import { describe, expect, it } from "vitest";
import { ACCOUNT_CHECKS, findDecision } from "../src/account-checks.ts";

describe("reading the failover log", () => {
  it("finds the decision however the logger wrapped it", () => {
    const decision = {
      event: "embedded_run_failover_decision",
      runId: "r1",
      decision: "rotate_profile",
    };
    expect(findDecision(JSON.stringify(decision))).toEqual(decision);
    expect(findDecision(JSON.stringify({ 0: JSON.stringify(decision), time: "t" }))).toEqual(
      decision,
    );
    expect(findDecision(JSON.stringify({ msg: { nested: decision } }))).toEqual(decision);
    expect(findDecision("not json")).toBeNull();
    expect(
      findDecision(JSON.stringify({ msg: "embedded_run_failover_decision mentioned" })),
    ).toBeNull();
  });
});

describe("the account checks", () => {
  it("each name the rows of the design's section 20 they exercise", () => {
    for (const check of ACCOUNT_CHECKS) expect(check.rows.length, check.name).toBeGreaterThan(0);
    expect(new Set(ACCOUNT_CHECKS.map((c) => c.name)).size).toBe(ACCOUNT_CHECKS.length);
  });
});
