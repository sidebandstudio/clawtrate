// HPKE (RFC 9180), base mode, single-shot, with exactly one suite:
// DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305 (kem 0x0020, kdf 0x0001,
// aead 0x0003). Written from the RFC's sections 4, 5.1, 5.2 and 7.1.3 and checked against its
// test vector A.2.1. Only sequence number 0 is used: each sealing is one message to one key.
// The ephemeral key comes from DeriveKeyPair over 32 random bytes the caller supplies.

import { x25519 } from "@noble/curves/ed25519.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { expand, extract } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concat, utf8 } from "./bytes.ts";
import { fail } from "./errors.ts";

const KEM_SUITE = concat(utf8("KEM"), Uint8Array.of(0x00, 0x20));
const HPKE_SUITE = concat(utf8("HPKE"), Uint8Array.of(0x00, 0x20, 0x00, 0x01, 0x00, 0x03));
const VERSION = utf8("HPKE-v1");
const EMPTY = new Uint8Array(0);

function labeledExtract(suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array) {
  return extract(sha256, concat(VERSION, suite, utf8(label), ikm), salt);
}

function labeledExpand(suite: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, length: number) {
  const prefix = Uint8Array.of(length >>> 8, length & 0xff);
  return expand(sha256, prk, concat(prefix, VERSION, suite, utf8(label), info), length);
}

/** RFC 9180 section 7.1.3, for X25519: the secret key is 32 bytes expanded from `ikm`. */
export function deriveSealKeyPair(ikm: Uint8Array): { secretKey: Uint8Array; publicKey: Uint8Array } {
  const prk = labeledExtract(KEM_SUITE, EMPTY, "dkp_prk", ikm);
  const secretKey = labeledExpand(KEM_SUITE, prk, "sk", EMPTY, 32);
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

/** X25519, refusing the all-zero result as RFC 9180 section 7.1.4 requires. */
function dh(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  try {
    return x25519.getSharedSecret(secretKey, publicKey);
  } catch {
    fail("bad_key", "key exchange gave zero");
  }
}

function sharedSecret(dhResult: Uint8Array, enc: Uint8Array, recipient: Uint8Array): Uint8Array {
  const prk = labeledExtract(KEM_SUITE, EMPTY, "eae_prk", dhResult);
  return labeledExpand(KEM_SUITE, prk, "shared_secret", concat(enc, recipient), 32);
}

/** The key schedule of section 5.1, mode base (0), with no PSK. */
function keySchedule(shared: Uint8Array, info: Uint8Array): { key: Uint8Array; nonce: Uint8Array } {
  const pskIdHash = labeledExtract(HPKE_SUITE, EMPTY, "psk_id_hash", EMPTY);
  const infoHash = labeledExtract(HPKE_SUITE, EMPTY, "info_hash", info);
  const context = concat(Uint8Array.of(0), pskIdHash, infoHash);
  const secret = labeledExtract(HPKE_SUITE, shared, "secret", EMPTY);
  return {
    key: labeledExpand(HPKE_SUITE, secret, "key", context, 32),
    nonce: labeledExpand(HPKE_SUITE, secret, "base_nonce", context, 12),
  };
}

/** Seals `plaintext` to `recipient` (a checked X25519 public key). Returns `enc` and the ciphertext. */
export function hpkeSeal(
  recipient: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
  ikmE: Uint8Array,
): { enc: Uint8Array; ciphertext: Uint8Array } {
  const ephemeral = deriveSealKeyPair(ikmE);
  const enc = ephemeral.publicKey;
  const shared = sharedSecret(dh(ephemeral.secretKey, recipient), enc, recipient);
  const { key, nonce } = keySchedule(shared, info);
  return { enc, ciphertext: chacha20poly1305(key, nonce, aad).encrypt(plaintext) };
}

/** Opens what `hpkeSeal` sealed to the key pair `secretKey`/`publicKey`. */
export function hpkeOpen(
  secretKey: Uint8Array,
  publicKey: Uint8Array,
  enc: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  let dhResult: Uint8Array;
  try {
    dhResult = dh(secretKey, enc);
  } catch {
    fail("decrypt_failed", "sealed bytes did not open");
  }
  const shared = sharedSecret(dhResult, enc, publicKey);
  const { key, nonce } = keySchedule(shared, info);
  try {
    return chacha20poly1305(key, nonce, aad).decrypt(ciphertext);
  } catch {
    fail("decrypt_failed", "sealed bytes did not open");
  }
}
