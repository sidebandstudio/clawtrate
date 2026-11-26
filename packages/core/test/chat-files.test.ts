// A file a bot attaches that isn't a picture (F-115). When a bot's answer ends
// with `MEDIA:` lines, the gateway stages each file and its history gives the
// row an `attachment` block per document, an `audio` or `video` block per
// recording, or an `attachment_error` block for a file it couldn't hand over.
// The live events carry none of them. The rows below are as a development
// gateway recorded them (OpenClaw 2026.10.6, the `#attach` scenario), with the
// ids kept.

import { describe, expect, it } from "vitest";
import { toBase64 } from "../src/bytes.ts";
import { utf8Length } from "../src/encoding.ts";
import { isTooLargeToSave, MAX_CHAT_FILE_BYTES } from "../src/chat-files.ts";
import { ClawtrateClient, CONNECTION_CHANGED, FILE_FROM_ANOTHER_GATEWAY } from "../src/client.ts";
import { parseBridgeCommand } from "../src/bridge.ts";
import type { HttpFetch, HttpResponseLike } from "../src/host.ts";
import {
  cleanFileName,
  mapHistory,
  MAX_FILE_NAME_BYTES,
  taskWithFilePreview,
} from "../src/mapping.ts";
import { READ_SCOPES } from "../src/scopes.ts";
import { enforceState } from "../src/state-bounds.ts";
import type { Task, Transcript } from "../src/types.ts";
import { FAST, grantingGateway, KEY, URL_A } from "./client-harness.ts";
import { deferred, memoryStorage, testHost, tokenKey, until } from "./fake-gateway.ts";

const PDF = "artifact_managed_media_470797d5-f45d-444a-901d-21a6bd2c2f96";
const NOTES = "artifact_managed_media_dcdee85c-5f62-4293-9cc5-68c53084eba3";
const outgoing = (artifactId: string) =>
  `/api/chat/media/outgoing/${encodeURIComponent(KEY)}/${artifactId.slice(-36)}/full`;
const attachment = (artifactId: string, label: string, mimeType: string, sizeBytes: number) => ({
  type: "attachment",
  attachment: {
    artifactId,
    url: outgoing(artifactId),
    kind: "document",
    label,
    mimeType,
    sizeBytes,
  },
});
const ROW = "d2659f35-1bb5-4140-bdd5-53d9ea49d1da";
const TEXT = "Both reviews are in this two-page draft.";

/** The person's ask, the bot's write, and its answer with `content` as the gateway gives it. */
function run(content: unknown[], ask = "#attach") {
  const meta = (id: string, seq: number) => ({ runId: "probe-attach", id, seq });
  return [
    { role: "user", content: ask, __openclaw: { id: "u1", seq: 1 } },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_351abac4c7bdd8be",
          name: "write",
          arguments: { path: "reports/reviews-draft.pdf", content: "%PDF-1.4\n" },
        },
      ],
      model: "dev-1",
      __openclaw: meta("6ccca801-364d-4203-991b-a4c93fcf9346", 2),
    },
    {
      role: "toolResult",
      toolCallId: "call_351abac4c7bdd8be",
      toolName: "write",
      content: [{ type: "text", text: "Successfully wrote 861 bytes" }],
      isError: false,
      __openclaw: meta("4b3c1a2e-0000-4000-8000-000000000003", 3),
    },
    {
      role: "assistant",
      content,
      model: "dev-1",
      stopReason: "stop",
      __openclaw: meta(ROW, 4),
    },
  ];
}

const ATTACHED = [
  { type: "text", text: TEXT },
  attachment(PDF, "reviews-draft.pdf", "application/pdf", 861),
  attachment(NOTES, "reviews.txt", "text/plain", 55),
];

describe("F-115: a file a bot attaches, in history", () => {
  it("F-115: each attachment block is a file of the message that carried it, in its order, with the gateway's name, type and size, and its address is never kept", () => {
    const turn = mapHistory(run(ATTACHED)).at(-1)!;
    expect(turn.files).toEqual([
      {
        artifactId: PDF,
        name: "reviews-draft.pdf",
        mimeType: "application/pdf",
        sizeBytes: 861,
        messageId: ROW,
      },
      {
        artifactId: NOTES,
        name: "reviews.txt",
        mimeType: "text/plain",
        sizeBytes: 55,
        messageId: ROW,
      },
    ]);
    expect(turn.pictures).toBeUndefined();
    const said = turn.blocks.find((block) => block.kind === "text");
    expect(said?.kind === "text" && said.text).toBe(TEXT);
    expect(JSON.stringify(turn.files)).not.toContain("/api/chat/media");
  });

  it("F-115: audio, video, another block that names an artifact and an attachment of another kind are files too; a picture is not", () => {
    const files = mapHistory(
      run([
        { type: "text", text: TEXT },
        {
          type: "audio",
          artifactId: "artifact_managed_media_918577ee-2ad0-4853-a314-7e97363a6b6d",
          url: "/x",
          openUrl: "/x",
          fileName: "tone.wav",
          mimeType: "audio/wav",
          playback: "native",
          sizeBytes: 44,
        },
        {
          type: "video",
          artifactId: "artifact_managed_media_v",
          fileName: "clip.mp4",
          mimeType: "video/mp4",
          sizeBytes: 9_000,
        },
        { type: "file", artifactId: "artifact_other", title: "plan.key", sizeBytes: 12 },
        // A known kind without an id is still a row, with nothing to read; an unknown one isn't.
        { type: "audio", fileName: "memo.m4a", mimeType: "audio/mp4" },
        { type: "file", title: "no-id.key" },
        {
          type: "attachment",
          attachment: { artifactId: "artifact_k", kind: "sheet", label: "costs.xlsx" },
        },
        {
          type: "image",
          artifactId: "artifact_managed_image_1",
          alt: "sun.png",
          mimeType: "image/png",
        },
      ]),
    ).at(-1)!.files!;
    expect(files.find((file) => file.name === "memo.m4a")?.artifactId).toBeNull();
    expect(files.map((file) => [file.name, file.mimeType, file.sizeBytes])).toEqual([
      ["tone.wav", "audio/wav", 44],
      ["clip.mp4", "video/mp4", 9_000],
      ["plan.key", null, 12],
      ["memo.m4a", "audio/mp4", null],
      ["costs.xlsx", null, null],
    ]);
  });

  it("F-115: a file the gateway couldn't hand over keeps its row, with nothing to read", () => {
    const files = mapHistory(
      run([
        { type: "text", text: "Bin." },
        {
          type: "attachment_error",
          attachment: {
            code: "delivery-failed",
            kind: "document",
            label: "blob.bin",
            mimeType: "application/octet-stream",
          },
        },
      ]),
    ).at(-1)!.files;
    expect(files).toEqual([
      {
        artifactId: null,
        name: "blob.bin",
        mimeType: "application/octet-stream",
        sizeBytes: null,
        messageId: ROW,
      },
    ]);
  });

  it("F-115: a message that is only a file is a turn with that file", () => {
    const items = mapHistory(run([attachment(NOTES, "reviews.txt", "text/plain", 55)]));
    const turn = items.at(-1)!;
    expect(turn.role).toBe("assistant");
    expect(turn.files?.map((file) => file.name)).toEqual(["reviews.txt"]);
    expect(turn.blocks.some((block) => block.kind === "text")).toBe(false);
  });

  it("F-115: missing or malformed fields still give the file, from what it has", () => {
    const files = mapHistory(
      run([
        { type: "attachment" },
        { type: "attachment", attachment: "nonsense" },
        {
          type: "attachment",
          attachment: {
            artifactId: 42,
            label: ["x"],
            mimeType: "not a type",
            sizeBytes: -3,
          },
        },
        {
          type: "attachment",
          attachment: {
            artifactId: PDF,
            label: "draft.pdf",
            mimeType: "APPLICATION/PDF",
            sizeBytes: 1.5,
          },
        },
        { type: "attachment_error" },
      ]),
    ).at(-1)!.files!;
    expect(
      files.map((file) => [file.artifactId, file.name, file.mimeType, file.sizeBytes]),
    ).toEqual([
      [null, "File", null, null],
      [null, "File", null, null],
      [null, "File", null, null],
      [PDF, "draft.pdf", "application/pdf", null],
      [null, "File", null, null],
    ]);
  });

  it("F-115: the same file twice in one turn shows once, where it first came", () => {
    const files = mapHistory(
      run([...ATTACHED, attachment(PDF, "reviews-draft.pdf", "application/pdf", 861)]),
    ).at(-1)!.files!;
    expect(files.map((file) => file.artifactId)).toEqual([PDF, NOTES]);
  });

  it("F-115: the files a turn keeps are bounded, per turn and across the history page", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      attachment(`artifact_managed_media_${i}`, `file-${i}.txt`, "text/plain", i),
    );
    const items = mapHistory(run(many));
    const transcript = { items } as unknown as Transcript;
    const kept = enforceState({ transcripts: { [KEY]: transcript } } as never) as unknown as {
      transcripts: Record<string, Transcript>;
    };
    expect(kept.transcripts[KEY]!.items.at(-1)!.files).toHaveLength(20);
  });
});

describe("F-115: a file a bot attaches, live", () => {
  it("F-115: the live events name no file; the row's files come when the gateway says the message changed and history is read again", async () => {
    const gateway = grantingGateway();
    let history: unknown[] = run([{ type: "text", text: "Earlier." }]).slice(0, 1);
    gateway.handlers["chat.history"] = () => ({ messages: history });
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: JSON.stringify({
        token: "device-token",
        grantedScopes: READ_SCOPES,
        heldScopes: READ_SCOPES,
      }),
    });
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await until(() => client.state.discovery.status === "ready");
    client.openSession(KEY);
    await until(() => client.state.transcripts[KEY]?.status === "ready");
    // As the gateway sent them: the final row's message and the run's end carry only the text.
    gateway.emit("session.message", {
      sessionKey: KEY,
      messageId: ROW,
      message: {
        role: "assistant",
        content: [{ type: "text", text: TEXT }],
        __openclaw: { runId: "probe-attach", id: ROW, seq: 4 },
      },
    });
    // At the run's end the row holds only its text: the history read then shows no file.
    history = run([{ type: "text", text: TEXT }]);
    const reads = gateway.calls("chat.history").length;
    gateway.emit("chat", {
      runId: "probe-attach",
      sessionKey: KEY,
      seq: 24,
      state: "final",
      stopReason: "stop",
      message: {
        role: "assistant",
        content: [{ type: "text", text: TEXT }],
        openclawDisplayContent: [],
      },
    });
    await until(() => gateway.calls("chat.history").length > reads);
    await until(() =>
      client.state.transcripts[KEY]!.items.some((item) =>
        item.blocks.some((block) => block.kind === "text" && block.text === TEXT),
      ),
    );
    expect(client.state.transcripts[KEY]!.items.some((item) => item.files)).toBe(false);
    // Just after, the gateway writes the files into the row and says the message changed.
    history = run(ATTACHED);
    gateway.emit("sessions.changed", { sessionKey: KEY, phase: "message" });
    await until(() => client.state.transcripts[KEY]!.items.some((item) => item.files?.length));
    const turn = client.state.transcripts[KEY]!.items.find((item) => item.files)!;
    expect(turn.files!.map((file) => file.name)).toEqual(["reviews-draft.pdf", "reviews.txt"]);
    client.stop();
  });
});

describe("F-115: the name shown and offered for saving", () => {
  it("F-115: keeps only the last path part, takes out control, format and separator characters and lone surrogates, and is never empty", () => {
    expect(cleanFileName("../../etc/passwd")).toBe("passwd");
    expect(cleanFileName("C:\\Users\\someone\\report.pdf")).toBe("report.pdf");
    expect(cleanFileName("a\u0007b\u0000c.txt")).toBe("abc.txt");
    expect(cleanFileName("invoice\u202Efdp.exe")).toBe("invoicefdp.exe");
    expect(cleanFileName("re\u200Bport.pdf")).toBe("report.pdf");
    expect(cleanFileName("a\u2060.pdf")).toBe("a.pdf");
    expect(cleanFileName("a\u00ADb.pdf")).toBe("ab.pdf");
    expect(cleanFileName("a\u{E0041}.pdf")).toBe("a.pdf");
    expect(cleanFileName("a\u2028b.pdf")).toBe("ab.pdf");
    expect(cleanFileName("a\u2029b.pdf")).toBe("ab.pdf");
    expect(cleanFileName("a\uD800b.pdf")).toBe("ab.pdf");
    expect(cleanFileName("\uFEFFnotes.txt")).toBe("notes.txt");
    expect(cleanFileName("  ..  ")).toBe("File");
    expect(cleanFileName("")).toBe("File");
    expect(cleanFileName(null)).toBe("File");
    expect(cleanFileName("folder/")).toBe("File");
  });

  it(`F-115: a long name is cut to ${MAX_FILE_NAME_BYTES} UTF-8 bytes between characters, with its extension kept`, () => {
    const bytes = utf8Length;
    const cut = cleanFileName(`${"a".repeat(400)}.pdf`);
    expect(cut.endsWith("….pdf")).toBe(true);
    expect(bytes(cut)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES);
    expect(bytes(cut)).toBeGreaterThan(MAX_FILE_NAME_BYTES - 4);
    const exact = `${"b".repeat(MAX_FILE_NAME_BYTES - 4)}.txt`;
    expect(cleanFileName(exact)).toBe(exact);
    // Emoji are four bytes each: never cut inside one, never over the limit.
    const emoji = cleanFileName(`${"\u{1F4C4}".repeat(300)}.pdf`);
    expect(bytes(emoji)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES);
    expect(emoji).toMatch(/^(?:\u{1F4C4})+….pdf$/u);
    expect(emoji.length).toBeLessThanOrEqual(255);
    // Fewer than 255 characters, more than 255 bytes: still cut.
    const short = cleanFileName(`${"\u{1F4C4}".repeat(100)}.pdf`);
    expect(bytes(short)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES);
    expect(short.endsWith("….pdf")).toBe(true);
  });
});

describe("F-115: the preview of a task whose last message is only a file", () => {
  const task = (preview: string | null) => ({ key: KEY, preview }) as unknown as Task;
  const transcript = (content: unknown[]) =>
    ({ items: mapHistory(run(content, "Send the route")) }) as unknown as Transcript;
  const only = transcript([attachment(NOTES, "route.csv", "text/csv", 1_204)]);

  it("F-115: reads as the file's name in place of the person's message the gateway lists, or of none", () => {
    expect(taskWithFilePreview(task("Send the route"), only).preview).toBe("route.csv");
    expect(taskWithFilePreview(task(null), only).preview).toBe("route.csv");
  });

  it("F-115: a file-only message after the bot's text in the same run still names its file, in place of that text", () => {
    const merged = {
      items: mapHistory([
        ...run([{ type: "text", text: "I'll prepare it." }], "Send the route"),
        {
          role: "assistant",
          content: [attachment(NOTES, "route.csv", "text/csv", 1_204)],
          model: "dev-1",
          __openclaw: { runId: "probe-attach", id: "row-last", seq: 5 },
        },
      ]),
    } as unknown as Transcript;
    expect(merged.items.filter((item) => item.role === "assistant")).toHaveLength(1);
    expect(taskWithFilePreview(task("I'll prepare it."), merged).preview).toBe("route.csv");
    expect(taskWithFilePreview(task("Send the route"), merged).preview).toBe("Send the route");
  });

  it("F-115: the last file-only message's files are named even when one was shown earlier in the run", () => {
    const row = (id: string, seq: number, file: unknown) => ({
      role: "assistant",
      content: [file],
      model: "dev-1",
      __openclaw: { runId: "probe-attach", id, seq },
    });
    const x = attachment(PDF, "x.pdf", "application/pdf", 861);
    const y = attachment(NOTES, "y.txt", "text/plain", 55);
    const repeated = {
      items: mapHistory([
        ...run([{ type: "text", text: "Here they come." }], "Send both"),
        row("row-a", 5, x),
        row("row-b", 6, y),
        row("row-c", 7, x),
      ]),
    } as unknown as Transcript;
    // The turn lists each file once; its last message carried x.pdf again.
    expect(repeated.items.at(-1)!.files!.map((file) => file.name)).toEqual(["x.pdf", "y.txt"]);
    expect(taskWithFilePreview(task("Here they come."), repeated).preview).toBe("x.pdf");
  });

  it("F-115: any other preview, a message with text, or no loaded history keeps the gateway's", () => {
    expect(taskWithFilePreview(task("Something newer"), only).preview).toBe("Something newer");
    expect(taskWithFilePreview(task("Send the route"), transcript(ATTACHED)).preview).toBe(
      "Send the route",
    );
    expect(taskWithFilePreview(task("Send the route"), undefined).preview).toBe("Send the route");
    // A text message after the file-only one in the same run: the preview is the bot's text.
    const later = {
      items: mapHistory([
        ...run([attachment(NOTES, "route.csv", "text/csv", 1_204)], "Send the route"),
        {
          role: "assistant",
          content: [{ type: "text", text: "Done, it's attached." }],
          model: "dev-1",
          __openclaw: { runId: "probe-attach", id: "row-later", seq: 5 },
        },
      ]),
    } as unknown as Transcript;
    expect(taskWithFilePreview(task("Done, it's attached."), later).preview).toBe(
      "Done, it's attached.",
    );
  });
});

describe("F-115: a file a bot attaches, read", () => {
  const BYTES = Uint8Array.from("%PDF-1.4\nthe two reviews\n%%EOF\n", (char) => char.charCodeAt(0));
  const ISSUED = `${outgoing(PDF)}?mediaTicket=v1.eyJzY29wZSI6Im1hbmFnZWQifQ.wvFYVx-PH9Ic0Rq3n8dJt2LmWbYk5sAeUoCiGzXhT1v`;

  function response(status: number, headers: Record<string, string>, body: Uint8Array) {
    let done = false;
    const reply: HttpResponseLike = {
      status,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      body: {
        getReader: () => ({
          read: async () => (done ? { done: true } : ((done = true), { done: false, value: body })),
          cancel: async () => {},
        }),
        cancel: async () => {},
      },
    };
    return reply;
  }

  async function open(
    fetch: HttpFetch,
    download: () => unknown = () => ({
      url: ISSUED,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    }),
  ) {
    const gateway = grantingGateway();
    gateway.handlers["chat.history"] = () => ({ messages: run(ATTACHED) });
    gateway.handlers["artifacts.download"] = download;
    gateway.handlers["gateway.identity.get"] = () => ({ deviceId: "gateway-a" });
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: JSON.stringify({
        token: "device-token",
        grantedScopes: READ_SCOPES,
        heldScopes: READ_SCOPES,
      }),
    });
    const client = new ClawtrateClient({ ...testHost(gateway, storage), fetch }, FAST);
    await client.start();
    await until(() => client.state.discovery.status === "ready");
    client.openSession(KEY);
    await until(() => client.state.transcripts[KEY]?.status === "ready");
    return { client, gateway };
  }

  it("F-115: on a read-only connection the file is read through the download the gateway issues for its id, whatever its type, and nothing the message names", async () => {
    const fetched: string[] = [];
    const { client, gateway } = await open(async (url) => {
      fetched.push(url);
      return response(200, { "content-type": "Application/PDF; charset=binary" }, BYTES);
    });
    expect(gateway.calls("artifacts.download")).toEqual([]);
    const read = await client.readChatFile(KEY, PDF);
    expect(read).toEqual({
      status: "content",
      mimeType: "application/pdf",
      bytes: BYTES.length,
      transfer: { id: null, chunks: 1, data: toBase64(BYTES) },
    });
    expect(gateway.calls("artifacts.download")).toEqual([{ sessionKey: KEY, artifactId: PDF }]);
    expect(fetched).toEqual([`http://${new URL(URL_A).host}${ISSUED}`]);
    client.stop();
  });

  it("F-115: a download in OpenClaw 2026.11.10's form, a grant on the connection, is read the same way, its ticket's encoded slash sent as issued", async () => {
    const newer = `${outgoing(PDF)}?mediaTicket=6f1c2a9e-3b7d-4e58-a0c4-9d2e81f7b630%2FQm9vay1yZXZpZXdzLWdyYW50LXRva2VuLWZvci10ZXM`;
    const fetched: string[] = [];
    const { client } = await open(
      async (url) => {
        fetched.push(url);
        return response(200, { "content-type": "application/pdf" }, BYTES);
      },
      () => ({ url: newer, expiresAt: new Date(Date.now() + 300_000).toISOString() }),
    );
    expect(await client.readChatFile(KEY, PDF)).toMatchObject({
      status: "content",
      bytes: BYTES.length,
    });
    expect(fetched).toEqual([`http://${new URL(URL_A).host}${newer}`]);
    client.stop();
  });

  it(`F-115: a file over ${MAX_CHAT_FILE_BYTES} bytes, by the size the gateway gave or the bytes it sent, is too large; a refused read says why`, async () => {
    expect(isTooLargeToSave(MAX_CHAT_FILE_BYTES)).toBe(false);
    expect(isTooLargeToSave(MAX_CHAT_FILE_BYTES + 1)).toBe(true);
    expect(isTooLargeToSave(null)).toBe(false);
    const declared = await open(async () =>
      response(200, { "content-length": String(MAX_CHAT_FILE_BYTES + 1) }, BYTES),
    );
    expect(await declared.client.readChatFile(KEY, PDF)).toEqual({
      status: "too-large",
      limit: MAX_CHAT_FILE_BYTES,
    });
    declared.client.stop();
    const sent = await open(async () => response(200, {}, new Uint8Array(MAX_CHAT_FILE_BYTES + 1)));
    expect(await sent.client.readChatFile(KEY, PDF)).toEqual({
      status: "too-large",
      limit: MAX_CHAT_FILE_BYTES,
    });
    sent.client.stop();
    const gone = await open(
      async () => response(200, {}, BYTES),
      () => {
        throw new Error("artifact not found");
      },
    );
    expect(await gone.client.readChatFile(KEY, PDF)).toEqual({
      status: "failed",
      message: expect.stringMatching(/^The gateway didn't give this file: .*artifact not found$/),
    });
    gone.client.stop();
    const unissued = await open(
      async () => response(200, {}, BYTES),
      () => ({ url: outgoing(PDF), expiresAt: new Date(Date.now() + 300_000).toISOString() }),
    );
    expect(await unissued.client.readChatFile(KEY, PDF)).toEqual({
      status: "failed",
      message: "The gateway didn't give a download for this file.",
    });
    unissued.client.stop();
    const refused = await open(async () => response(401, {}, BYTES));
    expect(await refused.client.readChatFile(KEY, PDF)).toEqual({
      status: "failed",
      message: "The gateway refused this file's download ticket.",
    });
    refused.client.stop();
  });

  it("F-115: the bridge takes a file read only with a task key, an id and the stamp of the gateway that drew it", () => {
    const stamp = { gatewayId: "gateway-a", target: 3 };
    expect(parseBridgeCommand({ type: "readChatFile", key: KEY, artifactId: PDF, stamp })).toEqual({
      type: "readChatFile",
      key: KEY,
      artifactId: PDF,
      stamp,
    });
    expect(() => parseBridgeCommand({ type: "readChatFile", key: KEY, stamp })).toThrow();
    expect(() => parseBridgeCommand({ type: "readChatFile", key: KEY, artifactId: PDF })).toThrow();
  });

  it("F-115: a viewer that leaves while the read waits for the gateway's identity asks nothing", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { client, gateway } = await open(async () => {
      await held;
      return response(200, {}, BYTES);
    });
    // Four reads hold the file reads' places, so the viewer's read waits for one.
    const busy = Array.from({ length: 4 }, () => client.readChatFile(KEY, PDF));
    await until(() => gateway.calls("artifacts.download").length === 4);
    const viewer = {};
    const stamp = { gatewayId: "gateway-a", target: client.state.connection.target };
    const reading = client.readChatFile(KEY, PDF, { owner: viewer }, stamp);
    // Meanwhile the identity the client knew is forgotten: the next check asks again, and waits.
    const identity = deferred<unknown>();
    gateway.handlers["gateway.identity.get"] = () => identity.promise;
    (client as unknown as { gatewayIdentity: unknown }).gatewayIdentity = null;
    const asked = gateway.calls("gateway.identity.get").length;
    // The places free up; the viewer's read takes one and waits on the identity, then the viewer goes.
    release();
    await Promise.allSettled(busy);
    await until(() => gateway.calls("gateway.identity.get").length > asked);
    client.withdraw(viewer);
    identity.resolve({ deviceId: "gateway-a" });
    await expect(reading).rejects.toThrow();
    expect(gateway.calls("artifacts.download")).toHaveLength(4);
    client.stop();
  });

  it("F-115: a file read that a reconnect crosses is refused and its transfer let go; on the same socket it reads", async () => {
    let release: () => void = () => {};
    let held = new Promise<void>((resolve) => (release = resolve));
    const { client, gateway } = await open(async () => {
      await held;
      return response(200, {}, BYTES);
    });
    const transfers = (client as unknown as { fileTransfers: { size: number } }).fileTransfers;
    const crossing = client.readChatFile(KEY, PDF, { maxChars: 1 });
    await until(() => gateway.calls("artifacts.download").length === 1);
    gateway.dropAll();
    await until(() => client.state.connection.status === "connected");
    release();
    expect(await crossing).toEqual({
      status: "failed",
      message: "The connection changed while this file was read.",
    });
    expect(transfers.size).toBe(0);
    // The same read on one socket from start to end gives the file.
    held = Promise.resolve();
    expect(await client.readChatFile(KEY, PDF)).toMatchObject({
      status: "content",
      bytes: BYTES.length,
    });
    client.stop();
  });

  it("F-115: a file read that waited for a place checks its gateway again before asking", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { client, gateway } = await open(async () => {
      await held;
      return response(200, {}, BYTES);
    });
    // Four reads hold the file reads' places, so the stamped one waits.
    const busy = Array.from({ length: 4 }, () => client.readChatFile(KEY, PDF));
    const stamp = { gatewayId: "gateway-a", target: client.state.connection.target };
    const waiting = client.readChatFile(KEY, PDF, {}, stamp);
    await until(() => gateway.calls("artifacts.download").length === 4);
    // The host moves to another target while it waits, on the same connection.
    (client as unknown as { target: number }).target += 1;
    release();
    await Promise.all(busy);
    expect(await waiting).toEqual({ status: "failed", message: CONNECTION_CHANGED });
    expect(gateway.calls("artifacts.download")).toHaveLength(4);
    client.stop();
  });

  it("F-115: a file is read only while the host still has the gateway whose history drew its row", async () => {
    const { client, gateway } = await open(async () => response(200, {}, BYTES));
    const target = client.state.connection.target;
    expect(await client.readChatFile(KEY, PDF, {}, { gatewayId: "gateway-b", target })).toEqual({
      status: "failed",
      message: FILE_FROM_ANOTHER_GATEWAY,
    });
    expect(
      await client.readChatFile(KEY, PDF, {}, { gatewayId: "gateway-a", target: target - 1 }),
    ).toEqual({ status: "failed", message: CONNECTION_CHANGED });
    expect(gateway.calls("artifacts.download")).toEqual([]);
    expect(
      await client.readChatFile(KEY, PDF, {}, { gatewayId: "gateway-a", target }),
    ).toMatchObject({ status: "content", bytes: BYTES.length });
    expect(gateway.calls("artifacts.download")).toHaveLength(1);
    client.stop();
  });
});
