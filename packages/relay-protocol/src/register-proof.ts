// The connector's register proof: a signed, bounded, replay-guarded answer to the relay's
// challenge, proving it holds the Ed25519 key its relay id is derived from.
//
// Ported from T3 Code (https://github.com/pingdotgg/t3code) at commit 18d1c4db:
// packages/shared/src/dpop.ts (`verifyDpopProof`: the failure codes, checking claims, then the
// signature, then the time window) and infra/relay/src/auth/DpopProofs.ts (consuming the proof's
// `jti` once, kept until the end of the last second its time window accepts it).
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
import {
  concatBytes,
  fromBase64Url,
  fromBase64UrlOfLength,
  secureRandomBytes,
  toBase64Url,
  utf8Decode,
  utf8Encode,
  type RandomBytes,
} from "./bytes.ts";
import { RelayProtocolError } from "./errors.ts";
import { MAX_REGISTER_PROOF_CHARS } from "./limits.ts";
import { REGISTER_NONCE_BYTES } from "./messages.ts";
import { relayIdFromKey } from "./relay-id.ts";

export const REGISTER_PROOF_TYP = "clawtrate-relay-register/1";
/**
 * How far a proof's `iat` may sit from the relay's clock, in either direction. The proof also
 * answers a nonce the relay chose for this socket, so it is good for this one registration only.
 */
export const REGISTER_PROOF_MAX_AGE_SECONDS = 60;
/** Signed in front of the payload, so the signature means nothing in any other context. */
const SIGNING_CONTEXT = utf8Encode("clawtrate relay register proof\n");
const JTI_BYTES = 16;
const SIGNATURE_BYTES = 64;
const MAX_AUDIENCE_CHARS = 256;

export type RegisterProofFailureCode =
  | "missing_proof"
  | "malformed_proof"
  /** The relay id in the proof is not the one its key derives. */
  | "key_mismatch"
  /** The proof is for another relay id than the socket's. */
  | "relay_mismatch"
  /** The proof is for another relay. */
  | "audience_mismatch"
  /** The proof answers another challenge. */
  | "nonce_mismatch"
  | "invalid_signature"
  | "time_window"
  | "replayed";

export type RegisterProofResult =
  | {
      readonly ok: true;
      readonly relayId: string;
      readonly publicKey: Uint8Array;
      readonly jti: string;
      readonly iat: number;
    }
  | { readonly ok: false; readonly code: RegisterProofFailureCode };

interface RegisterProofPayload {
  readonly typ: typeof REGISTER_PROOF_TYP;
  /** The relay's origin, for example `wss://relay.example.test`. */
  readonly aud: string;
  readonly relayId: string;
  /** The Ed25519 public key, base64url. */
  readonly key: string;
  /** The relay's challenge nonce. */
  readonly nonce: string;
  /** Seconds since the epoch, by the connector's clock. */
  readonly iat: number;
  readonly jti: string;
}

const PAYLOAD_KEYS = ["typ", "aud", "relayId", "key", "nonce", "iat", "jti"] as const;

/**
 * Remembers each proof's `jti` until its time window closes. The relay keeps it in its
 * per-relay-id storage; `MemoryReplayStore` serves tests and the Node runner.
 */
export interface ReplayStore {
  /** Records the jti and returns true, or returns false if it is already recorded and not expired. */
  consume(input: {
    readonly scope: string;
    readonly jti: string;
    readonly expiresAtMs: number;
    readonly nowMs: number;
  }): boolean | Promise<boolean>;
}

export class MemoryReplayStore implements ReplayStore {
  readonly #seen = new Map<string, number>();

  consume(input: {
    readonly scope: string;
    readonly jti: string;
    readonly expiresAtMs: number;
    readonly nowMs: number;
  }): boolean {
    this.prune(input.nowMs);
    const key = `${input.scope}\n${input.jti}`;
    if (this.#seen.has(key)) return false;
    this.#seen.set(key, input.expiresAtMs);
    return true;
  }

  /** Forgets every jti whose window has closed. */
  prune(nowMs: number): void {
    for (const [key, expiresAtMs] of this.#seen) if (expiresAtMs <= nowMs) this.#seen.delete(key);
  }

  get size(): number {
    return this.#seen.size;
  }
}

/** The connector's answer to a challenge, as `<payload>.<signature>` in base64url. */
export function createRegisterProof(input: {
  /** The connector's Ed25519 secret key (32 bytes). */
  readonly secretKey: Uint8Array;
  readonly audience: string;
  readonly nonce: string;
  readonly nowMs: number;
  readonly random?: RandomBytes;
}): string {
  const publicKey = ed25519.getPublicKey(input.secretKey);
  const payload: RegisterProofPayload = {
    typ: REGISTER_PROOF_TYP,
    aud: input.audience,
    relayId: relayIdFromKey(publicKey),
    key: toBase64Url(publicKey),
    nonce: input.nonce,
    iat: Math.floor(input.nowMs / 1_000),
    jti: toBase64Url((input.random ?? secureRandomBytes)(JTI_BYTES)),
  };
  const encoded = toBase64Url(utf8Encode(JSON.stringify(payload)));
  const signature = ed25519.sign(signingInput(encoded), input.secretKey);
  const proof = `${encoded}.${toBase64Url(signature)}`;
  if (proof.length > MAX_REGISTER_PROOF_CHARS) {
    throw new RelayProtocolError(
      "malformed",
      "The register proof is too long; shorten the audience.",
    );
  }
  return proof;
}

/**
 * Checks a register proof for the socket at /v1/connector/<relayId>, then consumes its jti.
 * A failure is returned, never thrown, except for an error from the replay store.
 */
export async function verifyRegisterProof(input: {
  readonly proof: string | null | undefined;
  /** The relay id in the socket's path. */
  readonly relayId: string;
  /** This relay's origin. */
  readonly audience: string;
  /** The challenge this socket was sent. */
  readonly nonce: string;
  readonly nowMs: number;
  readonly replay: ReplayStore;
}): Promise<RegisterProofResult> {
  const result = checkRegisterProof(input);
  if (!result.ok) return result;
  const consumed = await input.replay.consume({
    scope: result.relayId,
    jti: result.jti,
    // The time check floors the clock to seconds, so the proof passes until the end of
    // second `iat + REGISTER_PROOF_MAX_AGE_SECONDS`.
    expiresAtMs: (result.iat + REGISTER_PROOF_MAX_AGE_SECONDS + 1) * 1_000,
    nowMs: input.nowMs,
  });
  return consumed ? result : { ok: false, code: "replayed" };
}

function checkRegisterProof(input: {
  readonly proof: string | null | undefined;
  readonly relayId: string;
  readonly audience: string;
  readonly nonce: string;
  readonly nowMs: number;
}): RegisterProofResult {
  if (typeof input.proof !== "string" || input.proof.trim() === "") {
    return { ok: false, code: "missing_proof" };
  }
  if (input.proof.length > MAX_REGISTER_PROOF_CHARS) return { ok: false, code: "malformed_proof" };
  const parts = input.proof.split(".");
  if (parts.length !== 2) return { ok: false, code: "malformed_proof" };
  const [encoded, encodedSignature] = parts as [string, string];
  const payload = decodePayload(encoded);
  const signature = fromBase64UrlOfLength(encodedSignature, SIGNATURE_BYTES);
  if (payload === null || signature === null) return { ok: false, code: "malformed_proof" };
  const publicKey = fromBase64UrlOfLength(payload.key, 32)!;

  if (relayIdFromKey(publicKey) !== payload.relayId) return { ok: false, code: "key_mismatch" };
  if (payload.relayId !== input.relayId) return { ok: false, code: "relay_mismatch" };
  if (payload.aud !== input.audience) return { ok: false, code: "audience_mismatch" };
  if (payload.nonce !== input.nonce) return { ok: false, code: "nonce_mismatch" };

  let verified: boolean;
  try {
    // Strict RFC 8032 checks: no ZIP-215 leniency, so one message has one valid signature.
    verified = ed25519.verify(signature, signingInput(encoded), publicKey, { zip215: false });
  } catch {
    verified = false;
  }
  if (!verified) return { ok: false, code: "invalid_signature" };

  if (Math.abs(Math.floor(input.nowMs / 1_000) - payload.iat) > REGISTER_PROOF_MAX_AGE_SECONDS) {
    return { ok: false, code: "time_window" };
  }
  return { ok: true, relayId: payload.relayId, publicKey, jti: payload.jti, iat: payload.iat };
}

function signingInput(encodedPayload: string): Uint8Array {
  return concatBytes(SIGNING_CONTEXT, utf8Encode(encodedPayload));
}

function decodePayload(encoded: string): RegisterProofPayload | null {
  const bytes = fromBase64Url(encoded);
  if (bytes === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(utf8Decode(bytes));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (
    keys.length !== PAYLOAD_KEYS.length ||
    !PAYLOAD_KEYS.every((key) => Object.hasOwn(object, key))
  ) {
    return null;
  }
  const { typ, aud, relayId, key, nonce, iat, jti } = object;
  if (
    typ !== REGISTER_PROOF_TYP ||
    typeof aud !== "string" ||
    aud.length === 0 ||
    aud.length > MAX_AUDIENCE_CHARS ||
    typeof relayId !== "string" ||
    fromBase64UrlOfLength(key, 32) === null ||
    fromBase64UrlOfLength(nonce, REGISTER_NONCE_BYTES) === null ||
    typeof iat !== "number" ||
    !Number.isSafeInteger(iat) ||
    iat < 0 ||
    fromBase64UrlOfLength(jti, JTI_BYTES) === null
  ) {
    return null;
  }
  return object as unknown as RegisterProofPayload;
}
