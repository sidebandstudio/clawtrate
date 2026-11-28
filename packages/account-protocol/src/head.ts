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

let makeHead!: (fields: HeadFields) => Head;

interface HeadFields {
  readonly generation: number;
  readonly count: number;
  readonly entryHash: Uint8Array;
  readonly epoch: number;
  readonly cardHash: Uint8Array;
  readonly serial: number;
  readonly bytes: Uint8Array;
}

/**
 * A head the package has verified. Only `verifyHead` makes one: a reader persists `head.bytes`
 * and verifies them again when it reads them back, so no head a signature didn't check reaches
 * the package. Frozen; its byte arrays are copies the caller owns.
 */
export class Head {
  readonly #fields: HeadFields;

  static {
    makeHead = (fields) => new Head(fields);
  }

  private constructor(fields: HeadFields) {
    this.#fields = fields;
    Object.freeze(this);
  }

  /** Refuses anything not made by `verifyHead`. */
  static check(head: Head): Head {
    if (!(typeof head === "object" && head !== null && #fields in head))
      fail("bad_argument", "a head is read only by verifyHead");
    return head;
  }

  get generation(): number {
    return this.#fields.generation;
  }
  /** How many entries the list holds. */
  get count(): number {
    return this.#fields.count;
  }
  /** The hash of the list's latest entry. */
  get entryHash(): Uint8Array {
    return copy(this.#fields.entryHash);
  }
  get epoch(): number {
    return this.#fields.epoch;
  }
  get cardHash(): Uint8Array {
    return copy(this.#fields.cardHash);
  }
  get serial(): number {
    return this.#fields.serial;
  }
  /** `taggedHash(head hash, the whole head)`. */
  get hash(): Uint8Array {
    return taggedHash(TAG.headHash, this.#fields.bytes);
  }
  /** The signed bytes: what a reader persists. */
  get bytes(): Uint8Array {
    return copy(this.#fields.bytes);
  }
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
  return makeHead({ generation, count, entryHash, epoch, cardHash: cardHashValue, serial, bytes });
}

/**
 * Refuses a head older than one held: an earlier generation, or the same generation with fewer
 * entries, a lower epoch or a lower card serial (`stale_head`); the same generation and count
 * with another latest entry is a fork (`bad_chain`).
 */
export function requireNotOlder(head: Head, held: Head): void {
  Head.check(head);
  Head.check(held);
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
  Head.check(head);
  if (!equalBytes(cardHash(checkLength(card, card.length, "a card")), head.cardHash))
    fail("card_mismatch", "not the card the head names");
}
