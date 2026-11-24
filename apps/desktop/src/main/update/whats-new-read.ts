// Reads whats-new.json (F-554) as the feed is read: one bounded GET, no redirect.

import { open, readAll, Transfer } from "./fetch.ts";
import {
  MAX_WHATS_NEW_BYTES,
  parseWhatsNew,
  WHATS_NEW_TIMEOUT_MS,
  whatsNewAddress,
  type BuildNotes,
} from "./whats-new.ts";

/**
 * Reads whats-new.json beside `feed`: one GET, no redirect, at most 128 KiB,
 * five seconds in all. Resolves with its builds, or null for any failure.
 */
export async function readWhatsNew(
  feed: URL,
  userAgent: string,
  limits: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<BuildNotes[] | null> {
  const maxBytes = Math.min(limits.maxBytes ?? MAX_WHATS_NEW_BYTES, MAX_WHATS_NEW_BYTES);
  const timeoutMs = Math.min(limits.timeoutMs ?? WHATS_NEW_TIMEOUT_MS, WHATS_NEW_TIMEOUT_MS);
  const transfer = new Transfer(timeoutMs, timeoutMs);
  try {
    const response = await open(whatsNewAddress(feed), transfer, maxBytes, userAgent);
    const body = await readAll(response, transfer, maxBytes);
    // A file that is not valid UTF-8 is no list: a lenient decode would show its
    // bad bytes as replacement characters, which the title rule accepts.
    return parseWhatsNew(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return null;
  } finally {
    transfer.done();
  }
}
