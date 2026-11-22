import { describe, expect, it } from "vitest";
import { EXPIRES_MS, admit } from "../lib/ledger.js";
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
      const records = new Records(memoryStore(), { now: () => T });
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
    const records = new Records(store, { now: () => T });
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
    const records = new Records(store, { now: () => T });
    const digest = await records.persist("p", { id: "p" });
    store.rows.delete("v:p");
    const publish = records.publish("p", digest, (l, at) =>
      admit(l, entry("p", digest, { kind: "bot", bot: "pip" }, "pip", at), at),
    );
    await expect(publish).rejects.toMatchObject({ reason: "unpublishable" });
    expect((await records.ledger()).proposals).toEqual({});
  });

  it("reopening Records over the same store reads the same ledger and versions", async () => {
    const store = memoryStore();
    await propose(new Records(store, { now: () => T }), "p", { kind: "bot", bot: "pip" }, "pip");
    const again = new Records(store, { now: () => T + 1 });
    expect(await again.version("p", (await again.ledger()).proposals.p.digest)).toEqual({
      id: "p",
      bot: "pip",
    });
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
    const held = host.store.hold("v:p_");
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
      const held = host.store.hold("v:p_");
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
    host.store.faults.corrupt.add(`v:${broken.proposalId}`);
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
});
