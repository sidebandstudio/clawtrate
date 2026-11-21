// Ported from T3 Code, packages/client-runtime/src/connection/supervisor.ts at commit
// 18d1c4db96696dea89f83a209ff5675a773ad5ea (the retry ladder: `retryDelayMs`, the constants,
// and the failure handling of `run`), rewritten in plain TypeScript without Effect.
//
// Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software
// and associated documentation files (the "Software"), to deal in the Software without
// restriction, including without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
// Software is furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
// BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

/** The first retry waits between half and all of twice this. */
export const RETRY_BASE_DELAY_MS = 1_000;
/** No retry waits longer. */
export const RETRY_MAX_DELAY_MS = 300_000;
/** The first loss of a live session retries almost at once, jittered between half and all of it. */
export const SESSION_LOSS_RETRY_DELAY_MS = 250;
/** Someone is approving this device; check back soon rather than climbing the ladder. */
export const APPROVAL_PENDING_RETRY_DELAY_MS = 4_000;
/** A request lives 10 minutes; past that nobody is approving, so a forgotten device backs off. */
export const APPROVAL_PENDING_FAST_RETRIES = 150;
/** A confirmed open that lasted this long starts the ladder again from the bottom. */
export const BACKOFF_RESET_AFTER_MS = 30_000;

/**
 * Why an attempt ended:
 * - `transient`: the relay, the connector or the network; try again with backoff;
 * - `approval-pending`: the gateway is waiting for the owner to approve this device;
 * - `permanent`: the connector refused this phone (not enrolled, or the enrollment was
 *   refused). Trying again changes nothing until the person does something.
 */
export type RelayFailure = "transient" | "approval-pending" | "permanent";

export type RetryDecision =
  | { readonly retry: true; readonly delayMs: number }
  | { readonly retry: false; readonly reason: "permanent" };

/** The jittered exponential delay after `failureCount` earlier failures (T3's `retryDelayMs`). */
export function retryDelayMs(failureCount: number, random: number): number {
  const ceiling = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (failureCount + 1));
  return Math.round(ceiling / 2 + (ceiling / 2) * random);
}

/**
 * When to dial a relay route again. It does no I/O and keeps no timer: the host reports each
 * confirmed open (`opened`, on the connector's admission) and each end of an attempt
 * (`failed`), and waits the delay it is given.
 *
 * - Backoff is exponential with jitter, from 1–2 s up to a ceiling of 5 minutes.
 * - The first loss of a session that had opened retries after 125–250 ms; the ladder still
 *   counts it, so a connector that keeps dropping sessions backs off.
 * - A confirmed open that lasted 30 s resets the ladder. A shorter one does not, so a session
 *   that opens and drops at once cannot retry in a tight loop.
 * - A pending approval is checked every 4 s for 10 minutes without climbing the ladder, then
 *   backs off, never faster than every 4 s.
 * - A permanent refusal stops. `reset` (the person's retry, the app coming to the foreground)
 *   starts again from the bottom.
 */
export class RelayReconnectPolicy {
  readonly #random: () => number;
  #failureCount = 0;
  /** Approval waits count as attempts but not toward backoff, so a later outage starts low. */
  #backoffFailures = 0;
  #approvalWaits = 0;
  #openedAt: number | null = null;
  #stopped = false;

  constructor(options: { random?: () => number } = {}) {
    this.#random = options.random ?? Math.random;
  }

  /** Attempts since the ladder last started from the bottom. */
  get failures(): number {
    return this.#failureCount;
  }

  /** True after a permanent refusal, until `reset`. */
  get stopped(): boolean {
    return this.#stopped;
  }

  /** The connector admitted the phone: the channel is open end to end. */
  opened(nowMs: number): void {
    this.#openedAt = nowMs;
  }

  /** An attempt ended, before or after it opened. */
  failed(failure: RelayFailure, nowMs: number): RetryDecision {
    const established = this.#openedAt !== null;
    if (this.#openedAt !== null && nowMs - this.#openedAt >= BACKOFF_RESET_AFTER_MS) {
      this.#resetLadder();
    }
    this.#openedAt = null;
    if (failure === "permanent" || this.#stopped) {
      this.#stopped = true;
      return { retry: false, reason: "permanent" };
    }
    const firstLoss = established && this.#failureCount === 0;
    this.#failureCount += 1;
    if (failure === "approval-pending") this.#approvalWaits += 1;
    const awaitingApproval =
      failure === "approval-pending" && this.#approvalWaits <= APPROVAL_PENDING_FAST_RETRIES;
    if (!awaitingApproval) this.#backoffFailures += 1;
    const delayMs = awaitingApproval
      ? APPROVAL_PENDING_RETRY_DELAY_MS
      : firstLoss
        ? Math.round(SESSION_LOSS_RETRY_DELAY_MS * (0.5 + this.#random() / 2))
        : failure === "approval-pending"
          ? Math.max(
              APPROVAL_PENDING_RETRY_DELAY_MS,
              retryDelayMs(this.#backoffFailures - 1, this.#random()),
            )
          : retryDelayMs(this.#backoffFailures - 1, this.#random());
    return { retry: true, delayMs };
  }

  /** The person's retry, or the app coming back: start from the bottom, refusal included. */
  reset(): void {
    this.#resetLadder();
    this.#stopped = false;
    this.#openedAt = null;
  }

  #resetLadder(): void {
    this.#failureCount = 0;
    this.#backoffFailures = 0;
    this.#approvalWaits = 0;
  }
}
