// clawtrate-tool-rules: what each bot may do with its tools, decided before
// each call: run it without asking, ask a person first, or never run it.
//
// What it adds to an OpenClaw gateway, and what it cannot guarantee, is in
// README.md beside this file. In short:
//
//   tool policy        a trusted tool policy (`rules`, declared in the manifest)
//                      decides each agent tool call by the rules (lib/evaluate.js):
//                      a Never blocks with the rule named, an Ask and "Ask when
//                      nothing else decides" ask through the gateway's own
//                      approval card, Allow once or Deny, and refuse in a run
//                      another bot's message started or reached, or where the
//                      Codex harness may answer the card; it never rewrites a
//                      call
//   before_tool_call   after Allow once, refuses the call if its rule or its
//                      arguments changed while the card waited; decides again
//                      a call another policy changed; where there is no trusted
//                      policy, decides instead, refusing an Ask
//   before_message_write, model_call_started, after_tool_call
//                      note which bot's message started or reached a run (the
//                      message's role, the gateway's marks on it and on a bot's
//                      sessions_send result, never a message's text)
//   gateway methods    clawtrate-tool-rules.status, .get, .decisions.list
//                      (operator.read); .set (operator.admin)
//   event              plugin.clawtrate-tool-rules.changed, empty (operator.read)
//   gateway log        at start, each bot whose config lets it change the rules
//
// The rules and the decision record are this plugin's own files, in a folder
// of its own in the gateway's state folder (lib/store.js). The decision
// record is metadata only: no arguments, results, paths or commands.

import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { evaluate, targetDecides } from "./lib/evaluate.js";
import { configuredAgents, explicitlyDenied, exposureWarnings } from "./lib/exposure.js";
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
/** How often expired decision records are removed and the rules file looked at. */
export const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const LIST_LIMIT = { default: 100, max: 500 };
/** A page's `nextCursor`: the id of the last record it listed. */
const CURSOR = /^[0-9a-f]{16}$/;
/** The longest filter `decisions.list` takes. */
const FILTER_MAX = 512;
const ANSWERS = new Set(["allow-once", "allow-always", "deny", "timeout", "cancelled"]);
/** The trusted tool policy that decides each call; the manifest declares it. */
export const POLICY_ID = "rules";
/**
 * How many tasks, runs and answered cards the plugin remembers who started or
 * what was shown, each; the oldest is forgotten first.
 */
export const MEMORY_LIMIT = 1000;
/**
 * How many bots' messages one task holds waiting for their runs; past it the
 * oldest is let go, and its task and run are kept among the forgotten.
 */
export const PENDING_LIMIT = 16;
/**
 * How long a bot's message waits for its run before the plugin lets the task go;
 * its run, if it starts later, still counts as the bot's.
 */
export const MARK_EXPIRY_MS = 30 * 60 * 1000;
/** A bot's id as the gateway writes it in a task's key; anything else is not named. */
const BOT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

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
      /**
       * Who started each run, and who wrote each task's latest message: null for a person,
       * { bot } for another bot. `pending` holds, per task, the bots' messages waiting,
       * `{ bot, run, at }` with the run each names (`next` for one kept only for the next
       * run) and when it was written; `current` each task's latest run; `times` when a
       * task's person last wrote and its latest run was noted, on `clock`; `early` the
       * bots' messages a send's result placed before they were written ("steered" or
       * "ended"), by task and run; `forgotten` the runs and tasks whose bot's mark was let
       * go past a bound, which count as a bot's; `people` the runs a person's message
       * names, with when it was written on `clock`; `steeredTasks` the tasks a bot's message was steered into, `{ bot, at }`, whose
       * runs noted before `at` are the bot's until the task's next run starts; `notedAt` when
       * each run was noted, on `clock`; `notedLost` whether one of those was let go past the
       * bound, after which a run first seen may be one noted before; `lostTrack` whether a
       * bot's mark was let go with nowhere left to keep it.
       */
      origins: {
        sessions: new Map(),
        runs: new Map(),
        current: new Map(),
        pending: new Map(),
        times: new Map(),
        early: new Map(),
        clock: 0,
        forgotten: new Map(),
        people: new Map(),
        steeredTasks: new Map(),
        notedAt: new Map(),
        notedLost: false,
        lostTrack: false,
      },
      /**
       * The cards answered Allow once, by run and call: the source each card showed and
       * a hash of the arguments the policy looked at.
       */
      approved: new Map(),
      /**
       * The calls the trusted policy decided, by run and call: a hash of the arguments it
       * looked at, and whether it asked.
       */
      seen: new Map(),
      /** Which decided the last call: "policy" (the trusted policy) or "hook"; null before one. */
      decidedBy: null,
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
  return `Rules unavailable: ${view.problem}. No copy was read in this process, so every tool call but ask_user is refused.`;
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

const REDACTED_TAIL = " The details are in Clawtrate.";
const ACTION_WORDS = { ask: "Ask first", never: "Never", allow: "Allow" };

/**
 * Whether a card may reach more than the run's device and admin
 * connections: plugin approvals forwarded (`approvals.plugin.enabled`), a
 * channel's reviewer policy for plugin approvals (`approvals.plugin.<channel>`),
 * or any chat channel configured, which can deliver a card to its own reviewers.
 */
export function mayForward(config) {
  const approvals = isPlainObject(config?.approvals) ? config.approvals : {};
  const plugin = approvals.plugin;
  const forwarding = isPlainObject(plugin) && plugin.enabled === true;
  const reviewers =
    isPlainObject(plugin) &&
    Object.keys(plugin).some(
      (key) => !["enabled", "mode", "agentFilter", "sessionFilter", "targets"].includes(key),
    );
  const channels =
    isPlainObject(config?.channels) &&
    Object.values(config.channels).some((channel) => channel !== null && channel !== false);
  return forwarding || reviewers || channels;
}

/** Whether a card names its target: `full` or `redacted`, and why. */
export function cardDetails(setting, config) {
  if (setting === "full" || setting === "redacted") return { mode: setting, because: "setting" };
  return mayForward(config)
    ? { mode: "redacted", because: "forwarding-configured" }
    : { mode: "full", because: "no-forwarding" };
}

/**
 * The card's title and description, within the gateway's limits. Redacted,
 * it names the tool and the rule and leaves out the path, the command and
 * the bot's id.
 */
export function approvalText(result, tool, target, redacted = false) {
  const title = clip(`${tool}: Clawtrate's rules plugin asks first`, TITLE_MAX);
  const source = result.source;
  const forEvery = source.scope === EVERY_BOT;
  let asker;
  if (source.kind === "fallback") {
    asker = `"Ask when nothing else decides" is on for ${forEvery ? "every bot" : redacted ? "this bot" : source.scope}`;
  } else if (redacted) {
    asker = `${forEvery ? "a rule for every bot" : "a rule for this bot"} (rule ${source.ruleId}, version ${source.version}, ${ACTION_WORDS[source.action]})`;
  } else {
    asker = `${scopeWords(source.scope)} '${ruleLabel(result.rule)}', version ${source.version} (rule ${source.ruleId})`;
  }
  const description = redacted
    ? clip(
        `Asked by Clawtrate's rules plugin: ${asker}. The call: ${tool}.${REDACTED_TAIL}`,
        DESCRIPTION_MAX,
      )
    : clip(
        `Asked by Clawtrate's rules plugin: ${asker}. The call: ${tool}${targetWords(target)}.`,
        DESCRIPTION_MAX,
      );
  return { title, description };
}

/**
 * The refusal while the rules are lost and no copy was read in this process:
 * a saved Never may cover the call, and no card can say so, so every call but
 * `ask_user` is refused until the file can be read again.
 */
export const LOST_RULES_REASON =
  "Refused by Clawtrate's rules plugin without asking anyone: its rules could not be read and no copy was read before, so a saved Never may cover this call. Every call but ask_user is refused until the rules can be read again. The call did not run.";

/** The reason a Never gives, naming the rule; the call's own result carries it. */
export function blockReason(result) {
  const { source, rule } = result;
  return `Blocked by Clawtrate's rules plugin: ${scopeWords(source.scope)} '${ruleLabel(rule)}', version ${source.version} (rule ${source.ruleId}). The call did not run.`;
}

/** What asked, in words for a refusal: the rule, the fallback, or the lost rules. */
function askerWords(result) {
  const { source, rule } = result;
  if (source.kind === "fallback") {
    return `"Ask when nothing else decides" is on for ${source.scope === EVERY_BOT ? "every bot" : source.scope}`;
  }
  return `${scopeWords(source.scope)} '${ruleLabel(rule)}', version ${source.version} (rule ${source.ruleId}), asks first`;
}

/** The bot a task's key names (`agent:<id>:…`), in a bot id's form, or null. */
export function botOfKey(key) {
  const id = /^agent:([^:]{1,64}):/.exec(typeof key === "string" ? key : "")?.[1]?.toLowerCase();
  return id && BOT_ID.test(id) ? id : null;
}

/**
 * Who sent a task's user message, from the gateway's own mark on it: null for
 * a person or the gateway, `{ bot, source }` for another task's message (`bot`
 * the id its task's key names, or null when it names none the plugin can
 * name; `source` that task's key).
 */
export function messageOrigin(message) {
  const provenance = isPlainObject(message) ? message.provenance : null;
  if (!isPlainObject(provenance) || provenance.kind !== "inter_session") return null;
  const source =
    typeof provenance.sourceSessionKey === "string" ? provenance.sourceSessionKey : null;
  return { bot: botOfKey(source), source };
}

/**
 * The refusal of an Ask in a run another bot's message started: no card, the
 * asking rule and the bot named. The bot's id is one the gateway wrote in a
 * task's key, checked against its form, so it carries nothing else.
 */
export function botRunReason(result, origin) {
  const who = origin.unsure
    ? "the plugin can no longer tell who started this run: it let go of a bot's message past its memory limit, so it counts the run as a bot's"
    : `this run was started by a message from ${origin.bot ? `bot ${origin.bot}` : "another bot"}`;
  return clip(
    `Refused by Clawtrate's rules plugin without asking anyone: ${askerWords(result)}, and ${who}. An Ask in a run another bot started is a refusal, so a person never approves what a bot asked for. The call did not run.`,
    DESCRIPTION_MAX,
  );
}

const UNCHECKABLE = {
  hook: "the gateway did not run the plugin's trusted policy, so an answer could not be checked again before the call runs",
  changed:
    "another plugin's policy changed the call after this plugin looked at it, so an answer could not be checked again before the call runs",
  codex:
    "the gateway may run the Codex harness, whose native tool approvals are answered where the plugin cannot check the answer again before the call runs",
};

/** The refusal of an Ask whose answer the plugin could not check again before the call runs. */
export function uncheckableReason(result, why) {
  return clip(
    `Refused by Clawtrate's rules plugin without asking anyone: ${askerWords(result)}, and ${UNCHECKABLE[why]}. The call did not run.`,
    DESCRIPTION_MAX,
  );
}

/** The refusal of a call whose arguments changed after its card was shown. */
export const CHANGED_ARGUMENTS_REASON =
  "Refused by Clawtrate's rules plugin: the call's arguments changed after the plugin asked about it (another plugin's policy rewrote them). The answer was for the call the card showed. The call did not run.";

const CODEX = "codex";
/** A plugin id as the gateway compares it in its plugin lists (`normalizePluginPolicyId`). */
const policyId = (value) => (typeof value === "string" ? value.trim().toLowerCase() : "");
const namesCodex = (list) => Array.isArray(list) && list.some((id) => policyId(id) === CODEX);

/** How long a look for an untracked Codex plugin on disk is kept. */
export const CODEX_SCAN_MS = 60_000;
/** The most entries of a plugin folder the look reads. */
const CODEX_SCAN_LIMIT = 500;

/**
 * Whether the gateway may run the Codex harness, whose native tool relay
 * defers a plugin's card to Codex's own approval and runs the call without
 * this plugin's hook after the answer. Codex is not bundled with OpenClaw
 * 2026.10.6 or 2026.11.10 (neither's `dist/extensions` holds it): it reaches a
 * gateway installed, which leaves its entry, an install record or a load path
 * in the config, or copied into the global plugin folder untracked
 * (`onDisk`). It follows how both versions decide an installed plugin loads
 * (`resolvePluginActivationStateShared`): never with `plugins.enabled` false,
 * `codex` in `plugins.deny` or its entry's `enabled` false; always when a
 * memory or context-engine slot names it; never when a non-empty
 * `plugins.allow` leaves it out; otherwise when the config names it (its
 * entry, the allow list, an install record), a load path holds it (`atPath`:
 * by default, a path that names it), or it was found on disk.
 */
export function codexHarnessMayRun(config, onDisk = false, atPath = codexInName) {
  const plugins = isPlainObject(config?.plugins) ? config.plugins : {};
  if (plugins.enabled === false) return false;
  if (namesCodex(plugins.deny)) return false;
  const entries = isPlainObject(plugins.entries) ? plugins.entries : {};
  const entryKey = Object.keys(entries).find((key) => policyId(key) === CODEX);
  const entry = entryKey === undefined ? undefined : entries[entryKey];
  if (isPlainObject(entry) && entry.enabled === false) return false;
  const slots = isPlainObject(plugins.slots) ? plugins.slots : {};
  if (policyId(slots.memory) === CODEX || policyId(slots.contextEngine) === CODEX) return true;
  const allow = Array.isArray(plugins.allow) ? plugins.allow : [];
  if (allow.length > 0 && !namesCodex(allow)) return false;
  const installs = isPlainObject(plugins.installs) ? plugins.installs : {};
  const paths = isPlainObject(plugins.load) ? plugins.load.paths : undefined;
  return (
    onDisk ||
    entryKey !== undefined ||
    namesCodex(allow) ||
    Object.keys(installs).some((key) => policyId(key) === CODEX) ||
    (Array.isArray(paths) && paths.some((path) => typeof path === "string" && atPath(path)))
  );
}

/** A home value as the gateway reads one (`normalizeHomeDirValue`). */
const homeValue = (value) => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed && trimmed !== "undefined" && trimmed !== "null" ? trimmed : undefined;
};

/** The OS home as the gateway reads it (`resolveRawOsHomeDir`). */
function rawOsHome(env) {
  const prefix = homeValue(env.PREFIX);
  const termux =
    prefix &&
    homeValue(env.ANDROID_DATA) &&
    /(?:^|\/)com\.termux\/files\/usr\/?$/u.test(prefix.replace(/\\/gu, "/"))
      ? resolve(prefix, "..", "home")
      : undefined;
  let os;
  try {
    os = homeValue(homedir());
  } catch {
    os = undefined;
  }
  return homeValue(env.HOME) ?? homeValue(env.USERPROFILE) ?? termux ?? os;
}

/**
 * The home a path's `~` stands for, as OpenClaw 2026.10.6 and 2026.11.10
 * resolve it (`resolveEffectiveHomeDir`, then `resolveRequiredHomeDir`):
 * `OPENCLAW_HOME`, its own `~` read against the OS home, else the OS home,
 * else the working folder.
 */
export function gatewayHome(env = process.env) {
  const explicit = homeValue(env.OPENCLAW_HOME);
  if (explicit) {
    if (explicit === "~" || explicit.startsWith("~/") || explicit.startsWith("~\\")) {
      const os = rawOsHome(env);
      if (os) return resolve(explicit.replace(/^~(?=$|[\\/])/, () => os));
    } else {
      return resolve(explicit);
    }
  }
  const os = explicit ? undefined : rawOsHome(env);
  return resolve(os ?? process.cwd());
}

/** A configured path as the gateway resolves it (`resolveUserPath`): `~` against its home, then absolute. */
export function resolveUserPath(input, env = process.env) {
  const trimmed = input.trim();
  const expanded = trimmed.startsWith("~")
    ? trimmed.replace(/^~(?=$|[\\/])/, () => gatewayHome(env))
    : trimmed;
  return resolve(expanded);
}

/** Whether a load path names Codex in its own words. */
const codexInName = (path) => /codex/i.test(path);

/**
 * Whether a configured load path holds the Codex plugin: it names Codex; its
 * manifest (beside the path, or in its folder) has the id `codex`; or, a
 * folder of plugins, one of them does. The path is resolved as the gateway
 * resolves it (`resolveUserPath`); one the plugin cannot read may hold it.
 */
export function codexAtPath(path, env = process.env) {
  if (typeof path !== "string" || path.trim().length === 0) return false;
  if (codexInName(path)) return true;
  let where;
  try {
    where = resolveUserPath(path, env);
  } catch {
    return true;
  }
  for (const manifest of [
    join(where, "openclaw.plugin.json"),
    join(dirname(where), "openclaw.plugin.json"),
  ]) {
    try {
      if (policyId(JSON.parse(readFileSync(manifest, "utf8"))?.id) === CODEX) return true;
    } catch (error) {
      if (error?.code && error.code !== "ENOENT" && error.code !== "ENOTDIR") return true;
    }
  }
  return codexInFolder(where);
}

/**
 * Whether a plugin folder holds a Codex plugin: a folder named `codex`, or a
 * manifest whose id is `codex`. A folder that is not there holds none; one
 * that cannot be read may hold one.
 */
export function codexInFolder(folder) {
  let names;
  try {
    names = readdirSync(folder, { withFileTypes: true });
  } catch (error) {
    return error?.code !== "ENOENT" && error?.code !== "ENOTDIR";
  }
  for (const item of names.slice(0, CODEX_SCAN_LIMIT)) {
    if (!item.isDirectory() && !item.isSymbolicLink()) continue;
    if (policyId(item.name) === CODEX) return true;
    try {
      const manifest = JSON.parse(
        readFileSync(join(folder, item.name, "openclaw.plugin.json"), "utf8"),
      );
      if (policyId(manifest?.id) === CODEX) return true;
    } catch (error) {
      if (error?.code && error.code !== "ENOENT" && error.code !== "ENOTDIR") return true;
    }
  }
  return names.length > CODEX_SCAN_LIMIT;
}

/**
 * The global plugin folders an untracked plugin loads from: the state folder's
 * `extensions`, and the config folder's where the environment moves it, as
 * both versions resolve it (`resolvePluginInstallRoots`: OPENCLAW_STATE_DIR,
 * else beside OPENCLAW_CONFIG_PATH; with neither, the default the state folder
 * already is).
 */
export function globalPluginFolders(stateDir, env = process.env) {
  const override = text(env.OPENCLAW_STATE_DIR?.trim());
  const configPath = text(env.OPENCLAW_CONFIG_PATH?.trim());
  const configDir = override
    ? resolveUserPath(override, env)
    : configPath
      ? dirname(resolveUserPath(configPath, env))
      : null;
  return [
    ...new Set([stateDir, ...(configDir ? [configDir] : [])].map((dir) => join(dir, "extensions"))),
  ];
}

/** Where OpenClaw 2026.10.6 and 2026.11.10 keep the hooks their plugins registered. */
const HOOK_RUNNER_STATE = Symbol.for("openclaw.plugins.hook-runner-global-state");
const PLUGIN_REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");

/**
 * The other plugins holding a `before_tool_call` hook in this gateway
 * process, from the registries both versions keep there (the hook runner's
 * and the active one; each `typedHooks` entry names its `pluginId` and
 * `hookName`), sorted; null where the plugin cannot read them. Such a hook can
 * change a call's arguments after this plugin decided it: both versions give
 * each handler the original call and apply the merged arguments only after
 * the last one (`runBeforeToolCall`), with nothing after that can refuse.
 *
 * The hook runner dispatches from a registry it resolves for each call (a
 * prepared generation's, or a request's laid over the active one), which the
 * plugin cannot read by name; its `getHookCount` counts from that same
 * registry. So where it counts more such hooks than this plugin's own and the
 * registries read name no other, there is one the plugin cannot name: null.
 *
 * @param {Record<PropertyKey, any>} [store] where the registries are kept: the process itself
 * @returns {string[] | null}
 */
export function otherToolHooks(store = globalThis) {
  const state = store[HOOK_RUNNER_STATE];
  const registries = [state?.registry, store[PLUGIN_REGISTRY_STATE]?.activeRegistry].filter(
    (registry) => registry !== null && registry !== undefined,
  );
  if (registries.length === 0) return null;
  const ids = new Set();
  let own = false;
  for (const registry of registries) {
    if (!Array.isArray(registry?.typedHooks)) return null;
    for (const hook of registry.typedHooks) {
      if (hook?.hookName !== "before_tool_call") continue;
      const id = text(hook.pluginId);
      if (!id) return null;
      if (id === PLUGIN_ID) own = true;
      else ids.add(id);
    }
  }
  let live;
  try {
    live = state?.hookRunner?.getHookCount?.("before_tool_call");
  } catch {
    return null;
  }
  if (!Number.isInteger(live)) return null;
  if (ids.size === 0 && live > (own ? 1 : 0)) return null;
  return [...ids].sort();
}

const PLUGIN_ID_FORM = /^[a-z0-9][a-z0-9._/-]{0,63}$/i;

/**
 * The refusal of a call that would run without a card, when what it acts on
 * decides that and another plugin can change it after this plugin decided.
 */
export function rewritableReason(tool, others) {
  const named = (others ?? []).filter((id) => PLUGIN_ID_FORM.test(id));
  const who = named.length > 0 ? `another plugin (${named.join(", ")})` : "another plugin";
  return clip(
    `Refused by Clawtrate's rules plugin without asking anyone: whether ${tool} may run depends on what it acts on, and ${who} can change a call after this plugin decides it, so the call's final form cannot be checked. The call did not run.`,
    DESCRIPTION_MAX,
  );
}

/** A key-order-free text of a call's arguments, or null where it has none. */
function stableText(value) {
  return JSON.stringify(value ?? {}, (_key, v) =>
    isPlainObject(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
}

/** A hash of a call's arguments; null (never equal to another) where they cannot be read. */
export function argumentsHash(params) {
  try {
    const json = stableText(params);
    return typeof json === "string" ? createHash("sha256").update(json).digest("hex") : null;
  } catch {
    return null;
  }
}

const sameArguments = (a, b) => a !== null && a === b;

/** Whether the gateway's config turns this plugin off, as the gateway reads it. */
export function turnedOff(config) {
  const plugins = isPlainObject(config?.plugins) ? config.plugins : {};
  if (plugins.enabled === false) return true;
  if (Array.isArray(plugins.deny) && plugins.deny.includes(PLUGIN_ID)) return true;
  if (
    Array.isArray(plugins.allow) &&
    plugins.allow.length > 0 &&
    !plugins.allow.includes(PLUGIN_ID)
  )
    return true;
  const entry = isPlainObject(plugins.entries) ? plugins.entries[PLUGIN_ID] : undefined;
  return isPlainObject(entry) && entry.enabled === false;
}

export const TURNED_OFF_REASON =
  "Refused by Clawtrate's rules plugin: it was turned off while this run was under way. A run that started under the rules makes no more calls; a run started now is not ruled. The call did not run.";

/** The refusal of a call whose card was answered after its rule changed. */
export function changedReason(now) {
  const what =
    now.decision === "block"
      ? `${scopeWords(now.source.scope)} '${ruleLabel(now.rule)}', version ${now.source.version} (rule ${now.source.ruleId}), now says Never`
      : `${askerWords(now)} now`;
  return clip(
    `Refused by Clawtrate's rules plugin: the rules changed while the card waited, and ${what}. The answer was for the rule the card showed. The call did not run.`,
    DESCRIPTION_MAX,
  );
}

/** The refusal of a call whose tool the gateway's settings came to deny while its card waited. */
export function deniedReason(tool) {
  return clip(
    `Refused by Clawtrate's rules plugin: the gateway's settings now deny ${tool} to this bot, a change made while the card waited. The answer was for a call they allowed. The call did not run.`,
    DESCRIPTION_MAX,
  );
}

/** Whether two decision sources name the same rule at the same version, or the same fallback. */
const sameSource = (a, b) =>
  a?.kind === b?.kind &&
  a?.scope === b?.scope &&
  a?.ruleId === b?.ruleId &&
  a?.version === b?.version &&
  a?.action === b?.action;

/**
 * Keep `value` under `key` as the newest entry. Past the limit the oldest
 * entry is let go; with `peopleFirst`, a person's entry (null) goes first, the
 * oldest of them. A non-null entry let go is handed to `letGo`.
 */
function remember(map, key, value, { peopleFirst = false, letGo } = {}) {
  map.delete(key);
  map.set(key, value);
  if (map.size <= MEMORY_LIMIT) return;
  let drop;
  if (peopleFirst) {
    for (const [k, v] of map) {
      if (v === null) {
        drop = k;
        break;
      }
    }
  }
  if (drop === undefined) drop = map.keys().next().value;
  const mark = map.get(drop);
  map.delete(drop);
  if (mark) letGo?.(drop, mark);
}

/** Who started a run once the plugin let go of a bot's mark with nowhere left to keep it. */
const UNSURE = Object.freeze({ bot: null, unsure: true });

/**
 * The `sessions_send` results that say the run has ended: answered (`ok`) or
 * finished with nothing to say (`no_reply`); both versions give them only once
 * their wait saw the run end. An `error` or a `timeout` does not say so: both
 * versions give `error` for a deadline while the gateway's admission is still
 * pending ("Gateway admission is still pending"), and `timeout` for an error
 * seen while the run is still pending, so the message may yet start a run.
 */
const SEND_ENDED = new Set(["ok", "no_reply"]);

export const LOST_TRACK_LINE =
  "Let go of a bot's message past its memory limit: until the gateway restarts, an Ask in a run that no person's message started is refused.";

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
  /** The other plugins holding a before_tool_call hook (tests give their own). */
  const toolHooks = options.toolHooks ?? (() => otherToolHooks());
  /** The global plugin folders looked in for an untracked Codex plugin (tests give their own). */
  const pluginFolders = options.pluginFolders ?? globalPluginFolders(stateDir);
  let codexSeen = { at: -Infinity, found: false };
  /** Whether an untracked Codex plugin is in a global plugin folder, looked at once a minute. */
  const codexOnDisk = () => {
    if (now() - codexSeen.at >= CODEX_SCAN_MS) {
      codexSeen = { at: now(), found: pluginFolders.some((folder) => codexInFolder(folder)) };
    }
    return codexSeen.found;
  };
  /** Each configured load path's look, kept a minute; a handful of paths, cleared when it grows. */
  const pathSeen = new Map();
  const codexAtLoadPath = (path) => {
    const seen = pathSeen.get(path);
    if (seen && now() - seen.at < CODEX_SCAN_MS) return seen.found;
    if (pathSeen.size >= 64) pathSeen.clear();
    const found = codexAtPath(path);
    pathSeen.set(path, { at: now(), found });
    return found;
  };
  /** "auto" (the default), "full" or "redacted": whether a card names what the call acts on. */
  const cardSetting = isPlainObject(api.pluginConfig) ? api.pluginConfig.cardDetails : undefined;

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

  // ---- who started a run ----

  // The gateway marks a task's user message that came from another task
  // (`provenance.kind: "inter_session"`, with that task's key), and names the
  // run each user message is to start (`idempotencyKey` `<run id>:user`). The
  // plugin reads only those, the message's role and, after a bot's
  // `sessions_send`, the gateway's account of where the message went; never a
  // message's text. It keeps the sending bot's id and that run id.
  //
  // A bot's message in a task:
  //   - makes the run under way there that bot's (the gateway may steer the
  //     message into it, and the plugin cannot tell a steer from a message
  //     that waits);
  //   - waits until the run it names starts, which is that bot's;
  //   - meanwhile, every other run that starts in the task counts as that
  //     bot's too;
  //   - is let go when its run starts, when the sending bot's `sessions_send`
  //     result says the gateway steered it into a run under way or its run has
  //     ended (answered, or finished with no reply), or after MARK_EXPIRY_MS; a run it
  //     names that starts later is still that bot's.
  // A run is noted at its first model call. Past a bound, a mark is let go only
  // after its task and its run are kept among the forgotten, which count as a
  // bot's. Past the forgotten's own bound the plugin can no longer tell an old
  // run from a new one: from then on only a run a person's message names is a
  // person's.
  const { origins, approved, seen } = shared;
  const { forgotten } = origins;

  /** A bot's mark let go with nowhere left to keep it. */
  const loseTrack = () => {
    if (origins.lostTrack) return;
    origins.lostTrack = true;
    logger.warn?.(`${PLUGIN_ID}: ${LOST_TRACK_LINE}`);
  };
  /** When a run was noted, let go past the bound: a run first seen may be one noted before. */
  const notedLetGo = () => {
    origins.notedLost = true;
  };
  /** Keep a bot's mark among the forgotten; past their bound, the oldest is lost. */
  const keepForgotten = (key, mark) =>
    remember(
      forgotten,
      key,
      { bot: mark.bot ?? null, ...(mark.unsure ? { unsure: true } : {}) },
      { letGo: loseTrack },
    );
  /** Who wrote or started what: past the bound a person's note goes first, a bot's among the forgotten. */
  const MARKS = { peopleFirst: true, letGo: keepForgotten };

  /** Who a run or a task stands for: its note, a forgotten bot's mark, or undefined. */
  const noteOf = (map, key) =>
    map.get(key) ?? forgotten.get(key) ?? (map.has(key) ? null : undefined);

  /**
   * A message's origin as the plugin keeps it: another bot's, or, for a
   * message from this same bot's own task (its subagent reporting back, say),
   * whoever that task's run stands for. A source it knows nothing of counts as
   * a bot's.
   */
  function originOf(message, sessionKey) {
    const origin = messageOrigin(message);
    if (!origin) return null;
    if (!origin.bot || origin.bot !== botOfKey(sessionKey)) return { bot: origin.bot };
    const run = origins.current.get(origin.source);
    const known = run !== undefined ? noteOf(origins.runs, run) : undefined;
    const from = known !== undefined ? known : noteOf(origins.sessions, origin.source);
    return from === undefined ? { bot: origin.bot } : from;
  }

  /** A bot's mark let go past a bound: its task and its run still count as that bot's. */
  const forget = (sessionKey, mark) => {
    keepForgotten(sessionKey, mark);
    if (mark.run) keepForgotten(mark.run, mark);
  };

  /** Keep a task's waiting marks; past MEMORY_LIMIT tasks, the oldest task's are forgotten. */
  const keepWaiting = (sessionKey, marks) => {
    origins.pending.delete(sessionKey);
    if (marks.length === 0) return;
    origins.pending.set(sessionKey, marks);
    if (origins.pending.size <= MEMORY_LIMIT) return;
    const [oldest, theirs] = origins.pending.entries().next().value;
    origins.pending.delete(oldest);
    for (const mark of theirs) forget(oldest, mark);
  };

  /**
   * A task's waiting marks, less those written more than MARK_EXPIRY_MS ago
   * (nothing said where they went: dropped, cancelled, or their sender gone);
   * the run each of those names is kept among the forgotten.
   */
  const waitingIn = (sessionKey) => {
    const marks = origins.pending.get(sessionKey) ?? [];
    const cutoff = now() - MARK_EXPIRY_MS;
    const live = marks.filter((mark) => !(mark.at < cutoff));
    if (live.length === marks.length) return marks;
    for (const mark of marks) if (mark.at < cutoff && mark.run) keepForgotten(mark.run, mark);
    keepWaiting(sessionKey, live);
    return live;
  };

  const steerKey = (sessionKey, run) => `${sessionKey}\n${run}`;

  /**
   * A bot's message steered into a task: the plugin may not hold the run that
   * took it (the task's latest run let go past a bound, or not noted yet), so
   * every run of the task noted before now is the bot's, until a run first
   * seen after it starts there. Let go past the bound, the task counts as a
   * bot's for its next run.
   */
  const steeredInto = (sessionKey, bot) =>
    remember(
      origins.steeredTasks,
      sessionKey,
      { bot, at: origins.clock },
      { letGo: keepForgotten },
    );

  /**
   * A task's waiting marks once a bot's message was steered into a run under
   * way: if a person wrote there after its latest run was noted, that run may
   * not be noted yet, so the next run noted is the bot's too.
   */
  const afterSteer = (sessionKey, bot, waiting) => {
    const times = origins.times.get(sessionKey);
    if (times && times.person <= times.noted) return waiting;
    const kept = waiting.length >= PENDING_LIMIT ? waiting.slice(1) : waiting;
    if (kept !== waiting) forget(sessionKey, waiting[0]);
    return [...kept, { bot, run: null, next: true, at: now() }];
  };

  /** When a task's person last wrote and its latest run was noted, on one clock. */
  const stamp = (sessionKey, what) => {
    origins.clock += 1;
    const times = origins.times.get(sessionKey) ?? { person: 0, noted: 0 };
    remember(origins.times, sessionKey, { ...times, [what]: origins.clock });
  };

  function noteMessage(event, ctx) {
    try {
      const message = event?.message;
      if (!isPlainObject(message) || message.role !== "user") return undefined;
      const sessionKey = text(ctx?.sessionKey) ?? text(event?.sessionKey);
      if (!sessionKey) return undefined;
      const origin = originOf(message, sessionKey);
      remember(origins.sessions, sessionKey, origin, MARKS);
      const named = /^(.{1,200}):user$/s.exec(text(message.idempotencyKey) ?? "")?.[1] ?? null;
      if (!origin) {
        stamp(sessionKey, "person");
        // A person's run, positively: a person's own message, or this bot's own task's report
        // from a run that was itself a person's (a routine's hand-off is no person's).
        const source = messageOrigin(message)?.source;
        const fromRun = source === undefined ? undefined : origins.current.get(source);
        if (
          named &&
          (source === undefined || (fromRun !== undefined && origins.people.has(fromRun)))
        ) {
          // When it was written, on `clock`: after a steer, it names a run started since.
          remember(origins.people, named, origins.clock);
        }
        return undefined;
      }
      // The run under way may take it: from now on that run is this bot's.
      const running = origins.current.get(sessionKey);
      if (running !== undefined && !noteOf(origins.runs, running)) {
        remember(origins.runs, running, origin, MARKS);
        // A run a bot's message reached is no person's, whatever named it before.
        origins.people.delete(running);
      }
      const waiting = [...waitingIn(sessionKey)];
      // Its send's result came first (2026.10.6 answers a steer before the run takes it in).
      const early = named ? origins.early.get(steerKey(sessionKey, named)) : undefined;
      if (early) {
        origins.early.delete(steerKey(sessionKey, named));
        // Steered: it starts no run of its own, so it waits only as a steer's does.
        if (early === "steered") {
          keepWaiting(sessionKey, afterSteer(sessionKey, origin.bot, waiting));
          steeredInto(sessionKey, origin.bot);
        }
        // Ended: nothing waits; its run, should it start, is still the bot's.
        else keepForgotten(named, origin);
        return undefined;
      }
      if (waiting.length >= PENDING_LIMIT) forget(sessionKey, waiting.shift());
      keepWaiting(sessionKey, [...waiting, { bot: origin.bot, run: named, at: now() }]);
    } catch {
      // Noting who wrote is never a reason to stop a write.
    }
    return undefined;
  }

  /**
   * Who a run that starts now stands for: the bot whose message names it;
   * else, while a bot's message waits in its task, that bot; else a task
   * whose mark was forgotten, once; else a person, or, once the plugin lost
   * track of a bot's mark, a person only where a person's message names the
   * run. The run noted uses up any mark kept only for the next run.
   */
  function originAtStart(sessionKey, runId) {
    const waiting = waitingIn(sessionKey);
    const own = waiting.find((mark) => mark.run === runId);
    if (own) {
      keepWaiting(
        sessionKey,
        waiting.filter((mark) => mark !== own && !mark.next),
      );
      return { bot: own.bot };
    }
    if (waiting.length > 0) {
      keepWaiting(
        sessionKey,
        waiting.filter((mark) => !mark.next),
      );
      return { bot: waiting[0].bot };
    }
    const lost = forgotten.get(sessionKey);
    if (lost) {
      forgotten.delete(sessionKey);
      return lost;
    }
    return origins.lostTrack && !origins.people.has(runId) ? UNSURE : null;
  }

  function noteRun(event, ctx) {
    const runId = text(ctx?.runId) ?? text(event?.runId);
    const sessionKey = text(ctx?.sessionKey) ?? text(event?.sessionKey);
    if (!runId || !sessionKey || origins.runs.has(runId)) return;
    // A run first seen now: a task runs one run at a time, so the runs going when a bot's
    // message was steered in have ended.
    const known = origins.notedAt.has(runId);
    const steered = known ? undefined : origins.steeredTasks.get(sessionKey);
    if (!known) origins.steeredTasks.delete(sessionKey);
    remember(origins.current, sessionKey, runId);
    stamp(sessionKey, "noted");
    if (!known) remember(origins.notedAt, runId, origins.clock, { letGo: notedLetGo });
    // An expired mark's run goes among the forgotten first; a bot's run let go stays there.
    waitingIn(sessionKey);
    if (forgotten.has(runId)) return;
    let origin = originAtStart(sessionKey, runId);
    // Once the plugin let go of when runs were noted, a run it does not hold may be the one
    // the steer went into, seen again: it stays the bot's, unless a person's message written
    // after the steer names it.
    if (steered && origins.notedLost && !origin?.bot && !(origins.people.get(runId) > steered.at)) {
      origin = { bot: steered.bot };
    }
    // A run that starts as a bot's is no person's, though a person's message named it.
    if (origin) origins.people.delete(runId);
    remember(origins.runs, runId, origin, MARKS);
  }

  /**
   * A bot's `sessions_send` result: where the gateway put the message. Steered
   * into a run under way (which its write made the bot's), it starts no run,
   * so its mark is let go; a person's message written since the task's latest
   * run was noted may have started a run not noted yet, into which the gateway
   * steered it: then the next run noted is the bot's too. Ended (answered, or
   * finished with no reply: SEND_ENDED), its mark is let go and its run,
   * should it start, is still the bot's. Any other result (an error, a
   * timeout) leaves the mark waiting until MARK_EXPIRY_MS. A result that comes before its message is written is
   * kept until it is.
   */
  function noteSent(event) {
    try {
      if (event?.toolName !== "sessions_send" || !isPlainObject(event.result)) return undefined;
      const details = isPlainObject(event.result.details) ? event.result.details : {};
      const sessionKey = text(details.sessionKey);
      const run = text(details.runId);
      const steered = details.status === "accepted" && details.targetDisposition === "steered";
      const ended = SEND_ENDED.has(details.status);
      if (!sessionKey || !run || !(steered || ended)) return undefined;
      const waiting = waitingIn(sessionKey);
      const mark = waiting.find((m) => m.run === run);
      if (!mark) {
        remember(origins.early, steerKey(sessionKey, run), steered ? "steered" : "ended");
        return undefined;
      }
      const rest = waiting.filter((m) => m !== mark);
      if (ended) keepForgotten(run, mark);
      keepWaiting(sessionKey, steered ? afterSteer(sessionKey, mark.bot, rest) : rest);
      if (steered) steeredInto(sessionKey, mark.bot);
    } catch {
      // Noting where a message went is never a reason to fail a call.
    }
    return undefined;
  }

  /**
   * Who started a run, failing toward a bot: its note, where that is a bot's;
   * else a bot's message waiting in its task (the run under way may have taken
   * it, and the plugin may have forgotten that run was under way), or a task
   * whose bot's mark was forgotten; else a person (its note, or no model call
   * seen), but once the plugin lost track of a bot's mark only where a
   * person's message names the run.
   */
  const startedBy = (runId, sessionKey) => {
    // Expired marks go among the forgotten first, so a run one names is found there.
    const waiting = sessionKey ? waitingIn(sessionKey) : [];
    const note = runId ? noteOf(origins.runs, runId) : undefined;
    if (note) return note;
    // A steer the plugin could not tie to a run: every run going then is the bot's.
    const steered = sessionKey ? origins.steeredTasks.get(sessionKey) : undefined;
    if (steered && !(runId && origins.notedAt.get(runId) > steered.at)) return { bot: steered.bot };
    const mark = waiting.find((m) => m.run === runId) ?? waiting[0];
    if (mark) return { bot: mark.bot };
    const lost = sessionKey ? forgotten.get(sessionKey) : undefined;
    if (lost) return lost;
    // Once track is lost, a note from before (a routine's, say) is no proof a person started
    // the run: only a run a person's message names, a person's own hand-off included, is.
    return origins.lostTrack && !(runId && origins.people.has(runId)) ? UNSURE : null;
  };

  const approvalKey = (runId, toolCallId) =>
    runId && toolCallId ? `${runId}\n${toolCallId}` : null;

  // ---- the decision ----

  const callOf = (event, ctx) => {
    const tool = text(event?.toolName) ?? "";
    const agentId = text(ctx?.agentId);
    const toolCallId = text(event?.toolCallId) ?? text(ctx?.toolCallId);
    const base = {
      agentId,
      sessionKey: text(ctx?.sessionKey),
      runId: text(event?.runId) ?? text(ctx?.runId),
      callId: hashCallId(toolCallId),
      tool,
    };
    return { tool, agentId, toolCallId, base };
  };

  /**
   * `mode`: "policy", the trusted policy decides, and its card's answer is
   * looked at again by the hook before the call runs; "hook", the gateway did
   * not run the policy; "again", the hook decides a call another policy changed
   * after this one decided it. Only the policy asks: on the other two, nothing
   * can look at an answer again before the call runs, so an Ask is refused.
   */
  function decide(event, ctx, mode = "hook") {
    shared.lastCallAt = now();
    if (mode !== "again") shared.decidedBy = mode;
    const { tool, agentId, toolCallId, base } = callOf(event, ctx);
    const key = approvalKey(base.runId, toolCallId);
    const args = argumentsHash(event?.params);
    // The hook that runs after the policy leaves a call the policy decided alone, as it
    // was then: the arguments it looked at, and whether it asked.
    const decided = { args, asked: false };
    if (mode === "policy" && key) remember(seen, key, decided);
    // Before anything that could fail: a question is never asked about or blocked.
    if (tool === EXEMPT_TOOL) {
      log.add({ ...base, decision: "none", source: null });
      return undefined;
    }
    const config = currentConfig();
    const view = store.view();
    const rules = view.kind === "lost" ? (view.kept ? "kept" : "lost") : view.kind;
    // Called while turned off: a run that started under the rules (the gateway keeps
    // such a run's hooks on some versions and refuses its calls on others).
    if (turnedOff(config)) {
      log.add({ ...base, rules, decision: "block", source: { kind: "turned-off" } });
      return { block: true, blockReason: TURNED_OFF_REASON };
    }
    const redacted = cardDetails(cardSetting, config).mode === "redacted";
    const target = readTarget(tool, event?.params, workspaceOf(agentId));
    // Lost, with no copy: a saved Never may cover the call, so it is refused without a card
    // (the file is read again at each call, so restoring it ends this at once).
    if (view.enforced === null) {
      log.add({ ...base, rules, decision: "block", source: { kind: "rules-lost" } });
      return { block: true, blockReason: LOST_RULES_REASON };
    }
    const result = evaluate(view.enforced, { agentId, tool, target });
    // A call that would run without a card, where what it acts on decides that: another
    // plugin's hook can change it after this decision, unseen, so it is taken as an Ask
    // and refused, asking no one.
    if (
      (result.decision === "none" || result.decision === "allow") &&
      targetDecides(view.enforced, { agentId, tool })
    ) {
      const others = toolHooks();
      if (others === null || others.length > 0) {
        const asked = log.add({ ...base, rules, decision: "ask", source: { kind: "rewritable" } });
        log.answer(asked, "cancelled");
        return { block: true, blockReason: rewritableReason(tool, others) };
      }
    }
    const id = log.add({ ...base, rules, decision: result.decision, source: result.source });
    if (result.decision === "block") return { block: true, blockReason: blockReason(result) };
    if (result.decision !== "ask") return undefined;
    // A run another bot's message started asks no one: a person never approves what a bot asked for.
    const origin = startedBy(base.runId, base.sessionKey);
    if (origin) {
      log.answer(id, "cancelled");
      return { block: true, blockReason: botRunReason(result, origin) };
    }
    // An answer nothing looks at again before the call runs could outlast a change.
    const uncheckable =
      mode === "hook"
        ? "hook"
        : mode === "again"
          ? "changed"
          : codexHarnessMayRun(config, codexOnDisk(), codexAtLoadPath)
            ? "codex"
            : null;
    if (uncheckable) {
      log.answer(id, "cancelled");
      return { block: true, blockReason: uncheckableReason(result, uncheckable) };
    }
    decided.asked = true;
    return {
      requireApproval: {
        ...approvalText(result, tool, target, redacted),
        severity: "warning",
        timeoutMs: APPROVAL_TIMEOUT_MS,
        allowedDecisions: [...ALLOWED_DECISIONS],
        // The gateway stamps a hook's card with its plugin; a trusted policy's card names it itself.
        pluginId: PLUGIN_ID,
        // Only the decision word is kept; nothing standing is made from it.
        onResolution: (decision) => {
          log.answer(id, ANSWERS.has(decision) ? decision : "unknown");
          // The rules, and the call's arguments, are looked at again before the approved call runs.
          if (key && decision === "allow-once")
            remember(approved, key, { source: result.source, args });
        },
      },
    };
  }

  /**
   * After a card's Allow once, before the call runs: the answer was for the
   * call the card showed, under the rule it showed. A call whose arguments
   * changed since is refused. The call runs when the rules still ask by that
   * rule at that version, or would now run it without asking; otherwise it is
   * refused, naming what the rules say now.
   */
  function recheck(event, ctx, key) {
    const { tool, agentId, base } = callOf(event, ctx);
    const shown = approved.get(key);
    approved.delete(key);
    const view = store.view();
    const rules = view.kind === "lost" ? (view.kept ? "kept" : "lost") : view.kind;
    const config = currentConfig();
    if (turnedOff(config)) {
      log.add({ ...base, rules, decision: "block", source: { kind: "turned-off" } });
      return { block: true, blockReason: TURNED_OFF_REASON };
    }
    // A deny of this tool for this bot, saved while the card waited, wins over the answer.
    if (explicitlyDenied(config, configuredAgents(config).get(agentId) ?? {}, tool)) {
      log.add({ ...base, rules, decision: "block", source: { kind: "gateway-deny" } });
      return { block: true, blockReason: deniedReason(tool) };
    }
    // Another plugin's policy rewrote the call after this one asked about it.
    if (!sameArguments(shown.args, argumentsHash(event?.params))) {
      log.add({ ...base, rules, decision: "block", source: { kind: "arguments-changed" } });
      return { block: true, blockReason: CHANGED_ARGUMENTS_REASON };
    }
    // Lost while the card waited, with no copy: the rules the answer was for cannot be read.
    if (view.enforced === null) {
      log.add({ ...base, rules, decision: "block", source: { kind: "rules-lost" } });
      return { block: true, blockReason: LOST_RULES_REASON };
    }
    const result = evaluate(view.enforced, {
      agentId,
      tool,
      target: readTarget(tool, event?.params, workspaceOf(agentId)),
    });
    if (result.decision === "none" || result.decision === "allow") return undefined;
    if (result.decision === "ask" && sameSource(result.source, shown.source)) return undefined;
    log.add({ ...base, rules, decision: "block", source: result.source });
    return { block: true, blockReason: changedReason(result) };
  }

  /**
   * The ordinary hook: after the policy's card was answered Allow once, the
   * call is looked at again; a call the policy decided without asking is left
   * alone while its arguments are those the policy looked at, and decided
   * again when another policy changed them; any other call (one the policy
   * never saw: the gateway has no trusted policies, or did not take this one;
   * or one the policy asked about whose answer the plugin no longer holds),
   * the hook decides itself. Deciding in the hook, an Ask is refused.
   */
  function afterPolicy(event, ctx) {
    const { base, toolCallId } = callOf(event, ctx);
    const key = approvalKey(base.runId, toolCallId);
    if (key && approved.has(key)) {
      seen.delete(key);
      return recheck(event, ctx, key);
    }
    const decided = key ? seen.get(key) : undefined;
    if (decided === undefined) return decide(event, ctx);
    seen.delete(key);
    if (!decided.asked && sameArguments(decided.args, argumentsHash(event?.params))) {
      return undefined;
    }
    return decide(event, ctx, "again");
  }

  // Every tool: "Ask when nothing else decides" can apply to any of them. The
  // decision is a trusted tool policy, which the gateway runs before ordinary
  // hooks and before asking; the ordinary hook looks at the rules again after
  // a card is answered, and decides what the policy did not see. None of it
  // needs conversation access.
  let hookRegistered = false;
  // A gateway that does not take the policy does not throw; where the policy
  // never runs, the hook decides every call (`status.hook.decidedBy: "hook"`).
  if (typeof api.registerTrustedToolPolicy === "function") {
    api.registerTrustedToolPolicy({
      id: POLICY_ID,
      description: "Clawtrate's rules: run without asking, ask first, or never",
      evaluate: (event, ctx) => decide(event, ctx, "policy"),
    });
    hookRegistered = true;
  }
  if (typeof api.on === "function") {
    api.on("before_tool_call", afterPolicy);
    api.on("before_message_write", noteMessage);
    api.on("model_call_started", noteRun);
    api.on("after_tool_call", noteSent);
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
              : "refuse-every-call",
      hook: {
        registered,
        // When the hook last saw a call; it says nothing about the rules.
        lastCallAt: shared.lastCallAt,
        // What decided that call: the trusted policy, or the hook where the gateway did not
        // run the policy; null before any call.
        decidedBy: shared.decidedBy,
        // The other plugins holding a before_tool_call hook, which can change a call after
        // this plugin decides it; null where the plugin cannot read the gateway's registry.
        otherToolHooks: toolHooks(),
      },
      matches: view.enforced ? matchesOf(view.enforced) : null,
      cardDetails: cardDetails(cardSetting, currentConfig()),
      // Whether the decision record is being kept on disk, and, apart from
      // that, the records set aside as oversized that are still beside it.
      decisions: {
        ...(log.problem ? { state: "failing", reason: log.problem } : { state: "kept" }),
        setAside: log.listSetAside(),
      },
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
      const value = params[key];
      if (value !== undefined && (text(value) === null || value.length > FILTER_MAX)) {
        throw new RequestError(
          "INVALID_REQUEST",
          "bad_request",
          `${key} must be text of at most ${FILTER_MAX} characters`,
        );
      }
    }
    if (params.before !== undefined && !Number.isSafeInteger(params.before)) {
      throw new RequestError("INVALID_REQUEST", "bad_request", "before must be a time in ms");
    }
    if (
      params.cursor !== undefined &&
      !(typeof params.cursor === "string" && CURSOR.test(params.cursor))
    ) {
      throw new RequestError(
        "INVALID_REQUEST",
        "bad_request",
        "cursor must be a page's nextCursor as given",
      );
    }
    const limit = params.limit ?? LIST_LIMIT.default;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIST_LIMIT.max) {
      throw new RequestError(
        "INVALID_REQUEST",
        "bad_request",
        `limit must be 1 to ${LIST_LIMIT.max}`,
      );
    }
    const { records, hasMore, nextCursor } = log.list({ ...params, limit });
    return {
      records,
      hasMore,
      ...(nextCursor ? { nextCursor } : {}),
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
  const timers = [];
  const tick = () => {
    // Expired records leave the disk on an idle gateway too, and a change to
    // the rules file is noticed (and logged) without waiting for a call.
    log.prune();
    store.refresh();
  };
  if (typeof api.registerService === "function") {
    api.registerService({
      id: `${PLUGIN_ID}-rules`,
      start(ctx) {
        tick();
        const timer = setInterval(tick, options.pruneIntervalMs ?? PRUNE_INTERVAL_MS);
        // The timer never keeps the gateway's process alive.
        timer.unref?.();
        timers.push(timer);
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
        const where = { storeDir: dir, workspaceOf: (agentId) => workspaceOf(agentId)() };
        for (const line of exposureWarnings(currentConfig(), where))
          logger.warn?.(`${PLUGIN_ID}: ${line}`);
      },
      stop() {
        shared.active.delete(registration);
        for (const timer of timers.splice(0)) clearInterval(timer);
      },
    });
  }

  return { shared, dir, decide, timers };
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
