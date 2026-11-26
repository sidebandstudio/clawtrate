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
  DESCRIPTION_MAX,
  MEMORY_LIMIT,
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
    // None of these is a hook the gateway holds back without conversation access.
    expect(h.hooks.map((hook) => [hook.name, hook.opts])).toEqual([
      ["before_tool_call", {}],
      ["before_message_write", {}],
      ["model_call_started", {}],
    ]);
  });

  it("decides in its hook where the gateway has no trusted policies, or refuses its own", async () => {
    for (const trusted of [false, "refused"] as const) {
      const h = host({ trusted });
      expect(h.policies).toEqual([]);
      await h.save("otto", [{ action: "never", tools: ["write"] }]);
      expect(h.before("otto", "write", { path: "a" })?.block).toBe(true);
      expect((await h.call("status")).payload?.hook).toMatchObject({ registered: true });
      expect(h.warnings.some((w) => /did not take its tool policy/.test(w))).toBe(
        trusted === "refused",
      );
    }
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
        hook: { registered: true, lastCallAt: null },
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
    expect(after.hook).toEqual({ registered: true, lastCallAt: 2000 });
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

describe("a run another bot's message started (#606)", () => {
  const PIP = "agent:pip:main";
  const fromMarlow = {
    role: "user",
    content: "read your notes",
    provenance: {
      kind: "inter_session",
      sourceSessionKey: "agent:marlow:main",
      sourceTool: "sessions_send",
    },
  };
  const fromPerson = { role: "user", content: "hello", provenance: { kind: "external_user" } };
  const read = (h: ReturnType<typeof load>, runId: string) =>
    h.before(
      "pip",
      "read",
      { path: "AGENTS.md" },
      { runId, sessionKey: PIP, toolCallId: `${runId}-c` },
    );

  it("refuses an Ask without a card, naming the bot, and records the ask as cancelled", async () => {
    const h = host();
    await h.save("pip", [{ action: "ask", tools: ["read"] }]);
    h.write(PIP, fromMarlow);
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
    h.write(PIP, fromMarlow);
    h.modelCall("run-b", PIP);
    expect(read(h, "run-b")?.blockReason).toMatch(
      /"Ask when nothing else decides" is on for pip, and this run was started by a message from bot marlow/,
    );
    const never = h.before("pip", "write", { path: "a" }, { runId: "run-b", sessionKey: PIP });
    expect(never?.blockReason).toMatch(/^Blocked by Clawtrate's rules plugin: pip's rule/);
    writeFileSync(rulesFile(h.stateDir), "{ broken");
    const lost = open({ stateDir: h.stateDir });
    lost.write(PIP, fromMarlow);
    lost.modelCall("run-l", PIP);
    expect(read(lost, "run-l")?.blockReason).toMatch(
      /its rules could not be read, so it asks before every call, and this run was started by a message from bot marlow/,
    );
  });

  it("asks in a run a person's message started, also after a bot's run in the same task", async () => {
    const h = host();
    await h.save("pip", [{ action: "ask", tools: ["read"] }]);
    h.write(PIP, fromMarlow);
    h.modelCall("run-b", PIP);
    h.write(PIP, fromPerson);
    h.modelCall("run-p", PIP);
    expect(read(h, "run-p")?.requireApproval).toBeDefined();
    // The bot's run stays a bot's run.
    expect(read(h, "run-b")?.block).toBe(true);
  });

  it("refuses in a person's run once a bot's message reaches it", async () => {
    const h = host();
    await h.save("pip", [{ action: "ask", tools: ["read"] }]);
    h.write(PIP, fromPerson);
    h.modelCall("run-p", PIP);
    h.modelCall("run-p", PIP);
    h.write(PIP, fromMarlow);
    expect(read(h, "run-p")?.blockReason).toMatch(/from bot marlow/);
  });

  it("goes by the task's latest message when the run made no model call it saw", async () => {
    const h = host();
    await h.save("pip", [{ action: "ask", tools: ["read"] }]);
    h.write(PIP, fromMarlow);
    expect(read(h, "run-x")?.block).toBe(true);
    h.write(PIP, fromPerson);
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
      h.write(PIP, { ...fromMarlow, provenance: { kind: "inter_session", sourceSessionKey: key } });
      expect(read(h, `run-${key.length}`)?.blockReason).toContain(
        `started by a message from ${words}.`,
      );
    }
  });

  it("keeps at most MEMORY_LIMIT tasks and runs, the oldest forgotten first", async () => {
    const h = host();
    await h.save("pip", [{ action: "ask", tools: ["read"] }]);
    h.write(PIP, fromMarlow);
    h.modelCall("run-b", PIP);
    for (let i = 0; i < MEMORY_LIMIT; i += 1) {
      h.write(`agent:pip:t${i}`, fromPerson);
      h.modelCall(`run-${i}`, `agent:pip:t${i}`);
    }
    const origins = h.handle.shared.origins;
    expect([origins.sessions.size, origins.runs.size, origins.current.size]).toEqual([
      MEMORY_LIMIT,
      MEMORY_LIMIT,
      MEMORY_LIMIT,
    ]);
    // Forgotten: the run is not known, and neither is its task's message.
    expect(read(h, "run-b")?.requireApproval).toBeDefined();
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
    for (const now of [[{ action: "allow", tools: ["write"] }], []]) {
      const h = host();
      await h.save("main", [ASK]);
      const card = h.before(...call);
      await h.save("main", now);
      expect(h.answer(card, "allow-once", ...call)).toBeUndefined();
    }
  });

  it("looks again only at the call whose card was answered Allow once, once", async () => {
    const h = host();
    await h.save("main", [ASK]);
    const card = h.before(...call);
    await h.save("main", [{ action: "never", tools: ["write"] }]);
    expect(h.answer(card, "deny", ...call)).toBeUndefined();
    // Not a call this plugin asked about: the hook leaves it alone.
    const hook = h.hooks.find((x) => x.name === "before_tool_call")!;
    expect(
      hook.fn(
        { toolName: "write", params: {}, runId: "run-9", toolCallId: "c" },
        { agentId: "main" },
      ),
    ).toBeUndefined();
    expect(h.handle.shared.approved.size).toBe(0);
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
      hook: { registered: false, lastCallAt: null },
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
