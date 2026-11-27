import { describe, expect, it } from "vitest";
import {
  ACCOUNT_CHECKS,
  cancelAndCheck,
  findDecision,
  WizardRefusal,
  type AccountHarness,
} from "../src/account-checks.ts";

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

describe("cancelling a sign-in", () => {
  const notFound = () =>
    Object.assign(new Error("wizard not found"), { details: { code: "WIZARD_NOT_FOUND" } });
  /** An admin client whose gateway drops the sign-in after `heldFor` wizard.next calls. */
  const harness = (heldFor: number, terminal: unknown = cancelledEnd) => {
    const calls: string[] = [];
    let next = 0;
    const admin = {
      request: async (method: string) => {
        calls.push(method);
        if (method === "wizard.cancel") return { status: "cancelled", error: "cancelled" };
        next += 1;
        if (next > heldFor) throw notFound();
        return terminal;
      },
    };
    return { h: { admin } as unknown as AccountHarness, calls };
  };
  const cancelledEnd = { done: true, status: "cancelled", error: "cancelled" };

  it("takes the terminal answer when wizard.next comes before the gateway drops the sign-in", async () => {
    const { h, calls } = harness(1);
    expect(await cancelAndCheck(h, "s1")).toEqual({
      cancel: { status: "cancelled", error: "cancelled" },
      after: { ...cancelledEnd, step: undefined },
    });
    expect(calls).toEqual(["wizard.cancel", "wizard.next", "wizard.next"]);
  });

  it('takes "wizard not found" when the gateway dropped the sign-in first', async () => {
    const { h } = harness(0);
    expect((await cancelAndCheck(h, "s1")).after).toBe("wizard not found");
  });

  it("fails when the sign-in is still there after its terminal answer", async () => {
    const { h } = harness(2);
    await expect(cancelAndCheck(h, "s1")).rejects.toThrow(
      /a wizard\.next after the sign-in ended \(sign-in s1\)/,
    );
  });

  it("fails on a terminal answer other than cancelled", async () => {
    const { h } = harness(1, { done: true, status: "done" });
    await expect(cancelAndCheck(h, "s1")).rejects.toThrow(/terminal answer after the cancel/);
  });

  it("says which call on which sign-in another refusal came from", async () => {
    const admin = {
      request: async (method: string) => {
        if (method === "wizard.cancel") return { status: "cancelled", error: "cancelled" };
        throw new Error("wizard not running");
      },
    };
    const failure = await cancelAndCheck({ admin } as unknown as AccountHarness, "s1").catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(WizardRefusal);
    expect((failure as Error).message).toBe("wizard.next on sign-in s1: wizard not running");
  });
});
