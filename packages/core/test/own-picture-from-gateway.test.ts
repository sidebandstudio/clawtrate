// A person's own picture, read back from their gateway when this app holds no
// copy (#469). The route's answers are as a development gateway on OpenClaw
// 2026.10.6 gave them: a ticket answer of `available`, `mimeType`, `sizeBytes`,
// `mediaTicket` and `mediaTicketExpiresAt`, then the bytes for the ticket.
//
// The qualifying-address rule is the product's: these clients connect at
// `wss://gateway.example`, and the fake fetch stands in for its HTTPS origin.
// apps/desktop/test/own-picture-host-fetch.test.ts points that origin at a
// stand-in server on loopback, through the desktop host's own fetch.

import { describe, expect, it } from "vitest";
import { fromBase64, toBase64 } from "../src/bytes.ts";
import {
  ClawtrateClient,
  MAX_READ_BACK_PICTURES,
  MAX_RETAINED_ATTACHMENT_BYTES,
  type OutgoingAttachment,
} from "../src/client.ts";
import type { HttpFetch, HttpResponseLike } from "../src/host.ts";
import { inboundRef, MAX_SENT_SOURCES, sentSources } from "../src/mapping.ts";
import {
  fetchInboundPicture,
  INBOUND_MEDIA_ROUTE,
  MAX_PICTURE_BYTES,
  type InboundPictureContext,
  type SentPictureRead,
} from "../src/pictures.ts";
import { INTERACTIVE_SCOPES } from "../src/scopes.ts";
import { FAST, grantingGateway, KEY, URL_B } from "./client-harness.ts";
import { memoryStorage, testHost, tokenKey, until } from "./fake-gateway.ts";
import { FIRST, SECOND, SHOT, sentRow, solidPng } from "./sent-attachments-rows.ts";

const PROTECTED = "wss://gateway.example";
const ORIGIN = "https://gateway.example";
const TOKEN = "device-token";
const RED = solidPng(48, 32, [220, 40, 40]);
const NOW = Date.parse("2026-11-24T22:50:01.305Z");
/** A ticket in the gateway's form: `v1`, a payload and a signature, each base64url. Made up. */
const TICKET = ["v1", "c2NvcGU", "c2lnbmF0dXJl"].join(".");
const ascii = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));

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

const json = (value: unknown, status = 200) =>
  response(status, { "content-type": "application/json; charset=utf-8" }, [
    ascii(JSON.stringify(value)),
  ]);
const ticket = (overrides: Record<string, unknown> = {}) =>
  json({
    available: true,
    mimeType: "image/png",
    sizeBytes: RED.length,
    mediaTicket: TICKET,
    mediaTicketExpiresAt: new Date(NOW + 300_000).toISOString(),
    ...overrides,
  });
const png = (bytes: Uint8Array = RED) =>
  response(200, { "content-type": "image/png", "content-length": String(bytes.length) }, [
    bytes.slice(0, 10),
    bytes.slice(10),
  ]);

type Fetched = { url: string; init: Parameters<HttpFetch>[1] };

/** An address before its query, and its query's names and decoded values, in order. */
function parts(url: string) {
  const [base, search = ""] = url.split("?") as [string, string?];
  const pairs = search
    .split("&")
    .filter(Boolean)
    .map((pair) => pair.split("=") as [string, string?]);
  const get = (name: string) => {
    const value = pairs.find(([key]) => key === name)?.[1];
    return value === undefined ? null : decodeURIComponent(value);
  };
  return { base, keys: pairs.map(([key]) => key), get };
}

/** A fake HTTPS origin: the ticket answer for `meta=1`, the bytes otherwise. */
function route(meta: () => HttpResponseLike, bytes: () => HttpResponseLike = png) {
  const fetched: Fetched[] = [];
  const fetch: HttpFetch = async (url, init) => {
    fetched.push({ url, init });
    return parts(url).get("meta") === "1" ? meta() : bytes();
  };
  return { fetch, fetched };
}

const ctxOf = (
  fetch: HttpFetch | null,
  overrides: Partial<InboundPictureContext> = {},
): InboundPictureContext => ({
  fetch,
  gatewayUrl: PROTECTED,
  token: TOKEN,
  now: () => NOW,
  ...overrides,
});

describe("F-557: which reference a person's picture is read back by", () => {
  it("F-557: only `media://inbound/<id>` exactly, with nothing to decode and nothing else named", () => {
    expect(inboundRef(SHOT.url)).toBe(SHOT.url);
    for (const value of [
      "media://inbound/",
      "media://inbound/.",
      "media://inbound/..",
      "media://inbound/a/b.png",
      "media://inbound/..%2FAGENTS.md",
      "media://inbound/a\\b.png",
      "media://inbound/a.png?x=1",
      "media://inbound/a.png#x",
      "media://inbound/a b.png",
      "media://inbound/a\u0000.png",
      "media://outbound/a.png",
      "media://user@inbound/a.png",
      "file:///tmp/a.png",
      "https://gateway.example/a.png",
      "/state/media/inbound/a.png",
      "AGENTS.md",
      `media://inbound/${"a".repeat(600)}.png`,
      42,
      null,
    ])
      expect(inboundRef(value), String(value)).toBeNull();
  });

  it("F-557: a person's own rows give their files' references by row key and place; a bot's or the gateway's rows, and an entry's local path, give none", () => {
    const withPath = { ...SECOND, path: "/state/media/inbound/second.png" };
    const pathOnly = { ...FIRST, url: undefined, path: "/state/media/inbound/first.png" };
    const sources = sentSources([
      sentRow("m1", "one", [SHOT]),
      sentRow("m2", "two", [pathOnly, withPath]),
      // A bot's row naming media, and a turn the gateway wrote itself: neither is the person's.
      { role: "assistant", content: "x", __openclaw: { id: "a1", media: [FIRST] } },
      { role: "toolResult", content: "x", __openclaw: { id: "t1", media: [FIRST] } },
      {
        role: "user",
        content: "resume",
        provenance: { kind: "internal_system" },
        __openclaw: { id: "g1", idempotencyKey: "g1:user", media: [FIRST] },
      },
      // A row with no idempotency key is asked for by its id.
      { role: "user", content: "", __openclaw: { id: "row-x", media: [FIRST] } },
    ]);
    expect([...sources.entries()].sort()).toEqual(
      [
        ["m1:user\u00000", SHOT.url],
        ["m2:user\u00001", SECOND.url],
        ["row-x\u00000", FIRST.url],
      ].sort(),
    );
  });

  it(`F-557: at most ${MAX_SENT_SOURCES} references are kept for a task, the newest`, () => {
    const rows = Array.from({ length: MAX_SENT_SOURCES + 5 }, (_, i) =>
      sentRow(`m${i}`, `p${i}`, [SHOT], i + 1),
    );
    const sources = sentSources(rows);
    expect(sources.size).toBe(MAX_SENT_SOURCES);
    expect(sources.has(`m${MAX_SENT_SOURCES + 4}:user\u00000`)).toBe(true);
    expect(sources.has("m4:user\u00000")).toBe(false);
  });
});

describe("F-557: reading a person's picture back from the gateway", () => {
  it("F-557: at a protected address, a ticket for the task's own session with the token in a header, then the bytes with the ticket and no token", async () => {
    const { fetch, fetched } = route(() => ticket());
    const read = await fetchInboundPicture(ctxOf(fetch), KEY, SHOT.url);
    expect(read).toEqual({ status: "bytes", mimeType: "image/png", bytes: RED });
    expect(fetched).toHaveLength(2);
    const [meta, bytes] = fetched.map(({ url }) => parts(url));
    for (const url of [meta!, bytes!]) {
      expect(url.base).toBe(`${ORIGIN}${INBOUND_MEDIA_ROUTE}`);
      expect(url.get("source")).toBe(SHOT.url);
      expect(url.get("sessionKey")).toBe(KEY);
    }
    for (const { url } of fetched) expect(url).not.toContain(TOKEN);
    expect(meta!.keys).toEqual(["meta", "source", "sessionKey"]);
    expect(bytes!.keys).toEqual(["source", "sessionKey", "mediaTicket"]);
    expect(bytes!.get("mediaTicket")).toBe(TICKET);
    expect(fetched[0]!.init.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
    expect(fetched[1]!.init.headers).toBeUndefined();
    for (const { init } of fetched) {
      expect(init.redirect).toBe("error");
      expect(init.credentials).toBe("omit");
      expect(init.method).toBe("GET");
    }
  });

  it("F-557: at a loopback or ws:// address, with no host fetch, no token or a reference not in the exact form, nothing is asked", async () => {
    const { fetch, fetched } = route(() => ticket());
    for (const gatewayUrl of [
      "ws://gateway.example",
      "ws://127.0.0.1:19001",
      "wss://127.0.0.1:19001",
      "wss://localhost:19001",
      "wss://[::1]:19001",
      "wss://gateway.localhost",
    ])
      expect(await fetchInboundPicture(ctxOf(fetch, { gatewayUrl }), KEY, SHOT.url)).toEqual({
        status: "cannot-load",
      });
    expect(await fetchInboundPicture(ctxOf(null), KEY, SHOT.url)).toEqual({
      status: "cannot-load",
    });
    expect(await fetchInboundPicture(ctxOf(fetch, { token: null }), KEY, SHOT.url)).toEqual({
      status: "cannot-load",
    });
    for (const ref of ["AGENTS.md", "media://inbound/../x.png", "/state/media/inbound/x.png"])
      expect(await fetchInboundPicture(ctxOf(fetch), KEY, ref)).toEqual({
        status: "cannot-load",
      });
    expect(fetched).toEqual([]);
  });

  it("F-557: the gateway's own `available: false` is the only answer that says it no longer has the picture", async () => {
    const gone = route(() => json({ available: false, code: "blocked-local-file" }));
    expect(await fetchInboundPicture(ctxOf(gone.fetch), KEY, SHOT.url)).toEqual({
      status: "gone",
    });
    expect(gone.fetched).toHaveLength(1);
    // A route that isn't there (a gateway under a base path answers with its page, or 404), a
    // refusal, or an answer that isn't the route's: this connection can't load it, and nothing more.
    for (const meta of [
      () => response(404, { "content-type": "text/plain" }, [ascii("Not Found")]),
      () => response(401, {}, []),
      () => response(403, {}, []),
      () =>
        response(200, { "content-type": "text/html; charset=utf-8" }, [ascii("<!doctype html>")]),
      () => json({ available: "yes" }),
      () => response(200, { "content-type": "application/json" }, [ascii("{not json")]),
      () => json({ padding: "x".repeat(5000) }),
      () => ticket({ mediaTicket: "not-a-ticket" }),
      () => ticket({ mediaTicket: undefined }),
    ]) {
      const { fetch, fetched } = route(meta);
      expect(await fetchInboundPicture(ctxOf(fetch), KEY, SHOT.url)).toEqual({
        status: "cannot-load",
      });
      expect(fetched).toHaveLength(1);
    }
  });

  it("F-557: a failing or busy gateway, a ticket already run out, a refused ticket, no body, a network error and a slow answer are a failed read, to try again", async () => {
    for (const [meta, bytes] of [
      [() => response(503, {}, []), png],
      [() => response(500, {}, []), png],
      [() => response(429, {}, []), png],
      [() => ticket({ mediaTicketExpiresAt: new Date(NOW - 1).toISOString() }), png],
      [() => ticket({ mediaTicketExpiresAt: NOW + 300_000 }), png],
      [() => ticket(), () => response(401, {}, [])],
      [() => ticket(), () => ({ status: 200, headers: { get: () => "image/png" }, body: null })],
    ] as Array<[() => HttpResponseLike, () => HttpResponseLike]>) {
      const { fetch } = route(meta, bytes);
      expect((await fetchInboundPicture(ctxOf(fetch), KEY, SHOT.url)).status).toBe("failed");
    }
    const offline: HttpFetch = async () => {
      throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") });
    };
    expect(await fetchInboundPicture(ctxOf(offline), KEY, SHOT.url)).toEqual({
      status: "failed",
      message: "The gateway couldn't be reached for this picture.",
    });
  });

  it("F-557: a redirect, on either request, is refused and the picture is one this connection can't load", async () => {
    const redirect: HttpFetch = async () => {
      throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
    };
    expect(await fetchInboundPicture(ctxOf(redirect), KEY, SHOT.url)).toEqual({
      status: "cannot-load",
    });
    let calls = 0;
    const second: HttpFetch = async () => {
      calls += 1;
      if (calls === 1) return ticket();
      throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
    };
    expect(await fetchInboundPicture(ctxOf(second), KEY, SHOT.url)).toEqual({
      status: "cannot-load",
    });
  });

  it("F-557: only PNG, JPEG, GIF or WebP by their bytes, within 5 MB: anything else is its name and size, and a ticket for one isn't used", async () => {
    // Named as something not drawn, or larger than shown: the bytes aren't asked for.
    for (const meta of [
      () => ticket({ mimeType: "text/markdown" }),
      () => ticket({ mimeType: "image/svg+xml" }),
      () => ticket({ sizeBytes: MAX_PICTURE_BYTES + 1 }),
    ]) {
      const { fetch, fetched } = route(meta);
      expect(await fetchInboundPicture(ctxOf(fetch), KEY, SHOT.url)).toEqual({
        status: "not-a-picture",
      });
      expect(fetched).toHaveLength(1);
    }
    const tooLong = response(
      200,
      { "content-type": "image/png", "content-length": String(MAX_PICTURE_BYTES + 1) },
      [RED],
    );
    const streamedTooLong = response(200, { "content-type": "image/png" }, [
      RED,
      new Uint8Array(MAX_PICTURE_BYTES),
    ]);
    for (const bytes of [
      // Its content, not its name: a PNG type over bytes that aren't one, and text named a picture.
      () => response(200, { "content-type": "image/png" }, [ascii("# Notes\nnot a picture")]),
      () => response(200, { "content-type": "text/markdown" }, [RED]),
      () => response(200, { "content-type": "image/jpeg" }, [RED]),
      () => tooLong,
      () => streamedTooLong,
    ]) {
      const { fetch } = route(() => ticket(), bytes);
      expect(await fetchInboundPicture(ctxOf(fetch), KEY, SHOT.url)).toEqual({
        status: "not-a-picture",
      });
    }
    expect(tooLong.cancelled()).toBe(true);
    expect(streamedTooLong.cancelled()).toBe(true);
  });
});

/** A client on another device of this person: no copy of anything sent, at `url`. */
async function elsewhere(
  fetch: HttpFetch | undefined,
  history: unknown[],
  url = PROTECTED,
  gatewayId: string | null = null,
) {
  const gateway = grantingGateway();
  let rows = history;
  gateway.handlers["chat.history"] = () => ({ messages: rows });
  if (gatewayId) gateway.handlers["gateway.identity.get"] = () => ({ deviceId: gatewayId });
  const storage = memoryStorage({
    connection: JSON.stringify({ url, token: null }),
    [tokenKey(url)]: JSON.stringify({
      token: TOKEN,
      grantedScopes: INTERACTIVE_SCOPES,
      heldScopes: INTERACTIVE_SCOPES,
    }),
  });
  const host = { ...testHost(gateway, storage), ...(fetch ? { fetch } : {}) };
  const client = new ClawtrateClient(host, FAST);
  await client.start();
  await until(() => client.state.discovery.status === "ready");
  client.openSession(KEY);
  await until(() => client.state.transcripts[KEY]?.status === "ready");
  return { client, gateway, setHistory: (next: unknown[]) => (rows = next) };
}

/** The bytes a read hands its viewer, every part of its transfer joined. */
function bytesOf(client: ClawtrateClient, read: SentPictureRead): Uint8Array {
  if (read.status !== "content") throw new Error(`expected a picture, got ${JSON.stringify(read)}`);
  let data = read.transfer.data;
  for (let index = 1; index < read.transfer.chunks; index += 1)
    data += client.readFileChunk(read.transfer.id!, index).data;
  return fromBase64(data)!;
}

const live = () => route(() => ticket({ mediaTicketExpiresAt: new Date(Date.now() + 300_000) }));
const sentRed: OutgoingAttachment = {
  type: "image",
  mimeType: "image/png",
  fileName: "shot.png",
  content: toBase64(RED),
};

describe("F-557: your picture on another device, and after a restart", () => {
  it("F-557: with no copy here, it is read back from the gateway for the task's own row, and shown again without a second read", async () => {
    const { fetch, fetched } = live();
    const { client } = await elsewhere(fetch, [sentRow("m1", "look", [SHOT])]);
    expect(client.state.transcripts[KEY]!.items[0]!.attachments).toEqual([
      { fileName: "shot.png", mimeType: "image/png", sizeBytes: 111 },
    ]);
    // The reference stays in the host: the state a viewer is sent never has it.
    expect(JSON.stringify(client.state)).not.toContain("media://");
    expect(bytesOf(client, await client.readSentPicture(KEY, "m1:user", 0))).toEqual(RED);
    expect(fetched.map(({ url }) => parts(url).get("sessionKey"))).toEqual([KEY, KEY]);
    expect(client.readBackPictureBytes).toBe(RED.length);
    expect(bytesOf(client, await client.readSentPicture(KEY, "m1:user", 0))).toEqual(RED);
    expect(fetched).toHaveLength(2);
    client.stop();
  });

  it("F-557: on the device that sent it, the app's own copy shows and nothing is read from the gateway", async () => {
    const { fetch, fetched } = live();
    const { client, gateway, setHistory } = await elsewhere(fetch, []);
    const id = client.sendMessage(KEY, "look", { attachments: [sentRed] });
    expect(bytesOf(client, await client.readSentPicture(KEY, id, 0))).toEqual(RED);
    setHistory([sentRow(id, "look", [SHOT])]);
    gateway.emit("sessions.changed", { sessionKey: KEY, phase: "message", updatedAt: 2 });
    await until(() => client.state.transcripts[KEY]!.outbox.length === 0);
    expect(bytesOf(client, await client.readSentPicture(KEY, `${id}:user`, 0))).toEqual(RED);
    expect(fetched).toEqual([]);
    client.stop();
  });

  it("F-557: at a loopback address nothing is read, and the picture is one this connection can't load", async () => {
    const { fetch, fetched } = live();
    const { client } = await elsewhere(
      fetch,
      [sentRow("m1", "look", [SHOT])],
      "ws://127.0.0.1:19001",
    );
    expect(await client.readSentPicture(KEY, "m1:user", 0)).toEqual({ status: "cannot-load" });
    client.stop();
    const host = await elsewhere(undefined, [sentRow("m1", "look", [SHOT])]);
    expect(await host.client.readSentPicture(KEY, "m1:user", 0)).toEqual({
      status: "cannot-load",
    });
    host.client.stop();
    expect(fetched).toEqual([]);
  });

  it("F-557: only a reference the task's own person's row gave is used: not a bot's row's, not another task's, not one asked for by a viewer", async () => {
    const { fetch, fetched } = live();
    const { client } = await elsewhere(fetch, [
      {
        role: "assistant",
        content: "x",
        idempotencyKey: "a1:user",
        __openclaw: { id: "a1", idempotencyKey: "a1:user", media: [FIRST] },
      },
      sentRow("m1", "look", [SHOT]),
    ]);
    expect(await client.readSentPicture(KEY, "a1:user", 0)).toEqual({ status: "cannot-load" });
    expect(await client.readSentPicture(KEY, "m1:user", 1)).toEqual({ status: "cannot-load" });
    expect(await client.readSentPicture("agent:otto:elsewhere", "m1:user", 0)).toEqual({
      status: "cannot-load",
    });
    // A viewer names a row and a place, never a reference: one that looks like one finds nothing.
    expect(await client.readSentPicture(KEY, SHOT.url, 0)).toEqual({ status: "cannot-load" });
    expect(fetched).toEqual([]);
    client.stop();
  });

  it("F-557: a picture read while the connection changes to another gateway is dropped and not kept", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { fetch: answer } = live();
    const fetch: HttpFetch = async (url, init) => {
      await held;
      return answer(url, init);
    };
    const { client } = await elsewhere(fetch, [sentRow("m1", "look", [SHOT])]);
    const reading = client.readSentPicture(KEY, "m1:user", 0);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    void client.connect({ url: URL_B, token: "t" }).catch(() => {});
    await until(() => client.state.connection.gatewayUrl === URL_B);
    release();
    expect(await reading).toEqual({
      status: "failed",
      message: "The connection changed while this picture was read.",
    });
    expect(client.readBackPictureBytes).toBe(0);
    client.stop();
  });

  it("F-557: a read stamped for another gateway, or for a gateway not yet named, asks for nothing; one for this gateway reads", async () => {
    const { fetch, fetched } = live();
    const { client } = await elsewhere(fetch, [sentRow("m1", "look", [SHOT])], PROTECTED, "gw-a");
    await until(() => client.state.connection.gatewayId === "gw-a");
    const target = client.state.connection.target;
    for (const stamp of [
      { gatewayId: "gw-b", target },
      { gatewayId: null, target },
      { gatewayId: "gw-a", target: target + 1 },
    ])
      expect((await client.readSentPicture(KEY, "m1:user", 0, {}, stamp)).status).toBe("failed");
    expect(fetched).toEqual([]);
    const read = await client.readSentPicture(KEY, "m1:user", 0, {}, { gatewayId: "gw-a", target });
    expect(bytesOf(client, read)).toEqual(RED);
    client.stop();
  });

  it(`F-557: at most ${MAX_READ_BACK_PICTURES} pictures read back are kept, the oldest giving way; they give way to files still to be sent, and go with their task`, async () => {
    const { fetch, fetched } = live();
    const rows = Array.from({ length: MAX_READ_BACK_PICTURES + 1 }, (_, i) =>
      sentRow(`m${i}`, `p${i}`, [SHOT], i + 1),
    );
    const { client, gateway } = await elsewhere(fetch, rows);
    for (let i = 0; i <= MAX_READ_BACK_PICTURES; i += 1)
      expect((await client.readSentPicture(KEY, `m${i}:user`, 0)).status).toBe("content");
    expect(client.readBackPictureBytes).toBe(MAX_READ_BACK_PICTURES * RED.length);
    const reads = fetched.length;
    // The oldest gave way and is read again; the newest is still kept.
    expect((await client.readSentPicture(KEY, `m${MAX_READ_BACK_PICTURES}:user`, 0)).status).toBe(
      "content",
    );
    expect(fetched).toHaveLength(reads);
    expect((await client.readSentPicture(KEY, "m0:user", 0)).status).toBe("content");
    expect(fetched).toHaveLength(reads + 2);
    // Files still to be sent take the room first.
    gateway.handlers["chat.send"] = () => new Promise(() => {});
    const padding = (n: number) => ({
      type: "file" as const,
      mimeType: "application/octet-stream",
      fileName: "big.bin",
      content:
        "A".repeat(4 * Math.ceil(n / 3) - ((3 - (n % 3)) % 3)) + "=".repeat((3 - (n % 3)) % 3),
    });
    const half = MAX_RETAINED_ATTACHMENT_BYTES / 2;
    client.sendMessage(KEY, "big", { attachments: [padding(half)] });
    expect(client.readBackPictureBytes).toBe(MAX_READ_BACK_PICTURES * RED.length);
    client.sendMessage(KEY, "bigger", { attachments: [padding(half - 2 * RED.length)] });
    expect(client.readBackPictureBytes).toBe(2 * RED.length);
    // A task deleted elsewhere takes its pictures with it.
    gateway.emit("sessions.changed", { sessionKey: KEY, reason: "delete" });
    await until(() => client.readBackPictureBytes === 0);
    client.stop();
  }, 30_000);
});
