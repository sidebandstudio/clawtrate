import { describe, expect, it } from "vitest";
import { EXPIRES_MS, admit, decline } from "../lib/ledger.js";
import { Records } from "../lib/records.js";
import { load, memoryStore } from "./harness.ts";

const T = 1_800_000_000_000;
const entry = (id: string, digest: string, source: object, bot: string, at = T) => ({
  id,
  digest,
  source,
  bot: { id: bot, createdAt: 1 },
  fields: ["label"],
  createdAt: at,
  expiresAt: at + EXPIRES_MS,
});
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => "admitted",
    (e) => e.reason ?? e.message,
  );
async function propose(records: Records, id: string, source: object, bot: string) {
  const digest = await records.persist(id, { id, bot });
  return records.publish(id, digest, (l, at) => admit(l, entry(id, digest, source, bot, at), at));
}
const reasonOf = (answer: { error?: { details?: Record<string, unknown> } | undefined }) =>
  answer.error?.details?.reason;

describe("the records", () => {
  it("two proposals racing for the last slot: one admitted, one refused, the count at the limit", async () => {
    for (const [limit, racers] of [
      [20, ["pip", "pip"]],
      [200, ["s9", "s10"]],
    ] as const) {
      const records = new Records(memoryStore(), memoryStore(), { now: () => T });
      for (let i = 0; i < limit - 1; i += 1)
        await propose(
          records,
          `p${i}`,
          { kind: "bot", bot: limit === 20 ? "pip" : `s${Math.floor(i / 20)}` },
          `b${i}`,
        );
      const raced = await Promise.all(
        racers.map((s, i) => outcome(propose(records, `r${i}`, { kind: "bot", bot: s }, `r${i}`))),
      );
      expect(raced.sort()).toEqual(["admitted", limit === 20 ? "source-limit" : "open-limit"]);
      const open = Object.values((await records.ledger()).proposals).filter(
        (e) => e.state === "open",
      );
      expect(open).toHaveLength(limit);
    }
  });

  it("readers use only versions that read and match: missing, corrupt and changed ones are unreadable", async () => {
    const store = memoryStore();
    const records = new Records(memoryStore(), store, { now: () => T });
    for (const id of ["a", "b", "c"]) await propose(records, id, { kind: "bot", bot: id }, id);
    const { proposals } = await records.ledger();
    store.rows.set("v:a", { json: JSON.stringify({ digest: proposals.a.digest }), rev: 900 });
    store.faults.corrupt.add("v:b");
    const row = JSON.parse(store.rows.get("v:c")!.json);
    store.rows.set("v:c", {
      json: JSON.stringify({ ...row, body: { id: "c", bot: "otto" } }),
      rev: 901,
    });
    for (const id of ["a", "b", "c"])
      expect(await records.version(id, proposals[id].digest)).toBeNull();
  });

  it("publishing checks, after each observation, that its version exists and reads", async () => {
    const store = memoryStore();
    const records = new Records(memoryStore(), store, { now: () => T });
    const digest = await records.persist("p", { id: "p" });
    store.rows.delete("v:p");
    const publish = records.publish("p", digest, (l, at) =>
      admit(l, entry("p", digest, { kind: "bot", bot: "pip" }, "pip", at), at),
    );
    await expect(publish).rejects.toMatchObject({ reason: "unpublishable" });
    expect((await records.ledger()).proposals).toEqual({});
  });

  it("reopening Records over the same stores: before publication nothing was admitted, after it the entry is there once", async () => {
    const [store, versions] = [memoryStore(), memoryStore()];
    const unpublished = await new Records(store, versions, { now: () => T }).persist("u", {
      id: "u",
    });
    const reopened = new Records(store, versions, { now: () => T + 1 });
    expect((await reopened.ledger()).proposals).toEqual({});
    expect(await reopened.version("u", unpublished)).toEqual({ id: "u" });
    await propose(reopened, "p", { kind: "bot", bot: "pip" }, "pip");
    const digest = (await reopened.ledger()).proposals.p.digest;
    const again = new Records(store, versions, { now: () => T + 2 });
    const { proposals } = await again.ledger();
    expect(Object.keys(proposals)).toEqual(["p"]);
    expect(proposals.p).toMatchObject({ digest, state: "open" });
    expect(await again.version("p", digest)).toEqual({ id: "p", bot: "pip" });
  });

  it("a full versions namespace refuses new records with records-full, and decisions still commit", async () => {
    const records = new Records(memoryStore(), memoryStore({ maxEntries: 2 }), { now: () => T });
    await propose(records, "a", { kind: "bot", bot: "pip" }, "a");
    await propose(records, "b", { kind: "bot", bot: "pip" }, "b");
    await expect(propose(records, "c", { kind: "bot", bot: "pip" }, "c")).rejects.toMatchObject({
      reason: "records-full",
    });
    const { digest } = (await records.ledger()).proposals.a;
    await records.transact((l, at) => decline(l, "a", digest, "dev", at));
    expect((await records.ledger()).proposals.a.state).toBe("declined");
  });
});

describe("the plugin's methods", () => {
  const setup = async () => {
    const host = load({ now: () => T });
    const grant = (
      await host.call("relay.grants.set", {
        scope: "suggest",
        bots: ["pip"],
        includeInstructions: true,
      })
    ).payload!;
    const suggest = (params: Record<string, unknown>, generation = grant.generation) =>
      host.call("relay.propose", {
        grant: grant.id,
        generation,
        bot: "pip",
        fields: { label: "x" },
        ...params,
      });
    return { host, grant, suggest };
  };

  it("records a suggestion with its bot's incarnation, refuses accept, and reads nothing but agents.list", async () => {
    const { host, suggest } = await setup();
    const sent = (await suggest({ fields: { name: "  Scout   Bot " } })).payload!;
    expect(sent).toMatchObject({
      status: "proposed",
      fields: ["name"],
      bot: { id: "pip", createdAt: 2 },
    });
    const got = (await host.call("proposals.get", { id: sent.proposalId })).payload!;
    expect(got).toMatchObject({
      state: "open",
      payload: { name: "Scout Bot" },
      bot: { id: "pip", createdAt: 2 },
    });
    expect(typeof got.gateway).toBe("string");
    expect(
      reasonOf(await host.call("proposals.accept", { id: sent.proposalId, digest: sent.digest })),
    ).toBe("apply-unavailable");
    expect(new Set(host.dispatched)).toEqual(new Set(["agents.list"]));
    expect(host.events.length).toBeGreaterThan(0);
  });

  it("decisions need a direct operator request: not an in-process call, even with an operator client", async () => {
    const { host, grant, suggest } = await setup();
    const sent = (await suggest({})).payload!;
    const decide = { id: sent.proposalId, digest: sent.digest };
    for (const how of [{ inProcess: true }, { synthetic: true }]) {
      expect(reasonOf(await host.call("proposals.accept", decide, how))).toBe("operator-required");
      expect(reasonOf(await host.call("proposals.decline", decide, how))).toBe("operator-required");
      expect(
        reasonOf(await host.call("relay.grants.set", { id: grant.id, revoke: true }, how)),
      ).toBe("operator-required");
      expect(
        reasonOf(
          await host.call(
            "relay.propose",
            { grant: grant.id, generation: 1, bot: "pip", fields: { label: "y" } },
            how,
          ),
        ),
      ).toBe("operator-required");
    }
    expect((await host.call("status", {}, { inProcess: true })).ok).toBe(true);
    expect((await host.call("proposals.get", { id: sent.proposalId })).payload).toMatchObject({
      state: "open",
    });
  });

  it("ids are checked before they index anything", async () => {
    const { host } = await setup();
    expect(reasonOf(await host.call("proposals.get", { id: "__proto__" }))).toBe("invalid");
    expect(reasonOf(await host.call("relay.grants.get", { id: "constructor" }))).toBe("invalid");
    expect(reasonOf(await host.call("relay.grants.set", { id: "toString", revoke: true }))).toBe(
      "invalid",
    );
  });

  it("permissions come from the grant at the generation given, and a grant can't be changed", async () => {
    const { host, grant, suggest } = await setup();
    const instructions = { fields: { instructions: { agents: { text: "x", baseHash: null } } } };
    const reads = host.dispatched.length;
    expect(reasonOf(await suggest(instructions, 2))).toBe("grant-generation");
    expect(host.dispatched.length).toBe(reads);
    const change = { id: grant.id, scope: "suggest", bots: ["pip"] };
    expect(reasonOf(await host.call("relay.grants.set", change))).toBe("invalid");
    const narrow = (await host.call("relay.grants.set", { scope: "suggest", bots: ["pip"] }))
      .payload!;
    const fromNarrow = { grant: narrow.id, generation: 1, bot: "pip", ...instructions };
    expect(reasonOf(await host.call("relay.propose", fromNarrow))).toBe("instructions");
    await host.call("relay.grants.set", { id: grant.id, revoke: true });
    expect(reasonOf(await suggest(instructions, 2))).toBe("grant-revoked");
  });

  it("a suggestion admitted before the revocation is withdrawn on every device; one after is refused", async () => {
    const { host, grant, suggest } = await setup();
    const before = (await suggest({})).payload!;
    const held = host.versions.hold("v:p_");
    const after = suggest({ fields: { model: "m" } });
    await held.reached;
    await host.call("relay.grants.set", { id: grant.id, revoke: true });
    held.release();
    expect(reasonOf(await after)).toBe("grant-revoked");
    const other = await host.call(
      "proposals.accept",
      { id: before.proposalId, digest: before.digest },
      { device: "device-b" },
    );
    expect(other.error?.details).toMatchObject({ reason: "settled", state: "withdrawn" });
  });

  it("a decline and a superseding proposal, in both orders", async () => {
    for (const declineFirst of [true, false]) {
      const { host, suggest } = await setup();
      const old = (await suggest({})).payload!;
      const decline = () =>
        host.call("proposals.decline", { id: old.proposalId, digest: old.digest });
      const held = host.versions.hold("v:p_");
      const newer = suggest({ fields: { label: "newer" } });
      await held.reached;
      const first = declineFirst ? await decline() : null;
      held.release();
      expect((await newer).ok).toBe(true);
      const second = declineFirst ? null : await decline();
      expect((await host.call("proposals.get", { id: old.proposalId })).payload!.state).toBe(
        declineFirst ? "declined" : "superseded",
      );
      expect(declineFirst ? first!.ok : reasonOf(second!)).toBe(declineFirst ? true : "settled");
    }
  });

  it("scoped grants bind bot incarnations: a re-created bot, an unknown bot and a bot with no creation record are refused", async () => {
    const { host, grant, suggest } = await setup();
    expect(reasonOf(await host.call("relay.grants.set", { scope: "see", bots: ["nobody"] }))).toBe(
      "bot",
    );
    host.bots.splice(0, host.bots.length, { id: "main" }, { id: "pip", createdAt: 3 });
    expect(reasonOf(await suggest({}))).toBe("bot");
    expect(
      reasonOf(
        await host.call("relay.propose", {
          grant: grant.id,
          generation: 1,
          bot: "main",
          fields: { label: "x" },
        }),
      ),
    ).toBe("bot");
  });

  it("an unreadable request can't be decided, and an expired one says so before the next sweep", async () => {
    let now = T;
    const host = load({ now: () => now });
    const g = (
      await host.call("relay.grants.set", { scope: "suggest", bots: "all", includeFuture: true })
    ).payload!;
    const send = async (bot: string) =>
      (
        await host.call("relay.propose", {
          grant: g.id,
          generation: 1,
          bot,
          fields: { label: "x" },
        })
      ).payload!;
    const broken = await send("pip");
    host.versions.faults.corrupt.add(`v:${broken.proposalId}`);
    expect(
      reasonOf(
        await host.call("proposals.decline", { id: broken.proposalId, digest: broken.digest }),
      ),
    ).toBe("unreadable");
    expect((await host.call("proposals.get", { id: broken.proposalId })).payload).toMatchObject({
      unreadable: true,
    });
    const old = await send("main");
    now = T + EXPIRES_MS;
    const accept = await host.call("proposals.accept", { id: old.proposalId, digest: old.digest });
    expect(accept.error?.details).toMatchObject({ reason: "settled", state: "expired" });
    expect((await host.call("proposals.get", { id: old.proposalId })).payload).toMatchObject({
      state: "expired",
    });
  });

  it("a refused submission keeps no record, and a full versions namespace still lets decline and revoke commit", async () => {
    const host = load({ now: () => T, versions: memoryStore({ maxEntries: 23 }) });
    const bots = Array.from({ length: 30 }, (_, i) => ({ id: `b${i}`, createdAt: i + 1 }));
    host.bots.splice(0, host.bots.length, ...bots);
    const g = (
      await host.call("relay.grants.set", { scope: "suggest", bots: "all", includeFuture: true })
    ).payload!;
    const send = (i: number) =>
      host.call("relay.propose", {
        grant: g.id,
        generation: 1,
        bot: `b${i}`,
        fields: { label: "x" },
      });
    const sent = [];
    for (let i = 0; i < 20; i += 1) sent.push((await send(i)).payload!);
    const rows = host.versions.rows.size;
    for (let i = 20; i < 25; i += 1) expect(reasonOf(await send(i))).toBe("source-limit");
    expect(host.versions.rows.size).toBe(rows);
    const other = (
      await host.call("relay.grants.set", { scope: "suggest", bots: "all", includeFuture: true })
    ).payload!;
    const more = (i: number) =>
      host.call("relay.propose", {
        grant: other.id,
        generation: 1,
        bot: `b${i}`,
        fields: { model: "m" },
      });
    expect([reasonOf(await more(0)), reasonOf(await more(1)), reasonOf(await more(2))]).toEqual([
      undefined,
      "records-full",
      "records-full",
    ]);
    // Answering can't free a stored version, so the refusal doesn't say it would.
    expect((await more(3)).error?.message).not.toMatch(/answer/i);
    const first = sent[0]!;
    expect(
      (await host.call("proposals.decline", { id: first.proposalId, digest: first.digest })).ok,
    ).toBe(true);
    expect((await host.call("relay.grants.set", { id: g.id, revoke: true })).ok).toBe(true);
  });

  it("expiry reached while a decision reads the version, or before its commit, settles nothing", async () => {
    let now = T;
    const host = load({ now: () => now });
    const g = (
      await host.call("relay.grants.set", { scope: "suggest", bots: "all", includeFuture: true })
    ).payload!;
    const send = async (bot: string) =>
      (
        await host.call("relay.propose", {
          grant: g.id,
          generation: 1,
          bot,
          fields: { label: "x" },
        })
      ).payload!;
    for (const decision of ["proposals.decline", "proposals.accept"]) {
      now = T;
      const p = await send(decision === "proposals.decline" ? "pip" : "main");
      now = T + EXPIRES_MS - 1;
      const read = host.versions.hold(`v:${p.proposalId}`, "read");
      const answer = host.call(decision, { id: p.proposalId, digest: p.digest });
      await read.reached;
      now = T + EXPIRES_MS;
      read.release();
      expect((await answer).error?.details).toMatchObject({ reason: "settled", state: "expired" });
    }
    // Past the read, the deadline is checked again up to the commit.
    const issued = T + EXPIRES_MS + 10;
    now = issued;
    const late = await send("pip");
    now = issued + EXPIRES_MS - 1;
    host.store.faults.beforeCommit = () => (now = issued + EXPIRES_MS);
    expect(
      reasonOf(await host.call("proposals.decline", { id: late.proposalId, digest: late.digest })),
    ).toBe("expired");
    host.store.faults.beforeCommit = () => {};
    expect((await host.call("proposals.get", { id: late.proposalId })).payload).toMatchObject({
      state: "expired",
    });
  });

  it("a grant's deadline: 30 days only when none is given; an elapsed or invalid one is refused", async () => {
    const host = load({ now: () => T });
    const set = (extra: Record<string, unknown>) =>
      host.call("relay.grants.set", { scope: "see", bots: ["pip"], ...extra });
    expect((await set({})).payload).toMatchObject({ expiresAt: T + 30 * 24 * 60 * 60 * 1000 });
    expect((await set({ expiresAt: T + 5000 })).payload).toMatchObject({ expiresAt: T + 5000 });
    for (const expiresAt of [T, T - 1, "soon", 1.5, null])
      expect(reasonOf(await set({ expiresAt }))).toBe("invalid");
  });

  it("an expired grant beside its open request reads the same everywhere before the sweep, and a decline can't land after it", async () => {
    let now = T;
    const host = load({ now: () => now });
    const g = (
      await host.call("relay.grants.set", { scope: "suggest", bots: ["pip"], expiresAt: T + 1000 })
    ).payload!;
    const send = async (field: Record<string, unknown>) =>
      (await host.call("relay.propose", { grant: g.id, generation: 1, bot: "pip", fields: field }))
        .payload!;
    const p = await send({ label: "x" });
    now = T + 999;
    const read = host.versions.hold(`v:${p.proposalId}`, "read");
    const got = host.call("proposals.get", { id: p.proposalId });
    await read.reached;
    now = T + 1000;
    read.release();
    expect((await got).payload).toMatchObject({ state: "withdrawn", generation: 1 });
    expect((await host.call("proposals.list")).payload!.proposals).toMatchObject([
      { id: p.proposalId, state: "withdrawn" },
    ]);
    expect((await host.call("status")).payload).toMatchObject({ open: 0 });
    expect((await host.call("relay.grants.get", { id: g.id })).payload).toMatchObject({
      revoked: "expired",
      generation: 2,
    });
    // A decline checked before the grant expires, committing after: refused.
    now = T;
    const host2 = load({ now: () => now });
    const g2 = (
      await host2.call("relay.grants.set", { scope: "suggest", bots: ["pip"], expiresAt: T + 1000 })
    ).payload!;
    const q = (
      await host2.call("relay.propose", {
        grant: g2.id,
        generation: 1,
        bot: "pip",
        fields: { label: "x" },
      })
    ).payload!;
    now = T + 999;
    host2.store.faults.beforeCommit = () => (now = T + 1000);
    expect(
      reasonOf(await host2.call("proposals.decline", { id: q.proposalId, digest: q.digest })),
    ).toBe("expired");
    host2.store.faults.beforeCommit = () => {};
    expect((await host2.call("proposals.get", { id: q.proposalId })).payload).toMatchObject({
      state: "withdrawn",
    });
  });

  it("the list is a bounded page of summaries, newest first, and the same creation time never repeats or skips across pages", async () => {
    const host = load({ now: () => T });
    host.bots.splice(
      0,
      host.bots.length,
      ...Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, createdAt: i + 1 })),
    );
    const g = (
      await host.call("relay.grants.set", {
        scope: "suggest",
        bots: "all",
        includeFuture: true,
        includeInstructions: true,
      })
    ).payload!;
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const fields = { instructions: { agents: { text: "x".repeat(1000), baseHash: null } } };
      ids.push(
        (await host.call("relay.propose", { grant: g.id, generation: 1, bot: `b${i}`, fields }))
          .payload!.proposalId as string,
      );
    }
    const seen: string[] = [];
    let cursor: unknown;
    for (let page = 0; page < 3; page += 1) {
      const answer = (
        await host.call("proposals.list", { limit: 2, ...(cursor ? { cursor } : {}) })
      ).payload!;
      const rows = answer.proposals as Record<string, unknown>[];
      expect(rows.length).toBe(page < 2 ? 2 : 1);
      expect(rows.every((r) => r.payload === undefined)).toBe(true);
      seen.push(...rows.map((r) => r.id as string));
      cursor = answer.nextCursor;
    }
    expect(cursor).toBeUndefined();
    expect(seen).toEqual([...ids].sort().reverse());
    expect(reasonOf(await host.call("proposals.list", { limit: 500 }))).toBe("invalid");
  });
});
