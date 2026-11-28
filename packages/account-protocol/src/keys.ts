// The keys, one class per key and purpose, so one can never be passed where another is
// expected. A public key is checked when it is made from bytes. A secret key is made from 32
// random bytes the caller supplies, through HKDF-SHA256 with an info naming its one purpose, so
// the same bytes never give the same key in two roles. A secret never leaves its object except
// to this package's own signing, opening and derivation functions. Every object is frozen.

import { ed25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { checkLength, copy, equalBytes, utf8 } from "./bytes.ts";
import { fail } from "./errors.ts";
import { deriveSealKeyPair } from "./hpke.ts";
import { TAG } from "./labels.ts";

/** HKDF-SHA256 of a key's 32 random bytes, with no salt and the purpose's tag as info. */
function keyFor(random: Uint8Array, tag: string): Uint8Array {
  return hkdf(sha256, random, undefined, utf8(tag), 32);
}

/**
 * An Ed25519 public key must be the one encoding of a point in the prime-order subgroup, other
 * than a point of small order. A small-order or mixed key would let anyone make signatures
 * that verify under it.
 */
function checkEd25519(bytes: Uint8Array, what: string): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32)
    fail("bad_key", `${what}: not 32 bytes`);
  const own = copy(bytes);
  let point;
  try {
    point = ed25519.Point.fromBytes(own, false);
  } catch {
    fail("bad_key", `${what}: not a point`);
  }
  if (!equalBytes(point.toBytes(), own)) fail("bad_key", `${what}: not the canonical encoding`);
  if (point.isSmallOrder() || !point.isTorsionFree())
    fail("bad_key", `${what}: not of prime order`);
  return own;
}

/**
 * Ed25519 verification that accepts only signatures every common implementation accepts:
 * RFC 8032's strict decoding of R and A (not ZIP-215), S below the group order, and R neither of
 * small order (the identity included) nor with a small-order part. Noble checks the cofactored
 * equation; with A (checked when its key was made) and R both of prime order, it accepts what
 * the cofactorless equation of RFC 8032, OpenSSL, libsodium and strict verifiers accept.
 */
export function verifyEd25519(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (signature.length !== 64) return false;
  try {
    const r = ed25519.Point.fromBytes(signature.subarray(0, 32), false);
    if (r.isSmallOrder() || !r.isTorsionFree()) return false;
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}

const P = 2n ** 255n - 19n;

function modPow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = base % P;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}

/**
 * An X25519 public key must be a canonical u-coordinate (top bit clear, below 2^255 - 19) of a
 * point in the prime-order subgroup. It is mapped to its Edwards point (y = (u - 1) / (u + 1)),
 * which must exist (so u is not on the twist) and be of prime order (so no small-order part).
 * Each key then has one encoding, and a key exchange with it never gives zero.
 */
function checkX25519(bytes: Uint8Array, what: string): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32)
    fail("bad_key", `${what}: not 32 bytes`);
  const own = copy(bytes);
  let u = 0n;
  for (let i = 31; i >= 0; i--) u = (u << 8n) | BigInt(own[i]!);
  if (u >= P) fail("bad_key", `${what}: not the canonical encoding`);
  if (u + 1n === P) fail("bad_key", `${what}: of small order`);
  const y = ((u - 1n + P) * modPow(u + 1n, P - 2n)) % P;
  const encoded = new Uint8Array(32);
  let rest = y;
  for (let i = 0; i < 32; i++) {
    encoded[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  let point;
  try {
    point = ed25519.Point.fromBytes(encoded, false);
  } catch {
    fail("bad_key", `${what}: not on the curve`);
  }
  if (point.isSmallOrder() || !point.isTorsionFree())
    fail("bad_key", `${what}: not of prime order`);
  return own;
}

/** The session key's public half: what the account service checks session requests against. */
export class SessionPublicKey {
  readonly #bytes: Uint8Array;
  readonly kind = "session-public";

  private constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    Object.freeze(this);
  }

  static fromBytes(bytes: Uint8Array): SessionPublicKey {
    return new SessionPublicKey(checkEd25519(bytes, "session key"));
  }

  get bytes(): Uint8Array {
    return copy(this.#bytes);
  }

  equals(other: SessionPublicKey): boolean {
    return equalBytes(this.#bytes, other.#bytes);
  }
}

/** The list key's public half: what list entries, refusals and a join's reveal are checked against. */
export class ListPublicKey {
  readonly #bytes: Uint8Array;
  readonly kind = "list-public";

  private constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    Object.freeze(this);
  }

  static fromBytes(bytes: Uint8Array): ListPublicKey {
    return new ListPublicKey(checkEd25519(bytes, "list key"));
  }

  get bytes(): Uint8Array {
    return copy(this.#bytes);
  }

  equals(other: ListPublicKey): boolean {
    return equalBytes(this.#bytes, other.#bytes);
  }
}

/** A device's sealing key (X25519): what the list secret and the card are sealed to. */
export class SealPublicKey {
  readonly #bytes: Uint8Array;
  readonly kind = "seal-public";

  private constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    Object.freeze(this);
  }

  static fromBytes(bytes: Uint8Array): SealPublicKey {
    return new SealPublicKey(checkX25519(bytes, "seal key"));
  }

  get bytes(): Uint8Array {
    return copy(this.#bytes);
  }

  equals(other: SealPublicKey): boolean {
    return equalBytes(this.#bytes, other.#bytes);
  }
}

/** A device's OpenClaw device identity (Ed25519), which the connector matches pairing requests to. */
export class GatewayDeviceKey {
  readonly #bytes: Uint8Array;
  readonly kind = "gateway-device-public";

  private constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    Object.freeze(this);
  }

  static fromBytes(bytes: Uint8Array): GatewayDeviceKey {
    return new GatewayDeviceKey(checkEd25519(bytes, "gateway device key"));
  }

  get bytes(): Uint8Array {
    return copy(this.#bytes);
  }

  equals(other: GatewayDeviceKey): boolean {
    return equalBytes(this.#bytes, other.#bytes);
  }
}

// Each secret key class hands its secret to this module's functions alone, through an accessor
// set once in its static block. Nothing outside the package can reach these accessors: the
// package exports only what `index.ts` names, and a lint rule refuses imports of `src/` from
// outside the package.
let sessionSeed!: (key: SessionSecretKey) => Uint8Array;
let listSeed!: (key: ListSecretKey) => Uint8Array;
let listRoot!: (key: ListSecretKey) => Uint8Array;
let sealSecret!: (key: SealSecretKey) => Uint8Array;

/** The session key (Ed25519). Signs session requests and nothing else. */
export class SessionSecretKey {
  readonly #seed: Uint8Array;
  readonly publicKey: SessionPublicKey;
  readonly kind = "session-secret";

  static {
    sessionSeed = (key) => key.#seed;
  }

  private constructor(seed: Uint8Array) {
    this.#seed = seed;
    this.publicKey = SessionPublicKey.fromBytes(ed25519.getPublicKey(seed));
    Object.freeze(this);
  }

  /** `random` is 32 bytes from the system's random source. */
  static fromSeed(random: Uint8Array): SessionSecretKey {
    return new SessionSecretKey(
      keyFor(checkLength(random, 32, "a session key's seed"), TAG.sessionKey),
    );
  }
}

/**
 * The list key (Ed25519). Signs list entries, refusals, a card (the connector's) and join
 * steps. Its 32 random bytes also key the values the package derives for it: its answer nonces
 * and decoys, and the hedges on its ephemeral keys.
 */
export class ListSecretKey {
  readonly #root: Uint8Array;
  readonly #seed: Uint8Array;
  readonly publicKey: ListPublicKey;
  readonly kind = "list-secret";

  static {
    listSeed = (key) => key.#seed;
    listRoot = (key) => key.#root;
  }

  private constructor(root: Uint8Array) {
    this.#root = root;
    this.#seed = keyFor(root, TAG.listKey);
    this.publicKey = ListPublicKey.fromBytes(ed25519.getPublicKey(this.#seed));
    Object.freeze(this);
  }

  /** `random` is 32 bytes from the system's random source. */
  static fromSeed(random: Uint8Array): ListSecretKey {
    return new ListSecretKey(copy(checkLength(random, 32, "a list key's seed")));
  }
}

/** The sealing key (X25519, derived as HPKE's DeriveKeyPair). Opens what is sealed to this device. */
export class SealSecretKey {
  readonly #secret: Uint8Array;
  readonly publicKey: SealPublicKey;
  readonly kind = "seal-secret";

  static {
    sealSecret = (key) => key.#secret;
  }

  private constructor(secret: Uint8Array, publicKey: Uint8Array) {
    this.#secret = secret;
    this.publicKey = SealPublicKey.fromBytes(publicKey);
    Object.freeze(this);
  }

  /** `random` is 32 bytes from the system's random source. */
  static fromSeed(random: Uint8Array): SealSecretKey {
    const ikm = keyFor(checkLength(random, 32, "a seal key's seed"), TAG.sealKey);
    const pair = deriveSealKeyPair(ikm);
    return new SealSecretKey(pair.secretKey, pair.publicKey);
  }
}

/** For this package's builders only; `index.ts` does not export it. */
export function signSession(key: SessionSecretKey, message: Uint8Array): Uint8Array {
  return ed25519.sign(message, sessionSeed(key));
}

/** For this package's builders only; `index.ts` does not export it. */
export function signList(key: ListSecretKey, message: Uint8Array): Uint8Array {
  return ed25519.sign(message, listSeed(key));
}

/**
 * For this package only: a value derived from a list key's random bytes, HKDF-SHA256 with the
 * given salt and info. Every caller passes an info that begins with a tag of its own.
 */
export function deriveFromListKey(
  key: ListSecretKey,
  salt: Uint8Array | undefined,
  info: Uint8Array,
  length: number,
): Uint8Array {
  return hkdf(sha256, listRoot(key), salt, info, length);
}

/** For this package's opening functions only; `index.ts` does not export it. */
export function sealSecretBytes(key: SealSecretKey): Uint8Array {
  return sealSecret(key);
}
