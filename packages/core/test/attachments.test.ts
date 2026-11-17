// Attachment limits: 6 MiB per image, 20 MiB per file, checked before a file is
// kept; the 25 MiB frame checked before a message reaches the socket
// (capability map row 19, attachments). Parity rows F-074 and F-285.

import { describe, expect, it } from "vitest";
import {
  AttachmentStore,
  AttachmentTooLargeError,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
} from "../src/attachments.ts";
import { createBridgeSession } from "../src/bridge.ts";
import { ClawtrateClient, SendTooLargeError } from "../src/client.ts";
import { INTERACTIVE_SCOPES } from "../src/scopes.ts";
import { FakeGateway, helloOk, memoryStorage, testHost, tokenKey, until } from "./fake-gateway.ts";

let counter = 0;
const store = (options: { maxTotalBytes?: number; now?: () => number } = {}) =>
  new AttachmentStore({ newId: () => `a-${(counter += 1)}`, ...options });
const b64 = (bytes: number) => "A".repeat(Math.ceil(bytes / 3) * 4);

describe("attachment store (F-074, F-285)", () => {
  it("refuses an image over 6 MiB and a file over 20 MiB before keeping or encoding it", () => {
    const files = store();
    let encoded = 0;
    const encode = () => {
      encoded += 1;
      return "";
    };
    expect(() =>
      files.add({ fileName: "big.png", mimeType: "image/png" }, MAX_IMAGE_BYTES + 1, encode),
    ).toThrow(AttachmentTooLargeError);
    expect(() =>
      files.add({ fileName: "big.zip", mimeType: "application/zip" }, MAX_FILE_BYTES + 1, encode),
    ).toThrow(AttachmentTooLargeError);
    expect(encoded).toBe(0);
    expect(
      files.add({ fileName: "ok.png", mimeType: "image/png" }, MAX_IMAGE_BYTES, encode),
    ).toMatchObject({
      fileName: "ok.png",
      sizeBytes: MAX_IMAGE_BYTES,
    });
    expect(encoded).toBe(1);
  });

  it("rejects malformed names and types, and bounds what waits in memory", () => {
    const files = store({ maxTotalBytes: 100 });
    expect(() => files.check({ fileName: "../etc/passwd", mimeType: "text/plain" }, 1)).toThrow(
      "invalid file name",
    );
    expect(() => files.check({ fileName: "a.txt", mimeType: "text" }, 1)).toThrow(
      "invalid file type",
    );
    files.add({ fileName: "a.txt", mimeType: "text/plain" }, 80, () => b64(80));
    expect(() => files.check({ fileName: "b.txt", mimeType: "text/plain" }, 30)).toThrow(/waiting/);
  });

  it("hands files to one message, then forgets them; expired ones are gone", () => {
    let now = 0;
    const files = store({ now: () => now });
    const info = files.add({ fileName: "a.png", mimeType: "image/png" }, 3, () => "AAAA");
    expect(files.get([info.id])).toEqual([
      { type: "image", mimeType: "image/png", fileName: "a.png", content: "AAAA" },
    ]);
    files.release([info.id]);
    expect(() => files.get([info.id])).toThrow(/no longer available/);
    const later = files.add({ fileName: "b.txt", mimeType: "text/plain" }, 3, () => "AAAA");
    now = 16 * 60_000;
    expect(() => files.get([later.id])).toThrow(/no longer available/);
  });
});

const URL_A = "ws://127.0.0.1:19001";
const KEY = "agent:otto:disk-space";

async function openTask() {
  const gateway = new FakeGateway();
  gateway.connectReply = (params) => ({
    ok: true,
    payload: helloOk((params as { scopes: string[] }).scopes, "device-token"),
  });
  gateway.handlers["chat.send"] = () => ({ runId: "run-1", status: "started" });
  gateway.handlers["question.list"] = () => ({ questions: [] });
  for (const method of ["exec.approval.list", "plugin.approval.list", "openclaw.approval.list"]) {
    gateway.handlers[method] = () => [];
  }
  const storage = memoryStorage({
    connection: JSON.stringify({ url: URL_A, token: null }),
    [tokenKey(URL_A)]: JSON.stringify({ token: "device-token", heldScopes: INTERACTIVE_SCOPES }),
  });
  const client = new ClawtrateClient(testHost(gateway, storage), {
    reconnect: { initialMs: 20, maxMs: 40 },
  });
  await client.start();
  await until(() => client.state.connection.status === "connected");
  return { client, gateway };
}

describe("files through the bridge into chat.send (F-074, F-285)", () => {
  it("sends the files a viewer added, by id, and refuses a frame over 25 MiB before the socket", async () => {
    const { client, gateway } = await openTask();
    const files = store();
    const viewer = createBridgeSession(client, { attachments: files });
    await viewer.apply({ type: "openSession", key: KEY });
    await until(() => client.state.transcripts[KEY]?.status === "ready");

    const small = files.add({ fileName: "note.txt", mimeType: "text/plain" }, 3, () => "aGk=");
    await viewer.apply({
      type: "sendMessage",
      key: KEY,
      text: "see file",
      mode: "auto",
      attachmentIds: [small.id],
    });
    await until(() => gateway.calls("chat.send").length === 1);
    expect(gateway.calls("chat.send")[0]).toMatchObject({
      attachments: [
        { type: "file", mimeType: "text/plain", fileName: "note.txt", content: "aGk=" },
      ],
    });
    expect(client.state.transcripts[KEY]!.outbox[0]!.attachments).toEqual([
      { fileName: "note.txt", mimeType: "text/plain", sizeBytes: 2 },
    ]);
    expect(() => files.get([small.id])).toThrow();

    // Each file is under 20 MiB, but base64 of both together cannot fit one 25 MiB frame.
    const a = files.add(
      { fileName: "a.bin", mimeType: "application/octet-stream" },
      10_000_000,
      () => b64(10_000_000),
    );
    const b = files.add(
      { fileName: "b.bin", mimeType: "application/octet-stream" },
      10_000_000,
      () => b64(10_000_000),
    );
    await expect(
      viewer.apply({
        type: "sendMessage",
        key: KEY,
        text: "",
        mode: "auto",
        attachmentIds: [a.id, b.id],
      }),
    ).rejects.toThrow(SendTooLargeError);
    expect(gateway.calls("chat.send")).toHaveLength(1);
    // Refused files stay available, to send fewer of them.
    expect(files.get([a.id])).toHaveLength(1);
    client.stop();
  });

  it("refuses file ids on a host without a store", async () => {
    const { client } = await openTask();
    const viewer = createBridgeSession(client, {});
    await viewer.apply({ type: "openSession", key: KEY });
    await expect(
      viewer.apply({
        type: "sendMessage",
        key: KEY,
        text: "x",
        mode: "auto",
        attachmentIds: ["a-1"],
      }),
    ).rejects.toThrow(/does not take files/);
    client.stop();
  });
});
