// What a bot must be denied for these rules to mean anything, checked in the
// gateway's config where the plugin can read it, and in where each bot's
// workspace resolves to; the plugin writes what it finds to the gateway's
// log when it starts, as a warning, never as a guarantee.
//
// A bot can change or remove the rules when it can:
//   - manage the gateway or its plugins (the `gateway` and `plugins` tools);
//   - run commands on the gateway's machine outside a sandbox (`exec`,
//     `process`): a command runs as the gateway's user and can edit the
//     gateway's config and this plugin's store;
//   - write files outside its workspace (`write`, `edit`, `apply_patch`
//     without `tools.fs.workspaceOnly`): the store is in the gateway's state
//     folder; or write files in a workspace that holds the store's folder.
//
// The check is conservative: a tool counts as denied only when a deny list
// names it, by name, a group of OpenClaw 2026.10.6 that holds it, `*` or a
// pattern matching it, or when a non-empty allow list leaves it out (an
// empty one restricts nothing, and `write` brings `apply_patch`, as the
// gateway reads them). Anything it cannot tell (a tool profile, a group it
// does not know) counts as offered. Commands run elsewhere only on a node,
// or in a sandbox for every task when the bot does not name the gateway's
// host and elevated exec cannot take them out of it. A warning is a
// warning: it protects nothing.

import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** The groups of OpenClaw 2026.10.6 (tool-catalog) holding the tools checked here. */
const GROUPS = {
  "group:openclaw": ["gateway", "plugins"],
  "group:automation": ["gateway", "plugins"],
  "group:runtime": ["exec", "process"],
  "group:fs": ["write", "edit", "apply_patch"],
};
const ALIASES = new Map([
  ["bash", "exec"],
  ["apply-patch", "apply_patch"],
]);

const rec = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
const list = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string") : null);

/** The tools of a group this check knows, by its own names only (never `constructor`). */
const groupOf = (name) => (Object.hasOwn(GROUPS, name) ? GROUPS[name] : undefined);

function covers(entry, tool) {
  const name = ALIASES.get(entry.trim().toLowerCase()) ?? entry.trim().toLowerCase();
  if (name === "*" || name === tool) return true;
  if (groupOf(name)?.includes(tool)) return true;
  if (name.includes("*")) {
    const pattern = new RegExp(
      `^${name
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")}$`,
    );
    return pattern.test(tool);
  }
  return false;
}

/** The bots the config declares: `agents.entries` and `agents.list`. */
export function configuredAgents(config) {
  const agents = rec(rec(config).agents);
  const out = new Map();
  for (const [id, entry] of Object.entries(rec(agents.entries))) out.set(id, rec(entry));
  for (const entry of Array.isArray(agents.list) ? agents.list : []) {
    if (typeof rec(entry).id === "string") out.set(entry.id, rec(entry));
  }
  const hasRoster = ["entries", "list"].some(
    (key) => Object.hasOwn(agents, key) && agents[key] !== undefined,
  );
  if (!hasRoster) out.set("main", {});
  return out;
}

/** Whether the config surely keeps `tool` from `agent`: denied, or left out of an allow list. */
export function surelyDenied(config, agent, tool) {
  const global = rec(rec(config).tools);
  const own = rec(agent.tools);
  for (const deny of [list(global.deny), list(own.deny)]) {
    if (deny?.some((entry) => covers(entry, tool))) return true;
  }
  for (const allow of [list(global.allow), list(own.allow)]) {
    // An empty allow list restricts nothing, as the gateway reads it.
    if (!allow || allow.length === 0) continue;
    // A group this check does not know may hold the tool; `write` brings apply_patch.
    const unknownGroup = (entry) => entry.startsWith("group:") && !groupOf(entry);
    const brings = (entry) => tool === "apply_patch" && covers(entry, "write");
    if (!allow.some((entry) => covers(entry, tool) || unknownGroup(entry) || brings(entry))) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a sandboxed bot's command could still run on the gateway's host
 * through elevated exec (OpenClaw 2026.10.6, `resolveElevatedPermissions`):
 * on unless `tools.elevated.enabled` is false for the gateway or the bot, and
 * open to a sender listed in `tools.elevated.allowFrom` (any non-empty list)
 * or, with no list, to one a configured channel's own fallback list names.
 */
function elevatedOpen(config, agent) {
  const global = rec(rec(rec(config).tools).elevated);
  const own = rec(rec(agent.tools).elevated);
  if (global.enabled === false || own.enabled === false) return false;
  const anySender = (allowFrom) =>
    Object.values(rec(allowFrom)).some((entries) => Array.isArray(entries) && entries.length > 0);
  const channels = Object.keys(rec(rec(config).channels)).length > 0;
  return anySender(global.allowFrom) || channels;
}

const sandboxedAll = (config, agent) =>
  (rec(agent.sandbox).mode ?? rec(rec(rec(config).agents).defaults?.sandbox).mode) === "all";

/**
 * A path as the filesystem resolves it. One that does not exist yet (a store
 * not saved yet) is its nearest existing folder, resolved, with the missing
 * names after it, so a link above it is followed all the same.
 */
function real(path) {
  const missing = [];
  let at = resolve(path);
  for (;;) {
    try {
      return join(realpathSync.native(at), ...missing);
    } catch {
      const parent = dirname(at);
      if (parent === at) return resolve(path);
      missing.unshift(basename(at));
      at = parent;
    }
  }
}

/** Whether a folder is `inside`'s own or one below it, compared as resolved paths. */
function holds(folder, inside) {
  const rel = relative(real(folder), real(inside));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Per bot, what lets it change the rules, as `{agentId, reasons}`; reasons
 * among "manages-gateway", "commands-on-gateway-host", "files-outside-workspace"
 * and "store-in-workspace". `where` gives the rules store's folder and, per
 * bot, the names its workspace goes by; without it the last is not checked.
 */
export function exposures(config, where = {}) {
  const global = rec(rec(config).tools);
  const out = [];
  for (const [agentId, agent] of configuredAgents(config)) {
    const reasons = [];
    const own = rec(agent.tools);
    if (!surelyDenied(config, agent, "gateway") || !surelyDenied(config, agent, "plugins")) {
      reasons.push("manages-gateway");
    }
    const exec = { ...rec(global.exec), ...rec(own.exec) };
    const commandsOff =
      exec.mode === "deny" || (exec.mode === undefined && exec.security === "deny");
    // A sandbox keeps commands off the gateway's machine unless the bot names
    // that host, or elevated exec can take them out of the sandbox.
    const elsewhere =
      exec.host === "node" ||
      (sandboxedAll(config, agent) && exec.host !== "gateway" && !elevatedOpen(config, agent));
    const shell = ["exec", "process"].some((tool) => !surelyDenied(config, agent, tool));
    if (shell && !commandsOff && !elsewhere) reasons.push("commands-on-gateway-host");
    const fs = { ...rec(global.fs), ...rec(own.fs) };
    const writes = ["write", "edit", "apply_patch"].some(
      (tool) => !surelyDenied(config, agent, tool),
    );
    if (writes && fs.workspaceOnly !== true && !sandboxedAll(config, agent)) {
      reasons.push("files-outside-workspace");
    }
    // workspaceOnly keeps writes in the workspace, which protects nothing if it holds the store.
    const { storeDir, workspaceOf } = where;
    if (writes && storeDir && workspaceOf?.(agentId).some((name) => holds(name, storeDir))) {
      reasons.push("store-in-workspace");
    }
    if (reasons.length > 0) out.push({ agentId, reasons });
  }
  return out;
}

const WORDS = {
  "manages-gateway":
    "may use the gateway or plugins tool, which can change or remove the rules plugin and its rules",
  "commands-on-gateway-host":
    "may run commands on the gateway's machine outside a sandbox, as the gateway's user, which can edit the gateway's config and the rules plugin's store",
  "files-outside-workspace":
    "may write files outside its workspace, where the rules plugin's store is",
  "store-in-workspace": "may write files in its workspace, which holds the rules plugin's store",
};

const REMEDY = {
  "manages-gateway": "Deny it the gateway and plugins tools.",
  "commands-on-gateway-host":
    "Deny it exec and process, or run its commands on another machine or in a sandbox.",
  "files-outside-workspace":
    "Set tools.fs.workspaceOnly to true, or deny it write, edit and apply_patch.",
  "store-in-workspace":
    "Choose a workspace that does not contain the rules store, or deny it write, edit and apply_patch.",
};

/** One warning per bot and reason, in words. */
export function exposureWarnings(config, where = {}) {
  return exposures(config, where).flatMap(({ agentId, reasons }) =>
    reasons.map(
      (reason) =>
        `Bot ${agentId} ${WORDS[reason]}, so Clawtrate's rules are advice for it. ${REMEDY[reason]}`,
    ),
  );
}
