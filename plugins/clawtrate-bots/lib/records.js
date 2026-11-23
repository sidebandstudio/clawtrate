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
//   j:<change>:<attempt>:<field>
//             a journal entry, written once, the same way, in a retained
//             namespace of its own: evidence of a confirmed effect even
//             before the ledger refers to it, so the orphan sweep, which
//             scans only the versions, never sees it. Retention removes
//             entries (journalRetention), and recovery attaches unreferenced
//             ones first (settleAbandoned)
//
// Persist first, then publish: a version is written in full before the ledger
// refers to it, and readers use only versions the ledger refers to, with a
// matching digest. Cleanup and publication exclude each other through the
// ledger: a publisher checks, after each observation, that the version still
// exists and isn't being swept; cleanup marks the one version it deletes in
// the ledger first, deletes it, then clears the mark. Cleanup takes only
// versions nothing refers to: unpublished ones, replaced grant versions, and
// those of settled requests whose ledger entries retention has removed.

import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { canonical, digestOf } from "./canonical.js";
import {
  ORPHAN_MS,
  Refusal,
  attach,
  clearAge,
  journalExpired,
  journalKey,
  markJournal,
  settleClaim,
  clearSweeping,
  emptyLedger,
  markSweeping,
  recordAges,
  referenced,
  sweep,
} from "./ledger.js";

export const NAMESPACE = "records";
/** Versions are bounded; the sweep reclaims those nothing refers to any more. */
export const VERSIONS = { namespace: "versions", maxEntries: 512, overflowPolicy: "reject-new" };
export const JOURNAL = { namespace: "journal", retention: "retained" };
const LEDGER = "ledger";
const VERSION = "v:";
/**
 * Versions read per scan page. The store decodes every row of a page, and a
 * row is at most 1 MiB of JSON (the SDK's limit for one value), so a page is
 * at most 16 MiB of JSON however large the bodies are.
 */
const PAGE = 16;
/** The end of the versions' key range, and the longest key the store takes. */
const END = "v;";
const KEY_MAX = 512;
/** compareAndApply retries before giving up; each retry means another change landed. */
const ATTEMPTS = 50;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export class Records {
  constructor(
    store,
    versions,
    {
      now = Date.now,
      monotonic = () => performance.now(),
      onChange = () => {},
      journal = null,
    } = {},
  ) {
    for (const need of ["observe", "compareAndApply", "withCurrent"])
      if (typeof store[need] !== "function")
        throw new Error(`clawtrate-bots needs the gateway's keyed store to offer ${need}.`);
    this.store = store;
    for (const need of ["entriesInKeyRange", "delete"])
      if (typeof versions[need] !== "function")
        throw new Error(`clawtrate-bots needs the gateway's keyed store to offer ${need}.`);
    this.versions = versions;
    this.journal = journal;
    this.now = now;
    this.onChange = onChange;
    this.sweepRunning = false;
    // Ages are measured on this process's monotonic clock, so they belong to this epoch alone.
    this.epoch = randomBytes(8).toString("hex");
    this.monotonic = monotonic;
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
      // observe() returns a freshly decoded row; snapshot its JSON instead of cloning up to 512 orphanAges.
      const ledger = seen.value ?? emptyLedger();
      const beforeJson = seen.value ? JSON.stringify(ledger) : null;
      const beforeVisible = JSON.stringify([ledger.proposals, ledger.grants]);
      sweep(ledger, this.now());
      if (verify) await verify(ledger, this.now());
      const now = this.now();
      sweep(ledger, now);
      const until = deadline?.(ledger) ?? Infinity;
      const result = change(ledger, now);
      if (beforeJson !== null && JSON.stringify(ledger) === beforeJson) return result;
      // A revision on every stored change, so no change restores an earlier row.
      ledger.rev = (ledger.rev ?? 0) + 1;
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
      if (JSON.stringify([ledger.proposals, ledger.grants]) !== beforeVisible) this.onChange();
      return result;
    }
    throw new Error("The gateway's request records kept changing. Try again.");
  }

  /** Writes a version once. Its digest covers every field of the body. */
  async persist(id, body) {
    const { stored, digest } = await this.write(this.versions, VERSION + id, body);
    if (!stored) throw new Error("A record with this id already exists.");
    return digest;
  }

  /**
   * Writes a version once, or finds the same one already written: an Undo is
   * idempotent by id, so a retry stores nothing new.
   */
  async persistOnce(id, body) {
    const { stored, digest } = await this.write(this.versions, VERSION + id, body);
    if (!stored && !(await this.version(id, digest)))
      throw new Refusal("unpublishable", "Clawtrate couldn't record this. Try again.");
    return digest;
  }

  /** Writes a confirmed effect's journal entry once under its key; a retry under the same key with the same entry succeeds. */
  async writeEntry(key, body) {
    const { stored, digest } = await this.write(this.journal, key, body);
    if (!stored && !(await this.entry(key, digest)))
      throw new Error("A different journal entry has this key.");
    return digest;
  }

  /** A journal entry, if it reads and matches its digest (any digest when none is given); null otherwise. */
  async entry(key, digest) {
    return read(this.journal, key, digest);
  }

  async write(store, key, body) {
    // The store takes only JSON values: the canonical form leaves out undefined.
    const clean = JSON.parse(canonical(body));
    const digest = digestOf(clean);
    let stored;
    try {
      stored = await store.registerIfAbsent(key, { body: clean, digest, storedAt: this.now() });
    } catch (error) {
      if (error?.code !== "PLUGIN_STATE_LIMIT_EXCEEDED") throw error;
      throw new Refusal(
        "records-full",
        "Clawtrate's request records on this gateway are full. Try again after the gateway clears older records.",
      );
    }
    return { stored, digest };
  }

  /** A version, if it exists, reads and matches the digest the ledger holds; null otherwise. */
  async version(id, digest) {
    return read(this.versions, VERSION + id, digest);
  }

  /**
   * Publishes a stored version with `change`, checking after each observation
   * that it still exists and reads. The same update refuses the version
   * cleanup is deleting, and clears the version's orphan age.
   * @template R
   * @param {string} id
   * @param {string} digest
   * @param {(ledger: ReturnType<typeof emptyLedger>, now: number) => R} change
   * @param {(ledger: ReturnType<typeof emptyLedger>) => number} [deadline]
   * @returns {Promise<R>}
   */
  publish(id, digest, change, deadline) {
    return this.transact(
      (ledger, now) => {
        if (ledger.sweeping === id)
          throw new Refusal("unpublishable", "Clawtrate couldn't record this. Try again.");
        const result = change(ledger, now);
        clearAge(ledger, id);
        return result;
      },
      async () => {
        if (!(await this.version(id, digest)))
          throw new Refusal("unpublishable", "Clawtrate couldn't record this. Try again.");
      },
      deadline,
    );
  }

  /**
   * Reclaims versions nothing has referred to for an hour, continuously, as
   * this process has seen them: each scanned page records when its
   * unreferenced rows were first seen, and a row is marked for deletion only
   * an hour after that. A restart starts a fresh observation. One sweep at a
   * time; a deletion an earlier sweep (in any process) left marked is
   * finished first.
   */
  async sweepOrphans() {
    if (this.sweepRunning) return [];
    this.sweepRunning = true;
    const removed = [];
    const ages = () => ({ epoch: this.epoch, now: this.monotonic() });
    try {
      const pending = (await this.ledger()).sweeping;
      if (pending) await this.reclaim(pending, removed);
      let start = VERSION;
      for (;;) {
        const { page, unreadable } = await this.scan(start);
        const live = referenced(await this.ledger());
        const keys = [...page.map(({ key }) => key), ...(unreadable ? [unreadable] : [])];
        const ids = keys.map((key) => key.slice(VERSION.length)).filter((id) => !live.has(id));
        const due = ids.length
          ? await this.transact((l) => {
              const at = ages();
              recordAges(l, ids, at);
              const since = l.orphanAges?.epoch === at.epoch ? l.orphanAges.since : null;
              return since
                ? ids.filter((id) => Object.hasOwn(since, id) && at.now - since[id] >= ORPHAN_MS)
                : [];
            })
          : [];
        // Clear the finished deletion and mark the next due orphan in one ledger update.
        let marked = null;
        for (const id of due) {
          if (marked) {
            await this.versions.delete(VERSION + marked);
            removed.push(marked);
          }
          const prev = marked;
          marked = (await this.transact((l) => {
            if (prev) clearSweeping(l, prev);
            return markSweeping(l, id, ages());
          }))
            ? id
            : null;
        }
        if (marked) await this.reclaim(marked, removed);
        if (!unreadable && page.length < PAGE) return removed;
        start = `${unreadable ?? page[page.length - 1].key}\u0000`;
      }
    } finally {
      this.sweepRunning = false;
    }
  }

  /**
   * A page of versions from `start`. The store decodes each row it returns
   * and throws PLUGIN_STATE_CORRUPT, with no key, when one doesn't read; it
   * applies the limit first. So on that error the page is the readable rows
   * before the bad one, and `unreadable` is the bad row's key, found by range
   * probes, so the sweep goes on past it. An unreadable row nothing refers to
   * is reclaimed like any other after its hour (it can never be published:
   * version() can't read it); one the ledger refers to is never marked.
   */
  async scan(start) {
    const range = (lo, hi, limit) =>
      this.versions.entriesInKeyRange({ keyStartInclusive: lo, keyEndExclusive: hi, limit });
    const unreadableRow = (error) => {
      if (error?.code !== "PLUGIN_STATE_CORRUPT") throw error;
      return null;
    };
    const page = await range(start, END, PAGE).catch(unreadableRow);
    if (page) return { page, unreadable: null };
    // The longest readable run before the bad row: the largest limit that reads.
    let good = [];
    for (let low = 0, high = PAGE; high - low > 1;) {
      const mid = (low + high) >> 1;
      const rows = await range(start, END, mid).catch(unreadableRow);
      if (rows) [good, low] = [rows, mid];
      else high = mid;
    }
    const from = good.length ? `${good[good.length - 1].key}\u0000` : start;
    return { page: good, unreadable: await this.firstKeyFrom(from) };
  }

  /**
   * The first key at or after `from`, when its row can't be read. A range
   * [from, hi) holds that row exactly when hi is past its key, so the key is
   * found a character at a time (keys are ASCII: "v:" and generated ids).
   */
  async firstKeyFrom(from) {
    const holds = async (hi) => {
      if (hi <= from) return false;
      try {
        return (
          (
            await this.versions.entriesInKeyRange({
              keyStartInclusive: from,
              keyEndExclusive: hi,
              limit: 1,
            })
          ).length > 0
        );
      } catch (error) {
        if (error?.code !== "PLUGIN_STATE_CORRUPT") throw error;
        return true;
      }
    };
    let key = "";
    while (key.length <= KEY_MAX) {
      if (await holds(`${key}\u0000`)) return key;
      let low = 0;
      for (let high = 128; high - low > 1;) {
        const mid = (low + high) >> 1;
        if (await holds(key + String.fromCharCode(mid))) high = mid;
        else low = mid;
      }
      key += String.fromCharCode(low);
    }
    throw new Error("clawtrate-bots couldn't find the unreadable version's key.");
  }

  /**
   * Settles claims a stopped worker left `committing` (another epoch's: this
   * Records' own claims belong to live workers). Each step's journal entry is
   * looked up by its key and attached; a step with none is unknown when it may
   * have been written (the first such step) and not applied after it, since a
   * worker writes the next step only once the last is attached. `observe`, when
   * given, reads what an unknown step now shows. Runs before retention.
   */
  async settleAbandoned(observe) {
    const settled = [];
    const ledger = await this.ledger();
    for (const kind of ["proposal", "undo"])
      for (const [id, entry] of Object.entries(
        kind === "undo" ? (ledger.undos ?? {}) : ledger.proposals,
      )) {
        if (entry.state !== "committing" || entry.claim.epoch === this.epoch) continue;
        const { attempt } = entry.claim;
        const { steps } = entry.claim;
        const found = [];
        for (const step of steps) {
          const key = journalKey(id, attempt, step);
          const body = await this.entry(key);
          if (!body) break;
          found.push({ step, key, body });
        }
        const outcome = Object.fromEntries(
          steps.map((step, i) => [
            step,
            i < found.length ? "applied" : i === found.length ? "unknown" : "not-applied",
          ]),
        );
        // Fields with no conditional write were never claimed, and are reported as the worker would.
        for (const step of entry.claim.unavailable ?? []) outcome[step] = "unavailable";
        const unknown = steps[found.length];
        const observed =
          unknown && observe ? { [unknown]: await observe(entry.bot, unknown) } : undefined;
        settled.push(
          await this.transact((l, at) => {
            for (const { key, body } of found)
              attach(l, kind, id, attempt, key, {
                at: body.at,
                target: body.target,
                digest: digestOf(body),
              });
            return {
              id,
              ...settleClaim(l, kind, id, attempt, { outcome, observed }, at),
            };
          }),
        );
      }
    return settled;
  }

  /**
   * Journal retention: removes entries older than 90 days and, when `need`
   * more spaces are wanted, the oldest whose Undo is no longer offered. Rows
   * leave the index and are marked in one ledger update, then deleted, then
   * the mark is cleared; a deletion an earlier run left marked is finished
   * first. Returns the keys removed.
   */
  async journalRetention(need = 0) {
    const removed = [];
    const pending = (await this.ledger()).journalDeleting;
    if (pending?.length) removed.push(...(await this.deleteJournal(pending)));
    const marked = await this.transact((l, now) => {
      const expired = journalExpired(l, now, need);
      return markJournal(l, expired) ? expired : [];
    });
    if (marked.length) removed.push(...(await this.deleteJournal(marked)));
    return removed;
  }

  async deleteJournal(keys) {
    for (const key of keys) await this.journal.delete(key);
    // Only this run's mark: a concurrent run may have marked other rows since.
    await this.transact((l) => {
      if (isDeepStrictEqual(l.journalDeleting, keys)) delete l.journalDeleting;
    });
    return keys;
  }

  async reclaim(id, removed) {
    await this.versions.delete(VERSION + id);
    await this.transact((l) => clearSweeping(l, id));
    removed.push(id);
  }
}

/** A stored row's body, if it reads and matches `digest` (or its own, when none is given); null otherwise. */
async function read(store, key, digest) {
  let row;
  try {
    row = await store.lookup(key);
  } catch (error) {
    if (error?.code === "PLUGIN_STATE_CORRUPT") return null;
    throw error;
  }
  if (!isObject(row) || !isObject(row.body) || (digest !== undefined && row.digest !== digest))
    return null;
  return digestOf(row.body) === row.digest ? row.body : null;
}
