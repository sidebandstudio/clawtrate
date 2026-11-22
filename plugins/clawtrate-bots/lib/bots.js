// The plugin's methods and service (index.js registers them).

import { hashDevice, newId } from "./canonical.js";
import * as ledgerOps from "./ledger.js";
import { EXPIRES_MS, LIMITS, ORPHAN_MS, Refusal } from "./ledger.js";
import { NAMESPACE, Records } from "./records.js";

export const PLUGIN_ID = "clawtrate-bots";
export const PLUGIN_VERSION = "0.1.0";
const GRANT_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const EFFORT = ["off", "minimal", "low", "medium", "high", "xhigh"];
const AUTONOMY = ["hands-off", "ask"];
const TEXT_MAX = 64 * 1024;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const bad = (message) => new Refusal("invalid", message);
const str = (v, max, what) => {
  if (typeof v !== "string" || v.trim().length === 0 || v.length > max)
    throw bad(`${what} must be text of 1 to ${max} characters.`);
  return v;
};
const hash = (v, what) => {
  if (v !== null && (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)))
    throw bad(`${what} must be the file's hash, or null when the file is missing.`);
  return v;
};

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
    } else if (key === "instructions" && isObject(value)) {
      if (!instructions)
        throw new Refusal("instructions", "This agent may not see or change instructions.");
      out.instructions = {};
      for (const [file, change] of Object.entries(value)) {
        if (!["agents", "soul"].includes(file) || !isObject(change))
          throw bad(`instructions.${file} isn't a file Clawtrate changes.`);
        out.instructions[file] = {
          text: str(change.text, TEXT_MAX, file),
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

  async function view(id, entry) {
    const body = await records.version(id, entry.digest);
    const { grant, ...rest } = entry;
    if (!body)
      return { id, ...rest, unreadable: true, said: "Clawtrate couldn't read this request." };
    return {
      id,
      ...rest,
      generation: grant?.generation,
      payload: body.payload,
      reason: body.reason,
      kind: body.kind,
    };
  }

  async function grantView(id, entry) {
    const body = entry ? await records.version(entry.version, entry.digest) : null;
    if (!body) return null;
    const { version: _v, ...state } = entry;
    return { id, ...state, ...body.details };
  }

  const methods = {
    status: [
      "operator.read",
      async () => {
        const ledger = await records.ledger();
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
      async ({ id }) => {
        const entry = (await records.ledger()).proposals[id];
        if (!entry) throw new Refusal("unknown", "Clawtrate has no such request on this gateway.");
        return view(id, entry);
      },
    ],
    "proposals.decline": [
      "operator.write",
      async ({ id, digest }, opts) => {
        const by = hashDevice(opts.client?.connect?.device?.id);
        await records.transact((l, at) => ledgerOps.decline(l, id, digest, by, at));
        return { id, state: "declined" };
      },
    ],
    // Section 17: on 2026.10.6 no stored request can be applied. The claim's
    // checks still run, so a request already settled says so.
    "proposals.accept": [
      "operator.admin",
      async ({ id, digest }) => {
        ledgerOps.claim(structuredClone(await records.ledger()), id, digest, now());
        throw new Refusal(
          "apply-unavailable",
          "Clawtrate can't apply a saved request on this gateway. Review and save it yourself instead.",
        );
      },
    ],
    "relay.grants.get": [
      "operator.read",
      async ({ id }) => {
        const grant = await grantView(id, (await records.ledger()).grants[id]);
        if (!grant)
          throw new Refusal("grant-missing", "This agent's access to Clawtrate isn't set up.");
        return grant;
      },
    ],
    "relay.grants.set": [
      "operator.admin",
      async (params) => {
        if (params.revoke === true) {
          const { generation } = await records.transact((l, at) =>
            ledgerOps.revoke(l, params.id, at),
          );
          return { id: params.id, generation, revoked: true };
        }
        const id = params.id === undefined ? newId("g") : str(params.id, 40, "id");
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
        const known = (await bots()).map((b) => b.id);
        const details = {
          scope: params.scope,
          bots: all ? (params.includeFuture === true ? "all" : known) : [...new Set(params.bots)],
          includeInstructions: params.includeInstructions === true,
          includeFuture: all && params.includeFuture === true,
          expiresAt,
        };
        const version = newId("gv");
        const digest = await records.persist(version, {
          kind: "grant",
          grant: id,
          gateway: await gatewayId(),
          details,
        });
        if (!(await records.version(version, digest)))
          throw new Error("The grant's record didn't read back.");
        const { generation } = await records.transact((l, t) =>
          ledgerOps.publishGrant(l, id, { version, digest, expiresAt }, t),
        );
        return { id, generation, ...details };
      },
    ],
    "relay.propose": [
      "operator.admin",
      async (params) => {
        const ledger = await records.ledger();
        const grant = await grantView(params.grant, ledger.grants[params.grant]);
        if (!grant)
          throw new Refusal("grant-missing", "This agent's access to Clawtrate isn't set up.");
        // The ledger decides the generation again when it admits.
        if (grant.scope !== "suggest") throw new Refusal("scope", "This agent may only see bots.");
        const bot = (await bots()).find((b) => b.id === params.bot);
        if (!bot || (grant.bots !== "all" && !grant.bots.includes(bot.id)))
          throw new Refusal("bot", "This agent can't suggest changes to that bot.");
        const payload = updateFields(params.fields, { instructions: grant.includeInstructions });
        const reason = params.reason === undefined ? undefined : str(params.reason, 200, "reason");
        const at = now();
        const id = newId("p");
        const source = { kind: "agent", grant: params.grant, generation: params.generation };
        const body = {
          id,
          gateway: await gatewayId(),
          bot: {
            id: bot.id,
            createdAt: Number.isSafeInteger(bot.createdAt) ? bot.createdAt : null,
          },
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
        if (!(await records.version(id, digest)))
          throw new Error("The request's record didn't read back.");
        const fields = fieldNames(payload);
        const { superseded } = await records.transact((l, t) =>
          ledgerOps.admit(
            l,
            { id, digest, source, bot: bot.id, fields, createdAt: at, expiresAt: at + EXPIRES_MS },
            t,
          ),
        );
        return {
          status: "proposed",
          proposalId: id,
          digest,
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
      // At start (recovery before retention), then hourly.
      await tick();
      const timer = setInterval(tick, options.sweepIntervalMs ?? ORPHAN_MS);
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
