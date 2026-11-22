// The ledger: one row per gateway, the only record that decides anything
// (docs/design/main-bot-onboarding.md, section 9). These functions are pure:
// each changes a copy of the ledger, and lib/records.js stores the result in
// one compareAndApply, so two decisions that race can't both win.
//
// A proposal's entry: { digest, state, source, grant?, bot: { id, createdAt },
// fields, createdAt, expiresAt, settledAt?, by? }. A grant's entry: { version,
// digest, generation, revoked, expiresAt, revokedAt? }. `rev` counts every
// stored change.

export const LIMITS = Object.freeze({ open: 200, perSource: 20 });
export const EXPIRES_MS = 24 * 60 * 60 * 1000;
export const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;
/** The store's limit for one value, in UTF-8 bytes of JSON. */
export const VALUE_MAX = 1024 * 1024;
/** Room kept so every open proposal can settle and every grant can be revoked, whatever fills the rest. */
const ROOM = { settle: 96, revoke: 64, ledger: 64 };
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

/** @returns {{ rev: number, proposals: Record<string, any>, grants: Record<string, any> }} */
export const emptyLedger = () => ({ rev: 0, proposals: {}, grants: {} });
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
  for (const [id, grant] of Object.entries(ledger.grants)) {
    if (!grant.revoked && grant.expiresAt <= now) revoke(ledger, id, now, "expired");
    if (grant.revoked && grant.revokedAt + RETAIN_MS <= now) delete ledger.grants[id];
  }
  for (const [id, entry] of Object.entries(ledger.proposals)) {
    if (isOpen(entry) && entry.expiresAt <= now) settle(entry, "expired", now);
    if (!isOpen(entry) && entry.settledAt + RETAIN_MS <= now) delete ledger.proposals[id];
  }
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
  return size + open * ROOM.settle + live * ROOM.revoke + ROOM.ledger <= budget;
}
const full = () =>
  new Refusal(
    "records-full",
    "Clawtrate's request records on this gateway are full. Answer some requests, then try again.",
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
    throw new Refusal("settled", `This request was already ${state}.`, { state });
  if (entry.digest !== digest)
    throw new Refusal("digest", "This request isn't the one shown. Look at it again.");
  if (entry.grant) checkGrant(ledger, entry.grant, now);
  return entry;
}

export function decline(ledger, id, digest, by, now) {
  settle(claim(ledger, id, digest, now), "declined", now, by);
}

/**
 * Publishes a new grant at generation 1. A grant is never changed: a
 * narrower one is a new grant, and the old one is revoked.
 */
export function publishGrant(ledger, id, { version, digest, expiresAt }, now, budget) {
  if (expiresAt <= now) throw new Refusal("expired", "This access would already have expired.");
  if (own(ledger.grants, id)) throw new Refusal("invalid", "This grant already exists.");
  ledger.grants[id] = { version, digest, generation: 1, revoked: false, expiresAt };
  if (!fits(ledger, budget)) throw full();
  return { generation: 1 };
}

/** Removes access: the generation moves on and the open suggestions are withdrawn, together. */
export function revoke(ledger, id, now, why = "removed") {
  const grant = own(ledger.grants, id);
  if (!grant) throw gone("This agent's access to Clawtrate isn't set up.");
  if (!grant.revoked) {
    grant.generation += 1;
    grant.revoked = why;
    grant.revokedAt = now;
  }
  withdrawOpen(ledger, id, now);
  return { generation: grant.generation };
}
