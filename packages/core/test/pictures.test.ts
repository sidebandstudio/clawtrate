// A picture a bot made, in the conversation (F-535): what history gives it, how
// its bytes are read, and what is never fetched. The rows and the download's
// answer are as a development gateway with the stand-in image provider
// recorded them (OpenClaw 2026.10.6).

import { describe, expect, it } from "vitest";
import { toBase64 } from "../src/bytes.ts";
import { ClawtrateClient } from "../src/client.ts";
import { FileTransfers } from "../src/files.ts";
import type { HttpFetch, HttpResponseLike } from "../src/host.ts";
import { mapHistory } from "../src/mapping.ts";
import {
  issuedPath,
  MAX_PICTURE_BYTES,
  readChatPicture,
  type ChatPictureContext,
} from "../src/pictures.ts";
import { INTERACTIVE_SCOPES } from "../src/scopes.ts";
import { FAST, grantingGateway, KEY, URL_A, URL_B } from "./client-harness.ts";
import { memoryStorage, testHost, tokenKey, until } from "./fake-gateway.ts";

const TASK = "tool:image_generate:9b21401e-321f-48bb-a101-c2db7c0d78e9";
const ARTIFACT = "artifact_managed_image_2de197ca-510c-4299-bd7a-ded7fe92de0c";
const PROMPT = "A sun over a green hill, in flat solid colours";
const ISSUED = `/api/chat/media/outgoing/${encodeURIComponent(KEY)}/2de197ca-510c-4299-bd7a-ded7fe92de0c/full?mediaTicket=v1.eyJzY29wZSI6Im1hbmFnZWQifQ.wvFYVx-PH9Ic0Rq3n8dJt2LmWbYk5sAeUoCiGzXhT1v`;
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

describe("F-535: a picture in history", () => {
  it("F-535: the gateway's image block is the turn's picture, with the description of the call whose task it completes, and no address", () => {
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
        messageId: "a2",
      },
    ]);
    expect(JSON.stringify(items)).not.toContain("/api/chat/media");
    // The turn that asked for it holds the call and no picture.
    expect(items[1]!.pictures).toBeUndefined();
  });

  it("F-535: a turn whose message is only the picture still shows it", () => {
    const only = rows();
    only[3]!.content = [imageBlock];
    expect(
      mapHistory(only)
        .at(-1)!
        .pictures?.map((each) => each.artifactId),
    ).toEqual([ARTIFACT]);
  });

  it("F-535: a picture stays on its own run's turn when that run began with an empty row", () => {
    const items = mapHistory([
      { role: "user", content: "hi", __openclaw: { id: "u1", seq: 1 } },
      {
        role: "assistant",
        content: [{ type: "text", text: "First." }],
        __openclaw: { id: "a1", seq: 2, runId: "run-a" },
      },
      { role: "assistant", content: [], __openclaw: { id: "b0", seq: 3, runId: "run-b" } },
      {
        role: "assistant",
        content: [imageBlock],
        __openclaw: { id: "b1", seq: 4, runId: "run-b" },
      },
    ]);
    const turns = items.filter((item) => item.role === "assistant");
    expect(turns).toHaveLength(2);
    expect(turns[0]!.pictures).toBeUndefined();
    expect(turns[1]!.pictures?.map((each) => each.artifactId)).toEqual([ARTIFACT]);
  });

  it("F-535: an image block the gateway holds no artifact for is not a picture, and a turn of another run names no description", () => {
    const { artifactId: _, ...bare } = imageBlock;
    expect(mapHistory(rows(bare)).at(-1)!.pictures).toBeUndefined();
    const other = rows();
    other[3]!.__openclaw = { id: "a2", seq: 6, runId: "run-2" };
    expect(mapHistory(other).at(-1)!.pictures![0]!.prompt).toBeNull();
  });
});

describe("F-535: a picture the gateway writes into the task as a row of its own (OpenClaw 2026.11.10)", () => {
  const DELIVERY = `image_generate:${TASK}:ok:agent-loop`;
  /** 2026.11.10's row: no run, the gateway's mirror fields, and the delivery's key on it and under `__openclaw`. */
  const row = (
    key: unknown = `${DELIVERY}:generated-media-host-transcript`,
    extra: Record<string, unknown> = {},
  ) => ({
    role: "assistant",
    content: [imageBlock],
    api: "openclaw-transcript",
    provider: "openclaw",
    model: "delivery-mirror",
    stopReason: "stop",
    idempotencyKey: key,
    __openclaw: { id: "a3", seq: 7, idempotencyKey: key },
    ...extra,
  });
  /** The bot's run, its answer, then the picture's row. */
  const history = (picture: Record<string, unknown>) => [
    ...rows().slice(0, 3),
    {
      role: "assistant",
      content: [{ type: "text", text: "I asked for the picture." }],
      __openclaw: { id: "a2", seq: 4, runId: "run-1" },
    },
    picture,
  ];
  const promptOf = (picture: Record<string, unknown>) =>
    mapHistory(history(picture)).at(-1)!.pictures?.[0]?.prompt;

  it("F-535: the row's key names the delivery, so the picture keeps the description of the call whose task it completes", () => {
    const items = mapHistory(history(row()));
    expect(items.at(-1)!.pictures).toEqual([
      expect.objectContaining({ artifactId: ARTIFACT, prompt: PROMPT, messageId: "a3" }),
    ]);
    // The same delivery tried again: the gateway puts the attempt before the suffix.
    expect(promptOf(row(`${DELIVERY}:attempt:2:generated-media-host-transcript`))).toBe(PROMPT);
  });

  it("F-535: a bot's message tool copy under that key names the bot's run, and gets no description", () => {
    const copy = row(undefined, {
      __openclaw: {
        id: "a3",
        seq: 7,
        runId: "run-2",
        idempotencyKey: `${DELIVERY}:generated-media-host-transcript`,
      },
    });
    expect(promptOf(copy)).toBeNull();
  });

  it("F-535: a row of another writer, another key, or a key of another shape gets no description", () => {
    expect(promptOf(row(undefined, { model: "dev-1" }))).toBeNull();
    expect(promptOf(row(undefined, { model: undefined }))).toBeNull();
    for (const key of [
      DELIVERY,
      `${DELIVERY}:generated-media-host-transcript:x`,
      `x:${DELIVERY}:generated-media-host-transcript`,
      `${DELIVERY}:attempt:two:generated-media-host-transcript`,
      `image_generate:tool:image_generate:other-task:ok:agent-loop:generated-media-host-transcript`,
      `video_generate:${TASK}:ok:agent-loop:generated-media-host-transcript`,
      "send-picture-1",
      42,
      null,
    ])
      expect(promptOf(row(key)), String(key)).toBeNull();
  });

  it("F-535: with the call outside the history read, the picture shows without a description", () => {
    expect(mapHistory([row()]).at(-1)!.pictures?.[0]?.prompt).toBeNull();
  });
});

describe("F-535: reading a picture", () => {
  it("F-535: a download that ends before its first byte sent no picture, a read to try again", async () => {
    const { ctx } = context({ url: ISSUED, expiresAt: LATER }, () =>
      response(200, { "content-type": "image/png" }, []),
    );
    expect(await readChatPicture(ctx, KEY, ARTIFACT)).toEqual({
      status: "failed",
      message: "The gateway sent no picture.",
    });
  });

  it("F-535: only the download the gateway issued for this task is fetched, from its origin, without cookies or redirects, and its bytes reach the viewer whole", async () => {
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

  it("F-535: an address the message names, another task's download, a ticket out of form, an expired or missing expiry, and another origin are never fetched", async () => {
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

  it("F-535: a type other than a picture's, bytes that don't start as their type's, and a picture over Clawtrate's limit are refused", async () => {
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

  it("F-535: JPEG, GIF and WebP are shown when their bytes start as their type's, and not otherwise", async () => {
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

  it("F-535: a refused redirect and an unreachable gateway each say so in a fixed sentence that names no address", async () => {
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

  it("F-535: a picture that arrives when every transfer's place is taken says so, not that the gateway was unreachable", async () => {
    const { ctx } = context({ url: ISSUED, expiresAt: LATER }, png);
    for (let held = 0; held < 4; held += 1) ctx.transfers.start({}, PNG, 1);
    expect(await readChatPicture({ ...ctx, maxChars: 1 }, KEY, ARTIFACT)).toEqual({
      status: "failed",
      message: "Other files are on their way to a viewer; try again in a moment.",
    });
  });

  it("F-535: a picture's media type is read without regard to case", async () => {
    const { ctx } = context({ url: ISSUED, expiresAt: LATER }, () =>
      response(200, { "content-type": "Image/PNG" }, [PNG]),
    );
    expect(await readChatPicture(ctx, KEY, ARTIFACT)).toMatchObject({
      status: "content",
      mimeType: "image/png",
    });
  });

  it("F-535: a host that can't fetch fetches nothing, and says so", async () => {
    const { ctx, asked } = context({ url: ISSUED, expiresAt: LATER }, png);
    expect(await readChatPicture({ ...ctx, fetch: null }, KEY, ARTIFACT)).toEqual({
      status: "failed",
      message: "This device can't load pictures from the gateway.",
    });
    expect(asked).toEqual([]);
  });
});

describe("F-535: the download path either OpenClaw issues", () => {
  // 2026.10.6 signs a ticket (`v1.<payload>.<HMAC-SHA256>`); 2026.11.10 names a grant on the
  // connection that asked (`<connection UUID>/<32 random bytes>`), written by `URLSearchParams`.
  const ATTACHMENT = ARTIFACT.slice(-36);
  const ROUTE = `/api/chat/media/outgoing/${encodeURIComponent(KEY)}/${ATTACHMENT}/full`;
  const SIGNATURE = ISSUED.slice(-43);
  const CONNECTION = "6f1c2a9e-3b7d-4e58-a0c4-9d2e81f7b630";
  const GRANT = "Qm9vay1yZXZpZXdzLWdyYW50LXRva2VuLWZvci10ZXM";
  // What the gateway writes the query with and the host's fetch parses with; core's types leave them out.
  const web = globalThis as unknown as {
    URLSearchParams: new (init: string | Record<string, string>) => {
      get(name: string): string | null;
      toString(): string;
    };
    Request: new (url: string) => { url: string };
  };
  const NEWER = `${ROUTE}?${new web.URLSearchParams({ mediaTicket: `${CONNECTION}/${GRANT}` })}`;

  it("F-535: a download of either form is fetched, its bytes sent as the gateway wrote them", async () => {
    expect(NEWER).toBe(`${ROUTE}?mediaTicket=${CONNECTION}%2F${GRANT}`);
    for (const url of [ISSUED, NEWER]) {
      expect(issuedPath(KEY, ARTIFACT, url)).toBe(url);
      const { ctx, fetched } = context({ url, expiresAt: LATER }, png);
      expect(await readChatPicture(ctx, KEY, ARTIFACT)).toMatchObject({ status: "content" });
      const sent = fetched[0]!.url;
      expect(sent).toBe(`http://127.0.0.1:19540${url}`);
      // What the host's fetch parses and sends: the same bytes, the slash still `%2F`.
      expect(new web.Request(sent).url).toBe(sent);
      expect(new URL(sent).pathname + new URL(sent).search).toBe(url);
    }
    expect(
      new web.URLSearchParams(new URL(`http://127.0.0.1:19540${NEWER}`).search).get("mediaTicket"),
    ).toBe(`${CONNECTION}/${GRANT}`);
  });

  it("F-535: a path of any other shape, or of another task or attachment, is refused", () => {
    const refused: Array<[string, unknown, string?, string?]> = [
      ["not a string", 42],
      ["no ticket", ROUTE],
      ["the thumbnail route", NEWER.replace("/full?", "/thumbnail?")],
      ["a connection's grant route", `/api/artifacts/download/${CONNECTION}/${GRANT}`],
      ["a person's media route", NEWER.replace("/outgoing/", "/incoming/")],
      ["a prefix before the route", `/x${NEWER}`],
      ["another parameter after", `${NEWER}&next=/elsewhere`],
      ["another parameter before", NEWER.replace("?mediaTicket=", "?next=1&mediaTicket=")],
      ["the ticket twice", `${NEWER}&mediaTicket=${CONNECTION}%2F${GRANT}`],
      ["a fragment", `${NEWER}#top`],
      ["an empty fragment", `${ISSUED}#`],
      ["a scheme and host", `https://pictures.example${NEWER}`],
      ["a host without a scheme", `//pictures.example${NEWER}`],
      ["a dot segment", NEWER.replace(`/${ATTACHMENT}/`, `/../${ATTACHMENT}/`)],
      ["an encoded dot segment", NEWER.replace(`/${ATTACHMENT}/`, `/%2E%2E/${ATTACHMENT}/`)],
      ["an encoded slash in the route", NEWER.replace(`/${ATTACHMENT}/`, `%2F${ATTACHMENT}/`)],
      ["the slash decoded", `${ROUTE}?mediaTicket=${CONNECTION}/${GRANT}`],
      ["the slash in lower case", `${ROUTE}?mediaTicket=${CONNECTION}%2f${GRANT}`],
      ["the slash encoded twice", `${ROUTE}?mediaTicket=${CONNECTION}%252F${GRANT}`],
      ["a second encoded slash", `${NEWER}%2F${GRANT}`],
      ["a backslash", `${ROUTE}?mediaTicket=${CONNECTION}\\${GRANT}`],
      ["an encoded backslash", `${ROUTE}?mediaTicket=${CONNECTION}%5C${GRANT}`],
      ["a newline after", `${NEWER}\n`],
      ["an encoded newline", `${NEWER}%0A`],
      ["a tab inside", ISSUED.replace("v1.", "v1.\t")],
      ["an empty ticket", `${ROUTE}?mediaTicket=`],
      ["a grant one character short", NEWER.slice(0, -1)],
      ["a grant one character long", `${NEWER}A`],
      ["a grant with a dot", `${NEWER.slice(0, -1)}.`],
      ["a grant with padding", `${NEWER.slice(0, -1)}=`],
      ["a connection in upper case", NEWER.replace(CONNECTION, CONNECTION.toUpperCase())],
      ["a connection that isn't a UUID", NEWER.replace(CONNECTION, CONNECTION.replace(/-/g, ""))],
      ["a signature one character short", ISSUED.slice(0, -1)],
      ["a signature one character long", `${ISSUED}A`],
      ["another version", ISSUED.replace("mediaTicket=v1.", "mediaTicket=v2.")],
      ["a path before the version", ISSUED.replace("mediaTicket=v1.", "mediaTicket=../v1.")],
      ["no payload", `${ROUTE}?mediaTicket=v1..${SIGNATURE}`],
      ["a third part", ISSUED.replace("mediaTicket=v1.", "mediaTicket=v1.e30.")],
      ["a tilde, outside base64url", ISSUED.replace("v1.eyJ", "v1.~eyJ")],
      ["a payload with a plus", ISSUED.replace("v1.eyJ", "v1.+eyJ")],
      ["over 4096 characters", ISSUED.replace("v1.", `v1.${"e".repeat(4096)}`)],
      ["another task's", NEWER.replace(encodeURIComponent(KEY), encodeURIComponent("agent:x:y"))],
      ["the task not encoded", NEWER.replace(encodeURIComponent(KEY), KEY)],
      ["the task encoded in lower case", NEWER.replace("%3A", "%3a")],
      ["another attachment", NEWER.replace(ATTACHMENT, CONNECTION)],
      ["an attachment in upper case", NEWER.replace(ATTACHMENT, ATTACHMENT.toUpperCase())],
      ["an artifact id of another kind", NEWER, KEY, `artifact_other_${ATTACHMENT}`],
      [
        "an artifact id that isn't a UUID",
        NEWER.replace(ATTACHMENT, "pdf"),
        KEY,
        "artifact_managed_media_pdf",
      ],
      [
        "an artifact id in upper case",
        NEWER.replace(ATTACHMENT, ATTACHMENT.toUpperCase()),
        KEY,
        ARTIFACT.toUpperCase().replace("ARTIFACT_MANAGED_IMAGE_", "artifact_managed_image_"),
      ],
      ["an empty task", NEWER.replace(encodeURIComponent(KEY), ""), ""],
      ["a task that is a dot segment", NEWER.replace(encodeURIComponent(KEY), ".."), ".."],
      ["a task with a slash", NEWER.replace(encodeURIComponent(KEY), "agent%3Aa%2Fb"), "agent:a/b"],
      [
        "a task with a backslash",
        NEWER.replace(encodeURIComponent(KEY), "agent%3Aa%5Cb"),
        "agent:a\\b",
      ],
      ["a task with a lone surrogate", NEWER, "agent:\uD800"],
    ];
    for (const [label, url, key = KEY, artifactId = ARTIFACT] of refused)
      expect(issuedPath(key, artifactId, url), label).toBeNull();
    // Another task's path is refused only for being another's: for its own task it is a download.
    const another = refused.find(([label]) => label === "another task's")![1];
    expect(issuedPath("agent:x:y", ARTIFACT, another)).toBe(another);
    expect(issuedPath(KEY, `artifact_managed_media_${ATTACHMENT}`, NEWER)).toBe(NEWER);
  });
});

describe("F-535: the client", () => {
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

  it("F-535: a message the gateway changes in place is read again, so the picture it adds after the turn shows", async () => {
    const { client, gateway, setHistory } = await open(async () => png());
    expect(client.state.transcripts[KEY]!.items.some((item) => item.pictures)).toBe(false);
    setHistory(rows());
    gateway.emit("sessions.changed", { sessionKey: KEY, phase: "message", updatedAt: 2 });
    await until(() => client.state.transcripts[KEY]!.items.some((item) => item.pictures));
    client.stop();
  });

  it("F-535: more pictures than the file reads' places wait their turn and all show", async () => {
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

  it("F-535: pictures that each need a transfer wait for one of the transfers' places too, and all show", async () => {
    const { client } = await open(async () => png());
    // Three-byte parts: each picture is a transfer its viewer reads part by part.
    const reads = Array.from({ length: 6 }, () =>
      client.readChatPicture(KEY, ARTIFACT, { maxChars: 1 }),
    );
    const first = await Promise.all(reads.slice(0, 4));
    const ids = first.map((read) => (read.status === "content" ? read.transfer.id : null));
    expect(ids.every((id) => id !== null)).toBe(true);
    // The first four are still on their way when a read's place frees: the rest wait for them.
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    for (const id of ids) client.releaseFile(id!);
    expect((await Promise.all(reads.slice(4))).map((read) => read.status)).toEqual([
      "content",
      "content",
    ]);
    client.stop();
  });

  it("F-535: a picture that waited through a switch to another gateway isn't read there", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { client, gateway } = await open(async () => {
      await held;
      return png();
    });
    const busy = Array.from({ length: 4 }, () => client.readChatPicture(KEY, ARTIFACT));
    const waiting = client.readChatPicture(KEY, ARTIFACT);
    void client.connect({ url: URL_B, token: "t" }).catch(() => {});
    await until(
      () =>
        client.state.connection.status === "connected" &&
        client.state.connection.gatewayUrl === URL_B,
    );
    release();
    await Promise.allSettled(busy);
    expect(await waiting).toEqual({
      status: "failed",
      message: "The connection changed while this picture waited.",
    });
    expect(gateway.calls("artifacts.download")).toHaveLength(4);
    client.stop();
  });

  it("F-535: a picture whose viewer went away while it was read leaves no transfer behind", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { client } = await open(async () => {
      await held;
      return png();
    });
    const viewer = {};
    const reading = client.readChatPicture(KEY, ARTIFACT, { owner: viewer, maxChars: 1 });
    client.withdraw(viewer);
    release();
    const read = await reading;
    if (read.status !== "content" || !read.transfer.id) throw new Error("expected a transfer");
    const id = read.transfer.id;
    expect(() => client.readFileChunk(id, 1, viewer)).toThrow("This file's transfer has ended");
    client.stop();
  });

  it("F-535: a picture whose viewer left while it waited asks the gateway for nothing", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { client, gateway } = await open(async () => {
      await held;
      return png();
    });
    const busy = Array.from({ length: 4 }, () => client.readChatPicture(KEY, ARTIFACT));
    const viewer = {};
    const waiting = client.readChatPicture(KEY, ARTIFACT, { owner: viewer });
    client.withdraw(viewer);
    release();
    await Promise.all(busy);
    await expect(waiting).rejects.toThrow();
    expect(gateway.calls("artifacts.download")).toHaveLength(4);
    client.stop();
  });

  it("F-535: a picture whose bytes arrive after a switch to another gateway reaches no viewer", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { client } = await open(async () => {
      await held;
      return png();
    });
    const viewer = {};
    const reading = client.readChatPicture(KEY, ARTIFACT, { owner: viewer, maxChars: 1 });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    void client.connect({ url: URL_B, token: "t" }).catch(() => {});
    await until(
      () =>
        client.state.connection.status === "connected" &&
        client.state.connection.gatewayUrl === URL_B,
    );
    release();
    expect(await reading).toEqual({
      status: "failed",
      message: "The connection changed while this picture was read.",
    });
    client.stop();
  });

  it("F-535: the picture is read through the host's fetch at the gateway's origin", async () => {
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
