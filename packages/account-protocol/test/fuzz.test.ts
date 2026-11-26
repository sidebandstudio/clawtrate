// Seeded fuzzing of every decoder and of list verification. Each run is the same; a failure
// names its seed. The properties: nothing throws but `AccountProtocolError`; every input is
// handled in bounded time (the test's timeout); and nothing accepts a second encoding of a
// value: a changed input that a signature covers is never accepted, and an unsigned one that is
// accepted encodes back to exactly itself.

import { describe, expect, it, vi } from "vitest";
import {
  AccountProtocolError,
  decodeRemovalNotice,
  encodeRemovalNotice,
  joinChoices,
  joinConfirm,
  joinFinish,
  joinReveal,
  ListSecret,
  openCard,
  openEntry,
  openList,
  openRotation,
  readEntry,
  refuseJoin,
  rotateListSecret,
  sealCard,
  sealEntry,
  sealList,
  SessionSecretKey,
  signRemoval,
  signSessionRequest,
  verifyCard,
  verifyList,
  verifyRefusal,
  verifySessionRequest,
} from "../src/index.ts";
import { decodeList, encodeList } from "../src/list.ts";
import {
  CONTEXT,
  DECOY_SEED,
  fill,
  makeDevice,
  makeWorld,
  memberOf,
  N_NONCE,
  runJoin,
  SEAL_SEED,
  seeded,
  toHex,
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
const added = joinConfirm(
  member,
  run.commit,
  run.answer,
  run.reveal,
  DECOY_SEED,
  { set: run.right },
  SEAL_SEED,
);
if (added.outcome !== "added") throw new Error("expected an added outcome");
const removal = signRemoval(gateway.listKey, added.state, mac.device.listKey);
const entries = [world.genesis, added.entry, removal.entry];

describe("seeded fuzzing", () => {
  it("entries, read alone: whatever is accepted reads back as the bytes it came from", () => {
    // readEntry checks no signature, so a changed entry may read; it must then be another value
    // or carry another signature.
    const reading = (b: Uint8Array, out: unknown) =>
      JSON.stringify(describeValue(out)) + toHex(b.subarray(b.length - 64));
    const original = reading(added.entry, readEntry(added.entry));
    fuzz(1, added.entry, readEntry, (b, out) => reading(b, out) !== original);
  }, 120_000);

  it("the list, entry by entry and as a whole", () => {
    fuzz(2, world.genesis, (b) => verifyList(CONTEXT, [b]));
    fuzz(3, added.entry, (b) => world.state.append(b));
    fuzz(4, removal.entry, (b) => added.state.append(b));
    const rng = seeded(5);
    for (let i = 0; i < RUNS; i++) {
      const list = entries.map((entry) => (rng.int(3) === 0 ? mutate(rng, entry) : entry));
      if (rng.int(4) === 0) list.splice(rng.int(list.length), 1);
      if (rng.int(4) === 0) list.push(list[rng.int(list.length)]!);
      try {
        // A list cut short after any entry is still a list: what was accepted is a prefix of the real one.
        const state = verifyList(CONTEXT, list);
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
    fuzz(7, world.card, verifyCard);
    const refusal = refuseJoin(member, run.commit, "none-match");
    fuzz(8, refusal, (b) => verifyRefusal(world.state, b));
    const notice = encodeRemovalNotice(CONTEXT, mac.device.listKey);
    fuzz(9, notice, decodeRemovalNotice, (b, out) => {
      const value = out as ReturnType<typeof decodeRemovalNotice>;
      return same(encodeRemovalNotice(value.context, value.target), b);
    });
  }, 120_000);

  it("the join's messages, at the step that reads each", () => {
    fuzz(10, run.commit, (b) => joinReveal(mac, CONTEXT, N_NONCE, b, run.answer));
    // A changed answer that N reads still gives a reveal A refuses: the answer's acceptance is A's.
    fuzz(11, run.answer, (b) =>
      joinChoices(
        member,
        run.commit,
        run.answer,
        joinReveal(mac, CONTEXT, N_NONCE, run.commit, b).reveal,
        DECOY_SEED,
      ),
    );
    fuzz(12, run.reveal, (b) => joinChoices(member, run.commit, run.answer, b, DECOY_SEED));
    fuzz(13, added.confirm, (b) =>
      joinFinish(mac, CONTEXT, N_NONCE, run.commit, run.answer, run.reveal, b),
    );
  }, 120_000);

  it("sealed things and the rotation", () => {
    const secret = world.secret;
    fuzz(14, sealList(secret, CONTEXT, entries, fill(24, 1)), (b) => openList(secret, CONTEXT, b));
    fuzz(15, sealCard(secret, CONTEXT, world.card, fill(24, 2)), (b) =>
      openCard(secret, CONTEXT, b),
    );
    fuzz(16, sealEntry(secret, CONTEXT, added.entry, fill(24, 3)), (b) =>
      openEntry(secret, CONTEXT, b),
    );
    const rotation = rotateListSecret(
      world.connector,
      added.state,
      ListSecret.fromBytes(fill(32, 9), 1),
      fill(64, 3),
    );
    fuzz(17, rotation, (b) =>
      openRotation({ listKey: mac.device.listKey, sealKey: mac.sealKey }, added.state, b, secret),
    );
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
