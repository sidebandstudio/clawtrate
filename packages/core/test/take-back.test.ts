// A message's words and files move together: taken back from the shelf to be
// edited, or sent again after its turn failed, they are one record.

import { describe, expect, it } from "vitest";
import { AttachmentStore, MAX_PENDING_ATTACHMENTS } from "../src/attachments.ts";
import { createBridgeSession } from "../src/bridge.ts";
import { agentEvent, KEY, openTask, questionRecord, sentTexts } from "./client-harness.ts";
import { sleep, until } from "./fake-gateway.ts";

let ids = 0;
const randomUUID = () => `file-${(ids += 1)}`;

/** A small text file's base64, written out: the engine's tests use no Node APIs. */
const CONTENT: Record<string, string> = {
  "notes.txt": "Y29udGVudHMgb2Ygbm90ZXMudHg=",
  "log.txt": "Y29udGVudHMgb2YgbG9nLnR4dCE=",
};

async function withFile(store: AttachmentStore, name: string) {
  const content = CONTENT[name]!;
  return store.add({ fileName: name, mimeType: "text/plain" }, 20, () => content);
}

describe("taking a message back to edit it (F-468)", () => {
  it("gives back a held message's words and files, held again, and never sends it", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["question.resolve"] = () => ({ status: "cancelled" });
    const store = new AttachmentStore({ newId: randomUUID });
    const viewer = createBridgeSession(client, { attachments: store });
    await viewer.apply({ type: "openSession", key: KEY });
    gateway.emit("agent", agentEvent("run-x", 1, "lifecycle", { phase: "start" }));
    gateway.emit("question.requested", questionRecord("ask_1", "run-x"));
    await until(() => transcript().runs[0]?.state === "waiting");

    const info = await withFile(store, "notes.txt");
    const { messageId } = await viewer.apply({
      type: "sendMessage",
      key: KEY,
      text: "Keep the yearly ones too",
      mode: "auto",
      attachmentIds: [info.id],
    });
    expect(transcript().outbox[0]).toMatchObject({ status: "held" });
    expect(store.available()).toBeGreaterThan(0);

    const back = await viewer.apply({ type: "takeBackMessage", key: KEY, messageId });
    expect(back.text).toBe("Keep the yearly ones too");
    expect(back.attachments).toEqual([
      expect.objectContaining({ fileName: "notes.txt", mimeType: "text/plain" }),
    ]);
    // Held again under a new id: a new send can name it.
    expect(store.get([back.attachments[0]!.id])[0]!.content).toBe(CONTENT["notes.txt"]);
    expect(transcript().outbox[0]!.status).toBe("cancelled");
    expect(client.retainedAttachmentBytes).toBe(0);

    await client.dismissQuestion(KEY, "ask_1");
    await sleep(30);
    expect(sentTexts(gateway)).toEqual([]);
    viewer.dispose();
    client.stop();
  });

  it("refuses a message that is no longer held or queued, changing nothing", async () => {
    const { client, gateway, transcript } = await openTask();
    const viewer = createBridgeSession(client, {
      attachments: new AttachmentStore({ newId: randomUUID }),
    });
    await viewer.apply({ type: "openSession", key: KEY });
    const { messageId } = await viewer.apply({
      type: "sendMessage",
      key: KEY,
      text: "Already on its way",
      mode: "auto",
      attachmentIds: [],
    });
    await until(() => transcript().outbox[0]?.status === "sent");
    await expect(viewer.apply({ type: "takeBackMessage", key: KEY, messageId })).rejects.toThrow(
      /can no longer be edited/,
    );
    expect(transcript().outbox[0]!.status).toBe("sent");
    expect(sentTexts(gateway)).toEqual(["Already on its way"]);
    viewer.dispose();
    client.stop();
  });
});

describe("taking a message back is all or nothing (F-468)", () => {
  /** A task whose run asks a question, with a held message carrying these files. */
  async function heldWithFiles(names: string[]) {
    const task = await openTask();
    task.gateway.handlers["question.resolve"] = () => ({ status: "cancelled" });
    const store = new AttachmentStore({ newId: randomUUID });
    const viewer = createBridgeSession(task.client, { attachments: store });
    await viewer.apply({ type: "openSession", key: KEY });
    task.gateway.emit("agent", agentEvent("run-x", 1, "lifecycle", { phase: "start" }));
    task.gateway.emit("question.requested", questionRecord("ask_1", "run-x"));
    await until(() => task.transcript().runs[0]?.state === "waiting");
    const infos = await Promise.all(names.map((name) => withFile(store, name)));
    const { messageId } = await viewer.apply({
      type: "sendMessage",
      key: KEY,
      text: "Keep the yearly ones too",
      mode: "auto",
      attachmentIds: infos.map((info) => info.id),
    });
    return { ...task, store, viewer, messageId };
  }

  /** Fill the waiting files up to `count`, one small file each. */
  function fill(store: AttachmentStore, count: number) {
    for (let i = 0; i < count; i += 1) {
      store.add({ fileName: `waiting-${i}.txt`, mimeType: "text/plain" }, 1, () => "QQ==");
    }
  }

  it("leaves the held message, its words and its files as they were when the waiting files are full", async () => {
    const { client, transcript, store, viewer, messageId } = await heldWithFiles(["notes.txt"]);
    fill(store, MAX_PENDING_ATTACHMENTS);
    const bytes = client.retainedAttachmentBytes;
    const refused = await viewer.apply({ type: "takeBackMessage", key: KEY, messageId }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(transcript().outbox[0]).toMatchObject({ id: messageId, status: "held" });
    expect(client.retainedAttachmentBytes).toBe(bytes);
    expect(bytes).toBeGreaterThan(0);
    // Told why, in plain words.
    expect(String(refused)).toMatch(/Too many files are waiting.*The message stays as it is/);
    viewer.dispose();
    client.stop();
  });

  it("never holds more than the most waiting files: a batch that only partly fits is refused whole", async () => {
    const { client, transcript, store, viewer, messageId } = await heldWithFiles([
      "notes.txt",
      "log.txt",
    ]);
    // Room for one more file, not for both of the message's.
    fill(store, MAX_PENDING_ATTACHMENTS - 1);
    const refused = await viewer.apply({ type: "takeBackMessage", key: KEY, messageId }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(Error);
    expect(transcript().outbox[0]!.status).toBe("held");
    // Nothing was put back: the one place left is still free, and then none is.
    store.add({ fileName: "one-more.txt", mimeType: "text/plain" }, 1, () => "QQ==");
    expect(() =>
      store.add({ fileName: "too-many.txt", mimeType: "text/plain" }, 1, () => "QQ=="),
    ).toThrow(/Too many files/);
    viewer.dispose();
    client.stop();
  });
});

describe("sending a failed turn's message again (F-102)", () => {
  it("sends the same words and files as a new message with its own key", async () => {
    const { client, gateway, transcript } = await openTask();
    const store = new AttachmentStore({ newId: randomUUID });
    const viewer = createBridgeSession(client, { attachments: store });
    await viewer.apply({ type: "openSession", key: KEY });
    const info = await withFile(store, "log.txt");
    const first = await viewer.apply({
      type: "sendMessage",
      key: KEY,
      text: "Read this log",
      mode: "auto",
      attachmentIds: [info.id],
    });
    await until(() => transcript().outbox[0]?.status === "sent");
    const runId = transcript().outbox[0]!.runId!;
    gateway.emit("agent", agentEvent(runId, 1, "lifecycle", { phase: "start" }));
    gateway.emit(
      "agent",
      agentEvent(runId, 2, "lifecycle", {
        phase: "error",
        error: "overloaded",
        executionSettled: true,
      }),
    );
    await until(() => transcript().runs.some((run) => run.state === "failed"));

    const again = await viewer.apply({ type: "sendAgain", key: KEY, messageId: first.messageId });
    expect(again.messageId).not.toBe(first.messageId);
    await until(() => gateway.calls("chat.send").length === 2);
    const [one, two] = gateway.calls("chat.send") as Array<{
      message: string;
      idempotencyKey: string;
      attachments?: Array<{ fileName: string; content: string }>;
    }>;
    expect(two!.message).toBe("Read this log");
    expect(two!.idempotencyKey).toBe(again.messageId);
    expect(two!.attachments).toEqual(one!.attachments);
    expect(two!.attachments?.[0]?.fileName).toBe("log.txt");
    viewer.dispose();
    client.stop();
  });
});
