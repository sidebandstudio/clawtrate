// The rules' shape and limits (design section 6, F-332), and how a `set`
// keeps each rule's version. Nothing is ever removed by itself: a save past a
// limit is refused whole.

import { describe, expect, it } from "vitest";
import {
  LIMITS,
  RuleError,
  checkRule,
  checkStoredScope,
  nextScope,
  ruleLabel,
} from "../lib/rules.js";

let ids = 0;
const opts = () => ({
  now: 1000,
  setBy: "sha256:dev",
  newId: () => (++ids).toString(16).padStart(12, "0"),
});
const rules = (action: string, n: number, extra: Record<string, unknown> = {}) =>
  Array.from({ length: n }, () => ({ action, tools: ["write"], ...extra }));
const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (error instanceof RuleError) return { reason: error.reason, details: error.details };
    throw error;
  }
  return null;
};
const save = (scope: string, stored: unknown, list: unknown[], fallback = false) =>
  nextScope(scope, stored, { rules: list, fallback }, opts());

describe("limits (F-332): each scope holds at most 20 Allow, 20 Ask and 50 Never rules", () => {
  it("are Clawtrate's numbers", () => {
    expect([LIMITS.allow, LIMITS.ask, LIMITS.never, LIMITS.patternLength]).toEqual([
      20, 20, 50, 1000,
    ]);
  });

  it("a 1,000-character pattern saves; a 1,001-character one is refused and saves nothing", () => {
    const long = (n: number) => `notes/${"a".repeat(n - 6)}`;
    const saved = save("otto", undefined, [
      { action: "never", tools: ["write"], target: { kind: "path", pattern: long(1000) } },
    ]);
    expect(saved.rules[0]!.target!.pattern).toHaveLength(1000);
    expect(
      refusal(() =>
        save("otto", undefined, [
          { action: "never", tools: ["write"], target: { kind: "path", pattern: long(1001) } },
        ]),
      ),
    ).toEqual({ reason: "limit", details: { limit: 1000, length: 1001 } });
  });

  for (const [action, limit] of [
    ["allow", 20],
    ["ask", 20],
    ["never", 50],
  ] as const) {
    it(`with ${limit} ${action} rules, the ${limit + 1}st is refused and nothing is evicted`, () => {
      const full = save("otto", undefined, rules(action, limit));
      expect(full.rules).toHaveLength(limit);
      const kept = full.rules.map((r: { id: string }) => ({ id: r.id, action, tools: ["write"] }));
      expect(refusal(() => save("otto", full, [...kept, ...rules(action, 1)]))).toEqual({
        reason: "limit",
        details: { action, limit, count: limit + 1 },
      });
      // The scope as stored is untouched: the caller writes only what nextScope returns.
      expect(full.rules).toHaveLength(limit);
    });
  }

  it("with 20 Ask rules an Allow rule still saves, and another bot's scope still takes an Ask", () => {
    const full = save("otto", undefined, rules("ask", 20));
    const kept = full.rules.map((r: { id: string }) => ({
      id: r.id,
      action: "ask",
      tools: ["write"],
    }));
    expect(save("otto", full, [...kept, ...rules("allow", 1)]).rules).toHaveLength(21);
    expect(save("pip", undefined, rules("ask", 1)).rules).toHaveLength(1);
  });

  it("counts every bot's scope on its own", () => {
    expect(save("*", undefined, rules("never", 50)).rules).toHaveLength(50);
    expect(refusal(() => save("*", undefined, rules("never", 51)))?.reason).toBe("limit");
  });

  it("bounds a note and the tools of a rule", () => {
    expect(
      refusal(() =>
        save("otto", undefined, [{ action: "ask", tools: ["write"], note: "x".repeat(1001) }]),
      ),
    ).toMatchObject({ reason: "limit" });
    expect(
      refusal(() =>
        save("otto", undefined, [
          { action: "ask", tools: Array.from({ length: 17 }, (_, i) => `tool_${i}`) },
        ]),
      ),
    ).toMatchObject({ reason: "limit" });
  });
});

describe("a rule is built from choices", () => {
  it("takes an action, tools, an optional target and an optional note, nothing else", () => {
    expect(checkRule({ action: "never", tools: ["Write", "bash", "apply-patch"] }, 0)).toEqual({
      action: "never",
      tools: ["write", "exec", "apply_patch"],
    });
    expect(refusal(() => checkRule({ action: "deny", tools: ["write"] }, 0))?.reason).toBe(
      "bad_rule",
    );
    expect(refusal(() => checkRule({ action: "ask", tools: [] }, 0))?.reason).toBe("bad_rule");
    expect(
      refusal(() => checkRule({ action: "ask", tools: ["write"], when: "always" }, 0))?.reason,
    ).toBe("bad_rule");
    expect(refusal(() => checkRule({ action: "ask", tools: ["write rm"] }, 0))?.reason).toBe(
      "bad_rule",
    );
    expect(refusal(() => checkRule({ action: "ask", tools: ["*"] }, 0))?.reason).toBe("bad_rule");
  });

  it("refuses a rule about ask_user", () => {
    expect(refusal(() => checkRule({ action: "never", tools: ["ask_user"] }, 0))?.reason).toBe(
      "exempt_tool",
    );
  });

  it("takes a target only for the tools whose parameter the plugin reads", () => {
    expect(
      checkRule(
        {
          action: "never",
          tools: ["write", "edit", "apply_patch"],
          target: { kind: "path", pattern: "./secrets//**" },
        },
        0,
      ).target,
    ).toEqual({ kind: "path", pattern: "secrets/**" });
    expect(
      checkRule(
        { action: "ask", tools: ["exec"], target: { kind: "command", pattern: " rm   * " } },
        0,
      ).target,
    ).toEqual({ kind: "command", pattern: "rm *" });
    for (const raw of [
      { action: "never", tools: ["web_search"], target: { kind: "path", pattern: "a" } },
      { action: "never", tools: ["write"], target: { kind: "command", pattern: "a" } },
      { action: "never", tools: ["coder__*"], target: { kind: "path", pattern: "a" } },
      { action: "never", tools: ["write"], target: { kind: "path", pattern: "../a" } },
      { action: "never", tools: ["write"], target: { kind: "path", pattern: "/etc/**" } },
      { action: "never", tools: ["write"], target: { kind: "path", pattern: "a**" } },
      { action: "never", tools: ["exec"], target: { kind: "command", pattern: "a\nb" } },
      { action: "never", tools: ["write"], target: { kind: "url", pattern: "a" } },
    ]) {
      expect(refusal(() => checkRule(raw, 0))?.reason, JSON.stringify(raw)).toBe("bad_rule");
    }
  });

  it("keeps a note as the person's own words, and a label from the choices", () => {
    const rule = checkRule(
      {
        action: "never",
        tools: ["write"],
        target: { kind: "path", pattern: "secrets/**" },
        note: "Keep keys away",
      },
      0,
    );
    expect(rule.note).toBe("Keep keys away");
    expect(ruleLabel(rule)).toBe("Never · secrets/**");
    expect(ruleLabel({ action: "ask", tools: ["write", "edit"] })).toBe("Ask first · write, edit");
  });
});

describe("versions", () => {
  it("a scope counts its saves; a rule counts its own changes", () => {
    const first = save("otto", undefined, [{ action: "ask", tools: ["write"] }], true);
    expect(first.version).toBe(1);
    expect(first.fallback).toBe(true);
    const [a] = first.rules;
    expect(a).toMatchObject({ version: 1, setAt: 1000, setBy: "sha256:dev" });
    const same = save("otto", first, [{ id: a!.id, action: "ask", tools: ["write"] }]);
    expect(same.version).toBe(2);
    expect(same.rules[0]).toBe(a);
    const changed = save("otto", same, [{ id: a!.id, action: "never", tools: ["write"] }]);
    expect(changed.rules[0]).toMatchObject({ id: a!.id, version: 2, action: "never" });
  });

  it("refuses an id the scope does not have, or the same id twice", () => {
    const first = save("otto", undefined, [{ action: "ask", tools: ["write"] }]);
    const id = first.rules[0]!.id;
    expect(
      refusal(() => save("otto", first, [{ id: "0123456789ab", action: "ask", tools: ["write"] }]))
        ?.reason,
    ).toBe("unknown_rule");
    expect(
      refusal(() =>
        save("otto", first, [
          { id, action: "ask", tools: ["write"] },
          { id, action: "ask", tools: ["write"] },
        ]),
      )?.reason,
    ).toBe("bad_rule");
  });

  it("needs the fallback said outright", () => {
    expect(refusal(() => nextScope("otto", undefined, { rules: [] }, opts()))?.reason).toBe(
      "bad_request",
    );
  });
});

describe("a stored scope", () => {
  it("is checked as strictly as a set, bookkeeping included", () => {
    const saved = save("otto", undefined, [{ action: "ask", tools: ["write"] }]);
    expect(checkStoredScope("otto", JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    expect(
      refusal(() => checkStoredScope("otto", { ...saved, rules: rules("never", 51) }))?.reason,
    ).toBe("limit");
    expect(
      refusal(() =>
        checkStoredScope("otto", { ...saved, rules: [{ ...saved.rules[0], version: 0 }] }),
      )?.reason,
    ).toBe("bad_store");
    expect(refusal(() => checkStoredScope("Otto!", saved))?.reason).toBe("bad_store");
  });
});
