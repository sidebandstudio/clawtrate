// The keys, one class per key and purpose, so one can never be passed where another is
// expected. A public key is checked when it is made from bytes; a secret key is made from 32
// random bytes the caller supplies and never leaves its object except to the signing and
// opening functions of this package.

import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { checkLength, equalBytes } from "./bytes.ts";
import { fail } from "./errors.ts";
import { deriveSealKeyPair } from "./hpke.ts";

/**
 * An Ed25519 public key must be the one encoding of a point in the prime-order subgroup, other
 * than a point of small order. A small-order or mixed key would let anyone make signatures
 * that verify under it.
 */
function checkEd25519(bytes: Uint8Array, what: string): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) fail("bad_key", `${what}: not 32 bytes`);
  let point;
  try {
    point = ed25519.Point.fromBytes(bytes, false);
  } catch {
    fail("bad_key", `${what}: not a point`);
  }
  if (!equalBytes(point.toBytes(), bytes)) fail("bad_key", `${what}: not the canonical encoding`);
  if (point.isSmallOrder() || !point.isTorsionFree()) fail("bad_key", `${what}: not of prime order`);
  return bytes.slice();
}

/** RFC 8032 verification with its strict decoding (not ZIP-215), so a signature has one form. */
export function verifyEd25519(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}

const P = 2n ** 255n - 19n;
/** A clamped scalar: a multiple of 8, so a point of order dividing 8 multiplies to zero. */
const PROBE = Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 8 : i === 31 ? 0x40 : 0));

/**
 * An X25519 public key must be a canonical u-coordinate (top bit clear, below 2^255 - 19) and
 * not of small order, so it has one encoding and a key exchange with it never gives zero.
 */
function checkX25519(bytes: Uint8Array, what: string): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) fail("bad_key", `${what}: not 32 bytes`);
  let u = 0n;
  for (let i = 31; i >= 0; i--) u = (u << 8n) | BigInt(bytes[i]!);
  if (u >= P) fail("bad_key", `${what}: not the canonical encoding`);
  try {
    x25519.getSharedSecret(PROBE, bytes);
  } catch {
    fail("bad_key", `${what}: of small order`);
  }
  return bytes.slice();
}

/** The session key's public half: what the account service checks session requests against. */
export class SessionPublicKey {
  readonly #bytes: Uint8Array;
  readonly kind = "session-public";

  private constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  static fromBytes(bytes: Uint8Array): SessionPublicKey {
    return new SessionPublicKey(checkEd25519(bytes, "session key"));
  }

  get bytes(): Uint8Array {
    return this.#bytes.slice();
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
  }

  static fromBytes(bytes: Uint8Array): ListPublicKey {
    return new ListPublicKey(checkEd25519(bytes, "list key"));
  }

  get bytes(): Uint8Array {
    return this.#bytes.slice();
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
  }

  static fromBytes(bytes: Uint8Array): SealPublicKey {
    return new SealPublicKey(checkX25519(bytes, "seal key"));
  }

  get bytes(): Uint8Array {
    return this.#bytes.slice();
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
  }

  static fromBytes(bytes: Uint8Array): GatewayDeviceKey {
    return new GatewayDeviceKey(checkEd25519(bytes, "gateway device key"));
  }

  get bytes(): Uint8Array {
    return this.#bytes.slice();
  }

  equals(other: GatewayDeviceKey): boolean {
    return equalBytes(this.#bytes, other.#bytes);
  }
}

// Each secret key class hands its secret to this module's functions alone, through an accessor
// set once in its static block. Nothing outside the package can reach these accessors: the
// package exports only what `index.ts` names.
let sessionSeed!: (key: SessionSecretKey) => Uint8Array;
let listSeed!: (key: ListSecretKey) => Uint8Array;
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
  }

  /** `random` is 32 bytes from the system's random source. */
  static fromSeed(random: Uint8Array): SessionSecretKey {
    return new SessionSecretKey(checkLength(random, 32, "a session key's seed").slice());
  }
}

/** The list key (Ed25519). Signs list entries, refusals, a card (the connector's) and join steps. */
export class ListSecretKey {
  readonly #seed: Uint8Array;
  readonly publicKey: ListPublicKey;
  readonly kind = "list-secret";

  static {
    listSeed = (key) => key.#seed;
  }

  private constructor(seed: Uint8Array) {
    this.#seed = seed;
    this.publicKey = ListPublicKey.fromBytes(ed25519.getPublicKey(seed));
  }

  /** `random` is 32 bytes from the system's random source. */
  static fromSeed(random: Uint8Array): ListSecretKey {
    return new ListSecretKey(checkLength(random, 32, "a list key's seed").slice());
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
  }

  /** `random` is 32 bytes from the system's random source. */
  static fromSeed(random: Uint8Array): SealSecretKey {
    const pair = deriveSealKeyPair(checkLength(random, 32, "a seal key's seed"));
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

/** For this package's opening functions only; `index.ts` does not export it. */
export function sealSecretBytes(key: SealSecretKey): Uint8Array {
  return sealSecret(key);
}
