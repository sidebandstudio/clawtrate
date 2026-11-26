// Fixed keys, a list with its card and secret, and a whole join, built from fixed bytes so every
// test is deterministic.

import { ed25519 } from "@noble/curves/ed25519.js";
import { expect } from "vitest";
import {
  AccountProtocolError,
  assembleGenesis,
  GatewayDeviceKey,
  joinAnswer,
  joinChoices,
  joinCommit,
  joinConfirm,
  joinFinish,
  joinReveal,
  ListSecret,
  ListSecretKey,
  SealSecretKey,
  signCard,
  signGenesis,
  type AccountProtocolErrorCode,
  type DeviceRecord,
  type JoiningDevice,
  type JoinMember,
  type JoinPick,
  type ListContext,
  type ListState,
  type Platform,
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

/** A device's secret keys and record, all from one number. */
export function makeDevice(
  n: number,
  name = `Device ${n}`,
  platform: Platform = "macos",
  listSeed = fill(32, n),
): JoiningDevice {
  const listKey = ListSecretKey.fromSeed(listSeed);
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

export interface World {
  readonly connector: ListSecretKey;
  readonly gatewayDevice: JoiningDevice;
  readonly genesis: Uint8Array;
  readonly entries: Uint8Array[];
  readonly state: ListState;
  readonly card: Uint8Array;
  readonly secret: ListSecret;
}

/** A linked gateway: the connector, the gateway machine's own device (device 1), the card and the first secret. */
export function makeWorld(
  seeds: { connector?: Uint8Array; gatewayDevice?: Uint8Array } = {},
): World {
  const connector = ListSecretKey.fromSeed(seeds.connector ?? CONNECTOR_SEED);
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
      { host: "fd00::20", port: 18790 },
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
    secret: ListSecret.fromBytes(fill(32, 0xe0), 0),
  };
}

export function memberOf(world: World, key: ListSecretKey, state = world.state): JoinMember {
  return { key, state, card: world.card, secret: world.secret };
}

export interface JoinRun {
  readonly commit: Uint8Array;
  readonly answer: Uint8Array;
  readonly reveal: Uint8Array;
  readonly words: readonly string[];
  readonly sets: readonly (readonly string[])[];
  readonly right: number;
}

export const N_NONCE = fill(32, 0x11);
export const A_NONCE = fill(32, 0x22);
export const DECOY_SEED = fill(32, 0x33);
export const SEAL_SEED = fill(32, 0x44);

/** Steps 1 to 4 of a join with no one in the middle, and where the right set is. */
export function runJoin(
  member: JoinMember,
  joining: JoiningDevice,
  nonces = { n: N_NONCE, a: A_NONCE, decoy: DECOY_SEED },
): JoinRun {
  const commit = joinCommit(joining, member.state.context, nonces.n);
  const answer = joinAnswer(member, commit, nonces.a);
  const { reveal, words } = joinReveal(joining, member.state.context, nonces.n, commit, answer);
  const { sets } = joinChoices(member, commit, answer, reveal, nonces.decoy);
  const right = sets.findIndex((set) => set.join(" ") === words.join(" "));
  return { commit, answer, reveal, words, sets, right };
}

/** A whole join with a right pick; returns the entry, A's new state and what N opened. */
export function addDevice(
  member: JoinMember,
  joining: JoiningDevice,
  nonces = { n: N_NONCE, a: A_NONCE, decoy: DECOY_SEED },
) {
  const run = runJoin(member, joining, nonces);
  const pick: JoinPick = { set: run.right };
  const outcome = joinConfirm(
    member,
    run.commit,
    run.answer,
    run.reveal,
    nonces.decoy,
    pick,
    SEAL_SEED,
  );
  if (outcome.outcome !== "added") throw new Error("expected an added outcome");
  const finished = joinFinish(
    joining,
    member.state.context,
    nonces.n,
    run.commit,
    run.answer,
    run.reveal,
    outcome.confirm,
  );
  return { run, ...outcome, finished };
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
