// The records: immutable versions, and the one ledger row that refers to them
// (docs/design/main-bot-onboarding.md, section 9), in one retained keyed store
// of the gateway's database. A retained store has no eviction and no TTL
// (OpenClaw 2026.10.6, docs/plugins/sdk-runtime/state-and-system.md), so the
// ledger enforces the limits and the plugin's own sweep does the expiry.
//
//   v:<id>    a version, written once: { body, digest, storedAt }
//   ledger    the ledger (lib/ledger.js), changed only by compareAndApply
//
// Persist first, then publish: a version is written in full before the ledger
// refers to it, and readers use only versions the ledger refers to, with a
// matching digest.

import { canonical, digestOf } from "./canonical.js";
import { EXPIRES_MS, ORPHAN_MS, emptyLedger, referenced, sweep, tombstone } from "./ledger.js";

export const NAMESPACE = "records";
const LEDGER = "ledger";
const VERSION = "v:";
const PAGE = 500;
/** compareAndApply retries before giving up; each retry means another change landed. */
const ATTEMPTS = 50;

export class Records {
  constructor(store, { now = Date.now, onChange = () => {} } = {}) {
    for (const need of ["observe", "compareAndApply", "registerIfAbsent", "entriesInKeyRange"])
      if (typeof store[need] !== "function")
        throw new Error(`clawtrate-bots needs the gateway's keyed store to offer ${need}.`);
    this.store = store;
    this.now = now;
    this.onChange = onChange;
  }

  /** @returns {Promise<ReturnType<typeof emptyLedger>>} */
  async ledger() {
    return (await this.store.lookup(LEDGER)) ?? emptyLedger();
  }

  /**
   * Runs `change` on the current ledger after expiry and retention, and
   * stores the result in one compareAndApply. A Refusal thrown by `change`
   * writes nothing. On a conflict it starts again from what is stored.
   * @template R
   * @param {(ledger: ReturnType<typeof emptyLedger>, now: number) => R} change
   * @returns {Promise<R>}
   */
  async transact(change) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const seen = await this.store.observe(LEDGER);
      const before = seen.value ?? emptyLedger();
      const ledger = structuredClone(before);
      const now = this.now();
      const removed = sweep(ledger, now);
      const result = change(ledger, now);
      if (digestOf(ledger) === digestOf(before) && seen.value) return result;
      const out = await this.store.compareAndApply(LEDGER, seen.comparison, {
        operation: "update",
        action: "set",
        value: ledger,
      });
      if (out.status === "conflict") continue;
      for (const id of removed) await this.store.delete(VERSION + id);
      this.onChange();
      return result;
    }
    throw new Error("The gateway's request records kept changing. Try again.");
  }

  /** Writes a version once. Its digest covers every field of the body. */
  async persist(id, body) {
    // The store takes only JSON values: the canonical form leaves out undefined.
    const clean = JSON.parse(canonical(body));
    const digest = digestOf(clean);
    const stored = await this.store.registerIfAbsent(VERSION + id, {
      body: clean,
      digest,
      storedAt: this.now(),
    });
    if (!stored) throw new Error("A record with this id already exists.");
    return digest;
  }

  /** A version, if it exists and matches the digest the ledger holds; null otherwise. */
  async version(id, digest) {
    const row = await this.store.lookup(VERSION + id);
    if (!row || row.digest !== digest || digestOf(row.body) !== digest) return null;
    return row.body;
  }

  /**
   * Reclaims versions nothing has referred to for an hour: never published,
   * or replaced. Each is first marked swept in a ledger update, which a
   * publisher's update would conflict with, so the two can't both land.
   */
  async sweepOrphans() {
    const now = this.now();
    let start = VERSION;
    const removed = [];
    for (;;) {
      const page = await this.store.entriesInKeyRange({
        keyStartInclusive: start,
        keyEndExclusive: "v;",
        limit: PAGE,
      });
      const ledger = await this.ledger();
      const live = referenced(ledger);
      for (const { key, value } of page) {
        const id = key.slice(VERSION.length);
        if (live.has(id) || !(value?.storedAt + ORPHAN_MS <= now)) continue;
        if (await this.transact((l, at) => tombstone(l, id, at + EXPIRES_MS))) {
          await this.store.delete(key);
          removed.push(id);
        }
      }
      if (page.length < PAGE) return removed;
      start = `${page[page.length - 1].key}\u0000`;
    }
  }
}
