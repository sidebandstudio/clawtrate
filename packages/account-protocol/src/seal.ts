// The list secret: 32 random bytes the connector makes and every device member holds, so the
// account service can carry the list, the card and an entry on its way to the connector without
// reading them. A new secret, with the next epoch, is made whenever a member is removed and is
// sealed to each remaining device alone; the removed device opens nothing sealed after.

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { checkLength, concat, copy, equalBytes, Reader, utf8, Writer } from "./bytes.ts";
import { fail } from "./errors.ts";
import { hpkeOpen, hpkeSeal } from "./hpke.ts";
import {
  deriveFromListKey,
  ListPublicKey,
  sealSecretBytes,
  signList,
  verifyEd25519,
  type ListSecretKey,
  type SealSecretKey,
} from "./keys.ts";
import { LABEL, TAG } from "./labels.ts";
import {
  MAX_ADDRESSES,
  MAX_ENTRIES,
  MAX_HOST_BYTES,
  MAX_MEMBERS,
  MAX_NAME_BYTES,
} from "./limits.ts";
import { verifyCard, type Card } from "./card.ts";
import { MAX_ENTRY_BYTES, decodeList, encodeList, verifyList, type ListState } from "./list.ts";
import {
  checkContext,
  expectContext,
  readContext,
  writeContext,
  type ListContext,
} from "./records.ts";

/** The largest signed card: eight addresses of the longest host and the longest name. */
export const MAX_CARD_BYTES =
  LABEL.card.length +
  16 +
  4 +
  32 +
  32 +
  1 +
  MAX_ADDRESSES * (2 + MAX_HOST_BYTES + 2) +
  2 +
  MAX_NAME_BYTES +
  64;
/** The largest list as one byte string. */
export const MAX_LIST_BYTES = 2 + MAX_ENTRIES * (2 + MAX_ENTRY_BYTES);

let secretBytes!: (secret: ListSecret) => Uint8Array;

export class ListSecret {
  readonly #bytes: Uint8Array;
  readonly #epoch: number;

  static {
    secretBytes = (secret) => secret.#bytes;
  }

  private constructor(bytes: Uint8Array, epoch: number) {
    this.#bytes = bytes;
    this.#epoch = epoch;
    Object.freeze(this);
  }

  /** Which secret this is: the first is 0, and each rotation raises it by one. */
  get epoch(): number {
    return this.#epoch;
  }

  /** `random` is 32 bytes from the system's random source. */
  static fromBytes(random: Uint8Array, epoch: number): ListSecret {
    if (!Number.isInteger(epoch) || epoch < 0 || epoch > 0xffffffff)
      fail("bad_argument", "epoch out of range");
    return new ListSecret(copy(checkLength(random, 32, "a list secret")), epoch);
  }
}

/** For this package only: the secret's bytes, to seal it to a device. */
export function listSecretBytes(secret: ListSecret): Uint8Array {
  return secretBytes(secret);
}

const KINDS = { list: 1, card: 2, entry: 3 } as const;
export type SealedKind = keyof typeof KINDS;
const MAX_PLAINTEXT: Record<SealedKind, number> = {
  list: MAX_LIST_BYTES,
  card: MAX_CARD_BYTES,
  entry: MAX_ENTRY_BYTES,
};
const SEALED_VERSION = 1;
const HEADER_BYTES = 1 + 1 + 4 + 24;

function aeadKey(secret: ListSecret): Uint8Array {
  return hkdf(sha256, secretBytes(secret), undefined, utf8(TAG.listSealKey), 32);
}

function aad(header: Uint8Array, context: ListContext): Uint8Array {
  return concat(utf8(TAG.listSealed), header, context.gatewayId, context.accountId);
}

/**
 * The synthetic nonce: the first 24 bytes of HMAC-SHA256, keyed with HKDF-SHA256 of the secret
 * (info: the `list seal nonce` tag), over the tag, the version, kind and epoch, the gateway and
 * account ids, the caller's 32 random bytes and the plaintext. A repeated random value then
 * gives a repeated nonce only for an identical plaintext, which reveals that the two are equal
 * and nothing else.
 */
function syntheticNonce(
  secret: ListSecret,
  kind: SealedKind,
  context: ListContext,
  random: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
  const key = hkdf(sha256, secretBytes(secret), undefined, utf8(TAG.listSealNonce), 32);
  const message = new Writer()
    .label(TAG.listSealNonce)
    .u8(SEALED_VERSION)
    .u8(KINDS[kind])
    .u32(secret.epoch)
    .fixed(context.gatewayId, 16, "gateway id")
    .fixed(context.accountId, 16, "account id")
    .fixed(random, 32, "random")
    .finish();
  return hmac(sha256, key, concat(message, plaintext)).subarray(0, 24);
}

function seal(
  secret: ListSecret,
  kind: SealedKind,
  context: ListContext,
  plaintext: Uint8Array,
  random: Uint8Array,
): Uint8Array {
  const checked = checkContext(context);
  const ownRandom = copy(checkLength(random, 32, "the random bytes"));
  if (plaintext.length > MAX_PLAINTEXT[kind]) fail("too_large", `the ${kind} is over its bound`);
  const nonce = syntheticNonce(secret, kind, checked, ownRandom, plaintext);
  const header = new Writer()
    .u8(SEALED_VERSION)
    .u8(KINDS[kind])
    .u32(secret.epoch)
    .fixed(nonce, 24, "nonce")
    .finish();
  const ciphertext = xchacha20poly1305(aeadKey(secret), nonce, aad(header, checked)).encrypt(
    plaintext,
  );
  return concat(header, ciphertext);
}

function open(
  secret: ListSecret,
  kind: SealedKind,
  context: ListContext,
  input: Uint8Array,
): Uint8Array {
  const checked = checkContext(context);
  const sealed = copy(input);
  if (sealed.length > HEADER_BYTES + MAX_PLAINTEXT[kind] + 16)
    fail("too_large", `the sealed ${kind} is over its bound`);
  const reader = new Reader(sealed);
  if (reader.u8() !== SEALED_VERSION) fail("unsupported_version", "sealed with another version");
  if (reader.u8() !== KINDS[kind]) fail("malformed", `not a sealed ${kind}`);
  const epoch = reader.u32();
  const nonce = reader.fixed(24, "nonce");
  const header = reader.before();
  if (sealed.length - HEADER_BYTES < 16) fail("malformed", "the ciphertext is cut short");
  if (epoch !== secret.epoch) fail("decrypt_failed", "sealed under another list secret");
  try {
    return xchacha20poly1305(aeadKey(secret), nonce, aad(header, checked)).decrypt(
      sealed.subarray(HEADER_BYTES),
    );
  } catch {
    fail("decrypt_failed", "sealed bytes did not open");
  }
}

/** Seals a whole list. `random` is 32 random bytes; the nonce is derived from it (above). */
export function sealList(
  secret: ListSecret,
  context: ListContext,
  entries: readonly Uint8Array[],
  random: Uint8Array,
): Uint8Array {
  return seal(secret, "list", context, encodeList(entries.map(copy)), random);
}

/** For this package only: a sealed list's entries, before they are verified. */
export function openListEntries(
  secret: ListSecret,
  context: ListContext,
  sealed: Uint8Array,
): Uint8Array[] {
  return decodeList(open(secret, "list", context, sealed));
}

/** Opens a sealed list and verifies it from its first entry. */
export function openList(secret: ListSecret, context: ListContext, sealed: Uint8Array): ListState {
  return verifyList(context, openListEntries(secret, context, sealed));
}

/** Seals the signed card. `random` is 32 random bytes. */
export function sealCard(
  secret: ListSecret,
  context: ListContext,
  card: Uint8Array,
  random: Uint8Array,
): Uint8Array {
  return seal(secret, "card", context, copy(card), random);
}

/** Opens a sealed card and verifies it against the list's connector key and gateway. */
export function openCard(secret: ListSecret, state: ListState, sealed: Uint8Array): Card {
  const context = state.context;
  return verifyCard(open(secret, "card", context, sealed), state.connectorKey, context.gatewayId);
}

/** Seals one entry on its way to the connector. `random` is 32 random bytes. */
export function sealEntry(
  secret: ListSecret,
  context: ListContext,
  entry: Uint8Array,
  random: Uint8Array,
): Uint8Array {
  return seal(secret, "entry", context, copy(entry), random);
}

/** Opens a sealed entry and appends it to `state`: the connector's list after it, or a refusal. */
export function openEntry(
  secret: ListSecret,
  state: ListState,
  sealed: Uint8Array,
): { entry: Uint8Array; state: ListState } {
  const entry = open(secret, "entry", state.context, sealed);
  return Object.freeze({ entry, state: state.append(entry) });
}

const ROTATION_PURPOSE = 2;

function rotationInfo(context: ListContext, epoch: number, recipient: ListPublicKey): Uint8Array {
  return new Writer()
    .label(TAG.deviceSeal)
    .u8(ROTATION_PURPOSE)
    .fixed(context.gatewayId, 16, "gateway id")
    .fixed(context.accountId, 16, "account id")
    .u32(epoch)
    .fixed(recipient.bytes, 32, "recipient")
    .finish();
}

/**
 * The connector seals a new list secret to every current device member and signs the whole.
 * `held` is the secret it replaces: the new one must have a higher epoch and other bytes, so a
 * removed device's old secret never opens what is sealed after. `random` is 32 random bytes;
 * each share's HPKE ephemeral is hedged from it (see `rotationEphemeral`).
 */
export function rotateListSecret(
  connector: ListSecretKey,
  state: ListState,
  held: ListSecret,
  next: ListSecret,
  random: Uint8Array,
): Uint8Array {
  if (!connector.publicKey.equals(state.connectorKey))
    fail("not_permitted", "only the connector rotates the secret");
  if (next.epoch <= held.epoch) fail("stale_secret", "the new secret's epoch is not higher");
  if (equalBytes(secretBytes(next), secretBytes(held)))
    fail("stale_secret", "the new secret is the one held");
  const devices = state.devices();
  if (devices.length === 0) fail("bad_target", "no device is left to seal the secret to");
  const ownRandom = copy(checkLength(random, 32, "the random bytes"));
  const context = state.context;
  const writer = new Writer().label(LABEL.listSecret);
  writeContext(writer, context);
  writer.u32(next.epoch).u8(devices.length);
  for (const member of devices) {
    const info = rotationInfo(context, next.epoch, member.key);
    const ikm = rotationEphemeral(connector, ownRandom, info);
    const { enc, ciphertext } = hpkeSeal(
      member.device!.sealKey.bytes,
      info,
      new Uint8Array(0),
      secretBytes(next),
      ikm,
    );
    writer
      .fixed(member.key.bytes, 32, "recipient")
      .fixed(enc, 32, "enc")
      .fixed(ciphertext, 48, "sealed secret");
  }
  const signed = writer.finish();
  return concat(signed, signList(connector, signed));
}

/**
 * A share's HPKE ephemeral input: HKDF-SHA256 of the connector key's random bytes, salted with
 * the caller's random, with the `rotation ephemeral` tag and the share's HPKE info as info. A
 * repeated or predictable random still gives a value no one without the connector's key can
 * compute, and a different one for each share.
 */
function rotationEphemeral(connector: ListSecretKey, random: Uint8Array, info: Uint8Array) {
  return deriveFromListKey(connector, random, concat(utf8(TAG.rotationEphemeral), info), 32);
}

/**
 * A device member opens its share of a rotation. It checks the connector's signature, the
 * gateway and account, and that the epoch is newer than the secret it holds.
 */
export function openRotation(
  member: { readonly listKey: ListPublicKey; readonly sealKey: SealSecretKey },
  state: ListState,
  bytes: Uint8Array,
  held: ListSecret,
): ListSecret {
  const reader = new Reader(copy(bytes));
  reader.label(LABEL.listSecret);
  const context = readContext(reader);
  const epoch = reader.u32();
  const count = reader.u8();
  if (count < 1) fail("malformed", "a rotation has a recipient");
  if (count > MAX_MEMBERS) fail("too_large", "too many recipients");
  const shares: { key: ListPublicKey; enc: Uint8Array; ciphertext: Uint8Array }[] = [];
  for (let i = 0; i < count; i++) {
    shares.push({
      key: ListPublicKey.fromBytes(reader.fixed(32, "recipient")),
      enc: reader.fixed(32, "enc"),
      ciphertext: reader.fixed(48, "sealed secret"),
    });
  }
  const signed = reader.before();
  const signature = reader.fixed(64, "signature");
  reader.end();
  if (!verifyEd25519(state.connectorKey.bytes, signed, signature)) {
    fail("bad_signature", "the rotation is not the connector's");
  }
  expectContext(context, state.context);
  if (epoch <= held.epoch) fail("stale_secret", "not newer than the secret held");
  const share = shares.find((candidate) => candidate.key.equals(member.listKey));
  if (!share) fail("not_member", "the rotation has nothing for this device");
  const plaintext = hpkeOpen(
    sealSecretBytes(member.sealKey),
    member.sealKey.publicKey.bytes,
    share.enc,
    rotationInfo(context, epoch, member.listKey),
    new Uint8Array(0),
    share.ciphertext,
  );
  if (equalBytes(plaintext, secretBytes(held)))
    fail("stale_secret", "the new secret is the one held");
  return ListSecret.fromBytes(plaintext, epoch);
}
