// The plugin on a fake host: its hook, its methods and the tiers it asks the
// gateway to enforce, its status, its store and its decision record, and
// what it must never do (design section 21).

import { createHash } from "node:crypto";
import type * as fs from "node:fs";
import { mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin, {
  ALLOWED_DECISIONS,
  APPROVAL_TIMEOUT_MS,
  CHANGED_ARGUMENTS_REASON,
  DESCRIPTION_MAX,
  LOST_TRACK_LINE,
  MARK_EXPIRY_MS,
  MEMORY_LIMIT,
  PENDING_LIMIT,
  PLUGIN_VERSION,
  TITLE_MAX,
  TURNED_OFF_REASON,
} from "../index.js";
import { RulesStore, serializeRules } from "../lib/store.js";
import { load, running, tempState } from "./harness.ts";

// A read of one path fails with an I/O error while `failPath` names it,
// whatever the process may read: the unreadable rules file.
const io = vi.hoisted(() => ({ failPath: "" }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof fs>();
  return {
    ...real,
    readFileSync: (...args: Parameters<typeof real.readFileSync>) => {
      if (io.failPath && String(args[0]) === io.failPath) {
        throw Object.assign(new Error("injected"), { code: "EIO" });
      }
      return real.readFileSync(...args);
    },
  };
});

const cleanups: (() => void)[] = [];
const started: { stop(): void }[] = [];
afterEach(() => {
  // Every host a test started is stopped before its folder is removed.
  started.splice(0).forEach((h) => h.stop());
  expect(running.size).toBe(0);
  cleanups.splice(0).forEach((done) => done());
});
/** A host on a folder of its own, stopped and removed after the test. */
function host(options: Partial<Parameters<typeof load>[0]> = {}) {
  const { dir, done } = tempState();
  cleanups.push(done);
  return { ...open({ stateDir: dir, ...options }), stateDir: dir };
}
/** A host on a given folder, stopped after the test. */
function open(options: Parameters<typeof load>[0]) {
  const h = load(options);
  started.push(h);
  return h;
}
const rulesFile = (stateDir: string) => join(stateDir, "clawtrate-tool-rules", "rules.json");

describe("registration", () => {
  it("decides every tool call by a trusted policy with no matcher, and needs no conversation hook", () => {
    const h = host();
    expect(h.policies.map((p) => [p.id, p.matcher])).toEqual([["rules", undefined]]);
    // The manifest declares the policy, as the gateway asks of an installed plugin.
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "openclaw.plugin.json"), "utf8"),
    );
    expect(manifest.contracts).toEqual({ trustedToolPolicies: ["rules"] });
    // None of these is a hook the gateway holds back without conversation access (both
    // versions hold back agent_end, which is why the plugin does not use it).
    expect(h.hooks.map((hook) => [hook.name, hook.opts])).toEqual([
      ["before_tool_call", {}],
      ["before_message_write", {}],
      ["model_call_started", {}],
      ["after_tool_call", {}],
    ]);
  });

  it("decides in its hook where the gateway has no trusted policies, or refuses its own, and refuses an Ask there", async () => {
    for (const trusted of [false, "refused"] as const) {
      const h = host({ trusted });
      expect(h.policies).toEqual([]);
      await h.save("otto", [{ action: "never", tools: ["write"] }]);
      expect(h.before("otto", "write", { path: "a" })?.block).toBe(true);
      // An Ask: both versions resolve a hook's card after the hook has run, and nothing
      // can veto the answer, so the hook refuses it without a card.
      await h.save("otto", [{ action: "ask", tools: ["read"] }]);
      const result = h.before("otto", "read", { path: "a" });
      expect(result?.requireApproval).toBeUndefined();
      expect(result?.blockReason).toMatch(
        /^Refused by Clawtrate's rules plugin without asking anyone: otto's rule 'Ask first · read'.*asks first, and the gateway did not run the plugin's trusted policy, so an answer could not be checked again before the call runs\. The call did not run\.$/,
      );
      const [record] = (await h.call("decisions.list", { agentId: "otto" })).payload!
        .records as Record<string, unknown>[];
      expect([record?.decision, record?.answer]).toEqual(["ask", "cancelled"]);
      expect((await h.call("status")).payload?.hook).toMatchObject({
        registered: true,
        decidedBy: "hook",
      });
    }
  });

  it("says the policy decided where the gateway ran it", async () => {
    const h = host();
    expect((await h.call("status")).payload?.hook).toMatchObject({ decidedBy: null });
    h.before("otto", "read", { path: "a" });
    expect((await h.call("status")).payload?.hook).toMatchObject({ decidedBy: "policy" });
  });

  it("asks the gateway to hold get, status and decisions.list to read, and set to admin", () => {
    const h = host();
    expect(Object.fromEntries([...h.methods].map(([name, m]) => [name, m.opts.scope]))).toEqual({
      "clawtrate-tool-rules.status": "operator.read",
      "clawtrate-tool-rules.get": "operator.read",
      "clawtrate-tool-rules.decisions.list": "operator.read",
      "clawtrate-tool-rules.set": "operator.admin",
    });
  });

  it("says the version package.json says", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
    expect(PLUGIN_VERSION).toBe(pkg.version);
    expect(plugin.id).toBe("clawtrate-tool-rules");
  });

  it("shares its store and record between copies of the module in one process", async () => {
    const { dir, done } = tempState();
    cleanups.push(done);
    const slots = new Map();
    const hooksCopy = open({ stateDir: dir, slots });
    const methodsCopy = open({ stateDir: dir, slots, on: false });
    await methodsCopy.save("otto", [{ action: "never", tools: ["write"] }]);
    expect(hooksCopy.before("otto", "write", { path: "a" })?.block).toBe(true);
    expect((await methodsCopy.call("status")).payload?.hook).toMatchObject({ registered: true });
  });
});

describe("status says only what the plugin itself knows", () => {
  it("its version, rules schema, whether its hook is registered, when it last saw a call, and what it matches", async () => {
    let now = 1000;
    const h = host({ now: () => now });
    const before = await h.call("status");
    expect(before).toEqual({
      ok: true,
      payload: {
        plugin: "clawtrate-tool-rules",
        version: PLUGIN_VERSION,
        rulesSchema: 1,
        rules: { state: "none" },
        enforcing: "nothing",
        hook: { registered: true, lastCallAt: null, decidedBy: null },
        matches: { tools: [], fallback: [], exempt: ["ask_user"] },
        cardDetails: { mode: "full", because: "no-forwarding" },
        decisions: { state: "kept", setAside: [] },
      },
    });
    await h.save("otto", [{ action: "ask", tools: ["write", "edit"] }], true);
    await h.save("*", [{ action: "never", tools: ["coder__deploy_*"] }]);
    now = 2000;
    h.before("pip", "read", { path: "a" });
    const after = (await h.call("status")).payload!;
    expect(after.hook).toEqual({ registered: true, lastCallAt: 2000, decidedBy: "policy" });
    expect(after.matches).toEqual({
      tools: ["coder__deploy_*", "edit", "write"],
      fallback: ["otto"],
      exempt: ["ask_user"],
    });
  });

  it("does not claim a hook it could not register, or one whose service is not running", async () => {
    const none = host({ on: false, trusted: false });
    expect((await none.call("status")).payload?.hook).toEqual({
      registered: false,
      lastCallAt: null,
      decidedBy: null,
    });
    const stopped = host();
    stopped.stop();
    expect((await stopped.call("status")).payload?.hook).toMatchObject({ registered: false });
    const notStarted = host({ startService: false });
    expect((await notStarted.call("status")).payload?.hook).toMatchObject({ registered: false });
  });
});

describe("a lost policy is not an empty one", () => {
  const LOST: [string, (file: string) => void, RegExp][] = [
    ["not JSON", (f) => writeFileSync(f, "{ broken"), /not JSON/],
    ["too large", (f) => writeFileSync(f, Buffer.alloc(8 * 1024 * 1024 + 1, 32)), /larger/],
    [
      "a newer schema",
      (f) =>
        writeFileSync(f, JSON.stringify({ format: "clawtrate-tool-rules", schema: 2, scopes: {} })),
      /schema 2/,
    ],
    [
      "no scopes",
      (f) => writeFileSync(f, JSON.stringify({ format: "clawtrate-tool-rules", schema: 1 })),
      /not a valid rules store/,
    ],
    [
      "scopes that are a list",
      (f) =>
        writeFileSync(f, JSON.stringify({ format: "clawtrate-tool-rules", schema: 1, scopes: [] })),
      /not a valid rules store/,
    ],
    [
      "scopes that are null",
      (f) =>
        writeFileSync(
          f,
          JSON.stringify({ format: "clawtrate-tool-rules", schema: 1, scopes: null }),
        ),
      /not a valid rules store/,
    ],
    [
      "unreadable",
      (f) => (writeFileSync(f, JSON.stringify(serializeRules(new Map()))), (io.failPath = f)),
      /cannot be read \(EIO\)/,
    ],
    ["valid JSON that is not a store", (f) => writeFileSync(f, "{}"), /not a rules store/],
  ];

  it("no rules file: nothing was saved, and nothing is decided", () => {
    const h = host();
    expect(h.before("otto", "write", { path: "a" })).toBeUndefined();
  });

  for (const [what, spoil, reason] of LOST) {
    it(`${what}, with no copy read in this process: every call but ask_user asks, saying the rules could not be read`, async () => {
      const h0 = host();
      mkdirSync(join(h0.stateDir, "clawtrate-tool-rules"), { recursive: true });
      spoil(rulesFile(h0.stateDir));
      try {
        const h = open({ stateDir: h0.stateDir });
        for (const [tool, params] of [
          ["read", { path: "AGENTS.md" }],
          ["web_search", { query: "x" }],
          ["exec", { command: "ls" }],
        ] as const) {
          const approval = h.before("otto", tool, params)?.requireApproval;
          expect(approval?.title, tool).toBe(`${tool}: Clawtrate's rules could not be read`);
          expect(approval?.description).toMatch(
            /could not read its rules, so it asks before every tool call/,
          );
          expect(approval?.allowedDecisions).toEqual(["allow-once", "deny"]);
        }
        expect(h.before("otto", "ask_user", { questions: [] })).toBeUndefined();
        const [record] = (await h.call("decisions.list")).payload!.records as Record<
          string,
          unknown
        >[];
        expect(record).toMatchObject({ tool: "ask_user", decision: "none" });
        const records = (await h.call("decisions.list")).payload!.records as Record<
          string,
          unknown
        >[];
        expect(records[1]).toMatchObject({
          decision: "ask",
          rules: "lost",
          source: { kind: "rules-lost" },
        });
        expect(h.warnings.join("\n")).toMatch(reason);
        expect(h.warnings.join("\n")).toMatch(/every tool call but ask_user is asked about/);
        const got = await h.call("get");
        expect(got.error).toMatchObject({
          code: "UNAVAILABLE",
          details: { reason: "rules_unavailable" },
        });
      } finally {
        io.failPath = "";
      }
    });
  }

  it("with a copy read earlier, goes on enforcing it, says so, and never overwrites the file", async () => {
    const h = host();
    await h.save("otto", [{ action: "never", tools: ["write"] }]);
    for (const [, spoil] of LOST) {
      spoil(rulesFile(h.stateDir));
      try {
        expect(h.before("otto", "write", { path: "a" })?.block).toBe(true);
        expect(h.before("otto", "read", { path: "a" })).toBeUndefined();
        const set = await h.call("set", {
          scope: "otto",
          rules: [],
          fallback: false,
          expectedVersion: 1,
        });
        expect(set.error).toMatchObject({
          code: "UNAVAILABLE",
          details: { reason: "rules_unavailable" },
        });
        expect(set.error?.message).toMatch(/Enforcing the copy read at /);
      } finally {
        io.failPath = "";
      }
    }
    const records = (await h.call("decisions.list")).payload!.records as Record<string, unknown>[];
    expect(records[0]).toMatchObject({ tool: "read", decision: "none", rules: "kept" });
    expect(records[1]).toMatchObject({ tool: "write", decision: "block", rules: "kept" });
  });

  it("a file deleted after it was read is lost, not empty", async () => {
    const h = host();
    await h.save("otto", [{ action: "never", tools: ["write"] }]);
    rmSync(rulesFile(h.stateDir));
    expect(h.before("otto", "write", { path: "a" })?.block).toBe(true);
    expect(h.warnings.at(-1)).toMatch(/the rules file is gone\. Enforcing the copy read at/);
  });

  it("logs each change of state, once, and tells readers", async () => {
    const h = host();
    await h.save("otto", [{ action: "never", tools: ["write"] }]);
    const events = h.events.length;
    const good = readFileSync(rulesFile(h.stateDir), "utf8");
    writeFileSync(rulesFile(h.stateDir), "{ broken");
    h.before("otto", "write", { path: "a" });
    h.before("otto", "write", { path: "a" });
    expect(h.warnings.filter((w) => /Rules unavailable/.test(w))).toHaveLength(1);
    writeFileSync(rulesFile(h.stateDir), good);
    await h.call("status");
    expect(h.infos.at(-1)).toBe("clawtrate-tool-rules: Rules read; enforcing them.");
    expect(h.events.length - events).toBe(2);
  });
});

describe("set", () => {
  it("is compare-and-set on the scope's version", async () => {
    const h = host();
    const first = await h.call("set", {
      scope: "otto",
      rules: [{ action: "ask", tools: ["write"] }],
      fallback: false,
      expectedVersion: 0,
    });
    expect(first.payload).toMatchObject({ scope: "otto", version: 1 });
    const stale = await h.call("set", {
      scope: "otto",
      rules: [],
      fallback: false,
      expectedVersion: 0,
    });
    expect(stale.error).toMatchObject({
      code: "INVALID_REQUEST",
      details: { reason: "version_conflict", currentVersion: 1 },
    });
    const got = (await h.call("get", { scope: "otto" })).payload!;
    expect((got.scopes as Record<string, { version: number }>).otto!.version).toBe(1);
  });

  it("names who saved a rule by a hash of the device, and when", async () => {
    const h = host({ now: () => 777 });
    const saved = await h.save("otto", [{ action: "ask", tools: ["write"] }]);
    const [rule] = saved.payload!.rules as Record<string, unknown>[];
    expect(rule).toMatchObject({ version: 1, setAt: 777 });
    expect(rule!.setBy).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("refuses a save past a limit and saves nothing (F-332)", async () => {
    const h = host();
    const allows = Array.from({ length: 20 }, () => ({ action: "allow", tools: ["read"] }));
    expect((await h.save("otto", allows)).ok).toBe(true);
    const before = readFileSync(rulesFile(h.stateDir), "utf8");
    const got = (await h.call("get", { scope: "otto" })).payload!;
    const kept = (got.scopes as Record<string, { rules: { id: string }[] }>).otto!.rules.map(
      (r) => ({
        id: r.id,
        action: "allow",
        tools: ["read"],
      }),
    );
    const refused = await h.call("set", {
      scope: "otto",
      rules: [...kept, { action: "allow", tools: ["write"] }],
      fallback: false,
      expectedVersion: 1,
    });
    expect(refused.error).toMatchObject({
      code: "INVALID_REQUEST",
      details: { reason: "limit", action: "allow", limit: 20, count: 21 },
    });
    expect(readFileSync(rulesFile(h.stateDir), "utf8")).toBe(before);
  });

  it("refuses a scope that is not every bot or a bot's id", async () => {
    const h = host();
    const refused = await h.call("set", {
      scope: "Otto's",
      rules: [],
      fallback: false,
      expectedVersion: 0,
    });
    expect(refused.error).toMatchObject({
      code: "INVALID_REQUEST",
      details: { reason: "bad_scope" },
    });
  });

  it("never repeats a scope's revision: a clear keeps it, and an old revision is refused after a clear and recreate", async () => {
    const h = host();
    const set = (rules: unknown[], expectedVersion: number) =>
      h.call("set", { scope: "otto", rules, fallback: false, expectedVersion });
    const ask = [{ action: "ask", tools: ["write"] }];
    expect((await set(ask, 0)).payload).toMatchObject({ version: 1 });
    // Emptied: the scope stays, with its revision.
    expect((await set([], 1)).payload).toEqual({
      scope: "otto",
      version: 2,
      fallback: false,
      rules: [],
    });
    expect((await h.call("get", { scope: "otto" })).payload!.scopes).toEqual({
      otto: { version: 2, fallback: false, rules: [] },
    });
    // A client that read nothing, or read version 1, cannot recreate it over the clear.
    for (const stale of [0, 1]) {
      expect((await set(ask, stale)).error).toMatchObject({
        details: { reason: "version_conflict", currentVersion: 2 },
      });
    }
    expect((await set(ask, 2)).payload).toMatchObject({ version: 3 });
    // A client that read version 1 before the clear still cannot save.
    expect((await set([], 1)).error?.details?.reason).toBe("version_conflict");
    // And a fresh process sees the same revision.
    const fresh = host({ stateDir: h.stateDir });
    expect(
      (
        (await fresh.call("get", { scope: "otto" })).payload!.scopes as Record<
          string,
          { version: number }
        >
      ).otto!.version,
    ).toBe(3);
  });

  it("does not count an emptied scope against the bots with rules", async () => {
    const h = host();
    for (let i = 0; i < 64; i += 1) {
      await h.save(`bot${i}`, [{ action: "ask", tools: ["write"] }]);
    }
    expect(
      (await h.save("bot64", [{ action: "ask", tools: ["write"] }])).error?.details?.reason,
    ).toBe("limit");
    await h.save("bot0", []);
    expect((await h.save("bot64", [{ action: "ask", tools: ["write"] }])).ok).toBe(true);
  });
});

describe("the invalidation event", () => {
  it("is empty, read scope, after each save and after the file changes on disk", async () => {
    const h = host();
    await h.save("otto", [{ action: "ask", tools: ["write"] }]);
    expect(h.events).toEqual([{ name: "changed", payload: {}, opts: { scope: "operator.read" } }]);
    writeFileSync(rulesFile(h.stateDir), "something else entirely, and longer");
    await h.call("status");
    expect(h.events).toHaveLength(2);
    expect(h.events[1]).toEqual({ name: "changed", payload: {}, opts: { scope: "operator.read" } });
  });
});

describe("the hook", () => {
  it("asks with the gateway's card: a short title, a description naming the rule and target, 10 minutes, Allow once and Deny", async () => {
    const h = host();
    const saved = await h.save("otto", [
      { action: "ask", tools: ["write"], target: { kind: "path", pattern: "notes/**" } },
    ]);
    const ruleId = (saved.payload!.rules as { id: string }[])[0]!.id;
    const asked = h.before("otto", "write", { path: "notes/disk-2026-11-18.md", content: "x" })!;
    const approval = asked.requireApproval!;
    expect(approval.title.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(approval.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(approval.description).toBe(
      `Asked by Clawtrate's rules plugin: otto's rule 'Ask first · notes/**', version 1 (rule ${ruleId}). The call: write on notes/disk-2026-11-18.md.`,
    );
    expect(approval.timeoutMs).toBe(APPROVAL_TIMEOUT_MS);
    expect(APPROVAL_TIMEOUT_MS).toBe(600_000);
    expect(approval.allowedDecisions).toEqual(["allow-once", "deny"]);
    expect(ALLOWED_DECISIONS).not.toContain("allow-always");
    // A trusted policy's card is not stamped by the gateway: it names its plugin itself.
    expect(approval.pluginId).toBe("clawtrate-tool-rules");
    expect(asked.params).toBeUndefined();
    expect(asked.block).toBeUndefined();
  });

  it("keeps the card's text in bounds whatever the rule and target", async () => {
    const h = host();
    const long = `${"x".repeat(990)}*`;
    const own = await h.save("otto", [{ action: "ask", tools: [`coder__${"y".repeat(100)}`] }]);
    const every = await h.save("*", [
      { action: "ask", tools: ["exec"], target: { kind: "command", pattern: long } },
    ]);
    const idOf = (saved: typeof own) => (saved.payload!.rules as { id: string }[])[0]!.id;
    for (const [tool, params, ruleId] of [
      [`coder__${"y".repeat(100)}`, {}, idOf(own)],
      ["exec", { command: "x".repeat(3000) }, idOf(every)],
    ] as const) {
      const approval = h.before("otto", tool, params)!.requireApproval!;
      // The card is the one the rule it names asked for, the long one included.
      expect(approval.description).toContain(`(rule ${ruleId})`);
      expect(approval.title.length).toBeLessThanOrEqual(TITLE_MAX);
      expect(approval.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    }
  });

  it("asks for the fallback and says so", async () => {
    const h = host();
    await h.save("*", [], true);
    const approval = h.before("otto", "read", { path: "AGENTS.md" })!.requireApproval!;
    expect(approval.description).toBe(
      `Asked by Clawtrate's rules plugin: "Ask when nothing else decides" is on for every bot. The call: read on AGENTS.md.`,
    );
    expect(approval.allowedDecisions).toEqual(["allow-once", "deny"]);
  });

  it("blocks for a Never with the rule named, and never rewrites a call", async () => {
    const h = host();
    const saved = await h.save("otto", [
      { action: "never", tools: ["write"], target: { kind: "path", pattern: "secrets/**" } },
    ]);
    const ruleId = (saved.payload!.rules as { id: string }[])[0]!.id;
    expect(h.before("otto", "write", { path: "secrets/k" })).toEqual({
      block: true,
      blockReason: `Blocked by Clawtrate's rules plugin: otto's rule 'Never · secrets/**', version 1 (rule ${ruleId}). The call did not run.`,
    });
    expect(h.before("otto", "write", { path: "notes/k" })).toBeUndefined();
  });

  it("passes an Allow, and anything nothing decides, without returning a thing", async () => {
    const h = host();
    await h.save("otto", [{ action: "allow", tools: ["read"] }], true);
    expect(h.before("otto", "read", { path: "a" })).toBeUndefined();
    expect(h.before("pip", "read", { path: "a" })).toBeUndefined();
  });

  it("never asks about or blocks ask_user", async () => {
    const h = host();
    await h.save("*", [{ action: "never", tools: ["write"] }], true);
    await h.save("otto", [], true);
    expect(h.before("otto", "ask_user", { questions: [{ question: "?" }] })).toBeUndefined();
  });

  it("reads an absolute path through the bot's workspace", async () => {
    const h = host({ workspaces: { otto: "/srv/workspaces/otto" } });
    await h.save("otto", [
      { action: "never", tools: ["write"], target: { kind: "path", pattern: "secrets/**" } },
    ]);
    expect(h.before("otto", "write", { path: "/srv/workspaces/otto/secrets/k" })?.block).toBe(true);
    expect(h.before("otto", "write", { path: "/srv/workspaces/otto/notes/k" })).toBeUndefined();
    // Outside it the path is not read, so the Never applies.
    expect(h.before("otto", "write", { path: "/srv/workspaces/pip/notes/k" })?.block).toBe(true);
  });
});

describe("a run another bot's message started or reached (#606)", () => {
  const PIP = "agent:pip:main";
  const MARLOW = "agent:marlow:main";
  /** A message from another task, naming the run it is to start, as the gateway writes it. */
  const fromBot = (run: string, source = MARLOW, sourceTool = "sessions_send") => ({
    role: "user",
    content: "read your notes",
    idempotencyKey: `${run}:user`,
    provenance: { kind: "inter_session", sourceSessionKey: source, sourceTool },
  });
  const fromMarlow = (run: string) => fromBot(run);
  const fromPerson = (run: string) => ({
    role: "user",
    content: "hello",
    idempotencyKey: `${run}:user`,
    provenance: { kind: "external_user" },
  });
  const read = (h: ReturnType<typeof load>, runId: string, sessionKey = PIP) =>
    h.before("pip", "read", { path: "AGENTS.md" }, { runId, sessionKey, toolCallId: `${runId}-c` });
  /** A person's message that starts its run at once. */
  const personRun = (h: ReturnType<typeof load>, run: string, key = PIP) => {
    h.write(key, fromPerson(run));
    h.modelCall(run, key);
  };
  const asks = (h: ReturnType<typeof load>, run: string, key = PIP) =>
    expect(read(h, run, key)?.requireApproval).toBeDefined();
  const refusedFor = (h: ReturnType<typeof load>, run: string, bot = "marlow", key = PIP) => {
    const result = read(h, run, key);
    expect(result?.requireApproval).toBeUndefined();
    expect(result?.blockReason).toContain(`started by a message from bot ${bot}.`);
  };
  /** A task's waiting marks: the bot and the run each names (and `next`), not when it was written. */
  const pending = (h: ReturnType<typeof load>, key = PIP) =>
    ((h.handle.shared.origins.pending.get(key) ?? []) as Record<string, unknown>[]).map(
      ({ at: _at, ...mark }) => mark,
    );

  it("refuses an Ask without a card, naming the bot, and records the ask as cancelled", async () => {
    const h = host();
    await h.save("pip", [{ action: "ask", tools: ["read"] }]);
    h.write(PIP, fromMarlow("run-b"));
    h.modelCall("run-b", PIP);
    const result = read(h, "run-b");
    expect(result?.requireApproval).toBeUndefined();
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toMatch(
      /^Refused by Clawtrate's rules plugin without asking anyone: pip's rule 'Ask first · read'.*started by a message from bot marlow\..*The call did not run\.$/,
    );
    expect(result!.blockReason!.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    const [record] = (await h.call("decisions.list", { runId: "run-b" })).payload!
      .records as Record<string, unknown>[];
    expect([record?.decision, record?.answer]).toEqual(["ask", "cancelled"]);
  });

  it("refuses the fallback's ask and the lost rules' ask the same way, and still blocks a Never as a Never", async () => {
    const h = host();
    await h.save("pip", [{ action: "never", tools: ["write"] }], true);
    h.write(PIP, fromMarlow("run-b"));
    h.modelCall("run-b", PIP);
    expect(read(h, "run-b")?.blockReason).toMatch(
      /"Ask when nothing else decides" is on for pip, and this run was started by a message from bot marlow/,
    );
    const never = h.before("pip", "write", { path: "a" }, { runId: "run-b", sessionKey: PIP });
    expect(never?.blockReason).toMatch(/^Blocked by Clawtrate's rules plugin: pip's rule/);
    writeFileSync(rulesFile(h.stateDir), "{ broken");
    const lost = open({ stateDir: h.stateDir });
    lost.write(PIP, fromMarlow("run-l"));
    lost.modelCall("run-l", PIP);
    expect(read(lost, "run-l")?.blockReason).toMatch(
      /its rules could not be read, so it asks before every call, and this run was started by a message from bot marlow/,
    );
  });

  it("asks in a person's run once the bot's message has started its own run", async () => {
    const h = host();
    await h.save("pip", [{ action: "ask", tools: ["read"] }]);
    h.write(PIP, fromMarlow("run-b"));
    h.modelCall("run-b", PIP);
    expect(pending(h)).toEqual([]);
    personRun(h, "run-p");
    asks(h, "run-p");
    // The bot's run stays a bot's run.
    refusedFor(h, "run-b");
  });

  it("a bot's message queued behind a person's: the run under way, every run starting before the bot's own, and the bot's own count as the bot's; a run after it asks", async () => {
    // The order 2026.11.10 runs a queue in: the person's, the bot's, the person's.
    const h = host();
    await h.save("pip", [{ action: "ask", tools: ["read"] }]);
    personRun(h, "run-p1");
    asks(h, "run-p1");
    h.write(PIP, fromPerson("run-p2"));
    h.write(PIP, fromMarlow("run-m"));
    h.write(PIP, fromPerson("run-p3"));
    // The busy run may have taken Marlow's message (the gateway can steer it in).
    refusedFor(h, "run-p1");
    h.modelCall("run-p2", PIP);
    refusedFor(h, "run-p2");
    // Held across that run: it still waits for its own.
    expect(pending(h)).toEqual([{ bot: "marlow", run: "run-m" }]);
    h.modelCall("run-m", PIP);
    refusedFor(h, "run-m");
    expect(pending(h)).toEqual([]);
    h.modelCall("run-p3", PIP);
    asks(h, "run-p3");
  });

  it("a bot's queued message whose run starts first lets the person's queued runs ask", async () => {
    // The order 2026.10.6 runs the same queue in: the bot's first.
    const h = host();
    await h.save("pip", [{ action: "ask", tools: ["read"] }]);
    personRun(h, "run-p1");
    h.write(PIP, fromPerson("run-p2"));
    h.write(PIP, fromMarlow("run-m"));
    h.write(PIP, fromPerson("run-p3"));
    h.modelCall("run-m", PIP);
    refusedFor(h, "run-m");
    h.modelCall("run-p2", PIP);
    asks(h, "run-p2");
    h.modelCall("run-p3", PIP);
    asks(h, "run-p3");
  });

  it("a bot's message steered into a person's run makes that run the bot's, and is let go when the send says so", async () => {
    const h = host();
    await h.save("pip", [{ action: "ask", tools: ["read"] }]);
    personRun(h, "run-q1");
    // Marlow steers: the message names a run of its own that never starts.
    h.write(PIP, fromMarlow("run-s"));
    refusedFor(h, "run-q1");
    // Its send's result says where the gateway put it: a queued one keeps its mark.
    h.sent(MARLOW, {
      status: "accepted",
      runId: "run-s",
      sessionKey: PIP,
      targetDisposition: "queued",
    });
    expect(pending(h)).toHaveLength(1);
    h.sent(MARLOW, {
      status: "accepted",
      runId: "run-s",
      sessionKey: PIP,
      targetDisposition: "steered",
    });
    expect(pending(h)).toEqual([]);
    refusedFor(h, "run-q1");
    personRun(h, "run-q2");
    asks(h, "run-q2");
  });

  it("a steer whose send's result comes before its message is written: the run taking it in is the bot's, and nothing is left waiting", async () => {
    // The order 2026.10.6 answers a steer in: the result first, the write when the run takes it.
    const h = host();
    await h.save("pip", [{ action: "ask", tools: ["read"] }]);
    personRun(h, "run-q1");
    h.sent(MARLOW, {
      status: "accepted",
      runId: "run-s",
      sessionKey: PIP,
      targetDisposition: "steered",
    });
    // Only a steer is kept for later: a queued or answered one says nothing yet.
    h.sent(MARLOW, { status: "accepted", runId: "run-x", sessionKey: PIP });
    asks(h, "run-q1");
    h.write(PIP, fromMarlow("run-s"));
    refusedFor(h, "run-q1");
    expect(pending(h)).toEqual([]);
    personRun(h, "run-q2");
    asks(h, "run-q2");
    // A later message naming another run waits as any does.
    h.write(PIP, fromMarlow("run-x"));
    expect(pending(h)).toEqual([{ bot: "marlow", run: "run-x" }]);
  });

  it("a steer into a run not noted yet: the next run noted is the bot's, then the mark is gone", async () => {
    const h = host();
    await h.save("pip", [{ action: "ask", tools: ["read"] }]);
    personRun(h, "run-r1");
    // A person's message is written; its run has not made a model call when Marlow steers.
    h.write(PIP, fromPerson("run-r2"));
    h.write(PIP, fromMarlow("run-s"));
    h.sent(MARLOW, {
      status: "accepted",
      runId: "run-s",
      sessionKey: PIP,
      targetDisposition: "steered",
    });
    h.modelCall("run-r2", PIP);
    refusedFor(h, "run-r2");
    personRun(h, "run-r3");
    asks(h, "run-r3");
  });

  it("a mark whose run never starts and whose send's result never comes keeps every run in the task the bot's", async () => {
    const h = host();
    await h.save("pip", [{ action: "ask", tools: ["read"] }]);
    personRun(h, "run-q1");
    h.write(PIP, fromMarlow("run-s"));
    for (const run of ["run-q2", "run-q3", "run-q4"]) {
      personRun(h, run);
      refusedFor(h, run);
    }
    // An answer from the bot's send lets it go: its run has ended.
    h.sent(MARLOW, { status: "ok", runId: "run-s", sessionKey: PIP, reply: "done" });
    personRun(h, "run-q5");
    asks(h, "run-q5");
  });

  it("lets go only the mark a send's result names, in the task it names", async () => {
    const h = host();
    await h.save("pip", [{ action: "ask", tools: ["read"] }]);
    personRun(h, "run-q1");
    h.write(PIP, fromMarlow("run-s"));
    for (const details of [
      { status: "accepted", runId: "run-other", sessionKey: PIP, targetDisposition: "steered" },
      {
        status: "accepted",
        runId: "run-s",
        sessionKey: "agent:pip:other",
        targetDisposition: "steered",
      },
      { status: "accepted", runId: "run-s", sessionKey: PIP, targetDisposition: "queued" },
      { status: "forbidden", runId: "run-s", sessionKey: PIP },
      { status: "error", runId: "run-s", sessionKey: PIP, sentBeforeError: true },
      { status: "timeout", runId: "run-s", sessionKey: PIP, sentBeforeError: true },
    ]) {
      h.sent(MARLOW, details);
      expect(pending(h)).toEqual([{ bot: "marlow", run: "run-s" }]);
    }
    // Another tool's result is not read.
    h.hooks
      .find((x) => x.name === "after_tool_call")!
      .fn(
        {
          toolName: "message",
          params: {},
          result: { details: { status: "ok", runId: "run-s", sessionKey: PIP } },
        },
        { sessionKey: MARLOW },
      );
    expect(pending(h)).toHaveLength(1);
  });

  it("two bots' messages waiting: each bot's own run is its own, and any other run counts as the first's", async () => {
    const h = host();
    await h.save("pip", [{ action: "ask", tools: ["read"] }]);
    personRun(h, "run-p1");
    h.write(PIP, fromMarlow("run-m"));
    h.write(PIP, fromPerson("run-p2"));
    h.write(PIP, fromBot("run-o", "agent:otto:main"));
    h.modelCall("run-o", PIP);
    refusedFor(h, "run-o", "otto");
    h.modelCall("run-p2", PIP);
    refusedFor(h, "run-p2", "marlow");
    h.modelCall("run-m", PIP);
    refusedFor(h, "run-m", "marlow");
    personRun(h, "run-p3");
    asks(h, "run-p3");
  });

  it("takes a run of this bot's own task's message as that task's run stands, and an unknown one as a bot's", async () => {
    const h = host();
    await h.save("pip", [{ action: "ask", tools: ["read"] }]);
    const SUB = "agent:pip:subagent:s1";
    const back = (source: string, run: string) => fromBot(run, source, "subagent_announce");
    // A person's hand-off: its report back starts a person's run.
    personRun(h, "run-s", SUB);
    h.write(PIP, back(SUB, "run-back"));
    h.modelCall("run-back", PIP);
    asks(h, "run-back");
    expect(pending(h)).toEqual([]);
    // A hand-off Marlow's message started stays Marlow's.
    const SUB2 = "agent:pip:subagent:s2";
    h.write(SUB2, fromMarlow("run-s2"));
    h.modelCall("run-s2", SUB2);
    h.write(PIP, back(SUB2, "run-back2"));
    h.modelCall("run-back2", PIP);
    refusedFor(h, "run-back2");
    // A task of its own the plugin knows nothing of counts as a bot's: this one.
    h.write(PIP, back("agent:pip:subagent:unknown", "run-back3"));
    h.modelCall("run-back3", PIP);
    refusedFor(h, "run-back3", "pip");
  });

  it("with no model call seen, a waiting bot's message decides, and nothing once its run started", async () => {
    const h = host();
    await h.save("pip", [{ action: "ask", tools: ["read"] }]);
    h.write(PIP, fromMarlow("run-m"));
    h.write(PIP, fromPerson("run-p"));
    expect(read(h, "run-x")?.block).toBe(true);
    expect(read(h, "run-m")?.block).toBe(true);
    h.modelCall("run-m", PIP);
    expect(read(h, "run-y")?.requireApproval).toBeDefined();
  });

  it("names only a bot id the task's key gives in a bot id's form", async () => {
    const h = host();
    await h.save("pip", [{ action: "ask", tools: ["read"] }]);
    for (const [key, words] of [
      ["global", "another bot"],
      ["agent:Marlow<b>:main", "another bot"],
      [`agent:${"m".repeat(65)}:main`, "another bot"],
      ["agent:otto-2:task", "bot otto-2"],
    ] as const) {
      const run = `run-${key.length}`;
      h.write(PIP, fromBot(run, key));
      h.modelCall(run, PIP);
      expect(read(h, run)?.blockReason).toContain(`started by a message from ${words}.`);
    }
  });

  it("past PENDING_LIMIT a mark let go still counts as a bot's, its run and its task", async () => {
    const h = host();
    await h.save("pip", [{ action: "ask", tools: ["read"] }]);
    personRun(h, "run-p1");
    const runs = Array.from({ length: PENDING_LIMIT + 1 }, (_, i) => `run-m${i}`);
    for (const run of runs) h.write(PIP, fromMarlow(run));
    expect(pending(h)).toHaveLength(PENDING_LIMIT);
    // The first mark was let go: its run and its task are kept among the forgotten.
    expect(h.handle.shared.origins.forgotten.get("run-m0")).toEqual({ bot: "marlow" });
    for (const run of runs) {
      h.modelCall(run, PIP);
      refusedFor(h, run);
    }
    // Every mark is used up; the forgotten task counts as a bot's for one more run.
    personRun(h, "run-p2");
    refusedFor(h, "run-p2");
    personRun(h, "run-p3");
    asks(h, "run-p3");
  });

  it("past MEMORY_LIMIT tasks waiting, the oldest task's marks are forgotten, not dropped", async () => {
    const h = host();
    await h.save("pip", [{ action: "ask", tools: ["read"] }]);
    h.write(PIP, fromMarlow("run-first"));
    for (let i = 0; i < MEMORY_LIMIT; i += 1) h.write(`agent:pip:t${i}`, fromMarlow(`run-t${i}`));
    const { origins } = h.handle.shared;
    expect(origins.pending.size).toBe(MEMORY_LIMIT);
    expect(origins.pending.has(PIP)).toBe(false);
    h.modelCall("run-first", PIP);
    refusedFor(h, "run-first");
  });

  it("past MEMORY_LIMIT lets a person's entries go first, and a bot's run it let go still counts as a bot's", async () => {
    const h = host();
    await h.save("pip", [{ action: "ask", tools: ["read"] }]);
    h.write(PIP, fromMarlow("run-b"));
    h.modelCall("run-b", PIP);
    for (let i = 0; i < MEMORY_LIMIT; i += 1) personRun(h, `run-${i}`, `agent:pip:t${i}`);
    const origins = h.handle.shared.origins;
    expect([origins.sessions.size, origins.runs.size, origins.current.size]).toEqual([
      MEMORY_LIMIT,
      MEMORY_LIMIT,
      MEMORY_LIMIT,
    ]);
    // Marlow's run outlived a thousand people's, and a person's message since does not change it.
    expect(origins.runs.get("run-b")).toEqual({ bot: "marlow" });
    h.write(PIP, fromPerson("run-p"));
    h.modelCall("run-b", PIP);
    refusedFor(h, "run-b");
    // With only bots' runs left, the oldest is let go and kept among the forgotten.
    for (let i = 0; i < MEMORY_LIMIT; i += 1) {
      h.write(`agent:pip:b${i}`, fromMarlow(`run-bot-${i}`));
      h.modelCall(`run-bot-${i}`, `agent:pip:b${i}`);
    }
    expect(origins.runs.has("run-b")).toBe(false);
    expect(origins.forgotten.size).toBeLessThanOrEqual(MEMORY_LIMIT);
    h.modelCall("run-b", PIP);
    refusedFor(h, "run-b");
  });

  it("past the forgotten marks' own bound, a run it cannot place counts as a bot's, and only a run a person's message names asks", async () => {
    const h = host();
    await h.save("pip", [{ action: "ask", tools: ["read"] }]);
    h.write(PIP, fromMarlow("run-b"));
    h.modelCall("run-b", PIP);
    const { origins } = h.handle.shared;
    // Bots' runs fill the notes, then the forgotten: Marlow's run is let go from both.
    for (let i = 0; i < 2 * MEMORY_LIMIT; i += 1) {
      h.write(`agent:pip:b${i}`, fromMarlow(`run-bot-${i}`));
      h.modelCall(`run-bot-${i}`, `agent:pip:b${i}`);
    }
    expect([origins.runs.has("run-b"), origins.forgotten.has("run-b")]).toEqual([false, false]);
    expect(origins.lostTrack).toBe(true);
    expect(h.warnings.filter((w) => w.includes(LOST_TRACK_LINE))).toHaveLength(1);
    // Its next model call cannot make it a person's run, nor can a call with none seen.
    h.modelCall("run-b", PIP);
    for (const run of ["run-b", "run-unseen"]) {
      const result = read(h, run);
      expect(result?.requireApproval).toBeUndefined();
      expect(result?.blockReason).toContain(
        "the plugin can no longer tell who started this run: it let go of a bot's message past its memory limit",
      );
    }
    // A run no message named (a scheduled one, say) is refused too.
    h.modelCall("run-cron", PIP);
    expect(read(h, "run-cron")?.requireApproval).toBeUndefined();
    // A person's message still starts a person's run, at every model call.
    personRun(h, "run-p");
    asks(h, "run-p");
    h.modelCall("run-p", PIP);
    asks(h, "run-p");
  });

  it("once it lost track, a person's note from before is no proof: a routine's run noted earlier is refused, a person's message's run and a person's hand-off still ask", async () => {
    const h = host();
    await h.save("pip", [{ action: "ask", tools: ["read"] }]);
    // Noted before track is lost: a run no message named (a routine's), a person's, a hand-off.
    h.modelCall("run-routine", PIP);
    personRun(h, "run-person", "agent:pip:p");
    const SUB = "agent:pip:subagent:s1";
    personRun(h, "run-s", SUB);
    h.write(PIP, fromBot("run-back", SUB, "subagent_announce"));
    h.modelCall("run-back", PIP);
    // A routine's hand-off: its report back comes from a run no person started.
    const ROUTINE = "agent:pip:subagent:r1";
    h.modelCall("run-r", ROUTINE);
    h.write(PIP, fromBot("run-back-r", ROUTINE, "subagent_announce"));
    h.modelCall("run-back-r", PIP);
    asks(h, "run-routine");
    // Bots' messages waiting in another task push marks out of the forgotten ones; no run
    // starts, so the runs' notes from before are all still held.
    for (let i = 0; i < MEMORY_LIMIT + PENDING_LIMIT + 1; i += 1) {
      h.write("agent:pip:other", fromMarlow(`run-w${i}`));
    }
    const { origins } = h.handle.shared;
    expect(origins.lostTrack).toBe(true);
    expect(origins.runs.has("run-routine")).toBe(true);
    expect(read(h, "run-routine")?.blockReason).toContain(
      "the plugin can no longer tell who started this run",
    );
    asks(h, "run-person", "agent:pip:p");
    asks(h, "run-back");
    expect(read(h, "run-back-r")?.blockReason).toContain(
      "the plugin can no longer tell who started this run",
    );
  });

  it("a run that takes a bot's attribution is no longer a person's, on a steer or at its start, after its notes are let go", async () => {
    const h = host();
    await h.save("pip", [{ action: "ask", tools: ["read"] }]);
    const { origins } = h.handle.shared;
    /** Its note and its forgotten mark let go past their bounds, and track lost. */
    const evict = (run: string) => {
      origins.runs.delete(run);
      origins.forgotten.delete(run);
      origins.lostTrack = true;
    };
    // On a steer: a person's run under way, then Marlow's message, whose own run starts.
    personRun(h, "run-p");
    h.write(PIP, fromMarlow("run-m"));
    h.modelCall("run-m", PIP);
    expect(origins.people.has("run-p")).toBe(false);
    evict("run-p");
    expect(read(h, "run-p")?.requireApproval).toBeUndefined();
    // At its start: a person's message whose run starts while Marlow's message waits.
    const T = "agent:pip:t2";
    h.write(T, fromPerson("run-x"));
    h.write(T, fromMarlow("run-m2"));
    h.modelCall("run-x", T);
    h.modelCall("run-m2", T);
    expect(origins.people.has("run-x")).toBe(false);
    evict("run-x");
    expect(read(h, "run-x", T)?.requireApproval).toBeUndefined();
  });

  it("a waiting bot's message is read before a person's note: a busy run whose task the plugin no longer holds as under way still loses its cards", async () => {
    const h = host();
    await h.save("pip", [{ action: "ask", tools: ["read"] }]);
    personRun(h, "run-p1");
    const { origins } = h.handle.shared;
    // As past MEMORY_LIMIT tasks' latest runs, where the oldest task is let go.
    origins.current.delete(PIP);
    h.write(PIP, fromMarlow("run-m"));
    // The write could not mark the busy run, which keeps its person's note.
    expect(origins.runs.get("run-p1")).toBeNull();
    refusedFor(h, "run-p1");
    h.modelCall("run-m", PIP);
    asks(h, "run-p1");
  });

  it("a bot's message lets the task go once its send says the run ended; the run is still the bot's", async () => {
    for (const ended of [{ status: "no_reply" }, { status: "ok", reply: "done" }]) {
      const h = host();
      await h.save("pip", [{ action: "ask", tools: ["read"] }]);
      personRun(h, "run-q1");
      h.write(PIP, fromMarlow("run-s"));
      personRun(h, "run-q2");
      refusedFor(h, "run-q2");
      h.sent(MARLOW, { ...ended, runId: "run-s", sessionKey: PIP });
      expect(pending(h)).toEqual([]);
      personRun(h, "run-q3");
      asks(h, "run-q3");
      // Should its run start after all, it is Marlow's.
      h.modelCall("run-s", PIP);
      refusedFor(h, "run-s");
    }
  });

  it("a bot's message dropped or cancelled before its first model call: an error or a timeout keeps the task held until MARK_EXPIRY_MS, then a person's Ask is asked", async () => {
    for (const unsure of [
      // A deadline while the gateway's admission is still pending: the message may yet run.
      {
        status: "error",
        error: "Gateway admission is still pending; inspect this run before retrying.",
        sentBeforeError: true,
      },
      { status: "error", error: "dropped from the queue", sentBeforeError: true },
      { status: "timeout", error: "agent run timed out", sentBeforeError: true },
    ]) {
      let clock = 1_800_000_000_000;
      const h = host({ now: () => clock });
      await h.save("pip", [{ action: "ask", tools: ["read"] }]);
      personRun(h, "run-q1");
      h.write(PIP, fromMarlow("run-s"));
      h.sent(MARLOW, { ...unsure, runId: "run-s", sessionKey: PIP });
      expect(pending(h)).toEqual([{ bot: "marlow", run: "run-s" }]);
      personRun(h, "run-q2");
      refusedFor(h, "run-q2");
      clock += MARK_EXPIRY_MS + 1;
      personRun(h, "run-q3");
      asks(h, "run-q3");
      h.modelCall("run-s", PIP);
      refusedFor(h, "run-s");
    }
  });

  it("a send's result that its run ended, before its message is written, leaves nothing waiting", async () => {
    const h = host();
    await h.save("pip", [{ action: "ask", tools: ["read"] }]);
    personRun(h, "run-q1");
    h.sent(MARLOW, { status: "no_reply", runId: "run-s", sessionKey: PIP });
    h.write(PIP, fromMarlow("run-s"));
    expect(pending(h)).toEqual([]);
    personRun(h, "run-q2");
    asks(h, "run-q2");
    h.modelCall("run-s", PIP);
    refusedFor(h, "run-s");
  });

  it("a mark nothing lets go expires after MARK_EXPIRY_MS; its run, starting later, is still the bot's", async () => {
    let clock = 1_800_000_000_000;
    const h = host({ now: () => clock });
    await h.save("pip", [{ action: "ask", tools: ["read"] }]);
    personRun(h, "run-q1");
    // Sent without waiting: no result will ever say where it went.
    h.write(PIP, fromMarlow("run-s"));
    clock += MARK_EXPIRY_MS;
    personRun(h, "run-q2");
    refusedFor(h, "run-q2");
    clock += 1;
    personRun(h, "run-q3");
    asks(h, "run-q3");
    expect(pending(h)).toEqual([]);
    h.modelCall("run-s", PIP);
    refusedFor(h, "run-s");
  });

  it("a run whose mark expired is the bot's from its first call, with no model call seen", async () => {
    let clock = 1_800_000_000_000;
    const h = host({ now: () => clock });
    await h.save("pip", [{ action: "ask", tools: ["read"] }]);
    h.write(PIP, fromMarlow("run-s"));
    clock += MARK_EXPIRY_MS + 1;
    // Its first call comes before any model call is noted: the expired mark still names it.
    refusedFor(h, "run-s");
    refusedFor(h, "run-s");
  });

  it("a run that matches its own mark also uses up a mark kept only for the next run", async () => {
    const h = host();
    await h.save("pip", [{ action: "ask", tools: ["read"] }]);
    personRun(h, "run-r1");
    // A person writes; Marlow steers (into the run under way, or the one the person's
    // message starts: the plugin cannot tell), then sends again.
    h.write(PIP, fromPerson("run-r2"));
    h.write(PIP, fromMarlow("run-s"));
    h.sent(MARLOW, {
      status: "accepted",
      runId: "run-s",
      sessionKey: PIP,
      targetDisposition: "steered",
    });
    h.write(PIP, fromMarlow("run-m"));
    expect(pending(h)).toEqual([
      { bot: "marlow", run: null, next: true },
      { bot: "marlow", run: "run-m" },
    ]);
    // Marlow's run starts first (2026.10.6's order): it is the next run noted.
    h.modelCall("run-m", PIP);
    refusedFor(h, "run-m");
    expect(pending(h)).toEqual([]);
    // One run at a time in a task: the steer went into the run under way, not the person's.
    h.modelCall("run-r2", PIP);
    asks(h, "run-r2");
  });
});

describe("a card answered after its rule changed (#606)", () => {
  const ASK = { action: "ask", tools: ["write"], target: { kind: "path", pattern: "notes/**" } };
  const call = [
    "main",
    "write",
    { path: "notes/a.md" },
    { runId: "run-1", toolCallId: "call-1" },
  ] as const;

  it("runs the call when the rule the card showed still asks, at the same version", async () => {
    const h = host();
    const saved = await h.save("main", [ASK]);
    const card = h.before(...call);
    // Another rule changes; the card's rule stays as it was.
    const rules = (saved.payload!.rules as Record<string, unknown>[]).map((r) => ({ ...r }));
    await h.save("main", [...rules, { action: "never", tools: ["exec"] }]);
    expect(h.answer(card, "allow-once", ...call)).toBeUndefined();
  });

  it("refuses it when the rule now says Never, naming the rule, and records the refusal", async () => {
    const h = host();
    await h.save("main", [ASK]);
    const card = h.before(...call);
    await h.save("main", [{ action: "never", tools: ["write"] }]);
    const result = h.answer(card, "allow-once", ...call);
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toMatch(
      /^Refused by Clawtrate's rules plugin: the rules changed while the card waited, and main's rule 'Never · write', version 1 \(rule [0-9a-f]{12}\), now says Never\. The answer was for the rule the card showed\. The call did not run\.$/,
    );
    const records = (await h.call("decisions.list", { runId: "run-1" })).payload!.records as Record<
      string,
      unknown
    >[];
    expect(records.map((r) => [r.decision, r.answer])).toEqual([
      ["block", null],
      ["ask", "allow-once"],
    ]);
  });

  it("refuses it when another Ask, or another version of the rule, now asks", async () => {
    const h = host();
    const saved = await h.save("main", [ASK]);
    const id = (saved.payload!.rules as { id: string }[])[0]!.id;
    const card = h.before(...call);
    await h.save("main", [{ ...ASK, id, target: { kind: "path", pattern: "**" } }]);
    expect(h.answer(card, "allow-once", ...call)?.blockReason).toMatch(
      /version 2 .*asks first now/,
    );
    const fallback = host();
    await fallback.save("main", [ASK]);
    const second = fallback.before(...call);
    await fallback.save("main", [], true);
    expect(fallback.answer(second, "allow-once", ...call)?.blockReason).toMatch(
      /"Ask when nothing else decides" is on for main now/,
    );
  });

  it("runs it when the rules now let it run without asking", async () => {
    // An Allow decides only where the fallback would ask; with nothing at all, nothing decides.
    for (const [now, fallback, decision] of [
      [[{ action: "allow", tools: ["write"] }], true, "allow"],
      [[], false, "none"],
    ] as const) {
      const h = host();
      await h.save("main", [ASK]);
      const card = h.before(...call);
      await h.save("main", [...now], fallback);
      expect(h.answer(card, "allow-once", ...call)).toBeUndefined();
      // What the rules now say, for a call like it.
      h.before("main", "write", { path: "notes/a.md" }, { runId: "run-2", toolCallId: "c2" });
      const [latest] = (await h.call("decisions.list", { runId: "run-2" })).payload!
        .records as Record<string, unknown>[];
      expect(latest?.decision).toBe(decision);
    }
  });

  it("refuses Allow once for a call another policy rewrote after the card, under the same rule, and runs it unchanged", async () => {
    for (const rule of [ASK, { action: "ask", tools: ["write"] }]) {
      const h = host();
      await h.save("main", [rule]);
      const card = h.before(...call);
      // The rule asks for the rewritten target too: only the arguments tell them apart.
      const result = h.answer(card, "allow-once", "main", "write", { path: "notes/b.md" }, call[3]);
      expect(result).toEqual({ block: true, blockReason: CHANGED_ARGUMENTS_REASON });
      const records = (await h.call("decisions.list", { runId: "run-1" })).payload!
        .records as Record<string, unknown>[];
      expect(records.map((r) => [r.decision, r.source])).toEqual([
        ["block", { kind: "arguments-changed" }],
        ["ask", expect.objectContaining({ kind: "rule" })],
      ]);
    }
    // The same arguments, in another key order: the answer stands.
    const h = host();
    await h.save("main", [ASK]);
    const card = h.before("main", "write", { path: "notes/a.md", content: "x" }, call[3]);
    expect(
      h.answer(card, "allow-once", "main", "write", { content: "x", path: "notes/a.md" }, call[3]),
    ).toBeUndefined();
  });

  it("uses Allow once up: the same call reaching the hook again is refused, never run on that answer", async () => {
    const h = host();
    await h.save("main", [ASK]);
    const card = h.before(...call);
    expect(h.answer(card, "allow-once", ...call)).toBeUndefined();
    const hook = h.hooks.find((x) => x.name === "before_tool_call")!;
    const again = hook.fn(
      { toolName: "write", params: { path: "notes/a.md" }, runId: "run-1", toolCallId: "call-1" },
      { agentId: "main", sessionKey: "agent:main:main", runId: "run-1", toolCallId: "call-1" },
    ) as { block?: boolean; blockReason?: string; requireApproval?: unknown } | undefined;
    expect(again?.requireApproval).toBeUndefined();
    expect(again?.block).toBe(true);
    expect(again?.blockReason).toMatch(/could not be checked again before the call runs/);
    expect(h.handle.shared.approved.size).toBe(0);
  });

  it("looks again only at the call whose card was answered Allow once, once", async () => {
    const h = host();
    await h.save("main", [ASK]);
    const card = h.before(...call);
    await h.save("main", [{ action: "never", tools: ["write"] }]);
    expect(h.answer(card, "deny", ...call)).toBeUndefined();
    expect(h.handle.shared.approved.size).toBe(0);
    // A call the policy decided, then let run: the hook leaves it alone.
    await h.save("main", [{ action: "allow", tools: ["write"] }]);
    const free = ["main", "write", { path: "x" }, { runId: "run-2", toolCallId: "c2" }] as const;
    expect(h.before(...free)).toBeUndefined();
    const hook = h.hooks.find((x) => x.name === "before_tool_call")!;
    expect(
      hook.fn(
        { toolName: "write", params: { path: "x" }, runId: "run-2", toolCallId: "c2" },
        { agentId: "main" },
      ),
    ).toBeUndefined();
    // A call the policy never saw, the hook decides itself.
    await h.save("main", [{ action: "never", tools: ["write"] }]);
    expect(
      hook.fn(
        { toolName: "write", params: {}, runId: "run-9", toolCallId: "c" },
        { agentId: "main" },
      ),
    ).toMatchObject({ block: true });
  });
});

describe("a gateway setting changed while a card waits (#606)", () => {
  const call = [
    "main",
    "write",
    { path: "notes/a.md" },
    { runId: "run-1", toolCallId: "call-1" },
  ] as const;
  const DENIES: [string, Record<string, unknown>, boolean][] = [
    [
      "this bot's deny list names the tool",
      { agents: { entries: { main: { tools: { deny: ["write"] } } } } },
      true,
    ],
    ["the gateway's deny list holds it by a group", { tools: { deny: ["group:fs"] } }, true],
    ["the gateway's deny list matches it by a pattern", { tools: { deny: ["wr*"] } }, true],
    [
      "another tool is denied to this bot",
      { agents: { entries: { main: { tools: { deny: ["web_search"] } } } } },
      false,
    ],
    [
      "the tool is denied to another bot",
      { agents: { entries: { pip: { tools: { deny: ["write"] } } } } },
      false,
    ],
    ["an unrelated setting changed", { ui: { seamColor: "#000000" } }, false],
  ];
  for (const [what, change, refused] of DENIES) {
    it(`${refused ? "refuses Allow once" : "lets Allow once stand"} when ${what}`, async () => {
      const config: Record<string, unknown> = {};
      const h = host({ config });
      await h.save("main", [{ action: "ask", tools: ["write"] }]);
      const card = h.before(...call);
      Object.assign(config, change);
      const result = h.answer(card, "allow-once", ...call);
      if (!refused) return expect(result).toBeUndefined();
      expect(result).toEqual({
        block: true,
        blockReason:
          "Refused by Clawtrate's rules plugin: the gateway's settings now deny write to this bot, a change made while the card waited. The answer was for a call they allowed. The call did not run.",
      });
      const [record] = (await h.call("decisions.list", { runId: "run-1" })).payload!
        .records as Record<string, unknown>[];
      expect([record?.decision, record?.source]).toEqual(["block", { kind: "gateway-deny" }]);
    });
  }
});

describe("a pending read when the gateway comes to deny group:fs (#606)", () => {
  // Both versions' catalogs put read and ls in group:fs; 2026.11.10 checks a deny captured
  // before the card, so a deny saved while it waits is the plugin's to enforce.
  for (const [what, change] of [
    ["the gateway's deny list", { tools: { deny: ["group:fs"] } }],
    ["this bot's deny list", { agents: { entries: { main: { tools: { deny: ["group:fs"] } } } } }],
  ] as const) {
    it(`refuses Allow once for read and ls when ${what} names group:fs`, async () => {
      for (const tool of ["read", "ls"]) {
        const config: Record<string, unknown> = {};
        const h = host({ config });
        await h.save("main", [{ action: "ask", tools: [tool] }]);
        const card = h.before("main", tool, { path: "a" });
        Object.assign(config, change);
        expect(h.answer(card, "allow-once", "main", tool, { path: "a" })?.blockReason).toBe(
          `Refused by Clawtrate's rules plugin: the gateway's settings now deny ${tool} to this bot, a change made while the card waited. The answer was for a call they allowed. The call did not run.`,
        );
      }
    });
  }
});

describe("a pending call when the gateway comes to deny a group that holds its tool (#606)", () => {
  // Every group whole, as either version's catalog has it: a group read short would let the call run.
  for (const [tool, deny] of [
    ["web_fetch", "group:openclaw"],
    ["web_fetch", "group:web"],
    ["sessions_create", "group:sessions"],
    ["heartbeat_respond", "group:automation"],
    ["automations", "cron"],
    ["coder__deploy", "group:plugins"],
    ["coder__deploy", "bundle-mcp"],
    // The names both versions read a deny entry as: a renamed tool, an alias, a family.
    ["progress_card", "update_plan"],
    ["dispatch_action", "tool_call"],
    ["show_widget", "canvas"],
  ] as const) {
    it(`refuses Allow once for ${tool} when ${deny} is denied while its card waits`, async () => {
      const config: Record<string, unknown> = {};
      const h = host({ config });
      await h.save("main", [{ action: "ask", tools: [tool] }]);
      const card = h.before("main", tool, {});
      config.tools = { deny: [deny] };
      expect(h.answer(card, "allow-once", "main", tool, {})?.blockReason).toContain(
        `the gateway's settings now deny ${tool} to this bot`,
      );
    });
  }

  it("lets Allow once stand when the group denied does not hold the tool", async () => {
    const config: Record<string, unknown> = {};
    const h = host({ config });
    await h.save("main", [{ action: "ask", tools: ["web_fetch"] }]);
    const card = h.before("main", "web_fetch", {});
    config.tools = { deny: ["group:fs", "group:plugins"] };
    expect(h.answer(card, "allow-once", "main", "web_fetch", {})).toBeUndefined();
  });
});

describe("a call another plugin's policy changed after this one decided it (#606)", () => {
  it("decides it again: into a Never it is blocked, into an Ask it is refused, unchanged it is left alone", async () => {
    const h = host();
    await h.save("main", [
      { action: "never", tools: ["write"], target: { kind: "path", pattern: "secrets/**" } },
      { action: "ask", tools: ["write"], target: { kind: "path", pattern: "notes/**" } },
    ]);
    const ids = (n: number) => ({ runId: "run-1", toolCallId: `call-${n}` });
    expect(h.before("main", "write", { path: "tmp/a" }, ids(1))).toBeUndefined();
    expect(
      h.before("main", "write", { path: "tmp/a" }, ids(2), { path: "secrets/k" })?.blockReason,
    ).toMatch(/^Blocked by Clawtrate's rules plugin: main's rule 'Never · secrets\/\*\*'/);
    const asked = h.before("main", "write", { path: "tmp/a" }, ids(3), { path: "notes/a" });
    expect(asked?.requireApproval).toBeUndefined();
    expect(asked?.blockReason).toMatch(
      /asks first, and another plugin's policy changed the call after this plugin looked at it, so an answer could not be checked again before the call runs\. The call did not run\.$/,
    );
    // Rewritten to another target the rules let run: it runs.
    expect(h.before("main", "write", { path: "tmp/a" }, ids(4), { path: "tmp/b" })).toBeUndefined();
    // Each changed call has a record of its own; the policy still decided the rest.
    const records = (await h.call("decisions.list", { runId: "run-1" })).payload!.records as Record<
      string,
      unknown
    >[];
    expect(records.map((r) => r.decision)).toEqual([
      "none",
      "none",
      "ask",
      "none",
      "block",
      "none",
      "none",
    ]);
    expect((await h.call("status")).payload?.hook).toMatchObject({ decidedBy: "policy" });
  });

  it("decides it again when the answer the policy asked for is no longer held", async () => {
    const h = host();
    await h.save("main", [{ action: "ask", tools: ["write"] }]);
    const card = h.before("main", "write", { path: "a" });
    card!.requireApproval!.onResolution!("allow-once");
    h.handle.shared.approved.clear();
    const hook = h.hooks.find((x) => x.name === "before_tool_call")!;
    const result = hook.fn(
      { toolName: "write", params: { path: "a" }, runId: "run-1", toolCallId: "call-1" },
      { agentId: "main", sessionKey: "agent:main:main", runId: "run-1", toolCallId: "call-1" },
    ) as { blockReason?: string };
    expect(result?.blockReason).toMatch(/could not be checked again before the call runs/);
  });
});

describe("where the Codex harness may answer a card (#606)", () => {
  it("refuses an Ask without a card while the Codex plugin may run, and asks where it cannot", async () => {
    const config: Record<string, unknown> = {};
    const h = host({ config });
    await h.save("main", [
      { action: "ask", tools: ["write"] },
      { action: "never", tools: ["exec"] },
    ]);
    // Where an installed Codex plugin may load: the plugin cannot see what the gateway found on
    // disk, so a config that does not keep it from loading counts, an empty one included.
    for (const plugins of [
      {},
      { entries: { codex: { enabled: true } } },
      { entries: { Codex: {} } },
      { allow: ["codex", "clawtrate-tool-rules"] },
      { allow: [" CODEX ", "clawtrate-tool-rules"], entries: { codex: { enabled: true } } },
      { installs: { codex: { source: "npm" } } },
      { load: { paths: ["/srv/plugins/openclaw-codex"] } },
      // A slot that names it loads it past the allow list.
      { allow: ["clawtrate-tool-rules"], slots: { contextEngine: "codex" } },
    ]) {
      config.plugins = plugins;
      const result = h.before("main", "write", { path: "a" });
      expect(result?.requireApproval).toBeUndefined();
      expect(result?.blockReason).toMatch(
        /asks first, and the gateway runs the Codex harness, whose native tool approvals are answered where the plugin cannot check the answer again before the call runs\. The call did not run\.$/,
      );
      expect(h.before("main", "exec", { command: "ls" })?.blockReason).toMatch(/^Blocked by/);
    }
    // Where it cannot load: off, denied, turned off in its entry (OpenClaw's uninstall marker),
    // left out of an allow list.
    for (const plugins of [
      { entries: { codex: { enabled: false } } },
      { deny: ["codex"] },
      { deny: ["codex"], entries: { codex: { enabled: true } } },
      { allow: ["clawtrate-tool-rules"] },
      { allow: ["clawtrate-tool-rules"], entries: { codex: { enabled: true } } },
      { allow: ["clawtrate-tool-rules"], installs: { codex: {} } },
    ]) {
      config.plugins = plugins;
      expect(h.before("main", "write", { path: "a" })?.requireApproval).toBeDefined();
    }
  });
});

describe("the plugin turned off while a run is under way (#606)", () => {
  const OFF: [string, Record<string, unknown>][] = [
    ["its entry", { entries: { "clawtrate-tool-rules": { enabled: false } } }],
    ["plugins.enabled", { enabled: false }],
    ["plugins.deny", { deny: ["clawtrate-tool-rules"] }],
    ["an allow list without it", { allow: ["memory-core"] }],
  ];
  for (const [what, plugins] of OFF) {
    it(`refuses every call of that run, by ${what}, but never ask_user`, async () => {
      const config: Record<string, unknown> = {};
      const h = host({ config });
      await h.save("main", [{ action: "allow", tools: ["read"] }]);
      config.plugins = plugins;
      for (const tool of ["read", "write"]) {
        expect(h.before("main", tool, { path: "a" })).toEqual({
          block: true,
          blockReason: TURNED_OFF_REASON,
        });
      }
      expect(h.before("main", "ask_user")).toBeUndefined();
    });
  }

  it("refuses a call whose card is answered after it was turned off", async () => {
    const config: Record<string, unknown> = {};
    const h = host({ config });
    await h.save("main", [{ action: "ask", tools: ["write"] }]);
    const card = h.before("main", "write", { path: "a" });
    config.plugins = { entries: { "clawtrate-tool-rules": { enabled: false } } };
    expect(h.answer(card, "allow-once", "main", "write", { path: "a" })?.blockReason).toBe(
      TURNED_OFF_REASON,
    );
  });
});

describe("the decision record", () => {
  it("joins a call by run and hashed call id, names the rule as it was, and stores no arguments", async () => {
    const h = host();
    const saved = await h.save("otto", [
      { action: "ask", tools: ["exec"], target: { kind: "command", pattern: "rm *" } },
    ]);
    const ruleId = (saved.payload!.rules as { id: string }[])[0]!.id;
    const approval = h.before(
      "otto",
      "exec",
      { command: "rm -rf build-secret-dir" },
      {
        runId: "run-9",
        toolCallId: "call_abc",
      },
    )!.requireApproval!;
    approval.onResolution!("allow-once");
    // A later edit of the rule does not change what the record says decided the call.
    const got = (await h.call("get", { scope: "otto" })).payload!;
    const version = (got.scopes as Record<string, { version: number }>).otto!.version;
    await h.call("set", {
      scope: "otto",
      rules: [
        {
          id: ruleId,
          action: "never",
          tools: ["exec"],
          target: { kind: "command", pattern: "rm *" },
        },
      ],
      fallback: false,
      expectedVersion: version,
    });
    const { records } = (await h.call("decisions.list", { runId: "run-9" })).payload! as {
      records: Record<string, unknown>[];
    };
    expect(records).toEqual([
      {
        id: expect.stringMatching(/^[0-9a-f]{16}$/),
        at: expect.any(Number),
        agentId: "otto",
        sessionKey: "agent:otto:main",
        runId: "run-9",
        // As the gateway's audit log writes the same call's id.
        callId: `sha256:${createHash("sha256").update("call_abc").digest("hex")}`,
        tool: "exec",
        rules: "read",
        decision: "ask",
        source: { kind: "rule", scope: "otto", ruleId, version: 1, action: "ask" },
        answer: "allow-once",
        answeredAt: expect.any(Number),
      },
    ]);
    const file = readFileSync(join(h.stateDir, "clawtrate-tool-rules", "decisions.jsonl"), "utf8");
    expect(file).not.toMatch(/build-secret-dir|rm -rf|call_abc/);
  });

  it("lists at most 500 at a time, and refuses what it cannot filter on", async () => {
    const h = host();
    expect((await h.call("decisions.list", { limit: 501 })).error?.code).toBe("INVALID_REQUEST");
    expect((await h.call("decisions.list", { runId: 5 })).error?.code).toBe("INVALID_REQUEST");
    expect((await h.call("decisions.list", { runId: "r".repeat(513) })).error?.code).toBe(
      "INVALID_REQUEST",
    );
    expect((await h.call("status")).payload!.decisions).toEqual({ state: "kept", setAside: [] });
    expect((await h.call("decisions.list", {})).payload).toMatchObject({
      records: [],
      hasMore: false,
      retention: { days: 30, maxRecords: 50000 },
    });
  });
});

describe("what a bot must be denied", () => {
  it("is written to the gateway's log at start, for each bot that could change the rules", () => {
    const h = host({
      config: {
        tools: {
          deny: ["gateway", "plugins"],
          exec: { mode: "deny" },
          fs: { workspaceOnly: true },
        },
        agents: { entries: { otto: { tools: { exec: { mode: "ask" } } }, pip: {} } },
      },
    });
    expect(h.warnings).toEqual([
      "clawtrate-tool-rules: Bot otto may run commands on the gateway's machine outside a sandbox, as the gateway's user, which can edit the gateway's config and the rules plugin's store, so Clawtrate's rules are advice for it. Deny it exec and process. Or run its commands on another machine (tools.exec.host \"node\" in agents.entries.otto, which a global setting does not override). Or use a sandbox for its commands, clear any gateway-host override in its sessions and any tools.exec.host \"gateway\" in agents.entries.otto or globally, and disable elevated exec for the bot (tools.elevated.enabled false in agents.entries.otto).",
    ]);
  });
});

describe("a save the reader cannot reopen", () => {
  it("is refused whole, and every accepted save reads back the same in a fresh process", async () => {
    const h = host();
    const note = "n".repeat(1000);
    const tools = Array.from(
      { length: 16 },
      (_, i) => `tool_${String(i).padStart(2, "0")}_${"t".repeat(120)}`,
    );
    const full = (action: string, n: number) =>
      Array.from({ length: n }, () => ({ action, tools, note }));
    const rules = [...full("allow", 20), ...full("ask", 20), ...full("never", 50)];
    let refused: Awaited<ReturnType<typeof h.call>> | null = null;
    for (let i = 0; i < 64 && !refused; i += 1) {
      const before = i === 0 ? "" : readFileSync(rulesFile(h.stateDir), "utf8");
      const answer = await h.save(`bot${i}`, rules);
      if (!answer.ok) {
        refused = answer;
        expect(i).toBeGreaterThan(0);
        expect(readFileSync(rulesFile(h.stateDir), "utf8")).toBe(before);
        break;
      }
      // A fresh process reads exactly what the plugin answers with.
      const fresh = new RulesStore(join(h.stateDir, "clawtrate-tool-rules"));
      expect(Object.fromEntries(fresh.scopes() ?? [])).toEqual(
        (await h.call("get")).payload!.scopes,
      );
    }
    expect(refused?.error).toMatchObject({
      code: "INVALID_REQUEST",
      details: { reason: "store_too_large", limit: 8 * 1024 * 1024 },
    });
    expect(refused?.error?.details?.size).toBeGreaterThan(8 * 1024 * 1024);
    // The rules in memory are the ones last saved, and still read back.
    const fresh = new RulesStore(join(h.stateDir, "clawtrate-tool-rules"));
    expect(Object.fromEntries(fresh.scopes() ?? [])).toEqual((await h.call("get")).payload!.scopes);
  }, 60_000);
});

describe("status says whether rules are being enforced", () => {
  it("tells the three states of the rules apart, and the hook from the rules", async () => {
    let now = 1000;
    const h = host({ now: () => now });
    const status = async () => {
      const { rules, enforcing, hook } = (await h.call("status")).payload!;
      return { rules, enforcing, registered: (hook as { registered: boolean }).registered };
    };
    expect(await status()).toEqual({
      rules: { state: "none" },
      enforcing: "nothing",
      registered: true,
    });
    now = 2000;
    await h.save("otto", [{ action: "never", tools: ["write"] }]);
    expect(await status()).toEqual({
      rules: { state: "read", readAt: 2000 },
      enforcing: "rules",
      registered: true,
    });
    now = 3000;
    writeFileSync(rulesFile(h.stateDir), "{ broken");
    expect(await status()).toEqual({
      rules: { state: "lost", reason: "the rules file is not JSON", keptCopyReadAt: 2000 },
      enforcing: "kept-copy",
      registered: true,
    });
    h.stop();
    expect((await status()).enforcing).toBe("not-enforced");
  });

  it("says when every call is asked about, and when the hook is not there", async () => {
    const h0 = host();
    mkdirSync(join(h0.stateDir, "clawtrate-tool-rules"), { recursive: true });
    writeFileSync(rulesFile(h0.stateDir), "{ broken");
    const h = open({ stateDir: h0.stateDir });
    expect((await h.call("status")).payload).toMatchObject({
      rules: { state: "lost", reason: "the rules file is not JSON", keptCopyReadAt: null },
      enforcing: "ask-every-call",
      matches: null,
    });
    const without = host({ on: false, trusted: false });
    await without.save("otto", [{ action: "never", tools: ["write"] }]);
    expect((await without.call("status")).payload).toMatchObject({
      rules: { state: "read" },
      enforcing: "not-enforced",
      hook: { registered: false, lastCallAt: null, decidedBy: null },
    });
  });
});

describe("who can see a card's text", () => {
  const FORWARDING = { approvals: { plugin: { enabled: true, mode: "targets", targets: [] } } };
  const askNotes = [{ action: "ask", tools: ["write", "exec"] }];
  const card = async (options: Partial<Parameters<typeof load>[0]>) => {
    const h = host(options);
    await h.save("otto", askNotes);
    const write = h.before("otto", "write", { path: "notes/disk-report.md" })!.requireApproval!;
    const exec = h.before("otto", "exec", { command: "rm -rf build" })!.requireApproval!;
    const { cardDetails } = (await h.call("status")).payload!;
    return { write, exec, cardDetails };
  };

  it("carries the target when approvals are not forwarded", async () => {
    const { write, exec, cardDetails } = await card({});
    expect(write.description).toContain("notes/disk-report.md");
    expect(exec.description).toContain("rm -rf build");
    expect(cardDetails).toEqual({ mode: "full", because: "no-forwarding" });
  });

  for (const [what, config] of [
    ["plugin approvals are forwarded", FORWARDING],
    [
      "a channel has a plugin reviewer policy",
      { approvals: { plugin: { slack: { approvers: [] } } } },
    ],
    ["a chat channel is configured", { channels: { telegram: { enabled: true } } }],
  ] as const) {
    it(`leaves out the path, the command and the bot when ${what}`, async () => {
      const { write, exec, cardDetails } = await card({ config });
      for (const approval of [write, exec]) {
        expect(approval.description).not.toMatch(/notes\/disk-report\.md|rm -rf|otto/);
        expect(approval.title).not.toMatch(/otto/);
        expect(approval.description).toMatch(/The details are in Clawtrate\.$/);
        expect(approval.description).toMatch(
          /a rule for this bot \(rule [0-9a-f]{12}, version 1, Ask first\)/,
        );
      }
      expect(cardDetails).toEqual({ mode: "redacted", because: "forwarding-configured" });
    });
  }

  it("leaves the target out of the fallback's card and the lost-rules card too", async () => {
    const h = host({ config: FORWARDING });
    await h.save("*", [], true);
    const fallback = h.before("otto", "read", { path: "notes/x.md" })!.requireApproval!;
    expect(fallback.description).toBe(
      `Asked by Clawtrate's rules plugin: "Ask when nothing else decides" is on for every bot. The call: read. The details are in Clawtrate.`,
    );
    writeFileSync(rulesFile(h.stateDir), "{ broken");
    const h2 = open({ stateDir: h.stateDir, config: FORWARDING });
    const lost = h2.before("otto", "read", { path: "notes/x.md" })!.requireApproval!;
    expect(lost.description).not.toContain("notes/x.md");
  });

  it("follows a setting that forces either", async () => {
    const full = await card({ config: FORWARDING, pluginConfig: { cardDetails: "full" } });
    expect(full.write.description).toContain("notes/disk-report.md");
    expect(full.cardDetails).toEqual({ mode: "full", because: "setting" });
    const redacted = await card({ pluginConfig: { cardDetails: "redacted" } });
    expect(redacted.write.description).not.toContain("notes/disk-report.md");
    expect(redacted.cardDetails).toEqual({ mode: "redacted", because: "setting" });
  });
});

describe("thirty days means thirty days", () => {
  afterEach(() => vi.useRealTimers());

  it("drops expired records from disk with no tool activity, on a timer that keeps nothing alive", async () => {
    vi.useFakeTimers({ now: 0 });
    const day = 86_400_000;
    const h = host({ now: () => Date.now(), log: { now: () => Date.now() } });
    h.before("otto", "read", { path: "a" }, { runId: "old-run" });
    vi.setSystemTime(10 * day);
    h.before("otto", "read", { path: "a" }, { runId: "newer-run" });
    const file = join(h.stateDir, "clawtrate-tool-rules", "decisions.jsonl");
    expect(readFileSync(file, "utf8")).toContain("old-run");
    // Idle from here: no call, no method.
    vi.advanceTimersByTime(21 * day);
    expect(readFileSync(file, "utf8")).not.toContain("old-run");
    expect(readFileSync(file, "utf8")).toContain("newer-run");
    vi.advanceTimersByTime(10 * day);
    expect(readFileSync(file, "utf8")).toBe("");
    for (const timer of h.handle.timers) expect(timer.hasRef()).toBe(false);
    h.stop();
    expect(h.handle.timers).toEqual([]);
  });

  it("drops them at start", () => {
    const day = 86_400_000;
    let now = 0;
    const h = host({ now: () => now, log: { now: () => now } });
    h.before("otto", "read", { path: "a" }, { runId: "old-run" });
    now = 31 * day;
    open({ stateDir: h.stateDir, now: () => now, log: { now: () => now } });
    const file = join(h.stateDir, "clawtrate-tool-rules", "decisions.jsonl");
    expect(readFileSync(file, "utf8")).not.toContain("old-run");
  });
});

describe("a decision record set aside as oversized", () => {
  it("is named by status after later writes and a restart, until it is removed", async () => {
    const day = 86_400_000;
    let now = 1_000 * day;
    const { dir, done } = tempState();
    cleanups.push(done);
    const file = join(dir, "clawtrate-tool-rules", "decisions.jsonl");
    mkdirSync(join(dir, "clawtrate-tool-rules"), { recursive: true });
    writeFileSync(file, "");
    truncateSync(file, 64 * 1024 * 1024 + 1);
    const start = () => open({ stateDir: dir, now: () => now, log: { now: () => now } });
    const decisions = async (h: ReturnType<typeof start>) =>
      (await h.call("status")).payload!.decisions;
    const named = {
      state: "kept",
      setAside: [
        {
          file: expect.stringMatching(/^decisions\.jsonl\.oversize-\d+-[0-9a-f]{12}$/),
          setAsideAt: 1_000 * day,
        },
      ],
    };
    const first = start();
    first.before("otto", "read", { path: "a" }, { runId: "after-aside" });
    expect(readFileSync(file, "utf8")).toContain("after-aside");
    expect(await decisions(first)).toEqual(named);
    first.stop();
    now += day;
    const restarted = start();
    restarted.before("otto", "read", { path: "a" }, { runId: "after-restart" });
    expect(await decisions(restarted)).toEqual(named);
    restarted.stop();
    // Thirty days after it was set aside, the next start removes it, and it is no longer named.
    now = 1_031 * day;
    expect(await decisions(start())).toEqual({ state: "kept", setAside: [] });
  });
});

describe("paging the decision record", () => {
  it("goes on from a cursor, so two decisions in one millisecond are both listed", async () => {
    const h = host({ now: () => 5000, log: { now: () => 5000 } });
    for (const runId of ["run-a", "run-b", "run-c"])
      h.before("otto", "read", { path: "a" }, { runId });
    const seen: string[] = [];
    let cursor: unknown;
    for (let page = 0; page < 5; page += 1) {
      const answer = (await h.call("decisions.list", { limit: 1, ...(cursor ? { cursor } : {}) }))
        .payload!;
      seen.push(...(answer.records as { runId: string }[]).map((r) => r.runId));
      if (!answer.hasMore) {
        expect(answer.nextCursor).toBeUndefined();
        break;
      }
      expect(answer.nextCursor).toMatch(/^[0-9a-f]{16}$/);
      cursor = answer.nextCursor;
    }
    expect(seen).toEqual(["run-c", "run-b", "run-a"]);
    // `before` stays a time filter beside it.
    expect((await h.call("decisions.list", { before: 5000 })).payload!.records).toEqual([]);
    expect((await h.call("decisions.list", { cursor: "not a cursor" })).error?.code).toBe(
      "INVALID_REQUEST",
    );
  });
});
