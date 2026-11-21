// Noise_IK_25519_ChaChaPoly_SHA256, written from the Noise Protocol Framework, revision 34
// (https://noiseprotocol.org/noise.html), sections 5 and 7. Only the IK pattern is built:
//
//   IK:
//     <- s
//     ...
//     -> e, es, s, ss
//     <- e, ee, se
//
// The initiator (the phone) knows the responder's (the connector's) static key in advance,
// from the pairing code.

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, secureRandomBytes, utf8Encode, type RandomBytes } from "./bytes.ts";
import { fail, RelayProtocolError } from "./errors.ts";
import { KEY_BYTES, NOISE_MAX_MESSAGE_BYTES, TAG_BYTES } from "./limits.ts";

export const NOISE_PROTOCOL_NAME = "Noise_IK_25519_ChaChaPoly_SHA256";

const HASH_BYTES = 32;
const EMPTY = new Uint8Array(0);
/** Noise reserves 2^64-1; a JavaScript number counts exactly to 2^53-1, which no session reaches. */
const MAX_NONCE = Number.MAX_SAFE_INTEGER;

export interface KeyPair {
  readonly secretKey: Uint8Array;
  readonly publicKey: Uint8Array;
}

/** An X25519 key pair for Noise: the phone's or the connector's static key. */
export function generateKeyPair(random: RandomBytes = secureRandomBytes): KeyPair {
  return keyPairFromSecret(random(KEY_BYTES));
}

export function keyPairFromSecret(secretKey: Uint8Array): KeyPair {
  if (secretKey.length !== KEY_BYTES) fail("bad_key", "An X25519 secret key is 32 bytes.");
  return { secretKey: Uint8Array.from(secretKey), publicKey: x25519.getPublicKey(secretKey) };
}

function dh(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== KEY_BYTES) fail("bad_key", "An X25519 public key is 32 bytes.");
  let shared: Uint8Array;
  try {
    // noble refuses low-order points, whose shared secret is all zero.
    shared = x25519.getSharedSecret(secretKey, publicKey);
  } catch {
    return fail("bad_key", "The peer's key is a low-order point.");
  }
  let any = 0;
  for (const byte of shared) any |= byte;
  if (any === 0) fail("bad_key", "The peer's key is a low-order point.");
  return shared;
}

function hkdf2(chainingKey: Uint8Array, input: Uint8Array): [Uint8Array, Uint8Array] {
  const tempKey = hmac(sha256, chainingKey, input);
  const out1 = hmac(sha256, tempKey, Uint8Array.of(1));
  const out2 = hmac(sha256, tempKey, concatBytes(out1, Uint8Array.of(2)));
  return [out1, out2];
}

/** Noise section 5.1: a key and a counting nonce. */
export class CipherState {
  #key: Uint8Array | null;
  #nonce = 0;

  constructor(key: Uint8Array | null = null) {
    this.#key = key;
  }

  get hasKey(): boolean {
    return this.#key !== null;
  }

  #nonceBytes(): Uint8Array {
    if (this.#nonce >= MAX_NONCE)
      fail("nonce_exhausted", "This channel has sent its last message.");
    // 32 bits of zeros, then the 64-bit counter, little-endian (section 12.4).
    const out = new Uint8Array(12);
    const view = new DataView(out.buffer);
    view.setUint32(4, this.#nonce % 0x1_0000_0000, true);
    view.setUint32(8, Math.floor(this.#nonce / 0x1_0000_0000), true);
    return out;
  }

  encrypt(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (this.#key === null) return plaintext;
    const ciphertext = chacha20poly1305(this.#key, this.#nonceBytes(), ad).encrypt(plaintext);
    this.#nonce++;
    return ciphertext;
  }

  /** Fails with `decrypt_failed`; the counter only moves on success, as the specification says. */
  decrypt(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (this.#key === null) return ciphertext;
    if (ciphertext.length < TAG_BYTES)
      fail("decrypt_failed", "The message is shorter than its tag.");
    let plaintext: Uint8Array;
    try {
      plaintext = chacha20poly1305(this.#key, this.#nonceBytes(), ad).decrypt(ciphertext);
    } catch (error) {
      if (error instanceof RelayProtocolError) throw error;
      return fail("decrypt_failed", "The message failed authentication.");
    }
    this.#nonce++;
    return plaintext;
  }
}

/** Noise section 5.2. */
class SymmetricState {
  #chainingKey: Uint8Array;
  #hash: Uint8Array;
  #cipher = new CipherState();

  constructor(protocolName: string) {
    const name = utf8Encode(protocolName);
    const h = name.length <= HASH_BYTES ? new Uint8Array(HASH_BYTES) : sha256(name);
    if (name.length <= HASH_BYTES) h.set(name);
    this.#hash = h;
    this.#chainingKey = h;
  }

  get handshakeHash(): Uint8Array {
    return this.#hash;
  }

  mixKey(input: Uint8Array): void {
    const [chainingKey, key] = hkdf2(this.#chainingKey, input);
    this.#chainingKey = chainingKey;
    this.#cipher = new CipherState(key);
  }

  mixHash(data: Uint8Array): void {
    this.#hash = sha256(concatBytes(this.#hash, data));
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.#cipher.encrypt(this.#hash, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.#cipher.decrypt(this.#hash, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf2(this.#chainingKey, EMPTY);
    return [new CipherState(k1), new CipherState(k2)];
  }
}

export interface TransportKeys {
  /** Encrypts what this side sends. */
  readonly send: CipherState;
  /** Decrypts what this side receives. */
  readonly receive: CipherState;
  /** The handshake hash `h`, the same on both sides; it names this session. */
  readonly handshakeHash: Uint8Array;
}

export interface IKHandshakeOptions {
  readonly initiator: boolean;
  readonly prologue: Uint8Array;
  readonly staticKey: KeyPair;
  /** The responder's static public key. The initiator must have it; the responder learns it. */
  readonly remoteStaticKey?: Uint8Array;
  /** Where the ephemeral key comes from. Tests pass the vector's ephemeral key. */
  readonly random?: RandomBytes;
}

type Step = "write1" | "read1" | "write2" | "read2" | "done" | "failed";

/**
 * One IK handshake, as section 5.3's HandshakeState. Messages must be taken in order; any
 * failure, including a failed decryption, ends the handshake for good.
 */
export class IKHandshake {
  readonly #symmetric = new SymmetricState(NOISE_PROTOCOL_NAME);
  readonly #static: KeyPair;
  readonly #random: RandomBytes;
  #ephemeral: KeyPair | null = null;
  #remoteStatic: Uint8Array | null;
  #remoteEphemeral: Uint8Array | null = null;
  #step: Step;
  #keys: TransportKeys | null = null;

  constructor(options: IKHandshakeOptions) {
    this.#static = options.staticKey;
    this.#random = options.random ?? secureRandomBytes;
    this.#remoteStatic = options.remoteStaticKey ? Uint8Array.from(options.remoteStaticKey) : null;
    if (options.initiator && this.#remoteStatic?.length !== KEY_BYTES) {
      fail("bad_key", "The initiator needs the responder's 32-byte static key.");
    }
    this.#step = options.initiator ? "write1" : "read1";
    this.#symmetric.mixHash(options.prologue);
    // The pre-message `<- s`: both sides hash the responder's static key.
    this.#symmetric.mixHash(options.initiator ? this.#remoteStatic! : this.#static.publicKey);
  }

  /** The peer's static key: known to the initiator from the start, to the responder after message 1. */
  get remoteStaticKey(): Uint8Array | null {
    return this.#remoteStatic;
  }

  get complete(): boolean {
    return this.#step === "done";
  }

  /** The transport keys once the handshake is complete. */
  get transportKeys(): TransportKeys {
    if (this.#keys === null) return fail("unexpected", "The handshake is not complete.");
    return this.#keys;
  }

  #run<T>(step: Step, next: Step, body: () => T): T {
    if (this.#step !== step) {
      return fail("unexpected", `This handshake cannot take step ${step} now.`);
    }
    try {
      const result = body();
      this.#step = next;
      return result;
    } catch (error) {
      this.#step = "failed";
      this.#ephemeral?.secretKey.fill(0);
      this.#ephemeral = null;
      throw error;
    }
  }

  #newEphemeral(): Uint8Array {
    this.#ephemeral = keyPairFromSecret(this.#random(KEY_BYTES));
    this.#symmetric.mixHash(this.#ephemeral.publicKey);
    return this.#ephemeral.publicKey;
  }

  /** Initiator: `-> e, es, s, ss` and the payload. */
  writeMessage1(payload: Uint8Array): Uint8Array {
    return this.#run("write1", "read2", () => {
      const e = this.#newEphemeral();
      this.#symmetric.mixKey(dh(this.#ephemeral!.secretKey, this.#remoteStatic!));
      const s = this.#symmetric.encryptAndHash(this.#static.publicKey);
      this.#symmetric.mixKey(dh(this.#static.secretKey, this.#remoteStatic!));
      return checkSize(concatBytes(e, s, this.#symmetric.encryptAndHash(payload)));
    });
  }

  /** Responder: reads message 1 and returns its payload. */
  readMessage1(message: Uint8Array): Uint8Array {
    return this.#run("read1", "write2", () => {
      if (message.length < KEY_BYTES + KEY_BYTES + TAG_BYTES + TAG_BYTES) {
        fail("malformed", "Handshake message 1 is too short.");
      }
      checkSize(message);
      const re = message.subarray(0, KEY_BYTES);
      this.#remoteEphemeral = Uint8Array.from(re);
      this.#symmetric.mixHash(re);
      this.#symmetric.mixKey(dh(this.#static.secretKey, re));
      const rs = this.#symmetric.decryptAndHash(
        message.subarray(KEY_BYTES, KEY_BYTES + KEY_BYTES + TAG_BYTES),
      );
      this.#symmetric.mixKey(dh(this.#static.secretKey, rs));
      this.#remoteStatic = rs;
      return this.#symmetric.decryptAndHash(message.subarray(KEY_BYTES + KEY_BYTES + TAG_BYTES));
    });
  }

  /** Responder: `<- e, ee, se` and the payload. Completes the handshake. */
  writeMessage2(payload: Uint8Array): Uint8Array {
    return this.#run("write2", "done", () => {
      const e = this.#newEphemeral();
      this.#symmetric.mixKey(dh(this.#ephemeral!.secretKey, this.#remoteEphemeral!));
      this.#symmetric.mixKey(dh(this.#ephemeral!.secretKey, this.#remoteStatic!));
      const message = checkSize(concatBytes(e, this.#symmetric.encryptAndHash(payload)));
      const [initiatorToResponder, responderToInitiator] = this.#symmetric.split();
      this.#finish(responderToInitiator, initiatorToResponder);
      return message;
    });
  }

  /** Initiator: reads message 2 and returns its payload. Completes the handshake. */
  readMessage2(message: Uint8Array): Uint8Array {
    return this.#run("read2", "done", () => {
      if (message.length < KEY_BYTES + TAG_BYTES) {
        fail("malformed", "Handshake message 2 is too short.");
      }
      checkSize(message);
      const re = message.subarray(0, KEY_BYTES);
      this.#symmetric.mixHash(re);
      this.#symmetric.mixKey(dh(this.#ephemeral!.secretKey, re));
      this.#symmetric.mixKey(dh(this.#static.secretKey, re));
      const payload = this.#symmetric.decryptAndHash(message.subarray(KEY_BYTES));
      const [initiatorToResponder, responderToInitiator] = this.#symmetric.split();
      this.#finish(initiatorToResponder, responderToInitiator);
      return payload;
    });
  }

  #finish(send: CipherState, receive: CipherState): void {
    this.#keys = { send, receive, handshakeHash: this.#symmetric.handshakeHash };
    // Section 5.3: the ephemeral keys are no longer needed once the handshake is done.
    this.#ephemeral?.secretKey.fill(0);
    this.#ephemeral = null;
    this.#remoteEphemeral = null;
  }
}

function checkSize(message: Uint8Array): Uint8Array {
  if (message.length > NOISE_MAX_MESSAGE_BYTES) {
    fail("malformed", "A Noise message is at most 65535 bytes.");
  }
  return message;
}
