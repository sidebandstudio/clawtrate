// Scenarios ported from T3 Code's packages/client-runtime/src/connection/supervisor.test.ts at
// commit 18d1c4db96696dea89f83a209ff5675a773ad5ea, against the plain policy here. Each names
// the T3 test it follows.
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

import { describe, expect, it } from "vitest";
import {
  APPROVAL_PENDING_FAST_RETRIES,
  APPROVAL_PENDING_RETRY_DELAY_MS,
  BACKOFF_RESET_AFTER_MS,
  RelayReconnectPolicy,
  RETRY_MAX_DELAY_MS,
  retryDelayMs,
  type RetryDecision,
} from "../src/relay/reconnect.ts";

function delay(decision: RetryDecision): number {
  if (!decision.retry) throw new Error("stopped");
  return decision.delayMs;
}

describe("relay reconnect policy", () => {
  it("backs off exponentially with jitter, up to a ceiling", () => {
    const low = new RelayReconnectPolicy({ random: () => 0 });
    const high = new RelayReconnectPolicy({ random: () => 1 });
    const lows = Array.from({ length: 12 }, () => delay(low.failed("transient", 0)));
    const highs = Array.from({ length: 12 }, () => delay(high.failed("transient", 0)));
    expect(lows.slice(0, 5)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    expect(highs.slice(0, 5)).toEqual([2_000, 4_000, 8_000, 16_000, 32_000]);
    expect(Math.max(...highs)).toBe(RETRY_MAX_DELAY_MS);
    expect(lows.at(-1)).toBe(RETRY_MAX_DELAY_MS / 2);
    // Jitter lands between half and all of the ceiling.
    const mid = new RelayReconnectPolicy({ random: () => 0.5 });
    expect(delay(mid.failed("transient", 0))).toBe(1_500);
    expect(retryDelayMs(30, 0.25)).toBe(Math.round(RETRY_MAX_DELAY_MS * 0.625));
  });

  // "treats an involuntary session close as transient and reconnects"
  it("retries the first loss of an open session almost at once", () => {
    const policy = new RelayReconnectPolicy({ random: () => 1 });
    policy.opened(0);
    expect(delay(policy.failed("transient", 1_000))).toBe(250);
    // The ladder still counted it: a connector that keeps dropping backs off.
    // (T3 counts the fast retry toward backoff too.)
    policy.opened(2_000);
    expect(delay(policy.failed("transient", 3_000))).toBe(4_000);
    policy.opened(4_000);
    expect(delay(policy.failed("transient", 5_000))).toBe(8_000);
  });

  // "restarts the retry ladder" after a stable session (BACKOFF_RESET_AFTER_MS)
  it("resets the ladder only after a confirmed open that lasted 30 seconds", () => {
    const policy = new RelayReconnectPolicy({ random: () => 1 });
    for (let i = 0; i < 5; i++) policy.failed("transient", 0);
    expect(policy.failures).toBe(5);
    policy.opened(10_000);
    // Shorter than 30 s: no reset, the next wait keeps climbing.
    expect(delay(policy.failed("transient", 10_000 + BACKOFF_RESET_AFTER_MS - 1))).toBe(64_000);
    policy.opened(100_000);
    expect(delay(policy.failed("transient", 100_000 + BACKOFF_RESET_AFTER_MS))).toBe(250);
    expect(policy.failures).toBe(1);
  });

  // "checks back on a pending approval every few seconds instead of backing off"
  it("checks back on a pending approval every 4 seconds, and an outage after starts low", () => {
    const policy = new RelayReconnectPolicy({ random: () => 1 });
    for (let attempt = 1; attempt <= 8; attempt++) {
      expect(delay(policy.failed("approval-pending", 0))).toBe(APPROVAL_PENDING_RETRY_DELAY_MS);
    }
    expect(delay(policy.failed("transient", 0))).toBeLessThanOrEqual(2_000);
  });

  // "backs off a device nobody approved once its request has expired"
  it("backs off a device nobody approved once its request has expired", () => {
    const policy = new RelayReconnectPolicy({ random: () => 1 });
    const delays = Array.from({ length: 156 }, () => delay(policy.failed("approval-pending", 0)));
    expect(delays.slice(0, APPROVAL_PENDING_FAST_RETRIES).every((d) => d === 4_000)).toBe(true);
    expect(delays.slice(APPROVAL_PENDING_FAST_RETRIES).every((d) => d >= 4_000)).toBe(true);
    expect(delays.at(-1)).toBeGreaterThanOrEqual(32_000);
  });

  // "keeps a blocked host idle until an external signal requests another attempt"
  it("stops on a permanent refusal until the person retries", () => {
    const policy = new RelayReconnectPolicy({ random: () => 0 });
    policy.failed("transient", 0);
    expect(policy.failed("permanent", 0)).toEqual({ retry: false, reason: "permanent" });
    expect(policy.stopped).toBe(true);
    // Nothing on its own starts it again.
    expect(policy.failed("transient", 3_600_000)).toEqual({ retry: false, reason: "permanent" });
    policy.reset();
    expect(policy.stopped).toBe(false);
    expect(delay(policy.failed("transient", 0))).toBe(1_000);
  });

  // "explicit retry interrupts the current backoff"
  it("an explicit retry starts again from the bottom", () => {
    const policy = new RelayReconnectPolicy({ random: () => 1 });
    for (let i = 0; i < 10; i++) policy.failed("transient", 0);
    policy.reset();
    expect(delay(policy.failed("transient", 0))).toBe(2_000);
  });

  // "does not report a session lost while suspended as a failed connection": a lost session's
  // replacement starts as a first loss, not on the ladder where earlier failures left it.
  it("a session that came up clears what earlier failures built only once it was stable", () => {
    const policy = new RelayReconnectPolicy({ random: () => 1 });
    policy.failed("transient", 0);
    policy.failed("transient", 0);
    policy.opened(0);
    // Not stable and not the first failure: no fast retry.
    expect(delay(policy.failed("transient", 1_000))).toBe(8_000);
  });
});
