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
  createRegisterNonce,
  createRegisterProof,
  isRelayId,
  MemoryReplayStore,
  REGISTER_PROOF_TYP,
  relayIdFromKey,
  toBase64Url,
  verifyRegisterProof,
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

  it("checks the signature before it consumes anything, and passes on a store failure", async () => {
    let consumed = 0;
    const counting: ReplayStore = { consume: () => (consumed++, true) };
    await verify(sign(payload(), ed25519.utils.randomSecretKey()), { replay: counting });
    await verify(sign(payload({ iat: NOW_S - 1_000 })), { replay: counting });
    expect(consumed).toBe(0);
    const broken: ReplayStore = {
      consume: () => Promise.reject(new Error("storage unavailable")),
    };
    await expect(verify(sign(payload()), { replay: broken })).rejects.toThrow(
      "storage unavailable",
    );
  });
});
