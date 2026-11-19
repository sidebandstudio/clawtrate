// Turns whose identity or end the gateway reports otherwise than the client
// asked: a Stop before the gateway has taken the send, a send answered as
// already aborted, a turn the gateway ran from its queue under an id of its
// own, a turn the gateway wrote itself, and a deleted session's followed runs.
// Each event order below was recorded from OpenClaw 2026.10.6 on a named
// development instance.

import { describe, expect, it } from "vitest";
import { agentEvent, grantingGateway, KEY, openTask, questionRecord } from "./client-harness.ts";
import { deferred, sleep, until } from "./fake-gateway.ts";
import { MAX_RAW_ENTRY_CHARS, RawTable, runsFromHistory } from "../src/runs.ts";

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
    await until(() => transcript().queueAliases[X] === C);
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

describe("a deleted session nobody had open", () => {
  const PEER = "agent:marlow:review-peer";

  it("session deletion retires a foreign pending question and its run", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.emit(
      "agent",
      agentEvent("sender-r", 1, "tool", {
        phase: "start",
        name: "sessions_send",
        toolCallId: "send-c",
        args: { sessionKey: PEER, message: "A message" },
      }),
    );
    gateway.emit(
      "agent",
      agentEvent("sender-r", 2, "tool", {
        phase: "result",
        name: "sessions_send",
        toolCallId: "send-c",
        isError: false,
        result: {
          content: [{ type: "text", text: "{}" }],
          details: { status: "accepted", sessionKey: PEER, runId: "peer-r" },
        },
      }),
    );
    gateway.emit("agent", agentEvent("peer-r", 1, "lifecycle", { phase: "start" }, PEER));
    await until(() => transcript().linkedRuns["peer-r"]?.state === "running");
    gateway.emit("question.requested", questionRecord("foreign-q", "peer-r", PEER));
    await until(() => transcript().linkedRuns["peer-r"]?.state === "waiting");
    gateway.emit("sessions.changed", { sessionKey: PEER, reason: "delete" });
    await until(() => transcript().linkedRuns["peer-r"]?.state === "cancelled");
    const foreign = (client as unknown as { foreign: Map<string, unknown> }).foreign;
    expect(foreign.has(PEER)).toBe(false);
    client.stop();
  });
});

describe("a recipient's task let go while its sender's task is open", () => {
  const PEER = "agent:marlow:main";

  it("F-122: keeps following the recipient's run, so the sender's card sees it wait and end", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.history"] = (params) =>
      (params as { sessionKey: string }).sessionKey === PEER
        ? { messages: [], inFlightRun: { runId: "peer-r" } }
        : { messages: [] };
    const { client, transcript } = await openTask({ gateway });
    gateway.emit(
      "agent",
      agentEvent("sender-r", 1, "tool", {
        phase: "start",
        name: "sessions_send",
        toolCallId: "send-c",
        args: { sessionKey: PEER, message: "A message" },
      }),
    );
    gateway.emit(
      "agent",
      agentEvent("sender-r", 2, "tool", {
        phase: "result",
        name: "sessions_send",
        toolCallId: "send-c",
        isError: false,
        result: {
          content: [{ type: "text", text: "{}" }],
          details: { status: "accepted", sessionKey: PEER, runId: "peer-r" },
        },
      }),
    );
    gateway.emit("agent", agentEvent("peer-r", 1, "lifecycle", { phase: "start" }, PEER));
    await until(() => transcript().linkedRuns["peer-r"]?.state === "running");
    // The recipient asks its own user: its run, waiting on that question, is carried into its
    // task when the person opens it there. They answer there and go back: the task is let go.
    gateway.emit("question.requested", questionRecord("peer-q", "peer-r", PEER));
    await until(() => transcript().linkedRuns["peer-r"]?.state === "waiting");
    client.openSession(PEER);
    await until(() => client.state.transcripts[PEER]?.status === "ready");
    gateway.emit("question.resolved", { id: "peer-q", status: "answered" });
    await until(() => transcript().linkedRuns["peer-r"]?.state === "running");
    client.closeSession(PEER);
    await until(() => client.state.transcripts[PEER] === undefined);
    gateway.emit("agent", agentEvent("sender-r", 3, "lifecycle", { phase: "end" }));
    await until(() => transcript().runs[0]?.state === "completed");
    expect(transcript().linkedRuns["peer-r"]?.state).toBe("running");
    gateway.emit("agent", agentEvent("peer-r", 2, "lifecycle", { phase: "end" }, PEER));
    await until(() => transcript().linkedRuns["peer-r"]?.state === "completed");
    client.stop();
  });

  it("F-122: a sender opened after its recipient's task was let go reads the recipient's run from history", async () => {
    const gateway = grantingGateway();
    let peerEnded = false;
    gateway.handlers["chat.history"] = (params) => {
      if ((params as { sessionKey: string }).sessionKey !== PEER)
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "send-c",
                  name: "sessions_send",
                  arguments: { sessionKey: PEER, message: "A message" },
                },
              ],
              __openclaw: { id: "a1", runId: "sender-r" },
            },
            {
              role: "toolResult",
              toolCallId: "send-c",
              toolName: "sessions_send",
              isError: false,
              content: [{ type: "text", text: "{}" }],
              details: { status: "accepted", sessionKey: PEER, runId: "peer-r" },
              __openclaw: { id: "t1", runId: "sender-r" },
            },
            {
              role: "assistant",
              content: [{ type: "text", text: "Sent." }],
              stopReason: "stop",
              __openclaw: { id: "a2", runId: "sender-r" },
            },
          ],
        };
      return peerEnded
        ? {
            messages: [
              {
                role: "assistant",
                content: [{ type: "text", text: "Lake loop it is." }],
                stopReason: "stop",
                __openclaw: { id: "p1", runId: "peer-r" },
              },
            ],
          }
        : { messages: [], inFlightRun: { runId: "peer-r" } };
    };
    const { client, transcript } = await openTask({ gateway });
    await until(() => transcript().linkedRuns["peer-r"]?.state === "running");
    // The person leaves the sender's task for the recipient's, where its run ends; then that
    // task is let go too, before the sender's is opened again: nothing follows the run now.
    client.closeSession(KEY);
    client.openSession(PEER);
    await until(() => client.state.transcripts[PEER]?.status === "ready");
    peerEnded = true;
    gateway.emit("agent", agentEvent("peer-r", 2, "lifecycle", { phase: "end" }, PEER));
    await until(() => client.state.transcripts[PEER]?.runs[0]?.state === "completed");
    client.closeSession(PEER);
    await until(() => client.state.transcripts[PEER] === undefined);
    client.openSession(KEY);
    // The sender's card follows what the recipient's history establishes: the run ended.
    await until(() => client.state.transcripts[KEY]?.linkedRuns["peer-r"]?.state === "completed");
    client.stop();
  });
});

describe("a queued turn's two ids stay one run", () => {
  const X = "gateway-own-run";
  const C = "queued-send";

  it("a late frame under the gateway's id, after the send's run ended, updates that run and makes no other", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.history"] = () => ({ messages: [] });
    const { client, transcript } = await openTask({ gateway });
    gateway.emit("agent", agentEvent(X, 1, "run_status", { phase: "preparing_workspace" }));
    gateway.emit("agent", agentEvent(C, 1, "lifecycle", { phase: "start" }));
    gateway.emit("sessions.changed", { sessionKey: KEY, runId: X, clientRunId: C, phase: "start" });
    await until(() => transcript().queueAliases[X] === C);
    gateway.emit("chat", { runId: C, sessionKey: KEY, seq: 2, state: "final" });
    await until(() => transcript().runs[0]?.state === "completed");
    gateway.emit("agent", agentEvent(X, 2, "run_status", { phase: "cleanup" }));
    gateway.emit("chat", { runId: X, sessionKey: KEY, seq: 3, state: "final" });
    await sleep(50);
    expect(runIds(transcript().runs)).toEqual([[C, "completed"]]);
    client.stop();
  });

  it("after a reconnect that missed the pairing, history pairs them: one run, still running", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.history"] = () => ({ messages: [] });
    const { client, transcript } = await openTask({ gateway });
    gateway.emit("agent", agentEvent(C, 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs[0]?.state === "running");
    gateway.handlers["chat.history"] = () => ({
      messages: [
        { role: "user", content: "queued", __openclaw: { id: "u1", idempotencyKey: `${C}:user` } },
        {
          role: "assistant",
          content: [{ type: "text", text: "Still working" }],
          __openclaw: { id: "a1", runId: X },
        },
      ],
      inFlightRun: { runId: X },
    });
    gateway.dropAll();
    await until(() => transcript().caughtUp?.reason === "reconnect");
    expect(runIds(transcript().runs)).toEqual([[C, "running"]]);
    // A frame under the gateway's id afterwards updates the same run.
    gateway.emit("agent", agentEvent(X, 9, "lifecycle", { phase: "end" }));
    await until(() => transcript().runs[0]?.state === "completed");
    expect(transcript().runs).toHaveLength(1);
    client.stop();
  });

  it("a transcript built from history alone pairs them, from history itself: one run, in flight", async () => {
    const gateway = grantingGateway();
    // The gateway ran the turn from its queue: the earlier turn, then the queued one's user row
    // under the send's key and its rows under the gateway's own id, in flight under the send's.
    gateway.handlers["chat.history"] = () => ({
      messages: [
        { role: "user", content: "first", __openclaw: { id: "u0", idempotencyKey: "first:user" } },
        {
          role: "assistant",
          content: [{ type: "text", text: "First done" }],
          stopReason: "stop",
          __openclaw: { id: "a0", runId: "first" },
        },
        { role: "user", content: "queued", __openclaw: { id: "u1", idempotencyKey: `${C}:user` } },
        {
          role: "assistant",
          content: [{ type: "text", text: "Working on it" }],
          __openclaw: { id: "a1", runId: X },
        },
      ],
      inFlightRun: { runId: C },
    });
    const { client, transcript } = await openTask({ gateway });
    await until(() => transcript().runs.length > 0 && transcript().status === "ready");
    expect(runIds(transcript().runs)).toEqual([
      ["first", "completed"],
      [C, "running"],
    ]);
    expect(transcript().queueAliases).toEqual({ [X]: C });
    // A late frame under either id is that one run.
    gateway.emit("agent", agentEvent(X, 2, "run_status", { phase: "model" }));
    gateway.emit("agent", agentEvent(C, 3, "lifecycle", { phase: "end" }));
    await until(() => transcript().runs.find((run) => run.id === C)?.state === "completed");
    expect(transcript().runs).toHaveLength(2);
    client.stop();
  });

  it("a steer's user row inside the run it was sent into pairs nothing", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.history"] = () => ({
      messages: [
        { role: "user", content: "start", __openclaw: { id: "u0", idempotencyKey: "base:user" } },
        {
          role: "assistant",
          content: [{ type: "text", text: "Looking" }],
          __openclaw: { id: "a0", runId: "base" },
        },
        { role: "user", content: "steer", __openclaw: { id: "u1", idempotencyKey: "steer:user" } },
        {
          role: "assistant",
          content: [{ type: "text", text: "Only the photos, then" }],
          stopReason: "stop",
          __openclaw: { id: "a1", runId: "base" },
        },
      ],
    });
    const { client, transcript } = await openTask({ gateway });
    await until(() => transcript().status === "ready" && transcript().runs.length > 0);
    expect(transcript().queueAliases).toEqual({});
    expect(runIds(transcript().runs)).toEqual([["base", "completed"]]);
    client.stop();
  });
});

describe("a steer the gateway admits as a run of its own", () => {
  it("keeps its own id, its own history and its own anchor, apart from the run it was sent into", async () => {
    const gateway = grantingGateway();
    const answer = deferred<unknown>();
    gateway.handlers["chat.send"] = () => answer.promise;
    gateway.handlers["chat.history"] = () => ({ messages: [] });
    const { client, transcript } = await openTask({ gateway });
    gateway.emit("agent", agentEvent("base", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs[0]?.state === "running");
    const id = client.sendMessage(KEY, "Only the photos, please.");
    await until(() => gateway.calls("chat.send").length === 1);
    await client.stopRun(KEY, "base");
    answer.resolve({ runId: id, status: "started" });
    await until(() => transcript().outbox[0]?.status === "sent");
    gateway.emit("chat", {
      runId: "base",
      sessionKey: KEY,
      seq: 2,
      state: "aborted",
      stopReason: "rpc",
    });
    // Recorded: a steer racing a Stop admitted as a run of its own, which streams and ends.
    gateway.emit("agent", agentEvent(id, 1, "lifecycle", { phase: "start" }));
    gateway.emit("agent", agentEvent(id, 2, "assistant", { text: "On it.", delta: "On it." }));
    await until(() => transcript().runs.some((run) => run.id === id));
    expect(transcript().runs.find((run) => run.id === "base")?.state).toBe("stopped");
    gateway.handlers["chat.history"] = () => ({
      messages: [
        { role: "user", content: "first", __openclaw: { id: "u1" } },
        { role: "assistant", content: "first partial", __openclaw: { id: "a1", runId: "base" } },
        {
          role: "user",
          content: "Only the photos, please.",
          __openclaw: { id: "u2", idempotencyKey: `${id}:user` },
        },
        { role: "assistant", content: "On it.", __openclaw: { id: "a2", runId: id } },
      ],
    });
    gateway.emit("chat", {
      runId: id,
      sessionKey: KEY,
      seq: 3,
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text: "On it." }] },
    });
    await until(() => transcript().items.length === 4);
    await until(() => transcript().runs.find((run) => run.id === id)?.state === "completed");
    expect(transcript().runs.find((run) => run.id === "base")?.state).toBe("stopped");
    expect(transcript().runs.find((run) => run.id === id)?.anchorItemId).toBe("u2:2");
    client.stop();
  });

  it("a steer the gateway joins to the run is acknowledged by one bare final, which shows nothing", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.send"] = () => ({ runId: "steer-ack", status: "started" });
    const { client, transcript } = await openTask({ gateway });
    gateway.emit("agent", agentEvent("base", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs[0]?.state === "running");
    client.sendMessage(KEY, "And the documents too.");
    await until(() => transcript().steerAliases["steer-ack"] === "base");
    gateway.emit("chat", { runId: "base", sessionKey: KEY, seq: 2, state: "final" });
    gateway.emit("chat", { runId: "steer-ack", sessionKey: KEY, seq: 1, state: "final" });
    await sleep(50);
    expect(runIds(transcript().runs)).toEqual([["base", "completed"]]);
    client.stop();
  });

  it("a steer admitted as a run of its own whose only frame here is its error is shown as that failed run", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.send"] = () => ({ runId: "steer-own", status: "started" });
    const { client, transcript } = await openTask({ gateway });
    gateway.emit("agent", agentEvent("base", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs[0]?.state === "running");
    client.sendMessage(KEY, "And the documents too.");
    await until(() => transcript().steerAliases["steer-own"] === "base");
    // Its start and text did not reach this client; its end did.
    gateway.emit("chat", {
      runId: "steer-own",
      sessionKey: KEY,
      seq: 1,
      state: "error",
      errorMessage: "The model refused this run",
    });
    await until(() => transcript().runs.some((run) => run.id === "steer-own"));
    expect(transcript().runs.find((run) => run.id === "steer-own")).toMatchObject({
      state: "failed",
      error: { message: "The model refused this run" },
    });
    expect(transcript().steerAliases).toEqual({});
    // The run it was sent into is untouched.
    expect(transcript().runs.find((run) => run.id === "base")?.state).toBe("running");
    client.stop();
  });
});

describe("a recipient's run settled from history while its sender's task is open", () => {
  const PEER = "agent:marlow:main";

  it("F-122: the sender's card follows it in the same step, never left Working", async () => {
    const gateway = grantingGateway();
    let recipientActive = true;
    gateway.handlers["chat.history"] = (params) => {
      if ((params as { sessionKey: string }).sessionKey !== PEER) return { messages: [] };
      return recipientActive
        ? { messages: [], inFlightRun: { runId: "peer-r" } }
        : {
            messages: [
              {
                role: "assistant",
                content: [{ type: "text", text: "Finished." }],
                __openclaw: { id: "a1", runId: "peer-r" },
              },
            ],
          };
    };
    const { client, transcript } = await openTask({ gateway });
    gateway.emit(
      "agent",
      agentEvent("sender-r", 1, "tool", {
        phase: "start",
        name: "sessions_send",
        toolCallId: "send-c",
        args: { sessionKey: PEER, message: "A message" },
      }),
    );
    gateway.emit(
      "agent",
      agentEvent("sender-r", 2, "tool", {
        phase: "result",
        name: "sessions_send",
        toolCallId: "send-c",
        isError: false,
        result: {
          content: [{ type: "text", text: "{}" }],
          details: { status: "accepted", sessionKey: PEER, runId: "peer-r" },
        },
      }),
    );
    gateway.emit("agent", agentEvent("peer-r", 1, "lifecycle", { phase: "start" }, PEER));
    await until(() => transcript().linkedRuns["peer-r"]?.state === "running");
    client.openSession(PEER);
    await until(() => client.state.transcripts[PEER]?.status === "ready");
    // Its own end never reaches this client; the row naming it does, and history settles it.
    recipientActive = false;
    gateway.emit("sessions.changed", { sessionKey: PEER, runId: "peer-r", phase: "end" });
    await until(() => client.state.transcripts[PEER]?.runs[0]?.state === "completed");
    expect(transcript().linkedRuns["peer-r"]?.state).toBe("completed");
    client.stop();
  });
});

describe("a failed turn's request and Raw (F-301)", () => {
  it("F-301: keeps the id of the chat.send frame that started the run; the error event is read only when Raw is opened, as the gateway sent it, and is in no snapshot", async () => {
    const { client, gateway, transcript } = await openTask();
    const frames = () =>
      gateway.requests.filter((each) => each.method === "chat.send").map((each) => each.id);
    const id = client.sendMessage(KEY, "check the disk");
    await until(() => frames().length === 1);
    await until(() => transcript().runs[0]?.bound === true);
    const event = {
      runId: transcript().runs[0]!.id,
      sessionKey: KEY,
      seq: 3,
      state: "error",
      errorMessage: "The model provider is overloaded.",
      errorKind: "provider",
      // Diagnostics the gateway may attach: never part of a snapshot.
      errorDetail: { marker: "diagnostic-7f3a" },
    };
    gateway.emit("chat", event);
    await until(() => transcript().runs[0]?.state === "failed");
    const run = transcript().runs[0]!;
    expect(run.requestId).toBe(frames()[0]);
    expect(run.requestId).not.toBe(id);
    expect(run.error).toEqual({
      message: "The model provider is overloaded.",
      kind: "provider",
      raw: { holds: "chat-event", chars: JSON.stringify(event).length },
    });
    expect(JSON.stringify(client.state)).not.toContain("diagnostic-7f3a");
    expect(client.readRunRaw(KEY, run.id)).toEqual({
      status: "available",
      holds: "chat-event",
      payload: event,
    });
    client.stop();
  });

  it("F-301: a steer names no request of the run it joined; an error event too large to keep says so, and a failure nothing was kept for says only that", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.emit("agent", agentEvent("run-x", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs[0]?.state === "running");
    client.sendMessage(KEY, "and this");
    await until(() => gateway.calls("chat.send").length === 1);
    await sleep(20);
    expect(transcript().runs[0]!.requestId).toBeUndefined();
    const huge = "x".repeat(MAX_RAW_ENTRY_CHARS);
    gateway.emit("chat", {
      runId: "run-x",
      sessionKey: KEY,
      seq: 3,
      state: "error",
      errorMessage: huge,
    });
    await until(() => transcript().runs[0]?.state === "failed");
    const read = client.readRunRaw(KEY, "run-x");
    expect(read).toMatchObject({ status: "too-large", holds: "chat-event" });
    expect(JSON.stringify(client.state)).not.toContain(huge);
    // A run with no failing event kept: nothing is claimed about what the gateway sent.
    expect(client.readRunRaw(KEY, "no-such-run")).toBeNull();
    client.stop();
  });

  it("F-301: a failure read from history takes the gateway's error row as its reason, with no Raw kept", () => {
    const activity = runsFromHistory(
      [
        { role: "user", content: "Fail.", __openclaw: { id: "u", idempotencyKey: "r1" } },
        {
          role: "assistant",
          content: [{ type: "text", text: "LLM request rejected: no." }],
          stopReason: "error",
          __openclaw: { id: "a", runId: "r1" },
        },
      ],
      null,
      { sessionKey: KEY, now: 5_000, raw: new RawTable() },
    );
    const run = activity.find((each) => each.id === "r1")!;
    expect(run.state).toBe("failed");
    expect(run.error).toEqual({ message: "LLM request rejected: no.", kind: null });
  });
});
