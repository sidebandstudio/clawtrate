// Every lock claim is worded from its evidence and that evidence's age
// (docs/design/bots.md, section 10): a current reading is "Locked"; one last
// confirmed before a failed or unavailable read, or read offline, before this
// connection or long ago, is "as of" its time.

import type { BotBinding, LockEvidence } from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { bindingWord, clock, LOCK_OLD_MS, lockClaim, lockText, usedBy } from "../src/bots/words.ts";

const NOW = Date.UTC(2026, 10, 17, 17, 41);

const locked = (evidence: Partial<LockEvidence>): BotBinding => ({
  botId: "otto",
  primary: "acme/dev-1@acme:work",
  provider: "acme",
  model: "dev-1",
  account: "acme:work",
  mode: "account",
  fallbacks: [],
  suffixLost: false,
  accountMissing: false,
  effort: null,
  order: { ids: ["acme:work"], stored: true, configured: null },
  evidence: {
    status: "matched",
    checkedAt: NOW - 1_000,
    lastMatchAt: NOW - 1_000,
    lostAt: null,
    readSeq: null,
    attemptSeq: null,
    readGateway: null,
    error: null,
    ...evidence,
  },
  fallbacksUnwritten: false,
});

const fresh = { now: NOW, connected: true, connectedAt: NOW - 60_000 };

describe("lock claims", () => {
  it("a current reading is Locked, with no time", () => {
    expect(lockClaim(locked({}), fresh)).toEqual({ asOf: null });
    expect(bindingWord(locked({}), fresh)).toBe("Locked");
  });

  it("a lock last confirmed before a failed or unavailable read is as of that confirmation", () => {
    for (const status of ["failed", "unavailable"] as const) {
      const claim = lockClaim(locked({ status, lastMatchAt: NOW - 5_000 }), fresh);
      expect(claim).toEqual({ asOf: NOW - 5_000 });
      expect(lockText(claim!)).toBe(`Locked, as of ${clock(NOW - 5_000)}`);
      expect(lockText(claim!, true)).toBe(`locked as of ${clock(NOW - 5_000)}`);
    }
  });

  it("evidence read offline, before this connection, or long ago is as of that read", () => {
    const read = NOW - 120_000;
    expect(lockClaim(locked({ checkedAt: read }), { ...fresh, connected: false })).toEqual({
      asOf: read,
    });
    expect(lockClaim(locked({ checkedAt: read }), fresh)).toEqual({ asOf: read });
    const long = NOW - LOCK_OLD_MS - 1;
    expect(lockClaim(locked({ checkedAt: long }), { ...fresh, connectedAt: long - 1 })).toEqual({
      asOf: long,
    });
  });

  it("Used by carries the same claim as the bot's own page", () => {
    const bot = {
      id: "otto",
      name: "Otto",
      emoji: null,
      avatarUrl: null,
      theme: null,
      model: null,
      isDefault: false,
    };
    const failed = locked({ status: "failed", lastMatchAt: NOW - 5_000 });
    expect(usedBy("acme:work", [failed], [bot as never], fresh)[0]?.lock).toEqual({
      asOf: NOW - 5_000,
    });
  });
});
