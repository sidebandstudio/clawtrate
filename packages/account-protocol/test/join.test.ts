// The join from both sides, and against someone in the middle: the service, which carries
// every message and can change, swap, hold back or replay any of them.

import { describe, expect, it, vi } from "vitest";
import {
  cardHash,
  joinAnswer,
  joinChoices,
  joinCommit,
  joinConfirm,
  joinFinish,
  joinReveal,
  ListState,
  refuseJoin,
  signCard,
  verifyCard,
  verifyRefusal,
  wordsFor,
} from "../src/index.ts";
import {
  A_NONCE,
  addDevice,
  CONTEXT,
  DECOY_SEED,
  expectCode,
  fill,
  makeDevice,
  makeWorld,
  memberOf,
  N_NONCE,
  runJoin,
  SEAL_SEED,
  seeded,
} from "./helpers.ts";

// Signatures and key checks are quick alone; on a loaded machine a test can take seconds.
vi.setConfig({ testTimeout: 120_000 });

describe("a join with no one in the middle", () => {
  it("shows the same words on both sides and adds the device", () => {
    const world = makeWorld();
    const member = memberOf(world, world.gatewayDevice.listKey);
    const mac = makeDevice(2, "MacBook Pro");
    const { run, entry, state, finished } = addDevice(member, mac);

    expect(run.right).toBeGreaterThanOrEqual(0);
    expect(run.sets).toHaveLength(5);
    expect(state.member(mac.device.listKey)?.role).toBe("device");
    expect(
      state.member(mac.device.listKey)?.addedBy?.equals(world.gatewayDevice.device.listKey),
    ).toBe(true);
    // The connector appends the same entry to the list it holds.
    expect(world.state.append(entry).head).toEqual(state.head);
    // N opened the list secret and the card the words covered.
    expect(finished.secret.epoch).toBe(0);
    expect(finished.cardBytes).toEqual(world.card);
    expect(finished.card.connectorKey.equals(world.connector.publicKey)).toBe(true);
    expect(finished.entry).toEqual(entry);
  });

  it("lets the device just added confirm the next one", () => {
    const world = makeWorld();
    const mac = makeDevice(2);
    const first = addDevice(memberOf(world, world.gatewayDevice.listKey), mac);
    const phone = makeDevice(3, "iPhone", "ios");
    const second = addDevice(memberOf(world, mac.listKey, first.state), phone);
    expect(second.state.devices()).toHaveLength(3);
    expect(second.state.member(phone.device.listKey)?.addedBy?.equals(mac.device.listKey)).toBe(
      true,
    );
  });

  it("refuses the connector as the answering member", () => {
    const world = makeWorld();
    const commit = joinCommit(makeDevice(2), CONTEXT, N_NONCE);
    expectCode(
      () => joinAnswer(memberOf(world, world.connector), commit, A_NONCE),
      "not_permitted",
    );
  });

  it("refuses a card that is not the list's connector's", () => {
    const world = makeWorld();
    const commit = joinCommit(makeDevice(2), CONTEXT, N_NONCE);
    const card = signCard(makeDevice(9).listKey, { ...verifyCard(world.card) });
    expectCode(
      () => joinAnswer({ ...memberOf(world, world.gatewayDevice.listKey), card }, commit, A_NONCE),
      "card_mismatch",
    );
  });
});

describe("the pick", () => {
  const world = makeWorld();
  const member = memberOf(world, world.gatewayDevice.listKey);
  const mac = makeDevice(2);
  const run = runJoin(member, mac);

  it("a wrong set, none match or not started signs a refusal the connector accepts", () => {
    const wrong = (run.right + 1) % 5;
    for (const [pick, reason] of [
      [{ set: wrong }, "wrong-set"],
      ["none-match", "none-match"],
      ["not-started", "not-started"],
    ] as const) {
      const outcome = joinConfirm(
        member,
        run.commit,
        run.answer,
        run.reveal,
        DECOY_SEED,
        pick,
        SEAL_SEED,
      );
      expect(outcome.outcome).toBe("refused");
      if (outcome.outcome !== "refused") continue;
      const refusal = verifyRefusal(world.state, outcome.refusal);
      expect(refusal.reason).toBe(reason);
      expect(refusal.signer.equals(world.gatewayDevice.device.listKey)).toBe(true);
    }
  });

  it("refuses a pick outside the five sets", () => {
    for (const pick of [{ set: 5 }, { set: -1 }, { set: 1.5 }, "yes" as never]) {
      expectCode(
        () => joinConfirm(member, run.commit, run.answer, run.reveal, DECOY_SEED, pick, SEAL_SEED),
        "bad_argument",
      );
    }
  });

  it("a member can refuse before any pick, and the connector can't refuse", () => {
    const refusal = refuseJoin(member, run.commit, "concurrent");
    expect(verifyRefusal(world.state, refusal).reason).toBe("concurrent");
    expectCode(
      () => refuseJoin({ key: world.connector, state: world.state }, run.commit, "not-started"),
      "not_permitted",
    );
  });

  it("refuses to go on when the list changed after the answer", () => {
    const other = addDevice(member, makeDevice(5), {
      n: fill(32, 1),
      a: fill(32, 2),
      decoy: fill(32, 3),
    });
    const moved = { ...member, state: other.state };
    expectCode(
      () => joinChoices(moved, run.commit, run.answer, run.reveal, DECOY_SEED),
      "bad_chain",
    );
  });
});

describe("the five sets", () => {
  const world = makeWorld();
  const member = memberOf(world, world.gatewayDevice.listKey);

  it("hold the right set once and four decoys that share no word with it or each other", () => {
    for (let i = 0; i < 200; i++) {
      const rng = seeded(i);
      const run = runJoin(member, makeDevice(2), {
        n: rng.bytes(32),
        a: rng.bytes(32),
        decoy: rng.bytes(32),
      });
      const words = run.sets.flat();
      expect(new Set(words).size).toBe(15 - (3 - new Set(run.words).size));
      expect(run.sets.filter((set) => set.join() === run.words.join())).toHaveLength(1);
      const decoyWords = run.sets.filter((_, index) => index !== run.right).flat();
      for (const word of run.words) expect(decoyWords).not.toContain(word);
    }
  });

  it("come from the member's own seed: the same messages with another seed give other decoys and place", () => {
    const run = runJoin(member, makeDevice(2));
    const seen = new Set<string>();
    const places = [0, 0, 0, 0, 0];
    for (let i = 0; i < 500; i++) {
      const { sets } = joinChoices(
        member,
        run.commit,
        run.answer,
        run.reveal,
        seeded(1000 + i).bytes(32),
      );
      const right = sets.findIndex((set) => set.join() === run.words.join());
      places[right]!++;
      seen.add(JSON.stringify(sets));
    }
    // Everything the service sees is the same in every one of these; only the seed changed.
    expect(seen.size).toBe(500);
    // The right set's place is spread over all five (each expected 100 times).
    for (const count of places) expect(count).toBeGreaterThan(60);
  }, 60_000);

  it("are the same for the same seed, so the pick checks the set that was shown", () => {
    const run = runJoin(member, makeDevice(2));
    const again = joinChoices(member, run.commit, run.answer, run.reveal, DECOY_SEED);
    expect(again.sets).toEqual(run.sets);
  });
});

describe("someone in the middle", () => {
  const world = makeWorld();
  const member = memberOf(world, world.gatewayDevice.listKey);
  const mac = makeDevice(2);
  const thief = makeDevice(66, "MacBook Pro");

  it("swapping N's keys gives different words", () => {
    // The service shows A the thief's commit and reveal instead of N's.
    const real = runJoin(member, mac);
    const forged = runJoin(member, thief, { n: fill(32, 0x99), a: A_NONCE, decoy: DECOY_SEED });
    expect(forged.words).not.toEqual(real.words);
    expect(forged.sets.map((set) => set.join())).not.toContain(real.words.join());
    // N, handed the answer A gave the thief's commit, refuses it: it answers another join.
    expectCode(
      () => joinReveal(mac, CONTEXT, N_NONCE, real.commit, forged.answer),
      "transcript_mismatch",
    );
  });

  it("swapping A's answer gives different words", () => {
    // The service answers N's commit itself, with a key and a nonce of its own.
    const real = runJoin(member, mac);
    const fakeAnswer = forgeAnswer(real.answer, thief.listKey.publicKey.bytes);
    const { reveal, words } = joinReveal(mac, CONTEXT, N_NONCE, real.commit, fakeAnswer);
    expect(words).not.toEqual(real.words);
    // A, handed N's reveal for that transcript, refuses it.
    expectCode(
      () => joinChoices(member, real.commit, real.answer, reveal, DECOY_SEED),
      "transcript_mismatch",
    );
  });

  it("a commitment can't be opened to other keys or another nonce", () => {
    const real = runJoin(member, mac);
    // The thief's reveal, with N's nonce, against N's commitment.
    const thiefRun = runJoin(member, thief);
    expectCode(
      () => joinChoices(member, real.commit, real.answer, thiefRun.reveal, DECOY_SEED),
      "commitment_mismatch",
    );
    // N's own record with another nonce.
    expectCode(
      () => joinReveal(mac, CONTEXT, fill(32, 0x12), real.commit, real.answer),
      "commitment_mismatch",
    );
  });

  it("a replayed reveal, confirmation or entry fails", () => {
    const first = addDevice(member, mac);
    // The old reveal against a fresh answer to the same commit: its signature covers A's old nonce.
    const fresh = joinAnswer(member, first.run.commit, fill(32, 0x23));
    expectCode(
      () => joinChoices(member, first.run.commit, fresh, first.run.reveal, DECOY_SEED),
      "transcript_mismatch",
    );
    // The old confirmation delivered to a new join of the same device.
    const later = runJoin(member, mac, { n: fill(32, 7), a: fill(32, 8), decoy: DECOY_SEED });
    expectCode(
      () =>
        joinFinish(
          mac,
          CONTEXT,
          fill(32, 7),
          later.commit,
          later.answer,
          later.reveal,
          first.confirm,
        ),
      "transcript_mismatch",
    );
    // The entry appended a second time.
    expectCode(() => first.state.append(first.entry), "bad_chain");
  });

  it("refuses a device whose keys are already on the list", () => {
    const first = addDevice(member, mac);
    const after = memberOf(world, world.gatewayDevice.listKey, first.state);
    const commit = joinCommit(mac, CONTEXT, fill(32, 9));
    const answer = joinAnswer(after, commit, fill(32, 10));
    const { reveal } = joinReveal(mac, CONTEXT, fill(32, 9), commit, answer);
    expectCode(() => joinChoices(after, commit, answer, reveal, DECOY_SEED), "duplicate_key");
  });

  it("can't steer the words: they spread evenly over the list", () => {
    // Each try at matching words is one chance in 2^33 only if no word is likelier than another.
    const counts = new Map<string, number>();
    const rng = seeded(7);
    for (let i = 0; i < 20000; i++) {
      for (const word of wordsFor(rng.bytes(32))) counts.set(word, (counts.get(word) ?? 0) + 1);
    }
    // 60,000 words over 2,048: about 29 each.
    expect(counts.size).toBe(2048);
    expect(Math.max(...counts.values())).toBeLessThan(60);
  });
});

/** The service's own answer to N's commit: its key and its nonce in place of A's. */
function forgeAnswer(answer: Uint8Array, key: Uint8Array): Uint8Array {
  const out = answer.slice();
  const keyAt = answer.length - 32 * 4;
  out.set(key, keyAt);
  out.set(fill(32, 0x77), answer.length - 32);
  return out;
}

describe("what N checks before it uses the card", () => {
  it("refuses a card other than the one the words covered", () => {
    const world = makeWorld();
    const member = memberOf(world, world.gatewayDevice.listKey);
    const mac = makeDevice(2);
    const run = runJoin(member, mac);
    // A member that sends a card other than the one it answered with: here, a newer card.
    const newer = signCard(world.connector, { ...verifyCard(world.card), serial: 2 });
    expect(cardHash(newer)).not.toEqual(cardHash(world.card));
    expectCode(
      () =>
        joinConfirm(
          { ...member, card: newer },
          run.commit,
          run.answer,
          run.reveal,
          DECOY_SEED,
          { set: run.right },
          SEAL_SEED,
        ),
      "card_mismatch",
    );
  });

  it("keeps ListState immutable across a join", () => {
    const world = makeWorld();
    const before = world.state.head;
    addDevice(memberOf(world, world.gatewayDevice.listKey), makeDevice(2));
    expect(world.state.head).toEqual(before);
    expect(world.state).toBeInstanceOf(ListState);
  });
});
