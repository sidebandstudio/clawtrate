// A message written in a task that was deleted elsewhere (parity F-278), or archived elsewhere
// (F-277). OpenClaw 2026.10.6 starts a new, empty task under the deleted task's key for a plain
// `chat.send`; a send that names the session it was written for (`sessionId` with
// `expectedLeafEntryId: null`) is refused instead ("active branch changed; review and retry").
// Every send to an archived task is refused with a message and no reason of its own. The refused
// message fails with the reason and keeps its words; nothing is sent again into whatever the key
// holds now, unless the person sends it again to the task once it is live again.
import { describe, expect, it } from "vitest";
import { TaskArchivedError, TaskDeletedError, TaskResetError } from "../src/client.ts";
import {
  TASK_ARCHIVED_ELSEWHERE,
  TASK_DELETED_ELSEWHERE,
  TASK_RESET_ELSEWHERE,
} from "../src/task-actions.ts";
import { agentEvent, grantingGateway, KEY, openTask } from "./client-harness.ts";
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
    client.sendMessage(KEY, "first");
    await until(() => sends().length === 1);
    expect(sends()[0]).toMatchObject({ sessionId: "s-1", expectedLeafEntryId: null });
    // Its run is under way: the next message steers it, which the gateway does not guard.
    await until(() => transcript().runs.some((run) => run.bound && run.state === "running"));
    const started = transcript().runs.find((run) => run.bound)!.id;
    gateway.emit("agent", agentEvent(started, 1, "lifecycle", { phase: "start" }));
    client.sendMessage(KEY, "steer");
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
    const id = client.sendMessage(KEY, "Are you still there?");
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
    client.sendMessage(KEY, "hello");
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
    client.sendMessage(KEY, "/stop");
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
    client.sendMessage(KEY, "stop the photo sync tonight");
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
    client.sendMessage(KEY, "/stop\nthe photo sync can wait");
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
    client.sendMessage(KEY, "/stop");
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
    client.sendMessage(KEY, "/stop");
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
    client.sendMessage(KEY, "hello");
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(transcript().outbox[0]?.error).toBe(MOVED.message);
    client.stop();
  });

  it("a later read of the deleted task names no session: the one shown stays the one sent to", async () => {
    const { client, history, transcript, sends } = await shown({ session: null });
    history.sessionId = undefined;
    const before = transcript().loadedAt;
    client.sendMessage(KEY, "hello");
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
    const id = client.sendMessage(KEY, "Are you still there?");
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
    client.sendMessage(KEY, "hello");
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
    client.sendMessage(KEY, "Still there?");
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
    const id = client.sendMessage(KEY, "Still there?");
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
    client.sendMessage(KEY, "Then send me a summary.", { mode: "queue" });
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
    const id = client.sendMessage(KEY, "Check the disk.", {
      attachments: [{ fileName: "df.txt", mimeType: "text/plain", type: "file", content: "aGk=" }],
      replyToId: "row-2",
    });
    await until(() => transcript().outbox[0]?.status === "sent");
    // The task is deleted and another made under its key; history now names it.
    history.sessionId = "s-2";
    client.reloadSession(KEY);
    await until(() => transcript().sessionId === "s-2");
    gateway.handlers["chat.send"] = (params) => {
      if ((params as Send).sessionId !== "s-2") throw new GatewayError(MOVED);
      return { runId: "run-new", status: "started" };
    };
    const again = client.sendAgain(KEY, id);
    await until(() => transcript().outbox.find((each) => each.id === again)?.status === "failed");
    expect(sends()).toHaveLength(2);
    expect(sends()[1]).toMatchObject({ sessionId: "s-1", replyToId: "row-2" });
    expect(sends()[1]!.attachments).toHaveLength(1);
    expect(transcript().outbox.find((each) => each.id === again)?.error).toBe(
      TASK_DELETED_ELSEWHERE,
    );
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
    client.sendMessage(KEY, "Skip the photos folder.");
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
      client.sendMessage(KEY, "Skip the photos folder.");
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
    client.sendMessage(KEY, "Skip the photos folder.");
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
    client.sendMessage(KEY, "first");
    await until(() => sends().length === 1);
    expect(sends()[0]).toMatchObject({ sessionId: "s-1", expectedLeafEntryId: null });
    release();
    client.stop();
  });

  it("with none listed, it waits for the task's history, and names the session it reads", async () => {
    const { client, release, transcript, sends } = await opening(null, { sessionId: "s-1" });
    client.sendMessage(KEY, "first");
    await sleep(50);
    expect(sends()).toHaveLength(0);
    expect(transcript().outbox[0]?.status).toBe("sending");
    release();
    await until(() => sends().length === 1);
    expect(sends()[0]).toMatchObject({ sessionId: "s-1", expectedLeafEntryId: null });
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
    client.sendMessage(KEY, "first");
    release();
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(transcript().outbox[0]).toMatchObject({ text: "first", error: TASK_DELETED_ELSEWHERE });
    expect(sends()).toHaveLength(1);
    expect(sends()[0]).toMatchObject({ sessionId: "s-1" });
    client.stop();
  });

  it("F-278: a task opened from a link, never listed, and deleted before this client read it: the message is refused as deleted, its words kept, and nothing is sent", async () => {
    // A routine's shared-conversation link opens a key the task list does not hold.
    const { client, release, transcript, sends } = await opening(null, { sessionId: undefined });
    client.sendMessage(KEY, "Is this still running?");
    release();
    await until(() => transcript().outbox[0]?.status === "failed");
    await sleep(50);
    expect(transcript().outbox[0]).toMatchObject({
      text: "Is this still running?",
      error: TASK_DELETED_ELSEWHERE,
    });
    expect(sends()).toHaveLength(0);
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
    client.sendMessage(key, "second");
    await until(() => sends().length === 1);
    expect(sends()[0]).toMatchObject({ sessionKey: key, sessionId: "s-9" });
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
    const id = client.sendMessage(KEY, "One more thing");
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
    client.sendMessage(KEY, "And this");
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
      client.sendMessage(KEY, "hello");
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
    client.sendMessage(KEY, "hello");
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
    const id = client.sendMessage(KEY, "Where were we?");
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(transcript().outbox[0]?.error).toBe(TASK_RESET_ELSEWHERE);
    expect(new TaskResetError().message).toBe(TASK_RESET_ELSEWHERE);
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

  it("restored after its archive refused a message: Resend goes to the same session, still checked", async () => {
    const { client, gateway, transcript, sends } = await shown({ session: { sessionId: "s-1" } });
    let archived = true;
    gateway.handlers["chat.send"] = () => {
      if (archived) throw new GatewayError(ARCHIVED);
      return { runId: "run-new", status: "started" };
    };
    const id = client.sendMessage(KEY, "One more thing");
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
    const id = client.sendMessage(KEY, "hello");
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
    const first = client.sendMessage(KEY, "Same words");
    const second = client.sendMessage(KEY, "Same words");
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
    const id = client.sendMessage(KEY, "Are you still there?");
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
    const id = client.sendMessage(KEY, "hello");
    await until(() => transcript().outbox[0]?.status === "failed");
    await expect(client.startTaskFromMessage(KEY, id)).rejects.toThrow(
      "That message can't start a new task.",
    );
    expect(gateway.calls("sessions.create")).toHaveLength(0);
    client.stop();
  });
});
