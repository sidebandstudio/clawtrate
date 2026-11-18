// How a task's latest run ended, as the rail tells it apart (F-057, F-295):
// completed with failed actions ("done with failures"), ended by the gateway
// as blocked, stopped. From the gateway's events for a task the engine does
// not follow, and from the engine's runs for one it does.

import { describe, expect, it } from "vitest";
import { fromActivity, WaitingIndex } from "../src/waiting.ts";
import { emptyActivity, type Run, type Step } from "../src/runs.ts";
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

function step(id: string, status: Step["status"], extra: Partial<Step> = {}): Step {
  return {
    id: `tool:${id}`,
    kind: "tool",
    toolCallId: id,
    toolName: "read",
    status,
    argsText: null,
    output: null,
    result: { text: status === "failed" ? "ENOENT" : "text", totalChars: 4 },
    raw: null,
    truncated: false,
    startedAt: 1,
    endedAt: 2,
    ...extra,
  } as Step;
}

function run(state: Run["state"], steps: Step[]): Run {
  return { id: "r1", state, steps, startedAt: 1, reportedStartAt: 1, endedAt: 3 } as Run;
}

describe("F-057 F-295: the latest run's end, from the engine's runs", () => {
  it("a held task whose latest run completed with a failed action counts it as the run line does", () => {
    const held = fromActivity({
      ...emptyActivity,
      runs: [run("completed", [step("a", "done"), step("b", "failed")])],
    });
    expect(held).toMatchObject({ failedActions: 1, active: false, stoppedAt: null });
    expect(
      fromActivity({ ...emptyActivity, runs: [run("completed", [step("a", "done")])] })
        .failedActions,
    ).toBe(0);
    expect(
      fromActivity({ ...emptyActivity, runs: [run("running", [step("b", "failed")])] }),
    ).toMatchObject({ failedActions: 0, active: true });
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
