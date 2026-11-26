// The device list: who is a member after each entry, every refusal, the list secret's rotation
// and a removed member's blindness after it.

import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it, vi } from "vitest";
import {
  assembleGenesis,
  encodeRemovalNotice,
  GatewayDeviceKey,
  ListSecret,
  ListSecretKey,
  MAX_ENTRIES,
  MAX_MEMBERS,
  openCard,
  openEntry,
  openList,
  openRotation,
  rotateListSecret,
  SealSecretKey,
  sealCard,
  sealEntry,
  sealList,
  signGenesis,
  signRemoval,
  signRemovalNotice,
  signRestore,
  verifyList,
  type JoiningDevice,
} from "../src/index.ts";
import { concat } from "../src/bytes.ts";
import { signList } from "../src/keys.ts";
import { signAdd } from "../src/list.ts";
import {
  addDevice,
  CONTEXT,
  expectCode,
  fill,
  makeDevice,
  makeWorld,
  memberOf,
  OTHER_ACCOUNT,
  OTHER_GATEWAY,
  seeded,
} from "./helpers.ts";

// Signatures and key checks are quick alone; on a loaded machine a test can take seconds.
vi.setConfig({ testTimeout: 120_000 });

const TRANSCRIPT = fill(32, 0x5a);

/** A device from a seeded generator, for lists longer than 256 fixed seeds allow. */
function randomDevice(rng: ReturnType<typeof seeded>): JoiningDevice {
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
      name: "Laptop",
    },
  };
}

/** The gateway's device (1), a Mac (2) added by it, and a phone (3) added by the Mac. */
function threeDevices() {
  const world = makeWorld();
  const gateway = world.gatewayDevice;
  const mac = makeDevice(2);
  const phone = makeDevice(3, "iPhone", "ios");
  const one = signAdd(gateway.listKey, world.state, mac.device, TRANSCRIPT);
  const two = signAdd(mac.listKey, one.state, phone.device, TRANSCRIPT);
  return {
    world,
    gateway,
    mac,
    phone,
    entries: [world.genesis, one.entry, two.entry],
    state: two.state,
  };
}

describe("the first entry", () => {
  it("makes the connector and the gateway's device the first members", () => {
    const world = makeWorld();
    expect(world.state.members().map((member) => member.role)).toEqual([
      "connector",
      "gateway-device",
    ]);
    expect(world.state.length).toBe(1);
    expect(verifyList(CONTEXT, [world.genesis]).head).toEqual(world.state.head);
  });

  it("needs both signatures, each from its own key", () => {
    const world = makeWorld();
    const fields = {
      context: CONTEXT,
      connectorKey: world.connector.publicKey,
      device: world.gatewayDevice.device,
    };
    const connectorSig = signGenesis(world.connector, fields);
    const deviceSig = signGenesis(world.gatewayDevice.listKey, fields);
    expectCode(() => assembleGenesis(fields, deviceSig, deviceSig), "bad_signature");
    expectCode(() => assembleGenesis(fields, connectorSig, connectorSig), "bad_signature");
    expectCode(() => signGenesis(makeDevice(9).listKey, fields), "not_permitted");
  });

  it("refuses one key in both roles", () => {
    const connector = ListSecretKey.fromSeed(fill(32, 1));
    const device = makeDevice(1).device;
    const fields = { context: CONTEXT, connectorKey: connector.publicKey, device };
    const sig = signGenesis(connector, fields);
    expectCode(() => assembleGenesis(fields, sig, sig), "duplicate_key");
  });

  it("refuses a list that starts with anything else, and a second first entry", () => {
    const { entries, world } = threeDevices();
    expectCode(() => verifyList(CONTEXT, entries.slice(1)), "bad_chain");
    expectCode(() => world.state.append(world.genesis), "bad_chain");
    expectCode(() => verifyList(CONTEXT, []), "malformed");
  });

  it("is for one gateway and one account", () => {
    const world = makeWorld();
    expectCode(() => verifyList(OTHER_GATEWAY, [world.genesis]), "wrong_gateway");
    expectCode(() => verifyList(OTHER_ACCOUNT, [world.genesis]), "wrong_account");
  });
});

describe("the chain", () => {
  it("verifies from the first entry to the same state the appender reached", () => {
    const { entries, state, mac, phone, gateway } = threeDevices();
    const verified = verifyList(CONTEXT, entries);
    expect(verified.head).toEqual(state.head);
    expect(verified.devices().map((member) => member.key.bytes)).toEqual(
      [gateway, mac, phone].map((device) => device.device.listKey.bytes),
    );
  });

  it("refuses a reordered, repeated or forked list", () => {
    const { entries, world, gateway } = threeDevices();
    expectCode(() => verifyList(CONTEXT, [entries[0]!, entries[2]!, entries[1]!]), "bad_chain");
    expectCode(() => verifyList(CONTEXT, [entries[0]!, entries[1]!, entries[1]!]), "bad_chain");
    // Two entries made on the same head: the second can't follow the first.
    const fork = signAdd(gateway.listKey, world.state, makeDevice(4).device, TRANSCRIPT);
    expectCode(() => verifyList(CONTEXT, [entries[0]!, entries[1]!, fork.entry]), "bad_chain");
  });

  it("refuses an entry for another gateway or account", () => {
    const { world, mac } = threeDevices();
    // The same members, on a list for another gateway and another account.
    for (const [context, code] of [
      [OTHER_GATEWAY, "wrong_gateway"],
      [OTHER_ACCOUNT, "wrong_account"],
    ] as const) {
      const fields = {
        context,
        connectorKey: world.connector.publicKey,
        device: world.gatewayDevice.device,
      };
      const other = assembleGenesis(
        fields,
        signGenesis(world.connector, fields),
        signGenesis(world.gatewayDevice.listKey, fields),
      );
      const foreign = signAdd(world.gatewayDevice.listKey, other.state, mac.device, TRANSCRIPT);
      expectCode(() => world.state.append(foreign.entry), code);
    }
  });

  it("refuses an entry signed by a key that was never a member", () => {
    const world = makeWorld();
    const real = signAdd(
      world.gatewayDevice.listKey,
      world.state,
      makeDevice(4).device,
      TRANSCRIPT,
    ).entry;
    expectCode(() => world.state.append(resignedBy(real, makeDevice(9).listKey)), "not_member");
  });

  it("refuses an entry signed by a removed member", () => {
    const { state, gateway, mac, phone } = threeDevices();
    const removed = signRemoval(phone.listKey, state, mac.device.listKey).state;
    const real = signAdd(gateway.listKey, removed, makeDevice(5).device, TRANSCRIPT).entry;
    expectCode(() => removed.append(resignedBy(real, mac.listKey)), "removed_member");
  });

  it("refuses the connector adding a device or putting one back", () => {
    const world = makeWorld();
    expectCode(
      () => signAdd(world.connector, world.state, makeDevice(2).device, TRANSCRIPT),
      "not_permitted",
    );
  });

  it("refuses a device whose keys the list holds or held", () => {
    const { state, gateway, mac } = threeDevices();
    expectCode(() => signAdd(gateway.listKey, state, mac.device, TRANSCRIPT), "duplicate_key");
    const removed = signRemoval(gateway.listKey, state, mac.device.listKey).state;
    expectCode(() => signAdd(gateway.listKey, removed, mac.device, TRANSCRIPT), "duplicate_key");
    // Any one key reused is enough: here only the TLS pin.
    const copy = { ...makeDevice(7).device, tlsPin: mac.device.tlsPin };
    expectCode(() => signAdd(gateway.listKey, state, copy, TRANSCRIPT), "duplicate_key");
  });
});

/** The same entry with its signer replaced by `key` and signed by it: what a holder of `key` can make. */
function resignedBy(entry: Uint8Array, key: ListSecretKey): Uint8Array {
  const body = entry.slice(0, entry.length - 64);
  body.set(key.publicKey.bytes, body.length - 32);
  return concat(body, signList(key, body));
}

describe("removing and putting back", () => {
  it("a member removes any device but the connector, itself included", () => {
    const { state, gateway, mac, phone } = threeDevices();
    const s1 = signRemoval(mac.listKey, state, gateway.device.listKey).state;
    expect(s1.member(gateway.device.listKey)).toBeUndefined();
    expect(s1.removal(gateway.device.listKey)?.origin).toBe("member");
    const s2 = signRemoval(phone.listKey, s1, phone.device.listKey).state;
    expect(s2.devices().map((member) => member.key.bytes)).toEqual([mac.device.listKey.bytes]);
    expectCode(() => signRemoval(mac.listKey, s2, s2.connectorKey), "protected_member");
    expectCode(() => signRemoval(mac.listKey, s2, phone.device.listKey), "bad_target");
  });

  it("the connector removes on the gateway's machine, its own device included", () => {
    const { state, world, gateway } = threeDevices();
    const after = signRemoval(world.connector, state, gateway.device.listKey).state;
    expect(after.member(gateway.device.listKey)).toBeUndefined();
  });

  it("the account page's removal reaches any device but the gateway's own and the connector", () => {
    const { state, world, gateway, mac } = threeDevices();
    const after = signRemovalNotice(
      world.connector,
      state,
      encodeRemovalNotice(CONTEXT, mac.device.listKey),
    ).state;
    expect(after.removal(mac.device.listKey)?.origin).toBe("account");
    expectCode(
      () =>
        signRemovalNotice(
          world.connector,
          state,
          encodeRemovalNotice(CONTEXT, gateway.device.listKey),
        ),
      "protected_member",
    );
    expectCode(
      () =>
        signRemovalNotice(
          world.connector,
          state,
          encodeRemovalNotice(CONTEXT, world.connector.publicKey),
        ),
      "protected_member",
    );
    // Only the connector writes it; a device that writes one is refused.
    expectCode(
      () =>
        signRemovalNotice(mac.listKey, state, encodeRemovalNotice(CONTEXT, gateway.device.listKey)),
      "not_permitted",
    );
    // A notice for another gateway or account.
    expectCode(
      () =>
        signRemovalNotice(
          world.connector,
          state,
          encodeRemovalNotice(OTHER_GATEWAY, mac.device.listKey),
        ),
      "wrong_gateway",
    );
  });

  it("puts back only what the account page removed, signed by a device", () => {
    const { state, world, gateway, mac, phone } = threeDevices();
    const byPage = signRemovalNotice(
      world.connector,
      state,
      encodeRemovalNotice(CONTEXT, phone.device.listKey),
    ).state;
    const back = signRestore(mac.listKey, byPage, phone.device.listKey).state;
    expect(back.member(phone.device.listKey)?.device).toEqual(phone.device);
    expect(back.member(phone.device.listKey)?.addedBy?.equals(mac.device.listKey)).toBe(true);
    expectCode(() => signRestore(world.connector, byPage, phone.device.listKey), "not_permitted");
    expectCode(() => signRestore(mac.listKey, back, phone.device.listKey), "bad_target");
    const byMember = signRemoval(gateway.listKey, state, phone.device.listKey).state;
    expectCode(() => signRestore(mac.listKey, byMember, phone.device.listKey), "bad_target");
    expectCode(() => signRestore(mac.listKey, state, makeDevice(9).device.listKey), "bad_target");
  });

  it("names what a device added, for removing it with the device", () => {
    const { state, gateway, mac, phone } = threeDevices();
    expect(state.addedBy(mac.device.listKey).map((member) => member.key.bytes)).toEqual([
      phone.device.listKey.bytes,
    ]);
    expect(state.addedBy(gateway.device.listKey).map((member) => member.key.bytes)).toEqual([
      mac.device.listKey.bytes,
    ]);
  });
});

describe("bounds", () => {
  it(`holds at most ${MAX_MEMBERS} devices`, () => {
    const world = makeWorld();
    const rng = seeded(3);
    let state = world.state;
    while (state.devices().length < MAX_MEMBERS) {
      state = signAdd(
        world.gatewayDevice.listKey,
        state,
        randomDevice(rng).device,
        TRANSCRIPT,
      ).state;
    }
    expectCode(
      () => signAdd(world.gatewayDevice.listKey, state, randomDevice(rng).device, TRANSCRIPT),
      "list_full",
    );
    // Putting a device back counts too.
    const last = state.devices().at(-1)!.key;
    const removed = signRemovalNotice(
      world.connector,
      state,
      encodeRemovalNotice(CONTEXT, last),
    ).state;
    const refilled = signAdd(
      world.gatewayDevice.listKey,
      removed,
      randomDevice(rng).device,
      TRANSCRIPT,
    ).state;
    expectCode(() => signRestore(world.gatewayDevice.listKey, refilled, last), "list_full");
  }, 60_000);

  it(`holds at most ${MAX_ENTRIES} entries`, () => {
    const world = makeWorld();
    const rng = seeded(4);
    const entries = [world.genesis];
    let state = world.state;
    while (state.length < MAX_ENTRIES) {
      const device = randomDevice(rng);
      const added = signAdd(world.gatewayDevice.listKey, state, device.device, TRANSCRIPT);
      entries.push(added.entry);
      state = added.state;
      if (state.length < MAX_ENTRIES) {
        const removed = signRemoval(world.gatewayDevice.listKey, state, device.device.listKey);
        entries.push(removed.entry);
        state = removed.state;
      }
    }
    expect(verifyList(CONTEXT, entries).length).toBe(MAX_ENTRIES);
    expectCode(
      () => signRemoval(world.gatewayDevice.listKey, state, state.devices().at(-1)!.key),
      "list_full",
    );
    expectCode(() => verifyList(CONTEXT, [...entries, entries[1]!]), "too_large");
    // The longest list fits its sealed bound.
    const secret = ListSecret.fromBytes(fill(32, 1), 0);
    expect(openList(secret, CONTEXT, sealList(secret, CONTEXT, entries, fill(24, 2)))).toHaveLength(
      MAX_ENTRIES,
    );
  }, 120_000);
});

describe("the list secret", () => {
  it("seals the list, the card and an entry so only its holder opens them, each as its own kind", () => {
    const { entries, world } = threeDevices();
    const secret = world.secret;
    const sealedList = sealList(secret, CONTEXT, entries, fill(24, 1));
    expect(openList(secret, CONTEXT, sealedList)).toEqual(entries);
    const sealedCard = sealCard(secret, CONTEXT, world.card, fill(24, 2));
    expect(openCard(secret, CONTEXT, sealedCard)).toEqual(world.card);
    const sealedEntry = sealEntry(secret, CONTEXT, entries[1]!, fill(24, 3));
    expect(openEntry(secret, CONTEXT, sealedEntry)).toEqual(entries[1]);
    expectCode(() => openList(secret, CONTEXT, sealedCard), "malformed");
    expectCode(() => openCard(secret, OTHER_GATEWAY, sealedCard), "decrypt_failed");
    expectCode(() => openCard(secret, OTHER_ACCOUNT, sealedCard), "decrypt_failed");
    expectCode(
      () => openCard(ListSecret.fromBytes(fill(32, 9), 0), CONTEXT, sealedCard),
      "decrypt_failed",
    );
  });

  it("is rotated on removal to the remaining devices, and the removed one opens nothing after", () => {
    const { state, world, gateway, mac, phone } = threeDevices();
    const removed = signRemoval(gateway.listKey, state, phone.device.listKey).state;
    const next = ListSecret.fromBytes(fill(32, 0xe1), 1);
    const rotation = rotateListSecret(
      world.connector,
      removed,
      next,
      seeded(5).bytes(32 * removed.devices().length),
    );

    for (const device of [gateway, mac]) {
      const opened = openRotation(
        { listKey: device.device.listKey, sealKey: device.sealKey },
        removed,
        rotation,
        world.secret,
      );
      expect(opened.epoch).toBe(1);
      const sealed = sealCard(next, CONTEXT, world.card, fill(24, 4));
      expect(openCard(opened, CONTEXT, sealed)).toEqual(world.card);
    }
    // The removed phone has no share, and its old secret opens nothing sealed under the new one.
    expectCode(
      () =>
        openRotation(
          { listKey: phone.device.listKey, sealKey: phone.sealKey },
          state,
          rotation,
          world.secret,
        ),
      "not_member",
    );
    const sealedAfter = sealList(next, CONTEXT, [world.genesis], fill(24, 5));
    expectCode(() => openList(world.secret, CONTEXT, sealedAfter), "decrypt_failed");
    // Even holding the old secret with the new epoch's number, it can't open it.
    expectCode(
      () => openList(ListSecret.fromBytes(fill(32, 0xe0), 1), CONTEXT, sealedAfter),
      "decrypt_failed",
    );
    // Using the phone's seal key on another device's share fails too.
    expectCode(
      () =>
        openRotation(
          { listKey: mac.device.listKey, sealKey: phone.sealKey },
          removed,
          rotation,
          world.secret,
        ),
      "decrypt_failed",
    );
  });

  it("takes a rotation only from the connector, for this list, newer than the secret held", () => {
    const { state, world, mac } = threeDevices();
    const next = ListSecret.fromBytes(fill(32, 0xe1), 1);
    const random = fill(32 * state.devices().length, 6);
    const rotation = rotateListSecret(world.connector, state, next, random);
    const me = { listKey: mac.device.listKey, sealKey: mac.sealKey };
    expectCode(() => rotateListSecret(mac.listKey, state, next, random), "not_permitted");
    expectCode(() => openRotation(me, state, rotation, next), "stale_secret");
    const tampered = rotation.slice();
    tampered[tampered.length - 1]! ^= 1;
    expectCode(() => openRotation(me, state, tampered, world.secret), "bad_signature");
    expectCode(() => rotateListSecret(world.connector, state, next, fill(32, 1)), "bad_argument");
  });
});

describe("a join on a list", () => {
  it("adds through the join and appears on the connector's list", () => {
    const world = makeWorld();
    const { entry } = addDevice(memberOf(world, world.gatewayDevice.listKey), makeDevice(2));
    expect(world.state.append(entry).devices()).toHaveLength(2);
  });
});
