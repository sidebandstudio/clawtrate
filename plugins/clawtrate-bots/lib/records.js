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
// matching digest. Cleanup and publication exclude each other through the
// ledger: a publisher checks, after each observation, that the version still
// exists and isn't being swept; cleanup marks the one version it deletes in
// the ledger first, deletes it, then clears the mark.

import { canonical, digestOf } from "./canonical.js";
import {
  ORPHAN_MS,
  Refusal,
  clearSweeping,
  emptyLedger,
  markSweeping,
  referenced,
  sweep,
} from "./ledger.js";

export const NAMESPACE = "records";
const LEDGER = "ledger";
const VERSION = "v:";
const PAGE = 500;
/** compareAndApply retries before giving up; each retry means another change landed. */
const ATTEMPTS = 50;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export class Records {
  constructor(store, { now = Date.now, onChange = () => {} } = {}) {
    for (const need of ["observe", "compareAndApply", "registerIfAbsent", "entriesInKeyRange"])
      if (typeof store[need] !== "function")
        throw new Error(`clawtrate-bots needs the gateway's keyed store to offer ${need}.`);
    this.store = store;
    this.now = now;
    this.onChange = onChange;
    this.sweepRunning = false;
  }

  /** @returns {Promise<ReturnType<typeof emptyLedger>>} */
  async ledger() {
    return (await this.store.lookup(LEDGER)) ?? emptyLedger();
  }

  /**
   * Runs `change` on the current ledger after expiry and retention, and
   * stores the result in one compareAndApply. `verify`, if given, runs after
   * each observation and before the change. A Refusal from either writes
   * nothing. On a conflict it starts again from what is stored.
   * @template R
   * @param {(ledger: ReturnType<typeof emptyLedger>, now: number) => R} change
   * @param {(ledger: ReturnType<typeof emptyLedger>, now: number) => Promise<void>} [verify]
   * @returns {Promise<R>}
   */
  async transact(change, verify) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const seen = await this.store.observe(LEDGER);
      const before = seen.value ?? emptyLedger();
      const ledger = structuredClone(before);
      const now = this.now();
      sweep(ledger, now);
      if (verify) await verify(ledger, now);
      const result = change(ledger, now);
      if (digestOf(ledger) === digestOf(before) && seen.value) return result;
      // A revision on every stored change: a mark and its clearing never restore an earlier row.
      ledger.rev = (before.rev ?? 0) + 1;
      const out = await this.store.compareAndApply(LEDGER, seen.comparison, {
        operation: "update",
        action: "set",
        value: ledger,
      });
      if (out.status === "conflict") continue;
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

  /** A version, if it exists, reads and matches the digest the ledger holds; null otherwise. */
  async version(id, digest) {
    let row;
    try {
      row = await this.store.lookup(VERSION + id);
    } catch (error) {
      if (error?.code === "PLUGIN_STATE_CORRUPT") return null;
      throw error;
    }
    if (!isObject(row) || !isObject(row.body) || row.digest !== digest) return null;
    return digestOf(row.body) === digest ? row.body : null;
  }

  /**
   * Publishes a stored version with `change`, checking after each observation
   * that cleanup hasn't taken it.
   * @template R
   * @param {string} id
   * @param {string} digest
   * @param {(ledger: ReturnType<typeof emptyLedger>, now: number) => R} change
   * @returns {Promise<R>}
   */
  publish(id, digest, change) {
    return this.transact(change, async (ledger) => {
      if (ledger.sweeping === id || !(await this.version(id, digest)))
        throw new Refusal("unpublishable", "Clawtrate couldn't record this. Try again.");
    });
  }

  /**
   * Reclaims versions nothing has referred to for an hour: never published,
   * replaced, or settled and removed. One sweep at a time; a deletion an
   * earlier sweep left marked is finished first.
   */
  async sweepOrphans() {
    if (this.sweepRunning) return [];
    this.sweepRunning = true;
    const removed = [];
    try {
      const pending = (await this.ledger()).sweeping;
      if (pending) await this.reclaim(pending, removed);
      const now = this.now();
      let start = VERSION;
      for (;;) {
        const page = await this.store.entriesInKeyRange({
          keyStartInclusive: start,
          keyEndExclusive: "v;",
          limit: PAGE,
        });
        const live = referenced(await this.ledger());
        for (const { key, value } of page) {
          const id = key.slice(VERSION.length);
          if (live.has(id) || !(value?.storedAt + ORPHAN_MS <= now)) continue;
          if (await this.transact((l) => markSweeping(l, id))) await this.reclaim(id, removed);
        }
        if (page.length < PAGE) return removed;
        start = `${page[page.length - 1].key}\u0000`;
      }
    } finally {
      this.sweepRunning = false;
    }
  }

  async reclaim(id, removed) {
    await this.store.delete(VERSION + id);
    await this.transact((l) => clearSweeping(l, id));
    removed.push(id);
  }
}
