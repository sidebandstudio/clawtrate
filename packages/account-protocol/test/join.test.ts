// The join from both sides, and against someone in the middle: the service, which carries
// every message and can change, swap, hold back, repeat or replay any of them.

import { describe, expect, it, vi } from "vitest";
import {
  cardHash,
  ListSecret,
  MemberJoin,
  NewDeviceJoin,
  refuseJoin,
  sealList,
  signCard,
  signRemoval,
  verifyCard,
  verifyRefusal,
  wordsFor,
} from "../src/index.ts";
import { deriveSealKeyPair } from "../src/hpke.ts";
import { fiveSets } from "../src/join.ts";
import { signAdd } from "../src/list.ts";
import { commitmentOf, forgeAnswer, forgeConfirm, forgeRefusal, transcriptOf } from "./forge.ts";
import {
  addDevice,
  appended,
  CONTEXT,
  expectCode,
  fill,
  LIST_RANDOM,
  makeDevice,
  makeWorld,
  memberOf,
  N_RANDOM,
  OTHER_GATEWAY,
  runJoin,
  SEAL_RANDOM,
  seeded,
  CLOCK,
  NOW,
  headObject,
  chain,
  headOf,
} from "./helpers.ts";

// Signatures and key checks are quick alone; on a loaded machine a test can take seconds.
vi.setConfig({ testTimeout: 120_000 });

describe("a join with no one in the middle", () => {
  it("shows the same words on both sides, adds the device, and N finishes on the sealed list", () => {
    const world = makeWorld();
    const mac = makeDevice(2, "MacBook Pro");
    const { run, held, finished } = addDevice(world, world.gatewayDevice.listKey, mac);
    expect(run.right).toBeGreaterThanOrEqual(0);
    expect(run.sets).toHaveLength(5);
    expect(held.state.member(mac.device.listKey)?.role).toBe("device");
    expect(finished.state.head).toEqual(held.state.head);
    expect(finished.secret.epoch).toBe(0);
    expect(finished.cardBytes).toEqual(world.card);
    expect(finished.card.connectorKey.equals(world.connector.publicKey)).toBe(true);
    expect(Object.isFrozen(finished)).toBe(true);
  });

  it("lets the device just added confirm the next one", () => {
    const world = makeWorld();
    const mac = makeDevice(2);
    const first = addDevice(world, world.gatewayDevice.listKey, mac);
    const phone = makeDevice(3, "iPhone", "ios");
    const second = addDevice(world, mac.listKey, phone, first.held, fill(32, 0x12));
    expect(second.held.state.devices()).toHaveLength(3);
    expect(
      second.held.state.member(phone.device.listKey)?.addedBy?.equals(mac.device.listKey),
    ).toBe(true);
  });

  it("refuses the connector as the answering member, and a card that isn't the list's connector's", () => {
    const world = makeWorld();
    const n = NewDeviceJoin.start(makeDevice(2), CONTEXT, N_RANDOM, CLOCK);
    expectCode(
      () => MemberJoin.answer(memberOf(world, world.connector), n.commit, CLOCK),
      "not_permitted",
    );
    const card = signCard(
      makeDevice(9).listKey,
      verifyCard(world.card, world.connector.publicKey, CONTEXT.gatewayId),
    );
    expectCode(
      () =>
        MemberJoin.answer(
          { ...memberOf(world, world.gatewayDevice.listKey), card },
          n.commit,
          CLOCK,
        ),
      "card_mismatch",
    );
  });
});

describe("one answer, one reveal, one confirmation", () => {
  const world = makeWorld();
  const member = memberOf(world, world.gatewayDevice.listKey);
  const mac = makeDevice(2);

  it("N reveals once: the same answer again gets the same reveal, any other ends the join", () => {
    const n = NewDeviceJoin.start(mac, CONTEXT, N_RANDOM, CLOCK);
    const a = MemberJoin.answer(member, n.commit, CLOCK);
    const first = n.reveal(a.answer);
    expect(n.reveal(a.answer)).toEqual(first);
    // The service's own answer to N's commitment: A's key, list head and card, its own nonce.
    const forged = forgeAnswer({
      context: CONTEXT,
      commitment: commitmentOf(n.commit),
      memberKey: world.gatewayDevice.listKey.publicKey,
      listHead: world.state.head,
      cardHash: cardHash(world.card),
      nonce: fill(32, 0x99),
    });
    expectCode(() => n.reveal(forged), "join_spent");
    // The join has ended: not even the first answer, nor a finish, is taken any more.
    expectCode(() => n.reveal(a.answer), "join_spent");
    expectCode(() => n.finish(new Uint8Array(1), new Uint8Array(1), null), "join_spent");
  });

  it("so the service can't get a second reveal to grind against a member's words", () => {
    // The attack: reveal once to a forged answer, then try ground answers until N's words are
    // the ones A shows for the service's own device. The second reveal never comes.
    const n = NewDeviceJoin.start(mac, CONTEXT, N_RANDOM, CLOCK);
    const forge = (nonce: number) =>
      forgeAnswer({
        context: CONTEXT,
        commitment: commitmentOf(n.commit),
        memberKey: world.gatewayDevice.listKey.publicKey,
        listHead: world.state.head,
        cardHash: cardHash(world.card),
        nonce: fill(32, nonce),
      });
    n.reveal(forge(1));
    for (let nonce = 2; nonce < 6; nonce++) expectCode(() => n.reveal(forge(nonce)), "join_spent");
  });

  it("A answers a commitment the same way, byte for byte, however often it is asked", () => {
    const n = NewDeviceJoin.start(mac, CONTEXT, N_RANDOM, CLOCK);
    const once = MemberJoin.answer(member, n.commit, CLOCK).answer;
    const twice = MemberJoin.answer(member, n.commit, CLOCK).answer;
    expect(twice).toEqual(once);
    // A different commitment gets a different answer nonce.
    const other = NewDeviceJoin.start(makeDevice(3), CONTEXT, N_RANDOM, CLOCK);
    const otherAnswer = MemberJoin.answer(member, other.commit, CLOCK).answer;
    expect(otherAnswer.subarray(-32)).not.toEqual(once.subarray(-32));
  });

  it("A takes one reveal and confirms once", () => {
    const run = runJoin(member, mac);
    expect(run.a.choices(run.reveal).sets).toEqual(run.sets);
    const otherN = NewDeviceJoin.start(makeDevice(4), CONTEXT, N_RANDOM, CLOCK);
    const otherReveal = otherN.reveal(
      MemberJoin.answer(member, otherN.commit, CLOCK).answer,
    ).reveal;
    expectCode(() => run.a.choices(otherReveal), "join_spent");
    const outcome = run.a.confirm(run.words, SEAL_RANDOM, NOW);
    expect(outcome.outcome).toBe("added");
    expectCode(() => run.a.confirm(run.words, SEAL_RANDOM, NOW), "join_spent");
    expectCode(() => run.a.choices(run.reveal), "join_spent");
  });

  it("A refuses to confirm before it has shown the sets", () => {
    const n = NewDeviceJoin.start(mac, CONTEXT, N_RANDOM, CLOCK);
    const a = MemberJoin.answer(member, n.commit, CLOCK);
    expectCode(() => a.confirm("none-match", SEAL_RANDOM, NOW), "bad_argument");
  });
});

describe("the random values are the package's to derive", () => {
  const world = makeWorld();
  const member = memberOf(world, world.gatewayDevice.listKey);

  it("N's nonce is hedged with N's key: one constant random still gives each device its own", () => {
    const zero = new Uint8Array(32);
    const a = NewDeviceJoin.start(makeDevice(2), CONTEXT, zero, CLOCK);
    const b = NewDeviceJoin.start(makeDevice(3), CONTEXT, zero, CLOCK);
    expect(commitmentOf(a.commit)).not.toEqual(commitmentOf(b.commit));
    // The nonce N reveals is not the caller's bytes, and differs between the two devices.
    const nonceOf = (n: NewDeviceJoin) => {
      const { reveal } = n.reveal(MemberJoin.answer(member, n.commit, CLOCK).answer);
      return reveal.slice(reveal.length - 128, reveal.length - 96);
    };
    const [na, nb] = [nonceOf(a), nonceOf(b)];
    expect(na).not.toEqual(zero);
    expect(na).not.toEqual(nb);
    // What the caller still owes: the same keys and the same random give the same commitment,
    // so every attempt needs fresh keys and fresh random bytes (README).
    expect(NewDeviceJoin.start(makeDevice(2), CONTEXT, zero, CLOCK).commit).toEqual(a.commit);
  });

  it("A's answer nonce takes no caller random, and no one without A's key can predict it", () => {
    const n = NewDeviceJoin.start(makeDevice(2), CONTEXT, N_RANDOM, CLOCK);
    const nonceOf = (key: number) => {
      const other = makeWorld({ gatewayDevice: fill(32, key) });
      return MemberJoin.answer(
        memberOf(other, other.gatewayDevice.listKey),
        n.commit,
        CLOCK,
      ).answer.subarray(-32);
    };
    // Two members with the same list position answering one commitment: different nonces.
    expect(nonceOf(0x51)).not.toEqual(nonceOf(0x52));
  });

  it("a predictable sealing random gives the service nothing: the ephemeral is hedged", () => {
    const zero = new Uint8Array(32);
    const one = runJoin(member, makeDevice(2));
    const two = runJoin(member, makeDevice(3));
    const outcomes = [one.a.confirm(one.words, zero, NOW), two.a.confirm(two.words, zero, NOW)];
    const encs = outcomes.map((outcome) => {
      if (outcome.outcome !== "added") throw new Error("expected added");
      const entryLength =
        (outcome.confirm[37 + 1 + 32 + 32] ?? 0) * 256 +
        (outcome.confirm[37 + 1 + 32 + 32 + 1] ?? 0);
      const at = 37 + 1 + 32 + 32 + 2 + entryLength;
      return outcome.confirm.subarray(at, at + 32);
    });
    // The ephemeral isn't the one a zero seed gives, and two joins don't share one.
    expect(encs[0]).not.toEqual(deriveSealKeyPair(zero).publicKey);
    expect(encs[0]).not.toEqual(encs[1]);
  });

  it("the decoys come from A's key and the transcript: another key gives other decoys", () => {
    const run = runJoin(member, makeDevice(2));
    const transcript = transcriptOf(run.reveal);
    const right = wordsFor(transcript);
    const mine = fiveSets(transcript, right, world.gatewayDevice.listKey);
    const anothers = fiveSets(transcript, right, makeDevice(9).listKey);
    expect(mine.sets).toEqual(run.sets);
    expect(anothers.sets).not.toEqual(mine.sets);
  });
});

describe("the pick", () => {
  const world = makeWorld();
  const member = memberOf(world, world.gatewayDevice.listKey);

  it("is judged by the words picked: the right set adds, a decoy shown is refused as a wrong set", () => {
    const run = runJoin(member, makeDevice(2));
    const decoy = run.sets[(run.right + 1) % 5]!;
    const outcome = run.a.confirm(decoy, SEAL_RANDOM, NOW);
    expect(outcome.outcome).toBe("refused");
    if (outcome.outcome === "refused")
      expect(verifyRefusal(world.state, outcome.refusal, [world.state.head]).reason).toBe(
        "wrong-set",
      );
  });

  it("none match and not started sign refusals the connector accepts once, by hash", () => {
    for (const pick of ["none-match", "not-started"] as const) {
      const run = runJoin(member, makeDevice(2));
      const outcome = run.a.confirm(pick, SEAL_RANDOM, NOW);
      if (outcome.outcome !== "refused") throw new Error("expected refused");
      const refusal = verifyRefusal(world.state, outcome.refusal, [world.state.head]);
      expect(refusal.reason).toBe(pick);
      expect(refusal.hash).toHaveLength(32);
      expect(verifyRefusal(world.state, outcome.refusal, [world.state.head]).hash).toEqual(
        refusal.hash,
      );
    }
  });

  it("refuses words that weren't among the five sets shown", () => {
    const run = runJoin(member, makeDevice(2));
    for (const pick of [
      ["abandon", "ability", "able"],
      [...run.words].reverse(),
      run.words.slice(0, 2),
      "yes",
    ]) {
      expectCode(() => run.a.confirm(pick as never, SEAL_RANDOM, NOW), "bad_argument");
    }
  });

  it("a member can refuse before any pick, and the connector can neither refuse nor have its refusal taken", () => {
    const n = NewDeviceJoin.start(makeDevice(2), CONTEXT, N_RANDOM, CLOCK);
    const refusal = refuseJoin(member, n.commit, "concurrent");
    expect(verifyRefusal(world.state, refusal, [world.state.head]).reason).toBe("concurrent");
    expectCode(
      () => refuseJoin({ key: world.connector, state: world.state }, n.commit, "not-started"),
      "not_permitted",
    );
    // A refusal the connector signed, built by hand: verifyRefusal refuses it.
    const forged = forgeRefusal({
      signer: world.connector,
      context: CONTEXT,
      listHead: world.state.head,
      commitment: commitmentOf(n.commit),
      reason: 2,
    });
    expectCode(() => verifyRefusal(world.state, forged, [world.state.head]), "not_permitted");
  });
});

describe("the five sets", () => {
  const world = makeWorld();
  const member = memberOf(world, world.gatewayDevice.listKey);

  it("hold the right set once and four decoys that share no word with it or each other", () => {
    for (let i = 0; i < 100; i++) {
      const run = runJoin(member, makeDevice(2), seeded(i).bytes(32));
      const words = run.sets.flat();
      expect(new Set(words).size).toBe(15 - (3 - new Set(run.words).size));
      expect(run.sets.filter((set) => set.join() === run.words.join())).toHaveLength(1);
      const decoyWords = run.sets.filter((_, index) => index !== run.right).flat();
      for (const word of run.words) expect(decoyWords).not.toContain(word);
    }
  });

  it("put the right set at each of the five places about equally often", () => {
    const places = [0, 0, 0, 0, 0];
    for (let i = 0; i < 500; i++)
      places[runJoin(member, makeDevice(2), seeded(1000 + i).bytes(32)).right]!++;
    // Each expected 100 times.
    for (const count of places) expect(count).toBeGreaterThan(60);
  });
});

describe("someone in the middle", () => {
  const world = makeWorld();
  const member = memberOf(world, world.gatewayDevice.listKey);
  const mac = makeDevice(2);
  const thief = makeDevice(66, "MacBook Pro");

  it("swapping N's keys gives different words", () => {
    const real = runJoin(member, mac);
    const forged = runJoin(member, thief, fill(32, 0x99));
    expect(forged.words).not.toEqual(real.words);
    expect(forged.sets.map((set) => set.join())).not.toContain(real.words.join());
    const n = NewDeviceJoin.start(mac, CONTEXT, N_RANDOM, CLOCK);
    expectCode(() => n.reveal(forged.answer), "transcript_mismatch");
  });

  it("swapping A's answer gives different words", () => {
    const real = runJoin(member, mac);
    const n = NewDeviceJoin.start(mac, CONTEXT, N_RANDOM, CLOCK);
    const fake = forgeAnswer({
      context: CONTEXT,
      commitment: commitmentOf(n.commit),
      memberKey: thief.listKey.publicKey,
      listHead: world.state.head,
      cardHash: cardHash(world.card),
      nonce: fill(32, 0x77),
    });
    const { reveal, words } = n.reveal(fake);
    expect(words).not.toEqual(real.words);
    const a = MemberJoin.answer(member, n.commit, CLOCK);
    expectCode(() => a.choices(reveal), "transcript_mismatch");
  });

  it("a commitment can't be opened to other keys", () => {
    const real = runJoin(member, mac);
    const thiefRun = runJoin(member, thief);
    const a = MemberJoin.answer(member, real.commit, CLOCK);
    expectCode(() => a.choices(thiefRun.reveal), "commitment_mismatch");
  });

  it("a replayed reveal, confirmation or entry fails", () => {
    const first = addDevice(world, world.gatewayDevice.listKey, mac);
    // The old confirmation delivered to a new join of the same device.
    const later = runJoin(member, mac, fill(32, 7));
    expectCode(
      () => later.n.finish(first.confirm, first.sealed, first.head),
      "transcript_mismatch",
    );
    // The entry appended a second time.
    expectCode(() => first.held.state.append(first.entry), "bad_chain");
  });

  it("refuses a device whose keys are already on the list", () => {
    const first = addDevice(world, world.gatewayDevice.listKey, mac);
    const n = NewDeviceJoin.start(mac, CONTEXT, fill(32, 9), CLOCK);
    const a = MemberJoin.answer(
      memberOf(world, world.gatewayDevice.listKey, first.held),
      n.commit,
      CLOCK,
    );
    const { reveal } = n.reveal(a.answer);
    expectCode(() => a.choices(reveal), "duplicate_key");
  });

  it("can't steer the words: they spread evenly over the list", () => {
    const counts = new Map<string, number>();
    const rng = seeded(7);
    for (let i = 0; i < 20000; i++) {
      for (const word of wordsFor(rng.bytes(32))) counts.set(word, (counts.get(word) ?? 0) + 1);
    }
    expect(counts.size).toBe(2048);
    expect(Math.max(...counts.values())).toBeLessThan(60);
  });
});

describe("what N checks before it is handed anything", () => {
  const world = makeWorld();
  /** The connector's head of a list, when it verifies; else the world's (the list fails first). */
  const headFor = (entries: Uint8Array[]) => {
    try {
      return headOf(world, { state: chain(CONTEXT, entries), entries });
    } catch {
      return headOf(world);
    }
  };
  const a = world.gatewayDevice;
  const member = memberOf(world, a.listKey);
  const mac = makeDevice(2);

  /** A join up to N's reveal, and a confirmation A signs with the given changes. */
  function setUp(change: {
    entryState?: typeof world.state;
    transcript?: Uint8Array;
    card?: Uint8Array;
    listEntries?: (entry: Uint8Array) => Uint8Array[];
  }) {
    const run = runJoin(member, mac);
    const transcript = transcriptOf(run.reveal);
    const entry = signAdd(
      a.listKey,
      change.entryState ?? world.state,
      mac.device,
      change.transcript ?? transcript,
    );
    const confirm = forgeConfirm({
      member: a.listKey,
      context: CONTEXT,
      transcript,
      entry,
      sealTo: mac.device.sealKey,
      secret: world.secret,
      card: change.card ?? world.card,
    });
    const entries = change.listEntries?.(entry) ?? [...world.entries, entry];
    const sealed = sealList(world.secret, CONTEXT, entries, LIST_RANDOM, headObject(world));
    return () => run.n.finish(confirm, sealed, headFor(entries));
  }

  it("takes the honest confirmation, and hands back only the word back's prompt", () => {
    const prompt = setUp({})();
    expect(prompt.mode).toBe("member");
    expect(Object.keys(prompt).sort()).toEqual(["choices", "mode", "under"]);
  });

  it("refuses an entry that doesn't follow the head the words covered", () => {
    const moved = world.state.append(
      signAdd(a.listKey, world.state, makeDevice(5).device, fill(32, 1)),
    );
    expectCode(setUp({ entryState: moved }), "bad_chain");
  });

  it("refuses an entry carrying another join's transcript", () => {
    expectCode(setUp({ transcript: fill(32, 0x3e) }), "transcript_mismatch");
  });

  it("refuses a card the words didn't cover", () => {
    const newer = signCard(world.connector, {
      ...verifyCard(world.card, world.connector.publicKey, CONTEXT.gatewayId),
      serial: 2,
    });
    expectCode(setUp({ card: newer }), "card_mismatch");
  });

  it("refuses a list that doesn't hold N's entry after the covered head", () => {
    expectCode(setUp({ listEntries: () => [...world.entries] }), "bad_chain");
  });

  it("refuses a card for another gateway, even one the words covered", () => {
    // A member gone wrong answers with a card the connector signed for another gateway.
    const otherCard = signCard(world.connector, {
      ...verifyCard(world.card, world.connector.publicKey, CONTEXT.gatewayId),
      gatewayId: OTHER_GATEWAY.gatewayId,
    });
    const n = NewDeviceJoin.start(mac, CONTEXT, N_RANDOM, CLOCK);
    const answer = forgeAnswer({
      context: CONTEXT,
      commitment: commitmentOf(n.commit),
      memberKey: a.listKey.publicKey,
      listHead: world.state.head,
      cardHash: cardHash(otherCard),
      nonce: fill(32, 0x31),
    });
    const { reveal } = n.reveal(answer);
    const transcript = transcriptOf(reveal);
    const entry = signAdd(a.listKey, world.state, mac.device, transcript);
    const confirm = forgeConfirm({
      member: a.listKey,
      context: CONTEXT,
      transcript,
      entry,
      sealTo: mac.device.sealKey,
      secret: world.secret,
      card: otherCard,
    });
    const sealed = sealList(
      world.secret,
      CONTEXT,
      [...world.entries, entry],
      LIST_RANDOM,
      headObject(world),
    );
    expectCode(
      () => n.finish(confirm, sealed, headFor([...world.entries, entry])),
      "wrong_gateway",
    );
  });

  it("refuses when the confirming device is no longer a member", () => {
    const run = runJoin(member, mac);
    const outcome = run.a.confirm(run.words, SEAL_RANDOM, NOW);
    if (outcome.outcome !== "added") throw new Error("expected added");
    let held = appended(world, outcome.entry);
    // A removes itself (the gateway's own device may) before N's list is sealed.
    held = appended(held, signRemoval(a.listKey, held.state, a.device.listKey));
    const sealed = sealList(world.secret, CONTEXT, held.entries, LIST_RANDOM, headObject(world));
    expectCode(
      () => run.n.finish(outcome.confirm, sealed, headFor([...held.entries])),
      "not_member",
    );
  });

  it("refuses a list sealed under another secret", () => {
    const run = runJoin(member, mac);
    const outcome = run.a.confirm(run.words, SEAL_RANDOM, NOW);
    if (outcome.outcome !== "added") throw new Error("expected added");
    const sealed = sealList(
      ListSecret.fromBytes(fill(32, 0x0e), 0),
      CONTEXT,
      [...world.entries, outcome.entry],
      LIST_RANDOM,
      headObject(world),
    );
    expectCode(() => run.n.finish(outcome.confirm, sealed, headOf(world)), "decrypt_failed");
  });
});
