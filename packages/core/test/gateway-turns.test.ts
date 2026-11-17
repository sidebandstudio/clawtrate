// Turns whose identity or end the gateway reports otherwise than the client
// asked: a Stop before the gateway has taken the send, a send answered as
// already aborted, a turn the gateway ran from its queue under an id of its
// own, and a turn the gateway wrote itself.
// Each event order below was recorded from OpenClaw 2026.10.6 on a named
// development instance.

import { describe, expect, it } from "vitest";
import { agentEvent, grantingGateway, KEY, openTask } from "./client-harness.ts";
import { deferred, sleep, until } from "./fake-gateway.ts";

const runIds = (runs: { id: string; state: string }[]) => runs.map((run) => [run.id, run.state]);

describe("a Stop pressed before the gateway has taken the send (F-097)", () => {
  it("F-097: waits for the send's answer and then aborts the run it names, never an abort without a run", async () => {
    const gateway = grantingGateway();
    const answer = deferred<unknown>();
    gateway.handlers["chat.send"] = () => answer.promise;
    const { client, transcript } = await openTask({ gateway });
    const id = client.sendMessage(KEY, "Take a while #slow 20");
    await until(() => transcript().runs[0]?.state === "running");
    // Recorded: an abort that reaches the gateway before it has registered the send aborts
    // nothing ({aborted: false, runIds: []}), with or without the run's id, and the turn runs
    // in full. So nothing is sent yet.
    await client.stopRun(KEY, id);
    expect(transcript().runs[0]!.state).toBe("stopping");
    await sleep(30);
    expect(gateway.calls("chat.abort")).toEqual([]);
    answer.resolve({ runId: id, status: "started" });
    await until(() => gateway.calls("chat.abort").length === 1);
    expect(gateway.calls("chat.abort")[0]).toEqual({ sessionKey: KEY, runId: id });
    gateway.emit("chat", {
      runId: id,
      sessionKey: KEY,
      seq: 3,
      state: "aborted",
      stopReason: "rpc",
    });
    await until(() => transcript().runs[0]?.state === "stopped");
    client.stop();
  });

  it("F-097: a send the gateway answers as aborted before it ran ends stopped, with no event to follow", async () => {
    const gateway = grantingGateway();
    // Recorded: an abort that landed while the gateway was admitting the send. The answer is
    // the gateway's aborted-send payload, and no agent or chat event of the run ever comes.
    gateway.handlers["chat.send"] = (params) => ({
      runId: (params as { idempotencyKey: string }).idempotencyKey,
      status: "timeout",
      summary: "aborted",
      stopReason: "rpc",
      endedAt: 5_000,
    });
    gateway.handlers["chat.history"] = () => ({ messages: [] });
    const { client, transcript } = await openTask({ gateway });
    const id = client.sendMessage(KEY, "Never mind");
    await until(() => transcript().runs[0]?.state === "stopped");
    expect(transcript().runs[0]).toMatchObject({ id, bound: true, endedAt: 5_000 });
    expect(transcript().live).toBeNull();
    client.stop();
  });
});

describe("a turn the gateway ran from its queue under an id of its own", () => {
  // Recorded order: the gateway's id (X) reports run_status, the send's id (C) the turn's
  // lifecycle, text and end; sessions.changed names both; history stores the rows under X.
  const X = "gateway-own-run";
  const C = "queued-send";
  const history = (inFlight: string | null) => ({
    messages: [
      {
        role: "user",
        content: "queued #text",
        __openclaw: { id: "u1", seq: 1, idempotencyKey: `${C}:user` },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Here is a plain reply." }],
        __openclaw: { id: "a1", seq: 2, runId: X },
      },
    ],
    ...(inFlight ? { inFlightRun: { runId: inFlight } } : {}),
  });

  it("is one run, settled by its end, never a second run left working", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.history"] = () => ({ messages: [] });
    const { client, transcript } = await openTask({ gateway });
    gateway.emit("agent", agentEvent(X, 1, "run_status", { phase: "preparing_workspace" }));
    gateway.emit("agent", agentEvent(X, 2, "run_status", { phase: "preparing_context" }));
    gateway.emit("chat", {
      runId: C,
      sessionKey: KEY,
      seq: 1,
      state: "status",
      phase: "starting_model",
    });
    gateway.emit("agent", agentEvent(C, 1, "lifecycle", { phase: "model", provider: "scripted" }));
    gateway.emit(
      "agent",
      agentEvent(C, 2, "assistant", {
        text: "Here is a plain reply.",
        delta: "Here is a plain reply.",
      }),
    );
    gateway.emit("sessions.changed", { sessionKey: KEY, runId: X, clientRunId: C, phase: "model" });
    await until(() => transcript().steerAliases[X] === C);
    // The gateway's id is the send's run, not a run of its own.
    expect(transcript().runs.map((run) => run.id)).toEqual([C]);
    gateway.handlers["chat.history"] = () => history(null);
    gateway.emit("agent", agentEvent(C, 3, "lifecycle", { phase: "end", stopReason: "stop" }));
    gateway.emit("sessions.changed", { sessionKey: KEY, runId: X, clientRunId: C, phase: "end" });
    gateway.emit("chat", { runId: C, sessionKey: KEY, seq: 3, state: "final" });
    await until(() => transcript().items.length === 2);
    await sleep(200);
    // History's rows under the gateway's id are that same run.
    expect(runIds(transcript().runs)).toEqual([[C, "completed"]]);
    client.stop();
  });

  it("reads history again when only sessions.changed reports the end of a run it still shows working", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.history"] = () => ({ messages: [] });
    const { client, transcript } = await openTask({ gateway });
    gateway.emit("agent", agentEvent(X, 1, "run_status", { phase: "preparing_workspace" }));
    gateway.emit("agent", agentEvent(X, 2, "lifecycle", { phase: "start", startedAt: 10 }));
    await until(() => transcript().runs[0]?.state === "running");
    const reads = gateway.calls("chat.history").length;
    gateway.handlers["chat.history"] = () => history(null);
    // Its own end never reaches this client under X; the row naming it does.
    gateway.emit("sessions.changed", { sessionKey: KEY, runId: X, phase: "end" });
    await until(() => gateway.calls("chat.history").length > reads);
    await until(() => transcript().runs[0]?.state === "completed");
    client.stop();
  });
});

describe("a turn the gateway wrote itself", () => {
  const recovery = {
    role: "user",
    content:
      "[System] Your previous turn was interrupted by a gateway restart while OpenClaw was waiting on tool/model work.",
    provenance: {
      kind: "internal_system",
      sourceSessionKey: KEY,
      sourceTool: "main_session_restart_recovery",
    },
    __openclaw: { id: "r1", seq: 1 },
  };

  it("shows the gateway's prompt as a line saying what the gateway did, never as the person's message", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.history"] = () => ({
      messages: [
        recovery,
        {
          role: "assistant",
          content: [{ type: "text", text: "Picking up where I left off." }],
          __openclaw: { id: "a1", seq: 2, runId: "resumed" },
        },
      ],
    });
    const { client, transcript } = await openTask({ gateway });
    await until(() => transcript().items.length === 2);
    expect(transcript().items[0]).toMatchObject({
      role: "system",
      blocks: [{ kind: "text", text: "The gateway resumed an earlier turn by itself" }],
    });
    expect(JSON.stringify(transcript().items)).not.toContain("interrupted by a gateway restart");
    expect(transcript().runs[0]).toMatchObject({ id: "resumed", anchorItemId: "r1:0" });
    client.stop();
  });

  it("never settles the person's message, even at the sequence number the send returned", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.send"] = () => ({ status: "accepted", messageSeq: 1 });
    gateway.handlers["chat.history"] = () => ({ messages: [] });
    const { client, transcript } = await openTask({ gateway });
    client.sendMessage(KEY, "Is it done?");
    await until(() => transcript().outbox[0]?.status !== "sending");
    gateway.handlers["chat.history"] = () => ({ messages: [recovery] });
    gateway.emit("session.message", { sessionKey: KEY });
    await until(() => transcript().items.length === 1);
    expect(transcript().outbox).toHaveLength(1);
    client.stop();
  });
});
