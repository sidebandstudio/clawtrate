// The list secret: 32 bytes the package derives for the connector and every device member holds,
// so the account service can carry the list, the card and an entry on its way to the connector
// without reading them. A new secret, with the next epoch, is made after every removal and
// restore and sealed to each remaining device alone; the removed device opens nothing after.

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
import { MAX_ADDRESSES, MAX_HOST_BYTES, MAX_MEMBERS, MAX_NAME_BYTES } from "./limits.ts";
import { verifyCard, type Card } from "./card.ts";
import { Head, requireHeadCard } from "./head.ts";
import {
  entryHash,
  ListState,
  MAX_ENTRY_BYTES,
  MAX_LIST_BYTES,
  decodeList,
  encodeList,
  verifyList,
} from "./list.ts";
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

let secretBytes!: (secret: ListSecret) => Uint8Array;
let makeSecret!: (bytes: Uint8Array, epoch: number) => ListSecret;

export class ListSecret {
  readonly #bytes: Uint8Array;
  readonly #epoch: number;

  static {
    secretBytes = (secret) => secret.#bytes;
    makeSecret = (bytes, epoch) => new ListSecret(bytes, epoch);
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

  /**
   * Reads back a secret its holder stored itself (with `exportForStorage`): the connector, or a
   * device. Never a way to make a new secret: the package derives every new one.
   */
  static restoreStored(bytes: Uint8Array, epoch: number): ListSecret {
    if (!Number.isInteger(epoch) || epoch < 0 || epoch > 0xffffffff)
      fail("bad_argument", "epoch out of range");
    return new ListSecret(copy(checkLength(bytes, 32, "a list secret")), epoch);
  }

  /** The secret's bytes and epoch, for its holder to store in its own secure storage. */
  exportForStorage(): { readonly bytes: Uint8Array; readonly epoch: number } {
    return Object.freeze({ bytes: copy(this.#bytes), epoch: this.#epoch });
  }
}

/**
 * Every list secret: HKDF-SHA256 with the connector key's random bytes as input, the caller's 32
 * random bytes as salt, and as info the `list secret value` tag, the gateway and account ids, the
 * list's generation, length and latest entry hash at the point it is made, and its epoch. A
 * constant or reused random still gives a secret nobody without the connector's key can compute,
 * and another one at every point and epoch.
 */
function deriveListSecret(
  connector: ListSecretKey,
  context: ListContext,
  point: { generation: number; length: number; entryHash: Uint8Array },
  epoch: number,
  random: Uint8Array,
): ListSecret {
  const info = new Writer()
    .label(TAG.listSecretValue)
    .fixed(context.gatewayId, 16, "gateway id")
    .fixed(context.accountId, 16, "account id")
    .u32(point.generation)
    .u32(point.length)
    .fixed(point.entryHash, 32, "latest entry hash")
    .u32(epoch)
    .finish();
  const own = copy(checkLength(random, 32, "the random bytes"));
  return makeSecret(deriveFromListKey(connector, own, info, 32), epoch);
}

/** For the join only: the secret a confirmation delivered, at its epoch. */
export function receivedListSecret(bytes: Uint8Array, epoch: number): ListSecret {
  if (!Number.isInteger(epoch) || epoch < 0 || epoch > 0xffffffff)
    fail("bad_argument", "epoch out of range");
  return makeSecret(copy(checkLength(bytes, 32, "a list secret")), epoch);
}

/**
 * For a server's first join only: its first secret, made before any list exists (generation 0,
 * length 0, a zero entry hash, epoch 0).
 */
export function serverFirstSecret(
  connector: ListSecretKey,
  context: ListContext,
  random: Uint8Array,
): ListSecret {
  return deriveListSecret(
    connector,
    checkContext(context),
    { generation: 0, length: 0, entryHash: new Uint8Array(32) },
    0,
    random,
  );
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

/** Refuses to seal under a secret older than the newest head held names. */
function requireCurrent(secret: ListSecret, newest: Head): void {
  Head.check(newest);
  if (secret.epoch < newest.epoch) fail("stale_secret", "the newest head names a newer secret");
}

/**
 * Seals a whole list. `random` is 32 random bytes; the nonce is derived from it (above).
 * `newest` is the newest head the sealer holds: nothing is sealed under an older secret.
 */
export function sealList(
  secret: ListSecret,
  context: ListContext,
  entries: readonly Uint8Array[],
  random: Uint8Array,
  newest: Head,
): Uint8Array {
  requireCurrent(secret, newest);
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

/**
 * Opens a sealed list and verifies it from its first entry against the connector's head that
 * came with it, and against `held`, the newest head the reader holds (null only for a first read).
 */
export function openList(
  secret: ListSecret,
  context: ListContext,
  sealed: Uint8Array,
  head: Uint8Array,
  held: Head | null,
): { state: ListState; head: Head } {
  return verifyList(context, openListEntries(secret, context, sealed), head, held);
}

/** Seals the signed card. `random` is 32 random bytes. */
export function sealCard(
  secret: ListSecret,
  context: ListContext,
  card: Uint8Array,
  random: Uint8Array,
  newest: Head,
): Uint8Array {
  requireCurrent(secret, newest);
  return seal(secret, "card", context, copy(card), random);
}

/**
 * Opens a sealed card and verifies it against the list's connector key and gateway, and that it
 * is the card the newest head names: never an older one.
 */
export function openCard(
  secret: ListSecret,
  state: ListState,
  sealed: Uint8Array,
  head: Head,
): Card {
  const context = state.context;
  const bytes = open(secret, "card", context, sealed);
  const card = verifyCard(bytes, state.connectorKey, context.gatewayId);
  requireHeadCard(bytes, head);
  return card;
}

/** Seals one entry on its way to the connector. `random` is 32 random bytes. */
export function sealEntry(
  secret: ListSecret,
  context: ListContext,
  entry: Uint8Array,
  random: Uint8Array,
  newest: Head,
): Uint8Array {
  requireCurrent(secret, newest);
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
const FIRST_SECRET_PURPOSE = 3;

function shareInfo(
  purpose: number,
  context: ListContext,
  anchor: (writer: Writer) => Writer,
  recipient: ListPublicKey,
): Uint8Array {
  const writer = new Writer()
    .label(TAG.deviceSeal)
    .u8(purpose)
    .fixed(context.gatewayId, 16, "gateway id")
    .fixed(context.accountId, 16, "account id");
  return anchor(writer).fixed(recipient.bytes, 32, "recipient").finish();
}

function rotationInfo(context: ListContext, epoch: number, recipient: ListPublicKey): Uint8Array {
  return shareInfo(ROTATION_PURPOSE, context, (w) => w.u32(epoch), recipient);
}

/**
 * A share's HPKE ephemeral input: HKDF-SHA256 with the connector key's random bytes as input,
 * the caller's random as salt, and as info the `rotation ephemeral` tag, the share's HPKE info
 * and the SHA-256 of the secret it seals. A repeated random reuses an ephemeral only for an
 * identical plaintext. Exported for the tests only.
 */
export function shareEphemeral(
  connector: ListSecretKey,
  random: Uint8Array,
  info: Uint8Array,
  plaintext: Uint8Array,
) {
  return deriveFromListKey(
    connector,
    random,
    concat(utf8(TAG.rotationEphemeral), info, sha256(plaintext)),
    32,
  );
}

/**
 * The connector makes the next list secret and seals it to every current device member, signed
 * as a whole and naming the position it follows: exactly a removal or a restore (`bad_target`
 * from any other state). `held` is the secret it replaces; the new one has the next epoch and is
 * derived (above), so no earlier secret can be issued again. `random` is 32 random bytes. Returns
 * the rotation and the new secret.
 */
export function rotateListSecret(
  connector: ListSecretKey,
  state: ListState,
  held: ListSecret,
  random: Uint8Array,
): { rotation: Uint8Array; secret: ListSecret } {
  if (!connector.publicKey.equals(state.connectorKey))
    fail("not_permitted", "only the connector rotates the secret");
  if (!state.rotationPoint) fail("bad_target", "a rotation follows a removal or a restore");
  const devices = state.devices();
  if (devices.length === 0) fail("bad_target", "no device is left to seal the secret to");
  const ownRandom = copy(checkLength(random, 32, "the random bytes"));
  const context = state.context;
  const point = { generation: state.generation, length: state.length, entryHash: state.head };
  const next = deriveListSecret(connector, context, point, held.epoch + 1, ownRandom);
  if (equalBytes(secretBytes(next), secretBytes(held)))
    fail("stale_secret", "the new secret is the one held");
  const writer = new Writer().label(LABEL.listSecret);
  writeContext(writer, context);
  writer
    .u32(state.generation)
    .u32(state.length)
    .fixed(state.head, 32, "latest entry hash")
    .u32(next.epoch)
    .u8(devices.length);
  for (const member of devices) {
    const info = rotationInfo(context, next.epoch, member.key);
    const ikm = shareEphemeral(connector, ownRandom, info, secretBytes(next));
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
  return Object.freeze({ rotation: concat(signed, signList(connector, signed)), secret: next });
}

interface Rotation {
  readonly context: ListContext;
  readonly generation: number;
  readonly length: number;
  readonly entryHash: Uint8Array;
  readonly epoch: number;
  readonly shares: { key: ListPublicKey; enc: Uint8Array; ciphertext: Uint8Array }[];
}

function readRotation(bytes: Uint8Array, connectorKey: ListPublicKey): Rotation {
  const reader = new Reader(copy(bytes));
  reader.label(LABEL.listSecret);
  const context = readContext(reader);
  const generation = reader.u32();
  const length = reader.u32();
  const entryHash = reader.fixed(32, "latest entry hash");
  const epoch = reader.u32();
  const count = reader.u8();
  if (count < 1) fail("malformed", "a rotation has a recipient");
  if (count > MAX_MEMBERS) fail("too_large", "too many recipients");
  const shares: Rotation["shares"] = [];
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
  if (!verifyEd25519(connectorKey.bytes, signed, signature))
    fail("bad_signature", "the rotation is not the connector's");
  return { context, generation, length, entryHash, epoch, shares };
}

/** What a device holds: its list, the newest head it has seen (as verified bytes) and its secret. */
export interface HeldList {
  readonly state: ListState;
  readonly head: Head;
  readonly secret: ListSecret;
}

/** What a device reads to catch up: the newest rotation naming it, the newest list and its head. */
export interface Newest {
  readonly rotation: Uint8Array;
  readonly list: Uint8Array;
  readonly head: Uint8Array;
}

/**
 * A device takes a rotation and catches up (design §4.2.1), in this order, and returns the new
 * secret and the verified list together, or nothing: (1) the newest rotation naming it is the
 * held list's connector's, for this gateway and account, newer than the held secret, and the
 * device's own share opens; (2) the newest list opens with that secret; (3) it verifies against
 * its head, whose epoch is the rotation's, and against the held head; (4) the rotation's position
 * is on that list, is a removal or a restore, and its recipients are exactly the devices there,
 * in order; (5) the secret differs from the one held. One change behind or several, the device
 * needs nothing in between. A device already at the rotation's position takes it the same way.
 */
export function catchUp(
  member: { readonly listKey: ListPublicKey; readonly sealKey: SealSecretKey },
  held: HeldList,
  newest: Newest,
): { secret: ListSecret; state: ListState; head: Head } {
  // (1)
  const rotation = readRotation(newest.rotation, held.state.connectorKey);
  expectContext(rotation.context, held.state.context);
  const context = held.state.context;
  if (rotation.epoch <= held.secret.epoch) fail("stale_secret", "not newer than the secret held");
  const share = rotation.shares.find((candidate) => candidate.key.equals(member.listKey));
  if (!share) fail("not_member", "the rotation has nothing for this device");
  const plaintext = hpkeOpen(
    sealSecretBytes(member.sealKey),
    member.sealKey.publicKey.bytes,
    share.enc,
    rotationInfo(context, rotation.epoch, member.listKey),
    new Uint8Array(0),
    share.ciphertext,
  );
  const secret = makeSecret(copy(plaintext), rotation.epoch);
  // (2) and (3)
  const entries = openListEntries(secret, context, newest.list);
  const { state, head } = verifyList(context, entries, newest.head, held.head);
  if (head.epoch !== rotation.epoch) fail("stale_secret", "the head names another secret");
  // (4)
  if (
    rotation.generation !== state.generation ||
    rotation.length < 1 ||
    rotation.length > state.length
  )
    fail("bad_chain", "the rotation's position isn't on this list");
  const at = entries[rotation.length - 1]!;
  if (!equalBytes(entryHash(at), rotation.entryHash))
    fail("bad_chain", "the rotation's position isn't on this list");
  let there = ListState.fromGenesis(context, entries[0]!);
  for (const entry of entries.slice(1, rotation.length)) there = there.append(entry);
  if (!there.rotationPoint) fail("bad_chain", "a rotation follows a removal or a restore");
  const devices = there.devices();
  if (
    rotation.shares.length !== devices.length ||
    !rotation.shares.every((s, i) => s.key.equals(devices[i]!.key))
  )
    fail("bad_chain", "the rotation's recipients aren't the devices at its position");
  // (5)
  if (equalBytes(plaintext, secretBytes(held.secret)))
    fail("stale_secret", "the new secret is the one held");
  return Object.freeze({ secret, state, head });
}

function firstSecretInfo(context: ListContext, first: Uint8Array, recipient: ListPublicKey) {
  return shareInfo(
    FIRST_SECRET_PURPOSE,
    context,
    (w) => w.fixed(first, 32, "first entry hash"),
    recipient,
  );
}

/**
 * The first secret's own message (design §4.2.1): at linking, the connector makes the epoch-0
 * secret (derived, above, at the list's first entry) and seals it to the linking device alone,
 * signed and naming the first entry. It goes over the local channel between the two, never
 * through the service. Returns the message and the secret for the connector to keep.
 */
export function sealFirstSecret(
  connector: ListSecretKey,
  state: ListState,
  random: Uint8Array,
): { message: Uint8Array; secret: ListSecret } {
  if (!connector.publicKey.equals(state.connectorKey))
    fail("not_permitted", "only the connector seals the first secret");
  if (state.length !== 1 || state.generation !== 0)
    fail("bad_chain", "the first secret goes with the list's first entry");
  const ownRandom = copy(checkLength(random, 32, "the random bytes"));
  const context = state.context;
  const point = { generation: 0, length: 1, entryHash: state.head };
  const secret = deriveListSecret(connector, context, point, 0, ownRandom);
  const device = state.devices()[0]!;
  const info = firstSecretInfo(context, state.head, device.key);
  const ikm = shareEphemeral(connector, ownRandom, info, secretBytes(secret));
  const { enc, ciphertext } = hpkeSeal(
    device.device!.sealKey.bytes,
    info,
    new Uint8Array(0),
    secretBytes(secret),
    ikm,
  );
  const writer = new Writer().label(LABEL.firstSecret);
  writeContext(writer, context);
  const signed = writer
    .fixed(state.head, 32, "first entry hash")
    .fixed(device.key.bytes, 32, "recipient")
    .fixed(enc, 32, "enc")
    .fixed(ciphertext, 48, "sealed secret")
    .finish();
  return Object.freeze({ message: concat(signed, signList(connector, signed)), secret });
}

/** The linking device opens the first secret: the connector's, for this first entry, to it. */
export function openFirstSecret(
  member: { readonly listKey: ListPublicKey; readonly sealKey: SealSecretKey },
  state: ListState,
  bytes: Uint8Array,
): ListSecret {
  const reader = new Reader(copy(bytes));
  reader.label(LABEL.firstSecret);
  const context = readContext(reader);
  const first = reader.fixed(32, "first entry hash");
  const recipient = ListPublicKey.fromBytes(reader.fixed(32, "recipient"));
  const enc = reader.fixed(32, "enc");
  const ciphertext = reader.fixed(48, "sealed secret");
  const signed = reader.before();
  const signature = reader.fixed(64, "signature");
  reader.end();
  if (!verifyEd25519(state.connectorKey.bytes, signed, signature))
    fail("bad_signature", "the first secret is not the connector's");
  expectContext(context, state.context);
  if (state.length !== 1 || state.generation !== 0 || !equalBytes(first, state.head))
    fail("bad_chain", "the first secret for another list");
  if (!recipient.equals(member.listKey))
    fail("not_member", "the first secret is for another device");
  const plaintext = hpkeOpen(
    sealSecretBytes(member.sealKey),
    member.sealKey.publicKey.bytes,
    enc,
    firstSecretInfo(context, first, recipient),
    new Uint8Array(0),
    ciphertext,
  );
  return makeSecret(copy(plaintext), 0);
}
