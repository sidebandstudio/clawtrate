// The events that started and ended a run, kept with the run as received, for
// the run line's and the turn error's Raw (F-094): only frames the engine took,
// a retried attempt under its own label, and for a run known only from history
// the row its end was read from.

import { describe, expect, it } from "vitest";
import { agentEvent, grantingGateway, openTask } from "./client-harness.ts";
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

  it("a failed run keeps the error that ended it", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.emit("agent", agentEvent("run-2", 1, "lifecycle", { phase: "start" }));
    const error = agentEvent("run-2", 2, "lifecycle", {
      phase: "error",
      error: "The model provider is overloaded.",
      executionSettled: true,
    });
    gateway.emit("agent", error);
    await until(() => transcript().runs.find((run) => run.id === "run-2")?.state === "failed");
    const run = transcript().runs.find((each) => each.id === "run-2")!;
    expect(run.lifecycle?.at(-1)).toEqual({ via: "agent (lifecycle error)", record: error });
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

  it("an attempt the gateway retries is kept under its own label, not as the run's end", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.emit("agent", agentEvent("run-4", 1, "lifecycle", { phase: "start" }));
    gateway.emit("agent", agentEvent("run-4", 2, "lifecycle", { phase: "error", error: "retry" }));
    await until(
      () => (transcript().runs.find((run) => run.id === "run-4")?.attemptErrors.length ?? 0) > 0,
    );
    await sleep(30);
    const run = transcript().runs.find((each) => each.id === "run-4")!;
    expect(run.state).toBe("running");
    expect(run.lifecycle?.map((each) => each.via)).toEqual([
      "agent (lifecycle start)",
      "agent (lifecycle error, attempt retried)",
    ]);
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
    expect(run?.lifecycle).toEqual([{ via: "chat.history (the run's last row)", record: row }]);
    client.stop();
  });
});
