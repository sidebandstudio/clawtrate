// What a failed real-gateway check leaves behind, cleared before the next (e2e/teardown.ts).
// The gateway is a stand-in that answers the methods the teardown calls.
import { describe, expect, it } from "vitest";
import { leaveIdle, type GatewayCall } from "../../../e2e/teardown.ts";

const SINCE = 1_000_000;

/** A gateway holding these tasks, approvals and questions; it records what it was asked. */
function gateway(state: {
  sessions: Array<{ key: string; updatedAt: number; busyFor?: number; held?: boolean }>;
  approvals?: Array<{ id: string; createdAtMs: number }>;
  questions?: Array<{ id: string; createdAtMs: number; status: string }>;
}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const aborts = new Map<string, number>();
  let approvals = [...(state.approvals ?? [])];
  const questions = [...(state.questions ?? [])];
  const call = (async (method: string, params: unknown) => {
    const p = params as Record<string, unknown>;
    calls.push([method, p]);
    switch (method) {
      case "sessions.list":
        return { sessions: state.sessions.map(({ key, updatedAt }) => ({ key, updatedAt })) };
      case "chat.abort":
        aborts.set(String(p.sessionKey), (aborts.get(String(p.sessionKey)) ?? 0) + 1);
        return { ok: true };
      case "chat.history": {
        const row = state.sessions.find((each) => each.key === p.sessionKey)!;
        const busy = (aborts.get(row.key) ?? 0) < (row.busyFor ?? 0);
        return {
          messages: [],
          ...(busy ? { inFlightRun: { runId: "r" } } : {}),
          pendingInputs: { items: busy && row.held ? [{}] : [] },
        };
      }
      case "exec.approval.list":
        return approvals;
      case "exec.approval.resolve":
        approvals = approvals.filter((each) => each.id !== p.id);
        return { ok: true };
      case "question.list":
        return { questions };
      case "question.resolve":
        questions.find((each) => each.id === p.id)!.status = "cancelled";
        return { ok: true };
      default:
        throw new Error(`unexpected ${method}`);
    }
  }) as GatewayCall;
  return { call, calls, aborts, approvals: () => approvals, questions };
}

describe("leaveIdle", () => {
  it("stops the runs of every task updated since the check began, until each is idle, and leaves older tasks alone", async () => {
    const g = gateway({
      sessions: [
        { key: "agent:otto:own", updatedAt: SINCE + 5, busyFor: 2, held: true },
        { key: "agent:marlow:main", updatedAt: SINCE + 9, busyFor: 1 },
        { key: "agent:otto:seeded", updatedAt: SINCE - 1, busyFor: 1 },
      ],
    });
    await leaveIdle(g.call, SINCE);
    expect(Object.fromEntries(g.aborts)).toEqual({ "agent:otto:own": 2, "agent:marlow:main": 1 });
  });

  it("denies the approvals and cancels the questions asked since the check began, and only those", async () => {
    const g = gateway({
      sessions: [],
      approvals: [
        { id: "mine", createdAtMs: SINCE + 1 },
        { id: "earlier", createdAtMs: SINCE - 1 },
      ],
      questions: [
        { id: "asked", createdAtMs: SINCE + 1, status: "pending" },
        { id: "answered", createdAtMs: SINCE + 1, status: "answered" },
        { id: "earlier", createdAtMs: SINCE - 1, status: "pending" },
      ],
    });
    await leaveIdle(g.call, SINCE);
    expect(g.calls.filter(([method]) => method === "exec.approval.resolve")).toEqual([
      ["exec.approval.resolve", { id: "mine", decision: "deny" }],
    ]);
    expect(g.approvals().map((each) => each.id)).toEqual(["earlier"]);
    expect(g.calls.filter(([method]) => method === "question.resolve")).toEqual([
      ["question.resolve", { id: "asked", cancel: true }],
    ]);
  });

  it("says what is left when a task stays busy", async () => {
    const g = gateway({
      sessions: [{ key: "agent:pip:stuck", updatedAt: SINCE + 1, busyFor: Infinity }],
    });
    await expect(leaveIdle(g.call, SINCE, 1_200)).rejects.toThrow(
      "a failed check left a run or held message in agent:pip:stuck",
    );
  });
});
