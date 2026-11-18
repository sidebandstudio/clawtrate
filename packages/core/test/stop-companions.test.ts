// What a confirmed Stop also ends (F-296, F-297, F-298), as the gateway reports each:
// helper runs aborted with the run, other bots' runs its messages started, and
// processes it started on its machine.

import { describe, expect, it } from "vitest";
import { agentEvent, KEY, openTask } from "./client-harness.ts";
import { until } from "./fake-gateway.ts";

const PEER = "agent:marlow:main";

describe("Stop and what the run started (F-296, F-297, F-298)", () => {
  it("F-296 F-297 F-298: a confirmed Stop aborts the recipient's run, stops the processes the run started, and records them with the gateway's helpers", async () => {
    const { client, gateway, transcript } = await openTask();
    const started = Date.now();
    gateway.handlers["chat.abort"] = (params) =>
      (params as { sessionKey: string }).sessionKey === KEY
        ? { ok: true, aborted: true, runIds: ["run-s", "helper-1", "helper-2"] }
        : { ok: true, aborted: true, runIds: ["run-r"] };
    gateway.handlers["sessions.processes.list"] = () => ({
      sessionId: "session-1",
      truncated: false,
      processes: [
        // Started by this run.
        {
          processId: "p-1",
          instanceId: "i-1",
          name: "sleep 60",
          status: "running",
          startedAt: started + 50,
          tail: "",
          truncated: false,
          canStop: true,
        },
        // Started before it: another run's.
        {
          processId: "p-0",
          instanceId: "i-0",
          name: "tail -f log",
          status: "running",
          startedAt: started - 60_000,
          tail: "",
          truncated: false,
          canStop: true,
        },
        // Already ended.
        {
          processId: "p-2",
          instanceId: "i-2",
          name: "ls",
          status: "completed",
          startedAt: started + 60,
          tail: "",
          truncated: false,
          canStop: false,
        },
      ],
    });
    gateway.handlers["sessions.processes.stop"] = () => ({ requested: true });
    gateway.emit("agent", {
      ...agentEvent("run-s", 1, "lifecycle", { phase: "start", startedAt: started }),
      ts: started,
    });
    gateway.emit(
      "agent",
      agentEvent("run-s", 2, "tool", {
        phase: "result",
        name: "sessions_send",
        toolCallId: "c1",
        isError: false,
        result: {
          content: [{ type: "text", text: "{}" }],
          details: { runId: "run-r", sessionKey: PEER, status: "accepted" },
        },
      }),
    );
    gateway.emit("agent", agentEvent("run-r", 1, "lifecycle", { phase: "start" }, PEER));
    await until(() => transcript().linkedRuns["run-r"]?.state === "running");
    await client.stopRun(KEY, "run-s");
    await until(() => gateway.calls("sessions.processes.stop").length === 1);
    await until(() => (transcript().runs[0]!.stoppedWith?.bots.length ?? 0) === 1);
    expect(gateway.calls("chat.abort")).toEqual([
      { sessionKey: KEY, runId: "run-s" },
      { sessionKey: PEER, runId: "run-r" },
    ]);
    expect(gateway.calls("sessions.processes.stop")).toEqual([
      { key: KEY, sessionId: "session-1", processId: "p-1", instanceId: "i-1" },
    ]);
    await until(() => (transcript().runs[0]!.stoppedWith?.processes.length ?? 0) === 1);
    expect(transcript().runs[0]!.stoppedWith).toEqual({
      helpers: 2,
      bots: [PEER],
      processes: ["sleep 60"],
      uncertain: [],
    });
    client.stop();
  });

  it("F-296 F-298: a recipient whose run ended is not stopped, and nothing is claimed when the gateway stopped nothing", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["chat.abort"] = (params) =>
      (params as { sessionKey: string }).sessionKey === KEY
        ? { ok: true, aborted: true, runIds: ["run-s"] }
        : { ok: true, aborted: false, runIds: [] };
    gateway.handlers["sessions.processes.list"] = () => ({
      sessionId: "s",
      truncated: false,
      processes: [],
    });
    gateway.emit("agent", agentEvent("run-s", 1, "lifecycle", { phase: "start" }));
    gateway.emit(
      "agent",
      agentEvent("run-s", 2, "tool", {
        phase: "result",
        name: "sessions_send",
        toolCallId: "c1",
        isError: false,
        result: {
          content: [{ type: "text", text: "{}" }],
          details: { runId: "run-q", sessionKey: "agent:pip:main", status: "accepted" },
        },
      }),
    );
    await until(() => transcript().runs[0]?.steps.length === 1);
    await client.stopRun(KEY, "run-s");
    await until(() => gateway.calls("sessions.processes.list").length === 1);
    await until(() => gateway.calls("chat.abort").length === 2);
    expect(transcript().runs[0]!.stoppedWith).toBeUndefined();
    client.stop();
  });
});
