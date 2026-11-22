// The ledger: one row per gateway, the only record that decides anything
// (docs/design/main-bot-onboarding.md, section 9). These functions are pure:
// each changes a copy of the ledger, and lib/records.js stores the result in
// one compareAndApply, so two decisions that race can't both win.
//
// A proposal's entry: { digest, state, source, grant?, bot, fields, createdAt,
// expiresAt, settledAt?, by? }. A grant's entry: { version, digest,
// generation, revoked, expiresAt }. `swept` holds the versions cleanup
// removed, so a delayed publisher can't publish one afterwards.

export const LIMITS = Object.freeze({ open: 200, perSource: 20 });
export const EXPIRES_MS = 24 * 60 * 60 * 1000;
export const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;
/** A version nothing refers to after this long was never published, and is reclaimed. */
export const ORPHAN_MS = 60 * 60 * 1000;
/** Settled entries kept at most, so the one ledger row stays well under the store's 1 MiB. */
export const SETTLED_MAX = 1000;
export const TERMINAL = Object.freeze(["declined", "expired", "superseded", "withdrawn"]);

export class Refusal extends Error {
  constructor(reason, message, details = {}) {
    super(message);
    this.reason = reason;
    this.details = details;
  }
}

/** @returns {{ proposals: Record<string, any>, grants: Record<string, any>, swept: Record<string, number> }} */
export const emptyLedger = () => ({ proposals: {}, grants: {}, swept: {} });
export const sourceKey = (source) =>
  source.kind === "agent" ? `agent:${source.grant}` : `bot:${source.bot}`;
const isOpen = (entry) => entry.state === "open";

function settle(entry, state, now, by) {
  entry.state = state;
  entry.settledAt = now;
  if (by) entry.by = by;
}

function withdrawOpen(ledger, grant, now) {
  for (const entry of Object.values(ledger.proposals))
    if (isOpen(entry) && entry.source === `agent:${grant}`) settle(entry, "withdrawn", now);
}

/**
 * Expiry, grant expiry and retention, run at the start of every transition.
 * Returns the ids of settled proposals removed, whose versions can go too.
 */
export function sweep(ledger, now) {
  for (const [id, grant] of Object.entries(ledger.grants))
    if (!grant.revoked && grant.expiresAt <= now) revoke(ledger, id, now, "expired");
  for (const entry of Object.values(ledger.proposals))
    if (isOpen(entry) && entry.expiresAt <= now) settle(entry, "expired", now);
  const settled = Object.entries(ledger.proposals)
    .filter(([, entry]) => !isOpen(entry))
    .sort(([, a], [, b]) => a.settledAt - b.settledAt);
  const removed = [];
  settled.forEach(([id, entry], i) => {
    if (entry.settledAt + RETAIN_MS <= now || settled.length - i > SETTLED_MAX) {
      delete ledger.proposals[id];
      removed.push(id);
    }
  });
  for (const [id, until] of Object.entries(ledger.swept)) if (until <= now) delete ledger.swept[id];
  return removed;
}

function checkGrant(ledger, { grant, generation }, now) {
  const entry = ledger.grants[grant];
  if (!entry) throw new Refusal("grant-missing", "This agent's access to Clawtrate isn't set up.");
  if (entry.revoked || entry.expiresAt <= now)
    throw new Refusal("grant-revoked", "This agent's access to Clawtrate was removed.");
  if (entry.generation !== generation)
    throw new Refusal(
      "grant-generation",
      "This agent's access to Clawtrate changed. Reconnect it.",
    );
  return entry;
}

/** Admits a proposal: the limits, the grant's generation and supersession, decided together. */
export function admit(ledger, proposal, now) {
  const { id, digest, source, bot, fields, createdAt, expiresAt } = proposal;
  if (ledger.swept[id] || ledger.proposals[id])
    throw new Refusal("unpublishable", "Clawtrate couldn't record this request. Try again.");
  if (source.kind === "agent") checkGrant(ledger, source, now);
  const open = Object.entries(ledger.proposals).filter(([, entry]) => isOpen(entry));
  const superseded = open
    .filter(([, entry]) => entry.bot === bot && entry.fields.some((f) => fields.includes(f)))
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
  ledger.proposals[id] = {
    digest,
    state: "open",
    source: key,
    ...(source.kind === "agent"
      ? { grant: { grant: source.grant, generation: source.generation } }
      : {}),
    bot,
    fields,
    createdAt,
    expiresAt,
  };
  return { superseded };
}

/** Claims an open proposal for a decision, checking its digest and its grant's generation. */
export function claim(ledger, id, digest, now) {
  const entry = ledger.proposals[id];
  if (!entry) throw new Refusal("unknown", "Clawtrate has no such request on this gateway.");
  if (!isOpen(entry))
    throw new Refusal("settled", `This request was already ${entry.state}.`, {
      state: entry.state,
    });
  if (entry.digest !== digest)
    throw new Refusal("digest", "This request isn't the one shown. Look at it again.");
  if (entry.grant) checkGrant(ledger, entry.grant, now);
  return entry;
}

export function decline(ledger, id, digest, by, now) {
  settle(claim(ledger, id, digest, now), "declined", now, by);
}

/** Publishes a grant's version: a new generation, and its open suggestions withdrawn. */
export function publishGrant(ledger, id, { version, digest, expiresAt }, now) {
  if (ledger.swept[version])
    throw new Refusal("unpublishable", "Clawtrate couldn't record this access. Try again.");
  const generation = (ledger.grants[id]?.generation ?? 0) + 1;
  withdrawOpen(ledger, id, now);
  ledger.grants[id] = { version, digest, generation, revoked: false, expiresAt };
  return { generation };
}

/** Removes access: the generation moves on and the open suggestions are withdrawn, together. */
export function revoke(ledger, id, now, why = "removed") {
  const grant = ledger.grants[id];
  if (!grant) throw new Refusal("grant-missing", "This agent's access to Clawtrate isn't set up.");
  if (!grant.revoked) {
    grant.generation += 1;
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
  ]);

/** Marks an unreferenced version swept, under the same ledger update a publisher needs. */
export function tombstone(ledger, version, until) {
  if (referenced(ledger).has(version)) return false;
  ledger.swept[version] = until;
  return true;
}
