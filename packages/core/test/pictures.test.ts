// A picture a bot made, in the conversation (F-519): what history gives it, how
// its bytes are read, and what is never fetched. The rows and the download's
// answer are as a development gateway with the stand-in image provider
// recorded them (OpenClaw 2026.10.6).

import { describe, expect, it } from "vitest";
import { toBase64 } from "../src/bytes.ts";
import { ClawtrateClient } from "../src/client.ts";
import { FileTransfers } from "../src/files.ts";
import type { HttpFetch, HttpResponseLike } from "../src/host.ts";
import { mapHistory } from "../src/mapping.ts";
import { MAX_PICTURE_BYTES, readChatPicture, type ChatPictureContext } from "../src/pictures.ts";
import { INTERACTIVE_SCOPES } from "../src/scopes.ts";
import { FAST, grantingGateway, KEY, URL_A } from "./client-harness.ts";
import { memoryStorage, testHost, tokenKey, until } from "./fake-gateway.ts";

const TASK = "tool:image_generate:9b21401e-321f-48bb-a101-c2db7c0d78e9";
const ARTIFACT = "artifact_managed_image_2de197ca-510c-4299-bd7a-ded7fe92de0c";
const PROMPT = "A sun over a green hill, in flat solid colours";
const ISSUED = `/api/chat/media/outgoing/${encodeURIComponent(KEY)}/2de197ca-510c-4299-bd7a-ded7fe92de0c/full?mediaTicket=v1.eyJzY29wZSI6Im1hbmFnZWQifQ.wvFYVx-PH9Ic`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const ascii = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));
const NOW = Date.parse("2026-11-23T00:40:00.000Z");
const LATER = "2026-11-23T00:45:22.834Z";

const imageBlock = {
  type: "image",
  artifactId: ARTIFACT,
  url: `/api/chat/media/outgoing/${encodeURIComponent(KEY)}/2de197ca/full`,
  openUrl: `/api/chat/media/outgoing/${encodeURIComponent(KEY)}/2de197ca/full`,
  alt: "image-1.png",
  mimeType: "image/png",
  width: 256,
  height: 256,
  sizeBytes: 887,
};

/** The task's history: the call that starts the picture, then the gateway's turn that delivers it. */
const rows = (image: Record<string, unknown> = imageBlock) => [
  { role: "user", content: "#image", __openclaw: { id: "u1", seq: 1 } },
  {
    role: "assistant",
    content: [
      { type: "toolCall", id: "call_1", name: "image_generate", arguments: { prompt: PROMPT } },
    ],
    __openclaw: { id: "a1", seq: 2, runId: "run-1" },
  },
  {
    role: "toolResult",
    toolCallId: "call_1",
    content: [{ type: "text", text: `Background task started for image generation (${TASK}).` }],
    __openclaw: { id: "t1", seq: 3, runId: "run-1" },
  },
  {
    role: "assistant",
    content: [{ type: "text", text: "Here is the picture you asked for." }, image],
    __openclaw: { id: "a2", seq: 6, runId: `image_generate:${TASK}:ok:agent-loop` },
  },
];

function response(
  status: number,
  headers: Record<string, string>,
  chunks: Uint8Array[],
): HttpResponseLike & { cancelled: () => boolean } {
  let cancelled = false;
  let at = 0;
  return {
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    body: {
      getReader: () => ({
        read: async () =>
          at < chunks.length ? { done: false, value: chunks[at++]! } : { done: true },
        cancel: async () => {
          cancelled = true;
        },
      }),
      cancel: async () => {
        cancelled = true;
      },
    },
    cancelled: () => cancelled,
  };
}

function context(answer: unknown, reply: () => HttpResponseLike) {
  const fetched: Array<{ url: string; init: Parameters<HttpFetch>[1] }> = [];
  const asked: Array<{ method: string; params: unknown }> = [];
  const ctx: ChatPictureContext = {
    request: async (method, params) => {
      asked.push({ method, params });
      return answer;
    },
    fetch: async (url, init) => {
      fetched.push({ url, init });
      return reply();
    },
    gatewayUrl: "ws://127.0.0.1:19540",
    transfers: new FileTransfers(() => NOW),
    owner: {},
    now: () => NOW,
  };
  return { ctx, fetched, asked };
}

const png = () => response(200, { "content-type": "image/png" }, [PNG.slice(0, 5), PNG.slice(5)]);

describe("F-519: a picture in history", () => {
  it("F-519: the gateway's image block is the turn's picture, with the description of the call whose task it completes, and no address", () => {
    const items = mapHistory(rows());
    const turn = items.at(-1)!;
    expect(turn.pictures).toEqual([
      {
        artifactId: ARTIFACT,
        alt: "image-1.png",
        prompt: PROMPT,
        mimeType: "image/png",
        width: 256,
        height: 256,
        sizeBytes: 887,
      },
    ]);
    expect(JSON.stringify(items)).not.toContain("/api/chat/media");
    // The turn that asked for it holds the call and no picture.
    expect(items[1]!.pictures).toBeUndefined();
  });

  it("F-519: a turn whose message is only the picture still shows it", () => {
    const only = rows();
    only[3]!.content = [imageBlock];
    expect(
      mapHistory(only)
        .at(-1)!
        .pictures?.map((each) => each.artifactId),
    ).toEqual([ARTIFACT]);
  });

  it("F-519: an image block the gateway holds no artifact for is not a picture, and a turn of another run names no description", () => {
    const { artifactId: _, ...bare } = imageBlock;
    expect(mapHistory(rows(bare)).at(-1)!.pictures).toBeUndefined();
    const other = rows();
    other[3]!.__openclaw = { id: "a2", seq: 6, runId: "run-2" };
    expect(mapHistory(other).at(-1)!.pictures![0]!.prompt).toBeNull();
  });
});

describe("F-519: reading a picture", () => {
  it("F-519: only the download the gateway issued for this task is fetched, from its origin, without cookies or redirects, and its bytes reach the viewer whole", async () => {
    const { ctx, fetched, asked } = context({ url: ISSUED, expiresAt: LATER }, png);
    const read = await readChatPicture(ctx, KEY, ARTIFACT);
    expect(asked).toEqual([
      { method: "artifacts.download", params: { sessionKey: KEY, artifactId: ARTIFACT } },
    ]);
    expect(fetched.map((each) => each.url)).toEqual([`http://127.0.0.1:19540${ISSUED}`]);
    expect(fetched[0]!.init).toMatchObject({
      method: "GET",
      redirect: "error",
      credentials: "omit",
    });
    expect(read).toEqual({
      status: "content",
      kind: "image",
      mimeType: "image/png",
      bytes: PNG.length,
      transfer: { id: null, chunks: 1, data: toBase64(PNG) },
    });
  });

  it("F-519: an address the message names, another task's download, a ticket out of form, an expired or missing expiry, and another origin are never fetched", async () => {
    const other = ISSUED.replace(encodeURIComponent(KEY), encodeURIComponent("agent:main:other"));
    for (const answer of [
      { url: imageBlock.url, expiresAt: LATER },
      { url: other, expiresAt: LATER },
      { url: ISSUED.replace("mediaTicket=v1.", "mediaTicket=v2."), expiresAt: LATER },
      { url: `${ISSUED}&next=/elsewhere`, expiresAt: LATER },
      { url: `https://pictures.example${ISSUED}`, expiresAt: LATER },
      { url: ISSUED, expiresAt: "2026-11-23T00:39:59.000Z" },
      { url: ISSUED },
      null,
    ]) {
      const { ctx, fetched } = context(answer, png);
      expect(await readChatPicture(ctx, KEY, ARTIFACT)).toEqual({
        status: "failed",
        message: "The gateway didn't give a download for this picture.",
      });
      expect(fetched).toEqual([]);
    }
  });

  it("F-519: a type other than a picture's, bytes that don't start as their type's, and a picture over Clawtrate's limit are refused", async () => {
    const answer = { url: ISSUED, expiresAt: LATER };
    const svg = context(answer, () =>
      response(200, { "content-type": "image/svg+xml" }, [ascii("<svg/>")]),
    );
    expect(await readChatPicture(svg.ctx, KEY, ARTIFACT)).toMatchObject({ status: "failed" });
    const html = context(answer, () =>
      response(200, { "content-type": "image/png" }, [ascii("<html>")]),
    );
    expect(await readChatPicture(html.ctx, KEY, ARTIFACT)).toEqual({
      status: "failed",
      message: "The gateway sent something that isn't a picture this app shows.",
    });
    const declared = response(
      200,
      { "content-type": "image/png", "content-length": String(MAX_PICTURE_BYTES + 1) },
      [PNG],
    );
    const big = context(answer, () => declared);
    expect(await readChatPicture(big.ctx, KEY, ARTIFACT)).toEqual({
      status: "failed",
      message: "This picture is larger than Clawtrate shows: pictures up to 5 MB.",
    });
    expect(declared.cancelled()).toBe(true);
    // A body that runs past the limit without saying so is cut off as it arrives.
    const streamed = response(200, { "content-type": "image/png" }, [
      PNG,
      new Uint8Array(MAX_PICTURE_BYTES),
    ]);
    const long = context(answer, () => streamed);
    expect(await readChatPicture(long.ctx, KEY, ARTIFACT)).toMatchObject({ status: "failed" });
    expect(streamed.cancelled()).toBe(true);
    const refused = context(answer, () => response(401, {}, []));
    expect(await readChatPicture(refused.ctx, KEY, ARTIFACT)).toEqual({
      status: "failed",
      message: "The gateway refused this picture's download ticket.",
    });
  });

  it("F-519: JPEG, GIF and WebP are shown when their bytes start as their type's, and not otherwise", async () => {
    const answer = { url: ISSUED, expiresAt: LATER };
    const cases: Array<[string, number[], boolean]> = [
      ["image/jpeg", [0xff, 0xd8, 0xff, 0xe0], true],
      ["image/gif", [...ascii("GIF87a")], true],
      ["image/gif", [...ascii("GIF89a")], true],
      ["image/webp", [...ascii("RIFF"), 1, 2, 3, 4, ...ascii("WEBP")], true],
      ["image/webp", [...ascii("RIFF"), 1, 2, 3, 4, ...ascii("WAVE")], false],
      ["image/jpeg", [...PNG], false],
    ];
    for (const [type, bytes, shown] of cases) {
      const { ctx } = context(answer, () =>
        response(200, { "content-type": type }, [new Uint8Array(bytes)]),
      );
      expect((await readChatPicture(ctx, KEY, ARTIFACT)).status, type).toBe(
        shown ? "content" : "failed",
      );
    }
  });

  it("F-519: a refused redirect and an unreachable gateway each say so in a fixed sentence that names no address", async () => {
    const answer = { url: ISSUED, expiresAt: LATER };
    const redirect = context(answer, () => {
      throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
    });
    expect(await readChatPicture(redirect.ctx, KEY, ARTIFACT)).toEqual({
      status: "failed",
      message: "The gateway sent this picture somewhere else, and Clawtrate doesn't follow that.",
    });
    const down = context(answer, () => {
      throw new TypeError(`Failed to parse URL from http://127.0.0.1:19540${ISSUED}`);
    });
    expect(await readChatPicture(down.ctx, KEY, ARTIFACT)).toEqual({
      status: "failed",
      message: "The gateway couldn't be reached for this picture.",
    });
  });

  it("F-519: a host that can't fetch fetches nothing, and says so", async () => {
    const { ctx, asked } = context({ url: ISSUED, expiresAt: LATER }, png);
    expect(await readChatPicture({ ...ctx, fetch: null }, KEY, ARTIFACT)).toEqual({
      status: "failed",
      message: "This device can't load pictures from the gateway.",
    });
    expect(asked).toEqual([]);
  });
});

describe("F-519: the client", () => {
  async function open(fetch: HttpFetch) {
    const gateway = grantingGateway();
    let history = rows().slice(0, 3);
    gateway.handlers["chat.history"] = () => ({ messages: history });
    gateway.handlers["artifacts.download"] = () => ({
      url: ISSUED,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: JSON.stringify({
        token: "device-token",
        grantedScopes: INTERACTIVE_SCOPES,
        heldScopes: INTERACTIVE_SCOPES,
      }),
    });
    const client = new ClawtrateClient({ ...testHost(gateway, storage), fetch }, FAST);
    await client.start();
    await until(() => client.state.discovery.status === "ready");
    client.openSession(KEY);
    await until(() => client.state.transcripts[KEY]?.status === "ready");
    return { client, gateway, setHistory: (next: unknown[]) => (history = next as never) };
  }

  it("F-519: a message the gateway changes in place is read again, so the picture it adds after the turn shows", async () => {
    const { client, gateway, setHistory } = await open(async () => png());
    expect(client.state.transcripts[KEY]!.items.some((item) => item.pictures)).toBe(false);
    setHistory(rows());
    gateway.emit("sessions.changed", { sessionKey: KEY, phase: "message", updatedAt: 2 });
    await until(() => client.state.transcripts[KEY]!.items.some((item) => item.pictures));
    client.stop();
  });

  it("F-519: more pictures than the file reads' places wait their turn and all show", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { client } = await open(async () => {
      await held;
      return png();
    });
    const reads = Array.from({ length: 6 }, () => client.readChatPicture(KEY, ARTIFACT));
    setTimeout(release, 50);
    expect((await Promise.all(reads)).map((read) => read.status)).toEqual(Array(6).fill("content"));
    client.stop();
  });

  it("F-519: the picture is read through the host's fetch at the gateway's origin", async () => {
    const urls: string[] = [];
    const { client } = await open(async (url) => {
      urls.push(url);
      return png();
    });
    const read = await client.readChatPicture(KEY, ARTIFACT);
    expect(read).toMatchObject({ status: "content", bytes: PNG.length });
    expect(urls).toEqual([`${URL_A.replace("ws:", "http:")}${ISSUED}`]);
    client.stop();
  });
});
