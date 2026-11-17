// A message's words and files move together: taken back from the shelf to be
// edited, or sent again after its turn failed, they are one record.

import { describe, expect, it } from "vitest";
import { AttachmentStore } from "../src/attachments.ts";
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
