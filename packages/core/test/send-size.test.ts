// What one message may carry is computed once (parity F-074, F-285): the composer's check is
// the engine's, over the request as sent, against the gateway's current policy; the count holds
// at the engine's own entry; and a file removed from a draft frees what the host held for it.
import { describe, expect, it } from "vitest";
import { AttachmentStore, MAX_PENDING_ATTACHMENT_BYTES } from "../src/attachments.ts";
import { createBridgeSession } from "../src/bridge.ts";
import { SendTooLargeError } from "../src/client.ts";
import { utf8Length } from "../src/encoding.ts";
import { sendFrameBytes, sendRefusal } from "../src/send-size.ts";
type ConnectParams = { scopes: string[] };
import { grantingGateway, KEY, openTask, asShown } from "./client-harness.ts";
import { helloOk, until } from "./fake-gateway.ts";

const base64 = (bytes: number) => "A".repeat(Math.ceil(bytes / 3) * 4);
const LIMITS = {
  imageBytes: 6_291_456,
  fileBytes: 20_971_520,
  payloadBytes: 26_214_400,
  files: 20,
};

describe("one size for a message (F-074, F-285)", () => {
  it("F-074 F-285: the size a draft is checked at is the frame the engine writes, every escape, the reply id and a command's text counted", async () => {
    const { client, gateway } = await openTask();
    const socket = gateway.sockets.at(-1)!;
    const frames: string[] = [];
    const send = socket.send.bind(socket);
    socket.send = (data: string) => {
      frames.push(data);
      send(data);
    };
    const text = '/review "the plan" — ✓ ok\n\tthen ship';
    const id = client.sendMessage(KEY, text, {
      ...asShown(client),
      replyToId: "row-9",
      attachments: [
        { type: "file", mimeType: "text/plain", fileName: 'notes "v2".txt', content: base64(1000) },
        { type: "image", mimeType: "image/png", fileName: "shot.png", content: base64(2048) },
      ],
    });
    await until(() => frames.some((frame) => frame.includes('"chat.send"')));
    const frame = frames.find((each) => each.includes('"chat.send"'))!;
    const frameId = (JSON.parse(frame) as { id: string }).id;
    const computed = sendFrameBytes({
      sessionKey: KEY,
      text,
      idempotencyKey: id,
      queueMode: "followup",
      replyToId: "row-9",
      sessionId: `session:${KEY}`,
      files: [
        { fileName: 'notes "v2".txt', mimeType: "text/plain", bytes: 1000 },
        { fileName: "shot.png", mimeType: "image/png", bytes: 2048 },
      ],
    });
    // Exact, but for the frame id, which is counted at 64 characters before it exists.
    expect(computed - utf8Length(frame)).toBe(64 - frameId.length);
    client.stop();
  });

  it("F-074 F-285: the last byte of the frame decides: a message exactly at the ceiling goes, one byte more does not", () => {
    const shape = (bytes: number) => ({
      sessionKey: KEY,
      text: "here",
      idempotencyKey: "x".repeat(36),
      queueMode: "followup" as const,
      files: [{ fileName: "a.bin", mimeType: "application/octet-stream", bytes }],
    });
    const at = sendFrameBytes(shape(3_000));
    expect(sendRefusal(shape(3_000), { ...LIMITS, payloadBytes: at })).toBeNull();
    expect(sendRefusal(shape(3_000), { ...LIMITS, payloadBytes: at - 1 })).toEqual({
      kind: "frame",
      bytes: at,
      limit: at - 1,
    });
    // A file exactly at its ceiling goes, one byte past it does not.
    expect(sendRefusal(shape(5), { ...LIMITS, fileBytes: 5 })).toBeNull();
    expect(sendRefusal(shape(6), { ...LIMITS, fileBytes: 5 })).toMatchObject({ kind: "file" });
  });

  it("F-074: the engine refuses more than 20 files at its own entry, whatever the caller", async () => {
    const { client, gateway, transcript } = await openTask();
    const many = Array.from({ length: 21 }, (_, n) => ({
      type: "file",
      mimeType: "text/plain",
      fileName: `${n}.txt`,
      content: base64(3),
    }));
    expect(() =>
      client.sendMessage(KEY, "all of these", { ...asShown(client), attachments: many }),
    ).toThrow(SendTooLargeError);
    expect(gateway.calls("chat.send")).toEqual([]);
    expect(transcript().outbox).toEqual([]);
    client.stop();
  });

  it("F-285: a message waiting for the connection is checked again against the policy the gateway gives on reconnecting", async () => {
    const gateway = grantingGateway();
    let fileBytes = 1_000_000;
    gateway.connectReply = (params) => {
      const hello = helloOk((params as ConnectParams).scopes, "device-token");
      return {
        ok: true,
        payload: { ...hello, policy: { ...hello.policy, attachments: { maxBytes: fileBytes } } },
      };
    };
    const { client, transcript } = await openTask({ gateway });
    gateway.refuseConnections = true;
    gateway.dropAll();
    await until(() => client.state.connection.status !== "connected");
    client.sendMessage(KEY, "the report", {
      ...asShown(client),
      attachments: [
        { type: "file", mimeType: "application/pdf", fileName: "r.pdf", content: base64(600_000) },
      ],
    });
    // The gateway comes back with a smaller ceiling than the file.
    fileBytes = 500_000;
    gateway.refuseConnections = false;
    await until(() => client.state.connection.sendLimits?.fileBytes === 500_000);
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(transcript().outbox[0]!.error).toMatch(/up to 500000 bytes/);
    expect(gateway.calls("chat.send")).toEqual([]);
    client.stop();
  });

  it("F-285: a file removed from the draft frees the room the host held for it, so a valid file fits again", async () => {
    const { client } = await openTask();
    let ids = 0;
    const store = new AttachmentStore({ newId: () => `file-${(ids += 1)}` });
    const viewer = createBridgeSession(client, { attachments: store });
    const add = (bytes: number) =>
      store.add({ fileName: "big.bin", mimeType: "application/octet-stream" }, bytes, () =>
        base64(bytes),
      );
    const big = 18 * 1024 * 1024;
    const first = add(big);
    // The host's 32 MiB is mostly taken: a second large file does not fit.
    expect(() => add(big)).toThrow(/waiting to be sent/);
    await viewer.apply({ type: "releaseAttachments", attachmentIds: [first.id] });
    expect(store.available()).toBeGreaterThanOrEqual(MAX_PENDING_ATTACHMENT_BYTES - 1);
    expect(add(big)).toMatchObject({ sizeBytes: big });
    viewer.dispose();
    client.stop();
  });
});
