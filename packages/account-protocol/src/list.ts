// The device list: a chain of signed entries, each naming the hash of the one before it. A list
// starts with one of three first entries, each signed by the connector and by the device that
// confirms others on the gateway's machine: the linking app's first entry, a server's first
// device after its terminal confirmed it, or a fresh start carrying an older list's head and
// members. Every later entry is signed by one current member. `ListState` is what a verifier
// knows after each entry: who is a member, who was removed and how, and every key the list has
// held. A reader checks a list against the connector's signed head (head.ts).

import { checkLength, concat, copy, equalBytes, hex, Reader, taggedHash, Writer } from "./bytes.ts";
import { fail } from "./errors.ts";
import { verifyHead, requireNotOlder, type Head } from "./head.ts";
import { ListPublicKey, signList, verifyEd25519, type ListSecretKey } from "./keys.ts";
import { LABEL, TAG } from "./labels.ts";
import { GROWTH_LIMIT, MAX_ENTRIES, MAX_MEMBERS, MAX_NAME_BYTES } from "./limits.ts";
import {
  checkContext,
  expectContext,
  readContext,
  readRecord,
  writeContext,
  writeRecord,
  type DeviceRecord,
  type ListContext,
} from "./records.ts";

/** A device record's largest encoding: four 32-byte fields, the platform and the longest name. */
const MAX_RECORD_BYTES = 4 * 32 + 1 + 2 + MAX_NAME_BYTES;
const HEAD_BYTES = LABEL.listEntry.length + 32 + 4 + 32 + 1;
/** The largest entry other than a fresh start: a server's first entry with the longest name. */
export const MAX_ENTRY_BYTES = HEAD_BYTES + 32 + MAX_RECORD_BYTES + 32 + 128;
/** The largest fresh start: every device carried over, each with the longest name. */
export const MAX_FRESH_START_BYTES =
  HEAD_BYTES +
  4 +
  32 +
  4 +
  32 +
  MAX_RECORD_BYTES +
  1 +
  (MAX_MEMBERS - 1) * (MAX_RECORD_BYTES + 32) +
  128;

export type RemovalOrigin = "member" | "account" | "withdrawn";

interface EntryHead {
  readonly context: ListContext;
  readonly seq: number;
  readonly prev: Uint8Array;
}

/** A device a fresh start carries over, with the member whose entry made it one, if any. */
export interface CarriedDevice {
  readonly device: DeviceRecord;
  readonly addedBy: ListPublicKey | null;
}

export type Entry = EntryHead &
  (
    | {
        /** The linking app's first entry. */
        readonly type: "genesis";
        readonly connectorKey: ListPublicKey;
        readonly device: DeviceRecord;
      }
    | {
        readonly type: "add";
        readonly device: DeviceRecord;
        /** The hash of the join transcript whose right pick this entry follows. */
        readonly joinTranscript: Uint8Array;
        readonly signer: ListPublicKey;
      }
    | {
        readonly type: "remove";
        readonly origin: RemovalOrigin;
        readonly target: ListPublicKey;
        readonly signer: ListPublicKey;
      }
    | {
        readonly type: "restore";
        readonly target: ListPublicKey;
        readonly signer: ListPublicKey;
      }
    | {
        /** A server's first entry: its first device, after the server's terminal confirmed it. */
        readonly type: "server-first";
        readonly connectorKey: ListPublicKey;
        readonly device: DeviceRecord;
        readonly joinTranscript: Uint8Array;
      }
    | {
        /** A list started afresh: the old list's head and its members, carried over. */
        readonly type: "fresh-start";
        readonly generation: number;
        readonly connectorKey: ListPublicKey;
        readonly oldCount: number;
        readonly oldHead: Uint8Array;
        /** The gateway machine's own device (on a server, the first device), which signs. */
        readonly device: DeviceRecord;
        readonly carried: readonly CarriedDevice[];
      }
  );

type FirstEntry = Extract<Entry, { type: "genesis" | "server-first" | "fresh-start" }>;

const TYPES = ["genesis", "add", "remove", "restore", "server-first", "fresh-start"] as const;
const ORIGINS = ["member", "account", "withdrawn"] as const;
const ZERO_HASH = new Uint8Array(32);
const NO_KEY = new Uint8Array(32);

function isFirst(entry: Entry): entry is FirstEntry {
  return entry.type === "genesis" || entry.type === "server-first" || entry.type === "fresh-start";
}

/** The bytes every signature on the entry covers: the whole entry up to its first signature. */
function encodeSigned(entry: Entry): Uint8Array {
  const writer = new Writer().label(LABEL.listEntry);
  writeContext(writer, entry.context);
  writer
    .u32(entry.seq)
    .fixed(entry.prev, 32, "previous hash")
    .u8(TYPES.indexOf(entry.type) + 1);
  switch (entry.type) {
    case "genesis":
      writer.fixed(entry.connectorKey.bytes, 32, "connector key");
      writeRecord(writer, entry.device);
      break;
    case "add":
      writeRecord(writer, entry.device);
      writer
        .fixed(entry.joinTranscript, 32, "join transcript")
        .fixed(entry.signer.bytes, 32, "signer");
      break;
    case "remove":
      writer.u8(ORIGINS.indexOf(entry.origin) + 1).fixed(entry.target.bytes, 32, "target");
      writer.fixed(entry.signer.bytes, 32, "signer");
      break;
    case "restore":
      writer.fixed(entry.target.bytes, 32, "target").fixed(entry.signer.bytes, 32, "signer");
      break;
    case "server-first":
      writer.fixed(entry.connectorKey.bytes, 32, "connector key");
      writeRecord(writer, entry.device);
      writer.fixed(entry.joinTranscript, 32, "join transcript");
      break;
    case "fresh-start":
      writer
        .u32(entry.generation)
        .fixed(entry.connectorKey.bytes, 32, "connector key")
        .u32(entry.oldCount)
        .fixed(entry.oldHead, 32, "old head");
      writeRecord(writer, entry.device);
      if (entry.carried.length > MAX_MEMBERS - 1) fail("too_large", "too many devices carried");
      writer.u8(entry.carried.length);
      for (const carried of entry.carried) {
        writeRecord(writer, carried.device);
        writer.fixed(carried.addedBy?.bytes ?? NO_KEY, 32, "added by");
      }
      break;
  }
  return writer.finish();
}

interface DecodedEntry {
  readonly entry: Entry;
  readonly signed: Uint8Array;
  readonly signatures: Uint8Array[];
}

function readOptionalKey(reader: Reader, what: string): ListPublicKey | null {
  const bytes = reader.fixed(32, what);
  return equalBytes(bytes, NO_KEY) ? null : ListPublicKey.fromBytes(bytes);
}

/** Decodes an entry. `partial` reads a first entry that carries only the connector's signature. */
function decodeEntry(bytes: Uint8Array, partial = false): DecodedEntry {
  if (bytes.length > MAX_FRESH_START_BYTES) fail("too_large", "an entry is over its bound");
  const reader = new Reader(bytes);
  reader.label(LABEL.listEntry);
  const context = readContext(reader);
  const seq = reader.u32();
  const prev = reader.fixed(32, "previous hash");
  const type = TYPES[reader.u8() - 1];
  const head = { context, seq, prev };
  let entry: Entry;
  switch (type) {
    case "genesis":
      entry = {
        ...head,
        type,
        connectorKey: ListPublicKey.fromBytes(reader.fixed(32, "connector key")),
        device: readRecord(reader),
      };
      break;
    case "add":
      entry = {
        ...head,
        type,
        device: readRecord(reader),
        joinTranscript: reader.fixed(32, "join transcript"),
        signer: ListPublicKey.fromBytes(reader.fixed(32, "signer")),
      };
      break;
    case "remove": {
      const origin = ORIGINS[reader.u8() - 1];
      if (origin === undefined) fail("malformed", "unknown removal origin");
      entry = {
        ...head,
        type,
        origin,
        target: ListPublicKey.fromBytes(reader.fixed(32, "target")),
        signer: ListPublicKey.fromBytes(reader.fixed(32, "signer")),
      };
      break;
    }
    case "restore":
      entry = {
        ...head,
        type,
        target: ListPublicKey.fromBytes(reader.fixed(32, "target")),
        signer: ListPublicKey.fromBytes(reader.fixed(32, "signer")),
      };
      break;
    case "server-first":
      entry = {
        ...head,
        type,
        connectorKey: ListPublicKey.fromBytes(reader.fixed(32, "connector key")),
        device: readRecord(reader),
        joinTranscript: reader.fixed(32, "join transcript"),
      };
      break;
    case "fresh-start": {
      const generation = reader.u32();
      const connectorKey = ListPublicKey.fromBytes(reader.fixed(32, "connector key"));
      const oldCount = reader.u32();
      const oldHead = reader.fixed(32, "old head");
      const device = readRecord(reader);
      const count = reader.u8();
      if (count > MAX_MEMBERS - 1) fail("too_large", "too many devices carried");
      const carried: CarriedDevice[] = [];
      for (let i = 0; i < count; i++) {
        carried.push({ device: readRecord(reader), addedBy: readOptionalKey(reader, "added by") });
      }
      entry = { ...head, type, generation, connectorKey, oldCount, oldHead, device, carried };
      break;
    }
    default:
      fail("malformed", "unknown entry type");
  }
  if (entry.type !== "fresh-start" && bytes.length > MAX_ENTRY_BYTES)
    fail("too_large", "an entry is over its bound");
  const signed = reader.before();
  const signatures = [reader.fixed(64, "signature")];
  if (isFirst(entry) && !partial) signatures.push(reader.fixed(64, "signature"));
  reader.end();
  return { entry, signed, signatures };
}

/** Reads an entry without checking it against a list or checking its signatures. */
export function readEntryUnverified(bytes: Uint8Array): Entry {
  return freezeEntry(decodeEntry(copy(bytes)).entry);
}

function freezeEntry(entry: Entry): Entry {
  if ("device" in entry) Object.freeze(entry.device);
  if (entry.type === "fresh-start") Object.freeze(entry.carried.map((c) => Object.freeze(c)));
  Object.freeze(entry.context);
  return Object.freeze(entry);
}

/** The hash the next entry names as `prev`, over the whole entry with its signatures. */
export function entryHash(bytes: Uint8Array): Uint8Array {
  return taggedHash(TAG.entryHash, bytes);
}

export type Role = "connector" | "gateway-device" | "device";

export interface Member {
  readonly key: ListPublicKey;
  readonly role: Role;
  /** Null for the connector. */
  readonly device: DeviceRecord | null;
  /** The member whose entry added it; null for a first entry's own two. */
  readonly addedBy: ListPublicKey | null;
  /** The member whose entry last put it back, if it was put back. */
  readonly restoredBy: ListPublicKey | null;
  /** The position of the entry that added (or last put back) the member. */
  readonly since: number;
}

export interface Removal {
  readonly member: Member;
  readonly origin: RemovalOrigin;
  readonly at: number;
}

interface StateData {
  readonly context: ListContext;
  readonly connectorKey: ListPublicKey;
  /** 0 for a list that started with a linking or server first entry; raised by each fresh start. */
  readonly generation: number;
  readonly length: number;
  readonly head: Uint8Array;
  readonly members: ReadonlyMap<string, Member>;
  readonly removed: ReadonlyMap<string, Removal>;
  /**
   * Every key the list holds or held, of any kind and in any role (the connector's included),
   * and every TLS pin, except those of a withdrawn entry. No key may appear twice, so one key
   * can never act in two roles.
   */
  readonly seen: ReadonlySet<string>;
  /** The members that have signed an entry other than a first entry. */
  readonly signers: ReadonlySet<string>;
}

/** A record's keys and pin as `seen` holds them. Every key shares one namespace. */
function seenKeys(device: DeviceRecord): string[] {
  return [
    `key:${hex(device.listKey.bytes)}`,
    `key:${hex(device.sealKey.bytes)}`,
    `key:${hex(device.gatewayDeviceKey.bytes)}`,
    `tls:${hex(device.tlsPin)}`,
  ];
}

/** Refuses keys that appear twice: a record's list key as its OpenClaw key, say. */
function requireDistinct(keys: readonly string[]): void {
  if (new Set(keys).size !== keys.length) fail("duplicate_key", "one key in two roles");
}

/** A member as a caller gets it: its own frozen copy, so changing it can't change the state. */
function detach(member: Member): Member {
  const device =
    member.device && Object.freeze({ ...member.device, tlsPin: copy(member.device.tlsPin) });
  return Object.freeze({ ...member, device });
}

function newMember(
  device: DeviceRecord,
  role: Role,
  addedBy: ListPublicKey | null,
  since: number,
): Member {
  return { key: device.listKey, role, device, addedBy, restoredBy: null, since };
}

/** What a list says after a given entry. Immutable and frozen: `append` returns a new state. */
export class ListState {
  readonly #data: StateData;

  private constructor(data: StateData) {
    this.#data = data;
    Object.freeze(this);
  }

  get context(): ListContext {
    return Object.freeze({
      gatewayId: copy(this.#data.context.gatewayId),
      accountId: copy(this.#data.context.accountId),
    });
  }

  get connectorKey(): ListPublicKey {
    return this.#data.connectorKey;
  }

  /** Which list this is: 0, then one more for each fresh start. */
  get generation(): number {
    return this.#data.generation;
  }

  /** How many entries the list holds. The next entry's position. */
  get length(): number {
    return this.#data.length;
  }

  /** The hash of the latest entry. The next entry's `prev`. */
  get head(): Uint8Array {
    return copy(this.#data.head);
  }

  /** The current members, the connector first, in the order they were added. */
  members(): Member[] {
    return [...this.#data.members.values()].map(detach);
  }

  /** The current device members (everything but the connector). */
  devices(): Member[] {
    return this.members().filter((member) => member.role !== "connector");
  }

  member(key: ListPublicKey): Member | undefined {
    const member = this.#data.members.get(hex(key.bytes));
    return member && detach(member);
  }

  removal(key: ListPublicKey): Removal | undefined {
    const removal = this.#data.removed.get(hex(key.bytes));
    return removal && Object.freeze({ ...removal, member: detach(removal.member) });
  }

  /** The current members whose entry `key` signed: the devices it added. */
  addedBy(key: ListPublicKey): Member[] {
    return this.members().filter((member) => member.addedBy?.equals(key) === true);
  }

  /**
   * What removing `key` offers to remove too (design §4.6): every current member whose entry
   * descends from it through adds or restores. A device it added, a device that one added, a
   * device it put back, and so on; for a device put back, the member that put it back is the
   * one it descends from.
   */
  causedBy(key: ListPublicKey): Member[] {
    const caused = new Set([hex(key.bytes)]);
    const members = this.members();
    let grew = true;
    while (grew) {
      grew = false;
      for (const member of members) {
        const parent = member.restoredBy ?? member.addedBy;
        const id = hex(member.key.bytes);
        if (parent && caused.has(hex(parent.bytes)) && !caused.has(id)) {
          caused.add(id);
          grew = true;
        }
      }
    }
    return members.filter((member) => !member.key.equals(key) && caused.has(hex(member.key.bytes)));
  }

  /** Refuses a key that is not a current member, saying whether it never was or was removed. */
  requireMember(key: ListPublicKey): Member {
    const member = this.member(key);
    if (member) return member;
    if (this.removal(key)) fail("removed_member", "the signer has been removed");
    fail("not_member", "the signer is not on the list");
  }

  /**
   * Refuses a device record that uses one key twice, or any of whose keys or pin the list holds
   * or has held in any role (a withdrawn entry's keys excepted).
   */
  requireNew(device: DeviceRecord): void {
    const keys = seenKeys(device);
    requireDistinct(keys);
    for (const key of keys) {
      if (this.#data.seen.has(key)) fail("duplicate_key", "a key already on the list");
    }
  }

  /**
   * Starts a list from its first entry, checked in full: a linking first entry, a server's
   * first entry or a fresh start, each signed by the connector and by its device. Use
   * `verifyList` to read a list someone else holds: it also checks the connector's head.
   */
  static fromGenesis(context: ListContext, input: Uint8Array): ListState {
    const expected = checkContext(context);
    const bytes = copy(input);
    const { entry, signed, signatures } = decodeEntry(bytes);
    if (!isFirst(entry)) fail("bad_chain", "a list starts with its first entry");
    if (!verifyEd25519(entry.connectorKey.bytes, signed, signatures[0]!)) {
      fail("bad_signature", "the connector's signature does not verify");
    }
    if (!verifyEd25519(entry.device.listKey.bytes, signed, signatures[1]!)) {
      fail("bad_signature", "the first device's signature does not verify");
    }
    expectContext(entry.context, expected);
    if (entry.seq !== 0 || !equalBytes(entry.prev, ZERO_HASH))
      fail("bad_chain", "the first entry is not first");
    const connectorSeen = `key:${hex(entry.connectorKey.bytes)}`;
    const carried = entry.type === "fresh-start" ? entry.carried : [];
    const keys = [
      connectorSeen,
      ...seenKeys(entry.device),
      ...carried.flatMap((c) => seenKeys(c.device)),
    ];
    requireDistinct(keys);
    if (entry.type === "fresh-start" && entry.generation < 1)
      fail("bad_chain", "a fresh start follows a list");
    const connector: Member = {
      key: entry.connectorKey,
      role: "connector",
      device: null,
      addedBy: null,
      restoredBy: null,
      since: 0,
    };
    const first = newMember(entry.device, "gateway-device", null, 0);
    const members = new Map([
      [hex(connector.key.bytes), connector],
      [hex(first.key.bytes), first],
    ]);
    for (const c of carried)
      members.set(hex(c.device.listKey.bytes), newMember(c.device, "device", c.addedBy, 0));
    return new ListState({
      context: expected,
      connectorKey: entry.connectorKey,
      generation: entry.type === "fresh-start" ? entry.generation : 0,
      length: 1,
      head: entryHash(bytes),
      members,
      removed: new Map(),
      seen: new Set(keys),
      signers: new Set(),
    });
  }

  /**
   * Checks the next entry against this state and returns the state after it. The order of the
   * checks: the bytes, the signature, the gateway and account, the position, for an add or a
   * restore the growth limit, the signer, and what the signer's role allows.
   */
  append(input: Uint8Array): ListState {
    const data = this.#data;
    const bytes = copy(input);
    const { entry, signed, signatures } = decodeEntry(bytes);
    if (isFirst(entry)) fail("bad_chain", "a second first entry");
    if (!verifyEd25519(entry.signer.bytes, signed, signatures[0]!)) {
      fail("bad_signature", "the entry's signature does not verify");
    }
    expectContext(entry.context, data.context);
    if (entry.seq !== data.length || !equalBytes(entry.prev, data.head)) {
      fail("bad_chain", "the entry does not follow the list's latest entry");
    }
    // Only growth is bounded: a removal is never refused for size, so a device can always be
    // removed. At most MAX_MEMBERS removals can follow the growth limit.
    if (entry.type !== "remove" && data.length >= GROWTH_LIMIT)
      fail("list_full", "the list holds its most entries");
    const signer = this.requireMember(entry.signer);
    const members = new Map(data.members);
    const removed = new Map(data.removed);
    const seen = new Set(data.seen);
    const signers = new Set(data.signers);
    signers.add(hex(entry.signer.bytes));
    const deviceCount = this.devices().length;

    switch (entry.type) {
      case "add": {
        if (signer.role === "connector") fail("not_permitted", "only a device adds a device");
        this.requireNew(entry.device);
        if (deviceCount >= MAX_MEMBERS) fail("list_full", "the list holds its most members");
        const member = newMember(entry.device, "device", entry.signer, entry.seq);
        members.set(hex(member.key.bytes), member);
        for (const key of seenKeys(entry.device)) seen.add(key);
        break;
      }
      case "remove": {
        const target = this.member(entry.target);
        if (!target) fail("bad_target", "the target is not a current member");
        if (target.role === "connector")
          fail("protected_member", "the connector is removed by unlinking");
        if (entry.origin !== "member" && signer.role !== "connector")
          fail("not_permitted", "only the connector writes this removal");
        if (entry.origin === "member" && target.role === "gateway-device") {
          // Only that device itself, or the connector (both on the gateway's machine).
          if (signer.role !== "connector" && !entry.signer.equals(target.key))
            fail("protected_member", "only the gateway's own device or the connector removes it");
        }
        if (entry.origin === "account" && target.role === "gateway-device")
          fail("protected_member", "the account page can't remove the gateway's own device");
        if (entry.origin === "withdrawn") {
          // An entry that never paired: a device added by a join, never put back, that has
          // signed nothing. Its keys are freed so the same device can join again.
          if (target.role !== "device" || target.restoredBy !== null || target.since === 0)
            fail("bad_target", "only an added device that never paired is withdrawn");
          if (data.signers.has(hex(target.key.bytes)))
            fail("bad_target", "a device that has signed an entry is removed, not withdrawn");
          for (const key of seenKeys(target.device!)) seen.delete(key);
        }
        members.delete(hex(target.key.bytes));
        removed.set(hex(target.key.bytes), { member: target, origin: entry.origin, at: entry.seq });
        break;
      }
      case "restore": {
        if (signer.role === "connector") fail("not_permitted", "only a device puts a device back");
        const removal = this.removal(entry.target);
        if (!removal || removal.origin !== "account") {
          fail("bad_target", "only a device the account page removed can be put back");
        }
        if (deviceCount >= MAX_MEMBERS) fail("list_full", "the list holds its most members");
        removed.delete(hex(entry.target.bytes));
        members.set(hex(entry.target.bytes), {
          ...removal.member,
          restoredBy: entry.signer,
          since: entry.seq,
        });
        break;
      }
    }
    return new ListState({
      ...data,
      length: data.length + 1,
      head: entryHash(bytes),
      members,
      removed,
      seen,
      signers,
    });
  }

  /**
   * A member takes a fresh start of its list: signed by this list's connector and its gateway
   * machine's own device, the next generation, and naming this list's head or a newer one. When
   * it names this very head, the devices it carries must be exactly this list's.
   */
  freshStart(input: Uint8Array): ListState {
    const next = ListState.fromGenesis(this.#data.context, input);
    const { entry } = decodeEntry(copy(input));
    if (entry.type !== "fresh-start") fail("bad_chain", "not a fresh start");
    if (!entry.connectorKey.equals(this.#data.connectorKey))
      fail("not_permitted", "a fresh start by another connector");
    const own = this.devices().find((member) => member.role === "gateway-device");
    if (!own || !own.key.equals(entry.device.listKey))
      fail("not_permitted", "a fresh start signed by another device than the gateway's own");
    if (entry.generation !== this.#data.generation + 1)
      fail("bad_chain", "not the next generation");
    if (entry.oldCount < this.#data.length) fail("stale_head", "a fresh start of an older list");
    if (entry.oldCount === this.#data.length) {
      if (!equalBytes(entry.oldHead, this.#data.head))
        fail("bad_chain", "a fresh start of another list");
      const carried = [entry.device, ...entry.carried.map((c) => c.device)]
        .map((d) => hex(d.listKey.bytes))
        .sort();
      const current = this.devices()
        .map((m) => hex(m.key.bytes))
        .sort();
      if (carried.join() !== current.join())
        fail("bad_chain", "a fresh start that changes the members");
    }
    return next;
  }
}

/**
 * Reads a list someone else holds: checks it from its first entry, then checks the connector's
 * signed head that came with it, and that the list ends exactly at that head. With `held`, the
 * newest head this reader holds, it refuses a list older than that (`stale_head`) or forked from
 * it (`bad_chain`).
 */
export function verifyList(
  context: ListContext,
  entries: readonly Uint8Array[],
  headBytes: Uint8Array,
  held?: Head,
): { state: ListState; head: Head } {
  if (entries.length === 0) fail("malformed", "a list has at least its first entry");
  if (entries.length > MAX_ENTRIES) fail("too_large", "the list is over its bound");
  let state = ListState.fromGenesis(context, entries[0]!);
  for (const entry of entries.slice(1)) state = state.append(entry);
  const head = verifyHead(headBytes, state.connectorKey, state.context);
  if (
    head.generation !== state.generation ||
    head.count !== state.length ||
    !equalBytes(head.entryHash, state.head)
  )
    fail("bad_chain", "the list doesn't end at its head");
  if (held) requireNotOlder(head, held);
  return Object.freeze({ state, head });
}

/** The fields of the linking app's first entry, which the connector and the linking device each sign. */
export interface GenesisFields {
  readonly context: ListContext;
  readonly connectorKey: ListPublicKey;
  readonly device: DeviceRecord;
}

function genesisEntry(fields: GenesisFields): Entry {
  return {
    context: checkContext(fields.context),
    seq: 0,
    prev: ZERO_HASH,
    type: "genesis",
    connectorKey: fields.connectorKey,
    device: fields.device,
  };
}

/** One of the first entry's two signatures, by the connector's key or the linking device's. */
export function signGenesis(key: ListSecretKey, fields: GenesisFields): Uint8Array {
  const own = key.publicKey;
  if (!own.equals(fields.connectorKey) && !own.equals(fields.device.listKey)) {
    fail("not_permitted", "only the connector and the linking device sign the first entry");
  }
  return signList(key, encodeSigned(genesisEntry(fields)));
}

/**
 * Puts the first entry together from its two signatures and checks it. The state it returns is
 * the list's: a first entry with both signatures is the whole list.
 */
export function assembleGenesis(
  fields: GenesisFields,
  connectorSignature: Uint8Array,
  deviceSignature: Uint8Array,
): { entry: Uint8Array; state: ListState } {
  const signed = encodeSigned(genesisEntry(fields));
  const entry = concat(
    signed,
    checkLength(connectorSignature, 64, "a signature"),
    checkLength(deviceSignature, 64, "a signature"),
  );
  return Object.freeze({ entry, state: ListState.fromGenesis(fields.context, entry) });
}

/** For the join only: a server's first entry with the connector's signature alone. */
export function signServerFirst(
  connector: ListSecretKey,
  context: ListContext,
  device: DeviceRecord,
  joinTranscript: Uint8Array,
): Uint8Array {
  const signed = encodeSigned({
    context: checkContext(context),
    seq: 0,
    prev: ZERO_HASH,
    type: "server-first",
    connectorKey: connector.publicKey,
    device,
    joinTranscript,
  });
  return concat(signed, signList(connector, signed));
}

/** For the join only: reads a first entry that carries only the connector's signature, checked. */
export function readServerFirst(bytes: Uint8Array): {
  entry: Extract<Entry, { type: "server-first" }>;
  signed: Uint8Array;
} {
  const { entry, signed, signatures } = decodeEntry(copy(bytes), true);
  if (entry.type !== "server-first") fail("malformed", "not a server's first entry");
  if (!verifyEd25519(entry.connectorKey.bytes, signed, signatures[0]!))
    fail("bad_signature", "the connector's signature does not verify");
  if (entry.seq !== 0 || !equalBytes(entry.prev, ZERO_HASH))
    fail("bad_chain", "the first entry is not first");
  return { entry, signed };
}

/** For the join only: the new device adds its own signature to a server's first entry. */
export function completeServerFirst(device: ListSecretKey, partial: Uint8Array): Uint8Array {
  const { signed } = readServerFirst(partial);
  return concat(copy(partial), signList(device, signed));
}

function freshStartEntry(state: ListState): Entry {
  const devices = state.devices();
  const own = devices.find((member) => member.role === "gateway-device");
  if (!own) fail("bad_target", "the list has no gateway device to sign a fresh start");
  return {
    context: state.context,
    seq: 0,
    prev: ZERO_HASH,
    type: "fresh-start",
    generation: state.generation + 1,
    connectorKey: state.connectorKey,
    oldCount: state.length,
    oldHead: state.head,
    device: own.device!,
    carried: devices
      .filter((member) => member.role !== "gateway-device")
      .map((member) => ({ device: member.device!, addedBy: member.restoredBy ?? member.addedBy })),
  };
}

/**
 * One of a fresh start's two signatures, by the connector or the gateway machine's own device,
 * over the fields built from `state`: the next generation, its head, and its current devices.
 */
export function signFreshStart(key: ListSecretKey, state: ListState): Uint8Array {
  const entry = freshStartEntry(state);
  if (
    !key.publicKey.equals(state.connectorKey) &&
    !key.publicKey.equals((entry as { device: DeviceRecord }).device.listKey)
  )
    fail("not_permitted", "only the connector and the gateway's own device sign a fresh start");
  return signList(key, encodeSigned(entry));
}

/** Puts a fresh start together from its two signatures; returns it and the new list's state. */
export function assembleFreshStart(
  state: ListState,
  connectorSignature: Uint8Array,
  deviceSignature: Uint8Array,
): { entry: Uint8Array; state: ListState } {
  const entry = concat(
    encodeSigned(freshStartEntry(state)),
    checkLength(connectorSignature, 64, "a signature"),
    checkLength(deviceSignature, 64, "a signature"),
  );
  return Object.freeze({ entry, state: state.freshStart(entry) });
}

/**
 * Signs an entry and checks that it would follow `state`. Returns only the entry: whether it is
 * on the list is the connector's to decide when it appends it.
 */
function signEntry(signer: ListSecretKey, state: ListState, fields: Entry): Uint8Array {
  const signed = encodeSigned(fields);
  const entry = concat(signed, signList(signer, signed));
  state.append(entry);
  return entry;
}

function nextHead(state: ListState) {
  return { context: state.context, seq: state.length, prev: state.head };
}

/** For the join only: the entry that adds a device after a right pick. Not exported from the package. */
export function signAdd(
  signer: ListSecretKey,
  state: ListState,
  device: DeviceRecord,
  joinTranscript: Uint8Array,
): Uint8Array {
  return signEntry(signer, state, {
    ...nextHead(state),
    type: "add",
    device,
    joinTranscript,
    signer: signer.publicKey,
  });
}

/** A device member removes `target`, itself included. The connector uses `signRemovalOnGatewayMachine`. */
export function signRemoval(
  signer: ListSecretKey,
  state: ListState,
  target: ListPublicKey,
): Uint8Array {
  if (signer.publicKey.equals(state.connectorKey))
    fail("not_permitted", "the connector removes with signRemovalOnGatewayMachine");
  return removal(signer, state, target, "member");
}

/**
 * The connector removes `target` for an action on the gateway's machine (a device removed there
 * by other means, say). Never for a request that came through the service: that is
 * `signRemovalNotice`.
 */
export function signRemovalOnGatewayMachine(
  connector: ListSecretKey,
  state: ListState,
  target: ListPublicKey,
): Uint8Array {
  if (!connector.publicKey.equals(state.connectorKey))
    fail("not_permitted", "only the connector removes on the gateway's machine");
  return removal(connector, state, target, "member");
}

/**
 * The connector withdraws an entry that never paired (design §4.4 step 5a), which frees its
 * keys so the same device can join again. Refused for any device that was put back, was in a
 * first entry, or has signed an entry; those are removed, and their keys stay burned.
 */
export function signWithdrawal(
  connector: ListSecretKey,
  state: ListState,
  target: ListPublicKey,
): Uint8Array {
  if (!connector.publicKey.equals(state.connectorKey))
    fail("not_permitted", "only the connector withdraws an entry");
  return removal(connector, state, target, "withdrawn");
}

function removal(
  signer: ListSecretKey,
  state: ListState,
  target: ListPublicKey,
  origin: RemovalOrigin,
): Uint8Array {
  return signEntry(signer, state, {
    ...nextHead(state),
    type: "remove",
    origin,
    target,
    signer: signer.publicKey,
  });
}

/** A member puts back a device the account page removed. */
export function signRestore(
  signer: ListSecretKey,
  state: ListState,
  target: ListPublicKey,
): Uint8Array {
  return signEntry(signer, state, {
    ...nextHead(state),
    type: "restore",
    target,
    signer: signer.publicKey,
  });
}

/** The account page's unsigned removal, as the service hands it to the connector. */
export function encodeRemovalNotice(context: ListContext, target: ListPublicKey): Uint8Array {
  const writer = new Writer().label(LABEL.removalNotice);
  writeContext(writer, checkContext(context));
  return writer.fixed(target.bytes, 32, "target").finish();
}

export function decodeRemovalNotice(bytes: Uint8Array): {
  context: ListContext;
  target: ListPublicKey;
} {
  const reader = new Reader(copy(bytes));
  reader.label(LABEL.removalNotice);
  const context = readContext(reader);
  const target = ListPublicKey.fromBytes(reader.fixed(32, "target"));
  reader.end();
  return Object.freeze({ context: Object.freeze(context), target });
}

/**
 * The connector writes the account page's removal into the list under its own key. The list
 * refuses it for the connector and the gateway's own device.
 */
export function signRemovalNotice(
  connector: ListSecretKey,
  state: ListState,
  notice: Uint8Array,
): Uint8Array {
  const { context, target } = decodeRemovalNotice(notice);
  expectContext(context, state.context);
  return removal(connector, state, target, "account");
}

/** The largest list as one byte string: a fresh start, then every other entry at its largest. */
export const MAX_LIST_BYTES =
  2 + (2 + MAX_FRESH_START_BYTES) + (MAX_ENTRIES - 1) * (2 + MAX_ENTRY_BYTES);

/** A list as one byte string, for sealing: a two-byte count, then each entry with its length. */
export function encodeList(entries: readonly Uint8Array[]): Uint8Array {
  if (entries.length === 0) fail("malformed", "a list has at least its first entry");
  if (entries.length > MAX_ENTRIES) fail("too_large", "the list is over its bound");
  const writer = new Writer().u16(entries.length);
  entries.forEach((entry, i) =>
    writer.bytes(entry, 1, i === 0 ? MAX_FRESH_START_BYTES : MAX_ENTRY_BYTES, "entry"),
  );
  return writer.finish();
}

export function decodeList(bytes: Uint8Array): Uint8Array[] {
  const reader = new Reader(bytes);
  const count = reader.u16();
  if (count === 0) fail("malformed", "a list has at least its first entry");
  if (count > MAX_ENTRIES) fail("too_large", "the list is over its bound");
  const entries: Uint8Array[] = [];
  for (let i = 0; i < count; i++)
    entries.push(reader.bytes(1, i === 0 ? MAX_FRESH_START_BYTES : MAX_ENTRY_BYTES, "entry"));
  reader.end();
  return entries;
}

/** For the join only: reads an entry other than a first entry and checks its one signature. */
export function readSignedEntry(bytes: Uint8Array): Entry {
  const { entry, signed, signatures } = decodeEntry(copy(bytes));
  if (isFirst(entry)) fail("malformed", "not an entry one member signs");
  if (!verifyEd25519(entry.signer.bytes, signed, signatures[0]!)) {
    fail("bad_signature", "the entry's signature does not verify");
  }
  return entry;
}
