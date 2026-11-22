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
// matching digest. Nothing deletes a version yet: reclaiming unpublished ones
// comes with the journal's cleanup.

import { canonical, digestOf } from "./canonical.js";
import { Refusal, emptyLedger, sweep } from "./ledger.js";

export const NAMESPACE = "records";
/** Versions are bounded: nothing deletes one in this part, and a refused submission keeps no row. */
export const VERSIONS = { namespace: "versions", maxEntries: 512, overflowPolicy: "reject-new" };
const LEDGER = "ledger";
const VERSION = "v:";
/** compareAndApply retries before giving up; each retry means another change landed. */
const ATTEMPTS = 50;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export class Records {
  constructor(store, versions, { now = Date.now, onChange = () => {} } = {}) {
    for (const need of ["observe", "compareAndApply", "withCurrent"])
      if (typeof store[need] !== "function")
        throw new Error(`clawtrate-bots needs the gateway's keyed store to offer ${need}.`);
    this.store = store;
    this.versions = versions;
    this.now = now;
    this.onChange = onChange;
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
   * that it still exists and reads.
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
}
