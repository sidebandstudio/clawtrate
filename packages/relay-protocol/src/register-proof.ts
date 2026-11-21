// The connector's register proof: a signed, bounded, replay-guarded answer to the relay's
// challenge, proving it holds the Ed25519 key its relay id is derived from.
//
// Ported from T3 Code (https://github.com/pingdotgg/t3code) at commit 18d1c4db:
// packages/shared/src/dpop.ts (`verifyDpopProof`: the failure codes, checking claims, then the
// signature, then the time window) and infra/relay/src/auth/DpopProofs.ts (consuming the proof's
// `jti` once, kept until the end of the last second its time window accepts it). The challenge
// lifetime, one registration per socket and the key pin are Clawtrate's own.
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
import { fail, RelayProtocolError } from "./errors.ts";
import { readFlatObject } from "./json.ts";
import { MAX_REGISTER_PROOF_CHARS, REGISTER_CHALLENGE_MS } from "./limits.ts";
import { createRegisterNonce, encodeRelayMessage, REGISTER_NONCE_BYTES } from "./messages.ts";
import { relayIdFromKey } from "./relay-id.ts";
import { checkMillis, isMillis } from "./time.ts";

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
/** The largest `iat` whose replay record expiry is still a safe integer of milliseconds. */
const MAX_IAT_SECONDS =
  Math.floor(Number.MAX_SAFE_INTEGER / 1_000) - REGISTER_PROOF_MAX_AGE_SECONDS - 1;

export type RegisterProofFailureCode =
  | "missing_proof"
  | "malformed_proof"
  /** The relay id in the proof is not the one its key derives. */
  | "key_mismatch"
  /** The proof is for another relay id than the socket's. */
  | "relay_mismatch"
  /** The proof is for another relay origin. */
  | "audience_mismatch"
  /** The proof answers another challenge. */
  | "nonce_mismatch"
  | "invalid_signature"
  | "time_window"
  | "replayed"
  /** The host's clock is not a nonnegative whole number of milliseconds. */
  | "bad_clock"
  /** The replay store or the key claims failed; the registration fails with them. */
  | "store_failed"
  /** The socket's challenge is older than `REGISTER_CHALLENGE_MS`. */
  | "challenge_expired"
  /** The socket already registered, or tried to. */
  | "already_used"
  /** The relay id was first claimed by another key. */
  | "claimed_by_other_key";

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
  /** The relay's canonical origin, for example `wss://relay.example.test`. */
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
 * The one spelling of a relay origin both sides sign and compare: `wss://host[:port]` (or `ws:`
 * for a relay on this machine in tests), lowercase, without the default port, a path, a query
 * or credentials. Anything else fails with `malformed`.
 */
export function canonicalRelayOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return fail("malformed", "The relay origin is not a URL.");
  }
  if (
    (url.protocol !== "wss:" && url.protocol !== "ws:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.host === ""
  ) {
    fail("malformed", "A relay origin is ws: or wss:, a host and an optional port.");
  }
  const canonical = `${url.protocol}//${url.host}`;
  if (canonical.length > MAX_AUDIENCE_CHARS) fail("malformed", "The relay origin is too long.");
  return canonical;
}

/**
 * Remembers each proof's `jti` until its time window closes. The contract a relay's store
 * must meet:
 * - `consume` checks and records in one atomic step: of two calls with the same scope and jti,
 *   however they overlap, at most one returns true until `expiresAtMs`;
 * - a record outlives a restart or hibernation of the relay until `expiresAtMs`;
 * - a store that cannot answer throws or rejects, and the registration fails (`store_failed`);
 *   it never answers true on failure.
 * `MemoryReplayStore` is the reference implementation, for tests and a single Node process.
 */
export interface ReplayStore {
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
    checkMillis(nowMs, "The time");
    for (const [key, expiresAtMs] of this.#seen) if (expiresAtMs <= nowMs) this.#seen.delete(key);
  }

  get size(): number {
    return this.#seen.size;
  }
}

/**
 * Pins each relay id to the full public key that first registered it. The contract: `claim`
 * checks and records in one atomic step, returns true for an unclaimed id (recording the key)
 * or for the key already pinned, false for any other key, and throws or rejects if it cannot
 * answer. `MemoryKeyClaims` is the reference implementation.
 */
export interface KeyClaims {
  claim(relayId: string, publicKey: Uint8Array): boolean | Promise<boolean>;
}

export class MemoryKeyClaims implements KeyClaims {
  readonly #keys = new Map<string, string>();

  claim(relayId: string, publicKey: Uint8Array): boolean {
    const key = toBase64Url(publicKey);
    const pinned = this.#keys.get(relayId);
    if (pinned === undefined) this.#keys.set(relayId, key);
    return pinned === undefined || pinned === key;
  }
}

/** The connector's answer to a challenge, as `<payload>.<signature>` in base64url. */
export function createRegisterProof(input: {
  /** The connector's Ed25519 secret key (32 bytes), used for nothing else. */
  readonly secretKey: Uint8Array;
  /** The relay's origin; it is signed in canonical form. */
  readonly audience: string;
  readonly nonce: string;
  readonly nowMs: number;
  /** Tests only; production uses `crypto.getRandomValues`. */
  readonly random?: RandomBytes;
}): string {
  const nowMs = checkMillis(input.nowMs, "The time");
  const publicKey = ed25519.getPublicKey(input.secretKey);
  const payload: RegisterProofPayload = {
    typ: REGISTER_PROOF_TYP,
    aud: canonicalRelayOrigin(input.audience),
    relayId: relayIdFromKey(publicKey),
    key: toBase64Url(publicKey),
    nonce: input.nonce,
    iat: Math.floor(nowMs / 1_000),
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
 * A failure is returned, never thrown; a relay origin that is not canonical-izable is a host
 * error and throws. Use it through `ControlRegistration`, which also holds the challenge's
 * lifetime, one registration per socket and the key pin.
 */
export async function verifyRegisterProof(input: {
  readonly proof: string | null | undefined;
  /** The relay id in the socket's path. */
  readonly relayId: string;
  /** This relay's configured origin. */
  readonly audience: string;
  /** The challenge this socket was sent. */
  readonly nonce: string;
  readonly nowMs: number;
  readonly replay: ReplayStore;
}): Promise<RegisterProofResult> {
  const audience = canonicalRelayOrigin(input.audience);
  if (!isMillis(input.nowMs)) return { ok: false, code: "bad_clock" };
  const result = checkRegisterProof({ ...input, audience });
  if (!result.ok) return result;
  let consumed: boolean;
  try {
    consumed = await input.replay.consume({
      scope: result.relayId,
      jti: result.jti,
      // The time check floors the clock to seconds, so the proof passes until the end of
      // second `iat + REGISTER_PROOF_MAX_AGE_SECONDS`.
      expiresAtMs: (result.iat + REGISTER_PROOF_MAX_AGE_SECONDS + 1) * 1_000,
      nowMs: input.nowMs,
    });
  } catch {
    return { ok: false, code: "store_failed" };
  }
  return consumed === true ? result : { ok: false, code: "replayed" };
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
    // Strict RFC 8032 decoding: canonical points and scalars, no small-order keys. Replay is
    // caught by the jti, not by the signature's bytes.
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
  let members: Map<string, unknown>;
  try {
    // Refuses repeated member names, which JSON.parse would let the last one win.
    members = readFlatObject(utf8Decode(bytes));
  } catch {
    return null;
  }
  if (members.size !== PAYLOAD_KEYS.length || !PAYLOAD_KEYS.every((key) => members.has(key))) {
    return null;
  }
  const [typ, aud, relayId, key, nonce, iat, jti] = PAYLOAD_KEYS.map((name) => members.get(name));
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
    iat > MAX_IAT_SECONDS ||
    fromBase64UrlOfLength(jti, JTI_BYTES) === null
  ) {
    return null;
  }
  return { typ, aud, relayId, key: key as string, nonce: nonce as string, iat, jti: jti as string };
}

export type RegistrationState = "challenged" | "verifying" | "registered" | "failed";

/** What a relay keeps of a control socket's registration across hibernation. */
export interface RegistrationSnapshot {
  readonly nonce: string;
  readonly issuedAtMs: number;
  readonly state: RegistrationState;
}

export interface ControlRegistrationOptions {
  /** The relay id in the socket's path. */
  readonly relayId: string;
  /** This relay's configured origin. */
  readonly origin: string;
  /**
   * Elapsed time in whole milliseconds, never set back by wall-clock corrections; on a relay
   * that hibernates, one that survives hibernation.
   */
  readonly clock: () => number;
  /** Wall-clock milliseconds since the epoch, for the proof's `iat`. */
  readonly wallClock: () => number;
  readonly replay: ReplayStore;
  readonly claims: KeyClaims;
  /** A registration restored after hibernation, instead of a fresh challenge. */
  readonly restore?: RegistrationSnapshot;
  /** Tests only; production uses `crypto.getRandomValues`. */
  readonly random?: RandomBytes;
}

/**
 * One control socket's registration, as the relay runs it: one fresh challenge, good for
 * `REGISTER_CHALLENGE_MS`, and one registration attempt. The state moves to `verifying` before
 * the first await, so a second attempt, even one that overlaps the first, gets `already_used`.
 */
export class ControlRegistration {
  readonly #options: ControlRegistrationOptions;
  readonly #nonce: string;
  readonly #issuedAtMs: number;
  #state: RegistrationState;

  constructor(options: ControlRegistrationOptions) {
    this.#options = options;
    canonicalRelayOrigin(options.origin);
    if (options.restore) {
      this.#nonce = options.restore.nonce;
      this.#issuedAtMs = checkMillis(options.restore.issuedAtMs, "The challenge time");
      // An attempt cut off by hibernation cannot be resumed.
      this.#state = options.restore.state === "verifying" ? "failed" : options.restore.state;
    } else {
      this.#nonce = createRegisterNonce(options.random);
      this.#issuedAtMs = checkMillis(options.clock(), "The clock");
      this.#state = "challenged";
    }
  }

  get state(): RegistrationState {
    return this.#state;
  }

  /** The challenge message to send as the socket's first text. */
  get challengeMessage(): string {
    return encodeRelayMessage({ t: "challenge", nonce: this.#nonce });
  }

  snapshot(): RegistrationSnapshot {
    return { nonce: this.#nonce, issuedAtMs: this.#issuedAtMs, state: this.#state };
  }

  /** Checks the socket's one register proof. Any failure ends the registration for good. */
  async register(proof: string): Promise<RegisterProofResult> {
    if (this.#state !== "challenged") return { ok: false, code: "already_used" };
    this.#state = "verifying";
    const result = await this.#verify(proof);
    this.#state = result.ok ? "registered" : "failed";
    return result;
  }

  async #verify(proof: string): Promise<RegisterProofResult> {
    const options = this.#options;
    let elapsedMs: number;
    let wallMs: number;
    try {
      elapsedMs = checkMillis(options.clock(), "The clock") - this.#issuedAtMs;
      wallMs = checkMillis(options.wallClock(), "The wall clock");
    } catch {
      return { ok: false, code: "bad_clock" };
    }
    if (!(elapsedMs >= 0 && elapsedMs <= REGISTER_CHALLENGE_MS)) {
      return { ok: false, code: "challenge_expired" };
    }
    const result = await verifyRegisterProof({
      proof,
      relayId: options.relayId,
      audience: options.origin,
      nonce: this.#nonce,
      nowMs: wallMs,
      replay: options.replay,
    });
    if (!result.ok) return result;
    let claimed: boolean;
    try {
      claimed = await options.claims.claim(result.relayId, Uint8Array.from(result.publicKey));
    } catch {
      return { ok: false, code: "store_failed" };
    }
    return claimed === true ? result : { ok: false, code: "claimed_by_other_key" };
  }
}
