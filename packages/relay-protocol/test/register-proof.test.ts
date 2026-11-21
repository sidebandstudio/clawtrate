// The rejection cases are ported from T3 Code (https://github.com/pingdotgg/t3code) at commit
// 18d1c4db: packages/shared/src/dpop.test.ts ("rejects malformed DPoP header and payload JSON",
// "rejects method, URL, thumbprint, and time-window mismatches", "reports a time-window failure
// only after the proof signature is valid", "accepts clock offsets through 300 seconds in either
// direction") and infra/relay/src/auth/DpopProofs.verifyAndConsume.test.ts ("rejects replays
// until a future proof's time window closes").
//
// Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import {
  canonicalRelayOrigin,
  EnrollmentOffer,
  RelayProtocolError,
  ControlRegistration,
  createRegisterNonce,
  decodeRelayToConnector,
  MemoryKeyClaims,
  createRegisterProof,
  isRelayId,
  MemoryReplayStore,
  REGISTER_PROOF_TYP,
  relayIdFromKey,
  toBase64Url,
  verifyRegisterProof,
  type RegistrationSnapshot,
  type ReplayStore,
} from "../src/index.ts";

const AUDIENCE = "wss://relay.example.test";
const NOW_MS = Date.UTC(2026, 10, 20, 12, 0, 0);
const NOW_S = NOW_MS / 1_000;
const secretKey = ed25519.utils.randomSecretKey();
const publicKey = ed25519.getPublicKey(secretKey);
const relayId = relayIdFromKey(publicKey);
const nonce = createRegisterNonce();

function verify(
  proof: string | undefined,
  overrides: Partial<{
    relayId: string;
    audience: string;
    nonce: string;
    nowMs: number;
    replay: ReplayStore;
  }> = {},
) {
  return verifyRegisterProof({
    proof,
    relayId,
    audience: AUDIENCE,
    nonce,
    nowMs: NOW_MS,
    replay: new MemoryReplayStore(),
    ...overrides,
  });
}

/** Signs any payload the way the connector does, so tests can make proofs it never would. */
function sign(
  payload: unknown,
  key: Uint8Array = secretKey,
  context = "clawtrate relay register proof\n",
) {
  const encoded = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const message = new TextEncoder().encode(context + encoded);
  return `${encoded}.${toBase64Url(ed25519.sign(message, key))}`;
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    typ: REGISTER_PROOF_TYP,
    aud: AUDIENCE,
    relayId,
    key: toBase64Url(publicKey),
    nonce,
    iat: NOW_S,
    jti: toBase64Url(new Uint8Array(16).fill(1)),
    ...overrides,
  };
}

describe("the relay id", () => {
  it("is lowercase base32 of the first 16 bytes of SHA-256 over the key", () => {
    // Computed separately: base32(sha256(bytes([7] * 32))[:16]), lowercased, unpadded.
    expect(relayIdFromKey(new Uint8Array(32).fill(7))).toBe("joyg7dsohj3rluqb2vz5bkscg4");
  });

  it("accepts every id a key derives and no other spelling", () => {
    for (let i = 0; i < 200; i++) {
      const id = relayIdFromKey(ed25519.getPublicKey(ed25519.utils.randomSecretKey()));
      expect(id).toHaveLength(26);
      expect(isRelayId(id)).toBe(true);
    }
    const id = "joyg7dsohj3rluqb2vz5bkscg4";
    for (const other of [
      id.toUpperCase(),
      `${id.slice(0, 25)}5`,
      id.slice(0, 25),
      `${id}a`,
      `${id}=`,
      7,
    ]) {
      expect(isRelayId(other)).toBe(false);
    }
  });
});

describe("the connector's register proof", () => {
  it("verifies a fresh proof and names the key and relay id it proves", async () => {
    const proof = createRegisterProof({ secretKey, audience: AUDIENCE, nonce, nowMs: NOW_MS });
    const result = await verify(proof);
    expect(result).toMatchObject({ ok: true, relayId, iat: NOW_S });
    if (result.ok) expect(result.publicKey).toEqual(publicKey);
  });

  it("rejects a missing or malformed proof", async () => {
    const good = createRegisterProof({ secretKey, audience: AUDIENCE, nonce, nowMs: NOW_MS });
    const [encoded, signature] = good.split(".") as [string, string];
    const notJson = toBase64Url(new TextEncoder().encode("{"));
    for (const proof of [undefined, "", "   "]) {
      expect(await verify(proof)).toEqual({ ok: false, code: "missing_proof" });
    }
    for (const proof of [
      encoded,
      `${good}.extra`,
      `${notJson}.${signature}`,
      `${encoded}=.${signature}`,
      `${encoded}.${signature.slice(1)}`,
      `${encoded}.${signature}A`,
      `${encoded}.${"A".repeat(1_100)}`,
      sign(payload({ typ: "dpop+jwt" })),
      sign(payload({ extra: 1 })),
      sign({ ...payload(), jti: undefined }),
      sign(payload({ iat: NOW_S + 0.5 })),
      sign(payload({ iat: -1 })),
      sign(payload({ iat: String(NOW_S) })),
      sign(payload({ jti: "short" })),
      sign(payload({ nonce: "short" })),
      sign(payload({ key: toBase64Url(new Uint8Array(31)) })),
      sign(payload({ aud: "" })),
      sign(payload({ aud: "x".repeat(257) })),
      sign([payload()]),
      sign(null),
    ]) {
      expect(await verify(proof), proof).toEqual({ ok: false, code: "malformed_proof" });
    }
  });

  it("rejects relay id, audience, nonce and key mismatches", async () => {
    const proof = createRegisterProof({ secretKey, audience: AUDIENCE, nonce, nowMs: NOW_MS });
    const otherRelayId = relayIdFromKey(new Uint8Array(32).fill(7));
    expect(await verify(proof, { relayId: otherRelayId })).toEqual({
      ok: false,
      code: "relay_mismatch",
    });
    expect(await verify(proof, { audience: "wss://other.example.test" })).toEqual({
      ok: false,
      code: "audience_mismatch",
    });
    expect(await verify(proof, { nonce: createRegisterNonce() })).toEqual({
      ok: false,
      code: "nonce_mismatch",
    });
    // The key signs a proof claiming another key's relay id.
    expect(
      await verify(sign(payload({ relayId: otherRelayId })), { relayId: otherRelayId }),
    ).toEqual({
      ok: false,
      code: "key_mismatch",
    });
  });

  it("rejects a proof signed by another key or in another context", async () => {
    const otherKey = ed25519.utils.randomSecretKey();
    expect(await verify(sign(payload(), otherKey))).toEqual({
      ok: false,
      code: "invalid_signature",
    });
    expect(await verify(sign(payload(), secretKey, ""))).toEqual({
      ok: false,
      code: "invalid_signature",
    });
    // A payload changed after signing.
    const good = createRegisterProof({ secretKey, audience: AUDIENCE, nonce, nowMs: NOW_MS });
    const signature = good.split(".")[1]!;
    const changed = sign(payload({ iat: NOW_S - 1 })).split(".")[0]!;
    expect(await verify(`${changed}.${signature}`)).toEqual({
      ok: false,
      code: "invalid_signature",
    });
  });

  it("reports a time-window failure only after the proof signature is valid", async () => {
    const old = sign(payload({ iat: NOW_S - 1_000 }));
    expect(await verify(old)).toEqual({ ok: false, code: "time_window" });
    const oldAndForged = sign(payload({ iat: NOW_S - 1_000 }), ed25519.utils.randomSecretKey());
    expect(await verify(oldAndForged)).toEqual({ ok: false, code: "invalid_signature" });
  });

  it("accepts clock offsets through 60 seconds in either direction", async () => {
    for (const { offset, accepted } of [
      { offset: -60, accepted: true },
      { offset: 60, accepted: true },
      { offset: -61, accepted: false },
      { offset: 61, accepted: false },
    ]) {
      const result = await verify(sign(payload()), { nowMs: NOW_MS + offset * 1_000 });
      expect(result.ok, `Clock offset: ${offset}s`).toBe(accepted);
      if (!result.ok) expect(result.code).toBe("time_window");
    }
  });

  it("rejects a replayed proof", async () => {
    const replay = new MemoryReplayStore();
    const proof = createRegisterProof({ secretKey, audience: AUDIENCE, nonce, nowMs: NOW_MS });
    expect((await verify(proof, { replay })).ok).toBe(true);
    expect(await verify(proof, { replay })).toEqual({ ok: false, code: "replayed" });
  });

  it("rejects replays until a future proof's time window closes", async () => {
    const replay = new MemoryReplayStore();
    const proof = sign(payload({ iat: NOW_S + 60, jti: toBase64Url(new Uint8Array(16).fill(2)) }));
    expect((await verify(proof, { replay })).ok).toBe(true);
    for (const { elapsedMs, code } of [
      { elapsedMs: 0, code: "replayed" },
      { elapsedMs: 61_000, code: "replayed" },
      { elapsedMs: 120_999, code: "replayed" },
      { elapsedMs: 121_000, code: "time_window" },
    ]) {
      const result = await verify(proof, { replay, nowMs: NOW_MS + elapsedMs });
      expect(result, `Replay after ${elapsedMs}ms`).toEqual({ ok: false, code });
    }
    // The store keeps the jti exactly as long as the proof could pass the time check.
    replay.prune(NOW_MS + 120_999);
    expect(replay.size).toBe(1);
    replay.prune(NOW_MS + 121_000);
    expect(replay.size).toBe(0);
  });

  it("keeps replay records apart per relay id, and forgets them when they expire", () => {
    const replay = new MemoryReplayStore();
    const entry = { jti: "j", expiresAtMs: 10, nowMs: 0 };
    expect(replay.consume({ ...entry, scope: "a" })).toBe(true);
    expect(replay.consume({ ...entry, scope: "b" })).toBe(true);
    expect(replay.consume({ ...entry, scope: "a" })).toBe(false);
    expect(replay.consume({ ...entry, scope: "a", nowMs: 10 })).toBe(true);
  });

  it("checks the signature before it consumes anything, and fails when the store fails", async () => {
    let consumed = 0;
    const counting: ReplayStore = { consume: () => (consumed++, true) };
    await verify(sign(payload(), ed25519.utils.randomSecretKey()), { replay: counting });
    await verify(sign(payload({ iat: NOW_S - 1_000 })), { replay: counting });
    expect(consumed).toBe(0);
    const broken: ReplayStore = {
      consume: () => Promise.reject(new Error("storage unavailable")),
    };
    expect(await verify(sign(payload()), { replay: broken })).toEqual({
      ok: false,
      code: "store_failed",
    });
  });
});

describe("one control socket's registration", () => {
  function socket(
    overrides: Partial<{
      clock: () => number;
      wallClock: () => number;
      replay: ReplayStore;
      claims: MemoryKeyClaims | { claim: () => Promise<boolean> };
      origin: string;
      restore: RegistrationSnapshot;
    }> = {},
  ) {
    return new ControlRegistration({
      relayId,
      origin: AUDIENCE,
      clock: () => 5_000,
      wallClock: () => NOW_MS,
      replay: new MemoryReplayStore(),
      claims: new MemoryKeyClaims(),
      ...overrides,
    });
  }
  function proofFor(registration: ControlRegistration, audience = AUDIENCE) {
    const challenge = decodeRelayToConnector(registration.challengeMessage);
    if (challenge.t !== "challenge") throw new Error("No challenge.");
    return createRegisterProof({ secretKey, audience, nonce: challenge.nonce, nowMs: NOW_MS });
  }

  it("issues a fresh challenge per socket and registers once", async () => {
    const first = socket();
    const second = socket();
    expect(first.challengeMessage).not.toBe(second.challengeMessage);
    expect(first.state).toBe("challenged");
    const proof = proofFor(first);
    expect((await first.register(proof)).ok).toBe(true);
    expect(first.state).toBe("registered");
    expect(await first.register(proofFor(first))).toEqual({ ok: false, code: "already_used" });
    // A proof for one socket's challenge is no good on another socket.
    expect(await second.register(proof)).toEqual({ ok: false, code: "nonce_mismatch" });
    expect(await second.register(proofFor(second))).toEqual({ ok: false, code: "already_used" });
  });

  it("takes one attempt even when two overlap", async () => {
    const registration = socket();
    const proof = proofFor(registration);
    const results = await Promise.all([registration.register(proof), registration.register(proof)]);
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(results[1]).toEqual({ ok: false, code: "already_used" });
  });

  it("refuses a challenge older than 60 seconds by the monotonic clock", async () => {
    for (const [elapsed, ok] of [
      [60_000, true],
      [60_001, false],
    ] as const) {
      let now = 1_000;
      const registration = socket({ clock: () => now });
      const proof = proofFor(registration);
      now += elapsed;
      const result = await registration.register(proof);
      expect(result.ok, `${elapsed}ms`).toBe(ok);
      if (!result.ok) expect(result.code).toBe("challenge_expired");
    }
  });

  it("compares the signed origin with the relay's canonical origin", async () => {
    expect(canonicalRelayOrigin("WSS://Relay.Example.TEST:443/")).toBe(AUDIENCE);
    expect(canonicalRelayOrigin("ws://127.0.0.1:8787")).toBe("ws://127.0.0.1:8787");
    for (const bad of [
      "https://relay.example.test",
      "wss://relay.example.test/v1",
      "wss://user@relay.example.com",
      "wss://relay.example.test?x=1",
      "relay.example.test",
    ]) {
      expect(() => canonicalRelayOrigin(bad), bad).toThrow(RelayProtocolError);
    }
    // The connector signs the canonical form of what it was given.
    const relaxed = socket({ origin: "wss://relay.example.test/" });
    expect((await relaxed.register(proofFor(relaxed, "wss://RELAY.example.test:443"))).ok).toBe(
      true,
    );
    // A proof whose signed origin is not canonical does not match.
    const strict = socket();
    const challenge = decodeRelayToConnector(strict.challengeMessage);
    if (challenge.t !== "challenge") throw new Error("No challenge.");
    const spelled = sign(payload({ aud: "wss://relay.example.test/", nonce: challenge.nonce }));
    expect(await strict.register(spelled)).toEqual({ ok: false, code: "audience_mismatch" });
  });

  it("pins the relay id to the first key that registers it", async () => {
    const claims = new MemoryKeyClaims();
    expect(claims.claim(relayId, new Uint8Array(32).fill(1))).toBe(true);
    const registration = socket({ claims });
    expect(await registration.register(proofFor(registration))).toEqual({
      ok: false,
      code: "claimed_by_other_key",
    });
    expect(registration.state).toBe("failed");
    const own = new MemoryKeyClaims();
    for (let i = 0; i < 2; i++) {
      const again = socket({ claims: own });
      expect((await again.register(proofFor(again))).ok).toBe(true);
    }
  });

  it("fails when the replay store or the key claims fail", async () => {
    const replay = socket({ replay: { consume: () => Promise.reject(new Error("down")) } });
    expect(await replay.register(proofFor(replay))).toEqual({ ok: false, code: "store_failed" });
    expect(replay.state).toBe("failed");
    const claims = socket({ claims: { claim: () => Promise.reject(new Error("down")) } });
    expect(await claims.register(proofFor(claims))).toEqual({ ok: false, code: "store_failed" });
  });

  it("a store that checks and inserts atomically lets one of two overlapping uses through", async () => {
    const store = new MemoryReplayStore();
    // An asynchronous store in front of the atomic reference, as a database would be.
    const slow: ReplayStore = {
      consume: async (input) => {
        await Promise.resolve();
        return store.consume(input);
      },
    };
    const proof = createRegisterProof({ secretKey, audience: AUDIENCE, nonce, nowMs: NOW_MS });
    const results = await Promise.all([
      verify(proof, { replay: slow }),
      verify(proof, { replay: slow }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, code: "replayed" }]);
  });

  it("survives hibernation as a snapshot; an attempt cut off by it is not resumed", async () => {
    const registration = socket();
    const snapshot = registration.snapshot();
    const restored = socket({ restore: snapshot });
    expect(restored.challengeMessage).toBe(registration.challengeMessage);
    expect((await restored.register(proofFor(registration))).ok).toBe(true);
    const cut = socket({ restore: { ...snapshot, state: "verifying" } });
    expect(cut.state).toBe("failed");
  });
});

describe("clock inputs", () => {
  const badTimes = [Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY];

  it("an enrollment offer refuses a time that is not whole nonnegative milliseconds", () => {
    const secret = new Uint8Array(32).fill(5);
    for (const time of badTimes) {
      expect(() => new EnrollmentOffer(secret, time), String(time)).toThrow(
        expect.objectContaining({ code: "bad_time" }),
      );
      const offer = new EnrollmentOffer(secret, 100);
      expect(() => offer.matches(secret, time), String(time)).toThrow(
        expect.objectContaining({ code: "bad_time" }),
      );
      expect(() => offer.redeem(secret, time), String(time)).toThrow(
        expect.objectContaining({ code: "bad_time" }),
      );
      expect(offer.used).toBe(false);
    }
  });

  it("proof creation and verification fail closed on a bad clock", async () => {
    const proof = createRegisterProof({ secretKey, audience: AUDIENCE, nonce, nowMs: NOW_MS });
    for (const time of badTimes) {
      expect(await verify(proof, { nowMs: time }), String(time)).toEqual({
        ok: false,
        code: "bad_clock",
      });
      expect(
        () => createRegisterProof({ secretKey, audience: AUDIENCE, nonce, nowMs: time }),
        String(time),
      ).toThrow(expect.objectContaining({ code: "bad_time" }));
    }
    for (const clock of [() => Number.NaN, () => -5]) {
      const registration = new ControlRegistration({
        relayId,
        origin: AUDIENCE,
        clock: () => 0,
        wallClock: clock,
        replay: new MemoryReplayStore(),
        claims: new MemoryKeyClaims(),
      });
      expect(await registration.register(proof)).toEqual({ ok: false, code: "bad_clock" });
    }
  });

  it("refuses an iat whose replay record could not be kept in safe milliseconds", async () => {
    const largest = Math.floor(Number.MAX_SAFE_INTEGER / 1_000) - 61;
    const nowAt = (iat: number) => iat * 1_000;
    expect((await verify(sign(payload({ iat: largest })), { nowMs: nowAt(largest) })).ok).toBe(
      true,
    );
    expect(await verify(sign(payload({ iat: largest + 1 })), { nowMs: nowAt(largest) })).toEqual({
      ok: false,
      code: "malformed_proof",
    });
  });

  it("refuses a signed payload with a repeated member name", async () => {
    const good = JSON.stringify(payload());
    const repeated = good.replace('"aud":', '"aud":"wss://other.example.test","aud":');
    const encoded = toBase64Url(new TextEncoder().encode(repeated));
    const message = new TextEncoder().encode(`clawtrate relay register proof\n${encoded}`);
    const proof = `${encoded}.${toBase64Url(ed25519.sign(message, secretKey))}`;
    expect(await verify(proof)).toEqual({ ok: false, code: "malformed_proof" });
  });
});
