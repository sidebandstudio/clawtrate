// The plugin's methods and service (index.js registers them).

import { hashDevice, newId } from "./canonical.js";
import * as L from "./ledger.js";
import { EXPIRES_MS, LIMITS, Refusal, requireId } from "./ledger.js";
import { NAMESPACE, Records } from "./records.js";

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
  const records = new Records(store, {
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

  /** A proposal as read: expiry the sweep hasn't stored yet shown, and its body's own bot, gateway and tokens. */
  async function view(id, entry) {
    const { grant, ...rest } = entry;
    const state = rest.state === "open" && rest.expiresAt <= now() ? "expired" : rest.state;
    const body = await records.version(id, entry.digest);
    if (!body) return { id, ...rest, state, unreadable: true, said: unreadable().message };
    const { kind, payload, reason, bot, gateway, tokens } = body;
    return {
      id,
      ...rest,
      state,
      generation: grant?.generation,
      kind,
      payload,
      reason,
      bot,
      gateway,
      tokens,
    };
  }

  async function grantView(id, entry) {
    const body = entry ? await records.version(entry.version, entry.digest) : null;
    if (!body) return null;
    const { version: _v, ...state } = entry;
    if (!state.revoked && state.expiresAt <= now()) state.revoked = "expired";
    return { id, ...state, ...body.details };
  }

  const proposal = async (id) => {
    const { proposals } = await records.ledger();
    const entry = Object.hasOwn(proposals, id) ? proposals[id] : null;
    if (!entry) throw new Refusal("unknown", "Clawtrate has no such request on this gateway.");
    return entry;
  };

  const methods = {
    status: [
      "operator.read",
      async () => {
        const ledger = await records.ledger();
        const at = now();
        return {
          plugin: PLUGIN_ID,
          version: PLUGIN_VERSION,
          gateway: await gatewayId(),
          capabilities: { proposals: true, relay: true, onboarding: false },
          apply: { available: false, reason: "incarnation" },
          describe: { available: false, reason: "route-binding" },
          open: Object.values(ledger.proposals).filter(
            (e) => e.state === "open" && e.expiresAt > at,
          ).length,
          limits: { ...LIMITS },
        };
      },
    ],
    "proposals.list": [
      "operator.read",
      async () => {
        const ledger = await records.ledger();
        const entries = Object.entries(ledger.proposals).sort(
          ([, a], [, b]) => b.createdAt - a.createdAt,
        );
        return { proposals: await Promise.all(entries.map(([id, e]) => view(id, e))) };
      },
    ],
    "proposals.get": [
      "operator.read",
      async ({ id }) => view(id, await proposal(requireId("p", id, "id"))),
    ],
    // The claim is checked, then its version read, after every observation.
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
        const entry = L.claim(await records.ledger(), id, digest, now());
        if (!(await records.version(id, entry.digest))) throw unreadable();
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
        const ledger = await records.ledger();
        const grant = await grantView(
          id,
          Object.hasOwn(ledger.grants, id) ? ledger.grants[id] : null,
        );
        if (!grant)
          throw new Refusal("grant-missing", "This agent's access to Clawtrate isn't set up.");
        return grant;
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
        // A grant is never changed: a narrower one is a new grant, with a fresh id.
        if (params.id !== undefined)
          throw bad("A grant can't be changed. Add a new one and remove this one.");
        const id = newId("g");
        if (!["see", "suggest"].includes(params.scope)) throw bad("scope must be see or suggest.");
        const all = params.bots === "all";
        if (
          !all &&
          !(Array.isArray(params.bots) && params.bots.every((b) => typeof b === "string"))
        )
          throw bad('bots must be "all" or a list of bot ids.');
        const at = now();
        const expiresAt =
          Number.isSafeInteger(params.expiresAt) && params.expiresAt > at
            ? params.expiresAt
            : at + GRANT_DAYS_MS;
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
        const { generation } = await records.publish(version, digest, (l, t) =>
          L.publishGrant(l, id, { version, digest, expiresAt }, t),
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
        const digest = await records.persist(id, body);
        const fields = fieldNames(payload);
        const { superseded } = await records.publish(id, digest, (l, t) =>
          L.admit(
            l,
            { id, digest, source, bot: body.bot, fields, createdAt: at, expiresAt: body.expiresAt },
            t,
          ),
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
