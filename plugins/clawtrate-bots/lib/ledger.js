// The ledger: one row per gateway, the only record that decides anything
// (docs/design/main-bot-onboarding.md, section 9). These functions are pure:
// each changes a copy of the ledger, and lib/records.js stores the result in
// one compareAndApply, so two decisions that race can't both win.
//
// A proposal's entry: { digest, state, source, grant?, bot: { id, createdAt },
// fields, createdAt, expiresAt, settledAt?, by? }. A grant's entry: { version,
// digest, generation, revoked, expiresAt, revokedAt? }. `sweeping` is the one
// version cleanup is deleting, which no publisher may publish. `orphanAges`
// holds, for one process's epoch, when each version was first seen with
// nothing referring to it, on that process's monotonic clock. `rev` counts
// every stored change, so a mark and its clearing never restore an earlier row.
//
// Apply (section 8): a claim moves a proposal to `committing` with `claim: {
// by, at, attempt, epoch, steps }` and reserves one journal space per step in
// `reserved`. Each confirmed effect's journal entry is added to `effects` and
// to `journal`, the index of attached entries ({ at, target, digest } by key),
// using one reserved space; settling releases the rest and records `outcome`
// per step and `observed`. An Undo has its own entry in `undos`, the same way.
// `journalDeleting` is the retention's pending deletion of journal rows.

export const LIMITS = Object.freeze({ open: 200, perSource: 20 });
export const EXPIRES_MS = 24 * 60 * 60 * 1000;
export const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;
/** A version nothing has referred to for this long, continuously, was never published, or was replaced or retired. */
export const ORPHAN_MS = 60 * 60 * 1000;
/** The store's limit for one value, in UTF-8 bytes of JSON. */
export const VALUE_MAX = 1024 * 1024;
/** Room kept so every open proposal can settle and every grant can be revoked, whatever fills the rest. */
const ROOM = { settle: 96, revoke: 64, ledger: 64, orphanAges: 40 * 1024, journal: 640 };
const DAY_MS = 24 * 60 * 60 * 1000;
/** The journal: at most this many entries, attached or reserved, each kept 90 days. */
export const JOURNAL_MAX = 1000;
export const JOURNAL_RETAIN_MS = 90 * DAY_MS;
/** Undo is offered for 7 days, until the next change to the same field. */
export const UNDO_MS = 7 * DAY_MS;
const IDS = { p: /^p_[0-9a-f]{32}$/, g: /^g_[0-9a-f]{32}$/ };

export class Refusal extends Error {
  constructor(reason, message, details = {}) {
    super(message);
    this.reason = reason;
    this.details = details;
  }
}

/** Ids are checked before they index anything: a prefix and 32 lowercase hex digits. */
export function requireId(kind, value, what) {
  if (typeof value !== "string" || !IDS[kind].test(value))
    throw new Refusal("invalid", `${what} isn't an id Clawtrate made.`);
  return value;
}
const own = (map, key) => (Object.hasOwn(map, key) ? map[key] : undefined);

/** @returns {{ rev: number, proposals: Record<string, any>, grants: Record<string, any>, sweeping?: string | null, orphanAges?: { epoch: string, since: Record<string, number> }, journal?: Record<string, { at: number, target: string, digest: string }>, undos?: Record<string, any>, journalDeleting?: string[] }} */
export const emptyLedger = () => ({ rev: 0, proposals: {}, grants: {}, sweeping: null });
export const sourceKey = (source) =>
  source.kind === "agent" ? `agent:${source.grant}` : `bot:${source.bot}`;
const isOpen = (entry) => entry.state === "open";
const sameBot = (a, b) => a.id === b.id && a.createdAt === b.createdAt;
const gone = (message) => new Refusal("grant-missing", message);

function settle(entry, state, now, by) {
  entry.state = state;
  entry.settledAt = now;
  if (by) entry.by = by;
}

function withdrawOpen(ledger, grant, now) {
  for (const entry of Object.values(ledger.proposals))
    if (isOpen(entry) && entry.source === `agent:${grant}`) settle(entry, "withdrawn", now);
}

/** Expiry and retention, run at the start of every transition. */
export function sweep(ledger, now) {
  // A request whose own deadline came no later than its grant's expires; one
  // still open when its grant expired is withdrawn with the grant, below.
  for (const entry of Object.values(ledger.proposals)) {
    const grant = entry.grant && own(ledger.grants, entry.grant.grant);
    const grantEnd = grant && !grant.revoked ? grant.expiresAt : Infinity;
    if (isOpen(entry) && entry.expiresAt <= now && entry.expiresAt <= grantEnd)
      settle(entry, "expired", now);
  }
  for (const [id, grant] of Object.entries(ledger.grants)) {
    if (!grant.revoked && grant.expiresAt <= now) revoke(ledger, id, now, "expired");
    if (grant.revoked && grant.revokedAt + RETAIN_MS <= now) delete ledger.grants[id];
  }
  for (const [id, entry] of Object.entries(ledger.proposals)) {
    if (isOpen(entry) && entry.expiresAt <= now) settle(entry, "expired", now);
    if (!isOpen(entry) && entry.settledAt + RETAIN_MS <= now) delete ledger.proposals[id];
  }
  for (const [id, entry] of Object.entries(ledger.undos ?? {}))
    if (entry.settledAt + RETAIN_MS <= now) delete ledger.undos[id];
}

/** Checks a grant as the ledger holds it: present, live, and the generation and version given. */
export function checkGrant(ledger, { grant, generation, version }, now) {
  const entry = own(ledger.grants, grant);
  if (!entry) throw gone("This agent's access to Clawtrate isn't set up.");
  if (entry.revoked || entry.expiresAt <= now)
    throw new Refusal("grant-revoked", "This agent's access to Clawtrate was removed.");
  if (entry.generation !== generation || (version !== undefined && entry.version !== version))
    throw new Refusal(
      "grant-generation",
      "This agent's access to Clawtrate changed. Reconnect it.",
    );
  return entry;
}

/** Whether the ledger, with room for every open proposal to settle and every grant to be revoked, fits one stored value. */
export function fits(ledger, budget = VALUE_MAX) {
  const open = Object.values(ledger.proposals).filter(isOpen).length;
  const live = Object.values(ledger.grants).filter((g) => !g.revoked).length;
  const size = Buffer.byteLength(JSON.stringify(ledger));
  const reserved = journalUse(ledger) - Object.keys(ledger.journal ?? {}).length;
  return (
    size +
      open * ROOM.settle +
      live * ROOM.revoke +
      reserved * ROOM.journal +
      ROOM.ledger +
      ROOM.orphanAges <=
    budget
  );
}
const full = () =>
  new Refusal(
    "records-full",
    "Clawtrate's request records on this gateway are full. Settled requests leave them 30 days after they're settled.",
  );

/** Admits a proposal: the limits, the grant, supersession and the records' size, decided together. */
export function admit(ledger, proposal, now, budget) {
  const { id, digest, source, bot, fields, createdAt, expiresAt } = proposal;
  if (own(ledger.proposals, id))
    throw new Refusal("unpublishable", "Clawtrate couldn't record this request. Try again.");
  if (expiresAt <= now)
    throw new Refusal("expired", "This request expired before it was recorded.");
  if (source.kind === "agent") checkGrant(ledger, source, now);
  const open = Object.entries(ledger.proposals).filter(([, entry]) => isOpen(entry));
  const superseded = open
    .filter(([, entry]) => sameBot(entry.bot, bot) && entry.fields.some((f) => fields.includes(f)))
    .map(([key]) => key);
  const key = sourceKey(source);
  const staying = open.filter(([other]) => !superseded.includes(other));
  if (staying.filter(([, entry]) => entry.source === key).length >= LIMITS.perSource) {
    throw new Refusal(
      "source-limit",
      source.kind === "agent"
        ? "Too many open suggestions from this agent. Wait for an answer."
        : "Too many open requests from this bot. Wait for an answer.",
    );
  }
  if (staying.length >= LIMITS.open)
    throw new Refusal("open-limit", "Too many open requests on this gateway. Wait for an answer.");
  for (const other of superseded) settle(ledger.proposals[other], "superseded", now);
  const { grant, generation, version } = source;
  ledger.proposals[id] = {
    digest,
    state: "open",
    source: key,
    ...(source.kind === "agent" ? { grant: { grant, generation, version } } : {}),
    bot,
    fields,
    createdAt,
    expiresAt,
  };
  if (!fits(ledger, budget)) throw full();
  return { superseded };
}

/** Claims an open proposal for a decision: unexpired, the digest shown, and its grant's generation. */
export function claim(ledger, id, digest, now) {
  const entry = own(ledger.proposals, id);
  if (!entry) throw new Refusal("unknown", "Clawtrate has no such request on this gateway.");
  const state = isOpen(entry) && entry.expiresAt <= now ? "expired" : entry.state;
  if (state !== "open")
    throw new Refusal(
      "settled",
      state === "committing"
        ? "This request is being applied on another device."
        : `This request was already ${state}.`,
      { state },
    );
  if (entry.digest !== digest)
    throw new Refusal("digest", "This request isn't the one shown. Look at it again.");
  if (entry.grant) checkGrant(ledger, entry.grant, now);
  return entry;
}

export function decline(ledger, id, digest, by, now) {
  settle(claim(ledger, id, digest, now), "declined", now, by);
}

/** Checks the generation before storing an update and again when publishing it. */
export function grantForUpdate(ledger, id, expected) {
  const current = own(ledger.grants, id);
  if (!current) throw gone("This agent's access to Clawtrate isn't set up.");
  if (current.generation !== expected)
    throw new Refusal(
      "grant-generation",
      "This agent's access changed since it was read. Read it again.",
    );
  return current;
}

/**
 * Publishes a grant's version: a new grant (`expected` null), or a new
 * version of the generation the caller read, which can't bring access back
 * after a revocation it didn't read. It withdraws that grant's open
 * suggestions in the same change.
 */
export function publishGrant(ledger, id, { version, digest, expiresAt }, expected, now, budget) {
  if (expiresAt <= now) throw new Refusal("expired", "This access would already have expired.");
  if (expected === null && own(ledger.grants, id))
    throw new Refusal("invalid", "This grant already exists.");
  const generation = expected === null ? 1 : grantForUpdate(ledger, id, expected).generation + 1;
  withdrawOpen(ledger, id, now);
  ledger.grants[id] = { version, digest, generation, revoked: false, expiresAt };
  if (!fits(ledger, budget)) throw full();
  return { generation };
}

/** Removes access: the generation moves on and the open suggestions are withdrawn, together. */
export function revoke(ledger, id, now, why = "removed") {
  const grant = own(ledger.grants, id);
  if (!grant) throw gone("This agent's access to Clawtrate isn't set up.");
  grant.generation += 1;
  if (!grant.revoked) {
    grant.revoked = why;
    grant.revokedAt = now;
  }
  withdrawOpen(ledger, id, now);
  return { generation: grant.generation };
}

export const referenced = (ledger) =>
  new Set([
    ...Object.keys(ledger.proposals),
    ...Object.values(ledger.grants).map((g) => g.version),
    ...Object.keys(ledger.undos ?? {}),
  ]);

/**
 * Records when each of `ids` was first seen with nothing referring to it, in
 * this epoch. Ages from another epoch (another process) start again; an id
 * that is referenced again loses its age.
 */
export function recordAges(ledger, ids, { epoch, now }) {
  if (ledger.orphanAges?.epoch !== epoch) ledger.orphanAges = { epoch, since: {} };
  const live = referenced(ledger);
  const { since } = ledger.orphanAges;
  for (const id of Object.keys(since)) if (live.has(id)) delete since[id];
  for (const id of ids) if (!live.has(id) && !Object.hasOwn(since, id)) since[id] = now;
  if (Object.keys(since).length === 0) delete ledger.orphanAges;
}

/** Marks one version for deletion: unreferenced, seen so for an hour in this epoch, and only one at a time. */
export function markSweeping(ledger, version, { epoch, now }) {
  if ((ledger.sweeping ?? null) !== null && ledger.sweeping !== version) return false;
  if (referenced(ledger).has(version)) return false;
  const ages = ledger.orphanAges;
  if (ages?.epoch !== epoch || !Object.hasOwn(ages.since, version)) return false;
  if (now - ages.since[version] < ORPHAN_MS) return false;
  ledger.sweeping = version;
  return true;
}

/** Clears the mark, and the version's age, once it is deleted. */
export function clearSweeping(ledger, version) {
  if (ledger.sweeping === version) ledger.sweeping = null;
  clearAge(ledger, version);
}

/** Forgets a version's age: published again, or deleted. An empty map is removed. */
export function clearAge(ledger, version) {
  const ages = ledger.orphanAges;
  if (!ages || !Object.hasOwn(ages.since, version)) return;
  delete ages.since[version];
  if (Object.keys(ages.since).length === 0) delete ledger.orphanAges;
}

// Apply, the journal and Undo (sections 8 and 9). Reached only when the
// gateway can make a conditional write bound to a bot's incarnation, which
// OpenClaw 2026.10.6 can't (section 17).

const journalFull = () =>
  new Refusal(
    "journal-full",
    "Clawtrate's change history is full, so it can't apply this now. Review and save it yourself instead.",
  );
/** A journal entry's key: the change (a proposal or an Undo), its claim attempt and the field. */
export const journalKey = (change, attempt, step) => `j:${change}:${attempt}:${step}`;
const changesOf = (ledger, kind) => (kind === "undo" ? (ledger.undos ??= {}) : ledger.proposals);

/** Journal spaces in use: entries attached, and spaces still reserved by claims that may write. */
export function journalUse(ledger) {
  let reserved = 0;
  for (const entry of [...Object.values(ledger.proposals), ...Object.values(ledger.undos ?? {})])
    if (entry.state === "committing") reserved += entry.reserved;
  return Object.keys(ledger.journal ?? {}).length + reserved;
}

/**
 * Claims an open proposal for Apply: the claim's checks (state, expiry, the
 * digest shown, the grant's generation) and one journal space per step,
 * reserved in the same transition.
 */
export function claimForApply(
  ledger,
  id,
  digest,
  now,
  { by, epoch, steps, unavailable = [] },
  budget,
) {
  const entry = claim(ledger, id, digest, now);
  if (journalUse(ledger) + steps.length > JOURNAL_MAX) throw journalFull();
  Object.assign(entry, { state: "committing", reserved: steps.length, effects: [] });
  entry.claim = { by, at: now, attempt: 1, epoch, steps, unavailable };
  if (!fits(ledger, budget)) throw full();
  return entry.claim;
}

/** The claim still running this attempt, or a Refusal: recovery or another worker settled it. */
export function committing(ledger, kind, id, attempt) {
  const entry = own(changesOf(ledger, kind), id);
  if (entry?.state !== "committing" || entry.claim.attempt !== attempt)
    throw new Refusal("settled", "This change was settled elsewhere.", { state: entry?.state });
  return entry;
}

/** Adds a stored journal entry to its claim's effects, using one reserved space. */
export function attach(ledger, kind, id, attempt, key, { at, target, digest }) {
  const entry = committing(ledger, kind, id, attempt);
  if (entry.effects.includes(key)) return;
  entry.effects.push(key);
  entry.reserved -= 1;
  (ledger.journal ??= {})[key] = { at, target, digest };
}

/**
 * Settles a claim. A step is applied only when its journal entry is attached;
 * one the worker reports applied without it is unknown. The other steps keep
 * the worker's word: unknown, not-applied or unavailable. Unused spaces are
 * released.
 */
export function settleClaim(ledger, kind, id, attempt, { outcome, observed }, now) {
  const entry = committing(ledger, kind, id, attempt);
  const steps = Object.keys(outcome);
  const result = Object.fromEntries(
    steps.map((step) => {
      const journaled = entry.effects.includes(journalKey(id, attempt, step));
      const said = outcome[step] === "applied" ? "unknown" : outcome[step];
      return [step, journaled ? "applied" : said];
    }),
  );
  const applied = steps.filter((step) => result[step] === "applied").length;
  const unknown = steps.some((step) => result[step] === "unknown");
  const state =
    kind === "undo"
      ? applied
        ? "undone"
        : unknown
          ? "unknown"
          : outcome[steps[0]] === "failed"
            ? "failed"
            : "changed"
      : applied === steps.length
        ? "accepted"
        : applied
          ? "partial"
          : unknown
            ? "unknown"
            : "stale";
  Object.assign(entry, { state, settledAt: now, reserved: 0, outcome: result });
  // A read that failed shows nothing, and the store takes only JSON.
  const seen = Object.entries(observed ?? {}).filter(([, value]) => value !== undefined);
  if (seen.length) entry.observed = Object.fromEntries(seen);
  return { state, outcome: result };
}

/** Whether a journal entry's Undo is offered: attached, under 7 days old, and the latest for its bot and field. */
export function undoable(ledger, key, now) {
  const entry = own(ledger.journal ?? {}, key);
  if (!entry || entry.at + UNDO_MS <= now) return false;
  return !Object.values(ledger.journal).some((o) => o.target === entry.target && o.at > entry.at);
}

/**
 * Starts an Undo, or finds the first: one that wrote, or may have, is final;
 * one that wrote nothing (the field changed, or the read failed) starts again
 * as a new attempt. It reserves its one journal space.
 */
export function startUndo(ledger, id, digest, undoes, now, { by, epoch, field, bot }, budget) {
  const undos = (ledger.undos ??= {});
  const first = own(undos, id);
  if (first?.state === "committing")
    throw new Refusal("busy", "This Undo is under way on another device.");
  if (first && ["undone", "unknown"].includes(first.state)) return { first: first.state };
  if (!undoable(ledger, undoes, now))
    throw new Refusal("undo-unavailable", "Undo isn't available for this change.");
  if (journalUse(ledger) + 1 > JOURNAL_MAX) throw journalFull();
  const attempt = (first?.claim.attempt ?? 0) + 1;
  undos[id] = {
    digest,
    undoes,
    bot,
    state: "committing",
    reserved: 1,
    effects: [],
    createdAt: now,
  };
  undos[id].claim = { by, at: now, attempt, epoch, steps: [field] };
  if (!fits(ledger, budget)) throw full();
  return { attempt };
}

/**
 * The journal rows retention removes: those older than 90 days, then, when
 * `need` more spaces are wanted, the oldest whose Undo is no longer offered.
 */
export function journalExpired(ledger, now, need = 0) {
  const entries = Object.entries(ledger.journal ?? {}).sort(([, a], [, b]) => a.at - b.at);
  const old = entries.filter(([, e]) => e.at + JOURNAL_RETAIN_MS <= now).map(([key]) => key);
  const short = journalUse(ledger) - old.length + need - JOURNAL_MAX;
  const spare = entries
    .filter(([key, e]) => e.at + JOURNAL_RETAIN_MS > now && !undoable(ledger, key, now))
    .map(([key]) => key);
  return [...old, ...spare.slice(0, Math.max(0, short))];
}

/** Marks journal rows for deletion and drops them from the index, in one transition. */
export function markJournal(ledger, keys) {
  if (ledger.journalDeleting?.length || keys.length === 0) return false;
  for (const key of keys) delete ledger.journal[key];
  ledger.journalDeleting = keys;
  return true;
}
