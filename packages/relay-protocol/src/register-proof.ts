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
  | "claimed_by_other_key"
  /** The socket was aborted while the attempt waited. */
  | "aborted";

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

/** Only these hosts may use `ws:`, and only where a test turns it on. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);
/** A scheme and an authority (host and optional port), and at most a final slash. */
const ORIGIN_SPELLING = /^wss?:\/\/[A-Za-z0-9.\-[\]:]+\/?$/i;

export interface OriginOptions {
  /** Tests only: accept `ws:` for a relay on this machine. */
  readonly allowLoopbackWs?: boolean;
}

/**
 * The one spelling of a relay origin both sides sign and compare: `wss://host[:port]`,
 * lowercase, without the default port. The text given must already be a scheme, a host, an
 * optional port and at most a final slash; no path, query, fragment or credentials, checked
 * before any normalizing. `ws:` only for a loopback host, and only with `allowLoopbackWs`.
 * Anything else fails with `malformed`.
 */
export function canonicalRelayOrigin(origin: string, options: OriginOptions = {}): string {
  if (typeof origin !== "string" || origin.length > MAX_AUDIENCE_CHARS) {
    fail("malformed", "The relay origin is not short text.");
  }
  if (!ORIGIN_SPELLING.test(origin)) {
    fail("malformed", "A relay origin is a scheme, a host and an optional port.");
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return fail("malformed", "The relay origin is not a URL.");
  }
  const loopbackWs =
    url.protocol === "ws:" && options.allowLoopbackWs === true && LOOPBACK_HOSTS.has(url.hostname);
  if ((url.protocol !== "wss:" && !loopbackWs) || url.host === "") {
    fail("malformed", "A relay origin is wss:, or ws: on this machine in tests.");
  }
  return `${url.protocol}//${url.host}`;
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
 * Pins each relay id to the full public key that first registered it. The contract a relay's
 * store must meet: `claim` checks and records in one atomic step, and in that same step reads
 * `attempt.live`: when it is false it records nothing and returns false. Otherwise it returns
 * true for an unclaimed id (recording the key) or for the key already pinned, and false for any
 * other key. It throws or rejects if it cannot answer. `MemoryKeyClaims` is the reference.
 */
export interface KeyClaims {
  claim(
    relayId: string,
    publicKey: Uint8Array,
    attempt: { readonly live: boolean },
  ): boolean | Promise<boolean>;
}

export class MemoryKeyClaims implements KeyClaims {
  readonly #keys = new Map<string, string>();

  claim(relayId: string, publicKey: Uint8Array, attempt: { readonly live: boolean }): boolean {
    if (!attempt.live) return false;
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
  readonly allowLoopbackWs?: boolean;
}): string {
  const nowMs = checkMillis(input.nowMs, "The time");
  if (Math.floor(nowMs / 1_000) > MAX_IAT_SECONDS) {
    fail("bad_time", "The time is past what a register proof can carry.");
  }
  if (fromBase64UrlOfLength(input.nonce, REGISTER_NONCE_BYTES) === null) {
    fail("malformed", "The challenge nonce is not 32 bytes of canonical base64url.");
  }
  const publicKey = ed25519.getPublicKey(input.secretKey);
  const payload: RegisterProofPayload = {
    typ: REGISTER_PROOF_TYP,
    aud: canonicalRelayOrigin(input.audience, input),
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
  readonly allowLoopbackWs?: boolean;
}): Promise<RegisterProofResult> {
  const audience = canonicalRelayOrigin(input.audience, input);
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
  // Type and length first, so nothing scans text over the cap.
  if (typeof input.proof !== "string") return { ok: false, code: "missing_proof" };
  if (input.proof.length > MAX_REGISTER_PROOF_CHARS) return { ok: false, code: "malformed_proof" };
  if (input.proof.trim() === "") return { ok: false, code: "missing_proof" };
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

export interface ControlRegistrationOptions extends OriginOptions {
  /** The relay id in the socket's path. */
  readonly relayId: string;
  /** This relay's configured origin. It is checked and pinned when the socket starts. */
  readonly origin: string;
  /**
   * Elapsed time in whole milliseconds, never set back by wall-clock corrections; on a relay
   * that hibernates, one that survives hibernation. A reading below an earlier one ends the
   * attempt with `bad_clock`.
   */
  readonly clock: () => number;
  /** Wall-clock milliseconds since the epoch, for the proof's `iat`. */
  readonly wallClock: () => number;
  readonly replay: ReplayStore;
  readonly claims: KeyClaims;
  /**
   * Stores the snapshot. Called, and awaited, after every change of state: `verifying` before
   * any store is asked, and the outcome before it is returned. A success is stored while the
   * attempt can still be cancelled; if it is cancelled during that wait, `failed` is stored
   * after it. A failure to store fails the attempt. The relay restores only the latest
   * snapshot it stored; an older one must never replace it.
   */
  readonly persist?: (snapshot: RegistrationSnapshot) => void | Promise<void>;
  /** A registration restored after hibernation, instead of a fresh challenge. */
  readonly restore?: RegistrationSnapshot;
  /** Tests only; production uses `crypto.getRandomValues`. */
  readonly random?: RandomBytes;
}

/**
 * One control socket's registration, as the relay runs it: one fresh challenge, good for
 * `REGISTER_CHALLENGE_MS`, and one registration attempt.
 *
 * - The state moves to `verifying` before the first await, so a second attempt, even one that
 *   overlaps the first, gets `already_used`.
 * - The attempt is bound to this object's one in-flight token. After every await it checks
 *   that the token is still current and the challenge still in time, before the key claim and
 *   before returning success; the key claim itself is told whether the attempt is live. It
 *   stays cancellable until its success is stored.
 * - `expire()` ends a challenge that ran out with no proof; the relay calls it from a timer,
 *   since a quiet socket sends nothing. `abort()` ends the registration when the socket goes.
 */
export class ControlRegistration {
  readonly #options: ControlRegistrationOptions;
  readonly #relayId: string;
  readonly #origin: string;
  readonly #allowLoopbackWs: boolean;
  readonly #nonce: string;
  readonly #issuedAtMs: number;
  #state: RegistrationState;
  #attempt: object | null = null;
  /** The latest clock reading; a later one may not be lower. */
  #lastReading: number;

  constructor(options: ControlRegistrationOptions) {
    this.#options = options;
    this.#relayId = options.relayId;
    this.#allowLoopbackWs = options.allowLoopbackWs === true;
    this.#origin = canonicalRelayOrigin(options.origin, options);
    if (options.restore) {
      if (fromBase64UrlOfLength(options.restore.nonce, REGISTER_NONCE_BYTES) === null) {
        fail("malformed", "The restored nonce is not 32 bytes of canonical base64url.");
      }
      this.#nonce = options.restore.nonce;
      this.#issuedAtMs = checkMillis(options.restore.issuedAtMs, "The challenge time");
      // An attempt cut off by hibernation cannot be resumed.
      this.#state = options.restore.state === "verifying" ? "failed" : options.restore.state;
    } else {
      this.#nonce = createRegisterNonce(options.random);
      this.#issuedAtMs = checkMillis(options.clock(), "The clock");
      this.#state = "challenged";
    }
    this.#lastReading = this.#issuedAtMs;
  }

  get state(): RegistrationState {
    return this.#state;
  }

  /** The canonical origin this socket checks proofs against, fixed when it started. */
  get origin(): string {
    return this.#origin;
  }

  /** The challenge message to send as the socket's first text. */
  get challengeMessage(): string {
    return encodeRelayMessage({ t: "challenge", nonce: this.#nonce });
  }

  /** The clock reading after which the challenge has expired. */
  get expiresAtMs(): number {
    return this.#issuedAtMs + REGISTER_CHALLENGE_MS;
  }

  snapshot(): RegistrationSnapshot {
    return { nonce: this.#nonce, issuedAtMs: this.#issuedAtMs, state: this.#state };
  }

  /**
   * Ends the registration if the challenge is past its time (or the clock is not readable),
   * with or without an attempt in flight. Returns true if it ended it now.
   */
  expire(): boolean {
    if (this.#state !== "challenged" && this.#state !== "verifying") return false;
    if (this.#inTime()) return false;
    this.#end();
    return true;
  }

  /** Ends the registration, for a socket that closed. Safe to call any number of times. */
  abort(): void {
    if (this.#state === "challenged" || this.#state === "verifying") this.#end();
  }

  /** Checks the socket's one register proof. Any failure ends the registration for good. */
  async register(proof: string): Promise<RegisterProofResult> {
    if (this.#state !== "challenged") return { ok: false, code: "already_used" };
    const token = {};
    this.#attempt = token;
    this.#state = "verifying";
    let result: RegisterProofResult;
    let storedSuccess = false;
    try {
      await this.#options.persist?.(this.snapshot());
      result = await this.#verify(token, proof);
      if (result.ok) {
        // Still cancellable while the success is stored: an abort or an expiry during the
        // wait wins, and the failure is stored after it.
        storedSuccess = true;
        await this.#options.persist?.({ ...this.snapshot(), state: "registered" });
        if (!this.#live(token)) result = this.#lost(token);
      }
    } catch {
      result = { ok: false, code: "store_failed" };
    }
    if (result.ok) {
      this.#attempt = null;
      this.#state = "registered";
      return result;
    }
    const current = this.#attempt === token;
    if (current) this.#end();
    if (current || storedSuccess) {
      try {
        await this.#options.persist?.(this.snapshot());
      } catch {
        return { ok: false, code: "store_failed" };
      }
    }
    return result;
  }

  async #verify(token: object, proof: string): Promise<RegisterProofResult> {
    const options = this.#options;
    let wallMs: number;
    try {
      wallMs = checkMillis(options.wallClock(), "The wall clock");
    } catch {
      return { ok: false, code: "bad_clock" };
    }
    if (!this.#live(token)) return this.#lost(token);
    const result = await verifyRegisterProof({
      proof,
      relayId: this.#relayId,
      audience: this.#origin,
      nonce: this.#nonce,
      nowMs: wallMs,
      replay: options.replay,
      allowLoopbackWs: this.#allowLoopbackWs,
    });
    if (!result.ok) return result;
    // A store that took its time may have outlasted the challenge or the socket.
    if (!this.#live(token)) return this.#lost(token);
    const live = (): boolean => this.#live(token);
    let claimed: boolean;
    try {
      claimed = await options.claims.claim(result.relayId, Uint8Array.from(result.publicKey), {
        get live() {
          return live();
        },
      });
    } catch {
      return { ok: false, code: "store_failed" };
    }
    if (!this.#live(token)) return this.#lost(token);
    return claimed === true ? result : { ok: false, code: "claimed_by_other_key" };
  }

  /** True while `token` is the attempt in flight and the challenge is in time. */
  #live(token: object): boolean {
    return this.#attempt === token && this.#state === "verifying" && this.#inTime();
  }

  /** Why a live check failed, ending the registration if it has not ended yet. */
  #lost(token: object): RegisterProofResult {
    const clockOk = this.#read() !== null;
    const aborted = this.#attempt !== token || this.#state !== "verifying";
    if (!aborted) this.#end();
    if (aborted) return { ok: false, code: "aborted" };
    return { ok: false, code: clockOk ? "challenge_expired" : "bad_clock" };
  }

  #inTime(): boolean {
    const now = this.#read();
    if (now === null) return false;
    const elapsed = now - this.#issuedAtMs;
    return elapsed >= 0 && elapsed <= REGISTER_CHALLENGE_MS;
  }

  /** A checked clock reading, or null for one that is not whole milliseconds or went back. */
  #read(): number | null {
    let now: number;
    try {
      now = checkMillis(this.#options.clock(), "The clock");
    } catch {
      return null;
    }
    if (now < this.#lastReading) return null;
    this.#lastReading = now;
    return now;
  }

  #end(): void {
    this.#attempt = null;
    this.#state = "failed";
  }
}
