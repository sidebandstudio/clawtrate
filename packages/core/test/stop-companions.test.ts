// What this client's Stop also ends (F-296, F-298), as the gateway reports each: helper runs
// aborted with the run, and other bots' runs its messages started, taken from the run's own
// record however the stop's end arrived. No process is stopped with a run: the gateway's process
// list does not say which run started one (F-297).

import { describe, expect, it } from "vitest";
import { agentEvent, KEY, openTask, asShown } from "./client-harness.ts";
import { GatewayError, sleep, until } from "./fake-gateway.ts";

const PEER = "agent:marlow:main";

/** The run `run-s` has messaged each of these sessions, whose runs it names. */
function messaged(
  gateway: { emit: (event: string, payload: unknown) => void },
  links: Array<[string, string]>,
) {
  gateway.emit("agent", agentEvent("run-s", 1, "lifecycle", { phase: "start" }));
  links.forEach(([sessionKey, runId], index) =>
    gateway.emit(
      "agent",
      agentEvent("run-s", index + 2, "tool", {
        phase: "result",
        name: "sessions_send",
        toolCallId: `c${index}`,
        isError: false,
        result: {
          content: [{ type: "text", text: "{}" }],
          details: { runId, sessionKey, status: "accepted" },
        },
      }),
    ),
  );
}

const ended = (seq: number) =>
  agentEvent("run-s", seq, "lifecycle", { phase: "end", status: "cancelled", aborted: true });

describe("Stop and what the run started (F-296, F-298)", () => {
  it("F-296 F-298: a confirmed Stop aborts the recipient's exact run, records it with the gateway's helpers, and stops no process", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["chat.abort"] = (params) => {
      if ((params as { sessionKey: string }).sessionKey !== KEY)
        return { ok: true, aborted: true, runIds: ["run-r"] };
      setTimeout(() => gateway.emit("agent", ended(9)), 0);
      return { ok: true, aborted: true, runIds: ["run-s", "helper-1", "helper-2"] };
    };
    messaged(gateway, [[PEER, "run-r"]]);
    gateway.emit("agent", agentEvent("run-r", 1, "lifecycle", { phase: "start" }, PEER));
    await until(() => transcript().linkedRuns["run-r"]?.state === "running");
    await client.stopRun(KEY, "run-s");
    await until(() => (transcript().runs[0]!.stoppedWith?.bots.length ?? 0) === 1);
    expect(gateway.calls("chat.abort")).toEqual([
      { sessionKey: KEY, runId: "run-s" },
      { sessionKey: PEER, runId: "run-r" },
    ]);
    expect(transcript().runs[0]!.stoppedWith).toEqual({
      helpers: 2,
      bots: [PEER],
      uncertain: [],
      refused: [],
      unanswered: [],
      omitted: 0,
      recipientsAsked: true,
    });
    expect(gateway.calls("sessions.processes.list")).toEqual([]);
    expect(gateway.calls("sessions.processes.stop")).toEqual([]);
    client.stop();
  });

  it("F-296: when the abort's answer is lost, the run's own end still stops the recipient, once the connection is back", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["chat.abort"] = (params) => {
      if ((params as { sessionKey: string }).sessionKey !== KEY)
        return { ok: true, aborted: true, runIds: ["run-r"] };
      // The gateway stops the run and says so, then the connection drops before its answer.
      gateway.emit("agent", ended(9));
      gateway.dropAll();
      return new Promise(() => {});
    };
    messaged(gateway, [[PEER, "run-r"]]);
    await until(() => transcript().runs[0]?.steps.length === 1);
    void client.stopRun(KEY, "run-s");
    await until(() => transcript().runs[0]!.state === "stopped");
    await until(() => (transcript().runs[0]!.stoppedWith?.bots.length ?? 0) === 1);
    expect(gateway.calls("chat.abort")).toContainEqual({ sessionKey: PEER, runId: "run-r" });
    client.stop();
  });

  it("F-296: a /stop typed in the task stops the runs of the bots the stopped run messaged", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["chat.send"] = () => {
      setTimeout(() => gateway.emit("agent", ended(9)), 0);
      return { ok: true, aborted: true, runIds: ["run-s"] };
    };
    gateway.handlers["chat.abort"] = () => ({ ok: true, aborted: true, runIds: ["run-r"] });
    messaged(gateway, [[PEER, "run-r"]]);
    await until(() => transcript().runs[0]?.steps.length === 1);
    client.sendMessage(KEY, "/stop", asShown(client));
    await until(() => (transcript().runs[0]!.stoppedWith?.bots.length ?? 0) === 1);
    expect(gateway.calls("chat.abort")).toEqual([{ sessionKey: PEER, runId: "run-r" }]);
    expect(transcript().runs[0]!.stopRequestedAt).not.toBeNull();
    client.stop();
  });

  it("F-296 F-298: every recipient is asked, past the eight the note names; one whose stop is refused is named as refused", async () => {
    const { client, gateway, transcript } = await openTask();
    const links: Array<[string, string]> = Array.from({ length: 10 }, (_, i) => [
      `agent:bot${i}:main`,
      `run-${i}`,
    ]);
    gateway.handlers["chat.abort"] = (params) => {
      const { sessionKey } = params as { sessionKey: string };
      if (sessionKey === KEY) {
        setTimeout(() => gateway.emit("agent", ended(20)), 0);
        return { ok: true, aborted: true, runIds: ["run-s"] };
      }
      if (sessionKey === "agent:bot9:main")
        throw new GatewayError({ code: "INVALID_REQUEST", message: "not allowed" });
      return { ok: true, aborted: true, runIds: [] };
    };
    messaged(gateway, links);
    await until(() => transcript().runs[0]?.steps.length === 10);
    await client.stopRun(KEY, "run-s");
    await until(() => gateway.calls("chat.abort").length === 11);
    await until(() => (transcript().runs[0]!.stoppedWith?.refused.length ?? 0) === 1);
    const record = transcript().runs[0]!.stoppedWith!;
    expect(record.bots).toHaveLength(8);
    expect(record.omitted).toBe(1);
    expect(record.refused).toEqual(["agent:bot9:main"]);
    client.stop();
  });

  it("F-296 F-298: a recipient whose run ended is not stopped, and nothing is claimed when the gateway stopped nothing", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["chat.abort"] = (params) => {
      if ((params as { sessionKey: string }).sessionKey !== KEY)
        return { ok: true, aborted: false, runIds: [] };
      setTimeout(() => gateway.emit("agent", ended(9)), 0);
      return { ok: true, aborted: true, runIds: ["run-s"] };
    };
    messaged(gateway, [["agent:pip:main", "run-q"]]);
    await until(() => transcript().runs[0]?.steps.length === 1);
    await client.stopRun(KEY, "run-s");
    await until(() => gateway.calls("chat.abort").length === 2);
    await until(() => transcript().runs[0]!.stoppedWith?.recipientsAsked === true);
    const record = transcript().runs[0]!.stoppedWith!;
    expect([record.bots, record.uncertain, record.refused, record.unanswered]).toEqual([
      [],
      [],
      [],
      [],
    ]);
    client.stop();
  });
});

describe("Stop that this client did not get confirmed (F-296, F-101)", () => {
  it("F-296 F-101: a refused local Stop followed by an external stop does not abort recipients", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["chat.abort"] = () => {
      throw new GatewayError({ code: "INVALID_REQUEST", message: "not now" });
    };
    messaged(gateway, [[PEER, "run-r"]]);
    await until(() => transcript().runs[0]?.steps.length === 1);
    await client.stopRun(KEY, "run-s");
    await until(() => transcript().runs[0]?.stopError != null);
    // Someone else stops the parent.
    gateway.emit("agent", ended(9));
    await until(() => transcript().runs[0]?.state === "stopped");
    await sleep(50);
    expect(gateway.calls("chat.abort")).toEqual([{ sessionKey: KEY, runId: "run-s" }]);
    expect(transcript().runs[0]!.stopRequestedAt).toBeNull();
    client.stop();
  });

  it("F-296: a Stop whose answer was lost and whose end history does not show stops no recipient until the parent's own end arrives", async () => {
    const { client, gateway, transcript } = await openTask();
    let parentAnswered = false;
    gateway.handlers["chat.abort"] = (params) => {
      if ((params as { sessionKey: string }).sessionKey !== KEY)
        return { ok: true, aborted: true, runIds: ["run-r"] };
      if (parentAnswered) return { ok: true, aborted: true, runIds: ["run-s"] };
      parentAnswered = true;
      gateway.dropAll();
      return new Promise(() => {});
    };
    messaged(gateway, [[PEER, "run-r"]]);
    await until(() => transcript().runs[0]?.steps.length === 1);
    void client.stopRun(KEY, "run-s");
    // After the reconnect history shows neither the parent nor its end.
    await until(() => gateway.calls("chat.history").length >= 2);
    await sleep(100);
    expect(
      gateway
        .calls("chat.abort")
        .filter((each) => (each as { sessionKey: string }).sessionKey === PEER),
    ).toEqual([]);
    // The parent's own end, as the gateway says it.
    gateway.emit("agent", ended(9));
    await until(() => (transcript().runs[0]!.stoppedWith?.bots.length ?? 0) === 1);
    expect(gateway.calls("chat.abort")).toContainEqual({ sessionKey: PEER, runId: "run-r" });
    client.stop();
  });
});

describe("Stop with results no longer kept (F-296)", () => {
  it("F-296: an omitted recipient result does not make a complete companion-stop claim", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["chat.abort"] = (params) => {
      if ((params as { sessionKey: string }).sessionKey !== KEY)
        return { ok: true, aborted: true, runIds: ["run-r"] };
      setTimeout(() => gateway.emit("agent", ended(9_000)), 0);
      return { ok: true, aborted: true, runIds: ["run-s"] };
    };
    // The child is named by the parent's first result; many later calls push it out of the record.
    messaged(gateway, [[PEER, "run-r"]]);
    for (let n = 0; n < 140; n += 1)
      gateway.emit(
        "agent",
        agentEvent("run-s", 100 + n, "tool", {
          phase: "result",
          name: "read",
          toolCallId: `r${n}`,
          isError: false,
          result: { content: [{ type: "text", text: "ok" }] },
        }),
      );
    await until(() => (transcript().runs[0]?.omittedTools ?? 0) > 0);
    await client.stopRun(KEY, "run-s");
    await until(() => transcript().runs[0]?.stoppedWith?.recipientsAsked === true);
    // Nothing claims the child was stopped; the record says actions are missing instead.
    expect(transcript().runs[0]!.stoppedWith!.bots).toEqual([]);
    expect(transcript().runs[0]!.omittedTools).toBeGreaterThan(0);
    client.stop();
  });
});
