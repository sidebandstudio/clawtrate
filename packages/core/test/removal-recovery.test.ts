import { expect, it } from "vitest";
import { TASK_DELETED_ELSEWHERE } from "../src/task-actions.ts";
import { agentEvent, grantingGateway, KEY, openTask } from "./client-harness.ts";
import { deferred, until } from "./fake-gateway.ts";

const file = { fileName: "notes.txt", mimeType: "text/plain", type: "file", content: "aGk=" };

async function listedTask() {
  const gateway = grantingGateway();
  const rows = [{ key: KEY, agentId: "otto", sessionId: "session-a" }];
  const list = () => ({ sessions: [...rows], hasMore: false });
  gateway.handlers["sessions.list"] = list;
  gateway.handlers["sessions.subscribe"] = () => ({ subscribed: true, list: list() });
  gateway.handlers["chat.history"] = () => ({
    messages: [],
    hasMore: false,
    sessionId: "session-a",
  });
  const task = await openTask({ gateway });
  const listed = () => task.client.state.tasksByBot.otto?.some((row) => row.key === KEY) === true;
  await until(listed);
  gateway.emit("agent", agentEvent("run-on", 1, "lifecycle", { phase: "start" }));
  await until(() => task.transcript().runs.some((run) => run.state === "running"));
  const queue = (sessionId: string) =>
    task.client.sendMessage(KEY, `Keep ${sessionId}`, {
      mode: "queue",
      sessionId,
      attachments: [file],
    });
  const park = () =>
    gateway.emit("chat", {
      runId: "run-on",
      sessionKey: KEY,
      seq: 2,
      state: "aborted",
      stopReason: "delete",
    });
  return { ...task, rows, listed, queue, park };
}

it("F-278: an empty list before the key-only delete answer leaves the parked message recoverable", async () => {
  const { client, gateway, transcript, rows, listed, queue, park } = await listedTask();
  try {
    const id = queue("session-a");
    const bytes = client.retainedAttachmentBytes;
    park();
    await until(() => transcript().outbox[0]?.status === "not-sent");
    const answer = deferred<unknown>();
    gateway.handlers["sessions.describe"] = () => answer.promise;
    rows.length = 0;
    gateway.emit("sessions.changed", { sessionKey: KEY, reason: "delete" });
    await until(() => gateway.calls("sessions.describe").length > 0 && !listed());
    answer.resolve({ session: null });
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(transcript().outbox[0]).toMatchObject({
      id,
      error: TASK_DELETED_ELSEWHERE,
      text: "Keep session-a",
      attachments: [{ fileName: file.fileName }],
    });
    expect(client.retainedAttachmentBytes).toBe(bytes);
    expect(gateway.calls("chat.send")).toEqual([]);
  } finally {
    client.stop();
  }
});
