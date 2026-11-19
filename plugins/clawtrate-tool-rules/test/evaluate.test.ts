// The evaluator against the order of docs/design/controls.md section 3, row
// by row, and the cases the design calls out: an Allow never passes an Ask
// or a Never, for one bot or every bot; a call whose parameter cannot be read
// acts on everything; ask_user is never asked about or blocked.

import { describe, expect, it } from "vitest";
import { evaluate, ruleMatches } from "../lib/evaluate.js";
import { readTarget } from "../lib/targets.js";

type Rule = {
  id: string;
  version: number;
  action: "allow" | "ask" | "never";
  tools: string[];
  target?: { kind: "path" | "command"; pattern: string };
};
type Scope = { fallback?: boolean; rules?: Rule[] };

let counter = 0;
const rule = (
  action: Rule["action"],
  tools: string[],
  pattern?: string,
  kind: "path" | "command" = "path",
): Rule => ({
  id: (++counter).toString(16).padStart(12, "0"),
  version: 1,
  action,
  tools,
  ...(pattern === undefined ? {} : { target: { kind, pattern } }),
});
const scopes = (byId: Record<string, Scope>) =>
  new Map(
    Object.entries(byId).map(([id, s]) => [
      id,
      { version: 1, fallback: s.fallback ?? false, rules: s.rules ?? [] },
    ]),
  );
/** A call of `tool` by Otto, its target read from `params` as the hook reads it. */
const call = (tool: string, params: Record<string, unknown> = {}, agentId = "otto") => ({
  agentId,
  tool,
  target: readTarget(tool, params, "/srv/workspaces/otto"),
});
const decision = (s: ReturnType<typeof scopes>, c: ReturnType<typeof call>) => {
  const { decision: d, source } = evaluate(s, c);
  return [d, source && "ruleId" in source ? source.ruleId : (source?.kind ?? null)];
};

describe("the order, strongest first (section 3)", () => {
  it("rows 1 and 2: a tool the gateway denied never reaches the plugin, so nothing here decides it", () => {
    // The gateway removes a denied tool from what the bot is offered; the
    // hook is never called for it. With no rules the plugin decides nothing.
    expect(decision(scopes({}), call("read", { path: "a" }))).toEqual(["none", null]);
  });

  it("row 3: a Never about what a tool acts on blocks, naming the rule", () => {
    const never = rule("never", ["write", "edit", "apply_patch"], "secrets/**");
    const s = scopes({ otto: { rules: [never] } });
    expect(decision(s, call("write", { path: "secrets/key.txt" }))).toEqual(["block", never.id]);
    expect(decision(s, call("write", { path: "notes/a.md" }))).toEqual(["none", null]);
  });

  it("row 3: a Never for every bot applies to this bot", () => {
    const never = rule("never", ["write"], "**/.ssh/**");
    const s = scopes({ "*": { rules: [never] } });
    expect(decision(s, call("write", { path: "home/.ssh/id" }))).toEqual(["block", never.id]);
  });

  it("row 3 before row 4: a Never outranks a matching Ask", () => {
    const ask = rule("ask", ["write"], "secrets/**");
    const never = rule("never", ["write"], "secrets/**");
    const s = scopes({ otto: { rules: [ask] }, "*": { rules: [never] } });
    expect(decision(s, call("write", { path: "secrets/a" }))).toEqual(["block", never.id]);
  });

  it("row 4: a matching Ask asks", () => {
    const ask = rule("ask", ["write"], "notes/**");
    const s = scopes({ otto: { rules: [ask] } });
    expect(decision(s, call("write", { path: "notes/disk.md" }))).toEqual(["ask", ask.id]);
  });

  it("row 4: an Ask for a whole tool asks for every call of it", () => {
    const ask = rule("ask", ["sessions_send"]);
    const s = scopes({ otto: { rules: [ask] } });
    expect(decision(s, call("sessions_send", { agentId: "pip" }))).toEqual(["ask", ask.id]);
  });

  it("row 5: Ask when nothing else decides asks when no rule covers the call", () => {
    const s = scopes({ otto: { fallback: true } });
    expect(decision(s, call("read", { path: "AGENTS.md" }))).toEqual(["ask", "fallback"]);
    expect(evaluate(s, call("read", { path: "a" })).source).toEqual({
      kind: "fallback",
      scope: "otto",
    });
  });

  it("row 5: the fallback set for every bot asks for this bot too", () => {
    const s = scopes({ "*": { fallback: true } });
    expect(decision(s, call("web_search", { query: "x" }))).toEqual(["ask", "fallback"]);
  });

  it("row 5: a matching Allow keeps the fallback from asking, from either scope", () => {
    const own = rule("allow", ["read"]);
    const every = rule("allow", ["web_search"]);
    const s = scopes({ otto: { fallback: true, rules: [own] }, "*": { rules: [every] } });
    expect(decision(s, call("read", { path: "a" }))).toEqual(["allow", own.id]);
    expect(decision(s, call("web_search", {}))).toEqual(["allow", every.id]);
    expect(decision(s, call("write", { path: "a" }))).toEqual(["ask", "fallback"]);
  });

  it("row 5 off: an Allow alone decides nothing", () => {
    const s = scopes({ otto: { rules: [rule("allow", ["read"])] } });
    expect(decision(s, call("read", { path: "a" }))).toEqual(["none", null]);
  });

  it("row 6: for exec the plugin's answer is its own; nothing it returns passes the gateway's command check", () => {
    // An Allow keeps only the plugin's fallback from asking: the decision is
    // "allow", and the hook returns nothing, so the gateway's command
    // policy and the machine's approvals file still decide the command.
    const allow = rule("allow", ["exec"], "ls *", "command");
    const s = scopes({ otto: { fallback: true, rules: [allow] } });
    expect(decision(s, call("exec", { command: "ls -la" }))).toEqual(["allow", allow.id]);
  });

  it("the bot's own rule is named before a rule for every bot of the same action", () => {
    const own = rule("never", ["write"]);
    const every = rule("never", ["write"]);
    const s = scopes({ otto: { rules: [own] }, "*": { rules: [every] } });
    expect(decision(s, call("write", { path: "a" }))).toEqual(["block", own.id]);
  });

  it("another bot's rules do not apply", () => {
    const s = scopes({ pip: { fallback: true, rules: [rule("never", ["write"])] } });
    expect(decision(s, call("write", { path: "a" }))).toEqual(["none", null]);
  });
});

describe("an Allow never passes an Ask or a Never", () => {
  for (const [allowScope, otherScope] of [
    ["otto", "otto"],
    ["otto", "*"],
    ["*", "otto"],
    ["*", "*"],
  ] as const) {
    it(`an Allow for ${allowScope === "*" ? "every bot" : "the bot"} leaves an Ask for ${otherScope === "*" ? "every bot" : "the bot"} asking`, () => {
      const allow = rule("allow", ["write"], "notes/**");
      const ask = rule("ask", ["write"], "notes/**");
      const byId: Record<string, Scope> = {};
      (byId[allowScope] ??= { rules: [] }).rules!.push(allow);
      (byId[otherScope] ??= { rules: [] }).rules!.push(ask);
      expect(decision(scopes(byId), call("write", { path: "notes/a.md" }))).toEqual([
        "ask",
        ask.id,
      ]);
    });

    it(`an Allow for ${allowScope === "*" ? "every bot" : "the bot"} leaves a Never for ${otherScope === "*" ? "every bot" : "the bot"} blocking`, () => {
      const allow = rule("allow", ["write"]);
      const never = rule("never", ["write"], "secrets/**");
      const byId: Record<string, Scope> = {};
      (byId[allowScope] ??= { rules: [] }).rules!.push(allow);
      (byId[otherScope] ??= { rules: [] }).rules!.push(never);
      expect(decision(scopes(byId), call("write", { path: "secrets/k" }))).toEqual([
        "block",
        never.id,
      ]);
    });
  }

  it("an Allow listed before the Ask in the same scope still leaves it asking", () => {
    const allow = rule("allow", ["write"]);
    const ask = rule("ask", ["write"]);
    const s = scopes({ otto: { fallback: true, rules: [allow, ask] } });
    expect(decision(s, call("write", { path: "a" }))).toEqual(["ask", ask.id]);
  });
});

describe("a call whose parameter cannot be read acts on everything", () => {
  const unreadable: [string, Record<string, unknown>][] = [
    ["write", {}],
    ["write", { path: 42 }],
    ["write", { path: "notes/../secrets/key" }],
    ["write", { path: "~/secrets/key" }],
    ["write", { path: "@secrets/key" }],
    ["write", { path: "/elsewhere/secrets/key" }],
    ["write", { path: "a", file_path: "b" }],
    ["write", { paths: ["secrets/key"] }],
    ["apply_patch", { input: "*** Begin Patch\n*** Add File: secrets/key\n" }],
    ["exec", { command: "ls; rm -rf secrets" }],
    ["exec", { command: "echo $(cat secrets/key)" }],
    ["exec", { command: "FOO=1 rm -rf x" }],
    ["process", { action: "kill", sessionId: "s1" }],
  ];
  for (const [tool, params] of unreadable) {
    it(`${tool} ${JSON.stringify(params).slice(0, 60)}: a Never and an Ask about some targets apply, an Allow does not`, () => {
      const kind = tool === "exec" || tool === "process" ? "command" : "path";
      const pattern = kind === "command" ? "rm *" : "secrets/**";
      expect(readTarget(tool, params, "/srv/workspaces/otto")?.value).toBeNull();
      const never = rule("never", [tool], pattern, kind);
      expect(decision(scopes({ otto: { rules: [never] } }), call(tool, params))).toEqual([
        "block",
        never.id,
      ]);
      const ask = rule("ask", [tool], pattern, kind);
      expect(decision(scopes({ otto: { rules: [ask] } }), call(tool, params))).toEqual([
        "ask",
        ask.id,
      ]);
      const allow = rule("allow", [tool], kind === "command" ? "*" : "**", kind);
      expect(
        decision(scopes({ otto: { fallback: true, rules: [allow] } }), call(tool, params)),
      ).toEqual(["ask", "fallback"]);
    });
  }

  it("an absolute path inside the bot's workspace is read as its workspace path", () => {
    const never = rule("never", ["write"], "secrets/**");
    const s = scopes({ otto: { rules: [never] } });
    expect(decision(s, call("write", { path: "/srv/workspaces/otto/secrets/k" }))).toEqual([
      "block",
      never.id,
    ]);
    expect(decision(s, call("write", { path: "/srv/workspaces/otto/notes/k" }))).toEqual([
      "none",
      null,
    ]);
  });

  it("a rule without a target covers the tool whatever it acts on", () => {
    const ask = rule("ask", ["write"]);
    expect(ruleMatches(ask, call("write", {}))).toBe(true);
  });
});

describe("ask_user is never asked about or blocked", () => {
  it("not by the fallback, a Never or an Ask naming it, for the bot or every bot", () => {
    const s = scopes({
      otto: { fallback: true, rules: [rule("never", ["ask_user"]), rule("ask", ["*"])] },
      "*": { fallback: true, rules: [rule("never", ["ask_user"])] },
    });
    expect(evaluate(s, call("ask_user", { questions: [] }))).toEqual({
      decision: "none",
      source: null,
    });
  });
});

describe("tool servers", () => {
  it("a rule for a server's tools covers each of them by name", () => {
    const ask = rule("ask", ["coder__*"]);
    const s = scopes({ otto: { rules: [ask] } });
    expect(decision(s, call("coder__run_checks"))).toEqual(["ask", ask.id]);
    expect(decision(s, call("coderx__run"))).toEqual(["none", null]);
    const one = rule("never", ["coder__deploy_*"]);
    const t = scopes({ otto: { rules: [one] } });
    expect(decision(t, call("coder__deploy_prod"))).toEqual(["block", one.id]);
    expect(decision(t, call("coder__run_checks"))).toEqual(["none", null]);
  });
});
