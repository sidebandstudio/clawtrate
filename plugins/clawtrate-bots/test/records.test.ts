import { describe, expect, it, vi } from "vitest";
import { EXPIRES_MS, ORPHAN_MS, RETAIN_MS, admit, decline, publishGrant } from "../lib/ledger.js";
import { Records } from "../lib/records.js";
import { load, memoryStore, type Store } from "./harness.ts";

type Ledger = Parameters<typeof admit>[0];

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

  // Wall time and the monotonic clock the sweep measures an hour on, moved independently.
  const clocks = () => {
    const c = { wall: T, mono: 0 };
    return { c, now: () => c.wall, monotonic: () => c.mono };
  };
  const on = (store: Store, versions: Store, k = clocks()) => ({
    k,
    records: new Records(store, versions, { now: k.now, monotonic: k.monotonic }),
  });
  /** A proposal superseding an open one, or a grant version replacing gv1: each publication's change. */
  type Change = (l: Ledger, at: number) => unknown;
  async function publications(
    records: Records,
  ): Promise<Record<"proposal" | "grant", (id: string, digest: string) => Change>> {
    await propose(records, "old", { kind: "bot", bot: "pip" }, "pip");
    const g1 = await records.persist("gv1", { v: 1 });
    await records.publish("gv1", g1, (l, at) =>
      publishGrant(l, "g", { version: "gv1", digest: g1, expiresAt: at + 1e12 }, null, at),
    );
    return {
      proposal: (id: string, digest: string) => (l: Ledger, at: number) =>
        admit(l, entry(id, digest, { kind: "bot", bot: "main" }, "pip", at), at),
      grant: (id: string, digest: string) => (l: Ledger, at: number) =>
        publishGrant(l, "g", { version: id, digest, expiresAt: at + 1e12 }, 1, at),
    };
  }

  it("a failed delete is finished by a fresh Records over both stores, whether the body is still there or not, and the old publication stays refused", async () => {
    for (const kind of ["proposal", "grant"] as const)
      for (const body of ["present", "already deleted"]) {
        const [store, versions] = [memoryStore(), memoryStore()];
        const { k, records } = on(store, versions);
        const change = (await publications(records))[kind];
        const id = `${kind}-late`;
        const digest = await records.persist(id, { id });
        await records.sweepOrphans();
        k.c.mono += ORPHAN_MS;
        versions.faults.failNextDelete = true;
        await expect(records.sweepOrphans()).rejects.toThrow("the delete failed");
        expect((await records.ledger()).sweeping).toBe(id);
        await expect(records.publish(id, digest, change(id, digest))).rejects.toMatchObject({
          reason: "unpublishable",
        });
        if (body === "already deleted") versions.rows.delete(`v:${id}`);
        const fresh = on(store, versions).records;
        expect(await fresh.sweepOrphans()).toEqual([id]);
        expect([(await fresh.ledger()).sweeping, versions.rows.has(`v:${id}`)]).toEqual([
          null,
          false,
        ]);
        k.c.wall = T + 40 * 24 * 60 * 60 * 1000;
        await expect(records.publish(id, digest, change(id, digest))).rejects.toMatchObject({
          reason: "unpublishable",
        });
        const ledger = await records.ledger();
        expect([Object.hasOwn(ledger.proposals, id), ledger.grants.g?.version]).toEqual([
          false,
          "gv1",
        ]);
      }
  });

  it("the sweep wins: a publisher held after reading its body conflicts, then is refused, and the entry it would replace is unchanged", async () => {
    for (const kind of ["proposal", "grant"] as const) {
      const [store, versions] = [memoryStore(), memoryStore()];
      const { k, records } = on(store, versions);
      const change = (await publications(records))[kind];
      const before = await records.ledger();
      const digest = await records.persist("newer", { id: "newer" });
      // Held after its body read, at the ledger update that would publish it.
      const publishes = (value: unknown) => {
        const v = value as Ledger | undefined;
        return Boolean(v?.proposals?.newer) || v?.grants?.g?.version === "newer";
      };
      const held = store.hold("ledger", "cas", publishes);
      const published = outcome(records.publish("newer", digest, change("newer", digest)));
      await held.reached;
      await records.sweepOrphans();
      k.c.mono += ORPHAN_MS;
      expect(await records.sweepOrphans()).toEqual(["newer"]);
      const conflicts = store.stats.conflicts;
      held.release();
      expect(await published).toBe("unpublishable");
      expect(store.stats.conflicts).toBeGreaterThan(conflicts);
      const after = await records.ledger();
      expect([after.proposals, after.grants]).toEqual([before.proposals, before.grants]);
    }
  });

  it("the publisher wins: a sweep held before its marker conflicts, and the published body stays readable", async () => {
    const [store, versions] = [memoryStore(), memoryStore()];
    const { k, records } = on(store, versions);
    const change = (await publications(records)).proposal;
    const digest = await records.persist("newer", { id: "newer" });
    await records.sweepOrphans();
    k.c.mono += ORPHAN_MS;
    const held = store.hold(
      "ledger",
      "cas",
      (value) => (value as { sweeping?: string })?.sweeping === "newer",
    );
    const swept = records.sweepOrphans();
    await held.reached;
    const conflicts = store.stats.conflicts;
    await records.publish("newer", digest, change("newer", digest));
    held.release();
    expect(await swept).toEqual([]);
    expect(store.stats.conflicts).toBe(conflicts + 1);
    expect(await records.version("newer", digest)).toEqual({ id: "newer" });
    expect((await records.ledger()).sweeping).toBeNull();
  });

  it("an hour of continuous non-reference: a replaced grant, a retired request and a body written while the wall clock was set back", async () => {
    const [store, versions] = [memoryStore(), memoryStore()];
    const { k, records } = on(store, versions);
    await propose(records, "retired", { kind: "bot", bot: "pip" }, "pip");
    const { digest } = (await records.ledger()).proposals.retired;
    await records.transact((l, at) => decline(l, "retired", digest, "dev", at));
    const g1 = await records.persist("gv1", { v: 1 });
    await records.publish("gv1", g1, (l, at) =>
      publishGrant(l, "g", { version: "gv1", digest: g1, expiresAt: at + 1e13 }, null, at),
    );
    k.c.wall = T + RETAIN_MS;
    await records.transact(() => {});
    const g2 = await records.persist("gv2", { v: 2 });
    await records.publish("gv2", g2, (l, at) =>
      publishGrant(l, "g", { version: "gv2", digest: g2, expiresAt: at + 1e13 }, 1, at),
    );
    k.c.wall = T - 2 * ORPHAN_MS;
    await records.persist("rollback", { id: "rollback" });
    k.c.wall = T + RETAIN_MS;
    expect(await records.sweepOrphans()).toEqual([]);
    k.c.mono += ORPHAN_MS - 1;
    expect(await records.sweepOrphans()).toEqual([]);
    k.c.mono += 1;
    expect((await records.sweepOrphans()).sort()).toEqual(["gv1", "retired", "rollback"]);
    expect([...versions.rows.keys()]).toEqual(["v:gv2"]);
  });

  it("publishing a version clears its age: replaced later, it waits a fresh hour", async () => {
    const [store, versions] = [memoryStore(), memoryStore()];
    const { k, records } = on(store, versions);
    const g1 = await records.persist("gv1", { v: 1 });
    await records.publish("gv1", g1, (l, at) =>
      publishGrant(l, "g", { version: "gv1", digest: g1, expiresAt: at + 1e13 }, null, at),
    );
    const g2 = await records.persist("gv2", { v: 2 });
    await records.sweepOrphans();
    k.c.mono += ORPHAN_MS;
    await records.publish("gv2", g2, (l, at) =>
      publishGrant(l, "g", { version: "gv2", digest: g2, expiresAt: at + 1e13 }, 1, at),
    );
    const g3 = await records.persist("gv3", { v: 3 });
    await records.publish("gv3", g3, (l, at) =>
      publishGrant(l, "g", { version: "gv3", digest: g3, expiresAt: at + 1e13 }, 2, at),
    );
    // gv2 was aged before it was published; replaced now, its hour starts again.
    expect(await records.sweepOrphans()).toEqual([]);
    k.c.mono += ORPHAN_MS;
    expect((await records.sweepOrphans()).sort()).toEqual(["gv1", "gv2"]);
  });

  it("a full store of 512 versions is reclaimed page by page, and takes new records again", async () => {
    const [store, versions] = [memoryStore(), memoryStore({ maxEntries: 512 })];
    const { k, records } = on(store, versions);
    const scan = versions.entriesInKeyRange.bind(versions);
    const limits: number[] = [];
    versions.entriesInKeyRange = (range) => (limits.push(range.limit), scan(range));
    for (let i = 0; i < 512; i += 1) await records.persist(`o${String(i).padStart(3, "0")}`, { i });
    await expect(records.persist("one-more", { i: 512 })).rejects.toMatchObject({
      reason: "records-full",
    });
    expect(await records.sweepOrphans()).toEqual([]);
    k.c.mono += ORPHAN_MS;
    expect(await records.sweepOrphans()).toHaveLength(512);
    expect(versions.rows.size).toBe(0);
    expect((await records.ledger()).orphanAges).toBeUndefined();
    await expect(records.persist("one-more", { i: 512 })).resolves.toBeTypeOf("string");
    // At most 16 rows decoded per page, so at most 16 MiB of JSON at the store's 1 MiB per value.
    expect(Math.max(...limits)).toBe(16);
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

  it("permissions come from the generation that supplied them, in both orders", async () => {
    const { host, grant, suggest } = await setup();
    const narrow = { id: grant.id, expectedGeneration: 1, scope: "suggest", bots: ["pip"] };
    const instructions = { fields: { instructions: { agents: { text: "x", baseHash: null } } } };
    expect(
      reasonOf(await host.call("relay.grants.set", { id: grant.id, scope: "see", bots: ["pip"] })),
    ).toBe("invalid");
    const held = host.versions.hold("v:p_");
    const late = suggest(instructions);
    await held.reached;
    expect((await host.call("relay.grants.set", narrow)).payload).toMatchObject({
      generation: 2,
      includeInstructions: false,
    });
    held.release();
    expect(reasonOf(await late)).toBe("grant-generation");
    expect(reasonOf(await suggest(instructions, 1))).toBe("grant-generation");
    expect(reasonOf(await suggest(instructions, 2))).toBe("instructions");
    // A request naming the next generation isn't checked against the current, wider one.
    const ahead = host.versions.hold("v:p_");
    const early = suggest(instructions, 3);
    const where = await Promise.race([
      early.then(() => "answered"),
      ahead.reached.then(() => "held"),
    ]);
    if (where === "held") await host.call("relay.grants.set", { ...narrow, expectedGeneration: 2 });
    ahead.release();
    expect([where, reasonOf(await early)]).toEqual(["answered", "grant-generation"]);
    // A pending update can't bring access back after a revocation.
    const update = host.versions.hold("v:gv_");
    const pending = host.call("relay.grants.set", { ...narrow, expectedGeneration: 2 });
    await update.reached;
    await host.call("relay.grants.set", { id: grant.id, revoke: true });
    update.release();
    expect(reasonOf(await pending)).toBe("grant-generation");
    expect(reasonOf(await suggest({}, 3))).toBe("grant-revoked");
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
    expect((await more(3)).error?.message).toBe(
      "Clawtrate's request records on this gateway are full. Try again after the gateway clears older records.",
    );
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

  it("reopened past both deadlines, a request whose own deadline came first reads expired, not withdrawn", async () => {
    let now = T;
    const [store, versions] = [memoryStore(), memoryStore({ maxEntries: 512 })];
    const first = load({ store, versions, now: () => now });
    const g = (
      await first.call("relay.grants.set", {
        scope: "suggest",
        bots: ["pip"],
        expiresAt: T + EXPIRES_MS + 5000,
      })
    ).payload!;
    const p = (
      await first.call("relay.propose", {
        grant: g.id,
        generation: 1,
        bot: "pip",
        fields: { label: "x" },
      })
    ).payload!;
    now = T + EXPIRES_MS + 10_000;
    const reopened = load({ store, versions, now: () => now });
    expect((await reopened.call("proposals.get", { id: p.proposalId })).payload).toMatchObject({
      state: "expired",
    });
    expect((await reopened.call("relay.grants.get", { id: g.id })).payload).toMatchObject({
      revoked: "expired",
    });
  });

  it("a grant update lives no longer than the generation it read: an expiry or a retention end at commit refuses it", async () => {
    let now = T;
    const host = load({ now: () => now });
    const update = (id: unknown, expectedGeneration: number) =>
      host.call("relay.grants.set", {
        id,
        expectedGeneration,
        scope: "suggest",
        bots: ["pip"],
        expiresAt: T + 1e12,
      });
    const g = (
      await host.call("relay.grants.set", { scope: "suggest", bots: ["pip"], expiresAt: T + 1000 })
    ).payload!;
    now = T + 999;
    host.store.faults.beforeCommit = () => (now = T + 1000);
    expect(reasonOf(await update(g.id, 1))).toBe("expired");
    host.store.faults.beforeCommit = () => {};
    expect((await host.call("relay.grants.get", { id: g.id })).payload).toMatchObject({
      revoked: "expired",
      generation: 2,
    });
    now = T;
    const r = (await host.call("relay.grants.set", { scope: "suggest", bots: ["pip"] })).payload!;
    await host.call("relay.grants.set", { id: r.id, revoke: true });
    now = T + RETAIN_MS - 1;
    host.store.faults.beforeCommit = () => (now = T + RETAIN_MS);
    expect(reasonOf(await update(r.id, 2))).toBe("expired");
    host.store.faults.beforeCommit = () => {};
    expect(reasonOf(await host.call("relay.grants.get", { id: r.id }))).toBe("grant-missing");
  });

  it("the service finishes a pending deletion at start, sweeps hourly, and clears its timer when stopped", async () => {
    let mono = 0;
    const [store, versions] = [memoryStore(), memoryStore({ maxEntries: 512 })];
    const seed = new Records(store, versions, { now: () => T, monotonic: () => mono });
    await seed.persist("pending", { id: "pending" });
    await seed.transact((l) => {
      l.sweeping = "pending";
    });
    await seed.persist("orphan", { id: "orphan" });
    const timers: { tick: () => Promise<unknown>; ms: number }[] = [];
    const set = vi.spyOn(globalThis, "setInterval").mockImplementation(((
      tick: () => Promise<unknown>,
      ms: number,
    ) => {
      timers.push({ tick, ms });
      return 7;
    }) as unknown as typeof setInterval);
    const cleared = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
    try {
      const host = load({
        store,
        versions,
        now: () => T,
        monotonic: () => mono,
        startService: false,
      });
      await host.start();
      expect(timers.map((t) => t.ms)).toEqual([60 * 60 * 1000]);
      expect([versions.rows.has("v:pending"), versions.rows.has("v:orphan")]).toEqual([
        false,
        true,
      ]);
      expect((await seed.ledger()).sweeping).toBeNull();
      mono += ORPHAN_MS;
      await timers[0]!.tick();
      expect(versions.rows.has("v:orphan")).toBe(false);
      host.stop();
      expect(cleared).toHaveBeenCalledWith(7);
    } finally {
      set.mockRestore();
      cleared.mockRestore();
    }
  });
});
