// A picture a bot handed over in a task, read for the conversation (F-519).
//
// The gateway puts an `image` block with an `artifactId` on the bot's message
// (for `image_generate`, on the message of the turn it starts by itself when
// the picture is ready). `artifacts.download` turns that id into a path on the
// gateway's own origin with a ticket that lasts five minutes. Only that answer,
// in that exact form, is fetched, by the host: never an address a message
// names, and the ticketed address never reaches a viewer (docs/decisions.md,
// "Addresses a gateway hands the client"). The bytes are bounded, must be one
// of a few picture types, and must start as that type does.

import { asRecord } from "./mapping.ts";
import type { FileTransferStart, FileTransfers } from "./files.ts";
import type { HttpFetch } from "./host.ts";

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

const failed = (message: string): ChatPictureRead => ({ status: "failed", message });

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

/** One picture of the task, by the id its message gave, read whole or not at all. */
export async function readChatPicture(
  ctx: ChatPictureContext,
  key: string,
  artifactId: string,
): Promise<ChatPictureRead> {
  if (!ctx.fetch) return failed("This device can't load pictures from the gateway.");
  const origin = gatewayOrigin(ctx.gatewayUrl);
  if (!origin) return failed("This connection can't load pictures from the gateway.");
  let answer: Record<string, unknown> | null;
  try {
    answer = asRecord(await ctx.request("artifacts.download", { sessionKey: key, artifactId }));
  } catch (error) {
    return failed(
      `The gateway didn't give this picture: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const path = issuedPath(key, answer?.url);
  const expires = expiry(answer?.expiresAt);
  if (!path || expires === null || !(expires > ctx.now()))
    return failed("The gateway didn't give a download for this picture.");

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
          ? "The gateway refused this picture's download ticket."
          : `The gateway answered ${response.status} for this picture.`,
      );
    }
    const mimeType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim();
    const declared = Number(response.headers.get("content-length") ?? NaN);
    if (!SIGNATURES[mimeType]) {
      await response.body?.cancel().catch(() => {});
      return failed("The gateway sent something that isn't a picture this app shows.");
    }
    if (declared > MAX_PICTURE_BYTES) {
      await response.body?.cancel().catch(() => {});
      return failed("This picture is larger than Clawtrate shows: pictures up to 5 MB.");
    }
    const reader = response.body?.getReader();
    if (!reader) return failed("The gateway sent no picture.");
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.length;
      if (size > MAX_PICTURE_BYTES) {
        await reader.cancel().catch(() => {});
        return failed("This picture is larger than Clawtrate shows: pictures up to 5 MB.");
      }
      parts.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.length;
    }
    if (!matchesType(mimeType, bytes))
      return failed("The gateway sent something that isn't a picture this app shows.");
    // Refused here, not by the gateway: the transfer's own reason, never "couldn't be reached".
    let transfer: FileTransferStart;
    try {
      transfer = ctx.transfers.start(ctx.owner, bytes, ctx.maxChars);
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error));
    }
    return { status: "content", kind: "image", mimeType, bytes: size, transfer };
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
    return failed(
      controller.signal.aborted
        ? "The picture took too long to arrive."
        : cause === "unexpected redirect"
          ? "The gateway sent this picture somewhere else, and Clawtrate doesn't follow that."
          : "The gateway couldn't be reached for this picture.",
    );
  } finally {
    clearTimeout(timer);
  }
}
