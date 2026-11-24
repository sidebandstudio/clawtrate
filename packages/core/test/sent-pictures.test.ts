// A picture a person sends shows in their own message (#451). Clawtrate doesn't
// load a person's picture from the gateway (#469), so the preview
// comes from the copy this app sent, while the task stays open; history names
// each file so another device can say what was sent.

import { describe, expect, it } from "vitest";
import { fromBase64, toBase64, utf8Bytes } from "../src/bytes.ts";
import {
  MAX_RETAINED_ATTACHMENT_BYTES,
  MAX_SENT_PICTURE_MESSAGES,
  type ClawtrateClient,
  type OutgoingAttachment,
} from "../src/client.ts";
import { mapHistory } from "../src/mapping.ts";
import { MAX_PICTURE_BYTES, type SentPictureRead } from "../src/pictures.ts";
import { KEY, openTask } from "./client-harness.ts";
import { until } from "./fake-gateway.ts";
import { FIRST, NOTES, SECOND, SHOT, sentRow, solidPng } from "./sent-attachments-rows.ts";

const RED = solidPng(48, 32, [220, 40, 40]);
const BLUE = solidPng(24, 24, [40, 80, 220]);

const picture = (
  bytes: Uint8Array,
  fileName: string,
  mimeType = "image/png",
): OutgoingAttachment => ({
  type: "image",
  mimeType,
  fileName,
  content: toBase64(bytes),
});
const textFile: OutgoingAttachment = {
  type: "file",
  mimeType: "text/plain",
  fileName: "notes.txt",
  content: toBase64(utf8Bytes("milk\neggs\n")),
};

/** A file of exactly `bytes` decoded bytes. */
function blob(bytes: number): OutgoingAttachment {
  const padding = (3 - (bytes % 3)) % 3;
  const content = "A".repeat(4 * Math.ceil(bytes / 3) - padding) + "=".repeat(padding);
  return { type: "file", mimeType: "application/octet-stream", fileName: "big.bin", content };
}

/** The bytes a read hands its viewer, every part of its transfer joined. */
function bytesOf(client: ClawtrateClient, read: SentPictureRead): Uint8Array {
  if (read.status !== "content") throw new Error(`expected a picture, got ${JSON.stringify(read)}`);
  let data = read.transfer.data;
  for (let index = 1; index < read.transfer.chunks; index += 1)
    data += client.readFileChunk(read.transfer.id!, index).data;
  return fromBase64(data)!;
}

/** A task, its history as the test sets it, and a way to have the client read history again. */
async function task() {
  let history: unknown[] = [];
  const opened = await openTask();
  opened.gateway.handlers["chat.history"] = () => ({ messages: history });
  const confirm = async (rows: unknown[]) => {
    history = rows;
    opened.gateway.emit("sessions.changed", { sessionKey: KEY, phase: "message", updatedAt: 2 });
    await until(() => opened.transcript().outbox.length === 0);
  };
  return { ...opened, confirm, history: () => history };
}

describe("F-557: what history says a person's message carried", () => {
  it("F-557: each file the gateway names is on the message, in order, by name, type and size, with the text exactly as written and no reference", () => {
    const [one, file, two] = [
      mapHistory([sentRow("m1", "can u add this to my calendar?", [SHOT])])[0]!,
      mapHistory([sentRow("m2", "here are my notes", [NOTES])])[0]!,
      mapHistory([sentRow("m3", "two pictures", [FIRST, SECOND])])[0]!,
    ];
    expect(one.blocks).toEqual([{ kind: "text", text: "can u add this to my calendar?" }]);
    expect(one.attachments).toEqual([
      { fileName: "shot.png", mimeType: "image/png", sizeBytes: 111 },
    ]);
    expect(file.attachments).toEqual([
      { fileName: "notes.txt", mimeType: "text/plain", sizeBytes: 10 },
    ]);
    expect(two.attachments!.map((each) => each.fileName)).toEqual(["first.png", "second.png"]);
    expect(two.idempotencyKey).toBe("m3:user");
    expect(JSON.stringify([one, file, two])).not.toContain("media://");
  });

  it("F-557: a message that is only a picture still shows, with no empty bubble", () => {
    const items = mapHistory([sentRow("m4", "", [SECOND])]);
    expect(items).toHaveLength(1);
    expect(items[0]!.blocks).toEqual([]);
    expect(items[0]!.attachments).toEqual([
      { fileName: "second.png", mimeType: "image/png", sizeBytes: 88 },
    ]);
  });
});

describe("F-557: a picture you sent, from this app's own copy", () => {
  it("F-557: shows at once from the copy sent, and still after history holds the message and is read again", async () => {
    const { client, gateway, confirm, history } = await task();
    const id = client.sendMessage(KEY, "can u add this to my calendar?", {
      attachments: [picture(RED, "shot.png")],
    });
    expect(bytesOf(client, await client.readSentPicture(KEY, id, 0))).toEqual(new Uint8Array(RED));

    await confirm([sentRow(id, "can u add this to my calendar?", [SHOT])]);
    const item = client.state.transcripts[KEY]!.items[0]!;
    expect(item.attachments?.[0]?.fileName).toBe("shot.png");
    expect(bytesOf(client, await client.readSentPicture(KEY, item.idempotencyKey!, 0))).toEqual(
      new Uint8Array(RED),
    );

    // A reload of the history still finds it.
    client.reloadSession(KEY);
    await until(() => gateway.calls("chat.history").length >= 3);
    await until(() => client.state.transcripts[KEY]!.status === "ready");
    expect(history()).toHaveLength(1);
    expect(bytesOf(client, await client.readSentPicture(KEY, item.idempotencyKey!, 0))).toEqual(
      new Uint8Array(RED),
    );
    // Nothing was asked of the gateway for it.
    expect(gateway.calls("artifacts.download")).toEqual([]);
    client.stop();
  });

  it("F-557: a picture kept for one task shows in no other, even under the same row key, and nothing is asked of the gateway", async () => {
    const { client, gateway, confirm } = await task();
    const id = client.sendMessage(KEY, "can u add this to my calendar?", {
      attachments: [picture(RED, "shot.png")],
    });
    const row = sentRow(id, "can u add this to my calendar?", [SHOT]);
    await confirm([row]);
    expect((await client.readSentPicture(KEY, `${id}:user`, 0)).status).toBe("content");
    // Another task whose history holds a row under the same key: as another device sees it.
    const OTHER = "agent:otto:elsewhere";
    const answer = gateway.handlers["chat.history"]!;
    gateway.handlers["chat.history"] = (params: unknown) =>
      (params as { sessionKey?: string }).sessionKey === OTHER
        ? { messages: [row] }
        : answer(params);
    client.openSession(OTHER);
    await until(() => client.state.transcripts[OTHER]?.items.length === 1);
    const asked = gateway.requests.length;
    expect(await client.readSentPicture(OTHER, `${id}:user`, 0)).toEqual({ status: "not-kept" });
    expect(gateway.requests.length).toBe(asked);
    expect(gateway.calls("artifacts.download")).toEqual([]);
    // Nor on another gateway: a Disconnect lets every kept picture go.
    await client.disconnect();
    expect(client.keptPictureBytes).toBe(0);
    client.stop();
  });

  it("F-557: two pictures keep their order, and a file that isn't a picture isn't kept", async () => {
    const { client, confirm } = await task();
    const id = client.sendMessage(KEY, "two pictures", {
      attachments: [picture(RED, "first.png"), textFile, picture(BLUE, "second.png")],
    });
    await confirm([sentRow(id, "two pictures", [FIRST, NOTES, SECOND])]);
    const key = `${id}:user`;
    expect(bytesOf(client, await client.readSentPicture(KEY, key, 0))).toEqual(new Uint8Array(RED));
    expect(await client.readSentPicture(KEY, key, 1)).toEqual({ status: "not-kept" });
    expect(bytesOf(client, await client.readSentPicture(KEY, key, 2))).toEqual(
      new Uint8Array(BLUE),
    );
    expect(client.keptPictureBytes).toBe(RED.length + BLUE.length);
    client.stop();
  });

  it("F-557: a picture over 5 MB, a type not drawn, and bytes that aren't their type's are refused and not kept, and mislabelled bytes stay a file", async () => {
    const { client, confirm } = await task();
    const large = new Uint8Array(MAX_PICTURE_BYTES + 1);
    large.set(RED.subarray(0, 8));
    const id = client.sendMessage(KEY, "these", {
      attachments: [
        picture(large, "large.png"),
        picture(utf8Bytes("<svg/>"), "drawing.svg", "image/svg+xml"),
        picture(utf8Bytes("not a png"), "fake.png"),
      ],
    });
    expect(await client.readSentPicture(KEY, id, 0)).toEqual({
      status: "failed",
      message: "This picture is larger than Clawtrate shows: pictures up to 5 MB.",
    });
    for (const index of [1, 2])
      expect(await client.readSentPicture(KEY, id, index)).toEqual({ status: "not-a-picture" });
    await confirm([sentRow(id, "these", [SHOT, SHOT, SHOT])]);
    // None is kept: bytes that aren't the picture they are named as are never drawn.
    expect(client.keptPictureBytes).toBe(0);
    expect(await client.readSentPicture(KEY, `${id}:user`, 0)).toEqual({ status: "not-kept" });
    expect(await client.readSentPicture(KEY, `${id}:user`, 1)).toEqual({ status: "not-kept" });
    // The mislabelled one is still a file on your message, not a picture said to be elsewhere.
    expect(await client.readSentPicture(KEY, `${id}:user`, 2)).toEqual({ status: "not-a-picture" });
    client.stop();
  });

  it("F-557: a viewer that left is given nothing", async () => {
    const { client } = await task();
    const id = client.sendMessage(KEY, "look", { attachments: [picture(RED, "shot.png")] });
    const viewer = {};
    client.withdraw(viewer);
    await expect(client.readSentPicture(KEY, id, 0, { owner: viewer })).rejects.toThrow();
    client.stop();
  });

  it("F-557: kept pictures go when the task closes, and give way to files still to be sent", async () => {
    const { client, gateway, confirm } = await task();
    const id = client.sendMessage(KEY, "look", { attachments: [picture(RED, "shot.png")] });
    await confirm([sentRow(id, "look", [SHOT])]);
    expect(client.keptPictureBytes).toBe(RED.length);
    // Files that need all the room but two bytes take it from the kept picture.
    gateway.handlers["chat.send"] = () => new Promise(() => {});
    const half = MAX_RETAINED_ATTACHMENT_BYTES / 2;
    client.sendMessage(KEY, "big", { attachments: [blob(half)] });
    expect(client.keptPictureBytes).toBe(RED.length);
    client.sendMessage(KEY, "bigger", { attachments: [blob(half - 2)] });
    expect(client.keptPictureBytes).toBe(0);
    expect(await client.readSentPicture(KEY, `${id}:user`, 0)).toEqual({ status: "not-kept" });
    client.stop();
  });

  it(`F-557: at most ${MAX_SENT_PICTURE_MESSAGES} messages' pictures are kept, the oldest giving way, and none once the task is closed`, async () => {
    const { client, confirm } = await task();
    const rows: unknown[] = [];
    const ids: string[] = [];
    for (let i = 0; i <= MAX_SENT_PICTURE_MESSAGES; i += 1) {
      const id = client.sendMessage(KEY, `p${i}`, { attachments: [picture(RED, "shot.png")] });
      ids.push(id);
      rows.push(sentRow(id, `p${i}`, [SHOT], i + 1));
      await confirm([...rows]);
    }
    expect(client.keptPictureBytes).toBe(MAX_SENT_PICTURE_MESSAGES * RED.length);
    expect(await client.readSentPicture(KEY, `${ids[0]}:user`, 0)).toEqual({ status: "not-kept" });
    expect((await client.readSentPicture(KEY, `${ids.at(-1)}:user`, 0)).status).toBe("content");
    client.closeSession(KEY);
    expect(client.keptPictureBytes).toBe(0);
    client.stop();
  }, 30_000);
});
