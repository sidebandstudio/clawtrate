// The events that started and ended a run, kept with the run as received, for
// the run line's and the turn error's Raw (F-094): only frames the engine took,
// never an error frame (that event is read from the host's Raw when Raw opens,
// F-301), and for a run known only from history the row its end was read from.

import { describe, expect, it } from "vitest";
import { agentEvent, grantingGateway, KEY, openTask } from "./client-harness.ts";
import { sleep, until } from "./fake-gateway.ts";

describe("F-094: a run's own events, for its Raw", () => {
  it("keeps the lifecycle start and end as the gateway sent them, the latest of each", async () => {
    const { client, gateway, transcript } = await openTask();
    const start = agentEvent("run-1", 1, "lifecycle", { phase: "start", startedAt: 1_001 });
    const end = agentEvent("run-1", 2, "lifecycle", { phase: "end", stopReason: "stop" });
    gateway.emit("agent", start);
    await until(() => transcript().runs.some((run) => run.id === "run-1"));
    gateway.emit("agent", end);
    await until(() => transcript().runs.find((run) => run.id === "run-1")?.state === "completed");
    const run = transcript().runs.find((each) => each.id === "run-1")!;
    expect(run.lifecycle).toEqual([
      { via: "agent (lifecycle start)", record: start },
      { via: "agent (lifecycle end)", record: end },
    ]);
    client.stop();
  });

  it("a failed run keeps its start but no error frame: the event that failed it is read from the host's Raw when Raw opens (F-301)", async () => {
    const { client, gateway, transcript } = await openTask();
    const start = agentEvent("run-2", 1, "lifecycle", { phase: "start" });
    gateway.emit("agent", start);
    gateway.emit(
      "agent",
      agentEvent("run-2", 2, "lifecycle", {
        phase: "error",
        error: "The model provider is overloaded.",
        executionSettled: true,
      }),
    );
    await until(() => transcript().runs.find((run) => run.id === "run-2")?.state === "failed");
    const run = transcript().runs.find((each) => each.id === "run-2")!;
    expect(run.lifecycle).toEqual([{ via: "agent (lifecycle start)", record: start }]);
    expect(client.readRunRaw(KEY, "run-2")).toMatchObject({
      status: "available",
      holds: "lifecycle-data",
    });
    client.stop();
  });

  it("a failed run's snapshot carries no error frame through its lifecycle: not a chat error, not a later end", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.emit("agent", agentEvent("run-5", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.some((run) => run.id === "run-5"));
    gateway.emit("chat", {
      runId: "run-5",
      sessionKey: KEY,
      seq: 2,
      state: "error",
      errorMessage: "The model provider is overloaded.",
      errorKind: "provider",
      errorDetail: { marker: "diagnostic-run-raw" },
    });
    await until(() => transcript().runs.find((run) => run.id === "run-5")?.state === "failed");
    gateway.emit(
      "agent",
      agentEvent("run-5", 3, "lifecycle", {
        phase: "end",
        stopReason: "error",
        error: { message: "The model provider is overloaded.", marker: "diagnostic-run-raw" },
      }),
    );
    await sleep(50);
    const run = transcript().runs.find((each) => each.id === "run-5")!;
    expect(run.lifecycle?.map((each) => each.via)).toEqual(["agent (lifecycle start)"]);
    expect(JSON.stringify(client.state)).not.toContain("diagnostic-run-raw");
    // The event is still there to read when Raw is opened.
    expect(client.readRunRaw(KEY, "run-5")).toMatchObject({ status: "available" });
    client.stop();
  });
});

describe("F-094: Raw holds only what the engine took, and says where it came from", () => {
  it("an older end the engine rejected is not kept as the run's end", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.emit("agent", agentEvent("run-3", 10, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.some((run) => run.id === "run-3"));
    gateway.emit("agent", agentEvent("run-3", 9, "lifecycle", { phase: "end" }));
    await sleep(50);
    const run = transcript().runs.find((each) => each.id === "run-3")!;
    expect(run.state).toBe("running");
    expect(run.lifecycle?.map((each) => each.via)).toEqual(["agent (lifecycle start)"]);
    client.stop();
  });

  it("an attempt the gateway retries keeps no error frame, and is not taken as the run's end", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.emit("agent", agentEvent("run-4", 1, "lifecycle", { phase: "start" }));
    gateway.emit("agent", agentEvent("run-4", 2, "lifecycle", { phase: "error", error: "retry" }));
    await until(
      () => (transcript().runs.find((run) => run.id === "run-4")?.attemptErrors.length ?? 0) > 0,
    );
    await sleep(30);
    const run = transcript().runs.find((each) => each.id === "run-4")!;
    expect(run.state).toBe("running");
    expect(run.lifecycle?.map((each) => each.via)).toEqual(["agent (lifecycle start)"]);
    client.stop();
  });

  it("a run known only from history keeps the row its end was read from", async () => {
    const gateway = grantingGateway();
    const row = {
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
      stopReason: "stop",
      __openclaw: { id: "a1", runId: "run-h" },
    };
    gateway.handlers["chat.history"] = () => ({
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }], __openclaw: { id: "u1" } },
        row,
      ],
    });
    const { client, transcript } = await openTask({ gateway });
    const run = transcript().runs.find((each) => each.id === "run-h");
    expect(run?.lifecycle).toEqual([
      { via: "chat.history (the run's last correlated row)", record: row },
    ]);
    client.stop();
  });

  it("a failed run read from history keeps its last correlated row under the ordinary history-row label, never as the row its end was read from", async () => {
    const gateway = grantingGateway();
    const tag = (id: string) => ({ id, runId: "run-history" });
    const failed = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "Gateway failed.",
      __openclaw: tag("a1"),
    };
    const late = {
      role: "toolResult",
      toolCallId: "call_late",
      content: [{ type: "text", text: "A late result." }],
      __openclaw: tag("t1"),
    };
    gateway.handlers["chat.history"] = () => ({ messages: [failed, late] });
    const { client, transcript } = await openTask({ gateway });
    const run = transcript().runs.find((each) => each.id === "run-history")!;
    expect(run.state).toBe("failed");
    expect(run.lifecycle).toEqual([
      { via: "chat.history (the run's last correlated row)", record: late },
    ]);
    client.stop();
  });
  it("a run stopped by the chat's abort keeps that frame; the lifecycle end after it, which the engine does not take, is not kept as its end", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.emit("agent", agentEvent("run-5", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.some((run) => run.id === "run-5"));
    const aborted = {
      runId: "run-5",
      sessionKey: KEY,
      seq: 2,
      state: "aborted",
      stopReason: "rpc",
    };
    gateway.emit("chat", aborted);
    await until(() => transcript().runs.find((run) => run.id === "run-5")?.state === "stopped");
    gateway.emit(
      "agent",
      agentEvent("run-5", 3, "lifecycle", { phase: "end", aborted: true, stopReason: "rpc" }),
    );
    await sleep(30);
    const run = transcript().runs.find((each) => each.id === "run-5")!;
    expect(run.lifecycle?.map((each) => each.via)).toEqual([
      "agent (lifecycle start)",
      "chat (aborted)",
    ]);
    expect(run.lifecycle?.at(-1)?.record).toEqual(aborted);
    client.stop();
  });
});
