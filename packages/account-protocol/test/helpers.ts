// Fixed keys, a list with its card and secret, and a whole join, built from fixed bytes so every
// test is deterministic.

import { ed25519 } from "@noble/curves/ed25519.js";
import { expect } from "vitest";
import {
  AccountProtocolError,
  assembleGenesis,
  GatewayDeviceKey,
  ListSecret,
  ListSecretKey,
  MemberJoin,
  NewDeviceJoin,
  SealSecretKey,
  rotateListSecret,
  sealList,
  signCard,
  signGenesis,
  signHead,
  verifyHead,
  type AccountProtocolErrorCode,
  type DeviceRecord,
  type Head,
  type HeldList,
  type JoiningDevice,
  type JoinMember,
  type ListContext,
  ListState,
  type Platform,
  type Words,
} from "../src/index.ts";

export function fill(length: number, byte: number): Uint8Array {
  return new Uint8Array(length).fill(byte);
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function fromHex(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "hex"));
}

/** splitmix32: a small seeded generator, so a fuzz run repeats exactly. */
export function seeded(seed: number) {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
  const int = (max: number): number => next() % max;
  const bytes = (length: number): Uint8Array => Uint8Array.from({ length }, () => int(256));
  return { next, int, bytes };
}

export const CONTEXT: ListContext = { gatewayId: fill(16, 0xa1), accountId: fill(16, 0xb2) };
export const OTHER_GATEWAY: ListContext = { gatewayId: fill(16, 0xa3), accountId: fill(16, 0xb2) };
export const OTHER_ACCOUNT: ListContext = { gatewayId: fill(16, 0xa1), accountId: fill(16, 0xb4) };

/** The seed each list key the helpers made came from, so a test can make it again. */
const seedOf = new WeakMap<ListSecretKey, Uint8Array>();

function keyFrom(seed: Uint8Array): ListSecretKey {
  const key = ListSecretKey.fromSeed(seed);
  seedOf.set(key, seed);
  return key;
}

/**
 * The same list key as a new object. The package allows one new-device join per key object and
 * one open member join per key object, in a process; tests that run many joins with one fixed
 * key take a new object each time, as an app that made new keys would.
 */
export function again(key: ListSecretKey): ListSecretKey {
  const seed = seedOf.get(key);
  if (!seed) throw new Error("a key the helpers didn't make");
  return keyFrom(seed);
}

/** The same member with a new key object: a member that answers a new join after the last ended. */
export function anew<M extends { readonly key: ListSecretKey }>(member: M): M {
  return { ...member, key: again(member.key) };
}

/** The same device with new key objects (the same keys). */
export function fresh(device: JoiningDevice): JoiningDevice {
  return { ...device, listKey: again(device.listKey) };
}

/** A device's secret keys and record, all from one number. */
export function makeDevice(
  n: number,
  name = `Device ${n}`,
  platform: Platform = "macos",
  listSeed = fill(32, n),
): JoiningDevice {
  const listKey = keyFrom(listSeed);
  const sealKey = SealSecretKey.fromSeed(fill(32, (n + 64) % 256));
  const device: DeviceRecord = {
    listKey: listKey.publicKey,
    sealKey: sealKey.publicKey,
    tlsPin: fill(32, (n + 128) % 256),
    gatewayDeviceKey: GatewayDeviceKey.fromBytes(ed25519.getPublicKey(fill(32, (n + 192) % 256))),
    platform,
    name,
  };
  return { listKey, sealKey, device };
}

export const CONNECTOR_SEED = fill(32, 0xc0);

/** A list as a device holds it: the verified state and the entries it came from. */
export interface Held {
  readonly state: ListState;
  readonly entries: readonly Uint8Array[];
}

/** The list after one more entry, checked by `append`. */
export function appended(held: Held, entry: Uint8Array): Held {
  return { state: held.state.append(entry), entries: [...held.entries, entry] };
}

export interface World extends Held {
  readonly connector: ListSecretKey;
  readonly gatewayDevice: JoiningDevice;
  readonly genesis: Uint8Array;
  readonly card: Uint8Array;
  readonly secret: ListSecret;
}

/** A linked gateway: the connector, the gateway machine's own device (device 1), the card and the first secret. */
export function makeWorld(
  seeds: { connector?: Uint8Array; gatewayDevice?: Uint8Array } = {},
): World {
  const connector = keyFrom(seeds.connector ?? CONNECTOR_SEED);
  const gatewayDevice = makeDevice(1, "Windows PC", "windows", seeds.gatewayDevice);
  const fields = {
    context: CONTEXT,
    connectorKey: connector.publicKey,
    device: gatewayDevice.device,
  };
  const { entry, state } = assembleGenesis(
    fields,
    signGenesis(connector, fields),
    signGenesis(gatewayDevice.listKey, fields),
  );
  const card = signCard(connector, {
    gatewayId: CONTEXT.gatewayId,
    serial: 1,
    tlsPin: fill(32, 0xd0),
    addresses: [
      { host: "windows-pc.local", port: 18790 },
      { host: "windows-pc.example", port: 18790 },
    ],
    name: "Windows PC",
  });
  return {
    connector,
    gatewayDevice,
    genesis: entry,
    entries: [entry],
    state,
    card,
    secret: ListSecret.restoreStored(fill(32, 0xe0), 0),
  };
}

/** The connector's signed head of `held`, with the world's card and secret. */
export function headOf(world: World, held: Held = world, secret = world.secret): Uint8Array {
  return signHead(world.connector, held.state, secret, world.card);
}

/** The same head, read. */
export function headObject(world: World, held: Held = world, secret = world.secret): Head {
  return verifyHead(headOf(world, held, secret), held.state.connectorKey, held.state.context);
}

/** What a device holds: its list, the head of it (verified), and its secret. */
export function holding(world: World, held: Held, secret: ListSecret = world.secret): HeldList {
  return { state: held.state, head: headObject(world, held, secret), secret };
}

/**
 * The connector after a removal or restore: rotate, reseal the list under the new secret, sign
 * the head. Returns the new secret and what a device reads to catch up.
 */
export function rotated(world: World, held: Held, secret: ListSecret, random = fill(32, 0x6b)) {
  const { rotation, secret: next } = rotateListSecret(world.connector, held.state, secret, random);
  const head = headOf(world, held, next);
  const list = sealList(next, CONTEXT, held.entries, LIST_RANDOM, headObject(world, held, next));
  return { secret: next, newest: { rotation, list, head } };
}

export function memberOf(world: World, key: ListSecretKey, held: Held = world): JoinMember {
  return {
    key,
    state: held.state,
    head: headOf(world, held),
    card: world.card,
    secret: world.secret,
  };
}

export interface JoinRun {
  readonly n: NewDeviceJoin;
  readonly a: MemberJoin;
  readonly commit: Uint8Array;
  readonly answer: Uint8Array;
  readonly reveal: Uint8Array;
  readonly words: Words;
  readonly sets: readonly Words[];
  readonly right: number;
}

export const N_RANDOM = fill(32, 0x11);
export const SEAL_RANDOM = fill(32, 0x44);
export const LIST_RANDOM = fill(32, 0x71);
/** A fixed time, and no pause. */
export const NOW = 1_795_000_000_000;
export const CLOCK = { nowMs: NOW, pausedUntilMs: 0 } as const;

/** Steps 1 to 4 of a join with no one in the middle, and where the right set is. */
export function runJoin(member: JoinMember, joining: JoiningDevice, random = N_RANDOM): JoinRun {
  const n = NewDeviceJoin.start(fresh(joining), member.state.context, random, CLOCK);
  const commit = n.commit;
  const a = MemberJoin.answer({ ...member, key: again(member.key) }, commit, CLOCK);
  const answer = a.answer;
  const { reveal, words } = n.reveal(answer);
  const { sets } = a.choices(reveal);
  const right = sets.findIndex((set) => set.join(" ") === words.join(" "));
  return { n, a, commit, answer, reveal, words, sets, right };
}

/**
 * A whole join: the right pick on A, the connector's append and its new head, N's checks on the
 * list sealed after it, and the right word back on N. Returns the entry, the list after it,
 * N's prompt and what N was handed.
 */
export function addDevice(
  world: World,
  key: ListSecretKey,
  joining: JoiningDevice,
  held: Held = world,
  random = N_RANDOM,
) {
  const run = runJoin(memberOf(world, key, held), joining, random);
  const outcome = run.a.confirm(run.words, SEAL_RANDOM, NOW);
  if (outcome.outcome !== "added") throw new Error("expected an added outcome");
  const after = appended(held, outcome.entry);
  const head = headOf(world, after);
  const sealed = sealList(
    world.secret,
    CONTEXT,
    after.entries,
    LIST_RANDOM,
    headObject(world, after),
  );
  const prompt = run.n.finish(outcome.confirm, sealed, head, null);
  const picked = run.n.pickWord({ under: prompt.under, word: outcome.wordBack.word }, NOW);
  if (picked.outcome !== "confirmed") throw new Error("expected the word back to confirm");
  return {
    run,
    entry: outcome.entry,
    confirm: outcome.confirm,
    wordBack: outcome.wordBack,
    held: after,
    head,
    sealed,
    prompt,
    finished: picked.result,
  };
}

export function code(action: () => unknown): AccountProtocolErrorCode | "ok" {
  try {
    action();
    return "ok";
  } catch (error) {
    if (error instanceof AccountProtocolError) return error.code;
    throw error;
  }
}

export function expectCode(action: () => unknown, expected: AccountProtocolErrorCode): void {
  expect(code(action)).toBe(expected);
}

/** The bytes with one bit flipped at `index`. */
export function flip(bytes: Uint8Array, index: number, bit = 0): Uint8Array {
  const out = bytes.slice();
  out[index]! ^= 1 << bit;
  return out;
}

/** A list checked from its first entry, as the connector builds its own: no head. */
export function chain(context: ListContext, entries: readonly Uint8Array[]): ListState {
  let state = ListState.fromGenesis(context, entries[0]!);
  for (const entry of entries.slice(1)) state = state.append(entry);
  return state;
}
