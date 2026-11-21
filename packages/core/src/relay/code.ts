// The relay pairing code: what the desktop or the connector shows as a QR code, and what the
// phone scans or pastes. It is base64url (unpadded) of one flat JSON object:
//
//   { "v": 1,
//     "relay": "wss://relay.example",                the relay's canonical origin
//     "relayId": "<26 chars>",                       the connector's relay id
//     "connectorKey": "<43 chars>",                  its Noise static key, pinned
//     "enroll": "<43 chars>",                        the 32-byte one-time enrollment secret
//     "expiresAtMs": 1794921969869,                  when the enrollment secret expires
//     "openclaw": "<OpenClaw setup code>" }          made with `openclaw qr --url <dial URL>`
//
// The OpenClaw setup code is the gateway's own `{url, bootstrapToken, expiresAtMs}`, also
// base64url JSON; its `url` must be this route's dial address. Parsing is strict and bounded:
// the length is checked before anything is decoded, a repeated member name is refused, and so
// is any member, value or spelling other than the ones above.

import {
  ENROLL_SECRET_BYTES,
  fromBase64Url,
  isRelayId,
  readFlatObject,
  toBase64Url,
  utf8Decode,
  utf8Encode,
  type FlatValue,
} from "@clawtrate/relay-protocol";
import {
  connectorKeyBytes,
  isCanonicalOrigin,
  relayDialUrl,
  type RelayRoute,
  type RelayRouteOptions,
} from "./route.ts";

/** The longest code text read, after trimming. Checked before decoding. */
export const MAX_RELAY_CODE_CHARS = 4096;
/** The longest OpenClaw setup code inside a relay code. */
export const MAX_SETUP_CODE_CHARS = 2048;
/** The longest bootstrap token inside the OpenClaw setup code. */
export const MAX_BOOTSTRAP_TOKEN_CHARS = 512;
/**
 * The furthest ahead a code's expiry may be. OpenClaw's codes last 10 minutes; a code that
 * claims to last longer than this was not made by `openclaw qr`, or the clocks disagree.
 */
export const MAX_RELAY_CODE_LIFETIME_MS = 60 * 60 * 1000;
export const RELAY_CODE_VERSION = 1;

const CODE_KEYS = ["connectorKey", "enroll", "expiresAtMs", "openclaw", "relay", "relayId", "v"];
const SETUP_KEYS = ["bootstrapToken", "expiresAtMs", "url"];
/** Printable ASCII without spaces: what a bootstrap token is made of. */
const TOKEN_CHARS = /^[\x21-\x7e]+$/;

export type RelayCodeErrorCode =
  /** Not a relay code this version reads: wrong shape, field, value or spelling. */
  | "malformed"
  /** Longer than a relay code can be. */
  | "too_large"
  /** The enrollment secret or the OpenClaw setup code has expired. */
  | "expired"
  /** An expiry further ahead than `MAX_RELAY_CODE_LIFETIME_MS`. */
  | "bad_expiry";

export class RelayCodeError extends Error {
  readonly code: RelayCodeErrorCode;
  constructor(code: RelayCodeErrorCode, message: string) {
    super(message);
    this.name = "RelayCodeError";
    this.code = code;
  }
}

export type RelayCode = {
  readonly route: RelayRoute;
  /** The one-time enrollment secret, 32 bytes. The caller wipes it once it is used. */
  readonly enroll: Uint8Array;
  /** The gateway's bootstrap token from the OpenClaw setup code. */
  readonly bootstrapToken: string;
  /** The earlier of the two expiries: after this the code is no use. */
  readonly expiresAtMs: number;
};

export type RelayCodeFields = {
  readonly route: RelayRoute;
  readonly enroll: Uint8Array;
  readonly expiresAtMs: number;
  /** The OpenClaw setup code, exactly as `openclaw qr` printed it. */
  readonly setupCode: string;
};

function bad(message: string): never {
  throw new RelayCodeError("malformed", message);
}

/** Decodes canonical base64url holding strict UTF-8, then one flat JSON object with exactly `keys`. */
function readObject(text: string, keys: readonly string[], what: string): Map<string, FlatValue> {
  const bytes = fromBase64Url(text);
  if (bytes === null) bad(`The ${what} is not base64url.`);
  let members: Map<string, FlatValue>;
  try {
    members = readFlatObject(utf8Decode(bytes));
  } catch {
    return bad(`The ${what} is not one flat JSON object with distinct names.`);
  }
  const names = [...members.keys()].sort();
  if (names.length !== keys.length || names.some((name, index) => name !== keys[index])) {
    bad(`The ${what} has other fields than it may.`);
  }
  return members;
}

function checkExpiry(value: FlatValue | undefined, nowMs: number, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    bad(`The ${what}'s expiry is not a whole number of milliseconds.`);
  }
  if (nowMs >= value) throw new RelayCodeError("expired", `The ${what} has expired.`);
  if (value - nowMs > MAX_RELAY_CODE_LIFETIME_MS) {
    throw new RelayCodeError("bad_expiry", `The ${what}'s expiry is too far ahead.`);
  }
  return value;
}

/**
 * Reads a scanned or pasted relay code. Surrounding whitespace is ignored; anything else that
 * is not exactly a relay code, or a code that has expired at `nowMs`, throws `RelayCodeError`.
 */
export function parseRelayCode(
  input: string,
  nowMs: number,
  options: RelayRouteOptions = {},
): RelayCode {
  if (typeof input !== "string") bad("A relay code is text.");
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) bad("The time is not a whole number.");
  // Bounded before trimming or decoding: whitespace around a code is short.
  if (input.length > MAX_RELAY_CODE_CHARS * 2) {
    throw new RelayCodeError("too_large", "That is longer than a relay code.");
  }
  const text = input.trim();
  if (text.length > MAX_RELAY_CODE_CHARS) {
    throw new RelayCodeError("too_large", "That is longer than a relay code.");
  }
  const code = readObject(text, CODE_KEYS, "relay code");
  if (code.get("v") !== RELAY_CODE_VERSION) bad("The relay code is of another version.");
  const relayOrigin = code.get("relay");
  if (typeof relayOrigin !== "string" || !isCanonicalOrigin(relayOrigin, options)) {
    bad("The relay address is not a canonical wss: origin.");
  }
  const relayId = code.get("relayId");
  if (!isRelayId(relayId)) bad("The relay id is not canonical.");
  const key = connectorKeyBytes(code.get("connectorKey"));
  if (key === null) bad("The connector key is not a 32-byte key.");
  const enrollText = code.get("enroll");
  const enroll = typeof enrollText === "string" ? fromBase64Url(enrollText) : null;
  if (
    enroll === null ||
    enroll.length !== ENROLL_SECRET_BYTES ||
    toBase64Url(enroll) !== enrollText
  ) {
    bad("The enrollment secret is not 32 bytes.");
  }
  const route: RelayRoute = {
    kind: "relay",
    relayOrigin,
    relayId,
    connectorKey: toBase64Url(key),
  };
  const setupCode = code.get("openclaw");
  if (typeof setupCode !== "string") bad("The OpenClaw setup code is missing.");
  if (setupCode.length > MAX_SETUP_CODE_CHARS) {
    throw new RelayCodeError("too_large", "The OpenClaw setup code is too long.");
  }
  const setup = readObject(setupCode, SETUP_KEYS, "OpenClaw setup code");
  if (setup.get("url") !== relayDialUrl(route)) {
    bad("The OpenClaw setup code is for another address than this relay route.");
  }
  const bootstrapToken = setup.get("bootstrapToken");
  if (
    typeof bootstrapToken !== "string" ||
    bootstrapToken.length > MAX_BOOTSTRAP_TOKEN_CHARS ||
    !TOKEN_CHARS.test(bootstrapToken)
  ) {
    bad("The bootstrap token is not a token.");
  }
  const enrollExpiry = checkExpiry(code.get("expiresAtMs"), nowMs, "relay code");
  const setupExpiry = checkExpiry(setup.get("expiresAtMs"), nowMs, "OpenClaw setup code");
  return { route, enroll, bootstrapToken, expiresAtMs: Math.min(enrollExpiry, setupExpiry) };
}

/** Makes the text of a relay code, for whoever shows one and for tests. */
export function encodeRelayCode(fields: RelayCodeFields): string {
  const json = JSON.stringify({
    v: RELAY_CODE_VERSION,
    relay: fields.route.relayOrigin,
    relayId: fields.route.relayId,
    connectorKey: fields.route.connectorKey,
    enroll: toBase64Url(fields.enroll),
    expiresAtMs: fields.expiresAtMs,
    openclaw: fields.setupCode,
  });
  return toBase64Url(utf8Encode(json));
}

/** An OpenClaw setup code as `openclaw qr` encodes one, for tests and stand-ins. */
export function encodeSetupCode(setup: {
  url: string;
  bootstrapToken: string;
  expiresAtMs: number;
}): string {
  return toBase64Url(utf8Encode(JSON.stringify(setup)));
}
