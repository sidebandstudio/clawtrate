// One hand-built, validly signed counter-example for each rule that another check would
// otherwise hide, so every rule has a test that fails without it: the new device's checks in
// member and first-device mode, the head held, the fresh start, "what it caused", the re-link,
// and the constructions the known-answer vectors alone would guard.

import { describe, expect, it, vi } from "vitest";
import {
  assembleFreshStart,
  assembleRelink,
  cardHash,
  encodeRemovalNotice,
  Head,
  ListSecret,
  NewDeviceJoin,
  sealCard,
  sealList,
  signFreshStart,
  signRelink,
  signRemoval,
  signRemovalNotice,
  signRestore,
  signWithdrawal,
  verifyList,
} from "../src/index.ts";
import { confirmationWord, fiveWords, wordsFor } from "../src/join.ts";
import { signAdd, signServerFirst } from "../src/list.ts";
import { commitmentOf, forgeAnswer, forgeConfirm, transcriptOf } from "./forge.ts";
import {
  appended,
  CLOCK,
  CONTEXT,
  expectCode,
  fill,
  fresh,
  headObject,
  headOf,
  LIST_RANDOM,
  makeDevice,
  makeWorld,
  N_RANDOM,
  seeded,
  type Held,
} from "./helpers.ts";

// Signatures and key checks are quick alone; on a loaded machine a test can take seconds.
vi.setConfig({ testTimeout: 120_000 });

const TRANSCRIPT = fill(32, 0x5a);

describe("the new device's checks, each alone", () => {
  const world = makeWorld();
  const a = world.gatewayDevice;

  /** N's join up to its reveal, against an answer with the given fields. */
  function revealTo(fields: {
    memberKey: typeof a.listKey;
    listHead: Uint8Array;
    card?: Uint8Array;
  }) {
    const device = makeDevice(2);
    const n = NewDeviceJoin.start(fresh(device), CONTEXT, N_RANDOM, CLOCK);
    const answer = forgeAnswer({
      context: CONTEXT,
      commitment: commitmentOf(n.commit),
      memberKey: fields.memberKey.publicKey,
      listHead: fields.listHead,
      cardHash: cardHash(fields.card ?? world.card),
      nonce: fill(32, 0x31),
    });
    const { reveal } = n.reveal(answer);
    return { n, device, transcript: transcriptOf(reveal) };
  }

  it("member mode: the delivered secret must be the head's epoch", () => {
    const { n, device, transcript } = revealTo({
      memberKey: a.listKey,
      listHead: world.state.head,
    });
    const entry = signAdd(a.listKey, world.state, device.device, transcript);
    const other = ListSecret.restoreStored(fill(32, 0x2e), 1);
    const confirm = forgeConfirm({
      member: a.listKey,
      context: CONTEXT,
      transcript,
      entry,
      sealTo: device.device.sealKey,
      secret: other,
      card: world.card,
    });
    const after = appended(world, entry);
    const sealed = sealList(other, CONTEXT, after.entries, LIST_RANDOM, headObject(world, after));
    expectCode(() => n.finish(confirm, sealed, headOf(world, after), null), "stale_secret");
  });

  it("member mode: the add must be signed by the member the words covered", () => {
    const mac = makeDevice(3);
    const withMac = appended(world, signAdd(a.listKey, world.state, mac.device, TRANSCRIPT));
    const { n, device, transcript } = revealTo({
      memberKey: a.listKey,
      listHead: withMac.state.head,
    });
    const entry = signAdd(mac.listKey, withMac.state, device.device, transcript);
    const confirm = forgeConfirm({
      member: a.listKey,
      context: CONTEXT,
      transcript,
      entry,
      sealTo: device.device.sealKey,
      secret: world.secret,
      card: world.card,
    });
    const after = appended(withMac, entry);
    const sealed = sealList(
      world.secret,
      CONTEXT,
      after.entries,
      LIST_RANDOM,
      headObject(world, after),
    );
    expectCode(() => n.finish(confirm, sealed, headOf(world, after), null), "transcript_mismatch");
  });

  it("first-device mode: the answer must have named no list", () => {
    const { n, device, transcript } = revealTo({
      memberKey: world.connector,
      listHead: fill(32, 7),
    });
    const entry = signServerFirst(world.connector, CONTEXT, device.device, transcript);
    const confirm = forgeConfirm({
      member: world.connector,
      context: CONTEXT,
      transcript,
      entry,
      sealTo: device.device.sealKey,
      secret: ListSecret.restoreStored(fill(32, 0x2f), 0),
      card: world.card,
    });
    expectCode(() => n.finish(confirm, null, null, null), "bad_chain");
  });

  it("first-device mode: the first entry must be the answering connector's", () => {
    const zero = new Uint8Array(32);
    const { n, device, transcript } = revealTo({ memberKey: world.connector, listHead: zero });
    const otherConnector = makeWorld({ connector: fill(32, 0xc7) }).connector;
    const entry = signServerFirst(otherConnector, CONTEXT, device.device, transcript);
    const confirm = forgeConfirm({
      member: world.connector,
      context: CONTEXT,
      transcript,
      entry,
      sealTo: device.device.sealKey,
      secret: ListSecret.restoreStored(fill(32, 0x2f), 0),
      card: world.card,
    });
    expectCode(() => n.finish(confirm, null, null, null), "transcript_mismatch");
  });

  it("first-device mode: the first secret must be epoch 0", () => {
    const zero = new Uint8Array(32);
    const { n, device, transcript } = revealTo({ memberKey: world.connector, listHead: zero });
    const entry = signServerFirst(world.connector, CONTEXT, device.device, transcript);
    const confirm = forgeConfirm({
      member: world.connector,
      context: CONTEXT,
      transcript,
      entry,
      sealTo: device.device.sealKey,
      secret: ListSecret.restoreStored(fill(32, 0x2f), 1),
      card: world.card,
    });
    expectCode(() => n.finish(confirm, null, null, null), "stale_secret");
  });
});

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
  return { world, mac, phone, one, two };
}

describe("the head held", () => {
  it("refuses a longer fork: the held head's entry must be on the new list", () => {
    // The reviewer's case, turned round: the reader saw the phone added; a longer history
    // without it is refused.
    const { world, mac, one, two } = grown();
    const fork = appended(one, signAdd(mac.listKey, one.state, makeDevice(4).device, TRANSCRIPT));
    const longer = appended(
      fork,
      signAdd(mac.listKey, fork.state, makeDevice(5).device, TRANSCRIPT),
    );
    expectCode(
      () => verifyList(CONTEXT, longer.entries, headOf(world, longer), headObject(world, two)),
      "bad_chain",
    );
  });

  it("is a head the package verified: a look-alike object is refused", () => {
    const { world, two } = grown();
    const real = headObject(world, two);
    const lookalike = {
      generation: real.generation,
      count: real.count,
      entryHash: real.entryHash,
      epoch: real.epoch,
      cardHash: real.cardHash,
      serial: real.serial,
      hash: real.hash,
      bytes: real.bytes,
    } as unknown as Head;
    expectCode(
      () => verifyList(CONTEXT, two.entries, headOf(world, two), lookalike),
      "bad_argument",
    );
    expectCode(
      () => verifyList(CONTEXT, two.entries, headOf(world, two), undefined as unknown as Head),
      "bad_argument",
    );
    expect(Object.isFrozen(real)).toBe(true);
  });

  it("across a fresh start: the fresh start must name the held head or a later one, one generation on", () => {
    const { world, mac, one, two } = grown();
    // A fresh start of the list before the phone, for a reader that saw the phone.
    const older = assembleFreshStart(
      one.state,
      signFreshStart(world.connector, one.state),
      signFreshStart(world.gatewayDevice.listKey, one.state),
    );
    const olderList: Held = { state: older.state, entries: [older.entry] };
    expectCode(
      () =>
        verifyList(CONTEXT, olderList.entries, headOf(world, olderList), headObject(world, two)),
      "stale_head",
    );
    // A fresh start of another list of the same length.
    const fork = appended(one, signAdd(mac.listKey, one.state, makeDevice(4).device, TRANSCRIPT));
    const forked = assembleFreshStart(
      fork.state,
      signFreshStart(world.connector, fork.state),
      signFreshStart(world.gatewayDevice.listKey, fork.state),
    );
    const forkedList: Held = { state: forked.state, entries: [forked.entry] };
    expectCode(
      () =>
        verifyList(CONTEXT, forkedList.entries, headOf(world, forkedList), headObject(world, two)),
      "bad_chain",
    );
    // The right one is taken.
    const right = assembleFreshStart(
      two.state,
      signFreshStart(world.connector, two.state),
      signFreshStart(world.gatewayDevice.listKey, two.state),
    );
    const rightList: Held = { state: right.state, entries: [right.entry] };
    expect(
      verifyList(CONTEXT, rightList.entries, headOf(world, rightList), headObject(world, two)).head
        .generation,
    ).toBe(1);
    // Two fresh starts on is more than a reader can check.
    const twice = assembleFreshStart(
      right.state,
      signFreshStart(world.connector, right.state),
      signFreshStart(world.gatewayDevice.listKey, right.state),
    );
    const twiceList: Held = { state: twice.state, entries: [twice.entry] };
    expectCode(
      () =>
        verifyList(CONTEXT, twiceList.entries, headOf(world, twiceList), headObject(world, two)),
      "bad_chain",
    );
  });
});

describe("the fresh start", () => {
  it("is refused two generations on, even naming a longer list", () => {
    const world = makeWorld();
    const first = assembleFreshStart(
      world.state,
      signFreshStart(world.connector, world.state),
      signFreshStart(world.gatewayDevice.listKey, world.state),
    );
    const longer = appended(
      { state: first.state, entries: [first.entry] },
      signAdd(world.gatewayDevice.listKey, first.state, makeDevice(5).device, TRANSCRIPT),
    );
    const second = assembleFreshStart(
      longer.state,
      signFreshStart(world.connector, longer.state),
      signFreshStart(world.gatewayDevice.listKey, longer.state),
    );
    // Generation 2 offered to a reader at generation 0, naming a list longer than its own.
    expectCode(() => world.state.freshStart(second.entry), "bad_chain");
  });

  it("carries account-page removals, so Put it back still works after it", () => {
    const { world, mac, phone, two } = grown();
    const byPage = appended(
      two,
      signRemovalNotice(
        world.connector,
        two.state,
        encodeRemovalNotice(CONTEXT, phone.device.listKey),
      ),
    );
    const next = assembleFreshStart(
      byPage.state,
      signFreshStart(world.connector, byPage.state),
      signFreshStart(world.gatewayDevice.listKey, byPage.state),
    );
    expect(next.state.removal(phone.device.listKey)?.origin).toBe("account");
    const back = next.state.append(signRestore(mac.listKey, next.state, phone.device.listKey));
    expect(back.member(phone.device.listKey)).toBeDefined();
  });

  it("a withdrawal is refused for a device it carried", () => {
    const { world, mac, two } = grown();
    const next = assembleFreshStart(
      two.state,
      signFreshStart(world.connector, two.state),
      signFreshStart(world.gatewayDevice.listKey, two.state),
    );
    expectCode(() => signWithdrawal(world.connector, next.state, mac.device.listKey), "bad_target");
  });
});

describe("what it caused", () => {
  it("walks through a removed device, and a fresh start carries the nearest current ancestor", () => {
    // The reviewer's case, turned round: a thief adds a puppet, the puppet adds the device the
    // thief wants to keep, and the puppet removes itself.
    const world = makeWorld();
    const g = world.gatewayDevice;
    const [thief, puppet, kept] = [makeDevice(20), makeDevice(21), makeDevice(22)];
    let held: Held = world;
    held = appended(held, signAdd(g.listKey, held.state, thief.device, TRANSCRIPT));
    held = appended(held, signAdd(thief.listKey, held.state, puppet.device, TRANSCRIPT));
    held = appended(held, signAdd(puppet.listKey, held.state, kept.device, TRANSCRIPT));
    held = appended(held, signRemoval(puppet.listKey, held.state, puppet.device.listKey));
    expect(held.state.causedBy(thief.device.listKey).map((m) => m.device!.name)).toEqual([
      "Device 22",
    ]);
    const next = assembleFreshStart(
      held.state,
      signFreshStart(world.connector, held.state),
      signFreshStart(g.listKey, held.state),
    );
    expect(next.state.member(kept.device.listKey)?.addedBy?.equals(thief.device.listKey)).toBe(
      true,
    );
  });

  it("runs to a fixed point: a parent put back after its child still brings the child", () => {
    const world = makeWorld();
    const g = world.gatewayDevice;
    const [t, x, y] = [makeDevice(30), makeDevice(31), makeDevice(32)];
    let held: Held = world;
    held = appended(held, signAdd(g.listKey, held.state, t.device, TRANSCRIPT));
    held = appended(held, signAdd(t.listKey, held.state, x.device, TRANSCRIPT));
    held = appended(held, signAdd(x.listKey, held.state, y.device, TRANSCRIPT));
    held = appended(
      held,
      signRemovalNotice(
        world.connector,
        held.state,
        encodeRemovalNotice(CONTEXT, t.device.listKey),
      ),
    );
    // The gateway's device puts T back: T now comes after X and Y in the list's order.
    held = appended(held, signRestore(g.listKey, held.state, t.device.listKey));
    expect(
      held.state
        .causedBy(g.device.listKey)
        .map((m) => m.device!.name)
        .sort(),
    ).toEqual(["Device 30", "Device 31", "Device 32"]);
  });
});

describe("re-linking the gateway's own device", () => {
  it("gives the role to a current device, signed by the connector and that device, when no device holds it", () => {
    const { world, mac, phone, two } = grown();
    const g = world.gatewayDevice;
    expectCode(
      () =>
        assembleRelink(
          two.state,
          mac.device.listKey,
          signRelink(world.connector, two.state, mac.device.listKey),
          signRelink(mac.listKey, two.state, mac.device.listKey),
        ),
      "bad_target",
    );
    const alone = appended(two, signRemoval(g.listKey, two.state, g.device.listKey));
    // A fresh start is impossible without the role.
    expectCode(() => signFreshStart(world.connector, alone.state), "bad_target");
    expectCode(() => signRelink(phone.listKey, alone.state, mac.device.listKey), "not_permitted");
    // Signatures swapped, or by the wrong device: refused.
    expectCode(
      () =>
        assembleRelink(
          alone.state,
          mac.device.listKey,
          signRelink(mac.listKey, alone.state, mac.device.listKey),
          signRelink(world.connector, alone.state, mac.device.listKey),
        ),
      "bad_signature",
    );
    const relinked = alone.state.append(
      assembleRelink(
        alone.state,
        mac.device.listKey,
        signRelink(world.connector, alone.state, mac.device.listKey),
        signRelink(mac.listKey, alone.state, mac.device.listKey),
      ),
    );
    expect(relinked.member(mac.device.listKey)?.role).toBe("gateway-device");
    // The account page can't remove it now, and a fresh start is possible again.
    expectCode(
      () =>
        signRemovalNotice(
          world.connector,
          relinked,
          encodeRemovalNotice(CONTEXT, mac.device.listKey),
        ),
      "protected_member",
    );
    expect(() => signFreshStart(world.connector, relinked)).not.toThrow();
  });
});

describe("constructions a test checks, not only the vectors", () => {
  it("the list seal's synthetic nonce covers the plaintext: one random, two cards of one kind, two nonces", () => {
    const world = makeWorld();
    const head = headObject(world);
    const random = fill(32, 0x6c);
    const card2 = sealCard(world.secret, CONTEXT, world.card, random, head);
    const otherCard = makeWorld({ connector: fill(32, 0xc0) }).card.slice();
    otherCard[otherCard.length - 1]! ^= 1;
    const card3 = sealCard(world.secret, CONTEXT, otherCard, random, head);
    expect(card2.subarray(6, 30)).not.toEqual(card3.subarray(6, 30));
  });

  it("the confirmation word covers the card and A's signature", () => {
    const t = fill(32, 1);
    // Over many changes, a word that ignored either input would never change.
    const changes = (f: (i: number) => string) =>
      new Set(Array.from({ length: 20 }, (_, i) => f(i))).size;
    expect(changes((i) => confirmationWord(t, fill(64, 2), fill(32, 10 + i)))).toBeGreaterThan(1);
    expect(changes((i) => confirmationWord(t, fill(64, 10 + i), fill(32, 3)))).toBeGreaterThan(1);
  });

  it("N's five words come from N's own key: another key over the same join gives another order", () => {
    const t = fill(32, 1);
    const sig = fill(64, 2);
    const under = wordsFor(t);
    const orders = new Set(
      Array.from({ length: 20 }, (_, i) =>
        fiveWords("zoo", under, makeDevice(50 + i).listKey, t, sig).join(),
      ),
    );
    expect(orders.size).toBeGreaterThan(1);
  });

  it("N's four other words are never N's own three words", () => {
    const rng = seeded(9);
    const key = makeDevice(60).listKey;
    for (let i = 0; i < 300; i++) {
      const t = rng.bytes(32);
      const under = wordsFor(t);
      const right = ["zoo", "zone", "zero", "youth"].find((w) => !under.includes(w))!;
      const words = fiveWords(right, under, key, t, rng.bytes(64));
      for (const w of under) expect(words).not.toContain(w);
      expect(words).toContain(right);
    }
  });
});
