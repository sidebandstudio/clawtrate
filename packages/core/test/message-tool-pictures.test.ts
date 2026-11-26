// A picture a bot sends with its message tool, in the conversation (F-535,
// #423). In a task of this app's, the gateway runs a `send` that names no
// channel as its reply in the task: it stages the picture and writes a row of
// its own in the same run (`model: "delivery-mirror"`), whose `image` blocks
// name managed artifacts. The rows below are as a development gateway recorded
// them (OpenClaw 2026.10.6, `--with-message-tool`), with ids kept and the
// paths of the gateway's own computer replaced.

import { describe, expect, it } from "vitest";
import { ClawtrateClient } from "../src/client.ts";
import type { HttpFetch, HttpResponseLike } from "../src/host.ts";
import { mapHistory } from "../src/mapping.ts";
import { READ_SCOPES } from "../src/scopes.ts";
import { FAST, grantingGateway, KEY, URL_A } from "./client-harness.ts";
import { memoryStorage, testHost, tokenKey, until } from "./fake-gateway.ts";

const SUN = "artifact_managed_image_fbabd0fe-ab39-4db6-88ba-6bb4bb348ea3";
const MAP = "artifact_managed_image_2d354dee-da5c-47a0-b77f-446b2752a304";
const outgoing = (artifactId: string) =>
  `/api/chat/media/outgoing/${encodeURIComponent(KEY)}/${artifactId.slice(-36)}/full`;
const image = (artifactId: string, alt: string, width: number, height: number, size: number) => ({
  type: "image",
  artifactId,
  url: outgoing(artifactId),
  openUrl: outgoing(artifactId),
  alt,
  mimeType: "image/png",
  width,
  height,
  sizeBytes: size,
});
const sun = image(SUN, "sun.png", 256, 256, 887);
const map = image(MAP, "trail-map.png", 240, 160, 1133);
const RECEIPT = "Sent visible reply to the current source conversation via internal-ui.";

/**
 * One run: the person's message, the bot's `message` call with `args`, the row the
 * gateway delivered (`delivered` is its content, or null when nothing was
 * delivered), the call's result, and the bot's closing words.
 */
function run(
  args: Record<string, unknown>,
  delivered: unknown[] | null,
  result: { text: string; isError?: boolean } = { text: RECEIPT },
) {
  const meta = (id: string, seq: number) => ({ runId: "r7-1", id, seq });
  return [
    { role: "user", content: "Show me the pictures", __openclaw: { id: "u1", seq: 1 } },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "raw-1", name: "message", arguments: args }],
      model: "dev-1",
      __openclaw: meta("cca9bf46-d6a7-47e2-b282-a5752cb874bd", 2),
    },
    ...(delivered
      ? [
          {
            role: "assistant",
            content: delivered,
            api: "openclaw-transcript",
            provider: "openclaw",
            model: "delivery-mirror",
            idempotencyKey: "r7-1:message-tool:iHmKBed-TYL87VTkjYmbExz:raw-1",
            __openclaw: meta("c9a4fb79-7bcc-45c2-85e7-b783a9825f11", 3),
          },
        ]
      : []),
    {
      role: "toolResult",
      toolCallId: "raw-1",
      toolName: "message",
      content: [{ type: "text", text: result.text }],
      isError: result.isError === true,
      __openclaw: meta("17abe1f8-267e-45d2-afc5-0cd9a243a0d3", 4),
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "That's all of them." }],
      model: "dev-1",
      __openclaw: meta("8b36d8c3-7fa6-4a76-9824-4ffccabffe84", 5),
    },
  ];
}

const DELIVERED_ID = "c9a4fb79-7bcc-45c2-85e7-b783a9825f11";

describe("F-535: a picture sent with the message tool, in history", () => {
  it("F-535: a workspace file sent with `media` is the turn's one picture, on the row that carried it, and the call's path is never kept", () => {
    const items = mapHistory(
      run({ action: "send", message: "Here is the trail map.", media: "pictures/trail-map.png" }, [
        { type: "text", text: "Here is the trail map." },
        map,
      ]),
    );
    const turn = items.at(-1)!;
    expect(items.filter((item) => item.role === "assistant")).toHaveLength(1);
    expect(turn.pictures).toEqual([
      {
        artifactId: MAP,
        alt: "trail-map.png",
        prompt: null,
        mimeType: "image/png",
        width: 240,
        height: 160,
        sizeBytes: 1133,
        messageId: DELIVERED_ID,
      },
    ]);
    // The text the picture goes with is that row's bubble.
    const said = turn.blocks.find(
      (block) => block.kind === "text" && block.text.startsWith("Here is"),
    );
    expect(said?.kind === "text" && said.messageId).toBe(DELIVERED_ID);
    expect(JSON.stringify(turn.pictures)).not.toContain("/api/chat/media");
    expect(JSON.stringify(turn.pictures)).not.toContain("pictures/trail-map.png");
  });

  it("F-535: several pictures of one message keep the order it gave them, from `attachments` or `media` with `attachments`", () => {
    for (const args of [
      {
        action: "send",
        message: "Two pictures.",
        attachments: [
          { type: "image", media: "pictures/sun.png" },
          { type: "image", media: "pictures/trail-map.png" },
        ],
      },
      {
        action: "send",
        message: "Two pictures.",
        media: "pictures/sun.png",
        attachments: [{ type: "image", media: "pictures/trail-map.png" }],
      },
    ]) {
      const turn = mapHistory(run(args, [{ type: "text", text: "Two pictures." }, sun, map])).at(
        -1,
      )!;
      expect(turn.pictures?.map((each) => [each.artifactId, each.alt, each.messageId])).toEqual([
        [SUN, "sun.png", DELIVERED_ID],
        [MAP, "trail-map.png", DELIVERED_ID],
      ]);
    }
  });

  it("F-535: a picture sent as a `buffer` is a picture like any other", () => {
    const buffered = image(
      "artifact_managed_image_b6da465b-4e13-497a-9a83-5b97409b9d1a",
      "buffer-map.png",
      240,
      160,
      1133,
    );
    const turn = mapHistory(
      run(
        {
          action: "send",
          message: "A map from a buffer.",
          buffer: "data:image/png;base64,iVBORw0KGgo=",
          filename: "buffer-map.png",
        },
        [{ type: "text", text: "A map from a buffer." }, buffered],
      ),
    ).at(-1)!;
    expect(turn.pictures?.map((each) => each.artifactId)).toEqual([buffered.artifactId]);
    expect(JSON.stringify(turn.pictures)).not.toContain("base64");
  });

  it("F-535: a picture the gateway made, sent again with the message tool, shows once in each turn, with its own id", () => {
    const made = "artifact_managed_image_1d2444f2-d94d-4676-96a6-1a2f54637eb9";
    const resent = "artifact_managed_image_8748634d-39e6-412e-9368-b1f59527263b";
    const items = mapHistory([
      ...run({ action: "send", message: "x" }, null).slice(0, 1),
      {
        role: "assistant",
        content: [
          { type: "text", text: "Here is the picture you asked for." },
          image(made, "image-1.png", 256, 256, 887),
        ],
        __openclaw: {
          id: "a-made",
          seq: 6,
          runId: "image_generate:tool:image_generate:4b0cc110:ok:agent-loop",
        },
      },
      { role: "user", content: "Send it again", __openclaw: { id: "u2", seq: 7 } },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "raw-7",
            name: "message",
            arguments: {
              action: "send",
              message: "The picture again.",
              media:
                "/state/media/tool-image-generation/image-1---6bffe693-d049-43ae-b77c-ec3097cb7b47.png",
            },
          },
        ],
        __openclaw: { id: "a-call", seq: 8, runId: "r9-2" },
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "The picture again." },
          image(resent, "image-1---6bffe693.png", 256, 256, 887),
        ],
        model: "delivery-mirror",
        __openclaw: { id: "a-sent", seq: 9, runId: "r9-2" },
      },
    ]);
    expect(
      items.filter((item) => item.pictures).map((item) => item.pictures!.map((p) => p.artifactId)),
    ).toEqual([[made], [resent]]);
    expect(JSON.stringify(items.map((item) => item.pictures))).not.toContain("/state/");
  });

  it("F-535: a picture that also arrives as an image on another of the run's messages is drawn once, where it first came", () => {
    const rows = run(
      { action: "send", message: "Here is the trail map.", media: "pictures/trail-map.png" },
      [{ type: "text", text: "Here is the trail map." }, map, map],
    );
    // The bot's closing message carries the same picture again.
    (rows.at(-1)!.content as unknown[]).push(map);
    const turn = mapHistory(rows).at(-1)!;
    expect(turn.pictures?.map((each) => [each.artifactId, each.messageId])).toEqual([
      [MAP, DELIVERED_ID],
    ]);
  });

  it("F-535: a file that isn't a picture, and media the gateway couldn't stage, give no picture", () => {
    const document = mapHistory(
      run({ action: "send", message: "File notes.txt.", media: "pictures/notes.txt" }, [
        { type: "text", text: "File notes.txt." },
        {
          type: "attachment",
          attachment: {
            artifactId: "artifact_managed_media_5334d528-ec5b-47c2-9241-6cd0c2ddbfd6",
            url: outgoing("artifact_managed_media_5334d528-ec5b-47c2-9241-6cd0c2ddbfd6"),
            kind: "document",
            label: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 12,
          },
        },
      ]),
    );
    expect(document.some((item) => item.pictures)).toBe(false);
    const refused = mapHistory(
      run({ action: "send", message: "File box.svg.", media: "pictures/box.svg" }, null, {
        text: '{\n  "status": "error",\n  "tool": "message",\n  "error": "Current-source media could not be staged.\\n⚠️ box.svg: Delivery failed. Try sending this file again."\n}',
        isError: true,
      }),
    );
    expect(refused.some((item) => item.pictures)).toBe(false);
    const call = refused.at(-1)!.blocks.find((block) => block.kind === "tool-call");
    expect(call?.kind === "tool-call" && call.result?.isError).toBe(true);
  });
});

describe("F-535: a picture sent with the message tool, read", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const ISSUED = `${outgoing(MAP)}?mediaTicket=v1.eyJzY29wZSI6Im1hbmFnZWQifQ.wvFYVx-PH9Ic0Rq3n8dJt2LmWbYk5sAeUoCiGzXhT1v`;

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

  /** A task whose history holds the run above, on a connection with `scopes`. */
  async function open(
    fetch: HttpFetch,
    download: () => unknown = () => ({
      url: ISSUED,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    }),
    scopes: readonly string[] = READ_SCOPES,
  ) {
    const gateway = grantingGateway();
    gateway.handlers["chat.history"] = () => ({
      messages: run(
        { action: "send", message: "Here is the trail map.", media: "pictures/trail-map.png" },
        [{ type: "text", text: "Here is the trail map." }, map],
      ),
    });
    gateway.handlers["artifacts.download"] = download;
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: JSON.stringify({
        token: "device-token",
        grantedScopes: scopes,
        heldScopes: scopes,
      }),
    });
    const client = new ClawtrateClient({ ...testHost(gateway, storage), fetch }, FAST);
    await client.start();
    await until(() => client.state.discovery.status === "ready");
    client.openSession(KEY);
    await until(() => client.state.transcripts[KEY]?.status === "ready");
    return { client, gateway };
  }

  it("F-535: on a read-only connection the picture is read through the download the gateway issues for its id, and nothing the message names", async () => {
    const fetched: string[] = [];
    const { client, gateway } = await open(async (url) => {
      fetched.push(url);
      return response(200, { "content-type": "image/png" }, PNG);
    });
    const picture = client.state.transcripts[KEY]!.items.at(-1)!.pictures![0]!;
    const read = await client.readChatPicture(KEY, picture.artifactId);
    expect(read).toMatchObject({ status: "content", mimeType: "image/png", bytes: PNG.length });
    expect(gateway.calls("artifacts.download")).toEqual([{ sessionKey: KEY, artifactId: MAP }]);
    expect(fetched).toEqual([`http://${new URL(URL_A).host}${ISSUED}`]);
    client.stop();
  });

  it("F-535: a picture too large, of another type, or with no download says so in place of the picture", async () => {
    const big = await open(async () =>
      response(200, { "content-type": "image/jpeg", "content-length": "5242881" }, PNG),
    );
    expect(await big.client.readChatPicture(KEY, MAP)).toEqual({
      status: "failed",
      message: "This picture is larger than Clawtrate shows: pictures up to 5 MB.",
    });
    big.client.stop();
    const other = await open(async () => response(200, { "content-type": "image/svg+xml" }, PNG));
    expect(await other.client.readChatPicture(KEY, MAP)).toEqual({
      status: "failed",
      message: "The gateway sent something that isn't a picture this app shows.",
    });
    other.client.stop();
    const none = await open(
      async () => response(200, { "content-type": "image/png" }, PNG),
      () => {
        throw new Error("artifact not found");
      },
    );
    expect(await none.client.readChatPicture(KEY, MAP)).toMatchObject({ status: "failed" });
    none.client.stop();
    const unissued = await open(
      async () => response(200, { "content-type": "image/png" }, PNG),
      () => ({ url: outgoing(MAP), expiresAt: new Date(Date.now() + 300_000).toISOString() }),
    );
    expect(await unissued.client.readChatPicture(KEY, MAP)).toEqual({
      status: "failed",
      message: "The gateway didn't give a download for this picture.",
    });
    unissued.client.stop();
  });

  it("F-535: a picture whose viewer left before it was read asks the gateway for nothing", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { client, gateway } = await open(async () => {
      await held;
      return response(200, { "content-type": "image/png" }, PNG);
    });
    // Four reads hold the file reads' places, so the viewer's picture waits.
    const busy = Array.from({ length: 4 }, () => client.readChatPicture(KEY, MAP));
    const viewer = {};
    const waiting = client.readChatPicture(KEY, MAP, { owner: viewer });
    client.withdraw(viewer);
    release();
    await Promise.all(busy);
    await expect(waiting).rejects.toThrow();
    expect(gateway.calls("artifacts.download")).toHaveLength(4);
    client.stop();
  });
});
