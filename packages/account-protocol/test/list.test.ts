// The device list: who is a member after each entry, every refusal, the list secret's sealing
// and rotation, and a removed member's blindness after it.

import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it, vi } from "vitest";
import {
  assembleGenesis,
  encodeRemovalNotice,
  GatewayDeviceKey,
  GROWTH_LIMIT,
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
  signCard,
  signGenesis,
  signRemoval,
  signRemovalNotice,
  signRemovalOnGatewayMachine,
  signRestore,
  type DeviceRecord,
  type JoiningDevice,
  type ListState,
} from "../src/index.ts";
import { concat } from "../src/bytes.ts";
import { signList } from "../src/keys.ts";
import { encodeList, signAdd } from "../src/list.ts";
import {
  chain,
  addDevice,
  appended,
  CONTEXT,
  expectCode,
  fill,
  makeDevice,
  makeWorld,
  OTHER_ACCOUNT,
  OTHER_GATEWAY,
  seeded,
  type Held,
  headObject,
  headOf,
} from "./helpers.ts";

// Signatures and key checks are quick alone; on a loaded machine a test can take seconds.
vi.setConfig({ testTimeout: 120_000 });

const TRANSCRIPT = fill(32, 0x5a);
const RANDOM = fill(32, 0x6a);

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

/** `state` after `entry`. */
const after = (state: ListState, entry: Uint8Array) => state.append(entry);

/** The gateway's device (1), a Mac (2) added by it, and a phone (3) added by the Mac. */
function threeDevices() {
  const world = makeWorld();
  const gateway = world.gatewayDevice;
  const mac = makeDevice(2);
  const phone = makeDevice(3, "iPhone", "ios");
  let held: Held = world;
  held = appended(held, signAdd(gateway.listKey, held.state, mac.device, TRANSCRIPT));
  held = appended(held, signAdd(mac.listKey, held.state, phone.device, TRANSCRIPT));
  return { world, gateway, mac, phone, entries: [...held.entries], state: held.state };
}

/** The same entry with its signer replaced by `key` and signed by it: what a holder of `key` can make. */
function resignedBy(entry: Uint8Array, key: ListSecretKey): Uint8Array {
  const body = entry.slice(0, entry.length - 64);
  body.set(key.publicKey.bytes, body.length - 32);
  return concat(body, signList(key, body));
}

describe("the first entry", () => {
  it("makes the connector and the gateway's device the first members", () => {
    const world = makeWorld();
    expect(world.state.members().map((member) => member.role)).toEqual([
      "connector",
      "gateway-device",
    ]);
    expect(world.state.length).toBe(1);
    expect(chain(CONTEXT, [world.genesis]).head).toEqual(world.state.head);
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

  it("refuses one key in two roles, the connector's included", () => {
    const connector = ListSecretKey.fromSeed(fill(32, 0xc0));
    const device = makeDevice(1);
    const sign = (record: DeviceRecord, key = connector) => {
      const fields = { context: CONTEXT, connectorKey: key.publicKey, device: record };
      return () =>
        assembleGenesis(fields, signGenesis(key, fields), signGenesis(device.listKey, fields));
    };
    // The connector's key as the device's list key.
    const same = ListSecretKey.fromSeed(fill(32, 1));
    expectCode(sign(device.device, same), "duplicate_key");
    // The connector's key as the device's OpenClaw key.
    expectCode(
      sign({
        ...device.device,
        gatewayDeviceKey: GatewayDeviceKey.fromBytes(connector.publicKey.bytes),
      }),
      "duplicate_key",
    );
    // The device's own list key as its OpenClaw key.
    expectCode(
      sign({
        ...device.device,
        gatewayDeviceKey: GatewayDeviceKey.fromBytes(device.listKey.publicKey.bytes),
      }),
      "duplicate_key",
    );
  });

  it("refuses a list that starts with anything else, and a second first entry", () => {
    const { entries, world } = threeDevices();
    expectCode(() => chain(CONTEXT, entries.slice(1)), "bad_chain");
    expectCode(() => world.state.append(world.genesis), "bad_chain");
    expectCode(() => chain(CONTEXT, []), "malformed");
  });

  it("is for one gateway and one account", () => {
    const world = makeWorld();
    expectCode(() => chain(OTHER_GATEWAY, [world.genesis]), "wrong_gateway");
    expectCode(() => chain(OTHER_ACCOUNT, [world.genesis]), "wrong_account");
  });
});

describe("the chain", () => {
  it("verifies from the first entry to the same state the appender reached", () => {
    const { entries, state, mac, phone, gateway } = threeDevices();
    const verified = chain(CONTEXT, entries);
    expect(verified.head).toEqual(state.head);
    expect(verified.devices().map((member) => member.key.bytes)).toEqual(
      [gateway, mac, phone].map((device) => device.device.listKey.bytes),
    );
  });

  it("refuses a reordered, repeated or forked list", () => {
    const { entries, world, gateway } = threeDevices();
    expectCode(() => chain(CONTEXT, [entries[0]!, entries[2]!, entries[1]!]), "bad_chain");
    expectCode(() => chain(CONTEXT, [entries[0]!, entries[1]!, entries[1]!]), "bad_chain");
    const fork = signAdd(gateway.listKey, world.state, makeDevice(4).device, TRANSCRIPT);
    expectCode(() => chain(CONTEXT, [entries[0]!, entries[1]!, fork]), "bad_chain");
  });

  it("refuses an entry for another gateway or account", () => {
    const { world, mac } = threeDevices();
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
      expectCode(() => world.state.append(foreign), code);
    }
  });

  it("refuses an entry signed by a key that was never a member, or by a removed member", () => {
    const world = makeWorld();
    const real = signAdd(
      world.gatewayDevice.listKey,
      world.state,
      makeDevice(4).device,
      TRANSCRIPT,
    );
    expectCode(() => world.state.append(resignedBy(real, makeDevice(9).listKey)), "not_member");
    const { state, gateway, mac, phone } = threeDevices();
    const removed = after(state, signRemoval(phone.listKey, state, mac.device.listKey));
    const next = signAdd(gateway.listKey, removed, makeDevice(5).device, TRANSCRIPT);
    expectCode(() => removed.append(resignedBy(next, mac.listKey)), "removed_member");
  });

  it("refuses the connector adding a device", () => {
    const world = makeWorld();
    expectCode(
      () => signAdd(world.connector, world.state, makeDevice(2).device, TRANSCRIPT),
      "not_permitted",
    );
  });

  it("refuses a record any of whose keys the list holds or held, in any role", () => {
    const { state, world, gateway, mac } = threeDevices();
    expectCode(() => signAdd(gateway.listKey, state, mac.device, TRANSCRIPT), "duplicate_key");
    const removed = after(state, signRemoval(gateway.listKey, state, mac.device.listKey));
    expectCode(() => signAdd(gateway.listKey, removed, mac.device, TRANSCRIPT), "duplicate_key");
    const fresh = makeDevice(7).device;
    const withKey = (key: Uint8Array) => ({
      ...fresh,
      gatewayDeviceKey: GatewayDeviceKey.fromBytes(key),
    });
    for (const record of [
      { ...fresh, tlsPin: mac.device.tlsPin },
      withKey(mac.device.listKey.bytes), // a member's list key as its OpenClaw key
      withKey(world.connector.publicKey.bytes), // the connector's key as its OpenClaw key
      withKey(fresh.listKey.bytes), // its own list key as its OpenClaw key
      withKey(mac.device.gatewayDeviceKey.bytes),
    ]) {
      expectCode(() => signAdd(gateway.listKey, state, record, TRANSCRIPT), "duplicate_key");
    }
  });
});

describe("removing and putting back", () => {
  it("a device member removes any device but the connector and the gateway's own, itself included", () => {
    const { state, gateway, mac, phone } = threeDevices();
    const s1 = after(state, signRemoval(mac.listKey, state, phone.device.listKey));
    expect(s1.member(phone.device.listKey)).toBeUndefined();
    expect(s1.removal(phone.device.listKey)?.origin).toBe("member");
    const s2 = after(s1, signRemoval(mac.listKey, s1, mac.device.listKey));
    expect(s2.devices().map((member) => member.key.bytes)).toEqual([gateway.device.listKey.bytes]);
    expectCode(() => signRemoval(gateway.listKey, s2, s2.connectorKey), "protected_member");
    expectCode(() => signRemoval(gateway.listKey, s2, phone.device.listKey), "bad_target");
  });

  it("the gateway machine's own device is removed only by itself or the connector", () => {
    const { state, world, gateway, mac } = threeDevices();
    // A stolen member can't remove it, so it can't leave the list with nobody to confirm a device.
    expectCode(() => signRemoval(mac.listKey, state, gateway.device.listKey), "protected_member");
    expect(
      after(state, signRemoval(gateway.listKey, state, gateway.device.listKey)).member(
        gateway.device.listKey,
      ),
    ).toBeUndefined();
    expect(
      after(
        state,
        signRemovalOnGatewayMachine(world.connector, state, gateway.device.listKey),
      ).member(gateway.device.listKey),
    ).toBeUndefined();
  });

  it("the connector removes only through its own function for its own machine", () => {
    const { state, world, gateway } = threeDevices();
    expectCode(() => signRemoval(world.connector, state, gateway.device.listKey), "not_permitted");
    const removed = after(
      state,
      signRemovalOnGatewayMachine(world.connector, state, gateway.device.listKey),
    );
    expect(removed.member(gateway.device.listKey)).toBeUndefined();
    expectCode(
      () => signRemovalOnGatewayMachine(gateway.listKey, state, gateway.device.listKey),
      "not_permitted",
    );
  });

  it("the account page's removal reaches any device but the gateway's own and the connector", () => {
    const { state, world, gateway, mac } = threeDevices();
    const removed = after(
      state,
      signRemovalNotice(world.connector, state, encodeRemovalNotice(CONTEXT, mac.device.listKey)),
    );
    expect(removed.removal(mac.device.listKey)?.origin).toBe("account");
    for (const target of [gateway.device.listKey, world.connector.publicKey]) {
      expectCode(
        () => signRemovalNotice(world.connector, state, encodeRemovalNotice(CONTEXT, target)),
        "protected_member",
      );
    }
    expectCode(
      () =>
        signRemovalNotice(mac.listKey, state, encodeRemovalNotice(CONTEXT, gateway.device.listKey)),
      "not_permitted",
    );
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
    const byPage = after(
      state,
      signRemovalNotice(world.connector, state, encodeRemovalNotice(CONTEXT, phone.device.listKey)),
    );
    const back = after(byPage, signRestore(mac.listKey, byPage, phone.device.listKey));
    expect(back.member(phone.device.listKey)?.device).toEqual(phone.device);
    expect(back.member(phone.device.listKey)?.addedBy?.equals(mac.device.listKey)).toBe(true);
    expectCode(() => signRestore(world.connector, byPage, phone.device.listKey), "not_permitted");
    expectCode(() => signRestore(mac.listKey, back, phone.device.listKey), "bad_target");
    const byMember = after(state, signRemoval(gateway.listKey, state, phone.device.listKey));
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

describe("what a caller is given", () => {
  it("is its own frozen copy: changing it doesn't change the state", () => {
    const { state, mac } = threeDevices();
    const before = Buffer.from(state.member(mac.device.listKey)!.device!.tlsPin).toString("hex");
    state.member(mac.device.listKey)!.device!.tlsPin.fill(0);
    state.devices()[1]!.device!.tlsPin.fill(0);
    state.members()[2]!.device!.tlsPin.fill(0);
    state.head.fill(0);
    state.context.gatewayId.fill(0);
    expect(Buffer.from(state.member(mac.device.listKey)!.device!.tlsPin).toString("hex")).toBe(
      before,
    );
    expect(state.head).not.toEqual(fill(32, 0));
    expect(state.context.gatewayId).toEqual(CONTEXT.gatewayId);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.member(mac.device.listKey))).toBe(true);
    // A removal's record too.
    const removed = after(state, signRemoval(mac.listKey, state, mac.device.listKey));
    removed.removal(mac.device.listKey)!.member.device!.tlsPin.fill(0);
    expect(
      Buffer.from(removed.removal(mac.device.listKey)!.member.device!.tlsPin).toString("hex"),
    ).toBe(before);
  });

  it("an entry is copied once on entry: bytes that change while append reads them can't split what it checks from what it keeps", () => {
    // A view whose bytes change the first time the package takes a slice of it, as another
    // thread writing to shared memory could. Read once, as a copy, it is the honest entry.
    const world = makeWorld();
    const entry = signAdd(
      world.gatewayDevice.listKey,
      world.state,
      makeDevice(2).device,
      TRANSCRIPT,
    );
    class Shifting extends Uint8Array {
      #changed = false;
      override subarray(begin?: number, end?: number): Uint8Array<ArrayBuffer> {
        if (!this.#changed) {
          this.#changed = true;
          this[this.length - 1]! ^= 1;
        }
        return super.subarray(begin, end);
      }
    }
    const shifting = new Shifting(entry.length);
    shifting.set(entry);
    expect(world.state.append(shifting).head).toEqual(world.state.append(entry).head);
  });

  it("an entry appended is copied first: changing the caller's bytes afterwards changes nothing", () => {
    const world = makeWorld();
    const entry = signAdd(
      world.gatewayDevice.listKey,
      world.state,
      makeDevice(2).device,
      TRANSCRIPT,
    );
    const state = world.state.append(entry);
    const head = state.head;
    entry.fill(0);
    expect(state.head).toEqual(head);
  });
});

describe("bounds", () => {
  it(`holds at most ${MAX_MEMBERS} devices`, () => {
    const world = makeWorld();
    const rng = seeded(3);
    let state = world.state;
    while (state.devices().length < MAX_MEMBERS) {
      state = after(
        state,
        signAdd(world.gatewayDevice.listKey, state, randomDevice(rng).device, TRANSCRIPT),
      );
    }
    expectCode(
      () => signAdd(world.gatewayDevice.listKey, state, randomDevice(rng).device, TRANSCRIPT),
      "list_full",
    );
    const last = state.devices().at(-1)!.key;
    const removed = after(
      state,
      signRemovalNotice(world.connector, state, encodeRemovalNotice(CONTEXT, last)),
    );
    const refilled = after(
      removed,
      signAdd(world.gatewayDevice.listKey, removed, randomDevice(rng).device, TRANSCRIPT),
    );
    expectCode(() => signRestore(world.gatewayDevice.listKey, refilled, last), "list_full");
  });

  it(`stops growing at ${GROWTH_LIMIT} entries but never refuses a removal`, () => {
    // A stolen member T fills the list with devices it makes up, removing each one, until the
    // list can grow no more. The person can still remove T, from a member and from the page.
    const world = makeWorld();
    const gateway = world.gatewayDevice;
    const rng = seeded(4);
    const thief = randomDevice(rng);
    let held: Held = appended(
      world,
      signAdd(gateway.listKey, world.state, thief.device, TRANSCRIPT),
    );
    while (held.state.length < GROWTH_LIMIT) {
      const made = randomDevice(rng);
      held = appended(held, signAdd(thief.listKey, held.state, made.device, TRANSCRIPT));
      if (held.state.length < GROWTH_LIMIT) {
        held = appended(held, signRemoval(thief.listKey, held.state, made.device.listKey));
      }
    }
    expect(held.state.member(thief.device.listKey)).toBeDefined();
    expectCode(
      () => signAdd(gateway.listKey, held.state, randomDevice(rng).device, TRANSCRIPT),
      "list_full",
    );
    // From a member:
    const byMember = after(
      held.state,
      signRemoval(gateway.listKey, held.state, thief.device.listKey),
    );
    expect(byMember.member(thief.device.listKey)).toBeUndefined();
    // From the account page:
    const notice = encodeRemovalNotice(CONTEXT, thief.device.listKey);
    const byPage = after(held.state, signRemovalNotice(world.connector, held.state, notice));
    expect(byPage.member(thief.device.listKey)).toBeUndefined();
    // Every device can be removed past the growth limit, up to MAX_ENTRIES.
    let state = byMember;
    for (const member of state.devices()) {
      state = after(state, signRemovalOnGatewayMachine(world.connector, state, member.key));
    }
    expect(state.length).toBeLessThanOrEqual(MAX_ENTRIES);
    expect(chain(CONTEXT, [...held.entries]).length).toBe(GROWTH_LIMIT);
  });
});

describe("sealing with the list secret", () => {
  it("opens only in verified forms: a list as its state, a card checked, an entry appended", () => {
    const { entries, world, state } = threeDevices();
    const secret = world.secret;
    expect(
      openList(
        secret,
        CONTEXT,
        sealList(secret, CONTEXT, entries, RANDOM, headObject(world)),
        headOf(world, { state, entries }),
      ).state.head,
    ).toEqual(state.head);
    const card = openCard(
      secret,
      state,
      sealCard(secret, CONTEXT, world.card, RANDOM, headObject(world)),
      headObject(world),
    );
    expect(card.name).toBe("Windows PC");
    const opened = openEntry(
      secret,
      world.state,
      sealEntry(secret, CONTEXT, entries[1]!, RANDOM, headObject(world)),
    );
    expect(opened.state.length).toBe(2);
    const sealedCard = sealCard(secret, CONTEXT, world.card, RANDOM, headObject(world));
    expectCode(() => openList(secret, CONTEXT, sealedCard, headOf(world)), "malformed");
    expectCode(
      () =>
        openList(
          ListSecret.fromBytes(fill(32, 9), 0),
          CONTEXT,
          sealList(secret, CONTEXT, entries, RANDOM, headObject(world)),
          headOf(world),
        ),
      "decrypt_failed",
    );
  });

  it("refuses a sealed list whose entries don't verify, and a card another key signed", () => {
    const { world, mac, state } = threeDevices();
    const secret = world.secret;
    const forged = signAdd(mac.listKey, state, makeDevice(8).device, TRANSCRIPT);
    expectCode(
      () =>
        openList(
          secret,
          CONTEXT,
          sealList(secret, CONTEXT, [world.genesis, forged], RANDOM, headObject(world)),
          headOf(world),
        ),
      "bad_chain",
    );
    // A card a member signed with its own key, naming itself as the connector.
    const selfSigned = signCard(mac.listKey, {
      gatewayId: CONTEXT.gatewayId,
      serial: 9,
      tlsPin: fill(32, 1),
      addresses: [{ host: "evil.example", port: 443 }],
      name: "Gateway",
    });
    expectCode(
      () =>
        openCard(
          secret,
          state,
          sealCard(secret, CONTEXT, selfSigned, RANDOM, headObject(world)),
          headObject(world),
        ),
      "card_mismatch",
    );
  });

  it("a repeated random reveals at most that two plaintexts were equal: the nonce is synthetic", () => {
    const { entries, world } = threeDevices();
    const secret = world.secret;
    const list = sealList(secret, CONTEXT, entries, RANDOM, headObject(world));
    const card = sealCard(secret, CONTEXT, world.card, RANDOM, headObject(world));
    // Different plaintexts under one random: different nonces, so no shared keystream.
    expect(list.subarray(6, 30)).not.toEqual(card.subarray(6, 30));
    const plainList = encodeList(entries);
    const n = Math.min(list.length, card.length) - 46;
    let same = true;
    for (let i = 0; i < n; i++) {
      if ((list[30 + i]! ^ card[30 + i]!) !== (plainList[i]! ^ world.card[i]!)) same = false;
    }
    expect(same).toBe(false);
    // The same plaintext under the same random: the same bytes.
    expect(sealCard(secret, CONTEXT, world.card, RANDOM, headObject(world))).toEqual(card);
  });

  it("the explicit epoch check and the associated data each catch what the other doesn't", () => {
    const world = makeWorld();
    const bytes = fill(32, 0xe0);
    // The same secret bytes under another epoch: the associated data matches the header it was
    // sealed with, so only the explicit check refuses it.
    const sealed = sealCard(
      ListSecret.fromBytes(bytes, 1),
      CONTEXT,
      world.card,
      RANDOM,
      headObject(world),
    );
    expectCode(
      () => openCard(ListSecret.fromBytes(bytes, 0), world.state, sealed, headObject(world)),
      "decrypt_failed",
    );
    // A card relabelled as an entry: the kind check passes for the entry it now claims to be, and
    // only the associated data, which covers the kind, refuses it.
    const relabelled = sealed.slice();
    relabelled[1] = 3;
    const holder = ListSecret.fromBytes(bytes, 1);
    expectCode(() => openEntry(holder, world.state, relabelled), "decrypt_failed");
  });
});

describe("the list secret's rotation", () => {
  it("is sealed to the remaining devices, and the removed one opens nothing after", () => {
    const { state, world, gateway, mac, phone } = threeDevices();
    const removed = after(state, signRemoval(gateway.listKey, state, phone.device.listKey));
    const next = ListSecret.fromBytes(fill(32, 0xe1), 1);
    const rotation = rotateListSecret(world.connector, removed, world.secret, next, RANDOM);
    for (const device of [gateway, mac]) {
      const opened = openRotation(
        { listKey: device.device.listKey, sealKey: device.sealKey },
        removed,
        rotation,
        world.secret,
      );
      expect(opened.epoch).toBe(1);
      expect(
        openCard(
          opened,
          removed,
          sealCard(next, CONTEXT, world.card, RANDOM, headObject(world)),
          headObject(world),
        ).serial,
      ).toBe(1);
    }
    expectCode(
      () =>
        openRotation(
          { listKey: phone.device.listKey, sealKey: phone.sealKey },
          removed,
          rotation,
          world.secret,
        ),
      "not_member",
    );
    const sealedAfter = sealList(next, CONTEXT, [world.genesis], RANDOM, headObject(world));
    expectCode(() => openList(world.secret, CONTEXT, sealedAfter, headOf(world)), "decrypt_failed");
    expectCode(
      () => openList(ListSecret.fromBytes(fill(32, 0xe0), 1), CONTEXT, sealedAfter, headOf(world)),
      "decrypt_failed",
    );
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

  it("refuses a new secret with the held bytes or an epoch that isn't higher", () => {
    const { state, world, mac } = threeDevices();
    const sameBytes = ListSecret.fromBytes(fill(32, 0xe0), 1);
    expectCode(
      () => rotateListSecret(world.connector, state, world.secret, sameBytes, RANDOM),
      "stale_secret",
    );
    const lower = ListSecret.fromBytes(fill(32, 0xe1), 0);
    expectCode(
      () => rotateListSecret(world.connector, state, world.secret, lower, RANDOM),
      "stale_secret",
    );
    // A member refuses a rotation whose share is the secret it holds, under a higher epoch.
    const held = ListSecret.fromBytes(fill(32, 0xe1), 1);
    const rotation = rotateListSecret(
      world.connector,
      state,
      ListSecret.fromBytes(fill(32, 0xe2), 0),
      ListSecret.fromBytes(fill(32, 0xe1), 2),
      RANDOM,
    );
    expectCode(
      () =>
        openRotation({ listKey: mac.device.listKey, sealKey: mac.sealKey }, state, rotation, held),
      "stale_secret",
    );
  });

  it("takes a rotation only from the connector, for this list, newer than the secret held", () => {
    const { state, world, mac } = threeDevices();
    const next = ListSecret.fromBytes(fill(32, 0xe1), 1);
    const rotation = rotateListSecret(world.connector, state, world.secret, next, RANDOM);
    const me = { listKey: mac.device.listKey, sealKey: mac.sealKey };
    expectCode(
      () => rotateListSecret(mac.listKey, state, world.secret, next, RANDOM),
      "not_permitted",
    );
    expectCode(() => openRotation(me, state, rotation, next), "stale_secret");
    const tampered = rotation.slice();
    tampered[tampered.length - 1]! ^= 1;
    expectCode(() => openRotation(me, state, tampered, world.secret), "bad_signature");
    expectCode(
      () => rotateListSecret(world.connector, state, world.secret, next, fill(16, 1)),
      "bad_argument",
    );
    // A rotation the same connector signed for another account's list: refused for its context.
    const fields = {
      context: OTHER_ACCOUNT,
      connectorKey: world.connector.publicKey,
      device: world.gatewayDevice.device,
    };
    const other = assembleGenesis(
      fields,
      signGenesis(world.connector, fields),
      signGenesis(world.gatewayDevice.listKey, fields),
    );
    const withMac = after(
      other.state,
      signAdd(world.gatewayDevice.listKey, other.state, mac.device, TRANSCRIPT),
    );
    const foreign = rotateListSecret(world.connector, withMac, world.secret, next, RANDOM);
    expectCode(() => openRotation(me, state, foreign, world.secret), "wrong_account");
  });

  it("hedges each share's ephemeral: a constant random gives different shares each rotation", () => {
    const { state, world } = threeDevices();
    const zero = new Uint8Array(32);
    const one = rotateListSecret(
      world.connector,
      state,
      world.secret,
      ListSecret.fromBytes(fill(32, 0xe1), 1),
      zero,
    );
    const two = rotateListSecret(
      world.connector,
      state,
      world.secret,
      ListSecret.fromBytes(fill(32, 0xe1), 2),
      zero,
    );
    const enc = (rotation: Uint8Array) =>
      rotation.subarray(33 + 32 + 4 + 1 + 32, 33 + 32 + 4 + 1 + 64);
    expect(enc(one)).not.toEqual(enc(two));
  });

  it("has nothing to rotate to when no device is left", () => {
    const { state, world, gateway, mac, phone } = threeDevices();
    let empty = state;
    for (const device of [gateway, mac, phone]) {
      empty = after(
        empty,
        signRemovalOnGatewayMachine(world.connector, empty, device.device.listKey),
      );
    }
    expectCode(
      () =>
        rotateListSecret(
          world.connector,
          empty,
          world.secret,
          ListSecret.fromBytes(fill(32, 9), 1),
          RANDOM,
        ),
      "bad_target",
    );
  });

  it("can't have its epoch changed by a caller", () => {
    const held = ListSecret.fromBytes(fill(32, 1), 5);
    expect(() => {
      (held as unknown as { epoch: number }).epoch = -1;
    }).toThrow(TypeError);
    expect(held.epoch).toBe(5);
    expect(Object.isFrozen(held)).toBe(true);
  });
});

describe("a join on a list", () => {
  it("adds through the join and appears on the connector's list", () => {
    const world = makeWorld();
    const { entry } = addDevice(world, world.gatewayDevice.listKey, makeDevice(2));
    expect(world.state.append(entry).devices()).toHaveLength(2);
  });
});
