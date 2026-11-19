// How the rail reads a task's latest run (F-057): a request's own scoped record
// keeps its task waiting until the gateway resolves it, whatever its run does;
// a wait known only from the run's lifecycle ends with the run; and an older
// run's events never change the newer status the gateway's row gives.

import { describe, expect, it } from "vitest";
import { WaitingIndex } from "../src/waiting.ts";
import { groupTasks } from "../src/mapping.ts";
import { agentEvent, grantingGateway, KEY, openTask } from "./client-harness.ts";
import { sleep, until } from "./fake-gateway.ts";

const lifecycle = (phase: string, extra: Record<string, unknown> = {}, runId = "r1") => ({
  sessionKey: KEY,
  runId,
  stream: "lifecycle",
  data: { phase, ...extra },
});

describe("F-057: a wait, from the gateway's events", () => {
  it("a retriable lifecycle error keeps an unopened task's wait for an approval", () => {
    const index = new WaitingIndex();
    index.onAgent(lifecycle("start"), 1);
    index.onAgent(lifecycle("waiting-approval", { approvalId: "ap-1" }), 2);
    expect(index.waitingFor(KEY)?.kind).toBe("approval");
    index.onAgent(lifecycle("error", { error: "retry" }), 3);
    expect(index.waitingFor(KEY)?.kind).toBe("approval");
    // A definitive one ends the run, and a wait known only from its lifecycle with it.
    index.onAgent(lifecycle("error", { error: "gave up", executionSettled: true }), 4);
    expect(index.waitingFor(KEY)).toBeNull();
  });

  it("a wait from the request's own record outlives its run's end, and ends only with the request's resolution", () => {
    const index = new WaitingIndex();
    index.onAgent(lifecycle("start"), 1);
    index.onAgent(lifecycle("waiting-approval", { approvalId: "ap-1" }), 2);
    // The scoped record for the same id: one marker, now the record's.
    index.restoreApproval({ sessionKey: KEY, id: "ap-1", runId: "r1", createdAt: 2 }, 2);
    index.onAgent(lifecycle("approval-resolved", { approvalId: "ap-1" }), 3);
    index.onAgent(lifecycle("end"), 4);
    expect(index.settle(KEY, 10)).toBe(false);
    expect(index.waitingFor(KEY)).toEqual({ kind: "approval", since: 2 });
    expect(index.onApprovalResolved("ap-1")).toBe(true);
    expect(index.waitingFor(KEY)).toBeNull();
  });
});

describe("F-057: the task's status in the rail", () => {
  it("a pending request keeps its task waiting after its run ends, open or not, until the gateway resolves it", async () => {
    const gateway = grantingGateway();
    const rows = [{ key: KEY, agentId: "otto", sessionId: "s-1", status: "done", updatedAt: 900 }];
    gateway.handlers["sessions.list"] = () => ({ sessions: rows, hasMore: false });
    gateway.handlers["sessions.subscribe"] = () => ({
      subscribed: true,
      list: { sessions: rows, hasMore: false },
    });
    const { client, transcript } = await openTask({ gateway });
    const task = () => client.state.tasksByBot.otto?.find((each) => each.key === KEY);
    const request = {
      id: "survivor",
      request: { command: "sleep 2", host: "gateway", sessionKey: KEY, runId: "run-1" },
      createdAtMs: 1,
      expiresAtMs: 9_000_000_000_000,
    };
    try {
      gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
      gateway.emit("exec.approval.requested", request);
      gateway.emit(
        "agent",
        agentEvent("run-1", 2, "lifecycle", { phase: "waiting-approval", approvalId: request.id }),
      );
      await until(() => task()?.status === "waiting");
      gateway.emit("agent", agentEvent("run-1", 3, "lifecycle", { phase: "end" }));
      await until(() => transcript().approvals[0]?.runEnded === true);
      expect(transcript().approvals[0]?.status).toBe("pending");
      // Open: the run has ended and the request is still pending.
      expect(task()).toMatchObject({ status: "waiting", waitingFor: "approval" });
      // Closed: the same.
      client.closeSession(KEY);
      await sleep(30);
      expect(task()).toMatchObject({ status: "waiting", waitingFor: "approval" });
      // The gateway resolves it: the wait ends.
      gateway.emit("exec.approval.resolved", {
        id: request.id,
        decision: "allow-once",
        request: request.request,
      });
      await until(() => task()?.status === "done");
    } finally {
      client.stop();
    }
  });

  it("an older run's failed result or blocked end leaves the newer gateway row Done, with no failed count", async () => {
    const gateway = grantingGateway();
    const rows = [
      { key: KEY, agentId: "otto", sessionId: "s-1", status: "done", updatedAt: 60_000 },
    ];
    gateway.handlers["sessions.list"] = () => ({ sessions: rows, hasMore: false });
    gateway.handlers["sessions.subscribe"] = () => ({
      subscribed: true,
      list: { sessions: rows, hasMore: false },
    });
    const { client } = await openTask({ gateway, key: "agent:otto:other" });
    const task = () => client.state.tasksByBot.otto?.find((each) => each.key === KEY);
    try {
      gateway.emit("agent", agentEvent("r1", 1, "lifecycle", { phase: "start" }, KEY));
      gateway.emit(
        "agent",
        agentEvent(
          "r1",
          3,
          "tool",
          { phase: "result", name: "read", toolCallId: "call_a", isError: false, replace: true },
          KEY,
        ),
      );
      gateway.emit(
        "agent",
        agentEvent(
          "r1",
          2,
          "tool",
          { phase: "result", name: "read", toolCallId: "call_a", isError: true },
          KEY,
        ),
      );
      gateway.emit("agent", agentEvent("r1", 4, "lifecycle", { phase: "end" }, KEY));
      gateway.emit("agent", agentEvent("r2", 5, "lifecycle", { phase: "start" }, KEY));
      gateway.emit(
        "agent",
        agentEvent(
          "r2",
          6,
          "lifecycle",
          { phase: "error", livenessState: "blocked", executionSettled: true },
          KEY,
        ),
      );
      await sleep(50);
      expect(task()?.status).toBe("done");
      expect(task()).not.toHaveProperty("failedActions");
    } finally {
      client.stop();
    }
  });

  it("the row shapes the gateway lists stay as they were without such events", () => {
    const [task] = groupTasks([{ key: KEY, status: "done", updatedAt: 1 }]).otto!;
    expect(task!.status).toBe("done");
  });
});
