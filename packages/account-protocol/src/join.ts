// The join (steps 1 to 5 of the design's section 4.4). A new device N commits to its keys; a
// member A answers with its key, the list's latest entry, the card's hash and a random value;
// N reveals; both compute three words from the transcript; A shows five sets and the person
// picks; a right pick makes A sign an entry adding N and seal the list secret and the card to N.
//
// Each step is a function that takes every message so far, checks all of them again, and
// returns the next message or throws `AccountProtocolError`. No step keeps state between calls,
// so none can be skipped or run out of order: a later step needs the earlier messages and
// refuses them unless they fit together.

import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { checkLength, concat, equalBytes, Reader, taggedHash, utf8, Writer } from "./bytes.ts";
import { cardHash, checkCardForList, verifyCard, type Card } from "./card.ts";
import { fail } from "./errors.ts";
import { hpkeOpen, hpkeSeal } from "./hpke.ts";
import {
  ListPublicKey,
  sealSecretBytes,
  signList,
  verifyEd25519,
  type ListSecretKey,
  type SealSecretKey,
} from "./keys.ts";
import { LABEL, TAG } from "./labels.ts";
import { MAX_MEMBERS } from "./limits.ts";
import { MAX_ENTRY_BYTES, readSignedEntry, signAdd, type ListState } from "./list.ts";
import {
  checkContext,
  expectContext,
  readContext,
  readRecord,
  writeContext,
  writeRecord,
  type DeviceRecord,
  type ListContext,
  type Platform,
} from "./records.ts";
import { ListSecret, listSecretBytes, MAX_CARD_BYTES } from "./seal.ts";
import { WORDLIST_TEXT } from "./wordlist.ts";

const WORDS = WORDLIST_TEXT.split("\n");

export type Words = readonly [string, string, string];

/** The new device: its two secret keys and the record it asks to be added with. */
export interface JoiningDevice {
  readonly listKey: ListSecretKey;
  readonly sealKey: SealSecretKey;
  readonly device: DeviceRecord;
}

/** The member answering: its list key, the list it holds, the gateway's signed card and the list secret. */
export interface JoinMember {
  readonly key: ListSecretKey;
  readonly state: ListState;
  readonly card: Uint8Array;
  readonly secret: ListSecret;
}

const STEP = { commit: 1, answer: 2, reveal: 3, confirm: 4 } as const;
const JOIN_PURPOSE = 1;
/** The sealed payload to N: the epoch, the secret, and the card with its length. */
const MAX_DELIVERY_BYTES = 4 + 32 + 2 + MAX_CARD_BYTES + 16;

function encodeRecord(device: DeviceRecord): Uint8Array {
  const writer = new Writer();
  writeRecord(writer, device);
  return writer.finish();
}

function start(step: number, context: ListContext): Writer {
  const writer = new Writer().label(LABEL.joinTranscript).u8(step);
  writeContext(writer, context);
  return writer;
}

function open(bytes: Uint8Array, step: number): { reader: Reader; context: ListContext } {
  const reader = new Reader(bytes);
  reader.label(LABEL.joinTranscript);
  const found = reader.u8();
  if (found !== step) fail("transcript_mismatch", "a message from another step");
  return { reader, context: readContext(reader) };
}

function commitment(context: ListContext, device: DeviceRecord, nonce: Uint8Array): Uint8Array {
  return taggedHash(TAG.commitment, context.gatewayId, context.accountId, encodeRecord(device), nonce);
}

interface Commit {
  readonly context: ListContext;
  readonly commitment: Uint8Array;
}

function readCommit(bytes: Uint8Array): Commit {
  const { reader, context } = open(bytes, STEP.commit);
  const value = reader.fixed(32, "commitment");
  reader.end();
  return { context, commitment: value };
}

interface Answer {
  readonly context: ListContext;
  readonly commitment: Uint8Array;
  readonly memberKey: ListPublicKey;
  readonly listHead: Uint8Array;
  readonly cardHash: Uint8Array;
  readonly nonce: Uint8Array;
}

function readAnswer(bytes: Uint8Array): Answer {
  const { reader, context } = open(bytes, STEP.answer);
  const answer = {
    context,
    commitment: reader.fixed(32, "commitment"),
    memberKey: ListPublicKey.fromBytes(reader.fixed(32, "member key")),
    listHead: reader.fixed(32, "list head"),
    cardHash: reader.fixed(32, "card hash"),
    nonce: reader.fixed(32, "nonce"),
  };
  reader.end();
  return answer;
}

interface Reveal {
  readonly context: ListContext;
  readonly device: DeviceRecord;
  readonly nonce: Uint8Array;
  readonly transcriptHash: Uint8Array;
  readonly signed: Uint8Array;
  readonly signature: Uint8Array;
}

function readReveal(bytes: Uint8Array): Reveal {
  const { reader, context } = open(bytes, STEP.reveal);
  const device = readRecord(reader);
  const nonce = reader.fixed(32, "nonce");
  const transcriptHash = reader.fixed(32, "transcript hash");
  const signed = reader.before();
  const signature = reader.fixed(64, "signature");
  reader.end();
  return { context, device, nonce, transcriptHash, signed, signature };
}

/** What the words cover: both sides' keys and random values, the list's latest entry and the card's hash. */
function transcriptHash(commit: Commit, answer: Answer, device: DeviceRecord, nonce: Uint8Array): Uint8Array {
  return taggedHash(
    TAG.transcriptHash,
    commit.context.gatewayId,
    commit.context.accountId,
    commit.commitment,
    answer.memberKey.bytes,
    answer.listHead,
    answer.cardHash,
    answer.nonce,
    encodeRecord(device),
    nonce,
  );
}

/** Three words from the transcript: the first 33 bits of a hash, 11 bits per word, so no word is likelier. */
export function wordsFor(transcript: Uint8Array): Words {
  const h = taggedHash(TAG.words, checkLength(transcript, 32, "a transcript hash"));
  const bits = h[0]! * 2 ** 25 + h[1]! * 2 ** 17 + h[2]! * 2 ** 9 + h[3]! * 2 + (h[4]! >> 7);
  return [WORDS[Math.floor(bits / 2 ** 22)]!, WORDS[Math.floor(bits / 2 ** 11) % 2048]!, WORDS[bits % 2048]!];
}

/**
 * The five sets A shows: the right one at a uniformly random place and four decoys of words
 * drawn uniformly from the list, none of which is in the right set or another decoy. Everything
 * random comes from `decoySeed`, which A never sends, expanded with HKDF-SHA256 and salted with
 * the transcript hash. Each word takes two bytes (an 11-bit value with no bias, since 2,048
 * divides 65,536) and is drawn again when it repeats one already used; the place takes one byte
 * below 250, taken modulo 5.
 */
function fiveSets(transcript: Uint8Array, right: Words, decoySeed: Uint8Array): { sets: Words[]; rightIndex: number } {
  const stream = hkdf(sha256, decoySeed, transcript, utf8(TAG.decoys), 1024);
  let at = 0;
  const next = (bytes: number): number => {
    // 1,024 bytes allow 511 draws for 13 values, each refused with chance at most 14/2048:
    // running out is far less likely than a hash collision.
    if (at + bytes > stream.length) fail("bad_argument", "the decoy seed ran out");
    let value = 0;
    for (let i = 0; i < bytes; i++) value = (value << 8) | stream[at++]!;
    return value;
  };
  const used = new Set(right);
  const decoys: Words[] = [];
  for (let s = 0; s < 4; s++) {
    const set: string[] = [];
    while (set.length < 3) {
      const word = WORDS[next(2) & 0x7ff]!;
      if (used.has(word)) continue;
      used.add(word);
      set.push(word);
    }
    decoys.push(set as unknown as Words);
  }
  let place = next(1);
  while (place >= 250) place = next(1);
  const rightIndex = place % 5;
  const sets = [...decoys];
  sets.splice(rightIndex, 0, right);
  return { sets, rightIndex };
}

/** Step 1, on N: the commitment to its record (all its public keys, its name and platform) and a random value. */
export function joinCommit(device: JoiningDevice, context: ListContext, nonce: Uint8Array): Uint8Array {
  const checked = checkContext(context);
  checkJoiningDevice(device);
  const value = commitment(checked, device.device, checkLength(nonce, 32, "a nonce"));
  return start(STEP.commit, checked).fixed(value, 32, "commitment").finish();
}

function checkJoiningDevice(device: JoiningDevice): void {
  if (!device.listKey.publicKey.equals(device.device.listKey)) fail("bad_argument", "the record's list key is not N's");
  if (!device.sealKey.publicKey.equals(device.device.sealKey)) fail("bad_argument", "the record's seal key is not N's");
}

function checkMember(member: JoinMember): void {
  const role = member.state.requireMember(member.key.publicKey).role;
  if (role === "connector") fail("not_permitted", "a device answers a join, not the connector");
  checkCardForList(verifyCard(member.card), member.state);
}

/**
 * Step 2, on A: its answer, before it has seen N's keys. `nonce` is 32 random bytes. The card is
 * the gateway's current signed card, which must be the list's connector's.
 */
export function joinAnswer(member: JoinMember, commit: Uint8Array, nonce: Uint8Array): Uint8Array {
  checkMember(member);
  const found = readCommit(commit);
  expectContext(found.context, member.state.context);
  return start(STEP.answer, member.state.context)
    .fixed(found.commitment, 32, "commitment")
    .fixed(member.key.publicKey.bytes, 32, "member key")
    .fixed(member.state.head, 32, "list head")
    .fixed(cardHash(member.card), 32, "card hash")
    .fixed(checkLength(nonce, 32, "a nonce"), 32, "nonce")
    .finish();
}

/** N's checks on its own commit and A's answer, shared by steps 3 and 5. */
function joiningSide(device: JoiningDevice, context: ListContext, nonce: Uint8Array, commit: Uint8Array, answer: Uint8Array) {
  checkJoiningDevice(device);
  const checked = checkContext(context);
  checkLength(nonce, 32, "a nonce");
  const ownCommit = readCommit(commit);
  expectContext(ownCommit.context, checked);
  if (!equalBytes(ownCommit.commitment, commitment(checked, device.device, nonce))) {
    fail("commitment_mismatch", "not this device's commitment");
  }
  const found = readAnswer(answer);
  expectContext(found.context, checked);
  if (!equalBytes(found.commitment, ownCommit.commitment)) fail("transcript_mismatch", "an answer to another join");
  const transcript = transcriptHash(ownCommit, found, device.device, nonce);
  const record = encodeRecord(device.device);
  const signed = start(STEP.reveal, checked)
    .fixed(record, record.length, "record")
    .fixed(nonce, 32, "nonce")
    .fixed(transcript, 32, "transcript hash")
    .finish();
  const reveal = concat(signed, signList(device.listKey, signed));
  return { context: checked, answer: found, transcript, reveal };
}

/**
 * Step 3, on N: the reveal, signed with N's list key over the transcript hash, and the words N
 * shows. `nonce` is the one N committed with.
 */
export function joinReveal(
  device: JoiningDevice,
  context: ListContext,
  nonce: Uint8Array,
  commit: Uint8Array,
  answer: Uint8Array,
): { reveal: Uint8Array; words: Words } {
  const { transcript, reveal } = joiningSide(device, context, nonce, commit, answer);
  return { reveal, words: wordsFor(transcript) };
}

/** A's checks on every message so far, shared by steps 4 and 5. */
function memberSide(member: JoinMember, commit: Uint8Array, answer: Uint8Array, reveal: Uint8Array, decoySeed: Uint8Array) {
  checkMember(member);
  checkLength(decoySeed, 32, "a decoy seed");
  const state = member.state;
  const foundCommit = readCommit(commit);
  expectContext(foundCommit.context, state.context);
  const foundAnswer = readAnswer(answer);
  expectContext(foundAnswer.context, state.context);
  if (!foundAnswer.memberKey.equals(member.key.publicKey)) fail("transcript_mismatch", "not this member's answer");
  if (!equalBytes(foundAnswer.commitment, foundCommit.commitment)) fail("transcript_mismatch", "an answer to another join");
  if (!equalBytes(foundAnswer.listHead, state.head)) fail("bad_chain", "the list has changed since the answer");
  if (!equalBytes(foundAnswer.cardHash, cardHash(member.card))) fail("card_mismatch", "the card has changed since the answer");
  const found = readReveal(reveal);
  expectContext(found.context, state.context);
  if (!equalBytes(commitment(state.context, found.device, found.nonce), foundCommit.commitment)) {
    fail("commitment_mismatch", "the reveal does not open the commitment");
  }
  const transcript = transcriptHash(foundCommit, foundAnswer, found.device, found.nonce);
  if (!equalBytes(found.transcriptHash, transcript)) fail("transcript_mismatch", "a reveal for another transcript");
  if (!verifyEd25519(found.device.listKey.bytes, found.signed, found.signature)) {
    fail("bad_signature", "the reveal's signature does not verify");
  }
  state.requireNew(found.device);
  if (state.devices().length >= MAX_MEMBERS) fail("list_full", "the list holds its most members");
  const right = wordsFor(transcript);
  return { commit: foundCommit, device: found.device, transcript, right, ...fiveSets(transcript, right, decoySeed) };
}

/**
 * Step 4, on A: the five sets to show, after "I didn't start this" and "None of these match".
 * `decoySeed` is 32 random bytes A keeps for this join and never sends; step 5 needs the same.
 */
export function joinChoices(
  member: JoinMember,
  commit: Uint8Array,
  answer: Uint8Array,
  reveal: Uint8Array,
  decoySeed: Uint8Array,
): { sets: Words[]; name: string; platform: Platform } {
  const { sets, device } = memberSide(member, commit, answer, reveal, decoySeed);
  return { sets, name: device.name, platform: device.platform };
}

/** What the person did on A: picked one of the five sets, or one of the two refusals. */
export type JoinPick = { readonly set: number } | "none-match" | "not-started";

export type RefusalReason = "wrong-set" | "none-match" | "not-started" | "concurrent";
const REASONS: readonly RefusalReason[] = ["wrong-set", "none-match", "not-started", "concurrent"];

export type JoinOutcome =
  | {
      readonly outcome: "added";
      /** The signed entry, for the connector (sealed with `sealEntry` on its way). */
      readonly entry: Uint8Array;
      /** The list after the entry, as A now holds it. */
      readonly state: ListState;
      /** For N: the entry, and the list secret and card sealed to N's seal key. */
      readonly confirm: Uint8Array;
    }
  | {
      /** For the connector, which then takes no new device for an hour. */
      readonly outcome: "refused";
      readonly refusal: Uint8Array;
    };

/**
 * Step 5, on A, after the pick. A right pick signs the entry adding N and seals the list secret
 * and the card to N; anything else signs a refusal. `sealSeed` is 32 random bytes for the
 * sealing's ephemeral key.
 */
export function joinConfirm(
  member: JoinMember,
  commit: Uint8Array,
  answer: Uint8Array,
  reveal: Uint8Array,
  decoySeed: Uint8Array,
  pick: JoinPick,
  sealSeed: Uint8Array,
): JoinOutcome {
  const side = memberSide(member, commit, answer, reveal, decoySeed);
  checkLength(sealSeed, 32, "a seal seed");
  let reason: RefusalReason | null;
  if (pick === "none-match" || pick === "not-started") reason = pick;
  else if (typeof pick === "object" && pick !== null && Number.isInteger(pick.set) && pick.set >= 0 && pick.set < 5) {
    reason = pick.set === side.rightIndex ? null : "wrong-set";
  } else fail("bad_argument", "a pick is a set from 0 to 4 or a refusal");
  if (reason !== null) return { outcome: "refused", refusal: refusal(member.key, member.state, side.commit, reason) };

  const { entry, state } = signAdd(member.key, member.state, side.device, side.transcript);
  const payload = new Writer()
    .u32(member.secret.epoch)
    .fixed(listSecretBytes(member.secret), 32, "list secret")
    .bytes(member.card, 1, MAX_CARD_BYTES, "card")
    .finish();
  const { enc, ciphertext } = hpkeSeal(
    side.device.sealKey.bytes,
    deliveryInfo(state.context, side.transcript),
    new Uint8Array(0),
    payload,
    sealSeed,
  );
  const signed = start(STEP.confirm, state.context)
    .fixed(side.transcript, 32, "transcript hash")
    .bytes(entry, 1, MAX_ENTRY_BYTES, "entry")
    .fixed(enc, 32, "enc")
    .bytes(ciphertext, 17, MAX_DELIVERY_BYTES, "sealed delivery")
    .finish();
  const confirm = concat(signed, signList(member.key, signed));
  return { outcome: "added", entry, state, confirm };
}

function deliveryInfo(context: ListContext, transcript: Uint8Array): Uint8Array {
  return new Writer()
    .label(TAG.deviceSeal)
    .u8(JOIN_PURPOSE)
    .fixed(context.gatewayId, 16, "gateway id")
    .fixed(context.accountId, 16, "account id")
    .fixed(transcript, 32, "transcript hash")
    .finish();
}

/**
 * Step 5, on N: checks A's confirmation and opens what it carries. N checks the signature
 * under the member key the words covered, that the entry adds exactly N's record after the
 * list head the words covered, and that the card is the one whose hash the words covered and is
 * signed by the connector key it names.
 */
export function joinFinish(
  device: JoiningDevice,
  context: ListContext,
  nonce: Uint8Array,
  commit: Uint8Array,
  answer: Uint8Array,
  reveal: Uint8Array,
  confirm: Uint8Array,
): { secret: ListSecret; card: Card; cardBytes: Uint8Array; entry: Uint8Array } {
  const side = joiningSide(device, context, nonce, commit, answer);
  if (!equalBytes(side.reveal, reveal)) fail("transcript_mismatch", "not this device's reveal");
  const { reader, context: found } = open(confirm, STEP.confirm);
  expectContext(found, side.context);
  const transcript = reader.fixed(32, "transcript hash");
  const entryBytes = reader.bytes(1, MAX_ENTRY_BYTES, "entry");
  const enc = reader.fixed(32, "enc");
  const ciphertext = reader.bytes(17, MAX_DELIVERY_BYTES, "sealed delivery");
  const signed = reader.before();
  const signature = reader.fixed(64, "signature");
  reader.end();
  if (!equalBytes(transcript, side.transcript)) fail("transcript_mismatch", "a confirmation of another join");
  if (!verifyEd25519(side.answer.memberKey.bytes, signed, signature)) {
    fail("bad_signature", "the confirmation is not the answering member's");
  }
  const entry = readSignedEntry(entryBytes);
  const ownRecord = encodeRecord(device.device);
  if (
    entry.type !== "add" ||
    !equalBytes(encodeRecord(entry.device), ownRecord) ||
    !equalBytes(entry.joinTranscript, side.transcript) ||
    !entry.signer.equals(side.answer.memberKey) ||
    !equalBytes(entry.prev, side.answer.listHead)
  ) {
    fail("transcript_mismatch", "the entry does not add this device after this join");
  }
  expectContext(entry.context, side.context);
  const payload = hpkeOpen(
    sealSecretBytes(device.sealKey),
    device.sealKey.publicKey.bytes,
    enc,
    deliveryInfo(side.context, side.transcript),
    new Uint8Array(0),
    ciphertext,
  );
  const inner = new Reader(payload);
  const epoch = inner.u32();
  const secretBytes = inner.fixed(32, "list secret");
  const cardBytes = inner.bytes(1, MAX_CARD_BYTES, "card");
  inner.end();
  if (!equalBytes(cardHash(cardBytes), side.answer.cardHash)) fail("card_mismatch", "not the card the words covered");
  const card = verifyCard(cardBytes);
  if (!equalBytes(card.gatewayId, side.context.gatewayId)) fail("wrong_gateway", "the card is another gateway's");
  return { secret: ListSecret.fromBytes(secretBytes, epoch), card, cardBytes, entry: entryBytes };
}

function refusal(key: ListSecretKey, state: ListState, commit: Commit, reason: RefusalReason): Uint8Array {
  const writer = new Writer().label(LABEL.refusal);
  writeContext(writer, state.context);
  const signed = writer
    .fixed(state.head, 32, "list head")
    .fixed(commit.commitment, 32, "commitment")
    .u8(REASONS.indexOf(reason) + 1)
    .fixed(key.publicKey.bytes, 32, "signer")
    .finish();
  return concat(signed, signList(key, signed));
}

/**
 * A member refuses a join without a pick: "I didn't start this" before the sets are shown, or
 * a second join while one is open. Only a current device member can refuse.
 */
export function refuseJoin(member: { readonly key: ListSecretKey; readonly state: ListState }, commit: Uint8Array, reason: RefusalReason): Uint8Array {
  if (!REASONS.includes(reason)) fail("bad_argument", "unknown refusal reason");
  const role = member.state.requireMember(member.key.publicKey).role;
  if (role === "connector") fail("not_permitted", "a device refuses a join, not the connector");
  const found = readCommit(commit);
  expectContext(found.context, member.state.context);
  return refusal(member.key, member.state, found, reason);
}

export interface Refusal {
  readonly listHead: Uint8Array;
  readonly commitment: Uint8Array;
  readonly reason: RefusalReason;
  readonly signer: ListPublicKey;
}

/**
 * The connector checks a refusal: signed by a current device member, for this gateway and
 * account. The pause that follows is the connector's to keep (`JOIN_PAUSE_MS`).
 */
export function verifyRefusal(state: ListState, bytes: Uint8Array): Refusal {
  const reader = new Reader(bytes);
  reader.label(LABEL.refusal);
  const context = readContext(reader);
  const listHead = reader.fixed(32, "list head");
  const value = reader.fixed(32, "commitment");
  const reason = REASONS[reader.u8() - 1];
  if (reason === undefined) fail("malformed", "unknown refusal reason");
  const signer = ListPublicKey.fromBytes(reader.fixed(32, "signer"));
  const signed = reader.before();
  const signature = reader.fixed(64, "signature");
  reader.end();
  if (!verifyEd25519(signer.bytes, signed, signature)) fail("bad_signature", "the refusal's signature does not verify");
  expectContext(context, state.context);
  if (state.requireMember(signer).role === "connector") fail("not_permitted", "a device refuses a join, not the connector");
  return { listHead, commitment: value, reason, signer };
}
