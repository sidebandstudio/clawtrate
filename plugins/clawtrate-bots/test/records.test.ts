import { describe, expect, it } from "vitest";
import { EXPIRES_MS, ORPHAN_MS, admit, sourceKey } from "../lib/ledger.js";
import { Records } from "../lib/records.js";
import { load, memoryStore } from "./harness.ts";

const T = 1_800_000_000_000;
const entry = (id: string, digest: string, source: object, bot: string, field = "label") => ({
  id,
  digest,
  source,
  bot,
  fields: [field],
  createdAt: T,
  expiresAt: T + EXPIRES_MS,
});

async function publish(records: Records, id: string, source: object, bot: string) {
  const digest = await records.persist(id, { id, bot });
  return records.transact((l, at) => admit(l, entry(id, digest, source, bot), at));
}
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => "admitted",
    (e) => e.reason ?? e.message,
  );

describe("the records", () => {
  it("two proposals racing for the last slot: one admitted, one refused, the count at the limit", async () => {
    for (const [limit, sources] of [
      [20, ["pip", "pip"]],
      [200, ["s9", "s10"]],
    ] as const) {
      const records = new Records(memoryStore(), { now: () => T });
      const base = limit === 20 ? 19 : 199;
      for (let i = 0; i < base; i += 1)
        await publish(
          records,
          `p${i}`,
          { kind: "bot", bot: limit === 20 ? "pip" : `s${Math.floor(i / 20)}` },
          `b${i}`,
        );
      const raced = await Promise.all(
        sources.map((s, i) =>
          outcome(publish(records, `race${i}`, { kind: "bot", bot: s }, `r${i}`)),
        ),
      );
      expect(raced.sort()).toEqual(["admitted", limit === 20 ? "source-limit" : "open-limit"]);
      const ledger = await records.ledger();
      expect(Object.values(ledger.proposals).filter((e) => e.state === "open").length).toBe(
        limit === 20 ? 20 : 200,
      );
      if (limit === 20)
        expect(
          Object.values(ledger.proposals).every(
            (e) => e.source === sourceKey({ kind: "bot", bot: "pip" }),
          ),
        ).toBe(true);
    }
  });

  it("readers use only referenced versions, with a matching digest", async () => {
    const store = memoryStore();
    const records = new Records(store, { now: () => T });
    await publish(records, "p", { kind: "bot", bot: "pip" }, "pip");
    const { digest } = (await records.ledger()).proposals.p;
    expect(await records.version("p", digest)).toEqual({ id: "p", bot: "pip" });
    const row = JSON.parse(store.rows.get("v:p")!.json);
    store.rows.set("v:p", {
      json: JSON.stringify({ ...row, body: { id: "p", bot: "otto" } }),
      rev: 999,
    });
    expect(await records.version("p", digest)).toBeNull();
  });

  it("an unpublished version is reclaimed after an hour, and a delayed publisher can't publish it after", async () => {
    let now = T;
    const store = memoryStore();
    const records = new Records(store, { now: () => now });
    const digest = await records.persist("late", { id: "late", bot: "pip" });
    await records.persist("fresh-later", { id: "fresh-later" });
    await publish(records, "kept", { kind: "bot", bot: "main" }, "main");
    now = T + ORPHAN_MS - 1;
    expect(await records.sweepOrphans()).toEqual([]);
    now = T + ORPHAN_MS;
    expect(await records.sweepOrphans()).toEqual(["fresh-later", "late"]);
    expect(store.rows.has("v:kept")).toBe(true);
    // The publisher read its version before cleanup and publishes after it.
    await expect(
      records.transact((l, at) =>
        admit(l, entry("late", digest, { kind: "bot", bot: "pip" }, "pip"), at),
      ),
    ).rejects.toMatchObject({ reason: "unpublishable" });
    expect((await records.ledger()).proposals.late).toBeUndefined();
  });

  it("cleanup racing a publisher: whichever ledger update lands first decides", async () => {
    let now = T;
    const store = memoryStore();
    const records = new Records(store, { now: () => now });
    const digest = await records.persist("p", { id: "p" });
    now = T + ORPHAN_MS;
    const [published, swept] = await Promise.all([
      outcome(
        records.transact((l, at) =>
          admit(l, entry("p", digest, { kind: "bot", bot: "pip" }, "pip"), at),
        ),
      ),
      records.sweepOrphans(),
    ]);
    const ledger = await records.ledger();
    if (published === "admitted") {
      expect(swept).toEqual([]);
      expect(await records.version("p", ledger.proposals.p.digest)).not.toBeNull();
    } else {
      expect(swept).toEqual(["p"]);
      expect(ledger.proposals.p).toBeUndefined();
    }
  });

  it("survives a restart: a new process reads the same ledger and versions", async () => {
    const store = memoryStore();
    await publish(new Records(store, { now: () => T }), "p", { kind: "bot", bot: "pip" }, "pip");
    const again = new Records(store, { now: () => T + 1 });
    const { digest } = (await again.ledger()).proposals.p;
    expect(await again.version("p", digest)).toEqual({ id: "p", bot: "pip" });
  });
});

describe("the plugin's methods", () => {
  it("records a suggestion, refuses accept on 2026.10.6, and reads nothing but agents.list", async () => {
    const host = load({ now: () => T });
    const grant = (await host.call("relay.grants.set", { scope: "suggest", bots: ["pip"] }))
      .payload!;
    const sent = await host.call("relay.propose", {
      grant: grant.id,
      generation: grant.generation,
      bot: "pip",
      fields: { name: "  Scout   Bot " },
    });
    expect(sent.payload).toMatchObject({ status: "proposed", fields: ["name"] });
    const id = sent.payload!.proposalId as string;
    expect((await host.call("proposals.get", { id })).payload).toMatchObject({
      state: "open",
      payload: { name: "Scout Bot" },
    });
    const accept = await host.call("proposals.accept", { id, digest: sent.payload!.digest });
    expect(accept.error?.details?.reason).toBe("apply-unavailable");
    expect((await host.call("status")).payload).toMatchObject({
      apply: { available: false },
      open: 1,
    });
    expect(new Set(host.dispatched)).toEqual(new Set(["agents.list"]));
    expect(host.events.length).toBeGreaterThan(0);
  });

  it("refuses what a grant doesn't allow", async () => {
    const host = load({ now: () => T });
    const see = (await host.call("relay.grants.set", { scope: "see", bots: "all" })).payload!;
    const suggest = (await host.call("relay.grants.set", { scope: "suggest", bots: ["pip"] }))
      .payload!;
    const reasonOf = async (params: Record<string, unknown>) =>
      (await host.call("relay.propose", params)).error?.details?.reason;
    expect(
      await reasonOf({ grant: see.id, generation: 1, bot: "pip", fields: { label: "x" } }),
    ).toBe("scope");
    expect(
      await reasonOf({ grant: suggest.id, generation: 1, bot: "main", fields: { label: "x" } }),
    ).toBe("bot");
    expect(
      await reasonOf({
        grant: suggest.id,
        generation: 1,
        bot: "pip",
        fields: { instructions: { agents: { text: "x", baseHash: null } } },
      }),
    ).toBe("instructions");
    expect(
      await reasonOf({ grant: suggest.id, generation: 1, bot: "pip", fields: { effort: "max" } }),
    ).toBe("invalid");
  });

  it("a revoked grant's suggestion is withdrawn on every device, and its next call refused", async () => {
    const host = load({ now: () => T });
    const g = (await host.call("relay.grants.set", { scope: "suggest", bots: ["pip"] })).payload!;
    const sent = (
      await host.call("relay.propose", {
        grant: g.id,
        generation: 1,
        bot: "pip",
        fields: { label: "x" },
      })
    ).payload!;
    expect((await host.call("relay.grants.set", { id: g.id, revoke: true })).payload).toMatchObject(
      { generation: 2, revoked: true },
    );
    const other = await host.call(
      "proposals.accept",
      { id: sent.proposalId, digest: sent.digest },
      "device-b",
    );
    expect(other.error?.details).toMatchObject({ reason: "settled", state: "withdrawn" });
    const next = await host.call("relay.propose", {
      grant: g.id,
      generation: 2,
      bot: "pip",
      fields: { label: "y" },
    });
    expect(next.error?.details?.reason).toBe("grant-revoked");
  });
});
