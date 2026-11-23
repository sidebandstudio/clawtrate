// Apply and Undo (docs/design/main-bot-onboarding.md, sections 8 and 9): the
// writes a person's decision makes, one step at a time, each confirmed effect
// journaled and attached before the next write. They need `effects`, the
// gateway's conditional writes bound to a bot's incarnation, which OpenClaw
// 2026.10.6 doesn't have (section 17). The plugin's entry (index.js) never
// passes one, so on that gateway accept and Undo refuse before claiming
// anything; only the unit tests' stand-in supplies it.
//
//   effects.conditional(step)               whether the step has a conditional write
//   effects.read(bot, step)                 { value, token }: what the gateway holds now
//   effects.write(bot, step, value, token)  { before, after }: written under `token` and
//                                           read back. A Refusal "precondition" means the
//                                           gateway refused it inside the write; any other
//                                           error leaves it uncertain, and it is never resent.

import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { canonical, digestOf } from "./canonical.js";
import * as L from "./ledger.js";
import { Refusal } from "./ledger.js";

/** The order steps are written in. Account and model are one step, at the model. */
const ORDER = [
  "name",
  "label",
  "model",
  "effort",
  "autonomy",
  "instructions.agents",
  "instructions.soul",
];
export const stepsOf = (fields) =>
  ORDER.filter((step) => fields.includes(step) || (step === "model" && fields.includes("account")));

function valueOf(payload, step) {
  if (step.startsWith("instructions.")) return payload.instructions[step.slice(13)].text;
  if (step !== "model") return payload[step];
  return JSON.parse(canonical({ model: payload.model, account: payload.account }));
}
/** What a read shows, kept short in the ledger: a long value (a file's text) as its digest. */
const short = (value) =>
  Buffer.byteLength(canonical(value ?? null)) <= 256
    ? (value ?? null)
    : { digest: digestOf(value) };
export async function observe(effects, bot, step) {
  try {
    return short((await effects.read(bot, step)).value);
  } catch {
    return undefined;
  }
}
export const unavailable = () =>
  new Refusal(
    "apply-unavailable",
    "Clawtrate can't apply a saved request on this gateway. Review and save it yourself instead.",
  );
const noUndo = () => new Refusal("undo-unavailable", "Undo isn't available for this change.");
const target = (bot, step) => `${bot.id}:${bot.createdAt}:${step}`;

/**
 * Stores a confirmed effect's entry and attaches it to its claim. A failed
 * store is retried once under the same key, while this worker still holds the
 * gateway's confirmation; then the step stays unknown. False when it wasn't
 * attached.
 */
async function journal(records, kind, id, attempt, entry) {
  let digest = null;
  for (let tries = 0; tries < 2 && digest === null; tries += 1)
    digest = await records.writeEntry(entry.id, entry).catch(() => null);
  if (digest === null) return false;
  const { at, target } = entry;
  await records.transact((l) => L.attach(l, kind, id, attempt, entry.id, { at, target, digest }));
  return true;
}

/**
 * Applies a claimed proposal's steps in order. Before each write, the claim
 * must still be this worker's and `mayWrite` must still allow the proposer
 * (section 7). A refused precondition, a lost answer or an unstored journal
 * entry stops the steps after it. Settles with what the journal shows.
 */
export async function accept(records, effects, { id, digest, by, gateway, deadline, mayWrite }) {
  let body = null;
  let steps = [];
  let writable = [];
  const claimOnce = () =>
    records.transact(
      (l, at) => L.claimForApply(l, id, digest, at, { by, epoch: records.epoch, steps: writable }),
      async (l, at) => {
        const entry = L.claim(l, id, digest, at);
        body = await records.version(id, entry.digest);
        if (!body) throw new Refusal("unreadable", "Clawtrate couldn't read this request.");
        steps = stepsOf(entry.fields);
        writable = steps.filter(
          (step) => effects.conditional(step) && Object.hasOwn(body.tokens ?? {}, step),
        );
        if (writable.length === 0) throw unavailable();
      },
      deadline,
    );
  let claimed;
  try {
    claimed = await claimOnce();
  } catch (error) {
    if (error?.reason !== "journal-full") throw error;
    // The service frees what it can first: entries past 90 days, then the oldest without Undo.
    await records.journalRetention(writable.length);
    claimed = await claimOnce();
  }
  const { attempt } = claimed;
  const outcome = {};
  const observed = {};
  let stopped = false;
  for (const step of steps) {
    if (!writable.includes(step)) outcome[step] = "unavailable";
    else if (stopped) outcome[step] = "not-applied";
    else {
      outcome[step] = "not-applied";
      try {
        L.committing(await records.ledger(), "proposal", id, attempt);
        if (!(await mayWrite(body))) {
          stopped = true;
          continue;
        }
        let result;
        outcome[step] = "unknown";
        try {
          result = await effects.write(
            body.bot,
            step,
            valueOf(body.payload, step),
            body.tokens[step],
          );
        } catch (error) {
          stopped = true;
          if (error instanceof Refusal && error.reason === "precondition")
            outcome[step] = "not-applied";
          else observed[step] = await observe(effects, body.bot, step);
          continue;
        }
        const entry = {
          id: L.journalKey(id, attempt, step),
          at: records.now(),
          gateway,
          bot: body.bot,
          field: step,
          target: target(body.bot, step),
          before: result.before,
          after: result.after,
          token: body.tokens[step],
          change: id,
          kind: "proposal",
          by,
          source: body.source,
        };
        if (await journal(records, "proposal", id, attempt, entry)) outcome[step] = "applied";
        else stopped = true;
      } catch (error) {
        // Settled elsewhere (recovery took this claim over), or a store failure: nothing more is written.
        if (error instanceof Refusal && error.reason === "settled") return settledAs(records, id);
        stopped = true;
      }
    }
  }
  return records.transact((l, at) => ({
    id,
    ...L.settleClaim(l, "proposal", id, attempt, { outcome, observed }, at),
  }));
}

async function settledAs(records, id) {
  const entry = (await records.ledger()).proposals[id];
  return { id, state: entry?.state, outcome: entry?.outcome };
}

/** An Undo's id: the same for every Undo of one journal entry, so a retry finds the first. */
export const undoId = (key) =>
  `u_${createHash("sha256").update(`clawtrate-bots undo\0${key}`).digest("hex").slice(0, 32)}`;

/**
 * Undoes one journal entry (section 8). Its values come from the journal,
 * never the caller. The field is read once: when it still holds the journaled
 * result, the journaled before-value is written with that read's token, so an
 * edit after the read is refused inside the gateway's write; otherwise nothing
 * is written. Restoring more freedom needs `allow`.
 */
export async function undo(records, effects, { key, by, gateway, allow }) {
  const ledger = await records.ledger();
  const index = ledger.journal ?? {};
  const indexed = Object.hasOwn(index, key) ? index[key] : null;
  const entry = indexed && (await records.entry(key, indexed.digest));
  if (!entry || !effects.conditional(entry.field)) throw noUndo();
  const id = undoId(key);
  // Refused before anything is stored, unless this is a retry that finds the first.
  if (!Object.hasOwn(ledger.undos ?? {}, id) && !L.undoable(ledger, key, records.now()))
    throw noUndo();
  if (entry.field === "autonomy" && entry.before === "hands-off" && allow !== true)
    throw new Refusal("more-freedom", `Undo lets ${entry.bot.id} run hands-off again.`);
  const step = entry.field;
  const { bot, target } = entry;
  const digest = await records.persistOnce(id, {
    ...{ id, gateway, undoes: key, bot, field: step },
    restore: entry.before,
    expect: entry.after,
  });
  const started = await records.publish(id, digest, (l, at) =>
    L.startUndo(l, id, digest, key, at, { by, epoch: records.epoch, field: step, bot: entry.bot }),
  );
  if (started.first) {
    const first = (await records.ledger()).undos[id];
    return { id, state: first.state, outcome: first.outcome, observed: first.observed };
  }
  const { attempt } = started;
  let said = "failed";
  const observed = {};
  try {
    const now = await effects.read(entry.bot, step);
    said = "changed";
    observed[step] = short(now.value);
    if (isDeepStrictEqual(now.value, entry.after)) {
      said = "unknown";
      try {
        const result = await effects.write(entry.bot, step, entry.before, now.token);
        const done = await journal(records, "undo", id, attempt, {
          id: L.journalKey(id, attempt, step),
          at: records.now(),
          gateway,
          bot,
          field: step,
          target,
          before: result.before,
          after: result.after,
          token: now.token,
          change: id,
          kind: "undo",
          undoes: key,
          by,
        });
        if (done) [said, observed[step]] = ["applied", short(result.after)];
      } catch (error) {
        if (error instanceof Refusal && error.reason === "precondition") said = "changed";
        observed[step] = await observe(effects, entry.bot, step);
      }
    }
  } catch {
    // The read failed before any write: nothing was written, and Undo can start again.
  }
  return records.transact((l, at) => ({
    id,
    ...L.settleClaim(l, "undo", id, attempt, { outcome: { [step]: said }, observed }, at),
    observed,
  }));
}
