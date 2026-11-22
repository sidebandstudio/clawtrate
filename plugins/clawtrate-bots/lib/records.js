// The records: immutable versions, and the one ledger row that refers to them
// (docs/design/main-bot-onboarding.md, section 9), in one retained keyed store
// of the gateway's database. A retained store has no eviction and no TTL
// (OpenClaw 2026.10.6, docs/plugins/sdk-runtime/state-and-system.md), so the
// ledger enforces the limits and the plugin's own sweep does the expiry.
//
//   ledger    the ledger (lib/ledger.js), changed only by compareAndApply, in
//             the retained namespace, so a decision can always be stored
//   v:<id>    a version, written once: { body, digest, storedAt }, in a
//             bounded namespace of its own that refuses new rows when full
//
// Persist first, then publish: a version is written in full before the ledger
// refers to it, and readers use only versions the ledger refers to, with a
// matching digest. Cleanup and publication exclude each other through the
// ledger: a publisher checks, after each observation, that the version still
// exists and isn't being swept; cleanup marks the one version it deletes in
// the ledger first, deletes it, then clears the mark. Cleanup takes only
// versions nothing refers to: unpublished ones, replaced grant versions, and
// those of settled requests whose ledger entries retention has removed.

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
/** Versions are bounded; the sweep reclaims those nothing refers to any more. */
export const VERSIONS = { namespace: "versions", maxEntries: 512, overflowPolicy: "reject-new" };
const LEDGER = "ledger";
const VERSION = "v:";
const PAGE = 500;
/** compareAndApply retries before giving up; each retry means another change landed. */
const ATTEMPTS = 50;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export class Records {
  constructor(store, versions, { now = Date.now, onChange = () => {} } = {}) {
    for (const need of ["observe", "compareAndApply", "withCurrent"])
      if (typeof store[need] !== "function")
        throw new Error(`clawtrate-bots needs the gateway's keyed store to offer ${need}.`);
    this.store = store;
    for (const need of ["entriesInKeyRange", "delete"])
      if (typeof versions[need] !== "function")
        throw new Error(`clawtrate-bots needs the gateway's keyed store to offer ${need}.`);
    this.versions = versions;
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
   * each observation; the clock is read again after it, and expiry run again,
   * before the change. `deadline`, if given, is when the change stops being
   * valid: the store checks it up to its commit. A Refusal writes nothing.
   * On a conflict it starts again from what is stored.
   * @template R
   * @param {(ledger: ReturnType<typeof emptyLedger>, now: number) => R} change
   * @param {(ledger: ReturnType<typeof emptyLedger>, now: number) => Promise<void>} [verify]
   * @param {(ledger: ReturnType<typeof emptyLedger>) => number} [deadline]
   * @returns {Promise<R>}
   */
  async transact(change, verify, deadline) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const seen = await this.store.observe(LEDGER);
      const before = seen.value ?? emptyLedger();
      const ledger = structuredClone(before);
      sweep(ledger, this.now());
      if (verify) await verify(ledger, this.now());
      const now = this.now();
      sweep(ledger, now);
      const until = deadline?.(ledger) ?? Infinity;
      const result = change(ledger, now);
      if (digestOf(ledger) === digestOf(before) && seen.value) return result;
      // A revision on every stored change, so no change restores an earlier row.
      ledger.rev = (before.rev ?? 0) + 1;
      let late = false;
      const store = this.store.withCurrent({
        assertCurrent: () => {
          if (this.now() < until) return;
          late = true;
          throw new Refusal("expired", "This expired before the change was stored.");
        },
      });
      let out;
      try {
        out = await store.compareAndApply(LEDGER, seen.comparison, {
          operation: "update",
          action: "set",
          value: ledger,
        });
      } catch (error) {
        if (late) throw new Refusal("expired", "This expired before the change was stored.");
        throw error;
      }
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
    let stored;
    try {
      stored = await this.versions.registerIfAbsent(VERSION + id, {
        body: clean,
        digest,
        storedAt: this.now(),
      });
    } catch (error) {
      if (error?.code !== "PLUGIN_STATE_LIMIT_EXCEEDED") throw error;
      throw new Refusal(
        "records-full",
        "Clawtrate has stored as many requests as its bots plugin keeps in this version, and nothing frees that space yet. New requests can't be recorded.",
      );
    }
    if (!stored) throw new Error("A record with this id already exists.");
    return digest;
  }

  /** A version, if it exists, reads and matches the digest the ledger holds; null otherwise. */
  async version(id, digest) {
    let row;
    try {
      row = await this.versions.lookup(VERSION + id);
    } catch (error) {
      if (error?.code === "PLUGIN_STATE_CORRUPT") return null;
      throw error;
    }
    if (!isObject(row) || !isObject(row.body) || row.digest !== digest) return null;
    return digestOf(row.body) === digest ? row.body : null;
  }

  /**
   * Publishes a stored version with `change`, checking after each observation
   * that it still exists and reads. The change itself refuses the version
   * cleanup is deleting.
   * @template R
   * @param {string} id
   * @param {string} digest
   * @param {(ledger: ReturnType<typeof emptyLedger>, now: number) => R} change
   * @param {(ledger: ReturnType<typeof emptyLedger>) => number} [deadline]
   * @returns {Promise<R>}
   */
  publish(id, digest, change, deadline) {
    return this.transact(
      change,
      async () => {
        if (!(await this.version(id, digest)))
          throw new Refusal("unpublishable", "Clawtrate couldn't record this. Try again.");
      },
      deadline,
    );
  }

  /**
   * Reclaims versions nothing has referred to for an hour. One sweep at a
   * time; a deletion an earlier sweep left marked is finished first.
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
        const page = await this.versions.entriesInKeyRange({
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
    await this.versions.delete(VERSION + id);
    await this.transact((l) => clearSweeping(l, id));
    removed.push(id);
  }
}
