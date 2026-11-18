// What a bot hands over, in the engine (work-pane.md, Part 2, sections 11 to
// 14): one card per occurrence from the one untyped query, where each item's
// content is, reading it only from the gateway's own addresses within
// Clawtrate's limit, previews as section 11 says, and that nothing is fetched
// from anywhere before the person acts. Test names carry the parity rows.

import { describe, expect, it } from "vitest";
import {
  INLINE_PREVIEW_BYTES,
  listArtifacts,
  MAX_ARTIFACT_BYTES,
  MAX_PREVIEW_BYTES,
  placeOf,
  previewLink,
  readArtifact,
  readArtifactRecord,
  readPage,
  thumbnailAddress,
  type ArtifactContext,
} from "../src/artifacts.ts";
import { parseBridgeCommand } from "../src/bridge.ts";
import { fromBase64, sha256Hex, toBase64, utf8Bytes } from "../src/bytes.ts";
import { ClawtrateClient } from "../src/client.ts";
import { FileTransfers } from "../src/files.ts";
import type { HttpFetch } from "../src/host.ts";
import { mapHistory } from "../src/mapping.ts";
import { INTERACTIVE_SCOPES } from "../src/scopes.ts";
import { FAST, grantingGateway, KEY, URL_A } from "./client-harness.ts";
import { memoryStorage, testHost, tokenKey, until } from "./fake-gateway.ts";

const GATEWAY = "ws://127.0.0.1:19980";
const ORIGIN = "http://127.0.0.1:19980";
const SESSION = "agent:main:dashboard:one";

const managed = (n: number, kind: "image" | "media") =>
  `artifact_managed_${kind}_0000000${n}-0000-4000-8000-000000000000`;
const ticketPath = (n: number) =>
  `/api/chat/media/outgoing/${encodeURIComponent(SESSION)}/0000000${n}-0000-4000-8000-000000000000/full?mediaTicket=v1.payload.signature`;

type Record = {
  id: string;
  type: string;
  title?: string;
  mimeType?: string;
  sizeBytes?: number;
  messageSeq?: number;
  runId?: string;
  download: { mode: string };
};

const picture = (bytes: number) => {
  const out = new Uint8Array(bytes);
  out.set([137, 80, 78, 71, 13, 10, 26, 10]);
  for (let i = 8; i < bytes; i += 1) out[i] = (i * 7) % 251;
  return out;
};

/** A response as `HttpFetch` gives it: a status, headers and a body read in one piece. */
function reply(body: Uint8Array | string, init: { status?: number; type?: string } = {}) {
  const data = typeof body === "string" ? utf8Bytes(body) : body;
  let read = false;
  const stream = {
    getReader: () => ({
      read: async () => {
        if (read) return { done: true };
        read = true;
        return { done: false, value: data };
      },
      cancel: async () => {},
    }),
    cancel: async () => {},
  };
  return {
    status: init.status ?? 200,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? (init.type ?? "application/octet-stream") : null,
    },
    body: stream,
  };
}

/** A refusal as the pinned gateway client raises it: the message, and the gateway's details. */
const refusal = (message: string, details: { type: string; artifactId?: string | undefined }) =>
  Object.assign(new Error(message), { details });

/** A gateway that answers the artifact methods from a table, and a fetch that records every call. */
function world(options: {
  records: Record[];
  downloads?: { [id: string]: unknown };
  bodies?: { [path: string]: { status?: number; type?: string; body: Uint8Array } };
}) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const fetched: Array<{ url: string; init: unknown }> = [];
  const request = async (method: string, params: unknown) => {
    calls.push({ method, params });
    const p = params as { artifactId?: string; transport?: string; docId?: string };
    if (method === "artifacts.list") return { artifacts: options.records };
    if (method === "artifacts.get") {
      const found = options.records.find((record) => record.id === p.artifactId);
      if (!found)
        throw refusal("artifact not found", {
          type: "artifact_not_found",
          artifactId: p.artifactId,
        });
      return { artifact: found };
    }
    if (method === "artifacts.download") {
      const answer = options.downloads?.[`${p.artifactId}:${p.transport ?? "inline"}`];
      if (answer instanceof Error) throw answer;
      if (answer === undefined) throw new Error(`no download for ${p.artifactId}`);
      return answer;
    }
    if (method === "canvas.document.view") return { html: "<h1>Trail guide</h1>", sandboxPort: 1 };
    throw new Error(`unexpected ${method}`);
  };
  const fetch: HttpFetch = async (url, init) => {
    fetched.push({ url, init });
    const path = url.slice(ORIGIN.length);
    const found = options.bodies?.[path];
    if (!found) return reply("not found", { status: 404 });
    return reply(found.body, {
      status: found.status ?? 200,
      ...(found.type ? { type: found.type } : {}),
    });
  };
  const transfers = new FileTransfers(() => 0);
  const ctx: ArtifactContext = {
    request,
    fetch,
    gatewayUrl: GATEWAY,
    transfers,
    owner: {},
    now: () => 1_000,
  };
  return { ctx, calls, fetched };
}

describe("listing what a bot handed over", () => {
  it("F-115: one untyped query for the bot's own items; one card per occurrence, positions per message", async () => {
    const { ctx, calls } = world({
      records: [
        {
          id: managed(1, "media"),
          type: "file",
          title: "trail-report.md",
          mimeType: "text/markdown",
          sizeBytes: 149,
          messageSeq: 4,
          download: { mode: "url" },
        },
        {
          id: managed(2, "image"),
          type: "image",
          title: "ridge-profile.png",
          sizeBytes: 1202,
          messageSeq: 4,
          download: { mode: "url" },
        },
        // The same managed id sent again in a later message: another card with the same id.
        {
          id: managed(2, "image"),
          type: "image",
          title: "ridge-profile.png",
          sizeBytes: 1202,
          messageSeq: 9,
          download: { mode: "url" },
        },
        { id: "artifact_x", type: "widget", messageSeq: 9, download: { mode: "bytes" } },
      ],
    });
    const list = await listArtifacts(ctx, SESSION);
    expect(calls[0]).toEqual({
      method: "artifacts.list",
      params: { sessionKey: SESSION, messageRole: "assistant" },
    });
    expect(list.artifacts.map((each) => each.key)).toEqual([
      `4:0:${managed(1, "media")}`,
      `4:1:${managed(2, "image")}`,
      `9:0:${managed(2, "image")}`,
    ]);
    // A record of no known kind is counted, never drawn.
    expect(list.omitted).toBe(1);
    // A managed id says the item is the gateway's own: no address is asked for.
    expect(calls.filter((call) => call.method === "artifacts.download")).toEqual([]);
    expect(list.artifacts.every((each) => each.place.kind === "gateway")).toBe(true);
  });

  it("F-307: an item at another address is known as elsewhere from the address the gateway gives, which is not fetched", async () => {
    const { ctx, fetched } = world({
      records: [
        {
          id: "artifact_faq",
          type: "file",
          title: "lending-faq.pdf",
          mimeType: "application/pdf",
          messageSeq: 2,
          download: { mode: "url" },
        },
        {
          id: "artifact_none",
          type: "file",
          title: "card.pkpass",
          messageSeq: 2,
          download: { mode: "unsupported" },
        },
      ],
      downloads: {
        "artifact_faq:inline": {
          artifact: {},
          url: "https://help.library.example/lending-faq.pdf",
        },
      },
    });
    const list = await listArtifacts(ctx, SESSION);
    expect(list.artifacts[0]!.place).toEqual({
      kind: "elsewhere",
      host: "help.library.example",
      url: "https://help.library.example/lending-faq.pdf",
    });
    expect(list.artifacts[1]!.place).toEqual({ kind: "none" });
    expect(fetched).toEqual([]);
  });

  it("F-115: what fits the viewer's channel is carried, the rest counted", async () => {
    const records = Array.from({ length: 30 }, (_, i) => ({
      id: managed(i % 10, "media"),
      type: "file",
      title: `note-${i}.md`,
      messageSeq: i + 1,
      download: { mode: "url" },
    }));
    const { ctx } = world({ records });
    const list = await listArtifacts({ ...ctx, maxChars: 6_000 }, SESSION);
    expect(list.artifacts.length).toBeGreaterThan(0);
    expect(list.artifacts.length + list.omitted).toBe(30);
    expect(JSON.stringify(list).length).toBeLessThan(6_000);
  });
});

describe("reading an item", () => {
  it("F-118: a managed item's bytes come from the gateway's own address, without cookies or redirects, byte for byte", async () => {
    const bytes = utf8Bytes("# Trail report\n");
    const { ctx, calls, fetched } = world({
      records: [
        {
          id: managed(1, "media"),
          type: "file",
          title: "trail-report.md",
          mimeType: "text/markdown",
          sizeBytes: bytes.length,
          messageSeq: 4,
          download: { mode: "url" },
        },
      ],
      downloads: { [`${managed(1, "media")}:http`]: { artifact: {}, url: ticketPath(1) } },
      bodies: { [ticketPath(1)]: { type: "text/markdown", body: bytes } },
    });
    const read = await readArtifact(ctx, SESSION, managed(1, "media"), "full");
    expect(read).toMatchObject({
      status: "content",
      kind: "text",
      mimeType: "text/markdown",
      bytes: bytes.length,
      hash: sha256Hex(bytes),
      thumbnail: false,
    });
    if (read.status !== "content") throw new Error("no content");
    expect(fromBase64(read.transfer.data)).toEqual(bytes);
    expect(calls.map((call) => call.method)).toEqual(["artifacts.get", "artifacts.download"]);
    expect(calls[1]!.params).toEqual({
      sessionKey: SESSION,
      artifactId: managed(1, "media"),
      transport: "http",
    });
    expect(fetched).toEqual([
      {
        url: `${ORIGIN}${ticketPath(1)}`,
        init: expect.objectContaining({ method: "GET", redirect: "error", credentials: "omit" }),
      },
    ]);
  });

  it("F-118: bytes in the transcript come inline, and over the connection's address when the gateway asks for it", async () => {
    const small = utf8Bytes("hello");
    const big = picture(4_000);
    const inline = world({
      records: [
        {
          id: "artifact_a",
          type: "file",
          title: "a.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
          download: { mode: "bytes" },
        },
      ],
      downloads: {
        "artifact_a:inline": { artifact: {}, encoding: "base64", data: toBase64(small) },
      },
    });
    const first = await readArtifact(inline.ctx, SESSION, "artifact_a", "full");
    expect(first).toMatchObject({ status: "content", bytes: 5 });
    expect(inline.fetched).toEqual([]);

    const path = "/api/artifacts/download/conn-1/ticket-1";
    const viaHttp = world({
      records: [
        {
          id: "artifact_b",
          type: "image",
          title: "b.png",
          mimeType: "image/png",
          sizeBytes: big.length,
          download: { mode: "bytes" },
        },
      ],
      downloads: {
        "artifact_b:inline": refusal(
          'artifact is too large for inline transfer; request transport: "http"',
          { type: "artifact_download_unsupported", artifactId: "artifact_b" },
        ),
        "artifact_b:http": { artifact: {}, url: path, expiresAt: "later" },
      },
      bodies: { [path]: { type: "image/png", body: big } },
    });
    const second = await readArtifact(viaHttp.ctx, SESSION, "artifact_b", "full");
    expect(second).toMatchObject({
      status: "content",
      kind: "image",
      bytes: big.length,
      hash: sha256Hex(big),
    });
    expect(viaHttp.fetched.map((each) => each.url)).toEqual([`${ORIGIN}${path}`]);
  });

  it("F-307: an item elsewhere is never fetched; one with no content is said to have none; a lost copy is gone", async () => {
    const { ctx, fetched, calls } = world({
      records: [
        { id: "artifact_faq", type: "file", title: "lending-faq.pdf", download: { mode: "url" } },
        {
          id: "artifact_none",
          type: "image",
          title: "cover.jpg",
          download: { mode: "unsupported" },
        },
        { id: managed(3, "media"), type: "file", title: "old-route.md", download: { mode: "url" } },
      ],
      downloads: {
        "artifact_faq:http": { artifact: {}, url: "https://help.library.example/lending-faq.pdf" },
        [`${managed(3, "media")}:http`]: refusal("artifact not found", {
          type: "artifact_not_found",
        }),
      },
    });
    expect(await readArtifact(ctx, SESSION, "artifact_faq", "full")).toEqual({
      status: "elsewhere",
      host: "help.library.example",
      url: "https://help.library.example/lending-faq.pdf",
    });
    expect(await readArtifact(ctx, SESSION, "artifact_none", "full")).toEqual({
      status: "unsupported",
    });
    expect(await readArtifact(ctx, SESSION, managed(3, "media"), "full")).toMatchObject({
      status: "gone",
    });
    expect(await readArtifact(ctx, SESSION, "artifact_missing", "full")).toMatchObject({
      status: "gone",
    });
    expect(fetched).toEqual([]);
    // Unsupported content is not even asked for.
    expect(
      calls.filter(
        (call) =>
          call.method === "artifacts.download" &&
          (call.params as { artifactId: string }).artifactId === "artifact_none",
      ),
    ).toEqual([]);
  });

  it("F-307: a failed fetch says why, and a missing copy at the address is gone", async () => {
    const { ctx } = world({
      records: [
        { id: managed(1, "media"), type: "file", title: "a.md", download: { mode: "url" } },
        { id: managed(2, "media"), type: "file", title: "b.md", download: { mode: "url" } },
      ],
      downloads: {
        [`${managed(1, "media")}:http`]: { artifact: {}, url: ticketPath(1) },
        [`${managed(2, "media")}:http`]: { artifact: {}, url: ticketPath(2) },
      },
      bodies: { [ticketPath(2)]: { status: 500, body: new Uint8Array(0) } },
    });
    expect(await readArtifact(ctx, SESSION, managed(1, "media"), "full")).toMatchObject({
      status: "gone",
    });
    expect(await readArtifact(ctx, SESSION, managed(2, "media"), "full")).toEqual({
      status: "failed",
      message: "The gateway answered 500.",
    });
  });

  it("F-118: nothing over Clawtrate's limit is fetched, and a body that grows past it is dropped", async () => {
    const { ctx, fetched } = world({
      records: [
        {
          id: managed(1, "media"),
          type: "video",
          title: "walk.mp4",
          sizeBytes: MAX_ARTIFACT_BYTES + 1,
          download: { mode: "url" },
        },
        { id: managed(2, "media"), type: "audio", title: "note.wav", download: { mode: "url" } },
      ],
      downloads: { [`${managed(2, "media")}:http`]: { artifact: {}, url: ticketPath(2) } },
      bodies: {
        [ticketPath(2)]: { type: "audio/wav", body: new Uint8Array(MAX_ARTIFACT_BYTES + 10) },
      },
    });
    expect(await readArtifact(ctx, SESSION, managed(1, "media"), "full")).toEqual({
      status: "too-large",
      size: MAX_ARTIFACT_BYTES + 1,
      limit: MAX_ARTIFACT_BYTES,
    });
    expect(fetched).toEqual([]);
    expect(await readArtifact(ctx, SESSION, managed(2, "media"), "full")).toMatchObject({
      status: "too-large",
    });
    expect(ctx.transfers.size).toBe(0);
  });

  it("F-117: a card draws a small picture from its own bytes, and a large one from the gateway's thumbnail, up to 2 MB", async () => {
    const small = picture(INLINE_PREVIEW_BYTES);
    const thumb = picture(900);
    const { ctx, fetched } = world({
      records: [
        {
          id: managed(1, "image"),
          type: "image",
          title: "small.png",
          sizeBytes: small.length,
          download: { mode: "url" },
        },
        {
          id: managed(2, "image"),
          type: "image",
          title: "large.png",
          sizeBytes: INLINE_PREVIEW_BYTES + 1,
          download: { mode: "url" },
        },
        {
          id: managed(3, "image"),
          type: "image",
          title: "huge.png",
          sizeBytes: 3_000_000,
          download: { mode: "url" },
        },
        { id: managed(4, "media"), type: "file", title: "a.md", download: { mode: "url" } },
      ],
      downloads: {
        [`${managed(1, "image")}:http`]: { artifact: {}, url: ticketPath(1) },
        [`${managed(2, "image")}:http`]: { artifact: {}, url: ticketPath(2) },
        [`${managed(3, "image")}:http`]: { artifact: {}, url: ticketPath(3) },
      },
      bodies: {
        [ticketPath(1)]: { type: "image/png", body: small },
        [ticketPath(2).replace("/full?", "/thumbnail?")]: { type: "image/png", body: thumb },
        // The gateway's thumbnail can be larger than the picture: over 2 MB, it is no preview.
        [ticketPath(3).replace("/full?", "/thumbnail?")]: {
          type: "image/png",
          body: picture(MAX_PREVIEW_BYTES + 1),
        },
      },
    });
    expect(await readArtifact(ctx, SESSION, managed(1, "image"), "preview")).toMatchObject({
      status: "content",
      bytes: small.length,
      thumbnail: false,
    });
    expect(await readArtifact(ctx, SESSION, managed(2, "image"), "preview")).toMatchObject({
      status: "content",
      bytes: thumb.length,
      thumbnail: true,
    });
    expect(await readArtifact(ctx, SESSION, managed(3, "image"), "preview")).toMatchObject({
      status: "no-preview",
    });
    expect(await readArtifact(ctx, SESSION, managed(4, "media"), "preview")).toMatchObject({
      status: "no-preview",
    });
    expect(
      fetched.map((each) => each.url.slice(ORIGIN.length).split("?")[0]!.split("/").at(-1)),
    ).toEqual(["full", "thumbnail", "thumbnail"]);
  });

  it("F-117: a preview that comes back as anything but a picture is no preview", async () => {
    const { ctx } = world({
      records: [
        {
          id: managed(1, "image"),
          type: "image",
          title: "x.png",
          sizeBytes: 500_000,
          download: { mode: "url" },
        },
      ],
      downloads: { [`${managed(1, "image")}:http`]: { artifact: {}, url: ticketPath(1) } },
      bodies: {
        [ticketPath(1).replace("/full?", "/thumbnail?")]: {
          type: "text/html",
          body: utf8Bytes("<p>no</p>"),
        },
      },
    });
    expect(await readArtifact(ctx, SESSION, managed(1, "image"), "preview")).toMatchObject({
      status: "no-preview",
    });
  });

  it("F-117: the thumbnail addresses the gateway serves", () => {
    expect(thumbnailAddress(`${ORIGIN}${ticketPath(1)}`)).toBe(
      `${ORIGIN}${ticketPath(1).replace("/full?", "/thumbnail?")}`,
    );
    expect(thumbnailAddress(`${ORIGIN}/api/artifacts/download/c/t`)).toBe(
      `${ORIGIN}/api/artifacts/download/c/t?variant=thumbnail`,
    );
    expect(thumbnailAddress("https://elsewhere.example/x.png")).toBeNull();
  });

  it("F-307: only the gateway's own origin is ever an address on the gateway", () => {
    expect(placeOf("/api/chat/media/outgoing/a/b/full", GATEWAY)).toEqual({
      kind: "gateway",
      url: `${ORIGIN}/api/chat/media/outgoing/a/b/full`,
    });
    expect(placeOf(`${ORIGIN}/api/x`, GATEWAY)).toEqual({
      kind: "gateway",
      url: `${ORIGIN}/api/x`,
    });
    expect(placeOf("//evil.example/api/x", GATEWAY)).toBeNull();
    expect(placeOf("http://127.0.0.1:2/api/x", GATEWAY)).toMatchObject({ kind: "elsewhere" });
    expect(placeOf("javascript:alert(1)", GATEWAY)).toBeNull();
    expect(placeOf("/elsewhere/x", GATEWAY)).toBeNull();
    expect(placeOf("/api/x", "wss://gateway.example")).toEqual({
      kind: "gateway",
      url: "https://gateway.example/api/x",
    });
  });

  it("F-115: Raw is the record artifacts.get returns, and a page is read by its id", async () => {
    const { ctx } = world({
      records: [
        { id: managed(1, "media"), type: "file", title: "a.md", download: { mode: "url" } },
      ],
    });
    const raw = await readArtifactRecord(ctx, SESSION, managed(1, "media"));
    expect(raw).toMatchObject({ status: "ok", cut: false });
    if (raw.status === "ok") expect(JSON.parse(raw.text).artifact.title).toBe("a.md");
    const page = await readPage(ctx, "trail-guide");
    expect(page).toMatchObject({ status: "content", bytes: 20 });
  });
});

describe("nothing remote loads by itself", () => {
  const remoteHistory = [
    { role: "user", content: "show me", __openclaw: { seq: 1 } },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "![map](https://tracker.example/pixel.png) and https://library.example/ebooks",
        },
        { type: "image", url: "https://images.example/cover.jpg", alt: "cover.jpg" },
        { type: "audio", url: "https://sounds.example/note.mp3", fileName: "note.mp3" },
        {
          type: "canvas",
          preview: {
            kind: "canvas",
            viewId: "trail-guide",
            title: "Trail guide",
            url: "/__openclaw__/canvas/documents/trail-guide/index.html",
          },
        },
        {
          type: "attachment_error",
          attachment: { code: "delivery-failed", kind: "document", label: "elevation-log.csv" },
        },
      ],
      __openclaw: { seq: 2, runId: "run-1" },
    },
  ];

  it("F-116 F-117: a transcript with remote media, opened, listed and drawn, makes no request until the person acts", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.history"] = () => ({ messages: remoteHistory, hasMore: false });
    gateway.handlers["artifacts.list"] = () => ({
      artifacts: [
        {
          id: "artifact_cover",
          type: "image",
          title: "cover.jpg",
          messageSeq: 2,
          download: { mode: "url" },
        },
        {
          id: "artifact_note",
          type: "audio",
          title: "note.mp3",
          messageSeq: 2,
          download: { mode: "url" },
        },
      ],
    });
    gateway.handlers["artifacts.get"] = (params) => ({
      artifact: {
        id: (params as { artifactId: string }).artifactId,
        type: "image",
        title: "cover.jpg",
        download: { mode: "url" },
      },
    });
    gateway.handlers["artifacts.download"] = (params) => ({
      artifact: {},
      url:
        (params as { artifactId: string }).artifactId === "artifact_cover"
          ? "https://images.example/cover.jpg"
          : "https://sounds.example/note.mp3",
    });
    const fetched: string[] = [];
    const previewed: string[] = [];
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: JSON.stringify({
        token: "device-token",
        grantedScopes: INTERACTIVE_SCOPES,
        heldScopes: INTERACTIVE_SCOPES,
      }),
    });
    const client = new ClawtrateClient(
      {
        ...testHost(gateway, storage),
        fetch: async (url) => {
          fetched.push(url);
          return reply("no");
        },
        linkPreview: async (url) => {
          previewed.push(url);
          return { status: "none", url };
        },
      },
      FAST,
    );
    await client.start();
    await until(() => client.state.discovery.status === "ready");
    client.openSession(KEY);
    await until(() => client.state.transcripts[KEY]?.status === "ready");
    const item = client.state.transcripts[KEY]!.items.find((each) => each.role === "assistant")!;
    expect(item.seq).toBe(2);
    expect(item.blocks.filter((block) => block.kind === "page")).toEqual([
      { kind: "page", docId: "trail-guide", title: "Trail guide" },
    ]);
    const list = await client.listArtifacts(KEY);
    expect(list.artifacts.map((each) => each.place.kind)).toEqual(["elsewhere", "elsewhere"]);
    // Even opening an item elsewhere fetches nothing: it is handed to the browser on the person's choice.
    expect(await client.readArtifact(KEY, "artifact_cover", "full")).toMatchObject({
      status: "elsewhere",
      host: "images.example",
    });
    expect(await client.readArtifact(KEY, "artifact_cover", "preview")).toMatchObject({
      status: "elsewhere",
    });
    expect(fetched).toEqual([]);
    expect(previewed).toEqual([]);
    // The person hovers the link: only then is its preview asked for, once.
    await client.previewLink("https://library.example/ebooks");
    expect(previewed).toEqual(["https://library.example/ebooks"]);
    expect(fetched).toEqual([]);
    // A page this task does not name is not read for it.
    expect(await client.readPage(KEY, "another-page")).toMatchObject({ status: "failed" });
    client.stop();
  });

  it("F-115: the gateway's attachment errors and pages are kept as blocks, with the item's sequence number", () => {
    const [, item] = mapHistory(remoteHistory);
    expect(item!.seq).toBe(2);
    expect(item!.blocks.map((block) => block.kind)).toEqual(["text", "page", "attachment-error"]);
    expect(item!.blocks[2]).toEqual({
      kind: "attachment-error",
      label: "elevation-log.csv",
      code: "delivery-failed",
      media: "document",
    });
  });

  it("F-116: a link is previewed only for http and https, without credentials, through the host", async () => {
    const asked: string[] = [];
    const previewer = async (url: string) => {
      asked.push(url);
      return {
        status: "ok" as const,
        url,
        title: "T".repeat(1000),
        description: null,
        image: null,
      };
    };
    expect(await previewLink(previewer, "javascript:alert(1)")).toEqual({
      status: "none",
      url: "javascript:alert(1)",
    });
    expect(await previewLink(previewer, "https://user:pass@library.example/")).toMatchObject({
      status: "none",
    });
    expect(await previewLink(previewer, "file:///etc/passwd")).toMatchObject({ status: "none" });
    expect(await previewLink(null, "https://library.example/")).toMatchObject({ status: "none" });
    const ok = await previewLink(previewer, "https://library.example/");
    expect(ok).toMatchObject({ status: "ok" });
    if (ok.status === "ok") expect(ok.title!.length).toBe(300);
    expect(asked).toEqual(["https://library.example/"]);
  });

  it("F-116 F-118: the bridge takes only bounded artifact commands, and previews only of web addresses", () => {
    expect(
      parseBridgeCommand({ type: "readArtifact", key: KEY, artifactId: "a", part: "full" }),
    ).toEqual({ type: "readArtifact", key: KEY, artifactId: "a", part: "full" });
    expect(() =>
      parseBridgeCommand({ type: "readArtifact", key: KEY, artifactId: "a", part: "all" }),
    ).toThrow();
    expect(() => parseBridgeCommand({ type: "previewLink", url: "javascript:alert(1)" })).toThrow();
    expect(() =>
      parseBridgeCommand({ type: "previewLink", url: `https://a.example/${"x".repeat(3000)}` }),
    ).toThrow();
    expect(parseBridgeCommand({ type: "readPage", key: KEY, docId: "trail-guide" })).toEqual({
      type: "readPage",
      key: KEY,
      docId: "trail-guide",
    });
  });
});
