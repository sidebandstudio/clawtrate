// A user's words are delivered once, in order, or stay visibly undelivered with
// retry and delete: across held messages, queues, closing a task, failed Stops
// and reconciliation with history.

import { describe, expect, it } from "vitest";
import { createBridgeSession } from "../src/bridge.ts";
import {
  emptyActivity,
  reconcileOutbox,
  startLocalRun,
  type OutgoingMessage,
  type TaskActivity,
} from "../src/runs.ts";
import { agentEvent, KEY, openTask, questionRecord, sentTexts } from "./client-harness.ts";
import { deferred, GatewayError, sleep, until } from "./fake-gateway.ts";

function start(gateway: Parameters<typeof sentTexts>[0], runId = "run-x") {
  gateway.emit("agent", agentEvent(runId, 1, "lifecycle", { phase: "start" }));
}

describe("held messages (F-096, F-106)", () => {
  it("releases several held messages once each, in the order they were sent", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["question.resolve"] = () => ({ status: "cancelled" });
    start(gateway);
    gateway.emit("question.requested", questionRecord("ask_1", "run-x"));
    await until(() => transcript().runs[0]?.state === "waiting");
    for (const text of ["one", "two", "three"]) client.sendMessage(KEY, text);
    expect(transcript().outbox.map((m) => m.status)).toEqual(["held", "held", "held"]);
    await client.dismissQuestion(KEY, "ask_1");
    await until(() => transcript().outbox.every((m) => m.status === "sent"));
    await sleep(30);
    expect(sentTexts(gateway)).toEqual(["one", "two", "three"]);
    const keys = gateway
      .calls("chat.send")
      .map((p) => (p as { idempotencyKey: string }).idempotencyKey);
    expect(new Set(keys).size).toBe(3);
    client.stop();
  });
});

describe("a pending question holds every outgoing message (F-468)", () => {
  it("holds a message queued with the modifier or the menu, and releases it into the queue", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["question.resolve"] = () => ({ status: "cancelled" });
    gateway.handlers["chat.send"] = (params) => ({
      runId: `run-${(params as { message: string }).message}`,
      status: "started",
    });
    start(gateway);
    gateway.emit("question.requested", questionRecord("ask_1", "run-x"));
    await until(() => transcript().runs[0]?.state === "waiting");
    const id = client.sendMessage(KEY, "after this turn", { mode: "queue" });
    expect(transcript().outbox[0]).toMatchObject({ id, status: "held", mode: "queue" });
    expect(transcript().runs.filter((run) => run.state === "queued")).toEqual([]);

    await client.dismissQuestion(KEY, "ask_1");
    // Released as a message queued now: it waits for the run, not steered into it.
    await until(() => transcript().outbox[0]?.status === "queued");
    await sleep(30);
    expect(sentTexts(gateway)).toEqual([]);
    gateway.emit("agent", agentEvent("run-x", 3, "lifecycle", { phase: "end" }));
    await until(() => sentTexts(gateway).length === 1);
    expect(gateway.calls("chat.send")[0]).toMatchObject({
      message: "after this turn",
      queueMode: "followup",
    });
    client.stop();
  });

  it("turns messages still held when the run ends by itself into queued ones, one run each, in order", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["chat.send"] = (params) => ({
      runId: `run-${(params as { message: string }).message}`,
      status: "started",
    });
    start(gateway);
    gateway.emit("question.requested", questionRecord("ask_1", "run-x"));
    await until(() => transcript().runs[0]?.state === "waiting");
    client.sendMessage(KEY, "one");
    client.sendMessage(KEY, "two");
    expect(transcript().outbox.map((m) => m.status)).toEqual(["held", "held"]);
    gateway.emit("agent", agentEvent("run-x", 3, "lifecycle", { phase: "end" }));
    await until(() => sentTexts(gateway).length === 1);
    await sleep(30);
    // The first starts its own run; the second waits for it, queued.
    expect(sentTexts(gateway)).toEqual(["one"]);
    expect(gateway.calls("chat.send")[0]).toMatchObject({ queueMode: "followup" });
    expect(transcript().outbox.find((m) => m.text === "two")?.status).toBe("queued");
    gateway.emit("agent", agentEvent("run-one", 1, "lifecycle", { phase: "start" }));
    gateway.emit("agent", agentEvent("run-one", 2, "lifecycle", { phase: "end" }));
    await until(() => sentTexts(gateway).length === 2);
    expect(sentTexts(gateway)).toEqual(["one", "two"]);
    expect(gateway.calls("chat.send")[1]).toMatchObject({ queueMode: "followup" });
    client.stop();
  });
});

describe("queued messages (F-421, F-420)", () => {
  it("drains several queued messages in order after the run completes or fails", async () => {
    for (const ending of [
      { stream: "lifecycle", data: { phase: "end" } },
      { stream: "lifecycle", data: { phase: "error", error: "boom", executionSettled: true } },
    ]) {
      const { client, gateway, transcript } = await openTask();
      // Each queued message starts its own run; hold the first one open.
      gateway.handlers["chat.send"] = (params) => ({
        runId: `run-${(params as { message: string }).message}`,
        status: "started",
      });
      start(gateway);
      await until(() => transcript().runs.length === 1);
      client.sendMessage(KEY, "a", { mode: "queue" });
      client.sendMessage(KEY, "b", { mode: "queue" });
      gateway.emit("agent", agentEvent("run-x", 2, ending.stream, ending.data));
      await until(() => sentTexts(gateway).length === 1);
      expect(sentTexts(gateway)).toEqual(["a"]);
      gateway.emit("agent", agentEvent("run-a", 1, "lifecycle", { phase: "end" }));
      await until(() => sentTexts(gateway).length === 2);
      expect(sentTexts(gateway)).toEqual(["a", "b"]);
      client.stop();
    }
  });

  it("F-061: starts the next queued message when the oldest one is refused, which keeps its queue origin", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["chat.send"] = (params) => {
      if ((params as { message: string }).message === "a") {
        throw new GatewayError({ code: "INVALID_REQUEST", message: "budget exhausted" });
      }
      return { runId: "run-b", status: "started" };
    };
    start(gateway);
    await until(() => transcript().runs.length === 1);
    client.sendMessage(KEY, "a", { mode: "queue" });
    client.sendMessage(KEY, "b", { mode: "queue" });
    gateway.emit("agent", agentEvent("run-x", 2, "lifecycle", { phase: "end" }));
    await until(() => sentTexts(gateway).length === 2);
    // Refused as it started: still a queued message, so the shelf says "Couldn't start".
    expect(transcript().outbox.find((m) => m.text === "a")).toMatchObject({
      status: "failed",
      mode: "queue",
      error: expect.stringMatching(/budget exhausted/),
    });
    expect(transcript().outbox.find((m) => m.text === "b")).toMatchObject({ status: "sent" });
    client.stop();
  });

  it("cancels and sends-now through the bridge, and refuses send-now while stopping", async () => {
    const { client, gateway, transcript } = await openTask();
    const viewer = createBridgeSession(client);
    await viewer.apply({ type: "openSession", key: KEY });
    start(gateway);
    await until(() => transcript().runs.length === 1);
    const first = await viewer.apply({
      type: "sendMessage",
      key: KEY,
      text: "later",
      mode: "queue",
      attachmentIds: [],
    });
    const second = await viewer.apply({
      type: "sendMessage",
      key: KEY,
      text: "now",
      mode: "queue",
      attachmentIds: [],
    });
    await viewer.apply({ type: "cancelQueued", key: KEY, messageId: first.messageId });
    await viewer.apply({ type: "sendQueuedNow", key: KEY, messageId: second.messageId });
    await until(() => sentTexts(gateway).length === 1);
    expect(gateway.calls("chat.send")[0]).toMatchObject({ message: "now", queueMode: "steer" });
    const third = await viewer.apply({
      type: "sendMessage",
      key: KEY,
      text: "third",
      mode: "queue",
      attachmentIds: [],
    });
    await client.stopRun(KEY, "run-x");
    await expect(
      viewer.apply({ type: "sendQueuedNow", key: KEY, messageId: third.messageId }),
    ).rejects.toThrow(/unavailable while the run stops/);
    gateway.emit("agent", agentEvent("run-x", 3, "lifecycle", { phase: "end", aborted: true }));
    // The stop was confirmed: the queued message stays, not sent (§15–16).
    await until(
      () => transcript().outbox.find((m) => m.id === third.messageId)?.status === "not-sent",
    );
    await sleep(30);
    expect(sentTexts(gateway)).toEqual(["now"]);
    viewer.dispose();
    client.stop();
  });

  it("cancels queued messages when the task is deleted", async () => {
    const { client, gateway, transcript } = await openTask();
    start(gateway);
    await until(() => transcript().runs.length === 1);
    client.sendMessage(KEY, "later", { mode: "queue" });
    gateway.emit("sessions.changed", { sessionKey: KEY, reason: "delete" });
    await until(() => transcript().outbox[0]?.status === "cancelled");
    client.stop();
  });
});

describe("after a confirmed Stop nothing starts by itself (F-468)", () => {
  it("keeps queued and held messages as not sent, and Remove and Send act on each", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["question.resolve"] = () => ({ status: "cancelled" });
    start(gateway);
    gateway.emit("question.requested", questionRecord("ask_1", "run-x"));
    await until(() => transcript().runs[0]?.state === "waiting");
    const held = client.sendMessage(KEY, "held one");
    expect(transcript().outbox[0]!.status).toBe("held");
    await client.stopRun(KEY, "run-x");
    const queued = client.sendMessage(KEY, "queued one");
    expect(transcript().outbox[1]!.status).toBe("queued");
    gateway.emit("chat", { runId: "run-x", sessionKey: KEY, seq: 9, state: "aborted" });
    await until(() => transcript().outbox.every((m) => m.status === "not-sent"));
    await sleep(30);
    expect(sentTexts(gateway)).toEqual([]);
    expect(transcript().runs.filter((run) => run.state === "queued")).toEqual([]);

    client.deleteMessage(KEY, held);
    expect(transcript().outbox.map((m) => m.id)).toEqual([queued]);
    client.retryMessage(KEY, queued);
    await until(() => sentTexts(gateway).length === 1);
    expect(sentTexts(gateway)).toEqual(["queued one"]);
    client.stop();
  });

  it("still starts queued messages when the run finished before the stop took effect", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["chat.abort"] = () => ({ ok: true, aborted: false, runIds: [] });
    start(gateway);
    await until(() => transcript().runs.length === 1);
    client.sendMessage(KEY, "after it", { mode: "queue" });
    await client.stopRun(KEY, "run-x");
    gateway.emit("agent", agentEvent("run-x", 2, "lifecycle", { phase: "end", aborted: false }));
    await until(() => sentTexts(gateway).length === 1);
    expect(sentTexts(gateway)).toEqual(["after it"]);
    client.stop();
  });
});

describe("closing a task keeps the user's unsent words (F-073, F-421)", () => {
  it("keeps a queued message across close and reopen, and sends it when the run ends", async () => {
    const { client, gateway } = await openTask();
    start(gateway);
    await until(() => client.state.transcripts[KEY]!.runs.length === 1);
    client.sendMessage(KEY, "after this", { mode: "queue" });
    client.closeSession(KEY);
    client.openSession(KEY);
    await until(() => client.state.transcripts[KEY]?.status === "ready");
    expect(client.state.transcripts[KEY]!.outbox.map((m) => [m.text, m.status])).toEqual([
      ["after this", "queued"],
    ]);
    gateway.emit("agent", agentEvent("run-x", 2, "lifecycle", { phase: "end" }));
    await until(() => sentTexts(gateway).length === 1);
    expect(sentTexts(gateway)).toEqual(["after this"]);
    client.stop();
  });

  it("still sends a queued message when nobody reopens the task", async () => {
    const { client, gateway } = await openTask();
    start(gateway);
    await until(() => client.state.transcripts[KEY]!.runs.length === 1);
    client.sendMessage(KEY, "after this", { mode: "queue" });
    client.closeSession(KEY);
    gateway.emit("agent", agentEvent("run-x", 2, "lifecycle", { phase: "end" }));
    await until(() => sentTexts(gateway).length === 1);
    client.stop();
  });

  it("keeps a failed message for retry or delete after the task is closed", async () => {
    const { client, gateway } = await openTask();
    gateway.handlers["chat.send"] = () => {
      throw new GatewayError({ code: "INVALID_REQUEST", message: "no" });
    };
    const id = client.sendMessage(KEY, "important");
    await until(() => client.state.transcripts[KEY]!.outbox[0]?.status === "failed");
    client.closeSession(KEY);
    client.openSession(KEY);
    await until(() => client.state.transcripts[KEY]?.status === "ready");
    expect(client.state.transcripts[KEY]!.outbox.map((m) => m.id)).toEqual([id]);
    client.deleteMessage(KEY, id);
    client.closeSession(KEY);
    await sleep(20);
    expect(client.state.transcripts[KEY]).toBeUndefined();
    client.stop();
  });
});

describe("a failed Stop restores what was pending (F-097, F-292)", () => {
  it("returns to waiting with the question still pending, and keeps held messages held", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["chat.abort"] = () => {
      throw new GatewayError({ code: "UNAVAILABLE", message: "try again" });
    };
    start(gateway);
    gateway.emit("question.requested", questionRecord("ask_1", "run-x"));
    await until(() => transcript().runs[0]?.state === "waiting");
    client.sendMessage(KEY, "held one");
    await client.stopRun(KEY, "run-x");
    expect(transcript().runs[0]).toMatchObject({ state: "waiting", stopError: "try again" });
    expect(transcript().runs[0]!.pendingCards.map((card) => card.id)).toEqual(["ask_1"]);
    await sleep(30);
    expect(transcript().outbox[0]!.status).toBe("held");
    expect(gateway.calls("chat.send")).toEqual([]);
    client.stop();
  });

  it("aborts without a run id when Stop comes before the gateway named the run", async () => {
    const { client, gateway, transcript } = await openTask();
    const reply = deferred<unknown>();
    gateway.handlers["chat.send"] = () => reply.promise;
    const id = client.sendMessage(KEY, "go");
    await until(() => gateway.calls("chat.send").length === 1);
    await client.stopRun(KEY, id);
    expect(gateway.calls("chat.abort")).toEqual([{ sessionKey: KEY }]);
    reply.resolve({ runId: "run-1", status: "started" });
    await until(() => transcript().runs[0]?.id === "run-1");
    expect(transcript().runs[0]!.state).toBe("stopping");
    client.stop();
  });
});

describe("questions of an ended run are not actionable", () => {
  it("closes a pending question when its run ends, and ignores one requested after", async () => {
    const { client, gateway, transcript } = await openTask();
    start(gateway);
    gateway.emit("question.requested", questionRecord("ask_1", "run-x"));
    await until(() => transcript().questions.length === 1);
    gateway.emit("agent", agentEvent("run-x", 2, "lifecycle", { phase: "end" }));
    await until(() => transcript().runs[0]?.state === "completed");
    expect(transcript().questions[0]!.status).toBe("closed");
    await expect(client.dismissQuestion(KEY, "ask_1")).rejects.toThrow(/no longer open/);
    gateway.emit("question.requested", questionRecord("ask_1", "run-x"));
    gateway.emit("question.requested", questionRecord("ask_2", "run-x"));
    await sleep(20);
    expect(transcript().questions.map((q) => q.status)).toEqual(["closed"]);
    client.stop();
  });
});

describe("reconciling sent messages with history (F-075, F-107)", () => {
  const message = (id: string, extra: Partial<OutgoingMessage> = {}): OutgoingMessage => ({
    id,
    text: "hi",
    mode: "new",
    status: "sent",
    runId: null,
    messageSeq: null,
    createdAt: 3_000,
    error: null,
    attachments: [],
    ...extra,
  });

  it("never retires a message on a text match alone", () => {
    // Messages from before identifier-only matching carried a history watermark
    // (`afterSeq`) and were retired by text past it; the rows below are past it.
    const legacy = (each: OutgoingMessage) => ({ ...each, ...({ afterSeq: 1 } as object) });
    const activity: TaskActivity = startLocalRun(
      {
        ...emptyActivity,
        outbox: [
          legacy(message("m1", { status: "failed" })),
          legacy(message("m2")),
          legacy(message("m3", { text: "" })),
        ],
      },
      message("m1", { status: "failed" }),
      3_000,
    );
    const rows = [
      {
        role: "user",
        content: "something else hi there",
        timestamp: 2_000,
        __openclaw: { id: "u2", seq: 2, idempotencyKey: "other" },
      },
      { role: "user", content: "hi", timestamp: 3_100, __openclaw: { id: "u3", seq: 3 } },
    ];
    const next = reconcileOutbox(activity, rows);
    expect(next.outbox.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(next.runs[0]!.anchorItemId).toBeNull();
  });

  it("matches by the idempotency key, on the row or under its metadata, and by the returned seq", () => {
    const activity: TaskActivity = {
      ...emptyActivity,
      outbox: [
        message("m1"),
        message("m2"),
        message("m3", { messageSeq: 4 }),
        message("m4", { messageSeq: 5 }),
      ],
    };
    const rows = [
      { role: "user", content: "hi", __openclaw: { id: "u1", seq: 2, idempotencyKey: "m1" } },
      { role: "user", content: "hi", idempotencyKey: "m2", __openclaw: { id: "u2", seq: 3 } },
      { role: "user", content: "hi", __openclaw: { id: "u3", seq: 4 } },
      // A row whose own key contradicts the message never matches it, even at its seq.
      {
        role: "user",
        content: "hi",
        __openclaw: { id: "u4", seq: 5, idempotencyKey: "someone-else" },
      },
    ];
    expect(reconcileOutbox(activity, rows).outbox.map((m) => m.id)).toEqual(["m4"]);
  });

  it("F-075 F-107: matches the user row the gateway keys as the send's key with :user appended", () => {
    const activity: TaskActivity = {
      ...emptyActivity,
      outbox: [message("m1"), message("m2", { messageSeq: 7 })],
    };
    const rows = [
      { role: "user", content: "hi", __openclaw: { id: "u1", seq: 6, idempotencyKey: "m1:user" } },
      { role: "user", content: "hi", idempotencyKey: "m2:user", __openclaw: { id: "u2", seq: 7 } },
      // Any other suffix is another key.
      { role: "user", content: "hi", __openclaw: { id: "u3", seq: 8, idempotencyKey: "m3:other" } },
    ];
    const next = reconcileOutbox(activity, rows);
    expect(next.outbox).toEqual([]);
    const third = reconcileOutbox({ ...emptyActivity, outbox: [message("m3")] }, rows);
    expect(third.outbox.map((m) => m.id)).toEqual(["m3"]);
  });
});
