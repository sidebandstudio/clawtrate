// A list over its life (design §4.4 step 5a and §4.6): a withdrawal that frees an unpaired
// entry's keys, what removing a device offers to remove with it, and a list started afresh.

import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it, vi } from "vitest";
import {
  assembleFreshStart,
  assembleGenesis,
  signGenesis,
  encodeRemovalNotice,
  GatewayDeviceKey,
  ListSecretKey,
  MAX_FRESH_START_BYTES,
  MAX_MEMBERS,
  SealSecretKey,
  signFreshStart,
  signRemoval,
  signRemovalNotice,
  signRemovalOnGatewayMachine,
  signRestore,
  signWithdrawal,
  verifyList,
  type JoiningDevice,
} from "../src/index.ts";
import { signList } from "../src/keys.ts";
import { signAdd } from "../src/list.ts";
import {
  appended,
  CONTEXT,
  expectCode,
  fill,
  headOf,
  makeDevice,
  makeWorld,
  seeded,
  type Held,
} from "./helpers.ts";

// Signatures and key checks are quick alone; on a loaded machine a test can take seconds.
vi.setConfig({ testTimeout: 120_000 });

const TRANSCRIPT = fill(32, 0x5a);

/** The same device trying again: its OpenClaw key and TLS pin kept, fresh list and seal keys. */
function again(device: JoiningDevice, n: number): JoiningDevice {
  const listKey = ListSecretKey.fromSeed(fill(32, n));
  const sealKey = SealSecretKey.fromSeed(fill(32, n + 1));
  return {
    listKey,
    sealKey,
    device: { ...device.device, listKey: listKey.publicKey, sealKey: sealKey.publicKey },
  };
}

describe("a withdrawal", () => {
  it("takes out an entry that never paired and frees its keys, so the same device can join again", () => {
    const world = makeWorld();
    const mac = makeDevice(2);
    const held = appended(
      world,
      signAdd(world.gatewayDevice.listKey, world.state, mac.device, TRANSCRIPT),
    );
    const out = held.state.append(signWithdrawal(world.connector, held.state, mac.device.listKey));
    expect(out.removal(mac.device.listKey)?.origin).toBe("withdrawn");
    // The same OpenClaw identity and TLS pin, fresh list and seal keys: taken.
    const retry = again(mac, 0x90);
    expect(
      out
        .append(signAdd(world.gatewayDevice.listKey, out, retry.device, TRANSCRIPT))
        .member(retry.device.listKey),
    ).toBeDefined();
    // And the very same keys too, since none of them ever paired.
    expect(
      out.append(signAdd(world.gatewayDevice.listKey, out, mac.device, TRANSCRIPT)).length,
    ).toBe(4);
    // A withdrawn device is not put back by the account page's restore.
    expectCode(
      () => signRestore(world.gatewayDevice.listKey, out, mac.device.listKey),
      "bad_target",
    );
  });

  it("every other removal still burns the keys", () => {
    const world = makeWorld();
    const mac = makeDevice(2);
    const held = appended(
      world,
      signAdd(world.gatewayDevice.listKey, world.state, mac.device, TRANSCRIPT),
    );
    const out = held.state.append(
      signRemoval(world.gatewayDevice.listKey, held.state, mac.device.listKey),
    );
    expectCode(
      () => signAdd(world.gatewayDevice.listKey, out, again(mac, 0x90).device, TRANSCRIPT),
      "duplicate_key",
    );
  });

  it("is refused for a device that signed anything, was put back, was in a first entry, or by anyone but the connector", () => {
    const world = makeWorld();
    const mac = makeDevice(2);
    const phone = makeDevice(3);
    let held: Held = appended(
      world,
      signAdd(world.gatewayDevice.listKey, world.state, mac.device, TRANSCRIPT),
    );
    held = appended(held, signAdd(mac.listKey, held.state, phone.device, TRANSCRIPT));
    expectCode(() => signWithdrawal(world.connector, held.state, mac.device.listKey), "bad_target");
    expectCode(
      () => signWithdrawal(world.connector, held.state, world.gatewayDevice.device.listKey),
      "bad_target",
    );
    expectCode(
      () => signWithdrawal(mac.listKey, held.state, phone.device.listKey),
      "not_permitted",
    );
    const byPage = appended(
      held,
      signRemovalNotice(
        world.connector,
        held.state,
        encodeRemovalNotice(CONTEXT, phone.device.listKey),
      ),
    );
    const back = appended(byPage, signRestore(mac.listKey, byPage.state, phone.device.listKey));
    expectCode(
      () => signWithdrawal(world.connector, back.state, phone.device.listKey),
      "bad_target",
    );
  });
});

describe("what removing a device offers to remove with it", () => {
  it("is every member that descends from it through adds or restores", () => {
    // The reviewer's case, turned round: a thief adds T2, T2 adds T3, and the thief puts back a
    // device the person had removed from the account page.
    const world = makeWorld();
    const gateway = world.gatewayDevice;
    const [thief, t2, t3, laptop] = [
      makeDevice(20),
      makeDevice(21),
      makeDevice(22),
      makeDevice(23),
    ];
    let held: Held = world;
    held = appended(held, signAdd(gateway.listKey, held.state, laptop.device, TRANSCRIPT));
    held = appended(held, signAdd(gateway.listKey, held.state, thief.device, TRANSCRIPT));
    held = appended(held, signAdd(thief.listKey, held.state, t2.device, TRANSCRIPT));
    held = appended(held, signAdd(t2.listKey, held.state, t3.device, TRANSCRIPT));
    held = appended(
      held,
      signRemovalNotice(
        world.connector,
        held.state,
        encodeRemovalNotice(CONTEXT, laptop.device.listKey),
      ),
    );
    held = appended(held, signRestore(thief.listKey, held.state, laptop.device.listKey));
    const caused = held.state
      .causedBy(thief.device.listKey)
      .map((m) => m.device!.name)
      .sort();
    expect(caused).toEqual(["Device 21", "Device 22", "Device 23"]);
    expect(held.state.addedBy(thief.device.listKey).map((m) => m.device!.name)).toEqual([
      "Device 21",
    ]);
    expect(
      held.state
        .causedBy(gateway.device.listKey)
        .map((m) => m.device!.name)
        .sort(),
    ).toEqual(["Device 20", "Device 21", "Device 22", "Device 23"]);
  });
});

/** A device from a seeded generator. */
function randomDevice(rng: ReturnType<typeof seeded>, name = "Laptop"): JoiningDevice {
  const listKey = ListSecretKey.fromSeed(rng.bytes(32));
  const sealKey = SealSecretKey.fromSeed(rng.bytes(32));
  return {
    listKey,
    sealKey,
    device: {
      listKey: listKey.publicKey,
      sealKey: sealKey.publicKey,
      tlsPin: rng.bytes(32),
      gatewayDeviceKey: GatewayDeviceKey.fromBytes(ed25519.getPublicKey(rng.bytes(32))),
      platform: "linux",
      name,
    },
  };
}

describe("a fresh start", () => {
  function threeDevices() {
    const world = makeWorld();
    const mac = makeDevice(2);
    const phone = makeDevice(3, "iPhone", "ios");
    let held: Held = appended(
      world,
      signAdd(world.gatewayDevice.listKey, world.state, mac.device, TRANSCRIPT),
    );
    held = appended(held, signAdd(mac.listKey, held.state, phone.device, TRANSCRIPT));
    return { world, mac, phone, held };
  }

  it("carries the old head and the current devices into a new first entry the members take", () => {
    const { world, mac, phone, held } = threeDevices();
    const fresh = assembleFreshStart(
      held.state,
      signFreshStart(world.connector, held.state),
      signFreshStart(world.gatewayDevice.listKey, held.state),
    );
    expect(fresh.state.generation).toBe(1);
    expect(fresh.state.length).toBe(1);
    expect(fresh.state.devices().map((m) => m.key.bytes)).toEqual(
      held.state.devices().map((m) => m.key.bytes),
    );
    expect(fresh.state.member(phone.device.listKey)?.addedBy?.equals(mac.device.listKey)).toBe(
      true,
    );
    // A new device reads the new list from its first entry, against the connector's new head.
    const newList = { state: fresh.state, entries: [fresh.entry] };
    expect(verifyList(CONTEXT, newList.entries, headOf(world, newList)).head.generation).toBe(1);
    // The new list keeps refusing its members' keys.
    expectCode(() => signAdd(mac.listKey, fresh.state, mac.device, TRANSCRIPT), "duplicate_key");
  });

  it("is taken only when it names the member's head or a newer one, and keeps the members", () => {
    const { world, mac, held } = threeDevices();
    const fresh = assembleFreshStart(
      held.state,
      signFreshStart(world.connector, held.state),
      signFreshStart(world.gatewayDevice.listKey, held.state),
    );
    // A member still at an older head can't check the members, but the generation is the next.
    const older = held.state; // the same: taken
    expect(older.freshStart(fresh.entry).generation).toBe(1);
    // A member whose list moved on past the head it names: a fresh start of an older list.
    const moved = held.state.append(signRemoval(mac.listKey, held.state, mac.device.listKey));
    expectCode(() => moved.freshStart(fresh.entry), "stale_head");
  });

  it("naming the member's very head, must carry exactly its devices", () => {
    const { world, held } = threeDevices();
    const fresh = assembleFreshStart(
      held.state,
      signFreshStart(world.connector, held.state),
      signFreshStart(world.gatewayDevice.listKey, held.state),
    ).entry;
    // Drop the last carried device (the phone: its record and its 32-byte "added by"), lower the
    // count, and sign again with the connector's and the gateway device's keys.
    const phoneBytes = 4 * 32 + 1 + 2 + "iPhone".length + 32;
    const body = fresh.slice(0, fresh.length - 128 - phoneBytes);
    const countAt = body.length - (4 * 32 + 1 + 2 + "Device 2".length + 32) - 1;
    body[countAt] = body[countAt]! - 1;
    const fewer = Uint8Array.of(
      ...body,
      ...signList(world.connector, body),
      ...signList(world.gatewayDevice.listKey, body),
    );
    expectCode(() => held.state.freshStart(fewer), "bad_chain");
  });

  it("signed by another member as if it were the gateway's own device is refused", () => {
    // A list with the same connector whose first device is the Mac, grown to the same length:
    // its fresh start is signed by the connector and the Mac.
    const { world, mac, held } = threeDevices();
    const fields = {
      context: CONTEXT,
      connectorKey: world.connector.publicKey,
      device: mac.device,
    };
    const other = assembleGenesis(
      fields,
      signGenesis(world.connector, fields),
      signGenesis(mac.listKey, fields),
    );
    let otherHeld: Held = { state: other.state, entries: [other.entry] };
    otherHeld = appended(
      otherHeld,
      signAdd(mac.listKey, otherHeld.state, makeDevice(30).device, TRANSCRIPT),
    );
    otherHeld = appended(
      otherHeld,
      signAdd(mac.listKey, otherHeld.state, makeDevice(31).device, TRANSCRIPT),
    );
    const fresh = assembleFreshStart(
      otherHeld.state,
      signFreshStart(world.connector, otherHeld.state),
      signFreshStart(mac.listKey, otherHeld.state),
    ).entry;
    expectCode(() => held.state.freshStart(fresh), "not_permitted");
  });

  it("is signed only by the connector and the gateway machine's own device", () => {
    const { world, mac, held } = threeDevices();
    expectCode(() => signFreshStart(mac.listKey, held.state), "not_permitted");
    expectCode(
      () =>
        assembleFreshStart(
          held.state,
          signFreshStart(world.connector, held.state),
          signFreshStart(world.connector, held.state),
        ),
      "bad_signature",
    );
  });

  it("has the size its bound names with every device carried and the longest names", () => {
    const world = makeWorld();
    const rng = seeded(11);
    let held: Held = world;
    while (held.state.devices().length < MAX_MEMBERS) {
      held = appended(
        held,
        signAdd(
          world.gatewayDevice.listKey,
          held.state,
          randomDevice(rng, "n".repeat(64)).device,
          TRANSCRIPT,
        ),
      );
    }
    // The gateway's own device keeps its shorter name; every carried device has the longest.
    const fresh = assembleFreshStart(
      held.state,
      signFreshStart(world.connector, held.state),
      signFreshStart(world.gatewayDevice.listKey, held.state),
    );
    expect(fresh.entry.length).toBe(MAX_FRESH_START_BYTES - (64 - "Windows PC".length));
  });

  it("can't be made when the gateway's own device is gone", () => {
    const { world, held } = threeDevices();
    const gone = held.state.append(
      signRemovalOnGatewayMachine(world.connector, held.state, world.gatewayDevice.device.listKey),
    );
    expectCode(() => signFreshStart(world.connector, gone), "bad_target");
  });
});
