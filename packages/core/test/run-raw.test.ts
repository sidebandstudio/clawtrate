// The events that started and ended a run, kept with the run as received, for
// the run line's and the turn error's Raw (F-094). A run known only from
// history keeps none, since history keeps no such event.

import { describe, expect, it } from "vitest";
import { agentEvent, openTask } from "./client-harness.ts";
import { until } from "./fake-gateway.ts";

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
