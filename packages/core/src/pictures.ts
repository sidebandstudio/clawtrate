// A picture a bot handed over in a task, read for the conversation (F-535).
//
// The gateway puts an `image` block with an `artifactId` on the bot's message
// (for `image_generate`, on the message of the turn it starts by itself when
// the picture is ready). `artifacts.download` turns that id into a path on the
// gateway's own origin with a ticket that lasts five minutes. Only that answer,
// in that exact form, is fetched, by the host: never an address a message
// names, and the ticketed address never reaches a viewer (docs/decisions.md,
// "Addresses a gateway hands the client"). The bytes are bounded, must be one
// of a few picture types, and must start as that type does.
//
// A picture a person sent shows from this app's own copy while it holds one.
// Without one, the host reads it back from the gateway's media route
// (`fetchInboundPicture`), and only at a protected address: see that function.

import { fromBase64 } from "./bytes.ts";
import { protectedGatewayUrl } from "./gateway-url.ts";
import { asRecord, inboundRef } from "./mapping.ts";
import type { FileTransferStart, FileTransfers } from "./files.ts";
import type { HttpFetch, HttpResponseLike } from "./host.ts";

/** The largest picture shown: Clawtrate's limit for any file it hands a viewer. */
export const MAX_PICTURE_BYTES = 5_242_880;
/** How long the fetch may take, from asking to the last byte. */
export const PICTURE_FETCH_MS = 30_000;

/** The picture types a conversation draws, and how each one's bytes begin. */
const SIGNATURES: Record<string, number[][]> = {
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/gif": [
    [0x47, 0x49, 0x46, 0x38, 0x37, 0x61],
    [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  ],
  // "RIFF", four bytes of length, then "WEBP".
  "image/webp": [[0x52, 0x49, 0x46, 0x46, -1, -1, -1, -1, 0x57, 0x45, 0x42, 0x50]],
};

export type ChatPictureRead =
  | {
      status: "content";
      kind: "image";
      mimeType: string;
      /** The exact number of bytes fetched. */
      bytes: number;
      transfer: FileTransferStart;
    }
  | { status: "failed"; message: string };

export type ChatPictureContext = {
  request: (method: string, params: unknown) => Promise<unknown>;
  fetch: HttpFetch | null;
  /** The connection's address (`ws:` or `wss:`): its origin is the gateway's. */
  gatewayUrl: string;
  transfers: FileTransfers;
  owner: object;
  maxChars?: number | undefined;
  now: () => number;
};

/**
 * A picture a person sent (`readSentPicture`), from this app's own copy or read
 * back from the gateway: the same answer as a bot's, where `failed` is a read
 * that may work if tried again; `not-a-picture` when its bytes aren't one of the
 * types drawn or it is over 5 MB, whatever it was named; `cannot-load` when this
 * app holds no copy and can't read it back over this connection; `gone` when the
 * gateway said it no longer has it.
 */
export type SentPictureRead =
  ChatPictureRead | { status: "not-a-picture" } | { status: "cannot-load" } | { status: "gone" };

const failed = (message: string): ChatPictureRead => ({ status: "failed", message });

const TOO_LARGE = "This picture is larger than Clawtrate shows: pictures up to 5 MB.";
const NOT_SHOWN = "The gateway sent something that isn't a picture this app shows.";

/** Whether a conversation draws pictures of this type (PNG, JPEG, GIF or WebP). */
export function isShownPictureType(mimeType: string | null | undefined): boolean {
  return typeof mimeType === "string" && Object.hasOwn(SIGNATURES, mimeType.toLowerCase());
}

/** A file's bytes are one of the picture types drawn, as it is named. */
export function isDrawnPicture(mimeType: string, bytes: Uint8Array | null): boolean {
  return (
    isShownPictureType(mimeType) && bytes !== null && matchesType(mimeType.toLowerCase(), bytes)
  );
}

/**
 * A picture this app sent, from the copy it sent, held to the same rules as
 * one the gateway gives: one of the types drawn, at most `MAX_PICTURE_BYTES`,
 * starting as its type does. Nothing is fetched.
 */
export function ownPictureRead(
  file: { mimeType: string; content: string },
  start: (bytes: Uint8Array) => FileTransferStart,
): SentPictureRead {
  const mimeType = file.mimeType.toLowerCase();
  const bytes = fromBase64(file.content);
  if (!bytes || !isDrawnPicture(mimeType, bytes)) return { status: "not-a-picture" };
  if (bytes.length > MAX_PICTURE_BYTES) return failed(TOO_LARGE);
  try {
    return {
      status: "content",
      kind: "image",
      mimeType,
      bytes: bytes.length,
      transfer: start(bytes),
    };
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}

/** The gateway's own HTTP origin, from the connection's address; null for anything else. */
export function gatewayOrigin(gatewayUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(gatewayUrl);
  } catch {
    return null;
  }
  const scheme = url.protocol === "ws:" ? "http:" : url.protocol === "wss:" ? "https:" : null;
  return scheme && url.host ? `${scheme}//${url.host}` : null;
}

/**
 * The path of a download the gateway issued for this task, exactly as
 * `artifacts.download` writes a managed one: the task's own session, the
 * attachment, `full`, and a `v1` ticket, with nothing else. Null otherwise.
 */
export function issuedPath(key: string, url: unknown): string | null {
  if (typeof url !== "string" || url.length > 4096) return null;
  const match =
    /^\/api\/chat\/media\/outgoing\/([^/?#]+)\/([A-Za-z0-9_-]+)\/full\?mediaTicket=v1\.[A-Za-z0-9._~-]+$/.exec(
      url,
    );
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!) === key ? url : null;
  } catch {
    return null;
  }
}

/** The bytes start as their declared type's do. */
export function matchesType(mimeType: string, bytes: Uint8Array): boolean {
  return (SIGNATURES[mimeType] ?? []).some(
    (signature) =>
      bytes.length >= signature.length &&
      signature.every((byte, index) => byte < 0 || bytes[index] === byte),
  );
}

/** An ISO timestamp, as the gateway writes `expiresAt`; anything else is no expiry. */
const expiry = (value: unknown): number | null =>
  typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(value)
    ? Date.parse(value)
    : null;

/**
 * A picture's bytes from a 200 answer, read whole or not at all: the answer's
 * type must be one drawn, at most `MAX_PICTURE_BYTES` declared and read, and the
 * bytes must start as that type does. The body is cancelled on any refusal.
 */
async function readPictureBody(
  response: HttpResponseLike,
): Promise<{ mimeType: string; bytes: Uint8Array } | "not-a-picture" | "too-large" | "empty"> {
  // Media types are case-insensitive (RFC 9110): `Image/PNG` is a PNG, still checked by its bytes.
  const mimeType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const declared = Number(response.headers.get("content-length") ?? NaN);
  if (!SIGNATURES[mimeType]) {
    await response.body?.cancel().catch(() => {});
    return "not-a-picture";
  }
  if (declared > MAX_PICTURE_BYTES) {
    await response.body?.cancel().catch(() => {});
    return "too-large";
  }
  const bytes = await readAtMost(response, MAX_PICTURE_BYTES);
  if (bytes === "empty" || bytes === "too-large") return bytes;
  // A body that ended before any byte is no picture yet: a read to try again.
  if (bytes.length === 0) return "empty";
  return matchesType(mimeType, bytes) ? { mimeType, bytes } : "not-a-picture";
}

/** A body of at most `max` bytes, whole; cancelled once it passes `max`. */
async function readAtMost(
  response: HttpResponseLike,
  max: number,
): Promise<Uint8Array | "empty" | "too-large"> {
  const reader = response.body?.getReader();
  if (!reader) return "empty";
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return "too-large";
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

/** What a download the gateway issued gave: its bytes and their type, or why not. */
export type IssuedBytes =
  | { ok: true; mimeType: string; bytes: Uint8Array }
  | { ok: false; tooLarge: boolean; message: string };

/** What a read calls the thing it reads, and what it takes. */
export type IssuedRead = {
  /** "picture" or "file", in the read's messages. */
  noun: string;
  maxBytes: number;
  /** Said when it is over `maxBytes`. */
  tooLarge: string;
  /** Whether a response of this (lower-cased) type is read at all. */
  accepts: (mimeType: string) => boolean;
  /** Said when it isn't. */
  refused: string;
};

/**
 * One file of the task, by the id its message gave, through the download the
 * gateway issues for it (`artifacts.download`), read whole or not at all.
 */
export async function readIssued(
  ctx: ChatPictureContext,
  key: string,
  artifactId: string,
  read: IssuedRead,
): Promise<IssuedBytes> {
  const { noun } = read;
  const failed = (message: string, tooLarge = false): IssuedBytes => ({
    ok: false,
    tooLarge,
    message,
  });
  if (!ctx.fetch) return failed(`This device can't load ${noun}s from the gateway.`);
  const origin = gatewayOrigin(ctx.gatewayUrl);
  if (!origin) return failed(`This connection can't load ${noun}s from the gateway.`);
  let answer: Record<string, unknown> | null;
  try {
    answer = asRecord(await ctx.request("artifacts.download", { sessionKey: key, artifactId }));
  } catch (error) {
    return failed(
      `The gateway didn't give this ${noun}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const path = issuedPath(key, answer?.url);
  const expires = expiry(answer?.expiresAt);
  if (!path || expires === null || !(expires > ctx.now()))
    return failed(`The gateway didn't give a download for this ${noun}.`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PICTURE_FETCH_MS);
  try {
    const response = await ctx.fetch(`${origin}${path}`, {
      method: "GET",
      redirect: "error",
      credentials: "omit",
      signal: controller.signal,
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      return failed(
        response.status === 401
          ? `The gateway refused this ${noun}'s download ticket.`
          : `The gateway answered ${response.status} for this ${noun}.`,
      );
    }
    // Media types are case-insensitive (RFC 9110): `Image/PNG` is a PNG, still checked by its bytes.
    const mimeType = (response.headers.get("content-type") ?? "")
      .split(";")[0]!
      .trim()
      .toLowerCase();
    const declared = Number(response.headers.get("content-length") ?? NaN);
    if (!read.accepts(mimeType)) {
      await response.body?.cancel().catch(() => {});
      return failed(read.refused);
    }
    if (declared > read.maxBytes) {
      await response.body?.cancel().catch(() => {});
      return failed(read.tooLarge, true);
    }
    const bytes = await readAtMost(response, read.maxBytes);
    if (bytes === "empty") return failed(`The gateway sent no ${noun}.`);
    if (bytes === "too-large") return failed(read.tooLarge, true);
    return { ok: true, mimeType, bytes };
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
    return failed(
      controller.signal.aborted
        ? `The ${noun} took too long to arrive.`
        : cause === "unexpected redirect"
          ? `The gateway sent this ${noun} somewhere else, and Clawtrate doesn't follow that.`
          : `The gateway couldn't be reached for this ${noun}.`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** One picture of the task, by the id its message gave, read whole or not at all. */
export async function readChatPicture(
  ctx: ChatPictureContext,
  key: string,
  artifactId: string,
): Promise<ChatPictureRead> {
  const read = await readIssued(ctx, key, artifactId, {
    noun: "picture",
    maxBytes: MAX_PICTURE_BYTES,
    tooLarge: TOO_LARGE,
    accepts: (mimeType) => Object.hasOwn(SIGNATURES, mimeType),
    refused: NOT_SHOWN,
  });
  if (!read.ok) return failed(read.message);
  const { mimeType, bytes } = read;
  // A body that ended before any byte is no picture yet: a read to try again.
  if (bytes.length === 0) return failed("The gateway sent no picture.");
  if (!matchesType(mimeType, bytes)) return failed(NOT_SHOWN);
  // Refused here, not by the gateway: the transfer's own reason, never "couldn't be reached".
  let transfer: FileTransferStart;
  try {
    transfer = ctx.transfers.start(ctx.owner, bytes, ctx.maxChars);
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
  return { status: "content", kind: "image", mimeType, bytes: bytes.length, transfer };
}

// A person's own picture, read back from the gateway (#469) ----------------------------------

/** The gateway's route for a person's attached media, at its origin's root (OpenClaw 2026.10.6). */
export const INBOUND_MEDIA_ROUTE = "/__openclaw__/assistant-media";
/** The most the ticket's answer may be. */
export const MAX_TICKET_ANSWER_BYTES = 4096;

/**
 * Whether a person's picture may be read back over this connection's address: `wss://`, not
 * loopback (`protectedGatewayUrl`), and the origin's root itself, with no path and no query. A
 * gateway reached under a path sits behind something else at that origin, whose root was never
 * shown to be the gateway, so nothing is asked there.
 */
export function readBackAddress(gatewayUrl: string): boolean {
  if (!protectedGatewayUrl(gatewayUrl)) return false;
  try {
    const url = new URL(gatewayUrl.trim());
    return (url.pathname === "" || url.pathname === "/") && url.search === "";
  } catch {
    return false;
  }
}

/** A query of the route's own parameters, each value encoded whole. */
const queryOf = (query: Record<string, string>) =>
  Object.entries(query)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("&");

/** What the host needs to read a person's picture back: the connection's token goes on one request. */
export type InboundPictureContext = {
  fetch: HttpFetch | null;
  /** The connection's address: only a protected one (`protectedGatewayUrl`) is read from. */
  gatewayUrl: string;
  /** This device's token for that gateway, or null when it has none. */
  token: string | null;
  now: () => number;
};

/** A picture read back whole; the caller hands it to the viewer (`readSentPicture`). */
export type InboundPictureRead =
  | { status: "bytes"; mimeType: string; bytes: Uint8Array }
  | Exclude<SentPictureRead, { status: "content" }>;

const CANNOT_LOAD = { status: "cannot-load" } as const;
const retry = (message: string) => ({ status: "failed", message }) as const;
const NOT_A_PICTURE = { status: "not-a-picture" } as const;

/**
 * A person's own picture, by the reference their row gave, from the gateway's media route. Used
 * only when the connection's address is `wss://` and not loopback, over HTTPS to that same
 * origin, following no redirect, and with the task's own session key, which the ticket is bound
 * to. Two GETs: the first carries this device's token in `Authorization`, never in the address,
 * and answers with a five-minute ticket; the second carries the ticket and no token, and answers
 * with the bytes. Both share `PICTURE_FETCH_MS`. The bytes are held to the rules for any picture.
 *
 * `cannot-load` covers what trying again won't change: an address that doesn't qualify, no
 * token, a redirect, a refusal, and any answer that isn't the route's own, as when the gateway
 * serves its routes under a base path. `gone` is only the gateway's own `available: false`.
 */
export async function fetchInboundPicture(
  ctx: InboundPictureContext,
  key: string,
  ref: string,
): Promise<InboundPictureRead> {
  const origin = gatewayOrigin(ctx.gatewayUrl);
  const source = inboundRef(ref);
  if (
    !ctx.fetch ||
    !ctx.token ||
    !source ||
    !readBackAddress(ctx.gatewayUrl) ||
    !origin?.startsWith("https://")
  )
    return CANNOT_LOAD;
  const route = `${origin}${INBOUND_MEDIA_ROUTE}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PICTURE_FETCH_MS);
  const get = (query: Record<string, string>, token: string | null) =>
    ctx.fetch!(`${route}?${queryOf(query)}`, {
      method: "GET",
      redirect: "error",
      credentials: "omit",
      signal: controller.signal,
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });
  try {
    const meta = await get({ meta: "1", source, sessionKey: key }, ctx.token);
    if (meta.status !== 200) {
      await meta.body?.cancel().catch(() => {});
      // A busy or failing gateway may answer next time; a refusal or a missing route won't.
      return meta.status >= 500 || meta.status === 408 || meta.status === 429
        ? retry(`The gateway answered ${meta.status} for this picture.`)
        : CANNOT_LOAD;
    }
    const type = (meta.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/json") {
      await meta.body?.cancel().catch(() => {});
      return CANNOT_LOAD;
    }
    const raw = await readAtMost(meta, MAX_TICKET_ANSWER_BYTES);
    // The route's answer is ASCII JSON: anything else isn't its answer.
    if (typeof raw === "string" || raw.some((byte) => byte > 0x7e)) return CANNOT_LOAD;
    let answer: Record<string, unknown> | null;
    try {
      answer = asRecord(JSON.parse(String.fromCharCode(...raw)));
    } catch {
      return CANNOT_LOAD;
    }
    if (answer?.available === false) return { status: "gone" };
    if (answer?.available !== true) return CANNOT_LOAD;
    const named = typeof answer.mimeType === "string" ? answer.mimeType.toLowerCase() : null;
    const size = answer.sizeBytes;
    if (!isShownPictureType(named) || (typeof size === "number" && size > MAX_PICTURE_BYTES))
      return NOT_A_PICTURE;
    const ticket = answer.mediaTicket;
    if (
      typeof ticket !== "string" ||
      !/^v1\.[A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{1,512}$/.test(ticket)
    )
      return CANNOT_LOAD;
    const expires = expiry(answer.mediaTicketExpiresAt);
    if (expires === null || !(expires > ctx.now()))
      return retry("The gateway's ticket for this picture had already run out.");

    const response = await get({ source, sessionKey: key, mediaTicket: ticket }, null);
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      return retry(`The gateway answered ${response.status} for this picture.`);
    }
    const body = await readPictureBody(response);
    if (body === "empty") return retry("The gateway sent no picture.");
    return typeof body === "string" ? NOT_A_PICTURE : { status: "bytes", ...body };
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
    if (cause === "unexpected redirect") return CANNOT_LOAD;
    return retry(
      controller.signal.aborted
        ? "The picture took too long to arrive."
        : "The gateway couldn't be reached for this picture.",
    );
  } finally {
    clearTimeout(timer);
  }
}
