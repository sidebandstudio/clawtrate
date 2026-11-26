// Seeded fuzzing of every decoder and of list verification. Each run is the same; a failure
// names its seed. The properties: nothing throws but `AccountProtocolError`; every input is
// handled in bounded time (the test's timeout); and nothing accepts a second encoding of a
// value: a changed input that a signature covers is never accepted, and an unsigned one that is
// accepted encodes back to exactly itself.

import { describe, expect, it, vi } from "vitest";
import {
  AccountProtocolError,
  assembleRelink,
  signRelink,
  assembleFreshStart,
  ListState,
  openFirstSecret,
  sealFirstSecret,
  signFreshStart,
  verifyHead,
  decodeRemovalNotice,
  encodeRemovalNotice,
  MemberJoin,
  NewDeviceJoin,
  openCard,
  openEntry,
  openList,
  catchUp,
  readEntryUnverified,
  refuseJoin,
  sealCard,
  sealEntry,
  sealList,
  SessionSecretKey,
  signRemoval,
  signSessionRequest,
  verifyCard,
  verifyRefusal,
  verifySessionRequest,
} from "../src/index.ts";
import { decodeList, encodeList } from "../src/list.ts";
import {
  chain,
  appended,
  CONTEXT,
  fill,
  LIST_RANDOM,
  makeDevice,
  makeWorld,
  memberOf,
  N_RANDOM,
  runJoin,
  SEAL_RANDOM,
  seeded,
  toHex,
  CLOCK,
  NOW,
  headObject,
  headOf,
  holding,
  rotated,
  fresh,
  anew,
} from "./helpers.ts";

// Signatures and key checks are quick alone; on a loaded machine a test can take seconds.
vi.setConfig({ testTimeout: 120_000 });

type Rng = ReturnType<typeof seeded>;
const RUNS = 600;

/** One to four changes: a flipped bit, a replaced, inserted or deleted byte, or a cut. */
function mutate(rng: Rng, input: Uint8Array): Uint8Array {
  let bytes = [...input];
  for (let n = 1 + rng.int(4); n > 0; n--) {
    const at = rng.int(bytes.length + 1);
    switch (rng.int(5)) {
      case 0:
        if (at < bytes.length) bytes[at]! ^= 1 << rng.int(8);
        break;
      case 1:
        if (at < bytes.length) bytes[at] = rng.int(256);
        break;
      case 2:
        bytes.splice(at, 0, rng.int(256));
        break;
      case 3:
        bytes.splice(at, 1);
        break;
      default:
        bytes = bytes.slice(0, at);
    }
  }
  return Uint8Array.from(bytes);
}

/** Random bytes, often starting with a real label so the decoder gets past its first check. */
function noise(rng: Rng, label: Uint8Array): Uint8Array {
  const body = rng.bytes(rng.int(600));
  return rng.int(2) === 0
    ? body
    : Uint8Array.of(...label.subarray(0, rng.int(label.length + 1)), ...body);
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  return toHex(a) === toHex(b);
}

/**
 * Feeds `decode` mutations of `valid` and random bytes. A result for a changed input fails the
 * test unless `accepts` says the result is a legitimate reading of those exact bytes.
 */
function fuzz(
  seed: number,
  valid: Uint8Array,
  decode: (b: Uint8Array) => unknown,
  accepts: (b: Uint8Array, out: unknown) => boolean = () => false,
) {
  const rng = seeded(seed);
  for (let run = 0; run < RUNS; run++) {
    const input = run % 3 === 2 ? noise(rng, valid.subarray(0, 40)) : mutate(rng, valid);
    let out: unknown;
    try {
      out = decode(input);
    } catch (error) {
      if (!(error instanceof AccountProtocolError))
        throw new Error(`seed ${seed}, run ${run}: ${String(error)}`, { cause: error });
      continue;
    }
    if (!same(input, valid) && !accepts(input, out))
      throw new Error(`seed ${seed}, run ${run}: accepted a changed input`);
  }
}

const world = makeWorld();
const gateway = world.gatewayDevice;
const mac = makeDevice(2, "MacBook Pro");
const member = memberOf(world, gateway.listKey);
const run = runJoin(member, mac);
const added = run.a.confirm(run.words, SEAL_RANDOM, NOW);
if (added.outcome !== "added") throw new Error("expected an added outcome");
const withMac = appended(world, added.entry);
const removal = signRemoval(gateway.listKey, withMac.state, mac.device.listKey);
const entries = [world.genesis, added.entry, removal];
const sealedWithMac = sealList(
  world.secret,
  CONTEXT,
  withMac.entries,
  LIST_RANDOM,
  headObject(world),
);
/** A fresh N with the same keys and random: the same commitment, ready for one answer. */
const freshN = () => NewDeviceJoin.start(fresh(mac), CONTEXT, N_RANDOM, CLOCK);

describe("seeded fuzzing", () => {
  it("entries, read alone: whatever is accepted reads back as the bytes it came from", () => {
    // readEntry checks no signature, so a changed entry may read; it must then be another value
    // or carry another signature.
    const reading = (b: Uint8Array, out: unknown) =>
      JSON.stringify(describeValue(out)) + toHex(b.subarray(b.length - 64));
    const original = reading(added.entry, readEntryUnverified(added.entry));
    fuzz(1, added.entry, readEntryUnverified, (b, out) => reading(b, out) !== original);
  }, 120_000);

  it("the list, entry by entry and as a whole", () => {
    fuzz(2, world.genesis, (b) => chain(CONTEXT, [b]));
    fuzz(3, added.entry, (b) => world.state.append(b));
    fuzz(4, removal, (b) => withMac.state.append(b));
    const rng = seeded(5);
    for (let i = 0; i < RUNS; i++) {
      const list = entries.map((entry) => (rng.int(3) === 0 ? mutate(rng, entry) : entry));
      if (rng.int(4) === 0) list.splice(rng.int(list.length), 1);
      if (rng.int(4) === 0) list.push(list[rng.int(list.length)]!);
      try {
        // A list cut short after any entry is still a list: what was accepted is a prefix of the real one.
        const state = chain(CONTEXT, list);
        expect(list.map(toHex)).toEqual(entries.slice(0, list.length).map(toHex));
        expect(state.length).toBe(list.length);
      } catch (error) {
        if (!(error instanceof AccountProtocolError)) throw error;
      }
    }
  }, 120_000);

  it("the list as one byte string: whatever is accepted encodes back to itself", () => {
    const valid = encodeList(entries);
    fuzz(6, valid, decodeList, (b, out) => same(encodeList(out as Uint8Array[]), b));
  }, 120_000);

  it("the card, the refusal and the removal notice", () => {
    fuzz(7, world.card, (b) => verifyCard(b, world.connector.publicKey, CONTEXT.gatewayId));
    const refusal = refuseJoin(member, run.commit, "none-match", NOW).refusal;
    fuzz(8, refusal, (b) => verifyRefusal(world.state, b, [world.state.head]));
    const notice = encodeRemovalNotice(CONTEXT, mac.device.listKey);
    fuzz(9, notice, decodeRemovalNotice, (b, out) => {
      const value = out as ReturnType<typeof decodeRemovalNotice>;
      return same(encodeRemovalNotice(value.context, value.target), b);
    });
  }, 120_000);

  it("the join's messages, at the step that reads each", () => {
    // A changed commit that A answers gives N an answer to another join.
    fuzz(10, run.commit, (b) => freshN().reveal(MemberJoin.answer(anew(member), b, CLOCK).answer));
    // A changed answer that N reads still gives a reveal A refuses: the answer's acceptance is A's.
    fuzz(11, run.answer, (b) =>
      MemberJoin.answer(anew(member), run.commit, CLOCK).choices(freshN().reveal(b).reveal),
    );
    fuzz(12, run.reveal, (b) => MemberJoin.answer(anew(member), run.commit, CLOCK).choices(b));
    fuzz(13, added.confirm, (b) => {
      const n = freshN();
      n.reveal(run.answer);
      return n.finish(b, sealedWithMac, headOf(world, withMac), null);
    });
  }, 120_000);

  it("sealed things and the rotation", () => {
    const secret = world.secret;
    fuzz(14, sealList(secret, CONTEXT, entries, fill(32, 1), headObject(world)), (b) =>
      openList(
        secret,
        CONTEXT,
        b,
        headOf(world, { state: chain(CONTEXT, entries), entries }),
        null,
      ),
    );
    fuzz(15, sealCard(secret, CONTEXT, world.card, fill(32, 2), headObject(world)), (b) =>
      openCard(secret, world.state, b, headObject(world)),
    );
    fuzz(16, sealEntry(secret, CONTEXT, added.entry, fill(32, 3), headObject(world)), (b) =>
      openEntry(secret, world.state, b),
    );
    const afterRemoval = appended(withMac, removal);
    const { newest } = rotated(world, afterRemoval, secret);
    fuzz(17, newest.rotation, (b) =>
      catchUp(
        { listKey: gateway.device.listKey, sealKey: gateway.sealKey },
        holding(world, withMac),
        {
          ...newest,
          rotation: b,
        },
      ),
    );
  }, 120_000);

  it("the head, the first secret, a fresh start and a server's first entry", () => {
    fuzz(19, headOf(world, withMac), (b) => verifyHead(b, world.connector.publicKey, CONTEXT));
    const first = sealFirstSecret(world.connector, world.state, fill(32, 4)).message;
    fuzz(20, first, (b) =>
      openFirstSecret(
        { listKey: gateway.device.listKey, sealKey: gateway.sealKey },
        world.state,
        b,
      ),
    );
    const fresh = assembleFreshStart(
      withMac.state,
      signFreshStart(world.connector, withMac.state),
      signFreshStart(gateway.listKey, withMac.state),
    ).entry;
    fuzz(21, fresh, (b) => withMac.state.freshStart(b));
    fuzz(22, fresh, (b) => ListState.fromGenesis(CONTEXT, b));
    const gatewayGone = withMac.state.append(
      signRemoval(gateway.listKey, withMac.state, gateway.device.listKey),
    );
    const relink = assembleRelink(
      gatewayGone,
      mac.device.listKey,
      signRelink(world.connector, gatewayGone, mac.device.listKey),
      signRelink(mac.listKey, gatewayGone, mac.device.listKey),
    );
    fuzz(23, relink, (b) => gatewayGone.append(b));
  }, 120_000);

  it("the session request", () => {
    const key = SessionSecretKey.fromSeed(fill(32, 0x5e));
    const fields = {
      audience: "https://a.dev",
      challenge: fill(32, 1),
      method: "GET",
      path: "/",
      body: new Uint8Array(0),
    } as const;
    const request = signSessionRequest(key, { ...fields, issuedAtMs: 10_000 });
    fuzz(18, request, (b) => verifySessionRequest(b, { ...fields, nowMs: 10_000 }));
  }, 120_000);
});

/** A decoded value with every key and byte string as hex, so two readings compare by content. */
function describeValue(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, v: unknown) => {
      if (v instanceof Uint8Array) return toHex(v);
      if (v !== null && typeof v === "object" && "kind" in v && "bytes" in v)
        return toHex((v as { bytes: Uint8Array }).bytes);
      return v;
    }),
  );
}
