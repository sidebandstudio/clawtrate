// The session request: how a device proves to the account service that a request comes from
// the holder of its session key. The device builds the whole structure; the only value in it
// the service chose is the challenge nonce. It is signed with the session key, under its own
// label, and never with the list key.
//
// What it relies on: each session key belongs to exactly one account (no account id is signed),
// and the service takes each challenge once and issues it for this device alone. Both are the
// service's to keep.

import { checkLength, copy, equalBytes, Reader, taggedHash, Writer } from "./bytes.ts";
import { fail } from "./errors.ts";
import { SessionPublicKey, signSession, verifyEd25519, type SessionSecretKey } from "./keys.ts";
import { LABEL, TAG } from "./labels.ts";
import { MAX_AUDIENCE_BYTES, MAX_BODY_BYTES, MAX_PATH_BYTES, SESSION_SKEW_MS } from "./limits.ts";

/**
 * The service's origin: `https://host[:port]` in lowercase, where the host is a DNS name or an
 * IPv4 address (an IPv6 literal is not accepted). `http:` on loopback is accepted only when the
 * caller says it is a development build: on a shared machine another user could listen on that
 * port first. A port is 1 to 65535 with no leading zero. A path is printable ASCII with no space.
 */
const HTTPS_AUDIENCE = /^https:\/\/[0-9a-z.-]+(:[1-9][0-9]{0,4})?$/;
const LOOPBACK_AUDIENCE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:[1-9][0-9]{0,4})?$/;

function isAudience(audience: string, development: boolean): boolean {
  const port = /:([0-9]+)$/.exec(audience)?.[1];
  if (port !== undefined && Number(port) > 65535) return false;
  return HTTPS_AUDIENCE.test(audience) || (development && LOOPBACK_AUDIENCE.test(audience));
}
const PATH = /^\/[\x21-\x7e]*$/;

const METHODS = ["GET", "POST", "PUT", "DELETE"] as const;
export type SessionMethod = (typeof METHODS)[number];

export interface SessionRequestFields {
  /** The account service's origin, as the device was configured with it. */
  readonly audience: string;
  /** The service's challenge nonce, 32 bytes. */
  readonly challenge: Uint8Array;
  /** The device's clock, in milliseconds since 1970. */
  readonly issuedAtMs: number;
  readonly method: SessionMethod;
  readonly path: string;
  /** The request's body, hashed into the request. Empty for none. */
  readonly body: Uint8Array;
  /** A development build, talking to a service on loopback over `http:`. Never set in a release. */
  readonly development?: boolean;
}

function checkFields(fields: SessionRequestFields): void {
  if (!isAudience(fields.audience, fields.development === true))
    fail("malformed", "the audience is not an origin");
  if (!PATH.test(fields.path)) fail("malformed", "the path is not a path");
  if (!METHODS.includes(fields.method)) fail("malformed", "unknown method");
}

function bodyHash(body: Uint8Array): Uint8Array {
  if (!(body instanceof Uint8Array)) fail("bad_argument", "the body is bytes");
  if (body.length > MAX_BODY_BYTES) fail("too_large", "the body is over its bound");
  return taggedHash(TAG.sessionBody, body);
}

/** The device signs a request to the account service with its session key. */
export function signSessionRequest(
  key: SessionSecretKey,
  fields: SessionRequestFields,
): Uint8Array {
  checkFields(fields);
  const signed = new Writer()
    .label(LABEL.sessionRequest)
    .text(fields.audience, 1, MAX_AUDIENCE_BYTES, "audience")
    .fixed(key.publicKey.bytes, 32, "session key")
    .fixed(checkLength(fields.challenge, 32, "a challenge"), 32, "challenge")
    .u64(fields.issuedAtMs)
    .u8(METHODS.indexOf(fields.method) + 1)
    .text(fields.path, 1, MAX_PATH_BYTES, "path")
    .fixed(bodyHash(fields.body), 32, "body hash")
    .finish();
  return new Writer()
    .fixed(signed, signed.length, "request")
    .fixed(signSession(key, signed), 64, "signature")
    .finish();
}

/**
 * The service checks a session request against the request it arrived with, the challenge it
 * issued and its own clock, and returns the session key that signed it. Whether that key is a
 * device of the account is the service's to check.
 */
export function verifySessionRequest(
  bytes: Uint8Array,
  expected: Omit<SessionRequestFields, "issuedAtMs"> & { readonly nowMs: number },
): SessionPublicKey {
  const reader = new Reader(copy(bytes));
  reader.label(LABEL.sessionRequest);
  const audience = reader.text(1, MAX_AUDIENCE_BYTES, "audience");
  const key = SessionPublicKey.fromBytes(reader.fixed(32, "session key"));
  const challenge = reader.fixed(32, "challenge");
  const issuedAtMs = reader.u64("time");
  const method = METHODS[reader.u8() - 1];
  if (method === undefined) fail("malformed", "unknown method");
  const path = reader.text(1, MAX_PATH_BYTES, "path");
  const hash = reader.fixed(32, "body hash");
  const signed = reader.before();
  const signature = reader.fixed(64, "signature");
  reader.end();
  if (!isAudience(audience, expected.development === true) || !PATH.test(path))
    fail("malformed", "the audience or path is not well formed");
  if (!verifyEd25519(key.bytes, signed, signature))
    fail("bad_signature", "the session request's signature does not verify");
  if (
    audience !== expected.audience ||
    method !== expected.method ||
    path !== expected.path ||
    !equalBytes(challenge, checkLength(expected.challenge, 32, "a challenge")) ||
    !equalBytes(hash, bodyHash(expected.body))
  ) {
    fail("bad_challenge", "the request answers another challenge, service or request");
  }
  if (!Number.isSafeInteger(expected.nowMs) || expected.nowMs < 0)
    fail("bad_time", "the service's clock is not whole ms");
  if (Math.abs(expected.nowMs - issuedAtMs) > SESSION_SKEW_MS)
    fail("bad_time", "the request's time is out of range");
  return key;
}
