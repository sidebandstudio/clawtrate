// The list's head (design §4.2.2): what the connector signs on every change to the list or the
// card, so a reader can't be shown a list cut short, forked or older than one it has seen, or a
// card older than the list's. It names the list's generation, its number of entries and its
// latest entry's hash, the list secret's epoch, and the card's hash and serial.

import { checkLength, concat, copy, equalBytes, Reader, taggedHash, Writer } from "./bytes.ts";
import { cardHash, verifyCard } from "./card.ts";
import { fail } from "./errors.ts";
import { signList, verifyEd25519, type ListPublicKey, type ListSecretKey } from "./keys.ts";
import { LABEL, TAG } from "./labels.ts";
import type { ListState } from "./list.ts";
import { expectContext, readContext, writeContext, type ListContext } from "./records.ts";
import type { ListSecret } from "./seal.ts";

export interface Head {
  readonly generation: number;
  /** How many entries the list holds. */
  readonly count: number;
  /** The hash of the list's latest entry. */
  readonly entryHash: Uint8Array;
  readonly epoch: number;
  readonly cardHash: Uint8Array;
  readonly serial: number;
  /** `taggedHash(head hash, the whole head)`. */
  readonly hash: Uint8Array;
  readonly bytes: Uint8Array;
}

/**
 * The connector signs the head of `state`: its list as it now holds it, the epoch of the secret
 * it now seals with, and the card it now serves (checked against the list's connector key).
 */
export function signHead(
  connector: ListSecretKey,
  state: ListState,
  secret: ListSecret,
  card: Uint8Array,
): Uint8Array {
  if (!connector.publicKey.equals(state.connectorKey))
    fail("not_permitted", "only the connector signs the head");
  const context = state.context;
  const verified = verifyCard(card, state.connectorKey, context.gatewayId);
  const writer = new Writer().label(LABEL.listHead);
  writeContext(writer, context);
  const signed = writer
    .u32(state.generation)
    .u32(state.length)
    .fixed(state.head, 32, "latest entry hash")
    .u32(secret.epoch)
    .fixed(cardHash(copy(card)), 32, "card hash")
    .u32(verified.serial)
    .finish();
  return concat(signed, signList(connector, signed));
}

/** Reads a head and checks it is the given connector's, for this gateway and account. */
export function verifyHead(
  input: Uint8Array,
  connectorKey: ListPublicKey,
  context: ListContext,
): Head {
  const bytes = copy(input);
  const reader = new Reader(bytes);
  reader.label(LABEL.listHead);
  const found = readContext(reader);
  const generation = reader.u32();
  const count = reader.u32();
  const entryHash = reader.fixed(32, "latest entry hash");
  const epoch = reader.u32();
  const cardHashValue = reader.fixed(32, "card hash");
  const serial = reader.u32();
  const signed = reader.before();
  const signature = reader.fixed(64, "signature");
  reader.end();
  if (!verifyEd25519(connectorKey.bytes, signed, signature))
    fail("bad_signature", "the head is not the connector's");
  expectContext(found, context);
  if (count < 1) fail("malformed", "a head names at least the first entry");
  return Object.freeze({
    generation,
    count,
    entryHash,
    epoch,
    cardHash: cardHashValue,
    serial,
    hash: taggedHash(TAG.headHash, bytes),
    bytes,
  });
}

/**
 * Refuses a head older than one held: an earlier generation, or the same generation with fewer
 * entries, a lower epoch or a lower card serial (`stale_head`); the same generation and count
 * with another latest entry is a fork (`bad_chain`).
 */
export function requireNotOlder(head: Head, held: Head): void {
  if (head.generation < held.generation) fail("stale_head", "a head from an older list");
  if (head.generation === held.generation) {
    if (head.count < held.count) fail("stale_head", "a head older than the one held");
    if (head.count === held.count && !equalBytes(head.entryHash, held.entryHash))
      fail("bad_chain", "a head that forks from the one held");
  }
  if (head.epoch < held.epoch) fail("stale_head", "a head with an older secret");
  if (head.serial < held.serial) fail("stale_head", "a head with an older card");
}

/** Refuses a card other than the one a head names: an older card, or another. */
export function requireHeadCard(card: Uint8Array, head: Head): void {
  if (!equalBytes(cardHash(checkLength(card, card.length, "a card")), head.cardHash))
    fail("card_mismatch", "not the card the head names");
}
