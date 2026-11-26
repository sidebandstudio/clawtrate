// The list secret (design §4.2.1): derived inside the package, rotated only after a removal or
// a restore, taken by a device that is behind with one call that checks everything, and its
// first message. And refusals naming a head that was current within the hour (§4.5).

import { describe, expect, it, vi } from "vitest";
import {
  catchUp,
  encodeRemovalNotice,
  ListSecret,
  ListSecretKey,
  NewDeviceJoin,
  openFirstSecret,
  openList,
  refuseJoin,
  rotateListSecret,
  sealFirstSecret,
  sealList,
  signRelink,
  assembleRelink,
  signRemoval,
  signRemovalNotice,
  signRestore,
  verifyRefusal,
  type HeldList,
} from "../src/index.ts";
import { deriveSealKeyPair } from "../src/hpke.ts";
import { confirmationEphemeral } from "../src/join.ts";
import { entryHash, signAdd } from "../src/list.ts";
import { shareEphemeral } from "../src/seal.ts";
import { commitmentOf, forgeRefusal, forgeRotation } from "./forge.ts";
import {
  appended,
  CLOCK,
  CONTEXT,
  expectCode,
  fill,
  headObject,
  headOf,
  LIST_RANDOM,
  makeDevice,
  makeWorld,
  N_RANDOM,
  NOW,
  OTHER_ACCOUNT,
  holding,
  rotated,
  type Held,
  type World,
  fresh,
} from "./helpers.ts";

// Signatures and key checks are quick alone; on a loaded machine a test can take seconds.
vi.setConfig({ testTimeout: 120_000 });

const TRANSCRIPT = fill(32, 0x5a);
const ZERO = new Uint8Array(32);

/** The gateway's device, a Mac it added, a phone the Mac added. */
function grown() {
  const world = makeWorld();
  const mac = makeDevice(2);
  const phone = makeDevice(3, "iPhone", "ios");
  const one = appended(
    world,
    signAdd(world.gatewayDevice.listKey, world.state, mac.device, TRANSCRIPT),
  );
  const two = appended(one, signAdd(mac.listKey, one.state, phone.device, TRANSCRIPT));
  return { world, mac, phone, two };
}

const me = (device: ReturnType<typeof makeDevice>) => ({
  listKey: device.device.listKey,
  sealKey: device.sealKey,
});

describe("every list secret is derived", () => {
  it("from the connector's key: the same random gives another secret at every point and epoch, and never the random", () => {
    const { world, mac, phone, two } = grown();
    // The reviewer's case, turned round: the connector's caller hands the same buffer to every
    // rotation. Each secret is still new, and none is the buffer.
    const removedPhone = appended(two, signRemoval(mac.listKey, two.state, phone.device.listKey));
    const first = rotateListSecret(world.connector, removedPhone.state, world.secret, ZERO);
    const removedMac = appended(
      removedPhone,
      signRemoval(mac.listKey, removedPhone.state, mac.device.listKey),
    );
    const second = rotateListSecret(world.connector, removedMac.state, first.secret, ZERO);
    const bytes = [world.secret, first.secret, second.secret].map(
      (s) => s.exportForStorage().bytes,
    );
    expect(new Set(bytes.map((b) => Buffer.from(b).toString("hex"))).size).toBe(3);
    for (const b of bytes) expect(b).not.toEqual(ZERO);
    // The phone, removed first, kept epoch 0's bytes: they open nothing sealed at epoch 2.
    const sealed = sealList(
      second.secret,
      CONTEXT,
      removedMac.entries,
      LIST_RANDOM,
      headObject(world, removedMac, second.secret),
    );
    const asEpoch2 = ListSecret.restoreStored(world.secret.exportForStorage().bytes, 2);
    expectCode(
      () => openList(asEpoch2, CONTEXT, sealed, headOf(world, removedMac, second.secret), null),
      "decrypt_failed",
    );
  });

  it("so another connector's key, with the same random at the same point, gives another secret", () => {
    const { world, mac, phone, two } = grown();
    const removed = appended(two, signRemoval(mac.listKey, two.state, phone.device.listKey));
    const ours = rotateListSecret(
      world.connector,
      removed.state,
      world.secret,
      ZERO,
    ).secret.exportForStorage().bytes;
    const other = makeWorld({ connector: fill(32, 0xc1) });
    // A list with the other connector, same devices and entries, at the same point.
    const otherTwo = appended(
      appended(other, signAdd(other.gatewayDevice.listKey, other.state, mac.device, TRANSCRIPT)),
      signAdd(
        mac.listKey,
        appended(other, signAdd(other.gatewayDevice.listKey, other.state, mac.device, TRANSCRIPT))
          .state,
        phone.device,
        TRANSCRIPT,
      ),
    );
    const otherRemoved = appended(
      otherTwo,
      signRemoval(mac.listKey, otherTwo.state, phone.device.listKey),
    );
    const theirs = rotateListSecret(
      other.connector,
      otherRemoved.state,
      other.secret,
      ZERO,
    ).secret.exportForStorage().bytes;
    expect(theirs).not.toEqual(ours);
  });

  it("is stored and read back by its holder only through the functions named for that", () => {
    const stored = ListSecret.restoreStored(fill(32, 0x41), 7).exportForStorage();
    expect(stored.epoch).toBe(7);
    expect(ListSecret.restoreStored(stored.bytes, stored.epoch).exportForStorage().bytes).toEqual(
      fill(32, 0x41),
    );
  });
});

describe("a rotation", () => {
  it("follows exactly a removal or a restore, and is refused from any other state", () => {
    const { world, mac, phone, two } = grown();
    expectCode(
      () => rotateListSecret(world.connector, two.state, world.secret, ZERO),
      "bad_target",
    );
    const removed = appended(two, signRemoval(mac.listKey, two.state, phone.device.listKey));
    expect(rotateListSecret(world.connector, removed.state, world.secret, ZERO).secret.epoch).toBe(
      1,
    );
    const byPage = appended(
      two,
      signRemovalNotice(
        world.connector,
        two.state,
        encodeRemovalNotice(CONTEXT, phone.device.listKey),
      ),
    );
    const back = appended(byPage, signRestore(mac.listKey, byPage.state, phone.device.listKey));
    expect(rotateListSecret(world.connector, back.state, world.secret, ZERO).secret.epoch).toBe(1);
  });

  it("hedges each share's ephemeral with the connector's key and the secret it seals", () => {
    const world = makeWorld();
    const info = fill(40, 1);
    const a = shareEphemeral(world.connector, ZERO, info, fill(32, 2));
    const b = shareEphemeral(world.connector, ZERO, info, fill(32, 3));
    expect(a).not.toEqual(b);
    expect(a).not.toEqual(ZERO);
    // The service, guessing a constant random, can't recompute the ephemeral of a real share.
    const { world: w, mac, phone, two } = grown();
    const removed = appended(two, signRemoval(mac.listKey, two.state, phone.device.listKey));
    const { rotation } = rotateListSecret(w.connector, removed.state, w.secret, ZERO);
    const enc = rotation.subarray(
      33 + 32 + 4 + 4 + 32 + 4 + 1 + 32,
      33 + 32 + 4 + 4 + 32 + 4 + 1 + 64,
    );
    expect(enc).not.toEqual(deriveSealKeyPair(ZERO).publicKey);
  });

  it("the confirmation's hedge covers the payload it seals too", () => {
    const world = makeWorld();
    const info = fill(40, 1);
    const key = world.gatewayDevice.listKey;
    expect(confirmationEphemeral(key, ZERO, info, fill(80, 2))).not.toEqual(
      confirmationEphemeral(key, ZERO, info, fill(80, 3)),
    );
  });
});

describe("catching up", () => {
  it("a device one change behind takes the rotation, the list and the head in one call", () => {
    // The reviewer's case, turned round: the Mac was offline while the phone was removed.
    const { world, mac, phone, two } = grown();
    const removed = appended(
      two,
      signRemoval(world.gatewayDevice.listKey, two.state, phone.device.listKey),
    );
    const { secret, newest } = rotated(world, removed, world.secret);
    const caught = catchUp(me(mac), holding(world, two), newest);
    expect(caught.secret.epoch).toBe(1);
    expect(caught.secret.exportForStorage().bytes).toEqual(secret.exportForStorage().bytes);
    expect(caught.state.member(phone.device.listKey)).toBeUndefined();
    expect(caught.head.count).toBe(removed.state.length);
  });

  it("several changes behind, it needs only the newest rotation naming it", () => {
    const { world, mac, phone, two } = grown();
    const r1 = appended(
      two,
      signRemoval(world.gatewayDevice.listKey, two.state, phone.device.listKey),
    );
    const first = rotated(world, r1, world.secret);
    const laptop = makeDevice(4);
    const added = appended(
      r1,
      signAdd(world.gatewayDevice.listKey, r1.state, laptop.device, TRANSCRIPT),
    );
    const r2 = appended(
      added,
      signRemoval(world.gatewayDevice.listKey, added.state, laptop.device.listKey),
    );
    const second = rotated(world, r2, first.secret);
    // A list that moved on past the rotation (another add) is fine: the position is on it.
    const later = appended(
      r2,
      signAdd(world.gatewayDevice.listKey, r2.state, makeDevice(5).device, TRANSCRIPT),
    );
    const newest = {
      rotation: second.newest.rotation,
      list: sealList(
        second.secret,
        CONTEXT,
        later.entries,
        LIST_RANDOM,
        headObject(world, later, second.secret),
      ),
      head: headOf(world, later, second.secret),
    };
    const caught = catchUp(me(mac), holding(world, two), newest);
    expect(caught.secret.epoch).toBe(2);
    expect(caught.state.length).toBe(later.state.length);
  });

  it("a device already at the rotation's position takes it the same way", () => {
    const { world, mac, phone, two } = grown();
    const removed = appended(
      two,
      signRemoval(world.gatewayDevice.listKey, two.state, phone.device.listKey),
    );
    const { newest } = rotated(world, removed, world.secret);
    expect(catchUp(me(mac), holding(world, removed), newest).secret.epoch).toBe(1);
  });

  it("a removed device has no share, and the connector's signature is required", () => {
    const { world, phone, mac, two } = grown();
    const removed = appended(
      two,
      signRemoval(world.gatewayDevice.listKey, two.state, phone.device.listKey),
    );
    const { newest } = rotated(world, removed, world.secret);
    expectCode(() => catchUp(me(phone), holding(world, two), newest), "not_member");
    const tampered = newest.rotation.slice();
    tampered[tampered.length - 1]! ^= 1;
    expectCode(
      () => catchUp(me(mac), holding(world, two), { ...newest, rotation: tampered }),
      "bad_signature",
    );
  });

  it("refuses a rotation for another account, under the same connector", () => {
    const { world, mac, phone, two } = grown();
    const removed = appended(
      two,
      signRemoval(world.gatewayDevice.listKey, two.state, phone.device.listKey),
    );
    const { newest } = rotated(world, removed, world.secret);
    const foreign = forgeRotation({
      connector: world.connector,
      context: OTHER_ACCOUNT,
      generation: 0,
      length: removed.state.length,
      entryHash: removed.state.head,
      epoch: 1,
      recipients: removed.state.devices().map((m) => ({ key: m.key, seal: m.device!.sealKey })),
      secret: fill(32, 0x99),
    });
    expectCode(
      () => catchUp(me(mac), holding(world, two), { ...newest, rotation: foreign }),
      "wrong_account",
    );
  });

  it("refuses a rotation not newer than the secret held", () => {
    const { world, mac, phone, two } = grown();
    const removed = appended(
      two,
      signRemoval(world.gatewayDevice.listKey, two.state, phone.device.listKey),
    );
    const { newest } = rotated(world, removed, world.secret);
    // The Mac holds a later epoch than the rotation's (restored from its own store).
    const held = holding(world, two, ListSecret.restoreStored(fill(32, 0x77), 5));
    expectCode(() => catchUp(me(mac), held, newest), "stale_secret");
  });

  it("refuses a list sealed under the new secret whose head names another epoch", () => {
    const { world, mac, phone, two } = grown();
    const removed = appended(
      two,
      signRemoval(world.gatewayDevice.listKey, two.state, phone.device.listKey),
    );
    const { secret, newest } = rotated(world, removed, world.secret);
    // The head signed with the old epoch, over a list sealed under the new secret.
    const oldEpochHead = headOf(world, removed, world.secret);
    void secret;
    expectCode(
      () => catchUp(me(mac), holding(world, two), { ...newest, head: oldEpochHead }),
      "stale_secret",
    );
  });

  it("refuses a rotation whose position isn't a removal or a restore, even with the right devices", () => {
    // The gateway's device removes itself, the Mac takes its role: the re-link's position has the
    // same devices as the removal's, but no rotation follows a re-link.
    const { world, mac, phone, two } = grown();
    const removed = appended(
      two,
      signRemoval(world.gatewayDevice.listKey, two.state, world.gatewayDevice.device.listKey),
    );
    const relink = appended(
      removed,
      assembleRelink(
        removed.state,
        mac.device.listKey,
        signRelink(world.connector, removed.state, mac.device.listKey),
        signRelink(mac.listKey, removed.state, mac.device.listKey),
      ),
    );
    const secret = fill(32, 0x31);
    const rotation = forgeRotation({
      connector: world.connector,
      context: CONTEXT,
      generation: 0,
      length: relink.state.length,
      entryHash: relink.state.head,
      epoch: 1,
      recipients: relink.state.devices().map((m) => ({ key: m.key, seal: m.device!.sealKey })),
      secret,
    });
    const asSecret = ListSecret.restoreStored(secret, 1);
    const newest = {
      rotation,
      list: sealList(
        asSecret,
        CONTEXT,
        relink.entries,
        LIST_RANDOM,
        headObject(world, relink, asSecret),
      ),
      head: headOf(world, relink, asSecret),
    };
    expectCode(() => catchUp(me(phone), holding(world, two), newest), "bad_chain");
    void mac;
  });

  it("refuses a rotation whose recipients aren't exactly the devices at its position", () => {
    const { world, mac, phone, two } = grown();
    const removed = appended(
      two,
      signRemoval(world.gatewayDevice.listKey, two.state, phone.device.listKey),
    );
    const secret = fill(32, 0x32);
    const asSecret = ListSecret.restoreStored(secret, 1);
    const devices = removed.state.devices();
    const rotation = forgeRotation({
      connector: world.connector,
      context: CONTEXT,
      generation: 0,
      length: removed.state.length,
      entryHash: removed.state.head,
      epoch: 1,
      // The gateway's device left out.
      recipients: devices
        .filter((m) => m.key.equals(mac.device.listKey))
        .map((m) => ({ key: m.key, seal: m.device!.sealKey })),
      secret,
    });
    const newest = {
      rotation,
      list: sealList(
        asSecret,
        CONTEXT,
        removed.entries,
        LIST_RANDOM,
        headObject(world, removed, asSecret),
      ),
      head: headOf(world, removed, asSecret),
    };
    expectCode(() => catchUp(me(mac), holding(world, two), newest), "bad_chain");
  });

  it("refuses a rotation whose position isn't on the list", () => {
    const { world, mac, phone, two } = grown();
    const removed = appended(
      two,
      signRemoval(world.gatewayDevice.listKey, two.state, phone.device.listKey),
    );
    const { newest } = rotated(world, removed, world.secret);
    // Another list, forked at the same length, carrying the rotation's secret.
    const fork = appended(two, signRemoval(mac.listKey, two.state, mac.device.listKey));
    const secret = fill(32, 0x33);
    const asSecret = ListSecret.restoreStored(secret, 1);
    const rotation = forgeRotation({
      connector: world.connector,
      context: CONTEXT,
      generation: 0,
      length: fork.state.length,
      entryHash: fork.state.head,
      epoch: 1,
      recipients: removed.state.devices().map((m) => ({ key: m.key, seal: m.device!.sealKey })),
      secret,
    });
    const bad = {
      rotation,
      list: sealList(
        asSecret,
        CONTEXT,
        removed.entries,
        LIST_RANDOM,
        headObject(world, removed, asSecret),
      ),
      head: headOf(world, removed, asSecret),
    };
    expectCode(() => catchUp(me(mac), holding(world, two), bad), "bad_chain");
    void newest;
  });

  it("refuses a rotation that gives back the secret held", () => {
    const { world, mac, phone, two } = grown();
    const removed = appended(
      two,
      signRemoval(world.gatewayDevice.listKey, two.state, phone.device.listKey),
    );
    const held = world.secret.exportForStorage().bytes;
    const same = ListSecret.restoreStored(held, 1);
    const rotation = forgeRotation({
      connector: world.connector,
      context: CONTEXT,
      generation: 0,
      length: removed.state.length,
      entryHash: removed.state.head,
      epoch: 1,
      recipients: removed.state.devices().map((m) => ({ key: m.key, seal: m.device!.sealKey })),
      secret: held,
    });
    const newest = {
      rotation,
      list: sealList(same, CONTEXT, removed.entries, LIST_RANDOM, headObject(world, removed, same)),
      head: headOf(world, removed, same),
    };
    expectCode(() => catchUp(me(mac), holding(world, two), newest), "stale_secret");
  });

  it("refuses a list on which the held head's entry isn't found", () => {
    const { world, mac, phone, two } = grown();
    // The Mac held a list where the phone was removed by the Mac; the newest is another history.
    const macView = appended(two, signRemoval(mac.listKey, two.state, phone.device.listKey));
    const other = appended(
      two,
      signRemoval(world.gatewayDevice.listKey, two.state, phone.device.listKey),
    );
    const longer = appended(
      other,
      signAdd(world.gatewayDevice.listKey, other.state, makeDevice(6).device, TRANSCRIPT),
    );
    const removedAgain = appended(
      longer,
      signRemoval(world.gatewayDevice.listKey, longer.state, entryKeyOf(longer, 6)),
    );
    const { newest } = rotated(world, removedAgain, world.secret);
    expectCode(() => catchUp(me(mac), holding(world, macView), newest), "bad_chain");
  });
});

function entryKeyOf(_held: Held, n: number) {
  return makeDevice(n).device.listKey;
}

describe("the first secret", () => {
  it("is derived by the connector and sealed to the linking device alone", () => {
    const world = makeWorld();
    const gateway = world.gatewayDevice;
    const { message, secret } = sealFirstSecret(world.connector, world.state, fill(32, 4));
    const opened = openFirstSecret(me(gateway), world.state, message);
    expect(opened.epoch).toBe(0);
    expect(opened.exportForStorage().bytes).toEqual(secret.exportForStorage().bytes);
    expect(secret.exportForStorage().bytes).not.toEqual(fill(32, 4));
    const { two, mac } = grown();
    expectCode(() => sealFirstSecret(world.connector, two.state, fill(32, 4)), "bad_chain");
    expectCode(() => openFirstSecret(me(mac), world.state, message), "not_member");
    expectCode(() => sealFirstSecret(gateway.listKey, world.state, fill(32, 4)), "not_permitted");
    const grownWorld = appended(
      world,
      signAdd(gateway.listKey, world.state, makeDevice(7).device, TRANSCRIPT),
    );
    expectCode(() => openFirstSecret(me(gateway), grownWorld.state, message), "bad_chain");
    const tampered = message.slice();
    tampered[tampered.length - 1]! ^= 1;
    expectCode(() => openFirstSecret(me(gateway), world.state, tampered), "bad_signature");
  });
});

describe("refusals", () => {
  it("on a list quiet for longer than an hour, a refusal naming the current head is taken", () => {
    // The reviewer's case, turned round: no head was replaced within the hour.
    const { world, two } = grown();
    const n = NewDeviceJoin.start(fresh(makeDevice(9)), CONTEXT, N_RANDOM, CLOCK);
    const { refusal, pauseUntilMs } = refuseJoin(
      { key: world.gatewayDevice.listKey, state: two.state },
      n.commit,
      "not-started",
      NOW,
    );
    expect(pauseUntilMs).not.toBeNull();
    expect(verifyRefusal(two.state, refusal, []).pauses).toBe(true);
  });

  it("is taken naming a head replaced within the hour, and refused naming an older one", () => {
    const { world, two } = grown();
    const n = NewDeviceJoin.start(fresh(makeDevice(9)), CONTEXT, N_RANDOM, CLOCK);
    const { refusal } = refuseJoin(
      { key: world.gatewayDevice.listKey, state: two.state },
      n.commit,
      "not-started",
      NOW,
    );
    const moved = appended(
      two,
      signRemovalNotice(
        world.connector,
        two.state,
        encodeRemovalNotice(CONTEXT, makeDevice(3).device.listKey),
      ),
    );
    const taken = verifyRefusal(moved.state, refusal, [two.state.head]);
    expect(verifyRefusal(moved.state, refusal, [two.state.head]).hash).toEqual(taken.hash);
    expectCode(() => verifyRefusal(moved.state, refusal, []), "stale_head");
  });

  it("for two joins at once pauses nothing, and the member's app gets no pause to keep", () => {
    const { world, two } = grown();
    const n = NewDeviceJoin.start(fresh(makeDevice(9)), CONTEXT, N_RANDOM, CLOCK);
    const { refusal, pauseUntilMs } = refuseJoin(
      { key: world.gatewayDevice.listKey, state: two.state },
      n.commit,
      "concurrent",
      NOW,
    );
    expect(pauseUntilMs).toBeNull();
    expect(verifyRefusal(two.state, refusal, []).pauses).toBe(false);
  });

  it("is refused for another account even when it names a head hash this list has", () => {
    const { world, two } = grown();
    const n = NewDeviceJoin.start(fresh(makeDevice(9)), CONTEXT, N_RANDOM, CLOCK);
    const forged = forgeRefusal({
      signer: world.gatewayDevice.listKey,
      context: OTHER_ACCOUNT,
      listHead: two.state.head,
      commitment: commitmentOf(n.commit),
      reason: 3,
    });
    expectCode(() => verifyRefusal(two.state, forged, []), "wrong_account");
  });
});

void ListSecretKey;
