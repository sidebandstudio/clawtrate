// A message written in a task that was deleted elsewhere (parity F-278), or archived elsewhere
// (F-277). OpenClaw 2026.10.6 starts a new, empty task under the deleted task's key for a plain
// `chat.send`; a send that names the session it was written for (`sessionId` with
// `expectedLeafEntryId: null`) is refused instead ("active branch changed; review and retry").
// Every send to an archived task is refused with a message and no reason of its own. The refused
// message fails with the reason and keeps its words; nothing is sent again into whatever the key
// holds now.
import { describe, expect, it } from "vitest";
import { TaskArchivedError, TaskDeletedError } from "../src/client.ts";
import { TASK_ARCHIVED_ELSEWHERE, TASK_DELETED_ELSEWHERE } from "../src/task-actions.ts";
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
async function shown(now: { session: { sessionId: string; archived?: boolean } | null }) {
  const gateway = grantingGateway();
  const history = { sessionId: "s-1" as string | undefined, messages: [] as unknown[] };
  gateway.handlers["chat.history"] = () => ({
    messages: history.messages,
    hasMore: false,
    sessionId: history.sessionId,
  });
  gateway.handlers["sessions.describe"] = () => now;
  const opened = await openTask({ gateway });
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
    const { client, transcript, sends } = await shown({ session: { sessionId: "s-1" } });
    expect(transcript().sessionId).toBe("s-1");
    client.sendMessage(KEY, "first");
    await until(() => sends().length === 1);
    expect(sends()[0]).toMatchObject({ sessionId: "s-1", expectedLeafEntryId: null });
    // Its run is under way: the next message steers it, which the gateway does not guard.
    await until(() => transcript().runs.some((run) => run.bound && run.state === "running"));
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

  it("the same session under the key: a message that is no stop command is not sent again, and the refusal stands", async () => {
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
    expect(sends()).toHaveLength(1);
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

  it("a history that names no session: the task is gone, and nothing is sent", async () => {
    const { client, release, transcript, sends } = await opening(null, { sessionId: undefined });
    client.sendMessage(KEY, "first");
    release();
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(transcript().outbox[0]).toMatchObject({ text: "first", error: TASK_DELETED_ELSEWHERE });
    await sleep(50);
    expect(sends()).toHaveLength(0);
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
