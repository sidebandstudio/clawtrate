// Apply, the journal, crash settling and Undo, through the test-only Apply
// stand-in (harness.ts). Without it, as on OpenClaw 2026.10.6, accept and
// Undo refuse before claiming anything.

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { undoId } from "../lib/apply.js";
import { mayPropose } from "../lib/bots.js";
import { newId } from "../lib/canonical.js";
import * as L from "../lib/ledger.js";
import { load, memoryStore, standInApply } from "./harness.ts";

type Json = Record<string, unknown>;
type Host = ReturnType<typeof load>;
type Ledger = ReturnType<typeof L.emptyLedger> | undefined;
const T = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PIP = { id: "pip", createdAt: 2 };
const MAIN = { id: "main", createdAt: 1 };
const reasonOf = (a: { error?: { details?: Json } | undefined }) => a.error?.details?.reason;
const never = () => new Promise(() => {});

/** A host whose Apply is the stand-in, over stores a fresh host can reopen (a restart). */
function applying(initial: Json = {}) {
  const stores = {
    store: memoryStore(),
    versions: memoryStore({ maxEntries: 512 }),
    journal: memoryStore(),
  };
  const gateway = standInApply(initial);
  const clock = { now: T, mono: 0 };
  const open = (config: Json = {}) =>
    load({
      ...stores,
      effects: gateway,
      config,
      now: () => clock.now,
      monotonic: () => clock.mono,
      startService: false,
    });
  return { host: open(), open, gateway, clock, ...stores };
}

/** Admits a bot's request with a precondition token for each field, as the gated tools will. */
async function seed(
  host: Host,
  fields: Json = { label: "Helper" },
  {
    bot = PIP,
    source = { kind: "bot", bot: "pip", createdAt: 2 } as Json,
    tokens = Object.fromEntries(Object.keys(fields).map((f) => [f, `t0-${f}`])),
  } = {},
) {
  const id = newId("p");
  const names = Object.keys(fields);
  const expiresAt = T + L.EXPIRES_MS;
  const body = { id, gateway: "gw", bot, kind: "update", payload: fields, tokens, source };
  const digest = await host.records.persist(id, { ...body, createdAt: T, expiresAt });
  await host.records.publish(id, digest, (l, at) =>
    L.admit(l, { id, digest, source, bot, fields: names, createdAt: T, expiresAt }, at),
  );
  return { id, digest };
}
const accept = (host: Host, p: { id: string; digest: string }, device = "device-a") =>
  host.call("proposals.accept", p, { device });
const entryOf = async (host: Host, id: string) => (await host.records.ledger()).proposals[id];
const keyOf = (id: string, step: string, attempt = 1) => L.journalKey(id, attempt, step);
/** Fills the journal index: one entry per age, each for its own bot, so each is the latest. */
const fill = (host: Host, ages: number[]) =>
  host.records.transact((l) => {
    l.journal = Object.fromEntries(
      ages.map((age, i) => [
        keyOf(`p_${i.toString(16).padStart(32, "0")}`, "label"),
        { at: T - age, target: `b${i}:1:label`, digest: "d" },
      ]),
    );
  });

describe("on OpenClaw 2026.10.6", () => {
  it("without the stand-in, accept claims nothing, Undo is refused, and no shipped path supplies an Apply", async () => {
    const host = load({ now: () => T, startService: false });
    const p = await seed(host);
    expect(reasonOf(await accept(host, p))).toBe("apply-unavailable");
    expect(await entryOf(host, p.id)).toMatchObject({ state: "open" });
    expect((await entryOf(host, p.id)).claim).toBeUndefined();
    expect(host.journal.rows.size).toBe(0);
    expect((await host.call("status")).payload!.apply).toEqual({
      available: false,
      reason: "incarnation",
    });
    expect(reasonOf(await host.call("changes.undo", { id: keyOf(p.id, "label") }))).toBe(
      "undo-unavailable",
    );
    expect((await host.call("changes.list")).payload!.changes).toEqual([]);
    // The entry passes only the SDK; the code dispatches only reads and its own config write.
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    expect(read("../index.js")).toMatch(
      /createBots\(api, \{ sdk: \{ dispatchGatewayMethod \} \}\)/,
    );
    expect(read("../index.js")).not.toMatch(/effects/);
    const lib = readdirSync(new URL("../lib/", import.meta.url))
      .map((file) => read(`../lib/${file}`))
      .join("\n");
    // Any first argument, so a method named through a variable shows up too.
    const methods = [...lib.matchAll(/dispatchGatewayMethod\(\s*([^,)]+)/g)].map((m) =>
      m[1]!.trim(),
    );
    expect(new Set(methods)).toEqual(new Set(['"agents.list"', '"config.get"', '"config.patch"']));
    expect(lib.match(/options\.effects/g)).toHaveLength(1);
    // Options are read by name only, so no other name can carry an Apply in.
    expect(lib).not.toMatch(/\boptions\s*\[/);
    // The SDK only as direct calls, and no module loaded at run time.
    expect(lib).not.toMatch(/\bimport\s*\(|createRequire/);
    expect(lib.match(/\bsdk(?![\w-])/g)).toHaveLength(
      lib.match(/\bsdk\.dispatchGatewayMethod\(/g)!.length + 1,
    );
    expect([...lib.matchAll(/\{([\w\s,]*)\}\s*=\s*options\b/g)].map((m) => m[1]!.trim())).toEqual([
      "sdk",
    ]);
    expect(new Set([...lib.matchAll(/\boptions\.(\w+)/g)].map((m) => m[1]))).toEqual(
      new Set([
        ...["effects", "journal", "monotonic", "now", "store", "sweepIntervalMs", "versions"],
        // lib/runs.js and lib/hooks.js: the run origins' stand-ins for the host (test/hooks.test.ts).
        ...["config", "describeHolds", "ended", "sessions", "slots", "version"],
      ]),
    );
  });
});

describe("Apply and the journal", () => {
  it("writes each step in order, journaling each confirmed effect before the next write", async () => {
    const { host, gateway } = applying();
    const p = await seed(host, { effort: "high", label: "Helper" });
    const attachedFirst: boolean[] = [];
    gateway.faults.before = (step) => {
      if (step !== "effort") return;
      const ledger = JSON.parse(host.store.rows.get("ledger")!.json);
      attachedFirst.push(ledger.proposals[p.id].effects.includes(keyOf(p.id, "label")));
    };
    expect((await accept(host, p)).payload).toMatchObject({
      state: "accepted",
      outcome: { label: "applied", effort: "applied" },
    });
    expect(gateway.writes.map((w) => w.step)).toEqual(["label", "effort"]);
    expect(attachedFirst).toEqual([true]);
    const ledger = await host.records.ledger();
    expect([L.journalUse(ledger), ledger.proposals[p.id].reserved]).toEqual([2, 0]);
    const { changes } = (await host.call("changes.list")).payload! as { changes: Json[] };
    expect(changes.map((c) => [c.field, c.before, c.after, c.undo])).toEqual([
      ["label", null, "Helper", true],
      ["effort", null, "high", true],
    ]);
  });

  it("a full journal refuses the claim before any write, after the service frees what it can", async () => {
    const { host, gateway, journal } = applying();
    // One entry past its Undo, the rest still offering it: that one goes.
    await fill(host, [9 * DAY, ...Array.from({ length: 999 }, () => HOUR)]);
    const oldest = keyOf(`p_${"0".repeat(32)}`, "label");
    journal.rows.set(oldest, { json: "{}", rev: 0 });
    const p = await seed(host);
    expect((await accept(host, p)).payload).toMatchObject({ state: "accepted" });
    const ledger = await host.records.ledger();
    expect([L.journalUse(ledger), Object.hasOwn(ledger.journal!, oldest)]).toEqual([1000, false]);
    expect(journal.rows.has(oldest)).toBe(false);
    // Nothing left to free: refused, nothing written, the request still open.
    const q = await seed(
      host,
      { label: "Other" },
      { bot: MAIN, source: { kind: "bot", bot: "main" } },
    );
    const refused = await accept(host, q);
    expect([reasonOf(refused), refused.error?.message]).toEqual([
      "journal-full",
      "Clawtrate's change history is full, so it can't apply this now. Review and save it yourself instead.",
    ]);
    expect(gateway.writes).toHaveLength(1);
    expect(await entryOf(host, q.id)).toMatchObject({ state: "open" });
  });

  it("two claims compete for the last journal space: one claims and writes, the other is refused before writing", async () => {
    const { host, gateway } = applying();
    await fill(
      host,
      Array.from({ length: 999 }, () => HOUR),
    );
    const p = await seed(host);
    const q = await seed(
      host,
      { label: "Other" },
      { bot: MAIN, source: { kind: "bot", bot: "main" } },
    );
    const answers = await Promise.all([accept(host, p), accept(host, q, "device-b")]);
    expect(answers.map((a) => a.payload?.state ?? reasonOf(a)).sort()).toEqual([
      "accepted",
      "journal-full",
    ]);
    expect(gateway.writes).toHaveLength(1);
  });

  it("a crash between the claim and the write keeps its reservation until recovery settles it unknown, then releases it", async () => {
    const { host, open, gateway } = applying({ label: "Old" });
    const p = await seed(host, { label: "Helper", effort: "high" });
    let reached = () => {};
    const writing = new Promise<void>((resolve) => (reached = resolve));
    gateway.faults.before = () => (reached(), never());
    void accept(host, p);
    await writing;
    expect((await entryOf(host, p.id)).state).toBe("committing");
    // A claim of this process's own is a live worker's: neither recovery nor a sweep releases it.
    expect(await host.records.settleAbandoned()).toEqual([]);
    await host.records.transact(() => {});
    expect(L.journalUse(await host.records.ledger())).toBe(2);
    gateway.faults.before = () => {};
    const restarted = open();
    await restarted.start();
    expect(await entryOf(restarted, p.id)).toMatchObject({
      state: "unknown",
      outcome: { label: "unknown", effort: "not-applied" },
      observed: { label: "Old" },
      reserved: 0,
    });
    expect([L.journalUse(await restarted.records.ledger()), gateway.writes]).toEqual([0, []]);
  });

  it("a journal write that fails on the first or a later field: unknown, later fields unwritten, Undo only for earlier entries, and a restart finds none for it", async () => {
    for (const failing of [0, 1]) {
      const { host, open, gateway, journal } = applying();
      const steps = ["label", "effort", "autonomy"];
      const p = await seed(host, { label: "Helper", effort: "high", autonomy: "ask" });
      // Retried once under the same key: failing twice, it stays unknown.
      journal.faults.failWrites.set(keyOf(p.id, steps[failing]!), 2);
      const answer = (await accept(host, p)).payload!;
      expect(answer.outcome).toEqual(
        failing === 0
          ? { label: "unknown", effort: "not-applied", autonomy: "not-applied" }
          : { label: "applied", effort: "unknown", autonomy: "not-applied" },
      );
      expect(answer.state).toBe(failing === 0 ? "unknown" : "partial");
      expect(gateway.writes.map((w) => w.step)).toEqual(steps.slice(0, failing + 1));
      const restarted = open();
      await restarted.start();
      expect(await entryOf(restarted, p.id)).toMatchObject({ state: answer.state });
      expect(journal.rows.has(keyOf(p.id, steps[failing]!))).toBe(false);
      const { changes } = (await restarted.call("changes.list")).payload! as { changes: Json[] };
      expect(changes.map((c) => [c.field, c.undo])).toEqual(failing ? [["label", true]] : []);
    }
    // One failure is retried under the same key and stored.
    const { host, journal } = applying();
    const p = await seed(host);
    journal.faults.failWrites.set(keyOf(p.id, "label"), 1);
    expect((await accept(host, p)).payload).toMatchObject({ state: "accepted" });
  });

  it("a restart more than an hour after a confirmed entry was stored without its ledger reference: cleanup leaves it, recovery attaches it as applied", async () => {
    const { host, open, clock, journal } = applying();
    const p = await seed(host);
    const key = keyOf(p.id, "label");
    const attach = host.store.hold("ledger", "cas", (value) =>
      Boolean((value as Ledger)?.proposals?.[p.id]?.effects?.length),
    );
    void accept(host, p);
    await attach.reached;
    attach.drop();
    expect(journal.rows.has(key)).toBe(true);
    const restarted = open();
    await restarted.records.sweepOrphans();
    clock.mono += 2 * HOUR;
    await restarted.records.sweepOrphans();
    expect(journal.rows.has(key)).toBe(true);
    await restarted.start();
    expect(await entryOf(restarted, p.id)).toMatchObject({
      state: "accepted",
      effects: [key],
      outcome: { label: "applied" },
    });
    const { changes } = (await restarted.call("changes.list")).payload! as { changes: Json[] };
    expect(changes.map((c) => [c.id, c.undo])).toEqual([[key, true]]);
  });

  it("a revocation and a claim racing are decided by the claim's generation check, in both orders", async () => {
    for (const revokeFirst of [true, false]) {
      const { host, gateway } = applying();
      const g = (await host.call("relay.grants.set", { scope: "suggest", bots: ["pip"] })).payload!;
      const { version } = (await host.records.ledger()).grants[g.id as string];
      const source = { kind: "agent", grant: g.id, generation: 1, version };
      const p = await seed(host, { label: "Helper" }, { source });
      const revoke = () => host.call("relay.grants.set", { id: g.id, revoke: true });
      if (revokeFirst) {
        const claim = host.store.hold("ledger", "cas", (value) =>
          Boolean((value as Ledger)?.proposals?.[p.id]?.claim),
        );
        const answer = accept(host, p);
        await claim.reached;
        await revoke();
        claim.release();
        expect((await answer).error?.details).toMatchObject({
          reason: "settled",
          state: "withdrawn",
        });
        expect(gateway.writes).toEqual([]);
      } else {
        gateway.faults.before = () => revoke();
        // Claimed before access was removed: the commit goes on.
        expect((await accept(host, p)).payload).toMatchObject({ state: "accepted" });
        expect((await host.records.ledger()).grants[g.id as string].revoked).toBe("removed");
      }
    }
  });

  it("two devices deciding at once: one decision wins, the other is refused, and one write is sent", async () => {
    for (const other of ["proposals.accept", "proposals.decline"]) {
      const { host, gateway } = applying();
      const p = await seed(host);
      const answers = await Promise.all([
        accept(host, p),
        host.call(other, p, { device: "device-b" }),
      ]);
      expect(answers.filter((a) => a.ok)).toHaveLength(1);
      expect(answers.map(reasonOf).filter(Boolean)).toEqual(["settled"]);
      expect(gateway.writes.length).toBe(answers[0]!.ok ? 1 : 0);
    }
  });

  it("a supersession racing a commit: the committing request isn't superseded, and the newer one stays open", async () => {
    const { host, gateway } = applying();
    const p = await seed(host);
    let newer = { id: "", digest: "" };
    gateway.faults.before = async () => {
      newer = await seed(host, { label: "Newer" });
    };
    expect((await accept(host, p)).payload).toMatchObject({ state: "accepted" });
    expect((await entryOf(host, newer.id)).state).toBe("open");
  });

  it("a precondition refused inside the write stops that field and the ones after it", async () => {
    const { host, gateway } = applying();
    const p = await seed(host, { label: "Helper", effort: "high" });
    gateway.set(PIP, "label", "Edited elsewhere");
    expect((await accept(host, p)).payload).toMatchObject({
      state: "stale",
      outcome: { label: "not-applied", effort: "not-applied" },
    });
    expect(gateway.writes).toEqual([]);
  });

  it("recovery keeps a field with no conditional write unavailable, as the worker does", async () => {
    const { host, open } = applying();
    const p = await seed(host, { name: "Scout", label: "Helper" });
    // The worker stops right before its own settle.
    const settle = host.store.hold("ledger", "cas", (value) => {
      const state = (value as Ledger)?.proposals?.[p.id]?.state;
      return Boolean(state) && state !== "committing";
    });
    void accept(host, p);
    await settle.reached;
    settle.drop();
    const restarted = open();
    await restarted.start();
    expect(await entryOf(restarted, p.id)).toMatchObject({
      state: "partial",
      outcome: { name: "unavailable", label: "applied" },
    });
  });

  it("a worker whose claim recovery settled between fields writes nothing more", async () => {
    const { host, open, gateway } = applying();
    const p = await seed(host, { label: "Helper", effort: "high" });
    // Holds the worker's ledger read right before its next write, after the label landed.
    let armed = false;
    const next = host.store.hold("ledger", "read", () => {
      const hit = armed;
      armed = false;
      return hit;
    });
    gateway.faults.after = (step) => {
      if (step === "label") armed = true;
    };
    const answer = accept(host, p);
    // Without the check the worker never makes that read: it answers, and the assertions below say why.
    await Promise.race([next.reached, answer]);
    armed = false;
    await open().records.settleAbandoned();
    next.release();
    expect((await answer).payload).toMatchObject({ state: "partial" });
    expect(gateway.writes.map((w) => w.step)).toEqual(["label"]);
  });

  it("settling counts a step applied only when its journal entry is attached", () => {
    const l = L.emptyLedger();
    const id = `p_${"1".repeat(32)}`;
    const source = { kind: "bot", bot: "pip" };
    L.admit(
      l,
      { id, digest: "d", source, bot: PIP, fields: ["label"], createdAt: T, expiresAt: T + DAY },
      T,
    );
    L.claimForApply(l, id, "d", T, { by: null, epoch: "e", steps: ["label"] });
    expect(
      L.settleClaim(
        l,
        "proposal",
        id,
        1,
        { outcome: { label: "applied" }, observed: undefined },
        T,
      ),
    ).toEqual({
      state: "unknown",
      outcome: { label: "unknown" },
    });
  });

  it("a lost answer after an independent admin writes the same value, or restores the base: unknown, with what each reads, and never resent", async () => {
    for (const [admin, reads] of [
      ["Helper", "Helper"],
      ["Old", "Old"],
    ] as const) {
      const { host, gateway } = applying({ label: "Old" });
      const p = await seed(host);
      gateway.faults.lose.add("label");
      gateway.faults.after = () => gateway.set(PIP, "label", admin);
      expect((await accept(host, p)).payload).toMatchObject({
        state: "unknown",
        outcome: { label: "unknown" },
      });
      expect((await entryOf(host, p.id)).observed).toEqual({ label: reads });
      expect(gateway.writes).toHaveLength(1);
    }
  });

  it("a lost answer whose read-back fails too settles unknown, with nothing observed, at once and in recovery", async () => {
    const { host, gateway } = applying({ label: "Old" });
    const p = await seed(host);
    gateway.faults.lose.add("label");
    gateway.faults.read = () => {
      throw new Error("the read failed");
    };
    expect((await accept(host, p)).payload).toMatchObject({
      state: "unknown",
      outcome: { label: "unknown" },
    });
    const settled = await entryOf(host, p.id);
    expect(settled).toMatchObject({ state: "unknown", reserved: 0 });
    expect(settled).not.toHaveProperty("observed");

    const crashed = applying({ label: "Old" });
    const q = await seed(crashed.host);
    let reached = () => {};
    const writing = new Promise<void>((resolve) => (reached = resolve));
    crashed.gateway.faults.before = () => (reached(), never());
    void accept(crashed.host, q);
    await writing;
    crashed.gateway.faults.before = () => {};
    crashed.gateway.faults.read = () => {
      throw new Error("the read failed");
    };
    const restarted = crashed.open();
    await restarted.start();
    const recovered = await entryOf(restarted, q.id);
    expect(recovered).toMatchObject({ state: "unknown", reserved: 0 });
    expect(recovered).not.toHaveProperty("observed");
  });

  it("a bot's request for itself is written without reading the config", async () => {
    const { host, gateway } = applying({ label: "Old" });
    const p = await seed(host);
    const before = host.dispatched.length;
    expect((await accept(host, p)).payload).toMatchObject({ state: "accepted" });
    expect(host.dispatched.slice(before)).not.toContain("config.get");
    expect(gateway.writes).toEqual([{ bot: "pip", step: "label", value: "Helper" }]);
  });

  it("a bot's request for another bot stops before a write once the proposer's manager grant is gone: before the first field, or after it", async () => {
    for (const removed of ["before", "after the label"]) {
      const { open, gateway } = applying();
      const grant = {
        plugins: { entries: { "clawtrate-bots": { config: { managers: [MAIN] } } } },
      };
      const host = open(grant);
      const source = { kind: "bot", bot: "main", createdAt: 1 };
      const p = await seed(host, { label: "Helper", effort: "high" }, { source });
      if (removed === "before") host.config.value = {};
      else gateway.faults.after = () => (host.config.value = {});
      expect((await accept(host, p)).payload).toMatchObject(
        removed === "before"
          ? { state: "stale", outcome: { label: "not-applied", effort: "not-applied" } }
          : { state: "partial", outcome: { label: "applied", effort: "not-applied" } },
      );
      expect(gateway.writes).toHaveLength(removed === "before" ? 0 : 1);
    }
  });

  it("the service removes journal entries after 90 days, and finishes a deletion it left marked", async () => {
    const { host, open, clock, journal } = applying();
    const p = await seed(host);
    await accept(host, p);
    const key = keyOf(p.id, "label");
    const restarted = open();
    await restarted.records.transact((l) => {
      l.journalDeleting = ["j:pending"];
    });
    journal.rows.set("j:pending", { json: "{}", rev: 0 });
    clock.now = T + L.JOURNAL_RETAIN_MS - 1;
    await restarted.start();
    expect([journal.rows.has("j:pending"), journal.rows.has(key)]).toEqual([false, true]);
    expect((await restarted.records.ledger()).journalDeleting).toBeUndefined();
    clock.now = T + L.JOURNAL_RETAIN_MS;
    expect(await restarted.records.journalRetention()).toEqual([key]);
    expect([journal.rows.has(key), (await restarted.records.ledger()).journal]).toEqual([
      false,
      {},
    ]);
  });

  it("a retention run clears only its own deletion mark, so a concurrent run's mark survives a failed delete", async () => {
    const { host, journal } = applying();
    const old = keyOf(`p_${"2".repeat(32)}`, "label");
    await host.records.transact((l) => {
      l.journal = { [old]: { at: T - L.JOURNAL_RETAIN_MS, target: "b:1:label", digest: "d" } };
      l.journalDeleting = ["j:pending"];
    });
    for (const key of ["j:pending", old]) journal.rows.set(key, { json: "{}", rev: 0 });
    // Run B finishes the pending deletion and is held at clearing its mark.
    let first = true;
    const clear = host.store.hold("ledger", "cas", (value) => {
      const hit = first && !(value as Ledger)?.journalDeleting;
      if (hit) first = false;
      return hit;
    });
    const b = host.records.journalRetention();
    await clear.reached;
    // Run A finishes the same deletion, marks the expired row, and stops while deleting it.
    const mark = host.store.hold("ledger", "cas", (value) =>
      Boolean((value as Ledger)?.journalDeleting?.includes(old)),
    );
    const a = host.records.journalRetention().catch((error: Error) => error.message);
    await mark.reached;
    journal.faults.failNextDelete = true;
    mark.release();
    expect(await a).toBe("the delete failed");
    clear.release();
    await b;
    expect((await host.records.ledger()).journalDeleting).toEqual([old]);
    expect(await host.records.journalRetention()).toContain(old);
    expect(journal.rows.has(old)).toBe(false);
  });
});

describe("Undo", () => {
  const applied = async (initial: Json = { label: "Old" }, fields: Json = { label: "Helper" }) => {
    const setup = applying(initial);
    const p = await seed(setup.host, fields);
    await accept(setup.host, p);
    const step = Object.keys(fields)[0]!;
    const undo = (allow?: boolean) =>
      setup.host.call("changes.undo", { id: keyOf(p.id, step), ...(allow ? { allow } : {}) });
    return { ...setup, p, undo, step };
  };

  it("restores the journaled value under its one read's token, and a retry after a lost answer finds the first", async () => {
    const { gateway, undo } = await applied();
    expect((await undo()).payload).toMatchObject({ state: "undone" });
    expect(gateway.get(PIP, "label").value).toBe("Old");
    const lost = await applied();
    lost.gateway.faults.lose.add("label");
    expect((await lost.undo()).payload).toMatchObject({ state: "unknown" });
    const writes = lost.gateway.writes.length;
    expect((await lost.undo()).payload).toMatchObject({ state: "unknown" });
    expect(lost.gateway.writes).toHaveLength(writes);
    // The Undo's version is referenced, so cleanup keeps it.
    await lost.host.records.sweepOrphans();
    lost.clock.mono += 2 * HOUR;
    await lost.host.records.sweepOrphans();
    expect(lost.versions.rows.has(`v:${undoId(keyOf(lost.p.id, "label"))}`)).toBe(true);
    const ledger = await lost.host.records.ledger();
    expect(Object.keys(ledger.undos!)).toEqual([undoId(keyOf(lost.p.id, "label"))]);
    expect(gateway.writes).toHaveLength(2);
  });

  it("writes nothing when the field changed since, before the read or between the read and the write; a later Undo is a new attempt", async () => {
    const { gateway, undo, host, p } = await applied();
    gateway.set(PIP, "label", "Edited");
    expect((await undo()).payload).toMatchObject({
      state: "changed",
      observed: { label: "Edited" },
    });
    gateway.set(PIP, "label", "Helper");
    gateway.faults.before = () => gateway.set(PIP, "label", "Edited again");
    expect((await undo()).payload).toMatchObject({ state: "changed" });
    expect(gateway.writes).toHaveLength(1);
    gateway.faults.before = () => {};
    gateway.set(PIP, "label", "Helper");
    expect((await undo()).payload).toMatchObject({ state: "undone" });
    const id = undoId(keyOf(p.id, "label"));
    expect((await host.records.ledger()).undos![id].effects).toEqual([keyOf(id, "label", 3)]);
  });

  it("an Undo that would restore more freedom asks first", async () => {
    const { undo, host } = await applied({ autonomy: "hands-off" }, { autonomy: "ask" });
    const asked = await undo();
    expect([reasonOf(asked), asked.error?.message]).toEqual([
      "more-freedom",
      "Undo lets pip run hands-off again.",
    ]);
    expect((await host.records.ledger()).undos).toBeUndefined();
    expect((await undo(true)).payload).toMatchObject({ state: "undone" });
  });

  it("is offered for 7 days, until the next change to the same field", async () => {
    const { host, clock, p, gateway } = await applied();
    clock.now += 60_000;
    const later = await seed(
      host,
      { label: "Later" },
      { tokens: { label: gateway.get(PIP, "label").token } },
    );
    await accept(host, later);
    const offered = async () =>
      ((await host.call("changes.list")).payload!.changes as Json[]).map((c) => c.undo);
    expect(await offered()).toEqual([true, false]);
    expect(reasonOf(await host.call("changes.undo", { id: keyOf(p.id, "label") }))).toBe(
      "undo-unavailable",
    );
    clock.now += 7 * DAY;
    expect(await offered()).toEqual([false, false]);
  });
});

describe("managers", () => {
  it("a bot proposes for itself, and for another bot only with its own incarnation's grant; the star grants nothing", () => {
    expect(mayPropose([], PIP, PIP)).toBe(true);
    // main is the Main Bot here, with no grant.
    expect(mayPropose([], MAIN, PIP)).toBe(false);
    expect(mayPropose([MAIN], MAIN, PIP)).toBe(true);
    expect(mayPropose([{ id: "main", createdAt: 9 }], MAIN, PIP)).toBe(false);
    expect(mayPropose([MAIN], PIP, MAIN)).toBe(false);
  });

  it("managers.set writes the grants by incarnation to the plugin's own config under the hash it read, and reads them back", async () => {
    const host = load({ now: () => T, startService: false });
    // Writing them keeps the plugin's instance, which reads them fresh; a replacement would wait on this call.
    expect(host.reloads).toEqual([
      { noopPrefixes: ["plugins.entries.clawtrate-bots.config.managers"] },
    ]);
    const set = await host.call("managers.set", { bots: ["main", "pip", "main"] });
    expect(set.payload).toEqual({ managers: [MAIN, PIP] });
    expect(host.config.patches).toHaveLength(1);
    const [patch] = host.config.patches as {
      raw: string;
      baseHash: string;
      replacePaths: string[];
    }[];
    expect(JSON.parse(patch!.raw)).toEqual({
      plugins: { entries: { "clawtrate-bots": { config: { managers: [MAIN, PIP] } } } },
    });
    expect([patch!.baseHash, patch!.replacePaths]).toEqual([
      "h0",
      ["plugins.entries.clawtrate-bots.config.managers"],
    ]);
    expect((await host.call("managers.set", { bots: [] })).payload).toEqual({ managers: [] });
    expect(reasonOf(await host.call("managers.set", { bots: ["nobody"] }))).toBe("bot");
    expect(reasonOf(await host.call("managers.set", { bots: [] }, { inProcess: true }))).toBe(
      "operator-required",
    );
    expect(host.config.patches).toHaveLength(2);
  });
});
