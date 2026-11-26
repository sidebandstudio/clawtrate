// The join (steps 1 to 5 of the design's section 4.4). A new device N commits to its keys; a
// member A answers with its key, the list's latest entry, the card's hash and a value of its
// own; N reveals; both compute three words from the transcript; A shows five sets and the
// person picks; a right pick makes A sign an entry adding N and seal the list secret and the
// card to N.
//
// Each side is an object with one-shot state kept inside the package. `NewDeviceJoin` holds N's
// nonce, takes exactly one answer for its commitment and reveals once; `MemberJoin` derives A's
// answer from A's key and the commitment, so asking twice gets the same answer, and confirms
// once. Every random value of the join is derived or hedged inside the package from secret key
// material, so a caller's repeated or predictable random bytes can't weaken it.

import {
  checkLength,
  concat,
  copy,
  equalBytes,
  Reader,
  taggedHash,
  utf8,
  Writer,
} from "./bytes.ts";
import { cardHash, verifyCard, type Card } from "./card.ts";
import { requireHeadCard, verifyHead, type Head } from "./head.ts";
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
import { JOIN_PAUSE_MS, MAX_MEMBERS, WORD_BACK_MS } from "./limits.ts";
import {
  completeServerFirst,
  entryHash,
  ListState,
  MAX_ENTRY_BYTES,
  entryTypeOf,
  readServerFirst,
  readSignedEntry,
  signAdd,
  signServerFirst,
  verifyList,
} from "./list.ts";
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
import { ListSecret, listSecretBytes, MAX_CARD_BYTES, openListEntries } from "./seal.ts";
import { WORDLIST_TEXT } from "./wordlist.ts";

const WORDS = WORDLIST_TEXT.split("\n");

export type Words = readonly [string, string, string];

/** The new device: its two secret keys and the record it asks to be added with. */
export interface JoiningDevice {
  readonly listKey: ListSecretKey;
  readonly sealKey: SealSecretKey;
  readonly device: DeviceRecord;
}

/**
 * The member answering: its list key, the list it holds, the connector's signed head of that
 * list (its newest), the card that head names, and the secret of the head's epoch.
 */
export interface JoinMember {
  readonly key: ListSecretKey;
  readonly state: ListState;
  readonly head: Uint8Array;
  readonly card: Uint8Array;
  readonly secret: ListSecret;
}

/**
 * The time now and the end of the pause this device keeps after a refusal (0 for none), both
 * whole milliseconds by the device's clock. The package keeps no clock: the caller keeps the
 * pause between joins, and the join refuses to start while it lasts.
 */
export interface JoinClock {
  readonly nowMs: number;
  readonly pausedUntilMs: number;
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
  return taggedHash(
    TAG.commitment,
    context.gatewayId,
    context.accountId,
    encodeRecord(device),
    nonce,
  );
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
function transcriptHash(
  commit: Commit,
  answer: Answer,
  device: DeviceRecord,
  nonce: Uint8Array,
): Uint8Array {
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
  return [
    WORDS[Math.floor(bits / 2 ** 22)]!,
    WORDS[Math.floor(bits / 2 ** 11) % 2048]!,
    WORDS[bits % 2048]!,
  ];
}

/**
 * The five sets A shows: the right one at a uniformly random place and four decoys of words
 * drawn uniformly from the list, none of which is in the right set or another decoy. Everything
 * random comes from 1,024 bytes of HKDF-SHA256 of A's list key's random bytes, salted with the
 * transcript hash, with the `join decoys` tag as info: secret to A, the same for one transcript,
 * so there is nothing to store between showing and confirming. Each word takes two bytes (an
 * 11-bit value with no bias, since 2,048 divides 65,536) and is drawn again when it repeats one
 * already used; the place takes one byte below 250, taken modulo 5. Exported for the tests only;
 * `index.ts` doesn't export it.
 */
export function fiveSets(
  transcript: Uint8Array,
  right: Words,
  key: ListSecretKey,
): { sets: Words[]; rightIndex: number } {
  const stream = deriveFromListKey(key, transcript, utf8(TAG.decoys), 1024);
  let at = 0;
  const next = (bytes: number): number => {
    // 1,024 bytes allow 511 draws for 13 values, each refused with chance at most 14/2048:
    // running out is far less likely than a hash collision.
    if (at + bytes > stream.length) fail("bad_argument", "the decoy stream ran out");
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

function checkJoiningDevice(device: JoiningDevice): void {
  if (!device.listKey.publicKey.equals(device.device.listKey))
    fail("bad_argument", "the record's list key is not N's");
  if (!device.sealKey.publicKey.equals(device.device.sealKey))
    fail("bad_argument", "the record's seal key is not N's");
}

function checkTime(ms: number): number {
  if (!Number.isSafeInteger(ms) || ms < 0) fail("bad_time", "not a whole number of ms");
  return ms;
}

function checkClock(clock: JoinClock): void {
  if (checkTime(clock.nowMs) < checkTime(clock.pausedUntilMs))
    fail("paused", "joins are paused after a refusal");
}

/** A's member checks, with its head: A is at its newest head, holds that head's card and secret. */
function checkMember(member: JoinMember): Head {
  const state = member.state;
  const role = state.requireMember(member.key.publicKey).role;
  if (role === "connector") fail("not_permitted", "a device answers a join, not the connector");
  verifyCard(member.card, state.connectorKey, state.context.gatewayId);
  const head = verifyHead(member.head, state.connectorKey, state.context);
  if (
    head.generation !== state.generation ||
    head.count !== state.length ||
    !equalBytes(head.entryHash, state.head)
  )
    fail("bad_chain", "the list held is not at its head");
  requireHeadCard(member.card, head);
  if (member.secret.epoch !== head.epoch)
    fail("stale_secret", "not the secret of the head's epoch");
  return head;
}

function freezeWords(words: Words): Words {
  return Object.freeze([...words]) as unknown as Words;
}

function sameWords(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((word, i) => word === b[i]);
}

/** One word from a hash: its first 11 bits. */
function wordOf(hash: Uint8Array): string {
  return WORDS[(hash[0]! << 3) | (hash[1]! >> 5)]!;
}

/**
 * The confirmation word (design §4.4 step 5a): the first 11 bits of a tagged hash of the
 * transcript hash, A's confirmation signature and the card's hash.
 */
function confirmationWord(transcript: Uint8Array, signature: Uint8Array, card: Uint8Array): string {
  return wordOf(taggedHash(TAG.confirmationWord, transcript, signature, card));
}

/**
 * N's five words for the word back: the confirmation word at a uniformly random place and four
 * other words, none equal to it or to each other, all from 256 bytes of HKDF-SHA256 of N's list
 * key's random bytes, salted with the transcript hash, with the `join word back decoys` tag and
 * A's confirmation signature as info. Drawn as the decoy sets are.
 */
function fiveWords(
  right: string,
  key: ListSecretKey,
  transcript: Uint8Array,
  signature: Uint8Array,
): string[] {
  const stream = deriveFromListKey(
    key,
    transcript,
    concat(utf8(TAG.wordBackDecoys), signature),
    256,
  );
  let at = 0;
  const next = (bytes: number): number => {
    if (at + bytes > stream.length) fail("bad_argument", "the word stream ran out");
    let value = 0;
    for (let i = 0; i < bytes; i++) value = (value << 8) | stream[at++]!;
    return value;
  };
  const words: string[] = [];
  const used = new Set([right]);
  while (words.length < 4) {
    const word = WORDS[next(2) & 0x7ff]!;
    if (used.has(word)) continue;
    used.add(word);
    words.push(word);
  }
  let place = next(1);
  while (place >= 250) place = next(1);
  words.splice(place % 5, 0, right);
  return words;
}

/** What N holds once its join has finished: everything checked and the word back picked right. */
export interface JoinResult {
  readonly secret: ListSecret;
  readonly card: Card;
  readonly cardBytes: Uint8Array;
  readonly state: ListState;
  /** The connector's head that came with the list; null in first-device mode, where N reads it on connecting. */
  readonly head: Head | null;
  /** The confirming device's name, from the list (or, on a server, the gateway's from the card). */
  readonly confirmedOn: string;
  /** In first-device mode, the server's first entry with N's signature added, for the connector. */
  readonly firstEntry: Uint8Array | null;
}

/** N's word back prompt: its own three words, once, above five words. */
export interface WordBackPrompt {
  /** "first-device": the word to pick is on the server's terminal, not on another device. */
  readonly mode: "member" | "first-device";
  readonly under: Words;
  readonly choices: readonly string[];
}

/** What the person did on N: the word picked under N's own words, or one of the two refusals. */
export type WordBackPick =
  { readonly under: Words; readonly word: string } | "none-match" | "not-confirmed";

export type WordBackOutcome =
  | { readonly outcome: "confirmed"; readonly result: JoinResult }
  | {
      /** N discarded everything it was sent and its keys for this attempt. */
      readonly outcome: "refused";
      /** N starts no join before this (nowMs + JOIN_PAUSE_MS); the caller keeps it. */
      readonly pauseUntilMs: number;
    };

const ZERO_HEAD = new Uint8Array(32);

/**
 * The new device's side of one join. Built from N's keys, its record and 32 random bytes; it
 * holds N's nonce privately. N's nonce is HKDF-SHA256 of N's list key's random bytes, salted
 * with the caller's random, with the `join new nonce` tag, the gateway and account ids and N's
 * record as info: no one without N's key can predict it. The caller still owes fresh keys and
 * fresh random bytes for every attempt (README, "What the caller owes").
 *
 * It takes exactly one answer: the same answer again gets the same reveal (resuming after a
 * dropped connection), and any other answer ends the join for good (`join_spent`). Its finish
 * checks everything and hands back only the word back's prompt; the secret, card and list come
 * only with the right word.
 */
export class NewDeviceJoin {
  readonly #device: JoiningDevice;
  readonly #context: ListContext;
  readonly #nonce: Uint8Array;
  readonly #commit: Commit;
  readonly #commitBytes: Uint8Array;
  #phase: "committed" | "revealed" | "checked" | "ended" | "finished" = "committed";
  #answerBytes: Uint8Array | null = null;
  #answer: Answer | null = null;
  #transcript: Uint8Array | null = null;
  #reveal: Uint8Array | null = null;
  #checked: { result: JoinResult; prompt: WordBackPrompt; right: string } | null = null;

  private constructor(device: JoiningDevice, context: ListContext, random: Uint8Array) {
    this.#device = device;
    this.#context = context;
    const info = new Writer()
      .label(TAG.newNonce)
      .fixed(context.gatewayId, 16, "gateway id")
      .fixed(context.accountId, 16, "account id")
      .finish();
    this.#nonce = deriveFromListKey(
      device.listKey,
      random,
      concat(info, encodeRecord(device.device)),
      32,
    );
    this.#commit = { context, commitment: commitment(context, device.device, this.#nonce) };
    this.#commitBytes = start(STEP.commit, context)
      .fixed(this.#commit.commitment, 32, "commitment")
      .finish();
    Object.freeze(this);
  }

  /**
   * Step 1: a new join for N. `random` is 32 bytes from the system's random source. Refused while
   * N's own pause after a refused word back lasts.
   */
  static start(
    device: JoiningDevice,
    context: ListContext,
    random: Uint8Array,
    clock: JoinClock,
  ): NewDeviceJoin {
    checkClock(clock);
    checkJoiningDevice(device);
    const frozen: JoiningDevice = Object.freeze({
      listKey: device.listKey,
      sealKey: device.sealKey,
      device: Object.freeze({ ...device.device, tlsPin: copy(device.device.tlsPin) }),
    });
    return new NewDeviceJoin(
      frozen,
      checkContext(context),
      copy(checkLength(random, 32, "the random bytes")),
    );
  }

  /** The commitment message, for the service to carry to the members. */
  get commit(): Uint8Array {
    return copy(this.#commitBytes);
  }

  /**
   * Step 3: the reveal for the one answer this join takes, signed with N's list key over the
   * transcript hash, and the words N shows.
   */
  reveal(input: Uint8Array): { reveal: Uint8Array; words: Words } {
    const answer = copy(input);
    if (this.#phase === "revealed" && equalBytes(answer, this.#answerBytes!)) {
      return Object.freeze({
        reveal: copy(this.#reveal!),
        words: freezeWords(wordsFor(this.#transcript!)),
      });
    }
    if (this.#phase !== "committed") {
      if (this.#phase === "revealed") this.#phase = "ended";
      fail("join_spent", "this device has already revealed for its commitment");
    }
    const found = readAnswer(answer);
    expectContext(found.context, this.#context);
    if (!equalBytes(found.commitment, this.#commit.commitment))
      fail("transcript_mismatch", "an answer to another join");
    const transcript = transcriptHash(this.#commit, found, this.#device.device, this.#nonce);
    const record = encodeRecord(this.#device.device);
    const signed = start(STEP.reveal, this.#context)
      .fixed(record, record.length, "record")
      .fixed(this.#nonce, 32, "nonce")
      .fixed(transcript, 32, "transcript hash")
      .finish();
    const reveal = concat(signed, signList(this.#device.listKey, signed));
    this.#phase = "revealed";
    this.#answerBytes = answer;
    this.#answer = found;
    this.#transcript = transcript;
    this.#reveal = reveal;
    return Object.freeze({ reveal: copy(reveal), words: freezeWords(wordsFor(transcript)) });
  }

  /**
   * Step 5: checks the confirmation and what it carries, in the design's order, and returns only
   * the word back's prompt. (1) The confirmation answers this transcript and is signed by the
   * key the words covered; (2) its entry adds exactly N's record, carries this transcript and
   * follows the head the words covered; (3) the delivery opens and the card's hash is the one the
   * words covered; (4) the sealed list opens with the delivered secret, verifies from its first
   * entry against the connector's head that came with it (and `held`, the newest head N holds),
   * holds the covered head with N's entry (byte for byte the confirmation's) right after it, and
   * has N as a current member; (5) the confirming device is a current device member of that list;
   * (6) the card verifies against the connector key in that list's first entry, is for this
   * gateway, and is the card the head names.
   *
   * In first-device mode (the confirmation carries a server's first entry, signed by the
   * connector that answered), the list is that first entry alone, (4) and (5) become "the first
   * entry names N, this transcript and the answering connector", and no sealed list or head is
   * taken.
   */
  finish(
    confirmInput: Uint8Array,
    sealedList: Uint8Array | null,
    headBytes: Uint8Array | null,
    held?: Head,
  ): WordBackPrompt {
    if (this.#phase !== "revealed")
      fail("join_spent", "this join has no reveal to finish, or has ended");
    const confirm = copy(confirmInput);
    const answer = this.#answer!;
    const transcript = this.#transcript!;
    const context = this.#context;
    const own = encodeRecord(this.#device.device);

    // (1)
    const { reader, context: found } = open(confirm, STEP.confirm);
    expectContext(found, context);
    const confirmed = reader.fixed(32, "transcript hash");
    const entryBytes = reader.bytes(1, MAX_ENTRY_BYTES, "entry");
    const enc = reader.fixed(32, "enc");
    const ciphertext = reader.bytes(17, MAX_DELIVERY_BYTES, "sealed delivery");
    const signed = reader.before();
    const signature = reader.fixed(64, "signature");
    reader.end();
    if (!equalBytes(confirmed, transcript))
      fail("transcript_mismatch", "a confirmation of another join");
    if (!verifyEd25519(answer.memberKey.bytes, signed, signature))
      fail("bad_signature", "the confirmation is not the answering key's");

    const firstDevice = entryTypeOf(entryBytes) === "server-first";
    let firstEntry: Uint8Array | null = null;

    // (2)
    if (firstDevice) {
      const { entry } = readServerFirst(entryBytes);
      if (!equalBytes(encodeRecord(entry.device), own))
        fail("transcript_mismatch", "the first entry does not name this device");
      if (!equalBytes(entry.joinTranscript, transcript))
        fail("transcript_mismatch", "the first entry is for another join");
      if (!entry.connectorKey.equals(answer.memberKey))
        fail("transcript_mismatch", "the first entry is not the answering connector's");
      if (!equalBytes(answer.listHead, ZERO_HEAD))
        fail("bad_chain", "a first entry answers a join with no list");
      expectContext(entry.context, context);
    } else {
      const entry = readSignedEntry(entryBytes);
      if (entry.type !== "add" || !equalBytes(encodeRecord(entry.device), own))
        fail("transcript_mismatch", "the entry does not add this device");
      if (!equalBytes(entry.joinTranscript, transcript))
        fail("transcript_mismatch", "the entry is for another join");
      if (!entry.signer.equals(answer.memberKey))
        fail("transcript_mismatch", "the entry is not the answering member's");
      if (!equalBytes(entry.prev, answer.listHead))
        fail("bad_chain", "the entry does not follow the head the words covered");
      expectContext(entry.context, context);
    }

    // (3)
    const payload = hpkeOpen(
      sealSecretBytes(this.#device.sealKey),
      this.#device.sealKey.publicKey.bytes,
      enc,
      deliveryInfo(context, transcript),
      new Uint8Array(0),
      ciphertext,
    );
    const inner = new Reader(payload);
    const epoch = inner.u32();
    const secretBytes = inner.fixed(32, "list secret");
    const cardBytes = inner.bytes(1, MAX_CARD_BYTES, "card");
    inner.end();
    if (!equalBytes(cardHash(cardBytes), answer.cardHash))
      fail("card_mismatch", "not the card the words covered");
    const secret = ListSecret.fromBytes(secretBytes, epoch);

    let state: ListState;
    let head: Head | null = null;
    let confirmedOn: string;
    if (firstDevice) {
      // (4) and (5): the list will be the first entry alone, once N adds its signature.
      if (epoch !== 0) fail("stale_secret", "a server's first secret is epoch 0");
      firstEntry = completeServerFirst(this.#device.listKey, entryBytes);
      state = ListState.fromGenesis(context, firstEntry);
      // (6)
      const card = verifyCard(cardBytes, state.connectorKey, context.gatewayId);
      confirmedOn = card.name;
    } else {
      // (4)
      if (sealedList === null || headBytes === null)
        fail("bad_argument", "a member's confirmation comes with the sealed list and its head");
      const entries = openListEntries(secret, context, sealedList);
      ({ state, head } = verifyList(context, entries, headBytes, held));
      const at = entries.findIndex((candidate) =>
        equalBytes(entryHash(candidate), answer.listHead),
      );
      if (at < 0 || !equalBytes(entries[at + 1] ?? new Uint8Array(0), entryBytes))
        fail("bad_chain", "the list doesn't hold this device's entry after the covered head");
      const self = state.member(this.#device.listKey.publicKey);
      if (!self || !equalBytes(encodeRecord(self.device!), own))
        fail("not_member", "this device is not a current member of the list");
      // (5)
      const confirmer = state.member(answer.memberKey);
      if (!confirmer || confirmer.role === "connector")
        fail("not_member", "the confirming device is not a current device member");
      confirmedOn = confirmer.device!.name;
      // (6)
      verifyCard(cardBytes, state.connectorKey, context.gatewayId);
      requireHeadCard(cardBytes, head!);
      if (secret.epoch !== head!.epoch) fail("stale_secret", "not the secret of the head's epoch");
    }
    const card = verifyCard(cardBytes, state.connectorKey, context.gatewayId);

    const right = confirmationWord(transcript, signature, cardHash(cardBytes));
    const prompt: WordBackPrompt = Object.freeze({
      mode: firstDevice ? "first-device" : "member",
      under: freezeWords(wordsFor(transcript)),
      choices: Object.freeze(fiveWords(right, this.#device.listKey, transcript, signature)),
    });
    this.#checked = {
      result: Object.freeze({
        secret,
        card,
        cardBytes: copy(cardBytes),
        state,
        head,
        confirmedOn,
        firstEntry,
      }),
      prompt,
      right,
    };
    this.#phase = "checked";
    return prompt;
  }

  /**
   * Step 5a, on N: the person's pick of the word back. A pick is the word together with N's own
   * three words it was shown under. The right word hands back the join's result; anything else
   * discards everything N was sent and ends the attempt, and N then starts no join for an hour.
   * It picks once.
   */
  pickWord(pick: WordBackPick, nowMs: number): WordBackOutcome {
    checkTime(nowMs);
    if (this.#phase !== "checked")
      fail("join_spent", "this join has nothing to pick, or has ended");
    const checked = this.#checked!;
    let right = false;
    if (pick !== "none-match" && pick !== "not-confirmed") {
      if (
        typeof pick !== "object" ||
        pick === null ||
        !Array.isArray(pick.under) ||
        typeof pick.word !== "string"
      )
        fail("bad_argument", "a pick is a word under N's words, or a refusal");
      if (!sameWords(pick.under, checked.prompt.under))
        fail("bad_argument", "a word picked under other words than this device's");
      if (!checked.prompt.choices.includes(pick.word))
        fail("bad_argument", "not one of the five words shown");
      right = pick.word === checked.right;
    }
    this.#checked = null;
    if (!right) {
      this.#phase = "ended";
      return Object.freeze({ outcome: "refused", pauseUntilMs: nowMs + JOIN_PAUSE_MS });
    }
    this.#phase = "finished";
    return Object.freeze({ outcome: "confirmed", result: checked.result });
  }
}

/** What the person did on A: the three words of the set they picked, or one of the two refusals. */
export type JoinPick = Words | "none-match" | "not-started";

export type RefusalReason = "wrong-set" | "none-match" | "not-started" | "concurrent";
const REASONS: readonly RefusalReason[] = ["wrong-set", "none-match", "not-started", "concurrent"];

/** What A shows after a right pick: the confirmation word, under N's three words and N's name. */
export interface WordBack {
  readonly word: string;
  readonly under: Words;
  /** The name N says it has: shown as "says it is". */
  readonly name: string;
  /** A clears the word at this time at the latest (nowMs + WORD_BACK_MS), or when the join ends. */
  readonly showUntilMs: number;
}

export type JoinOutcome =
  | {
      readonly outcome: "added";
      /** The signed entry, for the connector (sealed with `sealEntry` on its way). Not yet on the list. */
      readonly entry: Uint8Array;
      /** For N: the entry, and the list secret and card sealed to N's seal key. */
      readonly confirm: Uint8Array;
      readonly wordBack: WordBack;
    }
  | {
      /** For the connector, which then takes no new device for an hour. */
      readonly outcome: "refused";
      readonly refusal: Uint8Array;
      /** A answers no join before this (nowMs + JOIN_PAUSE_MS); the caller keeps it. */
      readonly pauseUntilMs: number;
    };

interface Shown {
  readonly device: DeviceRecord;
  readonly transcript: Uint8Array;
  readonly right: Words;
  readonly sets: Words[];
}

/** The answerer's half of the join shared by a member and a server's connector. */
class Answering {
  readonly key: ListSecretKey;
  readonly context: ListContext;
  readonly commit: Commit;
  readonly answer: Answer;
  readonly answerBytes: Uint8Array;
  reveal: Uint8Array | null = null;
  shown: Shown | null = null;
  done = false;

  constructor(
    key: ListSecretKey,
    context: ListContext,
    commit: Commit,
    listHead: Uint8Array,
    card: Uint8Array,
  ) {
    this.key = key;
    this.context = context;
    this.commit = commit;
    const info = new Writer()
      .label(TAG.answerNonce)
      .fixed(context.gatewayId, 16, "gateway id")
      .fixed(context.accountId, 16, "account id")
      .fixed(commit.commitment, 32, "commitment")
      .finish();
    const nonce = deriveFromListKey(key, undefined, info, 32);
    this.answer = {
      context,
      commitment: commit.commitment,
      memberKey: key.publicKey,
      listHead,
      cardHash: cardHash(card),
      nonce,
    };
    this.answerBytes = start(STEP.answer, context)
      .fixed(commit.commitment, 32, "commitment")
      .fixed(key.publicKey.bytes, 32, "member key")
      .fixed(listHead, 32, "list head")
      .fixed(this.answer.cardHash, 32, "card hash")
      .fixed(nonce, 32, "nonce")
      .finish();
  }

  /** Checks a reveal; `requireNew` checks N's keys against the list (or the connector's key). */
  choices(input: Uint8Array, requireNew: (device: DeviceRecord) => void) {
    const reveal = copy(input);
    if (this.done) fail("join_spent", "this join has ended");
    if (this.reveal !== null && !equalBytes(reveal, this.reveal))
      fail("join_spent", "this join already took a reveal");
    const found = readReveal(reveal);
    expectContext(found.context, this.context);
    if (!equalBytes(commitment(this.context, found.device, found.nonce), this.commit.commitment))
      fail("commitment_mismatch", "the reveal does not open the commitment");
    const transcript = transcriptHash(this.commit, this.answer, found.device, found.nonce);
    if (!equalBytes(found.transcriptHash, transcript))
      fail("transcript_mismatch", "a reveal for another transcript");
    if (!verifyEd25519(found.device.listKey.bytes, found.signed, found.signature))
      fail("bad_signature", "the reveal's signature does not verify");
    requireNew(found.device);
    const right = wordsFor(transcript);
    const { sets } = fiveSets(transcript, right, this.key);
    this.reveal = reveal;
    this.shown = { device: found.device, transcript, right, sets };
    return Object.freeze({
      sets: Object.freeze(sets.map(freezeWords)) as unknown as Words[],
      name: found.device.name,
      platform: found.device.platform,
    });
  }

  /** Judges a pick: null for the right set, or the refusal's reason. */
  judge(pick: JoinPick): RefusalReason | null {
    if (this.done) fail("join_spent", "this join has already been confirmed or refused");
    const shown = this.shown;
    if (shown === null) fail("bad_argument", "the sets have not been shown");
    if (pick === "none-match" || pick === "not-started") return pick;
    if (Array.isArray(pick) && shown.sets.some((set) => sameWords(set, pick)))
      return sameWords(pick, shown.right) ? null : "wrong-set";
    fail("bad_argument", "a pick is one of the five sets shown, or a refusal");
  }

  /** The confirmation for a right pick, with `entry` (an add, or a server's partial first entry). */
  confirmation(
    entry: Uint8Array,
    secret: ListSecret,
    card: Uint8Array,
    random: Uint8Array,
    nowMs: number,
  ) {
    const shown = this.shown!;
    const payload = new Writer()
      .u32(secret.epoch)
      .fixed(listSecretBytes(secret), 32, "list secret")
      .bytes(card, 1, MAX_CARD_BYTES, "card")
      .finish();
    const info = deliveryInfo(this.context, shown.transcript);
    const ikm = deriveFromListKey(this.key, random, concat(utf8(TAG.joinEphemeral), info), 32);
    const { enc, ciphertext } = hpkeSeal(
      shown.device.sealKey.bytes,
      info,
      new Uint8Array(0),
      payload,
      ikm,
    );
    const signed = start(STEP.confirm, this.context)
      .fixed(shown.transcript, 32, "transcript hash")
      .bytes(entry, 1, MAX_ENTRY_BYTES, "entry")
      .fixed(enc, 32, "enc")
      .bytes(ciphertext, 17, MAX_DELIVERY_BYTES, "sealed delivery")
      .finish();
    const signature = signList(this.key, signed);
    const wordBack: WordBack = Object.freeze({
      word: confirmationWord(shown.transcript, signature, cardHash(card)),
      under: freezeWords(shown.right),
      name: shown.device.name,
      showUntilMs: nowMs + WORD_BACK_MS,
    });
    return { confirm: concat(signed, signature), wordBack };
  }
}

/**
 * The member's side of one join. Its answer nonce is HKDF-SHA256 of A's list key's random
 * bytes, with the `join answer nonce` tag, the gateway and account ids and the commitment as
 * info: no one without A's key can predict it, and the same commitment always gets the same
 * answer, byte for byte. It takes one reveal and confirms once.
 */
export class MemberJoin {
  readonly #member: JoinMember;
  readonly #side: Answering;

  private constructor(member: JoinMember, side: Answering) {
    this.#member = member;
    this.#side = side;
    Object.freeze(this);
  }

  /**
   * Step 2: A's answer to a commitment, before it has seen N's keys. A must be a current device
   * member at its newest head, holding that head's card and secret. Refused while A's own pause
   * after a refusal lasts.
   */
  static answer(member: JoinMember, commitInput: Uint8Array, clock: JoinClock): MemberJoin {
    checkClock(clock);
    const own: JoinMember = Object.freeze({
      key: member.key,
      state: member.state,
      head: copy(member.head),
      card: copy(member.card),
      secret: member.secret,
    });
    checkMember(own);
    const commit = readCommit(copy(commitInput));
    expectContext(commit.context, own.state.context);
    const side = new Answering(own.key, own.state.context, commit, own.state.head, own.card);
    return new MemberJoin(own, side);
  }

  /** The answer message: the same bytes for the same commitment, however often it is built. */
  get answer(): Uint8Array {
    return copy(this.#side.answerBytes);
  }

  /**
   * Step 4: checks N's reveal and returns the five sets to show, after "I didn't start this"
   * and "None of these match". It takes one reveal; the same reveal again gets the same sets.
   */
  choices(reveal: Uint8Array): { sets: Words[]; name: string; platform: Platform } {
    const state = this.#member.state;
    return this.#side.choices(reveal, (device) => {
      state.requireNew(device);
      if (state.devices().length >= MAX_MEMBERS)
        fail("list_full", "the list holds its most members");
    });
  }

  /**
   * Step 5, after the pick: the words of the set the person picked, compared with the
   * transcript's own words, or one of the two refusals. A right pick signs the entry adding N,
   * seals the list secret and the card to N, and returns the word back to show. Anything else
   * signs a refusal. `random` is 32 random bytes; the sealing's ephemeral is hedged from it. It
   * confirms once.
   */
  confirm(pick: JoinPick, random: Uint8Array, nowMs: number): JoinOutcome {
    checkTime(nowMs);
    const side = this.#side;
    const reason = side.judge(pick);
    const ownRandom = copy(checkLength(random, 32, "the random bytes"));
    const member = this.#member;
    side.done = true;
    if (reason !== null)
      return Object.freeze({
        outcome: "refused",
        refusal: refusal(member.key, member.state, side.commit, reason),
        pauseUntilMs: nowMs + JOIN_PAUSE_MS,
      });
    const entry = signAdd(member.key, member.state, side.shown!.device, side.shown!.transcript);
    const { confirm, wordBack } = side.confirmation(
      entry,
      member.secret,
      member.card,
      ownRandom,
      nowMs,
    );
    return Object.freeze({ outcome: "added", entry, confirm, wordBack });
  }
}

/** What the server's connector holds at install: its key, the gateway, its card, the first secret. */
export interface ServerInstall {
  readonly connector: ListSecretKey;
  readonly context: ListContext;
  readonly card: Uint8Array;
  /** The first list secret, epoch 0. */
  readonly secret: ListSecret;
}

export type ServerFirstOutcome =
  | {
      readonly outcome: "added";
      /** For N: the first entry with the connector's signature, the first secret and the card. */
      readonly confirm: Uint8Array;
      /** What the server's terminal shows. */
      readonly wordBack: WordBack;
    }
  | { readonly outcome: "refused" };

/**
 * The first join of a gateway on a server with no app (design §8.4): the connector answers one
 * join itself, its terminal shows the sets, and a right pick makes the list's first entry with
 * that device as its first device member. It takes no list, so it can't be used on a list that
 * exists; the caller opens one only from the install's own one-time state, and never again.
 * It answers one commitment: the same commitment again gets the same answer, and any other
 * commitment ends it for good (`join_spent`). The first entry is complete once N adds its own
 * signature on the right word back; N returns it to the connector, which starts its list from it
 * with `ListState.fromGenesis`.
 */
export class ServerFirstDeviceJoin {
  readonly #install: ServerInstall;
  #side: Answering | null = null;
  #ended = false;

  private constructor(install: ServerInstall) {
    this.#install = install;
    Object.freeze(this);
  }

  static open(install: ServerInstall): ServerFirstDeviceJoin {
    const context = checkContext(install.context);
    const card = copy(install.card);
    verifyCard(card, install.connector.publicKey, context.gatewayId);
    if (install.secret.epoch !== 0) fail("stale_secret", "a server's first secret is epoch 0");
    return new ServerFirstDeviceJoin(
      Object.freeze({ connector: install.connector, context, card, secret: install.secret }),
    );
  }

  /** Step 2, by the connector: its answer to the one commitment this join takes. */
  answer(commitInput: Uint8Array): Uint8Array {
    if (this.#ended) fail("join_spent", "this first join has ended");
    const commit = readCommit(copy(commitInput));
    expectContext(commit.context, this.#install.context);
    if (this.#side !== null) {
      if (equalBytes(commit.commitment, this.#side.commit.commitment))
        return copy(this.#side.answerBytes);
      this.#ended = true;
      fail("join_spent", "two devices asked to join; run the command again");
    }
    const install = this.#install;
    this.#side = new Answering(install.connector, install.context, commit, ZERO_HEAD, install.card);
    return copy(this.#side.answerBytes);
  }

  /** Step 4, by the connector: checks N's reveal and returns the five sets for the terminal. */
  choices(reveal: Uint8Array): { sets: Words[]; name: string; platform: Platform } {
    if (this.#ended || this.#side === null)
      fail("join_spent", "this first join has no answer, or has ended");
    const connectorKey = `${this.#install.connector.publicKey.bytes.join(",")}`;
    return this.#side.choices(reveal, (device) => {
      const keys = [device.listKey.bytes, device.sealKey.bytes, device.gatewayDeviceKey.bytes].map(
        (k) => k.join(","),
      );
      if (new Set(keys).size !== keys.length || keys.includes(connectorKey))
        fail("duplicate_key", "one key in two roles");
    });
  }

  /**
   * Step 5, by the connector, after the number typed at the terminal: a right pick makes the
   * first entry and seals the first secret and the card to N; anything else ends this first join.
   */
  confirm(pick: JoinPick, random: Uint8Array, nowMs: number): ServerFirstOutcome {
    checkTime(nowMs);
    if (this.#ended || this.#side === null)
      fail("join_spent", "this first join has no answer, or has ended");
    const side = this.#side;
    const reason = side.judge(pick);
    const ownRandom = copy(checkLength(random, 32, "the random bytes"));
    side.done = true;
    this.#ended = true;
    if (reason !== null) return Object.freeze({ outcome: "refused" });
    const install = this.#install;
    const entry = signServerFirst(
      install.connector,
      install.context,
      side.shown!.device,
      side.shown!.transcript,
    );
    const { confirm, wordBack } = side.confirmation(
      entry,
      install.secret,
      install.card,
      ownRandom,
      nowMs,
    );
    return Object.freeze({ outcome: "added", confirm, wordBack });
  }
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

function refusal(
  key: ListSecretKey,
  state: ListState,
  commit: Commit,
  reason: RefusalReason,
): Uint8Array {
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
 * two joins at once (which ends both and pauses nothing). Only a current device member can refuse.
 */
export function refuseJoin(
  member: { readonly key: ListSecretKey; readonly state: ListState },
  commit: Uint8Array,
  reason: RefusalReason,
): Uint8Array {
  if (!REASONS.includes(reason)) fail("bad_argument", "unknown refusal reason");
  const role = member.state.requireMember(member.key.publicKey).role;
  if (role === "connector") fail("not_permitted", "a device refuses a join, not the connector");
  const found = readCommit(copy(commit));
  expectContext(found.context, member.state.context);
  return refusal(member.key, member.state, found, reason);
}

export interface Refusal {
  readonly listHead: Uint8Array;
  readonly commitment: Uint8Array;
  readonly reason: RefusalReason;
  readonly signer: ListPublicKey;
  /** `taggedHash(refusal hash, the whole refusal)`: the connector takes each refusal once by it. */
  readonly hash: Uint8Array;
  /** Whether the connector pauses joins for it: every reason but two joins at once. */
  readonly pauses: boolean;
}

/**
 * The connector checks a refusal: signed by a current device member, for this gateway and
 * account, naming a head the connector signed within the last hour. `signedWithinHour` is the
 * latest-entry hashes of the heads it signed in that hour (the connector keeps them with their
 * times; the package keeps no clock). It returns the refusal's hash, by which the connector
 * takes each refusal once, and whether it pauses joins (`JOIN_PAUSE_MS`).
 */
export function verifyRefusal(
  state: ListState,
  input: Uint8Array,
  signedWithinHour: readonly Uint8Array[],
): Refusal {
  const bytes = copy(input);
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
  if (!verifyEd25519(signer.bytes, signed, signature))
    fail("bad_signature", "the refusal's signature does not verify");
  expectContext(context, state.context);
  if (state.requireMember(signer).role === "connector")
    fail("not_permitted", "a device refuses a join, not the connector");
  if (!signedWithinHour.some((head) => equalBytes(head, listHead)))
    fail("stale_head", "a refusal naming a head not signed within the hour");
  return Object.freeze({
    listHead,
    commitment: value,
    reason,
    signer,
    hash: taggedHash(TAG.refusalHash, bytes),
    pauses: reason !== "concurrent",
  });
}
