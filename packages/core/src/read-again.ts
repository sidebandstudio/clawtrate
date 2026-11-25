// A read the gateway answers as passing is asked again, a few times further apart, while the
// connection it belongs to lasts. A gateway that is starting answers some reads `UNAVAILABLE`
// for a moment (its agent databases change hands during discovery, say); the same read a
// second later succeeds. A refusal (no scope, not found, invalid) is never asked again.

import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { asRecord } from "./mapping.ts";

/** How many more times a read answered as passing is asked, after the first. */
export const READ_AGAIN_TRIES = 4;
/** The wait before the first try again; each later wait doubles (1, 2, 4, 8 seconds). */
export const READ_AGAIN_MS = 1_000;
/** No wait is longer, whatever the gateway asks for (`retryAfterMs`). */
export const READ_AGAIN_MAX_MS = 8_000;

/**
 * The gateway's answer says the read may succeed if asked again: marked retryable, or
 * `UNAVAILABLE` without a named reason. An `UNAVAILABLE` that names one (`details.code`, an
 * ended session, say) is lasting, and so is every other code.
 */
export function passingAnswer(error: unknown): boolean {
  if (!(error instanceof GatewayProtocolRequestError)) return false;
  if (error.retryable) return true;
  return error.gatewayCode === "UNAVAILABLE" && asRecord(error.details)?.code === undefined;
}

/**
 * Read, and while the answer is passing and `current()` holds (the same connection, the same
 * gateway), read again after a growing wait, at most `tries` more times. Anything else, or
 * the last answer, is thrown as it came. A try whose connection ended is never made.
 */
export async function readAgain<T>(
  read: () => Promise<T>,
  current: () => boolean,
  options: { tries?: number | undefined; firstMs?: number | undefined } = {},
): Promise<T> {
  const tries = options.tries ?? READ_AGAIN_TRIES;
  const firstMs = options.firstMs ?? READ_AGAIN_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= tries || !passingAnswer(error) || !current()) throw error;
      const asked = (error as GatewayProtocolRequestError).retryAfterMs ?? 0;
      const wait = Math.min(Math.max(firstMs * 2 ** attempt, asked), READ_AGAIN_MAX_MS);
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
      if (!current()) throw error;
    }
  }
}
