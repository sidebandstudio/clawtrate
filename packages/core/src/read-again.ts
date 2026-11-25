// A read the gateway may answer if asked again is asked again, a few times further apart, while
// the connection it belongs to lasts. A gateway that is starting answers some reads
// `UNAVAILABLE` for a moment (its agent databases change hands during discovery, say); the same
// read a second later succeeds. A refusal (no scope, not found, invalid) is never asked again.
//
// What the gateway says of its answer (OpenClaw 2026.10.6 and 2026.11.10, docs/decisions.md):
// - It marks an answer that may succeed if asked again `retryable: true`, often with a
//   `retryAfterMs` and a `details.code` or `details.reason` saying why (starting up, a session's
//   access refreshing, a database still being inspected).
// - 2026.11.10 names storage failures in `details.code`. `unavailable` (the database connection
//   was lost; "Please retry") comes without the flag and passes. `SQLITE_FULL` (the disk is full)
//   comes with the flag and lasts until someone frees space. `SQLITE_BUSY` and `SQLITE_LOCKED`
//   pass when they are named.
// - Any other error a handler throws comes as `UNAVAILABLE` with no flag and no reason, in both
//   versions: the gateway doesn't say whether it passes. It is asked again within the same
//   bound, but never called passing.

import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { asRecord } from "./mapping.ts";

/** How many more times a read is asked, after the first. */
export const READ_AGAIN_TRIES = 4;
/** The wait before the first try again; each later wait doubles (1, 2, 4, 8 seconds). */
export const READ_AGAIN_MS = 1_000;
/** No wait is longer, whatever the gateway asks for (`retryAfterMs`). */
export const READ_AGAIN_MAX_MS = 8_000;

/** A reason the gateway names that passes, though it doesn't mark it retryable. */
function passingReason(reason: string): boolean {
  return reason === "unavailable" || reason === "SQLITE_BUSY" || reason === "SQLITE_LOCKED";
}

/** A reason that lasts until someone acts, though the gateway marks it retryable. */
function lastingReason(reason: string): boolean {
  return reason === "SQLITE_FULL";
}

/**
 * What an answer says about asking again: `passing`, the gateway says it may succeed soon;
 * `unclassified`, an `UNAVAILABLE` the gateway gives no reason for; `lasting`, anything else
 * (a refusal, a named lasting reason, or no answer from the gateway at all).
 */
export type AnswerKind = "passing" | "unclassified" | "lasting";

export function answerKind(error: unknown): AnswerKind {
  if (!(error instanceof GatewayProtocolRequestError)) return "lasting";
  const details = asRecord(error.details);
  const named = typeof details?.code === "string" ? details.code : details?.reason;
  const reason = typeof named === "string" ? named : null;
  if (reason !== null && lastingReason(reason)) return "lasting";
  if (error.retryable) return "passing";
  if (error.gatewayCode !== "UNAVAILABLE") return "lasting";
  if (reason === null) return details?.code === undefined ? "unclassified" : "lasting";
  return passingReason(reason) ? "passing" : "lasting";
}

/** Asked again: an answer the gateway marks as passing, or gives no reason for. */
export function askedAgain(error: unknown): boolean {
  return answerKind(error) !== "lasting";
}

/**
 * Read, and while the answer may pass (`askedAgain`) and `current()` holds (the same
 * connection, the same gateway), read again after a growing wait, at most `tries` more times.
 * Anything else, or the last answer, is thrown as it came. A wait ends early when `ended`
 * settles (the connection it belongs to has ended), and a try whose connection ended is never
 * made.
 */
export async function readAgain<T>(
  read: () => Promise<T>,
  current: () => boolean,
  options: {
    tries?: number | undefined;
    firstMs?: number | undefined;
    ended?: Promise<unknown> | undefined;
  } = {},
): Promise<T> {
  const tries = options.tries ?? READ_AGAIN_TRIES;
  const firstMs = options.firstMs ?? READ_AGAIN_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= tries || !askedAgain(error) || !current()) throw error;
      const asked = (error as GatewayProtocolRequestError).retryAfterMs ?? 0;
      const wait = Math.min(Math.max(firstMs * 2 ** attempt, asked), READ_AGAIN_MAX_MS);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait);
        void options.ended?.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (!current()) throw error;
    }
  }
}
