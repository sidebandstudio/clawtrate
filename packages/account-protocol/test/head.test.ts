// The connector's signed head (design §4.2.2) and what is bound to it: a list read against it,
// a card no older than it, sealing no older than its epoch, a rotation naming it and sealed to
// exactly its devices, the first secret's own message, and refusals naming a recent head.

import { describe, expect, it, vi } from "vitest";
import {
  encodeRemovalNotice,
  ListSecret,
  MemberJoin,
  NewDeviceJoin,
  openCard,
  openFirstSecret,
  openList,
  openRotation,
  refuseJoin,
  rotateListSecret,
  sealCard,
  sealFirstSecret,
  sealList,
  signCard,
  signHead,
  signRemoval,
  signRemovalNotice,
  signRestore,
  verifyCard,
  verifyHead,
  verifyList,
  verifyRefusal,
} from "../src/index.ts";
import { signList } from "../src/keys.ts";
import { signAdd } from "../src/list.ts";
import {
  addDevice,
  appended,
  CLOCK,
  CONTEXT,
  expectCode,
  fill,
  headObject,
  headOf,
  makeDevice,
  makeWorld,
  memberOf,
  N_RANDOM,
  OTHER_ACCOUNT,
  type Held,
} from "./helpers.ts";

// Signatures and key checks are quick alone; on a loaded machine a test can take seconds.
vi.setConfig({ testTimeout: 120_000 });

const TRANSCRIPT = fill(32, 0x5a);
const RANDOM = fill(32, 0x6a);

/** The gateway's device, a Mac it added, a phone the Mac added, and the list at each step. */
function grown() {
  const world = makeWorld();
  const mac = makeDevice(2);
  const phone = makeDevice(3, "iPhone", "ios");
  const one = appended(
    world,
    signAdd(world.gatewayDevice.listKey, world.state, mac.device, TRANSCRIPT),
  );
  const two = appended(one, signAdd(mac.listKey, one.state, phone.device, TRANSCRIPT));
  return { world, mac, phone, one, two };
}

describe("the head", () => {
  it("names the list's generation, length, latest entry, epoch and card, signed by the connector", () => {
    const { world, two } = grown();
    const head = verifyHead(headOf(world, two), two.state.connectorKey, CONTEXT);
    expect([head.generation, head.count, head.epoch, head.serial]).toEqual([0, 3, 0, 1]);
    expect(head.entryHash).toEqual(two.state.head);
    expectCode(
      () => signHead(world.gatewayDevice.listKey, two.state, world.secret, world.card),
      "not_permitted",
    );
    expectCode(
      () => verifyHead(headOf(world, two), world.gatewayDevice.listKey.publicKey, CONTEXT),
      "bad_signature",
    );
    expectCode(
      () => verifyHead(headOf(world, two), two.state.connectorKey, OTHER_ACCOUNT),
      "wrong_account",
    );
  });

  it("refuses a list cut short, or one that doesn't end at its head", () => {
    // The reviewer's case, turned round: a member shown the list before a thief's add.
    const { world, one, two } = grown();
    const head = headOf(world, two);
    expectCode(() => verifyList(CONTEXT, one.entries, head), "bad_chain");
    expectCode(() => verifyList(CONTEXT, [...two.entries, two.entries[1]!], head), "bad_chain");
    expect(verifyList(CONTEXT, two.entries, head).state.length).toBe(3);
  });

  it("refuses a list older than, or forked from, the newest head the reader holds", () => {
    const { world, mac, one, two } = grown();
    const newest = headObject(world, two);
    // An older list with its own (genuine, older) head.
    expectCode(() => verifyList(CONTEXT, one.entries, headOf(world, one), newest), "stale_head");
    // A fork at the same height: another device added by the Mac instead of the phone.
    const fork = appended(one, signAdd(mac.listKey, one.state, makeDevice(4).device, TRANSCRIPT));
    expectCode(() => verifyList(CONTEXT, fork.entries, headOf(world, fork), newest), "bad_chain");
    // The same list, or a newer one, passes.
    expect(verifyList(CONTEXT, two.entries, headOf(world, two), newest).head.count).toBe(3);
  });

  it("refuses a head with an older secret or an older card than the one held", () => {
    const { world, two } = grown();
    const newer = ListSecret.fromBytes(fill(32, 0xe1), 1);
    const card2 = signCard(world.connector, {
      ...verifyCard(world.card, world.connector.publicKey, CONTEXT.gatewayId),
      serial: 2,
    });
    const held = verifyHead(
      signHead(world.connector, two.state, newer, card2),
      two.state.connectorKey,
      CONTEXT,
    );
    expectCode(
      () =>
        verifyList(
          CONTEXT,
          two.entries,
          signHead(world.connector, two.state, world.secret, card2),
          held,
        ),
      "stale_head",
    );
    expectCode(
      () =>
        verifyList(
          CONTEXT,
          two.entries,
          signHead(world.connector, two.state, newer, world.card),
          held,
        ),
      "stale_head",
    );
  });

  it("a card is taken only as the card the head names: never an older one", () => {
    // The reviewer's older card, turned round.
    const { world, two } = grown();
    const card2 = signCard(world.connector, {
      ...verifyCard(world.card, world.connector.publicKey, CONTEXT.gatewayId),
      serial: 2,
    });
    const head2 = verifyHead(
      signHead(world.connector, two.state, world.secret, card2),
      two.state.connectorKey,
      CONTEXT,
    );
    const sealedOld = sealCard(world.secret, CONTEXT, world.card, RANDOM, head2);
    expectCode(() => openCard(world.secret, two.state, sealedOld, head2), "card_mismatch");
    expect(
      openCard(
        world.secret,
        two.state,
        sealCard(world.secret, CONTEXT, card2, RANDOM, head2),
        head2,
      ).serial,
    ).toBe(2);
    // A member answering with an older card than its head's is refused before it answers.
    const n = NewDeviceJoin.start(makeDevice(9), CONTEXT, N_RANDOM, CLOCK);
    const member = { ...memberOf(world, world.gatewayDevice.listKey, two), head: head2.bytes };
    expectCode(() => MemberJoin.answer(member, n.commit, CLOCK), "card_mismatch");
  });

  it("nothing is sealed under a secret older than the newest head's", () => {
    const { world, two } = grown();
    const newerHead = verifyHead(
      signHead(world.connector, two.state, ListSecret.fromBytes(fill(32, 0xe1), 1), world.card),
      two.state.connectorKey,
      CONTEXT,
    );
    expectCode(
      () => sealList(world.secret, CONTEXT, two.entries, RANDOM, newerHead),
      "stale_secret",
    );
    expectCode(
      () => sealCard(world.secret, CONTEXT, world.card, RANDOM, newerHead),
      "stale_secret",
    );
  });

  it("a member answers only from its list at its head, with that head's card and secret", () => {
    const { world, one, two } = grown();
    const n = NewDeviceJoin.start(makeDevice(9), CONTEXT, N_RANDOM, CLOCK);
    // The list it holds is older than its head.
    expectCode(
      () =>
        MemberJoin.answer(
          { ...memberOf(world, world.gatewayDevice.listKey, one), head: headOf(world, two) },
          n.commit,
          CLOCK,
        ),
      "bad_chain",
    );
    // A secret of another epoch than the head's.
    const member = {
      ...memberOf(world, world.gatewayDevice.listKey, two),
      secret: ListSecret.fromBytes(fill(32, 0xe1), 1),
    };
    expectCode(() => MemberJoin.answer(member, n.commit, CLOCK), "stale_secret");
  });
});

describe("rotations bound to the head", () => {
  it("are taken only for the list the device holds at that head, sealed to exactly its devices", () => {
    // The reviewer's case, turned round: a rotation built from the state before the removal.
    const { world, mac, phone, two } = grown();
    const removed = appended(two, signRemoval(mac.listKey, two.state, phone.device.listKey));
    const next = ListSecret.fromBytes(fill(32, 0xe1), 1);
    const before = rotateListSecret(world.connector, two.state, world.secret, next, RANDOM);
    const me = { listKey: mac.device.listKey, sealKey: mac.sealKey };
    expectCode(() => openRotation(me, removed.state, before, world.secret), "bad_chain");
    const right = rotateListSecret(world.connector, removed.state, world.secret, next, RANDOM);
    expect(openRotation(me, removed.state, right, world.secret).epoch).toBe(1);
    // The same rotation to a device holding an older list.
    expectCode(() => openRotation(me, two.state, right, world.secret), "bad_chain");
  });

  it("a rotation for another head with the same devices is refused for its head", () => {
    // The phone is removed by the account page and put back: the same devices, another head.
    const { world, mac, phone, two } = grown();
    const byPage = appended(
      two,
      signRemovalNotice(
        world.connector,
        two.state,
        encodeRemovalNotice(CONTEXT, phone.device.listKey),
      ),
    );
    const back = appended(byPage, signRestore(mac.listKey, byPage.state, phone.device.listKey));
    const rotation = rotateListSecret(
      world.connector,
      back.state,
      world.secret,
      ListSecret.fromBytes(fill(32, 0xe1), 1),
      RANDOM,
    );
    expectCode(
      () =>
        openRotation(
          { listKey: mac.device.listKey, sealKey: mac.sealKey },
          two.state,
          rotation,
          world.secret,
        ),
      "bad_chain",
    );
  });

  it("a rotation the connector signed without one device's share is refused", () => {
    const { world, mac, two } = grown();
    const rotation = rotateListSecret(
      world.connector,
      two.state,
      world.secret,
      ListSecret.fromBytes(fill(32, 0xe1), 1),
      RANDOM,
    );
    // Drop the last share (112 bytes), lower the count, and sign again with the connector's key.
    const signedEnd = rotation.length - 64;
    const body = rotation.slice(0, signedEnd - 112);
    const countAt = 33 + 32 + 4 + 4 + 32 + 4;
    body[countAt] = body[countAt]! - 1;
    const short = Uint8Array.of(...body, ...signList(world.connector, body));
    expectCode(
      () =>
        openRotation(
          { listKey: mac.device.listKey, sealKey: mac.sealKey },
          two.state,
          short,
          world.secret,
        ),
      "bad_chain",
    );
  });

  it("a restore rotates too, and the device put back opens the new secret", () => {
    const { world, mac, phone, two } = grown();
    const byPage = appended(
      two,
      signRemovalNotice(
        world.connector,
        two.state,
        encodeRemovalNotice(CONTEXT, phone.device.listKey),
      ),
    );
    const back = appended(byPage, signRestore(mac.listKey, byPage.state, phone.device.listKey));
    const next = ListSecret.fromBytes(fill(32, 0xe1), 1);
    const rotation = rotateListSecret(world.connector, back.state, world.secret, next, RANDOM);
    expect(
      openRotation(
        { listKey: phone.device.listKey, sealKey: phone.sealKey },
        back.state,
        rotation,
        world.secret,
      ).epoch,
    ).toBe(1);
  });
});

describe("the first secret", () => {
  it("has its own message to the linking device, signed by the connector", () => {
    const world = makeWorld();
    const gateway = world.gatewayDevice;
    const message = sealFirstSecret(world.connector, world.state, world.secret, RANDOM);
    const opened = openFirstSecret(
      { listKey: gateway.device.listKey, sealKey: gateway.sealKey },
      world.state,
      message,
    );
    expect(opened.epoch).toBe(0);
    expect(
      openCard(
        opened,
        world.state,
        sealCard(world.secret, CONTEXT, world.card, RANDOM, headObject(world)),
        headObject(world),
      ).serial,
    ).toBe(1);
    // Not for a list that has grown, not to another device, not by anyone but the connector.
    const { two, mac } = grown();
    expectCode(
      () => sealFirstSecret(world.connector, two.state, world.secret, RANDOM),
      "bad_chain",
    );
    // A first secret held up against a list that has grown since its first entry.
    const grownWorld = appended(
      world,
      signAdd(gateway.listKey, world.state, makeDevice(7).device, TRANSCRIPT),
    );
    expectCode(
      () =>
        openFirstSecret(
          { listKey: gateway.device.listKey, sealKey: gateway.sealKey },
          grownWorld.state,
          message,
        ),
      "bad_chain",
    );
    expectCode(
      () =>
        openFirstSecret(
          { listKey: mac.device.listKey, sealKey: mac.sealKey },
          world.state,
          message,
        ),
      "not_member",
    );
    expectCode(
      () => sealFirstSecret(gateway.listKey, world.state, world.secret, RANDOM),
      "not_permitted",
    );
    expectCode(
      () =>
        sealFirstSecret(world.connector, world.state, ListSecret.fromBytes(fill(32, 9), 1), RANDOM),
      "stale_secret",
    );
    const tampered = message.slice();
    tampered[tampered.length - 1]! ^= 1;
    expectCode(
      () =>
        openFirstSecret(
          { listKey: gateway.device.listKey, sealKey: gateway.sealKey },
          world.state,
          tampered,
        ),
      "bad_signature",
    );
  });
});

describe("refusals", () => {
  it("are taken naming any head the connector signed within the hour, once by hash", () => {
    const { world, two } = grown();
    const n = NewDeviceJoin.start(makeDevice(9), CONTEXT, N_RANDOM, CLOCK);
    const refusal = refuseJoin(
      { key: world.gatewayDevice.listKey, state: two.state },
      n.commit,
      "not-started",
    );
    // The head moved since (an account-page removal, say): the refusal still counts.
    const moved = appended(
      two,
      signRemovalNotice(
        world.connector,
        two.state,
        encodeRemovalNotice(CONTEXT, makeDevice(3).device.listKey),
      ),
    );
    const recent = [two.state.head, moved.state.head];
    const taken = verifyRefusal(moved.state, refusal, recent);
    expect(taken.pauses).toBe(true);
    expect(verifyRefusal(moved.state, refusal, recent).hash).toEqual(taken.hash);
    // A head older than the hour is no longer in the connector's list: refused.
    expectCode(() => verifyRefusal(moved.state, refusal, [moved.state.head]), "stale_head");
  });

  it("for two joins at once end both and pause nothing", () => {
    const { world, two } = grown();
    const n = NewDeviceJoin.start(makeDevice(9), CONTEXT, N_RANDOM, CLOCK);
    const refusal = refuseJoin(
      { key: world.gatewayDevice.listKey, state: two.state },
      n.commit,
      "concurrent",
    );
    expect(verifyRefusal(two.state, refusal, [two.state.head]).pauses).toBe(false);
  });
});

describe("a whole join reads the list against its head", () => {
  it("N's first list need not hold N only if the head says so: a list cut before N's entry is refused", () => {
    const world = makeWorld();
    const { held } = addDevice(world, world.gatewayDevice.listKey, makeDevice(2));
    const cut: Held = world;
    expectCode(() => verifyList(CONTEXT, cut.entries, headOf(world, held)), "bad_chain");
    expect(
      openList(
        world.secret,
        CONTEXT,
        sealList(world.secret, CONTEXT, held.entries, RANDOM, headObject(world, held)),
        headOf(world, held),
      ).state.length,
    ).toBe(2);
  });
});
