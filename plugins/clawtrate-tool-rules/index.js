// clawtrate-tool-rules: what each bot may do with its tools, decided before
// each call: run it without asking, ask a person first, or never run it.
//
// What it adds to an OpenClaw gateway, and what it cannot guarantee, is in
// README.md beside this file. In short:
//
//   before_tool_call   decides each agent tool call by the rules (lib/evaluate.js):
//                      a Never blocks with the rule named, an Ask and "Ask when
//                      nothing else decides" ask through the gateway's own
//                      approval card, Allow once or Deny; it never rewrites a call
//   gateway methods    clawtrate-tool-rules.status, .get, .decisions.list
//                      (operator.read); .set (operator.admin)
//   event              plugin.clawtrate-tool-rules.changed, empty (operator.read)
//   gateway log        at start, each bot whose config lets it change the rules
//
// The rules and the decision record are this plugin's own files, in a folder
// of its own in the gateway's state folder (lib/store.js). The decision
// record is metadata only: no arguments, results, paths or commands.

import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "./lib/evaluate.js";
import { exposureWarnings } from "./lib/exposure.js";
import {
  EVERY_BOT,
  EXEMPT_TOOL,
  LIMITS,
  holdsRules,
  RULES_SCHEMA,
  RuleError,
  isScopeId,
  nextScope,
  ruleLabel,
  scopeWords,
} from "./lib/rules.js";
import {
  DecisionLog,
  MAX_DECISIONS,
  RETENTION_MS,
  RulesStore,
  STORE_DIR,
  hashCallId,
} from "./lib/store.js";
import { readTarget } from "./lib/targets.js";

export const PLUGIN_ID = "clawtrate-tool-rules";
/** The plugin's version, as `status` reports it; package.json says the same. */
export const PLUGIN_VERSION = "1.0.0";
/**
 * The host can load this module more than once (one copy for the tool hook,
 * another for the gateway methods), so what they share lives in one
 * process-wide slot, per store folder.
 */
export const STATE_KEY = Symbol.for("clawtrate-tool-rules.state.v1");
/** The wait the plugin asks for; the gateway keeps a plugin's wait to 10 minutes at most. */
export const APPROVAL_TIMEOUT_MS = 600_000;
/** Allow once and Deny, always: a card's answer never makes a standing permission. */
export const ALLOWED_DECISIONS = Object.freeze(["allow-once", "deny"]);
export const TITLE_MAX = 80;
export const DESCRIPTION_MAX = 512;
export const CHANGED_EVENT = "changed";
const LIST_LIMIT = { default: 100, max: 500 };
const ANSWERS = new Set(["allow-once", "allow-always", "deny", "timeout", "cancelled"]);

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => (typeof value === "string" && value.length > 0 ? value : null);
const clip = (value, max) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

class RequestError extends Error {
  constructor(code, reason, message, details = {}) {
    super(message);
    this.code = code;
    this.reason = reason;
    this.details = details;
  }
}

/** The state every copy of the module shares for one store folder. */
function sharedState(dir, options) {
  const slots = options.slots ?? (globalThis[STATE_KEY] ??= new Map());
  let shared = slots.get(dir);
  if (!shared) {
    shared = {
      store: new RulesStore(dir, options.now ? { now: options.now } : {}),
      log: new DecisionLog(dir, options.log ?? {}),
      /** When the hook last saw a tool call, in this process. */
      lastCallAt: null,
      /** registration -> { hook: whether it registered the hook, emit } while its service runs */
      active: new Map(),
    };
    shared.store.onExternalChange = () => emitChanged(shared);
    // Every change of state is said in the log, not only at start. (Readers are
    // told by onExternalChange, or by the save that made the change.)
    // (The first read is said by the service's start.)
    shared.store.onStateChange = (view, before) => {
      if (before.kind === "unread") return;
      const running = [...shared.active.values()].reverse().find((entry) => entry.logger);
      const line = `${PLUGIN_ID}: ${stateLine(view)}`;
      if (view.kind === "lost") running?.logger.warn?.(line);
      else running?.logger.info?.(line);
    };
    slots.set(dir, shared);
  }
  return shared;
}

function emitChanged(shared) {
  const running = [...shared.active.values()].reverse().find((entry) => entry.emit);
  // Empty: readers fetch again, and nothing about a rule or a bot goes out.
  running?.emit(CHANGED_EVENT, {}, { scope: "operator.read" });
}

/** The rules' state for `status`: none, read (and when), or lost (why, and any copy kept). */
function rulesState(view) {
  if (view.kind === "read") return { state: "read", readAt: view.readAt };
  if (view.kind === "lost") {
    return { state: "lost", reason: view.problem, keptCopyReadAt: view.kept?.readAt ?? null };
  }
  return { state: "none" };
}

/** The rules' state in words, for the gateway's log. */
function stateLine(view) {
  if (view.kind === "none") return "No rules file: nothing was saved, so nothing is enforced.";
  if (view.kind === "read") return "Rules read; enforcing them.";
  if (view.kind === "lost" && view.kept) {
    return `Rules unavailable: ${view.problem}. Enforcing the copy read at ${new Date(view.kept.readAt).toISOString()}.`;
  }
  return `Rules unavailable: ${view.problem}. No copy was read in this process, so every tool call but ask_user is asked about.`;
}

/** What the rules match, for `status`: tools by name, and the scopes that ask for every tool. */
function matchesOf(scopes) {
  const tools = new Set();
  const fallback = [];
  for (const [id, scope] of scopes) {
    for (const rule of scope.rules) for (const tool of rule.tools) tools.add(tool);
    if (scope.fallback) fallback.push(id);
  }
  return { tools: [...tools].sort(), fallback: fallback.sort(), exempt: [EXEMPT_TOOL] };
}

/** What the call acts on, in words for the card. */
function targetWords(target) {
  if (!target) return "";
  if (target.value === null) return " on a target the plugin cannot read";
  return target.kind === "command"
    ? ` running ${JSON.stringify(clip(target.value, 200))}`
    : ` on ${clip(target.value || ".", 200)}`;
}

/** The card's title and description, within the gateway's limits. */
export function approvalText(result, tool, target) {
  const title = clip(`${tool}: Clawtrate's rules plugin asks first`, TITLE_MAX);
  const source = result.source;
  const asker =
    source.kind === "fallback"
      ? `"Ask when nothing else decides" is on for ${source.scope === EVERY_BOT ? "every bot" : source.scope}`
      : `${scopeWords(source.scope)} '${ruleLabel(result.rule)}', version ${source.version} (rule ${source.ruleId})`;
  const description = clip(
    `Asked by Clawtrate's rules plugin: ${asker}. The call: ${tool}${targetWords(target)}.`,
    DESCRIPTION_MAX,
  );
  return { title, description };
}

/** The card while the rules are lost and no copy was read: every call is asked about. */
export function lostRulesText(tool, target) {
  return {
    title: clip(`${tool}: Clawtrate's rules could not be read`, TITLE_MAX),
    description: clip(
      `Clawtrate's rules plugin could not read its rules, so it asks before every tool call until they can be read. The call: ${tool}${targetWords(target)}.`,
      DESCRIPTION_MAX,
    ),
  };
}

/** The reason a Never gives, naming the rule; the call's own result carries it. */
export function blockReason(result) {
  const { source, rule } = result;
  return `Blocked by Clawtrate's rules plugin: ${scopeWords(source.scope)} '${ruleLabel(rule)}', version ${source.version} (rule ${source.ruleId}). The call did not run.`;
}

/**
 * Register the plugin on `api`. Returns a handle for tests. `options` lets
 * tests give the state folder, the shared slots and the decision record's
 * clock and bounds.
 */
export function createToolRules(api, options = {}) {
  const currentConfig = () => {
    try {
      return api.runtime?.config?.current?.() ?? api.config;
    } catch {
      return api.config;
    }
  };
  const stateDir = options.stateDir ?? api.runtime?.state?.resolveStateDir?.();
  if (typeof stateDir !== "string" || stateDir.length === 0) {
    throw new Error(`${PLUGIN_ID}: the gateway gave no state folder for the rules store`);
  }
  const dir = join(stateDir, STORE_DIR);
  const shared = sharedState(dir, options);
  const { store, log } = shared;
  const logger = api.logger ?? {};
  const registration = Symbol("registration");
  const now = options.now ?? Date.now;

  /** The names a bot's workspace folder goes by, for an absolute path. */
  const workspaceOf = (agentId) => () => {
    const resolve = api.runtime?.agent?.resolveAgentWorkspaceDir;
    if (typeof resolve !== "function" || typeof agentId !== "string") return [];
    try {
      const dir = resolve(currentConfig(), agentId);
      const names = [dir];
      try {
        names.push(realpathSync.native(dir));
      } catch {
        // Not created yet: its configured name is the only one.
      }
      return names;
    } catch {
      return [];
    }
  };

  // ---- the hook ----

  function decide(event, ctx) {
    shared.lastCallAt = now();
    const tool = text(event?.toolName) ?? "";
    const agentId = text(ctx?.agentId);
    const base = {
      agentId,
      sessionKey: text(ctx?.sessionKey),
      runId: text(event?.runId) ?? text(ctx?.runId),
      callId: hashCallId(text(event?.toolCallId) ?? text(ctx?.toolCallId)),
      tool,
    };
    // Before anything that could fail: a question is never asked about or blocked.
    if (tool === EXEMPT_TOOL) {
      log.add({ ...base, decision: "none", source: null });
      return undefined;
    }
    const view = store.view();
    const rules = view.kind === "lost" ? (view.kept ? "kept" : "lost") : view.kind;
    const target = readTarget(tool, event?.params, workspaceOf(agentId));
    const ask = (text, id) => ({
      requireApproval: {
        ...text,
        severity: "warning",
        timeoutMs: APPROVAL_TIMEOUT_MS,
        allowedDecisions: [...ALLOWED_DECISIONS],
        // Only the decision word is kept; nothing standing is made from it.
        onResolution: (decision) => log.answer(id, ANSWERS.has(decision) ? decision : "unknown"),
      },
    });
    if (view.enforced === null) {
      // Lost, with no copy: nothing a person forbade may run unasked.
      const id = log.add({ ...base, rules, decision: "ask", source: { kind: "rules-lost" } });
      return ask(lostRulesText(tool, target), id);
    }
    const result = evaluate(view.enforced, { agentId, tool, target });
    const id = log.add({ ...base, rules, decision: result.decision, source: result.source });
    if (result.decision === "block") return { block: true, blockReason: blockReason(result) };
    if (result.decision !== "ask") return undefined;
    return {
      requireApproval: {
        ...approvalText(result, tool, target),
        severity: "warning",
        timeoutMs: APPROVAL_TIMEOUT_MS,
        allowedDecisions: [...ALLOWED_DECISIONS],
        // Only the decision word is kept; nothing standing is made from it.
        onResolution: (decision) => log.answer(id, ANSWERS.has(decision) ? decision : "unknown"),
      },
    };
  }

  // Every tool: "Ask when nothing else decides" can apply to any of them.
  // The hook needs no conversation access.
  let hookRegistered = false;
  if (typeof api.on === "function") {
    api.on("before_tool_call", decide);
    hookRegistered = true;
  }

  // ---- methods ----

  const method = (name, scope, handler) => {
    if (typeof api.registerGatewayMethod !== "function") return;
    api.registerGatewayMethod(
      `${PLUGIN_ID}.${name}`,
      async (opts) => {
        try {
          opts.respond(true, handler(isPlainObject(opts.params) ? opts.params : {}, opts));
        } catch (error) {
          const refusal =
            error instanceof RuleError
              ? new RequestError("INVALID_REQUEST", error.reason, error.message, error.details)
              : error;
          if (!(refusal instanceof RequestError)) throw error;
          opts.respond(false, undefined, {
            code: refusal.code,
            message: refusal.message,
            details: { reason: refusal.reason, ...refusal.details },
          });
        }
      },
      { scope },
    );
  };

  const unavailable = () =>
    new RequestError("UNAVAILABLE", "rules_unavailable", stateLine(store.view()));

  method("status", "operator.read", () => {
    const view = store.view();
    const registered = [...shared.active.values()].some((entry) => entry.hook);
    return {
      plugin: PLUGIN_ID,
      version: PLUGIN_VERSION,
      rulesSchema: RULES_SCHEMA,
      rules: rulesState(view),
      // What the plugin applies to the next call, all things it knows taken together.
      enforcing: !registered
        ? "not-enforced"
        : view.kind === "none"
          ? "nothing"
          : view.kind === "read"
            ? "rules"
            : view.kept
              ? "kept-copy"
              : "ask-every-call",
      hook: {
        registered,
        // When the hook last saw a call; it says nothing about the rules.
        lastCallAt: shared.lastCallAt,
      },
      matches: view.enforced ? matchesOf(view.enforced) : null,
    };
  });

  method("get", "operator.read", (params) => {
    const scopes = store.scopes();
    if (scopes === null) throw unavailable();
    if (params.scope !== undefined && !isScopeId(params.scope)) {
      throw new RequestError("INVALID_REQUEST", "bad_scope", "scope is * or a bot's id");
    }
    const chosen = [...scopes].filter(([id]) => params.scope === undefined || id === params.scope);
    return {
      rulesSchema: RULES_SCHEMA,
      scopes: Object.fromEntries(chosen),
      limits: { ...LIMITS },
    };
  });

  method("decisions.list", "operator.read", (params) => {
    for (const key of ["agentId", "sessionKey", "runId"]) {
      if (params[key] !== undefined && text(params[key]) === null) {
        throw new RequestError("INVALID_REQUEST", "bad_request", `${key} must be text`);
      }
    }
    if (params.before !== undefined && !Number.isSafeInteger(params.before)) {
      throw new RequestError("INVALID_REQUEST", "bad_request", "before must be a time in ms");
    }
    const limit = params.limit ?? LIST_LIMIT.default;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIST_LIMIT.max) {
      throw new RequestError(
        "INVALID_REQUEST",
        "bad_request",
        `limit must be 1 to ${LIST_LIMIT.max}`,
      );
    }
    const { records, hasMore } = log.list({ ...params, limit });
    return {
      records,
      hasMore,
      retention: { days: RETENTION_MS / 86_400_000, maxRecords: MAX_DECISIONS },
    };
  });

  method("set", "operator.admin", (params, opts) => {
    const { scope, expectedVersion } = params;
    if (!isScopeId(scope)) {
      throw new RequestError("INVALID_REQUEST", "bad_scope", "scope is * or a bot's id");
    }
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw new RequestError(
        "INVALID_REQUEST",
        "bad_request",
        "expectedVersion must be the scope's version as read (0 for a scope never saved)",
      );
    }
    const scopes = store.scopes();
    if (scopes === null) throw unavailable();
    const stored = scopes.get(scope);
    const currentVersion = stored?.version ?? 0;
    if (expectedVersion !== currentVersion) {
      throw new RequestError(
        "INVALID_REQUEST",
        "version_conflict",
        `the rules of this scope changed: version ${currentVersion}, not ${expectedVersion}`,
        { currentVersion },
      );
    }
    const device = text(opts.client?.connect?.device?.id);
    const next = nextScope(scope, stored, params, {
      now: now(),
      setBy: device ? `sha256:${createHash("sha256").update(device).digest("hex")}` : null,
      newId: () => randomBytes(6).toString("hex"),
    });
    // An emptied scope is kept with its revision, so a revision never repeats.
    const after = new Map(scopes).set(scope, next);
    const bots = [...after].filter(([id, s]) => id !== EVERY_BOT && holdsRules(s)).length;
    if (bots > LIMITS.botScopes && holdsRules(next) && !(stored && holdsRules(stored))) {
      throw new RuleError("limit", `rules are kept for at most ${LIMITS.botScopes} bots`, {
        limit: LIMITS.botScopes,
      });
    }
    if (after.size > LIMITS.scopeEntries && !stored) {
      throw new RuleError("limit", `at most ${LIMITS.scopeEntries} scopes are kept`, {
        limit: LIMITS.scopeEntries,
      });
    }
    try {
      store.write(after);
    } catch (error) {
      if (error instanceof RuleError) throw error;
      throw new RequestError(
        "UNAVAILABLE",
        "store_not_written",
        `the rules could not be saved (${error?.code ?? "error"}); nothing changed`,
      );
    }
    emitChanged(shared);
    return { scope, ...next };
  });

  // ---- the service ----

  // Service ids are global across plugins, so this one carries the plugin's id.
  if (typeof api.registerService === "function") {
    api.registerService({
      id: `${PLUGIN_ID}-rules`,
      start(ctx) {
        const events = ctx?.gatewayEvents;
        shared.active.set(registration, {
          hook: hookRegistered,
          logger,
          emit: events ? (name, payload, opts) => events.emit(name, payload, opts) : null,
        });
        const view = store.view();
        // Said at every start; later changes are said as they happen.
        if (view.kind === "lost") logger.warn?.(`${PLUGIN_ID}: ${stateLine(view)}`);
        // What lets a bot change the rules, from the gateway's config, in its log.
        for (const line of exposureWarnings(currentConfig()))
          logger.warn?.(`${PLUGIN_ID}: ${line}`);
      },
      stop() {
        shared.active.delete(registration);
      },
    });
  }

  return { shared, dir, decide };
}

export default {
  id: PLUGIN_ID,
  name: "Clawtrate tool rules",
  description:
    "What each bot may do with its tools: run without asking, ask first, or never. Not made by or affiliated with OpenClaw.",
  register(api) {
    createToolRules(api);
  },
};
