// The plugin's methods and service (index.js registers them).

import { hashDevice, newId } from "./canonical.js";
import * as L from "./ledger.js";
import { EXPIRES_MS, LIMITS, Refusal, requireId } from "./ledger.js";
import { NAMESPACE, Records, VERSIONS } from "./records.js";

export const PLUGIN_ID = "clawtrate-bots";
export const PLUGIN_VERSION = "0.1.0";
const GRANT_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
/** How often expiry and retention run when nothing else changes the ledger. */
const SWEEP_MS = 60 * 60 * 1000;
const EFFORT = ["off", "minimal", "low", "medium", "high", "xhigh"];
const AUTONOMY = ["hands-off", "ask"];
const TEXT_MAX_BYTES = 64 * 1024;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const bad = (message) => new Refusal("invalid", message);
const str = (v, max, what) => {
  if (typeof v !== "string" || v.trim().length === 0 || Buffer.byteLength(v) > max)
    throw bad(`${what} must be text of 1 to ${max} bytes.`);
  return v;
};
const hash = (v, what) => {
  if (v !== null && (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)))
    throw bad(`${what} must be the file's hash, or null when the file is missing.`);
  return v;
};
const unreadable = () => new Refusal("unreadable", "Clawtrate couldn't read this request.");
const incarnation = (bot) => ({ id: bot.id, createdAt: bot.createdAt });
const hasIncarnation = (bot) => typeof bot?.id === "string" && Number.isSafeInteger(bot.createdAt);

/**
 * A ledger decision needs a person's own connection: a direct operator
 * request over the gateway's socket, not an in-process call such as a turn
 * with no operator (research finding R6), even one that reuses a client.
 */
export const isDirectOperator = (opts) =>
  opts.acceptsSerializedJson === true &&
  opts.client?.connect?.role === "operator" &&
  !opts.client?.internal?.syntheticClient;

/** An update proposal's fields, checked and in canonical form (section 6). */
export function updateFields(input, { instructions }) {
  if (!isObject(input) || Object.keys(input).length === 0) throw bad("Propose at least one field.");
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "name") out.name = str(value, 200, "name").replace(/\s+/g, " ").trim().slice(0, 64);
    else if (key === "label") out.label = value === null ? null : str(value, 64, "label").trim();
    else if (key === "model" || key === "account") out[key] = str(value, 200, key);
    else if (key === "effort" || key === "autonomy") {
      const allowed = key === "effort" ? EFFORT : AUTONOMY;
      if (!allowed.includes(value)) throw bad(`${key} must be one of ${allowed.join(", ")}.`);
      out[key] = value;
    } else if (key === "instructions" && isObject(value) && Object.keys(value).length > 0) {
      if (!instructions)
        throw new Refusal("instructions", "This agent may not see or change instructions.");
      out.instructions = {};
      for (const [file, change] of Object.entries(value)) {
        if (!["agents", "soul"].includes(file) || !isObject(change))
          throw bad(`instructions.${file} isn't a file Clawtrate changes.`);
        out.instructions[file] = {
          text: str(change.text, TEXT_MAX_BYTES, file),
          baseHash: hash(change.baseHash, `instructions.${file}.baseHash`),
        };
      }
    } else throw bad(`${key} isn't a field a proposal can change.`);
  }
  return out;
}

const fieldNames = (fields) =>
  Object.entries(fields).flatMap(([key, value]) =>
    key === "instructions" ? Object.keys(value).map((file) => `instructions.${file}`) : [key],
  );

export function createBots(api, options = {}) {
  const { sdk } = options;
  const now = options.now ?? Date.now;
  const store =
    options.store ??
    api.runtime.state.openKeyedStore({ namespace: NAMESPACE, retention: "retained" });
  let emit = null;
  const versions = options.versions ?? api.runtime.state.openKeyedStore(VERSIONS);
  const records = new Records(store, versions, {
    now,
    // Empty: readers fetch again, and nothing about a request goes out.
    onChange: () => emit?.("changed", {}, { scope: "operator.read" }),
  });

  /** The gateway's identity as this plugin knows it: made once, kept in its records. */
  async function gatewayId() {
    const existing = await store.lookup("gateway");
    if (existing) return existing.id;
    await store.registerIfAbsent("gateway", { id: newId("gw") });
    return (await store.lookup("gateway")).id;
  }

  async function bots() {
    const roster = await sdk.dispatchGatewayMethod("agents.list", {});
    if (!roster?.ok || !Array.isArray(roster.payload?.agents))
      throw new Refusal("bots", "Clawtrate couldn't list this gateway's bots.");
    return roster.payload.agents.filter((a) => a.kind !== "system");
  }

  /**
   * The ledger as every read shows it: expiry and retention applied at the
   * current clock to a copy, so a grant past its expiry reads as revoked and
   * its suggestions as withdrawn before the sweep stores that. Nothing is written.
   */
  async function snapshot() {
    const stored = await records.ledger();
    const swept = () => {
      const ledger = structuredClone(stored);
      L.sweep(ledger, now());
      return ledger;
    };
    return { ledger: swept(), again: swept };
  }
  const own = (map, key) => (Object.hasOwn(map, key) ? map[key] : undefined);
  const summary = (id, { grant, digest: _d, ...entry }) => ({
    id,
    ...entry,
    generation: grant?.generation,
  });
  const LIST_LIMIT = { default: 50, max: 200 };
  const CURSOR = /^(\d+):(p_[0-9a-f]{32})$/;
  // Newest first; the same creation time is ordered by id, so a page boundary never repeats or skips one.
  const newestFirst = ([a, x], [b, y]) => y.createdAt - x.createdAt || (a < b ? 1 : a > b ? -1 : 0);

  const methods = {
    status: [
      "operator.read",
      async () => {
        const { ledger } = await snapshot();
        return {
          plugin: PLUGIN_ID,
          version: PLUGIN_VERSION,
          gateway: await gatewayId(),
          capabilities: { proposals: true, relay: true, onboarding: false },
          apply: { available: false, reason: "incarnation" },
          describe: { available: false, reason: "route-binding" },
          open: Object.values(ledger.proposals).filter((e) => e.state === "open").length,
          limits: { ...LIMITS },
        };
      },
    ],
    // A page of summaries from the ledger alone; the full request, with any instruction text, comes from get.
    "proposals.list": [
      "operator.read",
      async ({ limit = LIST_LIMIT.default, cursor }) => {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIST_LIMIT.max)
          throw bad(`limit must be 1 to ${LIST_LIMIT.max}.`);
        const after =
          cursor === undefined ? null : CURSOR.exec(typeof cursor === "string" ? cursor : "");
        if (cursor !== undefined && !after) throw bad("cursor isn't one Clawtrate gave.");
        const sorted = Object.entries((await snapshot()).ledger.proposals).sort(newestFirst);
        const start = after
          ? sorted.findIndex(
              (row) => newestFirst(row, [after[2], { createdAt: Number(after[1]) }]) > 0,
            )
          : 0;
        const page = start < 0 ? [] : sorted.slice(start, start + limit);
        const last = page.at(-1);
        const more = start >= 0 && start + limit < sorted.length;
        return {
          proposals: page.map(([id, e]) => summary(id, e)),
          ...(more && last ? { nextCursor: `${last[1].createdAt}:${last[0]}` } : {}),
        };
      },
    ],
    // Its state is shown as of after the body was read, so a read that spans its expiry says so.
    "proposals.get": [
      "operator.read",
      async ({ id }) => {
        requireId("p", id, "id");
        const { ledger, again } = await snapshot();
        const entry = own(ledger.proposals, id);
        if (!entry) throw new Refusal("unknown", "Clawtrate has no such request on this gateway.");
        const body = await records.version(id, entry.digest);
        const current = summary(id, own(again().proposals, id) ?? entry);
        if (!body) return { ...current, unreadable: true, said: unreadable().message };
        const { kind, payload, reason, bot, gateway, tokens } = body;
        return { ...current, digest: entry.digest, kind, payload, reason, bot, gateway, tokens };
      },
    ],
    // The claim is checked, then its version read, after every observation. The
    // commit is bound to the earlier of the request's and its grant's expiry.
    "proposals.decline": [
      "operator.write",
      async ({ id, digest }, opts) => {
        requireId("p", id, "id");
        const by = hashDevice(opts.client?.connect?.device?.id);
        await records.transact(
          (l, at) => L.decline(l, id, digest, by, at),
          async (l, at) => {
            if (!(await records.version(id, L.claim(l, id, digest, at).digest))) throw unreadable();
          },
          (l) => {
            const entry = own(l.proposals, id);
            const grant = entry?.grant && own(l.grants, entry.grant.grant);
            return Math.min(entry?.expiresAt ?? 0, grant ? grant.expiresAt : Infinity);
          },
        );
        return { id, state: "declined" };
      },
    ],
    // Section 17: on 2026.10.6 no stored request can be applied. The claim's
    // checks still run, so a request already settled, or expired, says so.
    "proposals.accept": [
      "operator.admin",
      async ({ id, digest }) => {
        requireId("p", id, "id");
        const entry = L.claim((await snapshot()).ledger, id, digest, now());
        if (!(await records.version(id, entry.digest))) throw unreadable();
        // Again, with the clock as it is after the read.
        L.claim((await snapshot()).ledger, id, digest, now());
        throw new Refusal(
          "apply-unavailable",
          "Clawtrate can't apply a saved request on this gateway. Review and save it yourself instead.",
        );
      },
    ],
    "relay.grants.get": [
      "operator.read",
      async ({ id }) => {
        requireId("g", id, "id");
        const { ledger, again } = await snapshot();
        const entry = own(ledger.grants, id);
        const body = entry ? await records.version(entry.version, entry.digest) : null;
        if (!body)
          throw new Refusal("grant-missing", "This agent's access to Clawtrate isn't set up.");
        const { version: _v, ...state } = own(again().grants, id) ?? entry;
        return { id, ...state, ...body.details };
      },
    ],
    "relay.grants.set": [
      "operator.admin",
      async (params) => {
        if (params.revoke === true) {
          const id = requireId("g", params.id, "id");
          const { generation } = await records.transact((l, at) => L.revoke(l, id, at));
          return { id, generation, revoked: true };
        }
        // A new grant gets a fresh id; an update names the generation it read,
        // and the publish compares it, so a stale update can't land.
        const update = params.id !== undefined;
        const id = update ? requireId("g", params.id, "id") : newId("g");
        const expected = update ? params.expectedGeneration : null;
        if (update && !Number.isSafeInteger(expected))
          throw bad("An update names the expectedGeneration it read.");
        if (!["see", "suggest"].includes(params.scope)) throw bad("scope must be see or suggest.");
        const all = params.bots === "all";
        if (
          !all &&
          !(Array.isArray(params.bots) && params.bots.every((b) => typeof b === "string"))
        )
          throw bad('bots must be "all" or a list of bot ids.');
        const at = now();
        // The default applies only when no deadline was given; a given one is never replaced.
        if (
          params.expiresAt !== undefined &&
          !(Number.isSafeInteger(params.expiresAt) && params.expiresAt > at)
        )
          throw bad("expiresAt must be a time, in milliseconds, after now.");
        const expiresAt = params.expiresAt ?? at + GRANT_DAYS_MS;
        // Bots are their incarnations: an id and the time the gateway created it.
        const roster = (await bots()).filter(hasIncarnation);
        const chosen = all
          ? roster
          : [...new Set(params.bots)].map((b) => roster.find((r) => r.id === b));
        if (chosen.includes(undefined))
          throw new Refusal(
            "bot",
            "A chosen bot isn't on this gateway, or has no creation record.",
          );
        const includeFuture = all && params.includeFuture === true;
        const details = {
          scope: params.scope,
          bots: includeFuture ? "all" : chosen.map(incarnation),
          includeInstructions: params.includeInstructions === true,
          includeFuture,
          expiresAt,
        };
        const version = newId("gv");
        const body = { kind: "grant", grant: id, gateway: await gatewayId(), details };
        const digest = await records.persist(version, body);
        const { generation } = await records.publish(
          version,
          digest,
          (l, t) => L.publishGrant(l, id, { version, digest, expiresAt }, expected, t),
          () => expiresAt,
        );
        return { id, generation, ...details };
      },
    ],
    // Records an agent's suggestion. The permissions checked are the grant
    // version of the generation given, and the ledger admits only if that is
    // still the grant's current version.
    "relay.propose": [
      "operator.admin",
      async (params) => {
        const grantId = requireId("g", params.grant, "grant");
        const ledger = await records.ledger();
        const entry = L.checkGrant(
          ledger,
          { grant: grantId, generation: params.generation },
          now(),
        );
        const grant = await records.version(entry.version, entry.digest);
        if (!grant) throw unreadable();
        if (grant.details.scope !== "suggest")
          throw new Refusal("scope", "This agent may only see bots.");
        const bot = (await bots()).find((b) => b.id === params.bot);
        if (!hasIncarnation(bot))
          throw new Refusal("bot", "This bot isn't on this gateway, or has no creation record.");
        const scoped = grant.details.bots;
        if (
          scoped !== "all" &&
          !scoped.some((b) => b.id === bot.id && b.createdAt === bot.createdAt)
        )
          throw new Refusal("bot", "This agent can't suggest changes to that bot.");
        const payload = updateFields(params.fields, {
          instructions: grant.details.includeInstructions,
        });
        const reason = params.reason === undefined ? undefined : str(params.reason, 200, "reason");
        const at = now();
        const id = newId("p");
        const source = {
          kind: "agent",
          grant: grantId,
          generation: entry.generation,
          version: entry.version,
        };
        const body = {
          id,
          gateway: await gatewayId(),
          bot: incarnation(bot),
          kind: "update",
          payload,
          tokens: Object.fromEntries(
            Object.entries(payload.instructions ?? {}).map(([f, c]) => [
              `instructions.${f}`,
              c.baseHash,
            ]),
          ),
          source,
          reason,
          createdAt: at,
          expiresAt: at + EXPIRES_MS,
        };
        const fields = fieldNames(payload);
        const admission = (digest) => ({
          id,
          digest,
          source,
          bot: body.bot,
          fields,
          createdAt: at,
          expiresAt: body.expiresAt,
        });
        // Refused before anything is stored, when the ledger already says so.
        const snapshot = await records.ledger();
        L.sweep(snapshot, now());
        L.admit(snapshot, admission(""), now());
        const digest = await records.persist(id, body);
        const { superseded } = await records.publish(
          id,
          digest,
          (l, t) => L.admit(l, admission(digest), t),
          (l) => Math.min(body.expiresAt, l.grants[grantId]?.expiresAt ?? 0),
        );
        return {
          status: "proposed",
          proposalId: id,
          digest,
          bot: body.bot,
          fields,
          superseded,
          said: "Nothing changes until a person saves it in Clawtrate.",
        };
      },
    ],
  };

  for (const [name, [scope, handler]] of Object.entries(methods)) {
    api.registerGatewayMethod?.(
      `${PLUGIN_ID}.${name}`,
      async (opts) => {
        try {
          if (scope !== "operator.read" && !isDirectOperator(opts))
            throw new Refusal(
              "operator-required",
              "Only a person's own Clawtrate connection can decide this.",
            );
          opts.respond(true, await handler(isObject(opts.params) ? opts.params : {}, opts));
        } catch (error) {
          if (!(error instanceof Refusal)) throw error;
          opts.respond(false, undefined, {
            code: "INVALID_REQUEST",
            message: error.message,
            details: { reason: error.reason, ...error.details },
          });
        }
      },
      { scope },
    );
  }

  const timers = [];
  api.registerService?.({
    id: `${PLUGIN_ID}-records`,
    async start(ctx) {
      const events = ctx?.gatewayEvents;
      emit = events ? (name, payload, opts) => events.emit(name, payload, opts) : null;
      const tick = () =>
        records
          .transact(() => {})
          .then(() => records.sweepOrphans())
          .catch((error) =>
            api.logger?.warn?.(`${PLUGIN_ID}: couldn't sweep its records: ${error.message}`),
          );
      // At start, then hourly.
      await tick();
      const timer = setInterval(tick, options.sweepIntervalMs ?? SWEEP_MS);
      timer.unref?.();
      timers.push(timer);
    },
    stop() {
      emit = null;
      for (const timer of timers.splice(0)) clearInterval(timer);
    },
  });

  return { records, methods };
}
