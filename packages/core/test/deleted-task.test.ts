// A message written in a task that was deleted elsewhere (parity F-278), or archived elsewhere
// (F-277). OpenClaw 2026.10.6 starts a new, empty task under the deleted task's key for a plain
// `chat.send`; a send that names the session it was written for (`sessionId` with
// `expectedLeafEntryId: null`) is refused instead ("active branch changed; review and retry").
// Every send to an archived task is refused with a message and no reason of its own. The refused
// message fails with the reason and keeps its words; nothing is sent again into whatever the key
// holds now, unless the person sends it again to the task once it is live again.
import { describe, expect, it, vi } from "vitest";
import { createBridgeSession, parseBridgeCommand } from "../src/bridge.ts";
import {
  REMOVAL_HOLD_MS,
  TaskArchivedError,
  TaskDeletedError,
  TaskResetError,
} from "../src/client.ts";
import { CLIENT_OWNERS } from "../src/owners.ts";
import { READ_SCOPES } from "../src/scopes.ts";
import {
  TASK_ARCHIVED_ELSEWHERE,
  TASK_DELETED_ELSEWHERE,
  TASK_RESET_ELSEWHERE,
} from "../src/task-actions.ts";
import { agentEvent, grantingGateway, KEY, openTask, asShown } from "./client-harness.ts";
import { deferred, GatewayError, sleep, until } from "./fake-gateway.ts";

const MOVED = {
  code: "INVALID_REQUEST",
  message: "active branch changed; review and retry",
  details: { reason: "active-leaf-changed" },
};

type Send = {
  message: string;
  queueMode: string;
  sessionId?: string;
  expectedLeafEntryId?: string | null;
  idempotencyKey: string;
  attachments?: unknown[];
};

const ARCHIVED = {
  code: "INVALID_REQUEST",
  message: `Session "${KEY}" is archived. Restore it before starting new work.`,
};

/** OpenClaw 2026.10.6's refusal when the task is deleted while it admits the send. */
const DELETED_WHILE_STARTING = {
  code: "INVALID_REQUEST",
  message: `Session "${KEY}" was deleted while starting work. Retry.`,
};

const FILE = { fileName: "notes.txt", mimeType: "text/plain", type: "file", content: "aGk=" };

/** Two rows of history, each with the gateway's own id. */
const ROWS = [
  { role: "user", content: "hello", __openclaw: { id: "row-1", seq: 1 } },
  {
    role: "assistant",
    content: [{ type: "text", text: "Hi." }],
    __openclaw: { id: "row-2", seq: 2, runId: "run-0" },
  },
];

/** A task whose history came from session `s-1`; the gateway's row for it is `now`. */
async function shown(
  now: {
    session: { sessionId: string; archived?: boolean; previousSessionId?: string } | null;
  },
  client?: NonNullable<Parameters<typeof openTask>[0]>["client"],
) {
  const gateway = grantingGateway();
  const history = { sessionId: "s-1" as string | undefined, messages: [] as unknown[] };
  gateway.handlers["chat.history"] = () => ({
    messages: history.messages,
    hasMore: false,
    sessionId: history.sessionId,
  });
  gateway.handlers["sessions.describe"] = () => now;
  const opened = await openTask({ gateway, ...(client ? { client } : {}) });
  return { ...opened, history, sends: () => gateway.calls("chat.send") as Send[] };
}

/**
 * Another task open and read; `KEY` is listed with `row` when one is given, and its history read
 * waits until `release`, then answers `history`.
 */
async function opening(row: Record<string, unknown> | null, history: Record<string, unknown>) {
  const gateway = grantingGateway();
  if (row) {
    gateway.handlers["sessions.subscribe"] = () => ({
      subscribed: true,
      list: { sessions: [{ key: KEY, agentId: "otto", label: "Disk", ...row }], hasMore: false },
    });
  }
  const read = deferred<void>();
  gateway.handlers["chat.history"] = async (params) => {
    if ((params as { sessionKey: string }).sessionKey !== KEY) return { messages: [] };
    await read.promise;
    return { messages: [], hasMore: false, ...history };
  };
  gateway.handlers["sessions.describe"] = () => ({ session: null });
  const { client } = await openTask({ gateway, key: "agent:otto:other" });
  client.openSession(KEY);
  return {
    client,
    gateway,
    release: () => read.resolve(),
    transcript: () => client.state.transcripts[KEY]!,
    sends: () => gateway.calls("chat.send") as Send[],
  };
}

describe("a task deleted elsewhere (F-278)", () => {
  it("names the session its history came from on a send, and not on a steer", async () => {
    const { client, gateway, transcript, sends } = await shown({ session: { sessionId: "s-1" } });
    expect(transcript().sessionId).toBe("s-1");
    client.sendMessage(KEY, "first", asShown(client));
    await until(() => sends().length === 1);
    expect(sends()[0]).toMatchObject({ sessionId: "s-1", expectedLeafEntryId: null });
    // Its run is under way: the next message steers it, which the gateway does not guard.
    await until(() => transcript().runs.some((run) => run.bound && run.state === "running"));
    const started = transcript().runs.find((run) => run.bound)!.id;
    gateway.emit("agent", agentEvent(started, 1, "lifecycle", { phase: "start" }));
    client.sendMessage(KEY, "steer", asShown(client));
    await until(() => sends().length === 2);
    expect(sends()[1]).not.toHaveProperty("sessionId");
    expect(sends()[1]).not.toHaveProperty("expectedLeafEntryId");
    client.stop();
  });

  it("a send refused with no session under the key fails as deleted elsewhere, keeps its words and is not sent again", async () => {
    const { client, gateway, transcript, sends } = await shown({ session: null });
    gateway.handlers["chat.send"] = () => {
      throw new GatewayError(MOVED);
    };
    const id = client.sendMessage(KEY, "Are you still there?", asShown(client));
    await until(() => transcript().outbox[0]?.status === "failed");
    await sleep(50);
    expect(transcript().outbox[0]).toMatchObject({
      id,
      text: "Are you still there?",
      error: TASK_DELETED_ELSEWHERE,
    });
    expect(new TaskDeletedError().message).toBe(TASK_DELETED_ELSEWHERE);
    expect(sends()).toHaveLength(1);
    expect(transcript().runs.find((run) => run.id === id)?.error?.kind).toBe("not-started");
    client.stop();
  });

  it("another session under the key means the task shown was deleted", async () => {
    const { client, gateway, transcript, sends } = await shown({ session: { sessionId: "s-2" } });
    gateway.handlers["chat.send"] = () => {
      throw new GatewayError(MOVED);
    };
    client.sendMessage(KEY, "hello", asShown(client));
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(transcript().outbox[0]?.error).toBe(TASK_DELETED_ELSEWHERE);
    expect(sends()).toHaveLength(1);
    client.stop();
  });

  it("the same session under the key: a stop command goes again once, naming the latest row this client read, under the same key", async () => {
    const { client, gateway, history, transcript, sends } = await shown({
      session: { sessionId: "s-1" },
    });
    history.messages = ROWS;
    client.reloadSession(KEY);
    await until(() => transcript().items.length === 2);
    gateway.handlers["chat.send"] = (params) => {
      // The gateway checks a stop command's guard against the task's latest row.
      if ((params as Send).expectedLeafEntryId === null) throw new GatewayError(MOVED);
      return { ok: true, aborted: false, runIds: [] };
    };
    client.sendMessage(KEY, "/stop", asShown(client));
    await until(() => transcript().outbox[0]?.status === "handled");
    expect(sends()).toHaveLength(2);
    expect(sends()[1]).toMatchObject({ sessionId: "s-1", expectedLeafEntryId: "row-2" });
    expect(sends()[1]!.idempotencyKey).toBe(sends()[0]!.idempotencyKey);
    client.stop();
  });

  it("the same session under the key: any refused message goes again once, still naming its session, with the latest row read from it; refused again, the refusal stands", async () => {
    const { client, gateway, history, transcript, sends } = await shown({
      session: { sessionId: "s-1" },
    });
    history.messages = ROWS;
    client.reloadSession(KEY);
    await until(() => transcript().items.length === 2);
    gateway.handlers["chat.send"] = () => {
      throw new GatewayError(MOVED);
    };
    client.sendMessage(KEY, "stop the photo sync tonight", asShown(client));
    await until(() => transcript().outbox[0]?.status === "failed");
    await sleep(50);
    expect(transcript().outbox[0]?.error).toBe(MOVED.message);
    expect(sends()).toHaveLength(2);
    expect(sends()[1]).toMatchObject({ sessionId: "s-1", expectedLeafEntryId: "row-2" });
    expect(sends()[1]!.idempotencyKey).toBe(sends()[0]!.idempotencyKey);
    client.stop();
  });

  it("/stop with a pasted second line, which the gateway takes for its stop command: goes again once with the latest row, and is handled", async () => {
    const { client, gateway, history, transcript, sends } = await shown({
      session: { sessionId: "s-1" },
    });
    history.messages = ROWS;
    client.reloadSession(KEY);
    await until(() => transcript().items.length === 2);
    gateway.handlers["chat.send"] = (params) => {
      if ((params as Send).expectedLeafEntryId === null) throw new GatewayError(MOVED);
      return { ok: true, aborted: false, runIds: [] };
    };
    client.sendMessage(KEY, "/stop\nthe photo sync can wait", asShown(client));
    await until(() => transcript().outbox[0]?.status === "handled");
    expect(sends()).toHaveLength(2);
    expect(sends()[1]).toMatchObject({ sessionId: "s-1", expectedLeafEntryId: "row-2" });
    client.stop();
  });

  it("a stop refused before this client read any row of the task: the task is read first, and it goes again with the latest row that read gives", async () => {
    const { client, gateway, history, transcript, sends } = await shown({
      session: { sessionId: "s-1" },
    });
    expect(transcript().items).toHaveLength(0);
    // The rows are there on the gateway; this client has not read them.
    history.messages = ROWS;
    const reads = gateway.calls("chat.history").length;
    gateway.handlers["chat.send"] = (params) => {
      if ((params as Send).expectedLeafEntryId === null) throw new GatewayError(MOVED);
      return { ok: true, aborted: false, runIds: [] };
    };
    client.sendMessage(KEY, "/stop", asShown(client));
    await until(() => transcript().outbox[0]?.status === "handled");
    expect(gateway.calls("chat.history").length).toBeGreaterThan(reads);
    expect(sends()).toHaveLength(2);
    expect(sends()[1]).toMatchObject({ sessionId: "s-1", expectedLeafEntryId: "row-2" });
    client.stop();
  });

  it("a stop command's second try refused because the task was replaced meanwhile: deleted elsewhere, and it never reaches the new task", async () => {
    const { client, gateway, history, transcript, sends } = await shown({
      session: { sessionId: "s-1" },
    });
    history.messages = ROWS;
    client.reloadSession(KEY);
    await until(() => transcript().items.length === 2);
    gateway.handlers["chat.send"] = () => {
      throw new GatewayError(MOVED);
    };
    let described = 0;
    gateway.handlers["sessions.describe"] = () => ({
      session: { sessionId: (described += 1) === 1 ? "s-1" : "s-2" },
    });
    client.sendMessage(KEY, "/stop", asShown(client));
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(transcript().outbox[0]?.error).toBe(TASK_DELETED_ELSEWHERE);
    expect(sends()).toHaveLength(2);
    expect(sends().map((send) => send.sessionId)).toEqual(["s-1", "s-1"]);
    client.stop();
  });

  it("when the task's row cannot be read, the gateway's refusal stands", async () => {
    const { client, gateway, transcript } = await shown({ session: null });
    gateway.handlers["chat.send"] = () => {
      throw new GatewayError(MOVED);
    };
    gateway.handlers["sessions.describe"] = () => {
      throw new GatewayError({ code: "UNAVAILABLE", message: "try later" });
    };
    client.sendMessage(KEY, "hello", asShown(client));
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(transcript().outbox[0]?.error).toBe(MOVED.message);
    client.stop();
  });

  it("a later read of the deleted task names no session: the one shown stays the one sent to", async () => {
    const { client, history, transcript, sends } = await shown({ session: null });
    history.sessionId = undefined;
    const before = transcript().loadedAt;
    client.sendMessage(KEY, "hello", asShown(client));
    await until(() => sends().length === 1);
    expect(sends()[0]).toMatchObject({ sessionId: "s-1", expectedLeafEntryId: null });
    // The answer has history read again, and that read names no session.
    await until(() => transcript().loadedAt !== before);
    expect(transcript().sessionId).toBe("s-1");
    client.stop();
  });

  it("a delete while the gateway admits the send is refused in the gateway's own words, which say deleted", async () => {
    const { client, gateway, transcript, sends } = await shown({ session: { sessionId: "s-1" } });
    gateway.handlers["chat.send"] = () => {
      throw new GatewayError(DELETED_WHILE_STARTING);
    };
    const id = client.sendMessage(KEY, "Are you still there?", asShown(client));
    await until(() => transcript().outbox[0]?.status === "failed");
    await sleep(50);
    expect(transcript().outbox[0]).toMatchObject({
      id,
      text: "Are you still there?",
      error: TASK_DELETED_ELSEWHERE,
    });
    expect(sends()).toHaveLength(1);
    client.stop();
  });

  it("any other refusal of a guarded send stands as the gateway gave it", async () => {
    const { client, gateway, transcript, sends } = await shown({ session: { sessionId: "s-1" } });
    gateway.handlers["chat.send"] = () => {
      throw new GatewayError({ code: "INVALID_REQUEST", message: "budget exhausted" });
    };
    client.sendMessage(KEY, "hello", asShown(client));
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(transcript().outbox[0]?.error).toBe("budget exhausted");
    expect(sends()).toHaveLength(1);
    client.stop();
  });

  it("after a reconnect, a message to a run shown active waits for the task's history; the task deleted meanwhile, it is a checked send, refused, and no steer recreates the task", async () => {
    const { client, gateway, history, transcript, sends } = await shown({ session: null });
    gateway.emit("agent", agentEvent("run-away", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.some((run) => run.state === "running"));
    // While the connection is down the task is deleted, and its run ends unseen. A steer to the
    // deleted key would start a new task under it; a send that names the session is refused.
    history.sessionId = undefined;
    gateway.handlers["chat.send"] = (params) => {
      if ((params as Send).sessionId) throw new GatewayError(MOVED);
      return { runId: "run-new", status: "started" };
    };
    await sleep(5);
    gateway.dropAll();
    client.sendMessage(KEY, "Still there?", asShown(client));
    expect(transcript().outbox[0]?.mode).toBe("steer");
    await until(() => sends().length > 0);
    expect(sends()[0]).toMatchObject({
      queueMode: "followup",
      sessionId: "s-1",
      expectedLeafEntryId: null,
    });
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(transcript().outbox[0]?.error).toBe(TASK_DELETED_ELSEWHERE);
    expect(sends()).toHaveLength(1);
    client.stop();
  });

  it("after a reconnect whose read of the task fails, a steer is not sent; sent again once the read works, it is a checked send", async () => {
    const { client, gateway, history, transcript, sends } = await shown({ session: null });
    gateway.emit("agent", agentEvent("run-away", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.some((run) => run.state === "running"));
    // The task is deleted while the connection is down, and the first reads after it fail.
    history.sessionId = undefined;
    let readable = false;
    gateway.handlers["chat.history"] = () => {
      if (!readable) throw new GatewayError({ code: "UNAVAILABLE", message: "try later" });
      return { messages: [], hasMore: false, sessionId: undefined };
    };
    gateway.handlers["chat.send"] = (params) => {
      if ((params as Send).sessionId) throw new GatewayError(MOVED);
      return { runId: "run-new", status: "started" };
    };
    await sleep(5);
    gateway.dropAll();
    const id = client.sendMessage(KEY, "Still there?", asShown(client));
    expect(transcript().outbox[0]?.mode).toBe("steer");
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(transcript().outbox[0]?.error).toMatch(/^This task couldn't be read, so it wasn't sent/);
    expect(sends()).toHaveLength(0);
    // Sent again by the person, after a read that works: a checked send, refused as deleted.
    readable = true;
    client.retryMessage(KEY, id);
    await until(() => sends().length > 0);
    expect(sends()[0]).toMatchObject({ queueMode: "followup", sessionId: "s-1" });
    await until(() => transcript().outbox[0]?.error === TASK_DELETED_ELSEWHERE);
    expect(sends()).toHaveLength(1);
    client.stop();
  });

  it("a message queued behind a run keeps the session it was written for: history then names another, and it is refused, never sent to the new task", async () => {
    const { client, gateway, history, transcript, sends } = await shown({
      session: { sessionId: "s-2" },
    });
    gateway.emit("agent", agentEvent("run-on", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.some((run) => run.state === "running"));
    client.sendMessage(KEY, "Then send me a summary.", { ...asShown(client), mode: "queue" });
    expect(transcript().outbox[0]).toMatchObject({ status: "queued", sessionId: "s-1" });
    // The task is deleted and another made under its key; this read names it, and the run is gone.
    history.sessionId = "s-2";
    gateway.running.clear();
    gateway.handlers["chat.send"] = (params) => {
      if ((params as Send).sessionId !== "s-2") throw new GatewayError(MOVED);
      return { runId: "run-new", status: "started" };
    };
    client.reloadSession(KEY);
    await until(() => sends().length > 0);
    expect(sends()[0]).toMatchObject({ sessionId: "s-1", expectedLeafEntryId: null });
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(transcript().outbox[0]).toMatchObject({ mode: "queue", error: TASK_DELETED_ELSEWHERE });
    expect(sends()).toHaveLength(1);
    client.stop();
  });

  it("a send names the session the screen showed, whatever the task's state names by the time it is sent", async () => {
    const { client, history, transcript, sends } = await shown({ session: { sessionId: "s-2" } });
    // The host learns of another task under the key before the person's send arrives.
    history.sessionId = "s-2";
    client.reloadSession(KEY);
    await until(() => transcript().sessionId === "s-2");
    client.sendMessage(KEY, "hello", { sessionId: "s-1" });
    expect(transcript().outbox[0]).toMatchObject({ sessionId: "s-1" });
    await until(() => sends().length === 1);
    expect(sends()[0]).toMatchObject({ sessionId: "s-1", expectedLeafEntryId: null });
    client.stop();
  });

  it("Try again on a failed turn sends to the session its message was written for, with its file and reply, never to the task that replaced it", async () => {
    const { client, gateway, history, transcript, sends } = await shown({
      session: { sessionId: "s-2" },
    });
    const viewer = createBridgeSession(client);
    await viewer.apply({ type: "openSession", key: KEY });
    client.sendMessage(KEY, "Check the disk.", {
      ...asShown(client),
      attachments: [{ fileName: "df.txt", mimeType: "text/plain", type: "file", content: "aGk=" }],
      replyToId: "row-2",
    });
    await until(() => transcript().outbox[0]?.status === "sent");
    // The turn fails on the gateway.
    const runId = transcript().outbox[0]!.runId!;
    gateway.emit("agent", agentEvent(runId, 1, "lifecycle", { phase: "start" }));
    gateway.emit(
      "agent",
      agentEvent(runId, 2, "lifecycle", {
        phase: "error",
        error: "The model provider is overloaded.",
        executionSettled: true,
      }),
    );
    await until(() => transcript().runs.some((run) => run.id === runId && run.state === "failed"));
    // Then the task is deleted and another made under its key; history now names it.
    history.sessionId = "s-2";
    client.reloadSession(KEY);
    await until(() => transcript().sessionId === "s-2");
    gateway.handlers["chat.send"] = (params) => {
      if ((params as Send).sessionId !== "s-2") throw new GatewayError(MOVED);
      return { runId: "run-new", status: "started" };
    };
    // The failed turn's Try again: the engine still holds its message, so the button asks for it
    // again by the run's message, as the visible button does.
    const failed = transcript().runs.find((run) => run.id === runId)!;
    expect(transcript().outbox.some((message) => message.id === failed.messageId)).toBe(true);
    const again = await viewer.apply({
      type: "sendAgain",
      key: KEY,
      messageId: failed.messageId!,
    });
    const sentAgain = () => transcript().outbox.find((each) => each.id === again.messageId);
    await until(() => sentAgain()?.status === "failed");
    expect(sends()).toHaveLength(2);
    expect(sends()[1]).toMatchObject({ sessionId: "s-1", replyToId: "row-2" });
    expect(sends()[1]!.attachments).toHaveLength(1);
    expect(sentAgain()?.error).toBe(TASK_DELETED_ELSEWHERE);
    viewer.dispose();
    client.stop();
  });

  it("a steer written offline keeps its session: after the reconnect history names another, and it is refused unsent", async () => {
    const { client, gateway, history, transcript, sends } = await shown({
      session: { sessionId: "s-2" },
    });
    gateway.emit("agent", agentEvent("run-on", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.some((run) => run.state === "running"));
    await sleep(5);
    gateway.dropAll();
    client.sendMessage(KEY, "Skip the photos folder.", asShown(client));
    expect(transcript().outbox[0]).toMatchObject({ mode: "steer", sessionId: "s-1" });
    // Meanwhile the task is deleted and another made under its key.
    history.sessionId = "s-2";
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(transcript().outbox[0]?.error).toBe(TASK_DELETED_ELSEWHERE);
    expect(sends()).toHaveLength(0);
    client.stop();
  });

  it.each(["the new task's row", "its run starting", "the removal"])(
    "a steer written after this client hears of another task under the key (%s), before its history is read again, never goes unguarded: refused as deleted",
    async (heard) => {
      const { client, gateway, history, transcript, sends } = await shown({
        session: { sessionId: "s-2" },
      });
      // A run of the task shown is under way, and a read on this connection showed it in flight.
      gateway.emit("agent", agentEvent("run-a", 1, "lifecycle", { phase: "start" }));
      await until(() => transcript().runs.some((run) => run.state === "running"));
      const reads = gateway.calls("chat.history").length;
      client.reloadSession(KEY);
      await until(() => gateway.calls("chat.history").length > reads);
      await sleep(20);
      // The task is deleted elsewhere and another made under its key; the end of its run never
      // reaches this client, but this does.
      history.sessionId = "s-2";
      gateway.running.set(KEY, "run-b");
      if (heard === "the new task's row")
        gateway.emit("sessions.changed", { sessionKey: KEY, sessionId: "s-2", reason: "send" });
      if (heard === "its run starting")
        gateway.emit("agent", agentEvent("run-b", 1, "lifecycle", { phase: "start" }));
      if (heard === "the removal")
        gateway.emit("sessions.changed", { sessionKey: KEY, reason: "delete" });
      await sleep(20);
      client.sendMessage(KEY, "Skip the photos folder.", asShown(client));
      expect(transcript().outbox[0]).toMatchObject({ mode: "steer", sessionId: "s-1" });
      await until(() => transcript().outbox[0]?.status === "failed");
      expect(transcript().outbox[0]?.error).toBe(TASK_DELETED_ELSEWHERE);
      expect(sends()).toHaveLength(0);
      client.stop();
    },
  );

  it("a run the latest read did not show in flight is not steered: the message waits behind it and goes as a checked send once it ends", async () => {
    const { client, gateway, history, transcript, sends } = await shown({
      session: { sessionId: "s-1" },
    });
    gateway.emit("agent", agentEvent("run-x", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.some((run) => run.state === "running"));
    // History has a turn waiting, so the run stays shown active, but nothing in flight.
    gateway.running.clear();
    gateway.handlers["chat.history"] = () => ({
      messages: history.messages,
      hasMore: false,
      sessionId: "s-1",
      pendingInputs: { items: [{ id: "p-1", state: "queued" }], total: 1 },
    });
    client.sendMessage(KEY, "Skip the photos folder.", asShown(client));
    await until(() => transcript().outbox[0]?.status === "queued");
    expect(transcript().outbox[0]?.mode).toBe("queue");
    expect(sends()).toHaveLength(0);
    gateway.emit("agent", agentEvent("run-x", 2, "lifecycle", { phase: "end" }));
    await until(() => sends().length === 1);
    expect(sends()[0]).toMatchObject({
      queueMode: "followup",
      sessionId: "s-1",
      expectedLeafEntryId: null,
    });
    client.stop();
  });
});

describe("a send before the task's session is known (F-278)", () => {
  it("names the session the task list gives, before its history is read", async () => {
    const { client, release, sends } = await opening({ sessionId: "s-1" }, { sessionId: "s-1" });
    client.sendMessage(KEY, "first", asShown(client));
    await until(() => sends().length === 1);
    expect(sends()[0]).toMatchObject({ sessionId: "s-1", expectedLeafEntryId: null });
    release();
    client.stop();
  });

  it("F-278: a send that names no session is refused by the engine and by the bridge, so a read that then names another session never decides where it goes", async () => {
    const { client, release, transcript, sends } = await opening(null, { sessionId: "s-2" });
    expect(() => client.sendMessage(KEY, "first", {} as never)).toThrow(/names no session/);
    expect(() =>
      parseBridgeCommand({ type: "sendMessage", key: KEY, text: "first", mode: "auto" }),
    ).toThrow("invalid session id");
    release();
    await until(() => transcript().sessionId === "s-2");
    await sleep(50);
    expect(transcript().outbox).toEqual([]);
    expect(sends()).toHaveLength(0);
    client.stop();
  });

  it("listed, then deleted before its history is read: the send names the listed session, is refused, and makes nothing", async () => {
    const { client, gateway, release, transcript, sends } = await opening(
      { sessionId: "s-1" },
      { sessionId: undefined },
    );
    gateway.handlers["chat.send"] = (params) => {
      if ((params as Send).sessionId) throw new GatewayError(MOVED);
      return { runId: "run-new", status: "started" };
    };
    client.sendMessage(KEY, "first", asShown(client));
    release();
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(transcript().outbox[0]).toMatchObject({ text: "first", error: TASK_DELETED_ELSEWHERE });
    expect(sends()).toHaveLength(1);
    expect(sends()[0]).toMatchObject({ sessionId: "s-1" });
    client.stop();
  });

  it("F-278: a task opened from a link, never listed, and deleted before this client read it: the view shows no session, so nothing can be sent there", async () => {
    // A routine's shared-conversation link opens a key the task list does not hold.
    const { client, release, transcript, sends } = await opening(null, { sessionId: undefined });
    release();
    await until(() => transcript().status === "ready");
    expect(transcript().sessionId).toBeUndefined();
    expect(() => client.sendMessage(KEY, "Is this still running?", asShown(client))).toThrow(
      /shows no session/,
    );
    expect(sends()).toHaveLength(0);
    client.stop();
  });

  it("a task whose read named no session, then listed with one: its history is read again, and the view shows that session before anything is sent there", async () => {
    const history: { sessionId: string | undefined } = { sessionId: undefined };
    const { client, gateway, release, transcript, sends } = await opening(null, history);
    release();
    await until(() => transcript().status === "ready");
    expect(transcript().sessionId).toBeUndefined();
    // A task is made under the key elsewhere, and the list shows it with its session.
    history.sessionId = "s-5";
    gateway.handlers["sessions.list"] = () => ({
      sessions: [{ key: KEY, agentId: "otto", label: "Disk", sessionId: "s-5" }],
      hasMore: false,
    });
    gateway.emit("sessions.changed", { sessionKey: KEY, sessionId: "s-5", reason: "create" });
    await until(() => transcript().sessionId === "s-5");
    client.sendMessage(KEY, "Is this still running?", { sessionId: "s-5" });
    await until(() => sends().length === 1);
    expect(sends()[0]).toMatchObject({ sessionId: "s-5", expectedLeafEntryId: null });
    client.stop();
  });

  it("a caller that means to make the task (`newTask`): its first message to a key that holds none goes as any first message does", async () => {
    const { client, release, transcript, sends } = await opening(null, { sessionId: undefined });
    client.sendMessage(KEY, "first", { newTask: true });
    release();
    await until(() => sends().length === 1);
    expect(sends()[0]).not.toHaveProperty("sessionId");
    await until(() => transcript().outbox[0]?.status === "sent");
    client.stop();
  });

  it("a task this client just created: the next message names the session the creation answered with, before its history is read", async () => {
    const { client, gateway, sends } = await opening(null, { sessionId: "s-9" });
    // No history read answers from here.
    gateway.handlers["chat.history"] = () => new Promise(() => undefined);
    gateway.handlers["sessions.create"] = () => ({
      ok: true,
      key: "agent:otto:fresh",
      sessionId: "s-9",
    });
    const key = await client.createTask("otto", "first");
    client.sendMessage(key, "second", asShown(client, key));
    await until(() => sends().length === 1);
    expect(sends()[0]).toMatchObject({ sessionKey: key, sessionId: "s-9" });
    client.stop();
  });

  it("a first message whose run failed to start keeps the session its creation answered: Resend after the task was replaced is refused as deleted", async () => {
    const { client, gateway, sends } = await opening(null, { sessionId: "s-9" });
    const key = "agent:otto:fresh";
    // The creation names its session and a run that did not start (OpenClaw's `runError`).
    gateway.handlers["sessions.create"] = () => ({
      ok: true,
      key,
      sessionId: "s-9",
      runError: { code: "UNAVAILABLE", message: "The model provider is down." },
    });
    // Then the task is deleted elsewhere and another made under its key, which history names.
    gateway.handlers["chat.history"] = () => ({ messages: [], hasMore: false, sessionId: "s-10" });
    gateway.handlers["sessions.describe"] = () => ({ session: { sessionId: "s-10" } });
    gateway.handlers["chat.send"] = (params) => {
      if ((params as Send).sessionId !== "s-10") throw new GatewayError(MOVED);
      return { runId: "run-new", status: "started" };
    };
    await client.createTask("otto", "Back up the photos.");
    const transcript = () => client.state.transcripts[key]!;
    expect(transcript().outbox[0]?.status).toBe("failed");
    await until(() => transcript().sessionId === "s-10");
    client.retryMessage(key, transcript().outbox[0]!.id);
    await until(() => sends().length === 1);
    expect(sends()[0]).toMatchObject({ sessionId: "s-9", expectedLeafEntryId: null });
    await until(() => transcript().outbox[0]?.error === TASK_DELETED_ELSEWHERE);
    expect(sends()).toHaveLength(1);
    client.stop();
  });
});

describe("a task archived elsewhere (F-277)", () => {
  it("a send refused as archived fails as archived elsewhere, keeps its words and is not sent again", async () => {
    const { client, gateway, transcript, sends } = await shown({
      session: { sessionId: "s-1", archived: true },
    });
    gateway.handlers["chat.send"] = () => {
      throw new GatewayError(ARCHIVED);
    };
    const id = client.sendMessage(KEY, "One more thing", asShown(client));
    await until(() => transcript().outbox[0]?.status === "failed");
    await sleep(50);
    expect(transcript().outbox[0]).toMatchObject({
      id,
      text: "One more thing",
      error: TASK_ARCHIVED_ELSEWHERE,
    });
    expect(new TaskArchivedError().message).toBe(TASK_ARCHIVED_ELSEWHERE);
    expect(sends()).toHaveLength(1);
    expect(transcript().runs.find((run) => run.id === id)?.error?.kind).toBe("not-started");
    client.stop();
  });

  it("a steer refused the same way says so too", async () => {
    const { client, gateway, transcript, sends } = await shown({
      session: { sessionId: "s-1", archived: true },
    });
    gateway.emit("agent", agentEvent("run-on", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.some((run) => run.state === "running"));
    gateway.handlers["chat.send"] = () => {
      throw new GatewayError(ARCHIVED);
    };
    client.sendMessage(KEY, "And this", asShown(client));
    expect(transcript().outbox[0]?.mode).toBe("steer");
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(transcript().outbox[0]?.error).toBe(TASK_ARCHIVED_ELSEWHERE);
    expect(sends()).toHaveLength(1);
    expect(sends()[0]).toMatchObject({ queueMode: "steer" });
    client.stop();
  });

  it("the refusal's own words say archived, whatever the task's row says after it: restored meanwhile, or not readable", async () => {
    for (const row of [
      () => ({ session: { sessionId: "s-1" } }),
      () => {
        throw new GatewayError({ code: "UNAVAILABLE", message: "try later" });
      },
    ]) {
      const { client, gateway, transcript } = await shown({ session: { sessionId: "s-1" } });
      gateway.handlers["sessions.describe"] = row;
      gateway.handlers["chat.send"] = () => {
        throw new GatewayError(ARCHIVED);
      };
      client.sendMessage(KEY, "hello", asShown(client));
      await until(() => transcript().outbox[0]?.status === "failed");
      expect(transcript().outbox[0]?.error).toBe(TASK_ARCHIVED_ELSEWHERE);
      client.stop();
    }
  });

  it("another refusal is not taken for an archive, though the task was archived after it", async () => {
    const { client, gateway, transcript } = await shown({
      session: { sessionId: "s-1", archived: true },
    });
    gateway.handlers["chat.send"] = () => {
      throw new GatewayError({ code: "INVALID_REQUEST", message: "budget exhausted" });
    };
    client.sendMessage(KEY, "hello", asShown(client));
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(transcript().outbox[0]?.error).toBe("budget exhausted");
    client.stop();
  });
});

describe("a task reset or restored elsewhere (F-278, F-277)", () => {
  it("another session under the key that names the one sent to as its previous one: the task was reset, not deleted; history is read again, and Resend goes to the session it shows", async () => {
    const { client, gateway, history, transcript, sends } = await shown({
      session: { sessionId: "s-2", previousSessionId: "s-1" },
    });
    // Reset elsewhere, its session rotated (OpenClaw rotates it for an ACP task's reset).
    history.sessionId = "s-2";
    gateway.handlers["chat.send"] = (params) => {
      if ((params as Send).sessionId !== "s-2") throw new GatewayError(MOVED);
      return { runId: "run-new", status: "started" };
    };
    const id = client.sendMessage(KEY, "Where were we?", asShown(client));
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(transcript().outbox[0]).toMatchObject({ error: TASK_RESET_ELSEWHERE, resetTo: "s-2" });
    expect(new TaskResetError("s-2").message).toBe(TASK_RESET_ELSEWHERE);
    // The task is live: the screen moves to the session it holds now.
    await until(() => transcript().sessionId === "s-2");
    expect(sends()).toHaveLength(1);
    // Resend, by the person's choice, to the session the screen shows: still checked there.
    client.retryMessage(KEY, id, { sessionId: "s-2" });
    await until(() => transcript().outbox[0]?.status === "sent");
    expect(sends()).toHaveLength(2);
    expect(sends()[1]).toMatchObject({ sessionId: "s-2", expectedLeafEntryId: null });
    expect(sends()[1]!.idempotencyKey).toBe(sends()[0]!.idempotencyKey);
    client.stop();
  });

  it("reset, then the session that followed deleted and another made under the key: Resend goes to the session the refusal named, and to no other", async () => {
    const { client, gateway, history, transcript, sends } = await shown({
      session: { sessionId: "s-2", previousSessionId: "s-1" },
    });
    history.sessionId = "s-2";
    gateway.handlers["chat.send"] = () => {
      throw new GatewayError(MOVED);
    };
    const id = client.sendMessage(KEY, "Where were we?", asShown(client));
    await until(() => transcript().outbox[0]?.error === TASK_RESET_ELSEWHERE);
    // The session that followed is deleted too, and an unrelated task takes the key.
    history.sessionId = "s-3";
    client.reloadSession(KEY);
    await until(() => transcript().sessionId === "s-3");
    expect(() => client.retryMessage(KEY, id, { sessionId: "s-3" })).toThrow(
      "That message goes only to the task it was written in.",
    );
    expect(transcript().outbox[0]).toMatchObject({ sessionId: "s-1", status: "failed" });
    // To the session the refusal named, by the person's choice: still checked there.
    client.retryMessage(KEY, id, { sessionId: "s-2" });
    await until(() => sends().length === 2);
    expect(sends()[1]).toMatchObject({ sessionId: "s-2", expectedLeafEntryId: null });
    expect(sends().map((send) => send.sessionId)).not.toContain("s-3");
    client.stop();
  });

  it("archived, then another session under the key: Resend goes only to the session it was written for", async () => {
    const { client, gateway, transcript, sends } = await shown({ session: { sessionId: "s-1" } });
    gateway.handlers["chat.send"] = () => {
      throw new GatewayError(ARCHIVED);
    };
    const id = client.sendMessage(KEY, "One more thing", asShown(client));
    await until(() => transcript().outbox[0]?.error === TASK_ARCHIVED_ELSEWHERE);
    expect(() => client.retryMessage(KEY, id, { sessionId: "s-2" })).toThrow(
      "That message goes only to the task it was written in.",
    );
    expect(transcript().outbox[0]).toMatchObject({ sessionId: "s-1", status: "failed" });
    expect(sends()).toHaveLength(1);
    client.stop();
  });

  it("restored after its archive refused a message: Resend goes to the same session, still checked", async () => {
    const { client, gateway, transcript, sends } = await shown({ session: { sessionId: "s-1" } });
    let archived = true;
    gateway.handlers["chat.send"] = () => {
      if (archived) throw new GatewayError(ARCHIVED);
      return { runId: "run-new", status: "started" };
    };
    const id = client.sendMessage(KEY, "One more thing", asShown(client));
    await until(() => transcript().outbox[0]?.error === TASK_ARCHIVED_ELSEWHERE);
    archived = false;
    client.retryMessage(KEY, id, { sessionId: "s-1" });
    await until(() => transcript().outbox[0]?.status === "sent");
    expect(sends()[1]).toMatchObject({ sessionId: "s-1", expectedLeafEntryId: null });
    client.stop();
  });

  it("a message refused as deleted, or for any other reason, is never sent to another session", async () => {
    const { client, gateway, transcript, sends } = await shown({ session: null });
    gateway.handlers["chat.send"] = () => {
      throw new GatewayError(MOVED);
    };
    const id = client.sendMessage(KEY, "hello", asShown(client));
    await until(() => transcript().outbox[0]?.error === TASK_DELETED_ELSEWHERE);
    expect(() => client.retryMessage(KEY, id, { sessionId: "s-2" })).toThrow(
      "That message goes only to the task it was written in.",
    );
    expect(transcript().outbox[0]).toMatchObject({ sessionId: "s-1", status: "failed" });
    expect(sends()).toHaveLength(1);
    client.stop();
  });
});

describe('"Start a new task with this message" (F-278, F-277)', () => {
  const FILE = {
    fileName: "notes.txt",
    mimeType: "text/plain",
    type: "file",
    content: "aGk=",
  };

  /** A message with a file and a reply, refused because its task was deleted elsewhere. */
  async function refused(options: { files: boolean }) {
    const opened = await shown({ session: null });
    const { client, gateway, transcript } = opened;
    gateway.handlers["chat.send"] = () => {
      throw new GatewayError(MOVED);
    };
    let made = 0;
    gateway.handlers["sessions.create"] = () => ({
      ok: true,
      key: `agent:otto:fresh-${(made += 1)}`,
      sessionId: `s-new-${made}`,
    });
    const id = client.sendMessage(KEY, "Are you still there?", {
      ...asShown(client),
      ...(options.files ? { attachments: [FILE] } : {}),
      replyToId: "row-2",
    });
    await until(() => transcript().outbox[0]?.error === TASK_DELETED_ELSEWHERE);
    const creations = () =>
      gateway.calls("sessions.create") as Array<{ message: string; attachments?: unknown }>;
    return { ...opened, id, creations };
  }

  it("starts one task with its words; with files, the message stays with them and its reply, records where its words went, and is not started again, the task opened again too", async () => {
    const { client, transcript, id, creations } = await refused({ files: true });
    const bytes = client.retainedAttachmentBytes;
    expect(bytes).toBeGreaterThan(0);
    // Asked twice at once: one task.
    const [first, second] = await Promise.all([
      client.startTaskFromMessage(KEY, id),
      client.startTaskFromMessage(KEY, id),
    ]);
    expect(second).toBe(first);
    expect(creations()).toHaveLength(1);
    expect(creations()[0]).toMatchObject({ message: "Are you still there?" });
    expect(creations()[0]).not.toHaveProperty("attachments");
    expect(transcript().outbox[0]).toMatchObject({
      id,
      startedTask: first,
      replyToId: "row-2",
      attachments: [{ fileName: "notes.txt" }],
    });
    expect(client.retainedAttachmentBytes).toBe(bytes);
    await expect(client.startTaskFromMessage(KEY, id)).rejects.toThrow(
      "Its words already went to a new task.",
    );
    // The task is left and opened again: the record is the engine's, not a view's.
    client.closeSession(KEY);
    client.openSession(KEY);
    expect(transcript().outbox[0]?.startedTask).toBe(first);
    await expect(client.startTaskFromMessage(KEY, id)).rejects.toThrow();
    expect(creations()).toHaveLength(1);
    client.stop();
  });

  it("without files, the message leaves its task for the new one", async () => {
    const { client, transcript, id, creations } = await refused({ files: false });
    const key = await client.startTaskFromMessage(KEY, id);
    expect(key).toBe("agent:otto:fresh-1");
    expect(transcript().outbox).toHaveLength(0);
    await expect(client.startTaskFromMessage(KEY, id)).rejects.toThrow();
    expect(creations()).toHaveLength(1);
    client.stop();
  });

  it("two refused messages with the same words each start their own task", async () => {
    const opened = await shown({ session: null });
    const { client, gateway, transcript } = opened;
    gateway.handlers["chat.send"] = () => {
      throw new GatewayError(MOVED);
    };
    let made = 0;
    gateway.handlers["sessions.create"] = () => ({
      ok: true,
      key: `agent:otto:fresh-${(made += 1)}`,
    });
    const first = client.sendMessage(KEY, "Same words", asShown(client));
    const second = client.sendMessage(KEY, "Same words", asShown(client));
    await until(() => transcript().outbox.every((each) => each.error === TASK_DELETED_ELSEWHERE));
    const keys = await Promise.all([
      client.startTaskFromMessage(KEY, first),
      client.startTaskFromMessage(KEY, second),
    ]);
    expect(new Set(keys).size).toBe(2);
    expect(gateway.calls("sessions.create")).toHaveLength(2);
    expect(transcript().outbox).toHaveLength(0);
    client.stop();
  });

  it("its answer lost, the creation found by the check after it: the message follows, leaving its task, and is not offered again", async () => {
    const { client, gateway, transcript } = await shown(
      { session: null },
      { requestTimeoutMs: 120, creationCheckMs: 40 },
    );
    gateway.handlers["chat.send"] = () => {
      throw new GatewayError(MOVED);
    };
    const created = deferred<unknown>();
    gateway.handlers["sessions.create"] = () => created.promise;
    const id = client.sendMessage(KEY, "Are you still there?", asShown(client));
    await until(() => transcript().outbox[0]?.error === TASK_DELETED_ELSEWHERE);
    await expect(client.startTaskFromMessage(KEY, id)).rejects.toThrow();
    expect(client.state.creations[0]).toMatchObject({ status: "checking" });
    // The message still offers it meanwhile; asked again, it joins the same creation.
    expect(transcript().outbox[0]?.id).toBe(id);
    created.resolve({ ok: true, key: "agent:otto:fresh" });
    await until(() => client.state.creations[0]?.status === "created");
    expect(transcript().outbox).toHaveLength(0);
    await expect(client.startTaskFromMessage(KEY, id)).rejects.toThrow();
    expect(new Set(gateway.calls("sessions.create").map((each) => JSON.stringify(each))).size).toBe(
      1,
    );
    client.stop();
  });

  it("is refused for a message that failed for another reason", async () => {
    const { client, gateway, transcript } = await shown({ session: { sessionId: "s-1" } });
    gateway.handlers["chat.send"] = () => {
      throw new GatewayError({ code: "INVALID_REQUEST", message: "budget exhausted" });
    };
    const id = client.sendMessage(KEY, "hello", asShown(client));
    await until(() => transcript().outbox[0]?.status === "failed");
    await expect(client.startTaskFromMessage(KEY, id)).rejects.toThrow(
      "That message can't start a new task.",
    );
    expect(gateway.calls("sessions.create")).toHaveLength(0);
    client.stop();
  });
});

describe("a task archived or deleted elsewhere while a message waits in its queue (F-277, F-278)", () => {
  it.each([
    [
      "archived",
      { session: { archived: true } },
      { sessionId: "s-1", archived: true },
      TASK_ARCHIVED_ELSEWHERE,
    ],
    // OpenClaw 2026.10.6's delete names only the key; the gateway then has no row for it.
    ["deleted", { reason: "delete" }, null, TASK_DELETED_ELSEWHERE],
  ] as const)(
    "%s elsewhere, its event first: the message stays with its words and files, refused as such, and can start a new task",
    async (_, event, row, error) => {
      const { client, gateway, transcript, sends } = await shown({ session: row });
      gateway.emit("agent", agentEvent("run-on", 1, "lifecycle", { phase: "start" }));
      await until(() => transcript().runs.some((run) => run.state === "running"));
      const id = client.sendMessage(KEY, "Then send me a summary.", {
        ...asShown(client),
        mode: "queue",
        attachments: [FILE],
      });
      const bytes = client.retainedAttachmentBytes;
      gateway.emit("sessions.changed", { sessionKey: KEY, ...event });
      await until(() => transcript().outbox[0]?.status === "failed");
      expect(transcript().outbox[0]).toMatchObject({
        id,
        mode: "queue",
        error,
        sessionId: "s-1",
        attachments: [{ fileName: "notes.txt" }],
      });
      expect(client.retainedAttachmentBytes).toBe(bytes);
      // The run ends with the task: nothing is sent.
      gateway.emit("agent", agentEvent("run-on", 2, "lifecycle", { phase: "end" }));
      await sleep(50);
      expect(sends()).toHaveLength(0);
      gateway.handlers["sessions.create"] = () => ({ ok: true, key: "agent:otto:fresh" });
      await expect(client.startTaskFromMessage(KEY, id)).resolves.toBe("agent:otto:fresh");
      client.stop();
    },
  );
});

/**
 * A task whose history came from `s-1` and a run, `run-a`, in flight there, read on this
 * connection: what a steer may rely on. The gateway's row for the key is `now`.
 */
async function steering(
  now: { session: { sessionId: string; previousSessionId?: string } | null },
  options: { now?: () => number } = {},
) {
  const gateway = grantingGateway();
  gateway.handlers["chat.history"] = () => ({ messages: [], hasMore: false, sessionId: "s-1" });
  gateway.handlers["sessions.describe"] = () => now;
  const opened = await openTask({ gateway, ...options });
  const reads = () => gateway.calls("chat.history").length;
  gateway.emit("agent", agentEvent("run-a", 1, "lifecycle", { phase: "start" }));
  await until(() => opened.transcript().runs.some((run) => run.state === "running"));
  const before = reads();
  gateway.emit("session.message", { sessionKey: KEY });
  await until(() => reads() > before);
  await sleep(20);
  /** From now on history answers only once released, with `answer`. */
  const hold = (answer: Record<string, unknown>) => {
    const read = deferred<void>();
    gateway.handlers["chat.history"] = async () => {
      await read.promise;
      return { messages: [], hasMore: false, ...answer };
    };
    return () => read.resolve();
  };
  return { ...opened, reads, hold, sends: () => gateway.calls("chat.send") as Send[] };
}

describe("a steer relies only on what this connection's latest read established, in its own session (F-278)", () => {
  it("the list names another session while history still shows the first: no steer is sent, the task is read again, and the message is refused", async () => {
    const { client, gateway, transcript, hold, sends } = await steering({
      session: { sessionId: "s-2" },
    });
    const release = hold({ sessionId: "s-2" });
    gateway.handlers["sessions.list"] = () => ({
      sessions: [{ key: KEY, agentId: "otto", label: "Disk", sessionId: "s-2" }],
      hasMore: false,
    });
    const lists = gateway.calls("sessions.list").length;
    // A change with no row of its own: the list is read again, and names the task's new session.
    gateway.emit("sessions.changed", {});
    await until(() => gateway.calls("sessions.list").length > lists);
    await sleep(20);
    client.sendMessage(KEY, "Also check the logs.", { sessionId: "s-1" });
    await sleep(50);
    expect(sends()).toHaveLength(0);
    release();
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(transcript().outbox[0]?.error).toBe(TASK_DELETED_ELSEWHERE);
    expect(sends()).toHaveLength(0);
    client.stop();
  });

  it("a `chat` event of another run in the task after its read: that read no longer confirms a steer, and the task is read again first", async () => {
    const { client, gateway, transcript, hold, sends } = await steering({
      session: { sessionId: "s-2" },
    });
    const release = hold({ sessionId: "s-2" });
    gateway.emit("chat", {
      runId: "run-b",
      sessionKey: KEY,
      seq: 1,
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: "Starting over." }] },
    });
    await sleep(20);
    client.sendMessage(KEY, "Also check the logs.", { sessionId: "s-1" });
    await sleep(50);
    expect(sends()).toHaveLength(0);
    release();
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(transcript().outbox[0]?.error).toBe(TASK_DELETED_ELSEWHERE);
    expect(sends()).toHaveLength(0);
    client.stop();
  });

  it("after a reconnect that reads the same clock as the last read, a steer waits for the new connection's read", async () => {
    const { client, gateway, transcript, reads, hold, sends } = await steering(
      { session: { sessionId: "s-2" } },
      { now: () => 1_000 },
    );
    // The connection drops, and the task is replaced meanwhile. Its run's end was missed.
    const release = hold({ sessionId: "s-2" });
    const before = reads();
    gateway.dropAll();
    await until(() => reads() > before);
    expect(transcript().runs.some((run) => run.state === "running")).toBe(true);
    client.sendMessage(KEY, "Still there?", { sessionId: "s-1" });
    await sleep(50);
    expect(sends()).toHaveLength(0);
    release();
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(transcript().outbox[0]?.error).toBe(TASK_DELETED_ELSEWHERE);
    expect(sends()).toHaveLength(0);
    client.stop();
  });

  it("a run starting in another task while this task's read is out leaves that read able to confirm this task's steer", async () => {
    const { client, gateway, reads, sends } = await steering({ session: { sessionId: "s-1" } });
    const other = "agent:otto:other";
    client.openSession(other);
    await until(() => client.state.transcripts[other]?.status === "ready");
    // The other task has a run in flight too, as its read shows.
    gateway.emit("agent", agentEvent("run-o", 1, "lifecycle", { phase: "start" }, other));
    let before = reads();
    gateway.emit("session.message", { sessionKey: other });
    await until(() => reads() > before);
    await sleep(20);
    const read = deferred<void>();
    gateway.handlers["chat.history"] = async (params) => {
      if ((params as { sessionKey: string }).sessionKey !== KEY) return { messages: [] };
      await read.promise;
      return { messages: [], hasMore: false, sessionId: "s-1", inFlightRun: { runId: "run-a" } };
    };
    // News of this task drops what its read established: the steer reads it again first.
    gateway.emit("agent", agentEvent("run-c", 1, "lifecycle", { phase: "start" }));
    await sleep(20);
    before = reads();
    client.sendMessage(KEY, "Skip the photos folder.", { sessionId: "s-1" });
    await until(() => reads() > before);
    // Another run starts in the other task while this task's read is out.
    gateway.emit("agent", agentEvent("run-o2", 1, "lifecycle", { phase: "start" }, other));
    await sleep(20);
    read.resolve();
    await until(() => sends().length === 1);
    expect(sends()[0]).toMatchObject({ queueMode: "steer" });
    client.stop();
  });

  it("deleted while a steer waits for the task's read, and its run's end never comes: the task is read again, and the message is refused, not left waiting", async () => {
    const { client, gateway, transcript, reads, sends } = await steering({ session: null });
    const read = deferred<void>();
    let deleted = false;
    gateway.handlers["chat.history"] = async () => {
      if (deleted) return { messages: [], hasMore: false, sessionId: undefined };
      await read.promise;
      return { messages: [], hasMore: false, sessionId: "s-1", inFlightRun: { runId: "run-a" } };
    };
    gateway.handlers["chat.send"] = (params) => {
      if ((params as Send).sessionId) throw new GatewayError(MOVED);
      return { runId: "run-new", status: "started" };
    };
    // News of the task first, so the steer reads it before it goes.
    gateway.emit("agent", agentEvent("run-c", 1, "lifecycle", { phase: "start" }));
    await sleep(20);
    const before = reads();
    client.sendMessage(KEY, "Still there?", { sessionId: "s-1" });
    await until(() => reads() > before);
    deleted = true;
    gateway.emit("sessions.changed", { sessionKey: KEY, reason: "delete" });
    await sleep(20);
    read.resolve();
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(transcript().outbox[0]?.error).toBe(TASK_DELETED_ELSEWHERE);
    expect(sends().every((send) => send.sessionId === "s-1")).toBe(true);
    client.stop();
  });
});

describe("history of another session settles nothing of a message bound to the first (F-278)", () => {
  it("a row of the session that replaced the task, with the sequence number an accepted message had and no key of its own: the message and its file stay", async () => {
    const { client, gateway, history, transcript } = await shown({
      session: { sessionId: "s-2" },
    });
    gateway.handlers["chat.send"] = () => ({ runId: "run-a", status: "started", messageSeq: 7 });
    const id = client.sendMessage(KEY, "Archive the logs.", {
      sessionId: "s-1",
      attachments: [FILE],
    });
    await until(() => transcript().outbox[0]?.status === "sent");
    const bytes = client.retainedAttachmentBytes;
    expect(bytes).toBeGreaterThan(0);
    // The task is replaced elsewhere, and the new session's history has a row with that number.
    history.sessionId = "s-2";
    history.messages = [
      { role: "user", content: "Something else.", __openclaw: { id: "row-b", seq: 7 } },
    ];
    gateway.emit("chat", { runId: "run-a", sessionKey: KEY, seq: 2, state: "final" });
    await until(() => transcript().sessionId === "s-2");
    expect(transcript().outbox[0]).toMatchObject({
      id,
      text: "Archive the logs.",
      attachments: [{ fileName: "notes.txt" }],
    });
    expect(client.retainedAttachmentBytes).toBe(bytes);
    client.stop();
  });
});

describe("a task's run ended by its removal before the removal is heard (F-277, F-278, F-420)", () => {
  it("deleted elsewhere: the message its run's end parked Not sent is refused as deleted, keeps its words and files, and can start a new task", async () => {
    const { client, gateway, transcript, sends } = await shown({ session: null });
    gateway.emit("agent", agentEvent("run-on", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.some((run) => run.state === "running"));
    const id = client.sendMessage(KEY, "Then send me a summary.", {
      sessionId: "s-1",
      mode: "queue",
      attachments: [FILE],
    });
    const bytes = client.retainedAttachmentBytes;
    // The gateway ends the run as it deletes the task, and that end arrives first.
    gateway.emit("chat", {
      runId: "run-on",
      sessionKey: KEY,
      seq: 2,
      state: "aborted",
      stopReason: "delete",
    });
    await until(() => transcript().outbox[0]?.status === "not-sent");
    gateway.emit("sessions.changed", { sessionKey: KEY, reason: "delete" });
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(transcript().outbox[0]).toMatchObject({
      id,
      error: TASK_DELETED_ELSEWHERE,
      attachments: [{ fileName: "notes.txt" }],
    });
    expect(client.retainedAttachmentBytes).toBe(bytes);
    expect(sends()).toHaveLength(0);
    gateway.handlers["sessions.create"] = () => ({ ok: true, key: "agent:otto:fresh" });
    await expect(client.startTaskFromMessage(KEY, id)).resolves.toBe("agent:otto:fresh");
    client.stop();
  });

  it("archived elsewhere while this client's own archive checks the task, before it sends anything: the queued message keeps its words and files, refused as archived elsewhere", async () => {
    const { client, gateway, transcript, sends } = await shown({ session: null });
    gateway.emit("agent", agentEvent("run-on", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.some((run) => run.state === "running"));
    const id = client.sendMessage(KEY, "Then send me a summary.", {
      sessionId: "s-1",
      mode: "queue",
      attachments: [FILE],
    });
    const bytes = client.retainedAttachmentBytes;
    gateway.handlers["sessions.describe"] = () => {
      gateway.emit("sessions.changed", {
        sessionKey: KEY,
        session: { sessionId: "s-1", archived: true },
      });
      return { session: { key: KEY, sessionId: "s-1", archived: true } };
    };
    await client.archiveTask(KEY);
    expect(gateway.calls("sessions.patch")).toEqual([]);
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(transcript().outbox[0]).toMatchObject({
      id,
      error: TASK_ARCHIVED_ELSEWHERE,
      attachments: [{ fileName: "notes.txt" }],
    });
    expect(client.retainedAttachmentBytes).toBe(bytes);
    expect(sends()).toHaveLength(0);
    client.stop();
  });
});

describe("news of the task reaches the steer check before anything uses it (F-278)", () => {
  it("a `session.message` that names another session: the read no longer confirms a steer, the task is read again first, and the message is refused", async () => {
    const { client, gateway, transcript, hold, sends } = await steering({
      session: { sessionId: "s-2" },
    });
    const release = hold({ sessionId: "s-2" });
    // OpenClaw 2026.10.6 sends the task's row with each transcript row.
    gateway.emit("session.message", {
      sessionKey: KEY,
      message: { role: "user", content: "hello" },
      sessionId: "s-2",
      session: { key: KEY, sessionId: "s-2" },
    });
    await sleep(20);
    client.sendMessage(KEY, "Also check the logs.", { sessionId: "s-1" });
    await sleep(50);
    expect(sends()).toHaveLength(0);
    release();
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(transcript().outbox[0]?.error).toBe(TASK_DELETED_ELSEWHERE);
    expect(sends()).toHaveLength(0);
    client.stop();
  });

  it("a `session.message` of another run: the task is read again before a steer, which goes into the run that read shows", async () => {
    const { client, gateway, hold, sends } = await steering({ session: { sessionId: "s-1" } });
    const release = hold({ sessionId: "s-1", inFlightRun: { runId: "run-b" } });
    gateway.emit("session.message", {
      sessionKey: KEY,
      message: { role: "assistant", content: [{ type: "text", text: "On it." }] },
      sessionId: "s-1",
      session: { key: KEY, sessionId: "s-1" },
      runId: "run-b",
    });
    await sleep(20);
    client.sendMessage(KEY, "Skip the photos folder.", { sessionId: "s-1" });
    await sleep(50);
    expect(sends()).toHaveLength(0);
    release();
    await until(() => sends().length === 1);
    expect(sends()[0]).toMatchObject({ queueMode: "steer", message: "Skip the photos folder." });
    client.stop();
  });

  it("an event of another run while the read is out, with no run read before it: the read can't confirm the run it shows; one more read, with nothing heard, confirms it", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.history"] = () => ({ messages: [], hasMore: false, sessionId: "s-1" });
    const { client, transcript } = await openTask({ gateway });
    // The read named no run in flight; a run starts after it.
    gateway.emit("agent", agentEvent("run-a", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.some((run) => run.state === "running"));
    const read = deferred<void>();
    gateway.handlers["chat.history"] = async () => {
      await read.promise;
      return { messages: [], hasMore: false, sessionId: "s-1", inFlightRun: { runId: "run-a" } };
    };
    const before = gateway.calls("chat.history").length;
    client.sendMessage(KEY, "Skip the photos folder.", { sessionId: "s-1" });
    await until(() => gateway.calls("chat.history").length > before);
    // Another run's delta while the read the steer waits for is out.
    gateway.emit("chat", {
      runId: "run-b",
      sessionKey: KEY,
      seq: 1,
      state: "delta",
      message: { role: "assistant", content: [{ type: "text", text: "Starting over." }] },
    });
    await sleep(20);
    expect(gateway.calls("chat.send")).toHaveLength(0);
    read.resolve();
    await until(() => gateway.calls("chat.send").length === 1);
    expect(gateway.calls("chat.history")).toHaveLength(before + 2);
    expect(gateway.calls("chat.send")[0]).toMatchObject({ queueMode: "steer" });
    client.stop();
  });

  it("another run's delta during every read: a steer reads twice at most, then waits behind the run as a checked send", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.history"] = () => ({ messages: [], hasMore: false, sessionId: "s-1" });
    const { client, transcript } = await openTask({ gateway });
    gateway.emit("agent", agentEvent("run-a", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.some((run) => run.state === "running"));
    // A companion run streams while each read is out, until it ends.
    let seq = 0;
    let streaming = true;
    gateway.handlers["chat.history"] = async () => {
      seq += 1;
      if (streaming) gateway.emit("chat", { runId: "run-b", sessionKey: KEY, seq, state: "delta" });
      await sleep(10);
      return {
        messages: [],
        hasMore: false,
        sessionId: "s-1",
        ...(streaming ? { inFlightRun: { runId: "run-a" } } : {}),
      };
    };
    const before = gateway.calls("chat.history").length;
    const id = client.sendMessage(KEY, "Skip the photos folder.", { sessionId: "s-1" });
    await until(() => transcript().outbox.find((each) => each.id === id)?.status === "queued");
    // Time for several more reads, were any asked for.
    await sleep(800);
    expect(gateway.calls("chat.history").length - before).toBe(2);
    expect(gateway.calls("chat.send")).toHaveLength(0);
    // It goes once the runs end, naming its session.
    streaming = false;
    gateway.emit("chat", { runId: "run-b", sessionKey: KEY, seq: 99, state: "final" });
    gateway.emit("agent", agentEvent("run-a", 2, "lifecycle", { phase: "end" }));
    await until(() => gateway.calls("chat.send").length === 1);
    expect(gateway.calls("chat.send")[0]).toMatchObject({ sessionId: "s-1" });
    client.stop();
  });

  it("a hundred deltas of the run a read out shows in flight: the read still confirms it, and the steer goes with no other read", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.history"] = () => ({ messages: [], hasMore: false, sessionId: "s-1" });
    const { client, transcript } = await openTask({ gateway });
    gateway.emit("agent", agentEvent("run-a", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.some((run) => run.state === "running"));
    const read = deferred<void>();
    gateway.handlers["chat.history"] = async () => {
      await read.promise;
      return { messages: [], hasMore: false, sessionId: "s-1", inFlightRun: { runId: "run-a" } };
    };
    const before = gateway.calls("chat.history").length;
    client.sendMessage(KEY, "Skip the photos folder.", { sessionId: "s-1" });
    await until(() => gateway.calls("chat.history").length > before);
    for (let seq = 1; seq <= 100; seq += 1)
      gateway.emit("chat", {
        runId: "run-a",
        sessionKey: KEY,
        seq,
        state: "delta",
        message: { role: "assistant", content: [{ type: "text", text: "x".repeat(seq) }] },
      });
    await sleep(20);
    read.resolve();
    await until(() => gateway.calls("chat.send").length === 1);
    expect(gateway.calls("chat.send")[0]).toMatchObject({ queueMode: "steer" });
    // The one read the steer waited for; an accepted send asks for its own afterwards.
    expect(gateway.calls("chat.history")).toHaveLength(before + 1);
    client.stop();
  });

  it("a run id past the id bound: nothing keeps it, and it confirms no steer", async () => {
    const long = `run-${"r".repeat(100_000)}`;
    const gateway = grantingGateway();
    gateway.handlers["chat.history"] = () => ({
      messages: [],
      hasMore: false,
      sessionId: "s-1",
      inFlightRun: { runId: long },
    });
    const { client, transcript } = await openTask({ gateway });
    const checks = (client as unknown as { steerChecks: Map<string, unknown> }).steerChecks;
    expect(checks.get(KEY)).toMatchObject({ sessionId: "s-1", runId: null });
    expect(JSON.stringify([KEY, checks.get(KEY)]).length).toBeLessThanOrEqual(
      CLIENT_OWNERS.steerChecks!.each,
    );
    // Events under it while a read is out are not kept either.
    const read = deferred<void>();
    gateway.handlers["chat.history"] = async () => {
      await read.promise;
      return { messages: [], hasMore: false, sessionId: "s-1" };
    };
    gateway.emit("agent", agentEvent(long, 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.some((run) => run.state === "running"));
    gateway.emit("session.message", { sessionKey: KEY });
    await until(() => (client as unknown as { loads: Map<string, unknown> }).loads.has(KEY));
    gateway.emit("chat", { runId: long, sessionKey: KEY, seq: 1, state: "delta" });
    await sleep(20);
    const heard = (client as unknown as { steerHeard: Map<string, Set<string>> }).steerHeard;
    expect([...(heard.get(KEY) ?? [])].every((id) => id.length < 100)).toBe(true);
    read.resolve();
    client.stop();
  });

  it("the task's row read after a refusal names another session: what its last read established is dropped, and the task is read again", async () => {
    const { client, gateway, transcript } = await steering({ session: { sessionId: "s-2" } });
    const checks = (client as unknown as { steerChecks: Map<string, unknown> }).steerChecks;
    expect(checks.get(KEY)).toMatchObject({ sessionId: "s-1", runId: "run-a" });
    gateway.handlers["chat.send"] = () => {
      throw new GatewayError(MOVED);
    };
    const reads = gateway.calls("chat.history").length;
    gateway.handlers["chat.history"] = () => new Promise(() => undefined);
    client.sendMessage(KEY, "Later, the logs.", { sessionId: "s-1", mode: "queue" });
    gateway.emit("agent", agentEvent("run-a", 2, "lifecycle", { phase: "end" }));
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(transcript().outbox[0]?.error).toBe(TASK_DELETED_ELSEWHERE);
    expect(checks.has(KEY)).toBe(false);
    await until(() => gateway.calls("chat.history").length > reads);
    client.stop();
  });
});

describe("a late archive or delete of the session the task held before (F-277, F-278, F-420)", () => {
  /** A task listed and read in `s-2`, with a run going and a message queued behind it. */
  async function replaced() {
    const gateway = grantingGateway();
    const rows = [{ key: KEY, agentId: "otto", label: "Disk", sessionId: "s-2" }];
    gateway.handlers["sessions.subscribe"] = () => ({
      subscribed: true,
      list: { sessions: [...rows], hasMore: false },
    });
    gateway.handlers["sessions.list"] = () => ({ sessions: [...rows], hasMore: false });
    gateway.handlers["chat.history"] = () => ({ messages: [], hasMore: false, sessionId: "s-2" });
    const opened = await openTask({ gateway });
    const listed = () =>
      opened.client.state.tasksByBot.otto?.some((task) => task.key === KEY) === true;
    await until(listed);
    gateway.emit("agent", agentEvent("run-on", 1, "lifecycle", { phase: "start" }));
    await until(() => opened.transcript().runs.some((run) => run.state === "running"));
    const id = opened.client.sendMessage(KEY, "Then send me a summary.", {
      sessionId: "s-2",
      mode: "queue",
      attachments: [FILE],
    });
    /** The gateway lists the task no more. */
    const unlist = () => rows.splice(0);
    return { ...opened, id, listed, unlist };
  }

  it.each([
    ["deleted", { reason: "delete", sessionId: "s-1" }],
    ["archived", { session: { key: KEY, sessionId: "s-1", archived: true } }],
  ] as const)(
    "%s, heard after the session that followed: the message queued for that one stays queued with its file, and the task stays listed",
    async (_, event) => {
      const { client, gateway, transcript, id, listed, unlist } = await replaced();
      gateway.emit("sessions.changed", { sessionKey: KEY, ...event });
      await sleep(50);
      expect(transcript().outbox[0]).toMatchObject({ id, status: "queued", sessionId: "s-2" });
      expect(listed()).toBe(true);
      // Its own removal refuses it as any does.
      unlist();
      gateway.emit("sessions.changed", { sessionKey: KEY, reason: "delete", sessionId: "s-2" });
      await until(() => transcript().outbox[0]?.status === "failed");
      expect(transcript().outbox[0]).toMatchObject({ id, error: TASK_DELETED_ELSEWHERE });
      expect(listed()).toBe(false);
      client.stop();
    },
  );
});

describe("this client's own archive holds back what it will cancel until it settles (F-420)", () => {
  /** A task with a run going and a message queued behind it, archived here with its answer held. */
  async function archiving() {
    const { client, gateway, transcript, sends } = await shown({
      session: { sessionId: "s-1" },
    });
    gateway.handlers["sessions.describe"] = () => ({ session: { key: KEY, sessionId: "s-1" } });
    gateway.emit("agent", agentEvent("run-on", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.some((run) => run.state === "running"));
    const id = client.sendMessage(KEY, "Then send me a summary.", {
      sessionId: "s-1",
      mode: "queue",
    });
    const patched = deferred<unknown>();
    gateway.handlers["sessions.patch"] = () => patched.promise;
    const archived = client.archiveTask(KEY);
    await until(() => gateway.calls("sessions.patch").length === 1);
    // The run ends on its own while the archive is out.
    gateway.emit("agent", agentEvent("run-on", 2, "lifecycle", { phase: "end" }));
    await until(() => !transcript().runs.some((run) => run.state === "running"));
    await sleep(50);
    return { client, gateway, transcript, sends, id, patched, archived };
  }

  it("the run ends while the archive is out: the queued message is not sent, and once the archive succeeds it is cancelled", async () => {
    const { client, transcript, sends, id, patched, archived } = await archiving();
    expect(sends()).toHaveLength(0);
    expect(transcript().outbox.find((each) => each.id === id)?.status).toBe("queued");
    patched.resolve({ ok: true });
    await archived;
    expect(transcript().outbox.find((each) => each.id === id)?.status).toBe("cancelled");
    await sleep(50);
    expect(sends()).toHaveLength(0);
    client.stop();
  });

  it("the archive fails: the message held back goes on as it would have", async () => {
    const { client, sends, patched, archived } = await archiving();
    expect(sends()).toHaveLength(0);
    patched.reject(new GatewayError({ code: "UNAVAILABLE", message: "busy" }));
    await expect(archived).rejects.toThrow();
    await until(() => sends().length === 1);
    expect(sends()[0]).toMatchObject({ message: "Then send me a summary.", sessionId: "s-1" });
    client.stop();
  });
});

describe("a message meant to make its task (`newTask`) goes only to a key that holds none (F-097, F-278)", () => {
  it("refused when it is made, once the key holds a session", async () => {
    const { client, sends } = await shown({ session: { sessionId: "s-1" } });
    expect(() => client.sendMessage(KEY, "first", { newTask: true })).toThrow(
      "This task already has a session, so a message meant to start it wasn't sent.",
    );
    await sleep(20);
    expect(sends()).toHaveLength(0);
    client.stop();
  });

  it("refused when it is delivered, once the key's history names a session: nothing goes unguarded", async () => {
    const { client, gateway, release, transcript, sends } = await opening(null, {
      sessionId: undefined,
    });
    // Its first read answers with no session; a run of the key goes before the message.
    release();
    await until(() => transcript().status === "ready");
    gateway.emit("agent", agentEvent("run-x", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.some((run) => run.state === "running"));
    const id = client.sendMessage(KEY, "first", { newTask: true, mode: "queue" });
    // The key holds a session by the time it would go.
    gateway.handlers["chat.history"] = () => ({ messages: [], hasMore: false, sessionId: "s-5" });
    gateway.emit("session.message", { sessionKey: KEY });
    await until(() => transcript().sessionId === "s-5");
    gateway.emit("agent", agentEvent("run-x", 2, "lifecycle", { phase: "end" }));
    await until(() => transcript().outbox.find((each) => each.id === id)?.status === "failed");
    expect(sends()).toHaveLength(0);
    client.stop();
  });

  it("the bridge never passes it: a viewer's send names its session or is refused", () => {
    expect(() =>
      parseBridgeCommand({
        type: "sendMessage",
        key: KEY,
        text: "first",
        mode: "auto",
        attachmentIds: [],
        newTask: true,
      }),
    ).toThrow();
    expect(
      parseBridgeCommand({
        type: "sendMessage",
        key: KEY,
        text: "first",
        mode: "auto",
        attachmentIds: [],
        sessionId: "s-1",
        newTask: true,
      }),
    ).not.toHaveProperty("newTask");
  });
});

describe("Edit on a held message gives back the session it was bound to (F-278)", () => {
  it("its words and files come back with that session, whatever the task shows now", async () => {
    const { client, gateway, transcript } = await shown({ session: { sessionId: "s-1" } });
    gateway.emit("agent", agentEvent("run-on", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.some((run) => run.state === "running"));
    const id = client.sendMessage(KEY, "Then send me a summary.", {
      sessionId: "s-1",
      mode: "queue",
    });
    const viewer = createBridgeSession(client);
    await viewer.apply({ type: "openSession", key: KEY });
    await expect(
      viewer.apply({ type: "takeBackMessage", key: KEY, messageId: id }),
    ).resolves.toMatchObject({ text: "Then send me a summary.", sessionId: "s-1" });
    client.stop();
  });
});

/** A delta of `runId` in the task, as OpenClaw 2026.10.6 sends a `chat` delta. */
const delta = (runId: string, seq: number) => ({ runId, sessionKey: KEY, seq, state: "delta" });

/** The task's row as OpenClaw 2026.10.6 carries it on its events (`buildGatewaySessionSnapshot`). */
const snapshot = (sessionId: string, active: string[]) => ({
  session: {
    key: KEY,
    sessionId,
    status: active.length > 0 ? "running" : "done",
    hasActiveRun: active.length > 0,
    activeRunIds: active,
  },
  sessionId,
  status: active.length > 0 ? "running" : "done",
  hasActiveRun: active.length > 0,
  activeRunIds: active,
});

describe("one way in: news of the task not known to be harmless counts against a steer (F-278)", () => {
  /**
   * Something heard of the task after the read that confirmed `run-a` in `s-1`: the next steer
   * waits for a fresh read, which answers `then`, and nothing goes before it.
   */
  async function waitsForRead(
    hear: (task: Awaited<ReturnType<typeof steering>>) => unknown,
    then: Record<string, unknown> = { sessionId: "s-1", inFlightRun: { runId: "run-a" } },
  ) {
    const task = await steering({ session: { sessionId: "s-2" } });
    const release = task.hold(then);
    await hear(task);
    await sleep(20);
    const id = task.client.sendMessage(KEY, "Skip the photos folder.", { sessionId: "s-1" });
    await sleep(50);
    expect(task.sends()).toHaveLength(0);
    release();
    return { ...task, id };
  }

  it("a run's own deltas, in the read's session with only its run active, are harmless: the steer goes with no other read", async () => {
    const { client, gateway, reads, sends } = await steering({ session: { sessionId: "s-1" } });
    const before = reads();
    gateway.emit("chat", delta("run-a", 1));
    gateway.emit("agent", {
      ...agentEvent("run-a", 2, "assistant", { text: "Looking." }),
      ...snapshot("s-1", ["run-a"]),
    });
    await sleep(20);
    client.sendMessage(KEY, "Skip the photos folder.", { sessionId: "s-1" });
    await until(() => sends().length === 1);
    expect(sends()[0]).toMatchObject({ queueMode: "steer" });
    expect(reads()).toBe(before);
    client.stop();
  });

  it("an event of a type this client does not know, naming the task: the steer waits for a fresh read", async () => {
    const { client, sends } = await waitsForRead(({ gateway }) =>
      gateway.emit("session.wobble", { sessionKey: KEY, ts: 2_000 }),
    );
    await until(() => sends().length === 1);
    expect(sends()[0]).toMatchObject({ queueMode: "steer" });
    client.stop();
  });

  it("an archive's check reads the session that replaced the task (`sessions.describe`): no steer goes on the read before it, and the message is refused", async () => {
    const { client, transcript, sends } = await waitsForRead(
      ({ client }) => client.archiveTask(KEY).catch(() => undefined),
      { sessionId: "s-2" },
    );
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(transcript().outbox[0]?.error).toBe(TASK_DELETED_ELSEWHERE);
    expect(sends()).toHaveLength(0);
    client.stop();
  });

  it("a steer refused because the task was deleted while the gateway admitted it: the next steer waits for a fresh read", async () => {
    const task = await steering({ session: null });
    task.gateway.handlers["chat.send"] = () => {
      throw new GatewayError(DELETED_WHILE_STARTING);
    };
    const release = task.hold({ sessionId: undefined });
    task.client.sendMessage(KEY, "Skip the photos folder.", { sessionId: "s-1" });
    await until(() => task.transcript().outbox[0]?.status === "failed");
    expect(task.sends()).toHaveLength(1);
    task.client.sendMessage(KEY, "And the music folder.", { sessionId: "s-1" });
    await sleep(50);
    expect(task.sends()).toHaveLength(1);
    release();
    await until(() => task.transcript().outbox[1]?.status === "failed");
    expect(task.transcript().outbox[1]?.error).toBe(TASK_DELETED_ELSEWHERE);
    // Anything after the read goes as a checked send, naming its session.
    expect(task.sends().slice(1)).toMatchObject([{ sessionId: "s-1", expectedLeafEntryId: null }]);
    task.client.stop();
  });

  it("the run's end as a `sessions.changed` row: the read that confirmed it no longer does, and a steer waits", async () => {
    const { client, sends } = await waitsForRead(
      ({ gateway }) =>
        gateway.emit("sessions.changed", {
          sessionKey: KEY,
          agentId: "otto",
          phase: "end",
          runId: "run-a",
          ts: 2_000,
          ...snapshot("s-1", []),
        }),
      { sessionId: "s-1" },
    );
    await until(() => sends().length === 1);
    expect(sends()[0]).toMatchObject({ sessionId: "s-1", queueMode: "followup" });
    client.stop();
  });

  it.each([
    [
      "session.message",
      {
        sessionKey: KEY,
        message: { role: "assistant", content: [{ type: "text", text: "On it." }] },
        messageSeq: 3,
        ...snapshot("s-1", ["run-a", "run-b"]),
      },
    ],
    [
      "sessions.changed",
      { sessionKey: KEY, reason: "update", ts: 2_000, ...snapshot("s-1", ["run-b"]) },
    ],
  ] as const)(
    "a `%s` naming another set of active runs in the same session: a steer waits for a fresh read",
    async (event, payload) => {
      const { client, sends } = await waitsForRead(({ gateway }) => gateway.emit(event, payload));
      await until(() => sends().length === 1);
      client.stop();
    },
  );

  it("a `session.tool` of the session and run that replaced the task: a steer waits, and is refused", async () => {
    const { client, transcript, sends } = await waitsForRead(
      ({ gateway }) =>
        gateway.emit("session.tool", {
          ...agentEvent("run-b", 1, "tool", {
            phase: "start",
            name: "exec",
            toolCallId: "call-1",
            args: { command: "ls" },
          }),
          ...snapshot("s-2", ["run-b"]),
        }),
      { sessionId: "s-2", inFlightRun: { runId: "run-b" } },
    );
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(transcript().outbox[0]?.error).toBe(TASK_DELETED_ELSEWHERE);
    expect(sends()).toHaveLength(0);
    client.stop();
  });

  it("a run-phase row naming the run's two ids, and an agent event the task list shows: the read is dropped before either is published", async () => {
    const { client, gateway } = await steering({ session: { sessionId: "s-1" } });
    const checks = (client as unknown as { steerChecks: Map<string, unknown> }).steerChecks;
    const published: boolean[] = [];
    const stop = client.store.subscribe(() => void published.push(checks.has(KEY)));
    gateway.emit("sessions.changed", {
      sessionKey: KEY,
      agentId: "otto",
      phase: "start",
      runId: "run-q",
      clientRunId: "run-a",
      ts: 2_000,
      ...snapshot("s-1", ["run-q"]),
    });
    await until(() => published.length > 0);
    expect(published[0]).toBe(false);
    // Read again, and confirmed; then an approval the run waits on, which the task list shows.
    await until(() => checks.has(KEY));
    published.length = 0;
    gateway.emit(
      "agent",
      agentEvent("run-a", 3, "lifecycle", { phase: "waiting-approval", approvalId: "ap-1" }),
    );
    await until(() => published.length > 0);
    expect(published[0]).toBe(false);
    stop();
    client.stop();
  });

  it("a run id past the id bound in JSON characters, though not in code units: nothing keeps it, and it confirms no steer", async () => {
    const escaped = String.fromCharCode(1).repeat(900);
    const gateway = grantingGateway();
    gateway.handlers["chat.history"] = () => ({
      messages: [],
      hasMore: false,
      sessionId: "s-1",
      inFlightRun: { runId: escaped },
    });
    const { client, transcript } = await openTask({ gateway });
    const checks = (client as unknown as { steerChecks: Map<string, unknown> }).steerChecks;
    expect(checks.get(KEY)).toMatchObject({ sessionId: "s-1", runId: null });
    expect(JSON.stringify([KEY, checks.get(KEY)]).length).toBeLessThanOrEqual(
      CLIENT_OWNERS.steerChecks!.each,
    );
    // Its deltas while a read is out are not kept either.
    const read = deferred<void>();
    gateway.handlers["chat.history"] = async () => {
      await read.promise;
      return { messages: [], hasMore: false, sessionId: "s-1" };
    };
    gateway.emit("agent", agentEvent(escaped, 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.some((run) => run.state === "running"));
    gateway.emit("session.message", { sessionKey: KEY });
    await until(() => (client as unknown as { loads: Map<string, unknown> }).loads.has(KEY));
    gateway.emit("chat", delta(escaped, 1));
    await sleep(20);
    const heard = (client as unknown as { steerHeard: Map<string, Set<string>> }).steerHeard;
    expect([...(heard.get(KEY) ?? [])]).not.toContain(escaped);
    read.resolve();
    client.stop();
  });
});

describe("a delete that names only the task's key (F-278, F-420)", () => {
  it("heard after the session that replaced it: what the key holds is read first, and the message queued for that session stays queued, the task listed", async () => {
    const gateway = grantingGateway();
    const rows = [{ key: KEY, agentId: "otto", label: "Disk", sessionId: "s-2" }];
    gateway.handlers["sessions.subscribe"] = () => ({
      subscribed: true,
      list: { sessions: [...rows], hasMore: false },
    });
    gateway.handlers["sessions.list"] = () => ({ sessions: [...rows], hasMore: false });
    gateway.handlers["chat.history"] = () => ({ messages: [], hasMore: false, sessionId: "s-2" });
    gateway.handlers["sessions.describe"] = () => ({ session: { key: KEY, sessionId: "s-2" } });
    const { client, transcript } = await openTask({ gateway });
    const listed = () => client.state.tasksByBot.otto?.some((task) => task.key === KEY) === true;
    await until(listed);
    gateway.emit("agent", agentEvent("run-on", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.some((run) => run.state === "running"));
    const id = client.sendMessage(KEY, "Then send me a summary.", {
      sessionId: "s-2",
      mode: "queue",
      attachments: [FILE],
    });
    const describes = gateway.calls("sessions.describe").length;
    gateway.emit("sessions.changed", { sessionKey: KEY, agentId: "otto", reason: "delete", ts: 2 });
    await until(() => gateway.calls("sessions.describe").length > describes);
    await sleep(400);
    expect(transcript().outbox[0]).toMatchObject({ id, status: "queued", sessionId: "s-2" });
    expect(listed()).toBe(true);
    client.stop();
  });
});

describe("this client's own archive holds its messages wherever they are sent from (F-420)", () => {
  /** A task with a run going and a message waiting, archived here with its answer held. */
  async function archiving(start: (task: Awaited<ReturnType<typeof shown>>) => Promise<string>) {
    const task = await shown({ session: { sessionId: "s-1" } });
    task.gateway.handlers["sessions.describe"] = () => ({
      session: { key: KEY, sessionId: "s-1" },
    });
    const id = await start(task);
    const patched = deferred<unknown>();
    task.gateway.handlers["sessions.patch"] = () => patched.promise;
    const archived = task.client.archiveTask(KEY);
    await until(() => task.gateway.calls("sessions.patch").length === 1);
    return { ...task, id, patched, archived };
  }

  it("Send now on the queued message while the archive is out: nothing is sent, and once the archive succeeds it is cancelled", async () => {
    const { client, transcript, sends, id, patched, archived } = await archiving(
      async ({ client, gateway, transcript }) => {
        gateway.emit("agent", agentEvent("run-on", 1, "lifecycle", { phase: "start" }));
        await until(() => transcript().runs.some((run) => run.state === "running"));
        return client.sendMessage(KEY, "Then send me a summary.", {
          sessionId: "s-1",
          mode: "queue",
        });
      },
    );
    client.sendQueuedNow(KEY, id);
    await sleep(100);
    expect(sends()).toHaveLength(0);
    expect(transcript().outbox.find((each) => each.id === id)?.status).toBe("queued");
    patched.resolve({ ok: true });
    await archived;
    expect(transcript().outbox.find((each) => each.id === id)?.status).toBe("cancelled");
    await sleep(50);
    expect(sends()).toHaveLength(0);
    client.stop();
  });

  it("Send on a message parked Not sent while the archive is out: nothing is sent until it settles, and once it fails the message goes", async () => {
    const { client, gateway, sends, id, patched, archived } = await archiving(
      async ({ client, gateway, transcript }) => {
        gateway.emit("agent", agentEvent("run-on", 1, "lifecycle", { phase: "start" }));
        await until(() => transcript().runs.some((run) => run.state === "running"));
        const queued = client.sendMessage(KEY, "Then send me a summary.", {
          sessionId: "s-1",
          mode: "queue",
        });
        gateway.emit("chat", { runId: "run-on", sessionKey: KEY, seq: 2, state: "aborted" });
        await until(() => transcript().outbox[0]?.status === "not-sent");
        return queued;
      },
    );
    client.retryMessage(KEY, id);
    await sleep(100);
    expect(sends()).toHaveLength(0);
    patched.reject(new GatewayError({ code: "UNAVAILABLE", message: "busy" }));
    await expect(archived).rejects.toThrow();
    await until(() => sends().length === 1);
    expect(sends()[0]).toMatchObject({ message: "Then send me a summary.", sessionId: "s-1" });
    expect(gateway.calls("sessions.patch")).toHaveLength(1);
    client.stop();
  });

  it("an archive still waiting for write access at `REMOVAL_HOLD_MS` gives up: it holds nothing back, and sends nothing once access comes", async () => {
    const gateway = grantingGateway();
    const wait = deferred<unknown>();
    gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-9" });
    gateway.handlers["device.scopes.waitUpgrade"] = () => wait.promise;
    gateway.handlers["chat.history"] = () => ({ messages: [], hasMore: false, sessionId: "s-1" });
    const { client, transcript } = await openTask({ gateway, held: READ_SCOPES });
    gateway.emit("agent", agentEvent("run-on", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.some((run) => run.state === "running"));
    client.sendMessage(KEY, "Then send me a summary.", { sessionId: "s-1", mode: "queue" });
    const removals = (client as unknown as { ownRemovals: Map<number, unknown> }).ownRemovals;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const failed = client.archiveTask(KEY).then(
        () => null,
        (error: unknown) => error,
      );
      await until(() => client.state.connection.upgrade.status === "pending");
      expect(removals.size).toBe(1);
      await vi.advanceTimersByTimeAsync(REMOVAL_HOLD_MS);
      expect(String(await failed)).toMatch(/took too long, so nothing was archived or deleted/);
      expect(removals.size).toBe(0);
      wait.resolve({ status: "expired", requestId: "up-9" });
      await sleep(50);
      expect(gateway.calls("sessions.describe")).toEqual([]);
      expect(gateway.calls("sessions.patch")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
    client.stop();
  });
});
