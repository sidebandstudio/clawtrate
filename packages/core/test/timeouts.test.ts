// Three tool calls in a row that time out: the machine may not be responding, so this
// client stops the run and says why (F-101).

import { describe, expect, it } from "vitest";
import { agentEvent, KEY, openTask } from "./client-harness.ts";
import { GatewayError, sleep, until } from "./fake-gateway.ts";

type Opened = Awaited<ReturnType<typeof openTask>>;

// An exec that ran out of its own time, as OpenClaw 2026.10.6 reports it.
const TIMED_OUT = {
  status: "failed",
  failureKind: "overall-timeout",
  exitReason: "overall-timeout",
  timedOut: true,
};
const FINISHED = { status: "completed", exitCode: 0, exitReason: "exit", timedOut: false };

let seq = 1;
function call({ gateway }: Opened, id: string, details: Record<string, unknown>) {
  gateway.emit(
    "agent",
    agentEvent("run-x", (seq += 1), "tool", {
      phase: "start",
      name: "exec",
      toolCallId: id,
      args: { command: "sleep 5" },
    }),
  );
  gateway.emit(
    "agent",
    agentEvent("run-x", (seq += 1), "tool", {
      phase: "result",
      name: "exec",
      toolCallId: id,
      isError: details.timedOut === true,
      result: { content: [{ type: "text", text: "Command timed out after 1 seconds." }], details },
    }),
  );
}

describe("tool calls that keep timing out (F-101)", () => {
  it("F-101: after three timed-out calls in a row the run is stopped, and says so", async () => {
    const task = await openTask();
    task.gateway.emit("agent", agentEvent("run-x", 1, "lifecycle", { phase: "start" }));
    await until(() => task.transcript().runs[0]?.state === "running");
    call(task, "c1", TIMED_OUT);
    call(task, "c2", TIMED_OUT);
    await until(() => task.transcript().runs[0]?.steps.length === 2);
    await sleep(20);
    expect(task.gateway.calls("chat.abort")).toEqual([]);
    call(task, "c3", TIMED_OUT);
    await until(() => task.gateway.calls("chat.abort").length === 1);
    expect(task.gateway.calls("chat.abort")[0]).toEqual({ sessionKey: KEY, runId: "run-x" });
    expect(task.transcript().runs[0]).toMatchObject({ state: "stopping", stoppedForTimeouts: 3 });
    task.client.stop();
  });

  it("F-101: an automatic stop the gateway refuses leaves the run going, is not asked again, and a later Stop is not put down to the timeouts", async () => {
    const task = await openTask();
    let refuse = true;
    task.gateway.handlers["chat.abort"] = () => {
      if (refuse) throw new GatewayError({ code: "INVALID_REQUEST", message: "not now" });
      setTimeout(
        () =>
          task.gateway.emit(
            "agent",
            agentEvent("run-x", 50, "lifecycle", {
              phase: "end",
              status: "cancelled",
              aborted: true,
            }),
          ),
        0,
      );
      return { ok: true, aborted: true, runIds: ["run-x"] };
    };
    task.gateway.emit("agent", agentEvent("run-x", 1, "lifecycle", { phase: "start" }));
    await until(() => task.transcript().runs[0]?.state === "running");
    call(task, "c1", TIMED_OUT);
    call(task, "c2", TIMED_OUT);
    call(task, "c3", TIMED_OUT);
    await until(() => task.transcript().runs[0]?.stoppedForTimeouts === 0);
    expect(task.transcript().runs[0]!.state).toBe("running");
    call(task, "c4", TIMED_OUT);
    await sleep(30);
    expect(task.gateway.calls("chat.abort")).toHaveLength(1);
    // The person's own Stop later: its note is a plain stop's.
    refuse = false;
    await task.client.stopRun(KEY, "run-x");
    await until(() => task.transcript().runs[0]?.state === "stopped");
    expect(task.transcript().runs[0]!.stoppedForTimeouts).toBe(0);
    task.client.stop();
  });

  it("F-101: a call that finishes in time between them starts the count again", async () => {
    const task = await openTask();
    task.gateway.emit("agent", agentEvent("run-x", 1, "lifecycle", { phase: "start" }));
    await until(() => task.transcript().runs[0]?.state === "running");
    call(task, "c1", TIMED_OUT);
    call(task, "c2", TIMED_OUT);
    call(task, "c3", FINISHED);
    call(task, "c4", TIMED_OUT);
    call(task, "c5", TIMED_OUT);
    await until(() => task.transcript().runs[0]?.steps.length === 5);
    await sleep(30);
    expect(task.gateway.calls("chat.abort")).toEqual([]);
    expect(task.transcript().runs[0]!.state).toBe("running");
    task.client.stop();
  });
});

describe("a model request the gateway retries (F-082)", () => {
  it("F-082: run_status retrying says which attempt of how many, until the model answers", async () => {
    const task = await openTask();
    task.gateway.emit("agent", agentEvent("run-y", 1, "lifecycle", { phase: "start" }));
    // As OpenClaw 2026.10.6 sends it for a rate-limited provider.
    task.gateway.emit(
      "agent",
      agentEvent("run-y", 2, "run_status", {
        phase: "retrying",
        message: "Retrying… 2/5",
        retryAttempt: 1,
        maxRetries: 4,
        delayMs: 1000,
        attempt: 2,
        maxAttempts: 5,
        reason: "rate_limit",
      }),
    );
    await until(() => task.transcript().runs[0]?.retry !== undefined);
    expect(task.transcript().runs[0]!.retry).toEqual({ attempt: 2, of: 5, reason: "rate_limit" });
    task.gateway.emit(
      "agent",
      agentEvent("run-y", 3, "assistant", { text: "Here", delta: "Here" }),
    );
    await until(() => task.transcript().runs[0]?.retry === undefined);
    task.client.stop();
  });
});
