// The device list: a chain of signed entries, each naming the hash of the one before it. The
// first entry is signed by the connector and by the linking device; every later entry by one
// current member. `ListState` is what a verifier knows after each entry: who is a member, who
// was removed and how, and every key the list has ever held.

import { checkLength, concat, copy, equalBytes, hex, Reader, taggedHash, Writer } from "./bytes.ts";
import { fail } from "./errors.ts";
import { ListPublicKey, signList, verifyEd25519, type ListSecretKey } from "./keys.ts";
import { LABEL, TAG } from "./labels.ts";
import { GROWTH_LIMIT, MAX_ENTRIES, MAX_MEMBERS } from "./limits.ts";
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

/** The largest entry: a first entry with the longest name. Checked by the tests. */
export const MAX_ENTRY_BYTES = 456;

export type RemovalOrigin = "member" | "account";

interface EntryHead {
  readonly context: ListContext;
  readonly seq: number;
  readonly prev: Uint8Array;
}

export type Entry = EntryHead &
  (
    | {
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
  );

const TYPES = ["genesis", "add", "remove", "restore"] as const;
const ORIGINS = ["member", "account"] as const;
const ZERO_HASH = new Uint8Array(32);

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
  }
  return writer.finish();
}

interface DecodedEntry {
  readonly entry: Entry;
  readonly signed: Uint8Array;
  readonly signatures: Uint8Array[];
}

function decodeEntry(bytes: Uint8Array): DecodedEntry {
  if (bytes.length > MAX_ENTRY_BYTES) fail("too_large", "an entry is over its bound");
  const reader = new Reader(bytes);
  reader.label(LABEL.listEntry);
  const context = readContext(reader);
  const seq = reader.u32();
  const prev = reader.fixed(32, "previous hash");
  const type = TYPES[reader.u8() - 1];
  let entry: Entry;
  switch (type) {
    case "genesis":
      entry = {
        context,
        seq,
        prev,
        type,
        connectorKey: ListPublicKey.fromBytes(reader.fixed(32, "connector key")),
        device: readRecord(reader),
      };
      break;
    case "add":
      entry = {
        context,
        seq,
        prev,
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
        context,
        seq,
        prev,
        type,
        origin,
        target: ListPublicKey.fromBytes(reader.fixed(32, "target")),
        signer: ListPublicKey.fromBytes(reader.fixed(32, "signer")),
      };
      break;
    }
    case "restore":
      entry = {
        context,
        seq,
        prev,
        type,
        target: ListPublicKey.fromBytes(reader.fixed(32, "target")),
        signer: ListPublicKey.fromBytes(reader.fixed(32, "signer")),
      };
      break;
    default:
      fail("malformed", "unknown entry type");
  }
  const signed = reader.before();
  const signatures = [reader.fixed(64, "signature")];
  if (entry.type === "genesis") signatures.push(reader.fixed(64, "signature"));
  reader.end();
  return { entry, signed, signatures };
}

/** Reads an entry without checking it against a list or checking its signatures. */
export function readEntryUnverified(bytes: Uint8Array): Entry {
  return freezeEntry(decodeEntry(copy(bytes)).entry);
}

function freezeEntry(entry: Entry): Entry {
  if ("device" in entry) Object.freeze(entry.device);
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
  /** The member whose entry added it; null for the first entry's two. */
  readonly addedBy: ListPublicKey | null;
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
  readonly length: number;
  readonly head: Uint8Array;
  readonly members: ReadonlyMap<string, Member>;
  readonly removed: ReadonlyMap<string, Removal>;
  /**
   * Every key the list has held, of any kind and in any role (the connector's included), and
   * every TLS pin. No key may appear twice, so one key can never act in two roles.
   */
  readonly seen: ReadonlySet<string>;
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

/** Refuses a record that uses one key twice: its list key as its OpenClaw key, say. */
function requireDistinct(keys: readonly string[]): void {
  if (new Set(keys).size !== keys.length) fail("duplicate_key", "one key in two roles");
}

/** A member as a caller gets it: its own frozen copy, so changing it can't change the state. */
function detach(member: Member): Member {
  const device =
    member.device && Object.freeze({ ...member.device, tlsPin: copy(member.device.tlsPin) });
  return Object.freeze({ ...member, device });
}

/** What a list says after a given entry. Immutable: `append` returns a new state. */
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

  /** The current members whose entry `key` signed: what removing `key` offers to remove too. */
  addedBy(key: ListPublicKey): Member[] {
    return this.members().filter((member) => member.addedBy?.equals(key) === true);
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
   * or has held in any role.
   */
  requireNew(device: DeviceRecord): void {
    const keys = seenKeys(device);
    requireDistinct(keys);
    for (const key of keys) {
      if (this.#data.seen.has(key)) fail("duplicate_key", "a key already on the list");
    }
  }

  /** Starts a list from its first entry, checked in full. */
  static fromGenesis(context: ListContext, input: Uint8Array): ListState {
    const expected = checkContext(context);
    const bytes = copy(input);
    const { entry, signed, signatures } = decodeEntry(bytes);
    if (entry.type !== "genesis") fail("bad_chain", "a list starts with its first entry");
    if (!verifyEd25519(entry.connectorKey.bytes, signed, signatures[0]!)) {
      fail("bad_signature", "the connector's signature does not verify");
    }
    if (!verifyEd25519(entry.device.listKey.bytes, signed, signatures[1]!)) {
      fail("bad_signature", "the linking device's signature does not verify");
    }
    expectContext(entry.context, expected);
    if (entry.seq !== 0 || !equalBytes(entry.prev, ZERO_HASH))
      fail("bad_chain", "the first entry is not first");
    const connectorSeen = `key:${hex(entry.connectorKey.bytes)}`;
    requireDistinct([connectorSeen, ...seenKeys(entry.device)]);
    const connector: Member = {
      key: entry.connectorKey,
      role: "connector",
      device: null,
      addedBy: null,
      since: 0,
    };
    const device: Member = {
      key: entry.device.listKey,
      role: "gateway-device",
      device: entry.device,
      addedBy: null,
      since: 0,
    };
    return new ListState({
      context: expected,
      connectorKey: entry.connectorKey,
      length: 1,
      head: entryHash(bytes),
      members: new Map([
        [hex(connector.key.bytes), connector],
        [hex(device.key.bytes), device],
      ]),
      removed: new Map(),
      seen: new Set([connectorSeen, ...seenKeys(entry.device)]),
    });
  }

  /**
   * Checks the next entry against this state and returns the state after it. The order of the
   * checks: the bytes, the signature, the gateway and account, the position, the signer, and
   * what the signer's role allows.
   */
  append(input: Uint8Array): ListState {
    const data = this.#data;
    const bytes = copy(input);
    const { entry, signed, signatures } = decodeEntry(bytes);
    if (entry.type === "genesis") fail("bad_chain", "a second first entry");
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
    const deviceCount = this.devices().length;

    switch (entry.type) {
      case "add": {
        if (signer.role === "connector") fail("not_permitted", "only a device adds a device");
        this.requireNew(entry.device);
        if (deviceCount >= MAX_MEMBERS) fail("list_full", "the list holds its most members");
        const member: Member = {
          key: entry.device.listKey,
          role: "device",
          device: entry.device,
          addedBy: entry.signer,
          since: entry.seq,
        };
        members.set(hex(member.key.bytes), member);
        for (const key of seenKeys(entry.device)) seen.add(key);
        break;
      }
      case "remove": {
        const target = this.member(entry.target);
        if (!target) fail("bad_target", "the target is not a current member");
        if (target.role === "connector")
          fail("protected_member", "the connector is removed by unlinking");
        if (entry.origin === "account") {
          if (signer.role !== "connector")
            fail("not_permitted", "only the connector writes the account's removal");
          if (target.role === "gateway-device") {
            fail("protected_member", "the account page can't remove the gateway's own device");
          }
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
        members.set(hex(entry.target.bytes), { ...removal.member, since: entry.seq });
        break;
      }
    }
    return new ListState({
      context: data.context,
      connectorKey: data.connectorKey,
      length: data.length + 1,
      head: entryHash(bytes),
      members,
      removed,
      seen,
    });
  }
}

/** Checks a whole list from its first entry. */
export function verifyList(context: ListContext, entries: readonly Uint8Array[]): ListState {
  if (entries.length === 0) fail("malformed", "a list has at least its first entry");
  if (entries.length > MAX_ENTRIES) fail("too_large", "the list is over its bound");
  let state = ListState.fromGenesis(context, entries[0]!);
  for (const entry of entries.slice(1)) state = state.append(entry);
  return state;
}

/** The fields of the first entry, which the connector and the linking device each sign. */
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

/** For the join only: the entry that adds a device after a right pick. Not exported from the package. */
export function signAdd(
  signer: ListSecretKey,
  state: ListState,
  device: DeviceRecord,
  joinTranscript: Uint8Array,
): Uint8Array {
  return signEntry(signer, state, {
    context: state.context,
    seq: state.length,
    prev: state.head,
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
  return memberRemoval(signer, state, target);
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
  return memberRemoval(connector, state, target);
}

function memberRemoval(signer: ListSecretKey, state: ListState, target: ListPublicKey): Uint8Array {
  return signEntry(signer, state, {
    context: state.context,
    seq: state.length,
    prev: state.head,
    type: "remove",
    origin: "member",
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
    context: state.context,
    seq: state.length,
    prev: state.head,
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
  return signEntry(connector, state, {
    context: state.context,
    seq: state.length,
    prev: state.head,
    type: "remove",
    origin: "account",
    target,
    signer: connector.publicKey,
  });
}

/** A list as one byte string, for sealing: a two-byte count, then each entry with its length. */
export function encodeList(entries: readonly Uint8Array[]): Uint8Array {
  if (entries.length === 0) fail("malformed", "a list has at least its first entry");
  if (entries.length > MAX_ENTRIES) fail("too_large", "the list is over its bound");
  const writer = new Writer().u16(entries.length);
  for (const entry of entries) writer.bytes(entry, 1, MAX_ENTRY_BYTES, "entry");
  return writer.finish();
}

export function decodeList(bytes: Uint8Array): Uint8Array[] {
  const reader = new Reader(bytes);
  const count = reader.u16();
  if (count === 0) fail("malformed", "a list has at least its first entry");
  if (count > MAX_ENTRIES) fail("too_large", "the list is over its bound");
  const entries: Uint8Array[] = [];
  for (let i = 0; i < count; i++) entries.push(reader.bytes(1, MAX_ENTRY_BYTES, "entry"));
  reader.end();
  return entries;
}

/** For the join only: reads an entry other than the first and checks its one signature. */
export function readSignedEntry(bytes: Uint8Array): Entry {
  const { entry, signed, signatures } = decodeEntry(copy(bytes));
  if (entry.type === "genesis") fail("malformed", "not an entry one member signs");
  if (!verifyEd25519(entry.signer.bytes, signed, signatures[0]!)) {
    fail("bad_signature", "the entry's signature does not verify");
  }
  return entry;
}
