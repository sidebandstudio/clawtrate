// A message the gateway accepted is not yet a delivered message. When its run
// has ended and history holds no row tied to it, it is unconfirmed: visible,
// kept across closing the task, with its files, and it can be retried with its
// own idempotency key or deleted.

import { describe, expect, it } from "vitest";
import { createBridgeSession } from "../src/bridge.ts";
import type { OutgoingAttachment } from "../src/client.ts";
import {
  agentEvent,
  grantingGateway,
  KEY,
  openTask,
  sentTexts,
  asShown,
} from "./client-harness.ts";
import { until } from "./fake-gateway.ts";

const note: OutgoingAttachment = {
  type: "file",
  mimeType: "text/plain",
  fileName: "note.txt",
  content: "aGVsbG8=",
};

/** Send one message, let its run end, and reload a history that holds no row for it. */
async function acceptedButUnmatched(attachments: OutgoingAttachment[] = []) {
  const gateway = grantingGateway();
  const opened = await openTask({ gateway });
  const id = opened.client.sendMessage(KEY, "deploy it", {
    ...asShown(opened.client),
    attachments,
  });
  await until(() => opened.transcript().outbox[0]?.status === "sent");
  // History persisted something, but nothing ties it to this message: no key, no seq.
  gateway.handlers["chat.history"] = () => ({
    messages: [{ role: "user", content: "deploy it", __openclaw: { id: "u9", seq: 9 } }],
  });
  gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
  gateway.emit("agent", agentEvent("run-1", 2, "lifecycle", { phase: "end" }));
  await until(() => opened.transcript().outbox[0]?.status === "unconfirmed");
  return { ...opened, id };
}

describe("an accepted message history does not hold (D3)", () => {
  it("is unconfirmed, says so, and stays in the outbox", async () => {
    const { client, transcript, id } = await acceptedButUnmatched();
    expect(transcript().outbox).toEqual([
      expect.objectContaining({
        id,
        status: "unconfirmed",
        error: expect.stringMatching(/may not have been delivered/),
      }),
    ]);
    client.stop();
  });

  it("can be retried with its own idempotency key, once", async () => {
    const { client, gateway, transcript, id } = await acceptedButUnmatched();
    client.retryMessage(KEY, id);
    await until(() => gateway.calls("chat.send").length === 2);
    expect(
      gateway
        .calls("chat.send")
        .map((params) => (params as { idempotencyKey: string }).idempotencyKey),
    ).toEqual([id, id]);
    expect(sentTexts(gateway)).toEqual(["deploy it", "deploy it"]);
    expect(transcript().outbox[0]!.status).not.toBe("unconfirmed");
    client.stop();
  });

  it("can be deleted", async () => {
    const { client, gateway, transcript, id } = await acceptedButUnmatched();
    client.deleteMessage(KEY, id);
    expect(transcript().outbox).toEqual([]);
    expect(gateway.calls("chat.send")).toHaveLength(1);
    client.stop();
  });

  it("survives closing the task and a viewer reconnecting", async () => {
    const { client, transcript, id } = await acceptedButUnmatched();
    const first = createBridgeSession(client);
    await first.apply({ type: "openSession", key: KEY });
    client.closeSession(KEY);
    first.dispose();
    // No viewer has it open; the client keeps it for its unconfirmed message.
    expect(client.state.transcripts[KEY]?.outbox.map((each) => [each.id, each.status])).toEqual([
      [id, "unconfirmed"],
    ]);
    const second = createBridgeSession(client);
    await second.apply({ type: "openSession", key: KEY });
    await until(() => transcript().status === "ready");
    expect(transcript().outbox.map((each) => [each.id, each.status])).toEqual([
      [id, "unconfirmed"],
    ]);
    await second.apply({ type: "retryMessage", key: KEY, messageId: id });
    second.dispose();
    client.stop();
  });

  it("keeps its files for a retry until history confirms it, then lets them go", async () => {
    const { client, gateway, transcript, id } = await acceptedButUnmatched([note]);
    expect(client.retainedAttachmentBytes).toBe(5);
    client.retryMessage(KEY, id);
    await until(() => gateway.calls("chat.send").length === 2);
    expect(
      (gateway.calls("chat.send")[1] as { attachments: OutgoingAttachment[] }).attachments,
    ).toEqual([note]);
    // History now holds it, by its key: it leaves the outbox and its files go.
    gateway.handlers["chat.history"] = () => ({
      messages: [
        {
          role: "user",
          content: "deploy it",
          __openclaw: { id: "u10", seq: 10, idempotencyKey: id },
        },
      ],
    });
    gateway.emit("session.message", { sessionKey: KEY });
    await until(() => transcript().outbox.length === 0);
    expect(client.retainedAttachmentBytes).toBe(0);
    client.stop();
  });

  it("an accepted message whose run is still going stays sent", async () => {
    const gateway = grantingGateway();
    const { client, transcript } = await openTask({ gateway });
    client.sendMessage(KEY, "keep going", asShown(client));
    await until(() => transcript().outbox[0]?.status === "sent");
    gateway.handlers["chat.history"] = () => ({ messages: [], inFlightRun: { runId: "run-1" } });
    gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
    gateway.emit("session.message", { sessionKey: KEY });
    await until(() => gateway.calls("chat.history").length >= 2);
    await until(() => transcript().status === "ready");
    expect(transcript().outbox[0]!.status).toBe("sent");
    client.stop();
  });
});
