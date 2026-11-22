// A message written in a task that was deleted elsewhere (parity F-278), or archived elsewhere
// (F-277). OpenClaw 2026.10.6 starts a new, empty task under the deleted task's key for a plain
// `chat.send`; a send that names the session its history came from (`sessionId` with
// `expectedLeafEntryId: null`) is refused instead ("active branch changed; review and retry").
// Every send to an archived task is refused with a message and no reason of its own. The refused
// message fails with the reason and keeps its words; nothing is sent again into whatever the key
// holds now.
import { describe, expect, it } from "vitest";
import { TaskArchivedError, TaskDeletedError } from "../src/client.ts";
import { TASK_ARCHIVED_ELSEWHERE, TASK_DELETED_ELSEWHERE } from "../src/task-actions.ts";
import { agentEvent, grantingGateway, KEY, openTask } from "./client-harness.ts";
import { GatewayError, sleep, until } from "./fake-gateway.ts";

const MOVED = {
  code: "INVALID_REQUEST",
  message: "active branch changed; review and retry",
  details: { reason: "active-leaf-changed" },
};

type Send = { sessionId?: string; expectedLeafEntryId?: null; idempotencyKey: string };

const ARCHIVED = {
  code: "INVALID_REQUEST",
  message: `Session "${KEY}" is archived. Restore it before starting new work.`,
};

/** A task whose history came from session `s-1`; the gateway's row for it is `now`. */
async function shown(now: { session: { sessionId: string; archived?: boolean } | null }) {
  const gateway = grantingGateway();
  const history = { sessionId: "s-1" as string | undefined };
  gateway.handlers["chat.history"] = () => ({
    messages: [],
    hasMore: false,
    ...(history.sessionId ? { sessionId: history.sessionId } : {}),
  });
  gateway.handlers["sessions.describe"] = () => now;
  const opened = await openTask({ gateway });
  return { ...opened, history, sends: () => gateway.calls("chat.send") as Send[] };
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

  it("the same session under the key: the refusal was not about the task, and the send goes again unguarded with the same key", async () => {
    const { client, gateway, transcript, sends } = await shown({ session: { sessionId: "s-1" } });
    gateway.handlers["chat.send"] = (params) => {
      // The gateway checks a stop command's guard against the whole history.
      if ((params as Send).sessionId) throw new GatewayError(MOVED);
      return { ok: true, aborted: false, runIds: [] };
    };
    client.sendMessage(KEY, "stop");
    await until(() => transcript().outbox[0]?.status === "handled");
    expect(sends()).toHaveLength(2);
    expect(sends()[1]).not.toHaveProperty("sessionId");
    expect(sends()[1]).not.toHaveProperty("expectedLeafEntryId");
    expect(sends()[1]!.idempotencyKey).toBe(sends()[0]!.idempotencyKey);
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
    expect(gateway.calls("sessions.describe")).toHaveLength(1);
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
});

describe("a task archived elsewhere (F-277)", () => {
  it("a send refused while the task's row says archived fails as archived elsewhere, keeps its words and is not sent again", async () => {
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

  it("a task the gateway shows not archived keeps the refusal as it came", async () => {
    const { client, gateway, transcript } = await shown({ session: { sessionId: "s-1" } });
    gateway.handlers["chat.send"] = () => {
      throw new GatewayError(ARCHIVED);
    };
    client.sendMessage(KEY, "hello");
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(transcript().outbox[0]?.error).toBe(ARCHIVED.message);
    client.stop();
  });
});
