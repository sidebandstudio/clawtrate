// How a task's latest run ended, as the rail tells it apart (F-057, F-295):
// completed with failed actions ("done with failures"), ended by the gateway
// as blocked, stopped. From the gateway's events for a task the engine does
// not follow, and from the engine's runs for one it does.

import { describe, expect, it } from "vitest";
import { WaitingIndex } from "../src/waiting.ts";
import { groupTasks } from "../src/mapping.ts";
import { agentEvent, grantingGateway, KEY, openTask } from "./client-harness.ts";
import { until } from "./fake-gateway.ts";

const lifecycle = (phase: string, extra: Record<string, unknown> = {}, runId = "r1") => ({
  sessionKey: KEY,
  runId,
  stream: "lifecycle",
  data: { phase, ...extra },
});
const toolResult = (isError: boolean, runId = "r1", id = "call_1") => ({
  sessionKey: KEY,
  runId,
  stream: "tool",
  data: { phase: "result", name: "read", toolCallId: id, isError, result: {} },
});

describe("F-057 F-295: the latest run's end, from the gateway's events", () => {
  it("a run that completed with a failed action is done with failures, counted; the next run's start clears it", () => {
    const index = new WaitingIndex();
    index.onAgent(lifecycle("start"), 10);
    index.onAgent(toolResult(false, "r1", "call_a"), 20);
    index.onAgent(toolResult(true, "r1", "call_b"), 30);
    expect(index.latestEnd(KEY).failedActions).toBe(0);
    expect(index.onAgent(lifecycle("end"), 40)).toBe(true);
    expect(index.latestEnd(KEY)).toEqual({ stoppedAt: null, failedActions: 1, blocked: false });
    index.onAgent(lifecycle("start", {}, "r2"), 50);
    expect(index.latestEnd(KEY).failedActions).toBe(0);
  });

  it("a stopped or failed run is not done with failures; another run's failed action is not this run's", () => {
    const index = new WaitingIndex();
    index.onAgent(lifecycle("start"), 10);
    index.onAgent(toolResult(true), 20);
    index.onAgent(lifecycle("end", { aborted: true }), 30);
    expect(index.latestEnd(KEY)).toMatchObject({ stoppedAt: 30, failedActions: 0 });
    index.onAgent(lifecycle("start", {}, "r2"), 40);
    index.onAgent(toolResult(true, "r1"), 45);
    index.onAgent(lifecycle("end", {}, "r2"), 50);
    expect(index.latestEnd(KEY).failedActions).toBe(0);
    index.onAgent(lifecycle("start", {}, "r3"), 60);
    index.onAgent(toolResult(true, "r3"), 65);
    index.onAgent(lifecycle("error", { executionSettled: true }, "r3"), 70);
    expect(index.latestEnd(KEY).failedActions).toBe(0);
  });

  it("a run the gateway ends as blocked marks the task blocked until the next run", () => {
    const index = new WaitingIndex();
    index.onAgent(lifecycle("start"), 10);
    index.onAgent(lifecycle("error", { livenessState: "blocked", executionSettled: true }), 20);
    expect(index.latestEnd(KEY).blocked).toBe(true);
    index.onAgent(lifecycle("start", {}, "r2"), 30);
    expect(index.latestEnd(KEY).blocked).toBe(false);
  });
});

describe("F-057 F-295: what the review found", () => {
  it("a result sent again, or replacing an earlier one, for the same call counts once", () => {
    const index = new WaitingIndex();
    index.onAgent(lifecycle("start"), 1);
    const failed = { ...toolResult(true, "r1", "same") };
    index.onAgent(failed, 2);
    index.onAgent({ ...failed, data: { ...failed.data, replace: true } }, 3);
    index.onAgent(lifecycle("end"), 4);
    expect(index.latestEnd(KEY).failedActions).toBe(1);
    // A replacing result that succeeds takes the failure back.
    const again = new WaitingIndex();
    again.onAgent(lifecycle("start"), 1);
    again.onAgent(toolResult(true, "r1", "call_x"), 2);
    again.onAgent(toolResult(false, "r1", "call_x"), 3);
    again.onAgent(lifecycle("end"), 4);
    expect(again.latestEnd(KEY).failedActions).toBe(0);
  });

  it("a retriable lifecycle error keeps an unopened task's wait for an approval", () => {
    const index = new WaitingIndex();
    index.onAgent(lifecycle("start"), 1);
    index.onAgent(lifecycle("waiting-approval", { approvalId: "ap-1" }), 2);
    expect(index.waitingFor(KEY)?.kind).toBe("approval");
    index.onAgent(lifecycle("error", { error: "retry" }), 3);
    expect(index.waitingFor(KEY)?.kind).toBe("approval");
    // A definitive one ends the run, and its wait with it.
    index.onAgent(lifecycle("error", { error: "gave up", executionSettled: true }), 4);
    expect(index.waitingFor(KEY)).toBeNull();
  });

  it("an end older than the task's row does not describe the task: no failed count, no blocked", () => {
    const index = new WaitingIndex();
    index.onAgent({ ...lifecycle("start"), ts: 1_000 }, 1_000);
    index.onAgent(toolResult(true), 1_100);
    index.onAgent({ ...lifecycle("end"), ts: 2_000 }, 2_000);
    expect(index.latestEnd(KEY, 2_100).failedActions).toBe(1);
    // The row was written well after that end: newer activity the index did not see.
    expect(index.latestEnd(KEY, 60_000).failedActions).toBe(0);
    const blocked = new WaitingIndex();
    blocked.onAgent({ ...lifecycle("start"), ts: 1_000 }, 1_000);
    blocked.onAgent(
      { ...lifecycle("error", { livenessState: "blocked", executionSettled: true }), ts: 2_000 },
      2_000,
    );
    expect(blocked.latestEnd(KEY, 2_500).blocked).toBe(true);
    expect(blocked.latestEnd(KEY, 60_000).blocked).toBe(false);
  });

  it("a task open in the engine reads the same failed count as one that is not: one source", () => {
    const index = new WaitingIndex();
    index.onAgent(lifecycle("start"), 1);
    index.onAgent(toolResult(true, "r1", "call_a"), 2);
    index.onAgent(toolResult(true, "r1", "call_b"), 3);
    index.onAgent(lifecycle("end"), 4);
    const unopened = index.latestEnd(KEY).failedActions;
    index.hold(KEY, { waiting: null, stoppedAt: null, active: false });
    expect(index.latestEnd(KEY).failedActions).toBe(unopened);
    expect(unopened).toBe(2);
  });
});

describe("F-057 F-295: the task's status in the rail", () => {
  it("a task whose run completed with a failed action reads done with failures, with the count", async () => {
    const gateway = grantingGateway();
    const rows = [{ key: KEY, agentId: "otto", sessionId: "s-1", status: "done", updatedAt: 900 }];
    gateway.handlers["sessions.list"] = () => ({ sessions: rows, hasMore: false });
    gateway.handlers["sessions.subscribe"] = () => ({
      subscribed: true,
      list: { sessions: rows, hasMore: false },
    });
    const { client } = await openTask({ gateway, key: "agent:otto:other" });
    gateway.emit("agent", agentEvent("r1", 1, "lifecycle", { phase: "start" }, KEY));
    gateway.emit("agent", {
      ...agentEvent("r1", 2, "tool", {
        phase: "result",
        name: "read",
        toolCallId: "call_1",
        isError: true,
        result: {},
      }),
      sessionKey: KEY,
    });
    gateway.emit("agent", agentEvent("r1", 3, "lifecycle", { phase: "end" }, KEY));
    const task = () => client.state.tasksByBot.otto?.find((each) => each.key === KEY);
    await until(() => task()?.status === "done-with-failures");
    expect(task()).toMatchObject({ status: "done-with-failures", failedActions: 1 });
    client.stop();
  });

  it("the row shapes the gateway lists stay as they were without such events", () => {
    const [task] = groupTasks([{ key: KEY, status: "done", updatedAt: 1 }]).otto!;
    expect(task!.status).toBe("done");
    expect(task!.failedActions).toBeUndefined();
  });
});
