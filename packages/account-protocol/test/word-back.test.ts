// The word back (design §4.4 step 5a): after a right pick on A, the new device uses nothing it
// was sent until the person picks, on N, the word A shows under N's own three words. And the
// first join of a gateway on a server with no app (§8.4), confirmed at the server's terminal.

import { describe, expect, it, vi } from "vitest";
import {
  encodeRemovalNotice,
  JOIN_PAUSE_MS,
  ListSecretKey,
  ListState,
  MemberJoin,
  NewDeviceJoin,
  sealList,
  ServerFirstDeviceJoin,
  signRemovalNotice,
  WORD_BACK_MS,
} from "../src/index.ts";
import {
  addDevice,
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
  memberOf,
  N_RANDOM,
  NOW,
  runJoin,
  SEAL_RANDOM,
  seeded,
  type World,
  fresh,
} from "./helpers.ts";

// Signatures and key checks are quick alone; on a loaded machine a test can take seconds.
vi.setConfig({ testTimeout: 120_000 });

/** A join up to N's finish: A's right pick, the connector's append, N's checks and prompt. */
function upToTheWord(world: World, random = N_RANDOM) {
  const mac = makeDevice(2, "MacBook Pro");
  const run = runJoin(memberOf(world, world.gatewayDevice.listKey), mac, random);
  const outcome = run.a.confirm(run.words, SEAL_RANDOM, NOW);
  if (outcome.outcome !== "added") throw new Error("expected added");
  const after = appended(world, outcome.entry);
  const sealed = sealList(
    world.secret,
    CONTEXT,
    after.entries,
    LIST_RANDOM,
    headObject(world, after),
  );
  const prompt = run.n.finish(outcome.confirm, sealed, headOf(world, after), null);
  return { run, outcome, prompt, mac };
}

describe("the word back", () => {
  it("A shows its word under N's three words and N's name, for two minutes at most", () => {
    const world = makeWorld();
    const { run, outcome } = upToTheWord(world);
    if (outcome.outcome !== "added") throw new Error("expected added");
    expect(outcome.wordBack.under).toEqual(run.words);
    expect(outcome.wordBack.name).toBe("MacBook Pro");
    expect(outcome.wordBack.showUntilMs).toBe(NOW + WORD_BACK_MS);
  });

  it("N shows its own words once, above five words: the right one and four of its own, all different", () => {
    const world = makeWorld();
    const { run, outcome, prompt } = upToTheWord(world);
    if (outcome.outcome !== "added") throw new Error("expected added");
    expect(prompt.under).toEqual(run.words);
    expect(prompt.choices).toHaveLength(5);
    expect(new Set(prompt.choices).size).toBe(5);
    expect(prompt.choices).toContain(outcome.wordBack.word);
  });

  it("puts the right word at each of the five places about equally often", () => {
    const places = [0, 0, 0, 0, 0];
    const world = makeWorld();
    for (let i = 0; i < 250; i++) {
      const { outcome, prompt } = upToTheWord(world, seeded(i).bytes(32));
      if (outcome.outcome !== "added") throw new Error("expected added");
      places[prompt.choices.indexOf(outcome.wordBack.word)]!++;
    }
    for (const count of places) expect(count).toBeGreaterThan(25);
  });

  it("hands back the secret, card and list only on the right word, picked under N's words", () => {
    const world = makeWorld();
    const { outcome, prompt, run } = upToTheWord(world);
    if (outcome.outcome !== "added") throw new Error("expected added");
    // The word picked under other words is no pick at all.
    expectCode(
      () =>
        run.n.pickWord({ under: ["abandon", "ability", "able"], word: outcome.wordBack.word }, NOW),
      "bad_argument",
    );
    expectCode(
      () =>
        run.n.pickWord(
          { under: prompt.under, word: "zoo" === outcome.wordBack.word ? "zone" : "zoo" },
          NOW,
        ),
      "bad_argument",
    );
    const picked = run.n.pickWord({ under: prompt.under, word: outcome.wordBack.word }, NOW);
    if (picked.outcome !== "confirmed") throw new Error("expected confirmed");
    expect(picked.result.confirmedOn).toBe("Windows PC");
    expect(picked.result.state.length).toBe(2);
    expectCode(
      () => run.n.pickWord({ under: prompt.under, word: outcome.wordBack.word }, NOW),
      "join_spent",
    );
  });

  it("a wrong word, none match or not confirmed ends the attempt, keeps nothing, and pauses N for an hour", () => {
    for (const pick of ["wrong", "none-match", "not-confirmed"] as const) {
      const world = makeWorld();
      const { outcome, prompt, run } = upToTheWord(world);
      if (outcome.outcome !== "added") throw new Error("expected added");
      const choice =
        pick === "wrong"
          ? { under: prompt.under, word: prompt.choices.find((w) => w !== outcome.wordBack.word)! }
          : pick;
      const picked = run.n.pickWord(choice, NOW);
      expect(picked).toEqual({ outcome: "refused", pauseUntilMs: NOW + JOIN_PAUSE_MS });
      expectCode(
        () => run.n.pickWord({ under: prompt.under, word: outcome.wordBack.word }, NOW),
        "join_spent",
      );
      // N starts no join while the pause lasts.
      expectCode(
        () =>
          NewDeviceJoin.start(fresh(makeDevice(5)), CONTEXT, N_RANDOM, {
            nowMs: NOW + 1,
            pausedUntilMs: NOW + JOIN_PAUSE_MS,
          }),
        "paused",
      );
    }
  });

  it("a fake gateway the service runs passes every check, and is stopped only by the word back", () => {
    // The reviewer's case, turned round. The service builds its own connector and "member"
    // under the real gateway's and account's ids; N's checks all pass, because the list is the
    // service's own. No real member saw this join, so no real device shows a word under N's
    // three words; the person, looking at their own device, picks "I didn't confirm anything".
    const real = makeWorld();
    const fake = makeWorld({ connector: fill(32, 0xee), gatewayDevice: fill(32, 0xef) });
    const { prompt, run } = upToTheWord(fake);
    expect(prompt.mode).toBe("member");
    const picked = run.n.pickWord("not-confirmed", NOW);
    expect(picked.outcome).toBe("refused");
    // A real join at the same time, of another new device, shows the person other words.
    const realRun = upToTheWord(real, fill(32, 0x77));
    expect(realRun.prompt.under).not.toEqual(prompt.under);
  });
});

describe("pauses", () => {
  it("A answers no join while its own pause lasts, and a refusal tells it until when", () => {
    const world = makeWorld();
    const member = memberOf(world, world.gatewayDevice.listKey);
    const run = runJoin(member, makeDevice(2));
    const outcome = run.a.confirm("not-started", SEAL_RANDOM, NOW);
    if (outcome.outcome !== "refused") throw new Error("expected refused");
    expect(outcome.pauseUntilMs).toBe(NOW + JOIN_PAUSE_MS);
    const n = NewDeviceJoin.start(fresh(makeDevice(3)), CONTEXT, N_RANDOM, CLOCK);
    expectCode(
      () =>
        MemberJoin.answer(member, n.commit, {
          nowMs: NOW + 1,
          pausedUntilMs: outcome.pauseUntilMs,
        }),
      "paused",
    );
    expect(
      MemberJoin.answer(member, n.commit, {
        nowMs: outcome.pauseUntilMs,
        pausedUntilMs: outcome.pauseUntilMs,
      }).answer,
    ).toHaveLength(37 + 1 + 32 + 32 * 5);
    expectCode(
      () => MemberJoin.answer(member, n.commit, { nowMs: 1.5, pausedUntilMs: 0 }),
      "bad_time",
    );
  });
});

describe("a server's first join", () => {
  function install(seed = 0xc5) {
    const world = makeWorld({ connector: fill(32, seed) });
    return {
      world,
      install: {
        connector: world.connector,
        context: CONTEXT,
        card: world.card,
        random: fill(32, 0x5d),
      },
    };
  }

  it("makes the list's first entry with that device, confirmed at the terminal, after its word back", () => {
    const { world, install: inst } = install();
    const phone = makeDevice(4, "iPhone", "ios");
    const server = ServerFirstDeviceJoin.open(inst);
    const n = NewDeviceJoin.start(fresh(phone), CONTEXT, N_RANDOM, CLOCK);
    const answer = server.answer(n.commit);
    expect(server.answer(n.commit)).toEqual(answer);
    const { reveal, words } = n.reveal(answer);
    const { sets } = server.choices(reveal);
    const outcome = server.confirm(
      sets.find((set) => set.join() === words.join())!,
      SEAL_RANDOM,
      NOW,
    );
    if (outcome.outcome !== "added") throw new Error("expected added");
    const prompt = n.finish(outcome.confirm, null, null, null);
    expect(prompt.mode).toBe("first-device");
    const picked = n.pickWord({ under: prompt.under, word: outcome.wordBack.word }, NOW);
    if (picked.outcome !== "confirmed") throw new Error("expected confirmed");
    // The connector starts its list from the entry N returns.
    const state = ListState.fromGenesis(CONTEXT, picked.result.firstEntry!);
    expect(state.member(phone.device.listKey)?.role).toBe("gateway-device");
    expect(picked.result.secret.epoch).toBe(0);
    // That first device holds the gateway device's protection: the account page can't remove it.
    expectCode(
      () =>
        signRemovalNotice(
          world.connector,
          state,
          encodeRemovalNotice(CONTEXT, phone.device.listKey),
        ),
      "protected_member",
    );
  });

  it("ends for good on a second commitment, and on any refusal at the terminal", () => {
    const { install: inst } = install();
    const server = ServerFirstDeviceJoin.open(inst);
    server.answer(NewDeviceJoin.start(fresh(makeDevice(4)), CONTEXT, N_RANDOM, CLOCK).commit);
    expectCode(
      () =>
        server.answer(NewDeviceJoin.start(fresh(makeDevice(5)), CONTEXT, N_RANDOM, CLOCK).commit),
      "join_spent",
    );
    expectCode(
      () =>
        server.answer(NewDeviceJoin.start(fresh(makeDevice(4)), CONTEXT, N_RANDOM, CLOCK).commit),
      "join_spent",
    );
    const second = ServerFirstDeviceJoin.open(inst);
    const n = NewDeviceJoin.start(fresh(makeDevice(4)), CONTEXT, N_RANDOM, CLOCK);
    second.choices(n.reveal(second.answer(n.commit)).reveal);
    expect(second.confirm("none-match", SEAL_RANDOM, NOW)).toEqual({ outcome: "refused" });
    expectCode(() => second.confirm("none-match", SEAL_RANDOM, NOW), "join_spent");
  });

  it("refuses a device using the connector's key", () => {
    const { install: inst } = install();
    const sneaky = makeDevice(4, "Phone", "ios", fill(32, 0xc5));
    const server = ServerFirstDeviceJoin.open(inst);
    const n = NewDeviceJoin.start(fresh({ ...sneaky }), CONTEXT, N_RANDOM, CLOCK);
    const { reveal } = n.reveal(server.answer(n.commit));
    expectCode(() => server.choices(reveal), "duplicate_key");
    expect(ListSecretKey.fromSeed(fill(32, 0xc5)).publicKey.equals(inst.connector.publicKey)).toBe(
      true,
    );
  });

  it("a device told it is in first-device mode by a service that lies sees a prompt naming the terminal", () => {
    // A member's join answered as if it were a server's: N's prompt says the word is on the
    // server's terminal, which a person adding a device to a gateway with an app doesn't have.
    const { install: inst } = install();
    const server = ServerFirstDeviceJoin.open(inst);
    const n = NewDeviceJoin.start(fresh(makeDevice(4)), CONTEXT, N_RANDOM, CLOCK);
    const { reveal, words } = n.reveal(server.answer(n.commit));
    const { sets } = server.choices(reveal);
    const outcome = server.confirm(
      sets.find((set) => set.join() === words.join())!,
      SEAL_RANDOM,
      NOW,
    );
    if (outcome.outcome !== "added") throw new Error("expected added");
    expect(n.finish(outcome.confirm, null, null, null).mode).toBe("first-device");
  });
});

describe("the whole join, end to end", () => {
  it("adds the device and hands it the list at the connector's head", () => {
    const world = makeWorld();
    const { finished, head } = addDevice(world, world.gatewayDevice.listKey, makeDevice(2));
    expect(finished.head?.bytes).toEqual(head);
    expect(finished.firstEntry).toBeNull();
  });
});
