// The plugin on a fake host: its hook, its methods and the tiers it asks the
// gateway to enforce, its status, its store and its decision record, and
// what it must never do (design section 21).

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import plugin, {
  ALLOWED_DECISIONS,
  APPROVAL_TIMEOUT_MS,
  DESCRIPTION_MAX,
  PLUGIN_VERSION,
  TITLE_MAX,
} from "../index.js";
import { RulesStore } from "../lib/store.js";
import { tempState, load } from "./harness.ts";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((done) => done()));
function host(options: Partial<Parameters<typeof load>[0]> = {}) {
  const { dir, done } = tempState();
  cleanups.push(done);
  return { ...load({ stateDir: dir, ...options }), stateDir: dir };
}
const rulesFile = (stateDir: string) => join(stateDir, "clawtrate-tool-rules", "rules.json");

describe("registration", () => {
  it("registers one hook for every tool call, with no matcher and no conversation hook", () => {
    const h = host();
    expect(h.hooks.map((hook) => [hook.name, hook.opts])).toEqual([["before_tool_call", {}]]);
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
    const hooksCopy = load({ stateDir: dir, slots });
    const methodsCopy = load({ stateDir: dir, slots, on: false });
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
    const none = host({ on: false });
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
    ["unreadable", (f) => (writeFileSync(f, "{}"), chmodSync(f, 0o000)), /cannot be read/],
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
        const h = load({ stateDir: h0.stateDir });
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
        chmodSync(rulesFile(h0.stateDir), 0o600);
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
        chmodSync(rulesFile(h.stateDir), 0o600);
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
    expect(asked.params).toBeUndefined();
    expect(asked.block).toBeUndefined();
  });

  it("keeps the card's text in bounds whatever the rule and target", async () => {
    const h = host();
    const long = `${"x".repeat(990)}*`;
    await h.save("otto", [{ action: "ask", tools: [`coder__${"y".repeat(100)}`, "exec"] }]);
    await h.save("*", [
      { action: "ask", tools: ["exec"], target: { kind: "command", pattern: long } },
    ]);
    for (const [tool, params] of [
      [`coder__${"y".repeat(100)}`, {}],
      ["exec", { command: "x".repeat(3000) }],
    ] as const) {
      const approval = h.before("otto", tool, params)!.requireApproval!;
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
      "clawtrate-tool-rules: Bot otto may run commands on the gateway's machine outside a sandbox, as the gateway's user, which can edit the gateway's config and the rules plugin's store, so Clawtrate's rules are advice for it. Deny it exec and process, or run its commands on another machine or in a sandbox.",
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
    const h = load({ stateDir: h0.stateDir });
    expect((await h.call("status")).payload).toMatchObject({
      rules: { state: "lost", reason: "the rules file is not JSON", keptCopyReadAt: null },
      enforcing: "ask-every-call",
      matches: null,
    });
    const without = host({ on: false });
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
    const h2 = load({ stateDir: h.stateDir, config: FORWARDING });
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
