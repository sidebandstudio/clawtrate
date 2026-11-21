// What a bot may do (docs/design/controls.md sections 2 to 5): the facts the
// gateway and Clawtrate's rules plugin give about one bot's tools, read as
// lines in plain words, and the writes a line's choice makes. Pure: the
// engine (`permissions-engine.ts`) does the reading and writing.
//
// Four facts are kept apart: what the bot's latest task was offered
// (`tools.effective`), the gateway's settings for every bot, the bot's own
// settings (`config.get`), and the rules plugin's rules (`get`), which hold
// only while the plugin runs. A line's value is its strongest truthful word
// from those facts; nothing here predicts what will happen to one call.

import { asRecord, type RawRecord } from "./mapping.ts";

/** The rules plugin (`plugins/clawtrate-tool-rules`). */
export const RULES_PLUGIN = "clawtrate-tool-rules";
export const RULES_STATUS_METHOD = `${RULES_PLUGIN}.status`;
export const RULES_GET_METHOD = `${RULES_PLUGIN}.get`;
export const RULES_SET_METHOD = `${RULES_PLUGIN}.set`;
/** The oldest plugin version whose rules this page reads and writes. */
export const RULES_NEEDED_VERSION = "1.0.0";
/** The plugin's scope for every bot. */
export const EVERY_BOT = "*";

/** Tools read from the gateway's catalog for one view; past it the rest are not read. */
export const MAX_CATALOG_TOOLS = 256;
/** Tool servers read from the config for one view. */
export const MAX_TOOL_SERVERS = 32;
/** Entries read from one allow or deny list. */
export const MAX_LIST_ENTRIES = 256;
/** A tool name, a list entry or a server name: longer ones are not read. */
export const MAX_RULE_NAME_CHARS = 128;
/** Lines one view holds. */
export const MAX_LINES = 160;
/** Exceptions one line holds. */
export const MAX_EXCEPTIONS = 8;
/** A rule's pattern as a line shows it; the rule itself is never cut (writes read it again). */
export const MAX_SHOWN_PATTERN_CHARS = 200;
/** Rules of one scope the plugin may hold (20 allow, 20 ask, 50 never). */
export const MAX_SCOPE_RULES = 90;
/** Tools one rule names (the plugin's limit). */
export const MAX_RULE_TOOLS = 16;

// The facts --------------------------------------------------------------------------

export type RuleAction = "allow" | "ask" | "never";

/** A rule of the plugin as this page uses it: no note, the pattern whole. */
export type PluginRule = {
  id: string;
  version: number;
  action: RuleAction;
  tools: string[];
  target: { kind: string; pattern: string } | null;
  /** Whether the rule carries this page's own note (`PAGE_RULE_NOTE`): a rule this page wrote. */
  pageNote?: boolean;
};

/** The note this page writes on each rule it creates; a rule without it is managed elsewhere. */
export const PAGE_RULE_NOTE = "Created in Clawtrate per-bot permissions";

export type RulesScope = { version: number; fallback: boolean; rules: PluginRule[] };

/** What the rules plugin's own `status` said, or why there is none. */
export type RulesPluginStatus =
  /** Its methods are not in the gateway's method list. */
  | { kind: "unavailable" }
  /** No answer yet in this session. */
  | { kind: "unchecked" }
  /** `status` failed, or reports its hook not registered or its rules not enforced. */
  /** `answered`: its status said it isn't enforcing; else its status couldn't be read. */
  | { kind: "stopped"; reason: string; answered: boolean }
  /** `status` reports a version older than this page needs. */
  | { kind: "old"; version: string }
  | {
      kind: "running";
      version: string;
      answeredAt: number;
      lastCallAt: number | null;
      /** The rules file: none saved, read, or lost (the plugin keeps a copy, or asks every call). */
      rules: "none" | "read" | "lost";
      lostReason: string | null;
      keptCopyReadAt: number | null;
      enforcing: "rules" | "kept-copy" | "ask-every-call" | "nothing";
    };

/** Where the rules a view shows come from. */
export type RulesSource =
  /** Read from the running plugin now. */
  | { from: "now"; readAt: number }
  /** This client's own last read, while the plugin does not answer. */
  | { from: "kept"; readAt: number }
  /** Not known: the plugin never answered this client, or it refuses reads now. */
  | { from: null; readAt: null };

export type ExecPolicy = "deny" | "allowlist" | "ask" | "auto" | "full" | "legacy";

/** The gateway's tool lists this page reads: for every bot, and the bot's own. */
export type ToolList = "every-allow" | "every-deny" | "bot-allow" | "bot-deny";

/** The settings `config.get` gives, as far as this page reads them. */
export type ToolSettings = {
  /** The gateway's lists for every bot; `allow` is null when it sets none. */
  everyAllow: string[] | null;
  everyDeny: string[];
  everyProfile: string | null;
  everyExec: ExecPolicy | null;
  /** The bot's own lists and command policy. */
  botAllow: string[] | null;
  botDeny: string[];
  botExec: ExecPolicy | null;
  /** The bot's own exec block names `security` or `ask`, the legacy pair. */
  botExecLegacy: boolean;
  /** Tool servers the gateway configures, by name. */
  servers: string[];
  /**
   * The lists not read whole: more than `MAX_LIST_ENTRIES` entries, an entry
   * that isn't a name this page reads, or one given twice. A list cut here is
   * never written back, since its replacement would drop what was cut.
   */
  cut: ToolList[];
  /** Settings present that can remove tools and that this page doesn't evaluate, by path. */
  unread: string[];
  /**
   * Whether the gateway reports it is using the stored revision read here
   * (`appliedConfigHash` against `configRevisionHash`); unknown when it doesn't say.
   */
  applied: "yes" | "no" | "unknown";
  hash: string | null;
};

export type CatalogTool = { id: string; group: string; groupLabel: string; plugin: string | null };

/**
 * A tool server the listing names: its name as configured, and the ids the
 * gateway gave the tools it listed for it. The listing names no namespace
 * that covers all of a server's tools and no other server's (a normalized
 * server name can itself hold `__`), so these ids are facts to show, never a
 * wildcard to write.
 */
export type ListedServer = { name: string; tools: string[] };

/** What the bot's latest task was offered (`tools.effective`). */
export type Offered =
  | { status: "listed"; taskKey: string; available: string[]; servers: ListedServer[] }
  | { status: "no-task" }
  | { status: "failed"; reason: string };

// Reading the gateway's answers ------------------------------------------------------

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_RULE_NAME_CHARS
    ? value
    : null;

function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const each of value) {
    const name = str(each);
    if (name && !out.includes(name)) out.push(name);
    if (out.length >= MAX_LIST_ENTRIES) break;
  }
  return out;
}

/** Tool settings that can remove tools and that this page doesn't evaluate. */
const UNREAD_KEYS = ["profile", "byProvider", "alsoAllow", "sandbox"] as const;

/** Whether `names` read a list whole: every entry a name, once, within the bound. */
const readWhole = (value: unknown) => !Array.isArray(value) || names(value).length === value.length;

function execPolicy(value: unknown): { policy: ExecPolicy | null; legacy: boolean } {
  const exec = asRecord(value);
  if (!exec) return { policy: null, legacy: false };
  const mode = exec.mode;
  if (
    mode === "deny" ||
    mode === "allowlist" ||
    mode === "ask" ||
    mode === "auto" ||
    mode === "full"
  )
    return { policy: mode, legacy: false };
  const legacy = exec.security !== undefined || exec.ask !== undefined;
  return { policy: legacy ? "legacy" : null, legacy };
}

const UNREADABLE_SETTINGS = "The gateway's settings couldn't be read.";
const UNREADABLE_CATALOG = "The gateway's tool catalog couldn't be read.";
/** What a rules plugin's `get` answer that can't be read whole is said as. */
export const UNREADABLE_RULES = "The rules plugin's rules couldn't be read.";

/** The tool settings of `config.get` for one bot. Nothing else of the config is kept. */
export function readToolSettings(answer: unknown, botId: string): ToolSettings {
  const root = asRecord(answer);
  const config = asRecord(root?.config);
  // A malformed answer is no settings at all, never settings that deny nothing.
  if (!config || typeof root?.hash !== "string") throw new Error(UNREADABLE_SETTINGS);
  const tools = asRecord(config.tools);
  const entry = asRecord(asRecord(asRecord(config.agents)?.entries)?.[botId]);
  const own = asRecord(entry?.tools);
  for (const each of [tools, own])
    for (const list of [each?.allow, each?.deny])
      if (list !== undefined && !Array.isArray(list)) throw new Error(UNREADABLE_SETTINGS);
  const every = execPolicy(tools?.exec);
  const bot = execPolicy(own?.exec);
  const servers = Object.keys(asRecord(asRecord(config?.mcp)?.servers) ?? {})
    .filter((name) => str(name) !== null)
    .slice(0, MAX_TOOL_SERVERS);
  return {
    everyAllow: Array.isArray(tools?.allow) && tools.allow.length > 0 ? names(tools.allow) : null,
    everyDeny: names(tools?.deny),
    everyProfile: str(tools?.profile),
    everyExec: every.policy,
    botAllow: Array.isArray(own?.allow) && own.allow.length > 0 ? names(own.allow) : null,
    botDeny: names(own?.deny),
    botExec: bot.policy,
    botExecLegacy: bot.legacy,
    servers,
    unread: (
      [
        ["tools", tools],
        [`agents.entries.${botId}.tools`, own],
      ] as const
    ).flatMap(([at, each]) =>
      UNREAD_KEYS.filter((key) => each?.[key] !== undefined).map((key) => `${at}.${key}`),
    ),
    cut: (
      [
        ["every-allow", tools?.allow],
        ["every-deny", tools?.deny],
        ["bot-allow", own?.allow],
        ["bot-deny", own?.deny],
      ] as const
    )
      .filter(([, list]) => !readWhole(list))
      .map(([name]) => name),
    applied:
      typeof root?.configRevisionHash !== "string" || typeof root?.appliedConfigHash !== "string"
        ? "unknown"
        : root.appliedConfigHash === root.configRevisionHash
          ? "yes"
          : "no",
    hash: typeof root?.hash === "string" ? root.hash : null,
  };
}

/** The gateway's whole tool catalog (`tools.catalog`): every tool, with its group and plugin. */
export function readToolCatalog(answer: unknown): CatalogTool[] {
  const out: CatalogTool[] = [];
  const groups = asRecord(answer)?.groups;
  if (!Array.isArray(groups)) throw new Error(UNREADABLE_CATALOG);
  for (const group of groups) {
    const g = asRecord(group);
    const groupId = str(g?.id) ?? "";
    const label = str(g?.label) ?? groupId;
    const tools = g?.tools;
    if (!g || !Array.isArray(tools)) throw new Error(UNREADABLE_CATALOG);
    for (const tool of tools) {
      const t = asRecord(tool);
      const id = str(t?.id);
      if (!id) throw new Error(UNREADABLE_CATALOG);
      if (out.some((each) => each.id === id)) continue;
      const plugin = t?.source === "plugin" ? (str(t.pluginId) ?? str(g?.pluginId)) : null;
      out.push({ id, group: groupId, groupLabel: label, plugin });
      if (out.length >= MAX_CATALOG_TOOLS) return out;
    }
  }
  return out;
}

/** What `tools.effective` says the task is offered: its available tools and its tool servers. */
export function readOffered(answer: unknown, taskKey: string): Offered {
  const root = asRecord(answer);
  const available: string[] = [];
  const byServer = new Map<string, string[]>();
  const access = asRecord(root?.toolAccess)?.tools;
  // A listing that can't be read lists nothing: it is a failed read, not an empty one.
  if (!Array.isArray(access) && !Array.isArray(root?.groups))
    return { status: "failed", reason: "its answer couldn't be read" };
  for (const each of Array.isArray(access) ? access : []) {
    const t = asRecord(each);
    const id = str(t?.id);
    if (id && t?.status === "available" && available.length < MAX_CATALOG_TOOLS) available.push(id);
  }
  for (const group of Array.isArray(root?.groups) ? root.groups : []) {
    for (const each of (asRecord(group)?.tools as unknown[] | undefined) ?? []) {
      const t = asRecord(each);
      const id = str(t?.id);
      if (!id || t?.deniedBySession === true) continue;
      if (t?.source === "mcp") {
        const server = str(t.mcpServer);
        if (server && (byServer.has(server) || byServer.size < MAX_TOOL_SERVERS))
          byServer.set(server, [...(byServer.get(server) ?? []), id].slice(0, MAX_CATALOG_TOOLS));
      }
      if (!available.includes(id) && available.length < MAX_CATALOG_TOOLS) available.push(id);
    }
  }
  const servers = [...byServer].map(([name, tools]): ListedServer => ({ name, tools }));
  return { status: "listed", taskKey, available, servers };
}

function version(value: unknown): string | null {
  return typeof value === "string" && /^\d+\.\d+\.\d+/.test(value) && value.length <= 32
    ? value
    : null;
}

/** Whether `have` is `need` or newer, comparing the three numbers. */
export function versionAtLeast(have: string, need: string): boolean {
  const a = have.split(/[.-]/).slice(0, 3).map(Number);
  const b = need.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;
const time = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** The plugin's `status` answer, exactly as it states it. */
export function readStatus(answer: unknown, answeredAt: number): RulesPluginStatus {
  const s = asRecord(answer);
  const v = version(s?.version);
  if (!s || s.plugin !== RULES_PLUGIN || !v)
    return { kind: "stopped", reason: "its status answer couldn't be read", answered: false };
  if (!versionAtLeast(v, RULES_NEEDED_VERSION)) return { kind: "old", version: v };
  const hook = asRecord(s.hook);
  const enforcing = s.enforcing;
  if (hook?.registered !== true || enforcing === "not-enforced")
    return {
      kind: "stopped",
      reason:
        hook?.registered !== true
          ? "It reports its hook not registered."
          : "It reports its rules not enforced.",
      answered: true,
    };
  const rules = asRecord(s.rules);
  const state = rules?.state === "read" || rules?.state === "lost" ? rules.state : "none";
  return {
    kind: "running",
    version: v,
    answeredAt,
    lastCallAt: time(hook.lastCallAt),
    rules: state,
    lostReason:
      state === "lost" && typeof rules?.reason === "string" ? cut(rules.reason, 200) : null,
    keptCopyReadAt: state === "lost" ? time(rules?.keptCopyReadAt) : null,
    enforcing:
      enforcing === "rules" ||
      enforcing === "kept-copy" ||
      enforcing === "ask-every-call" ||
      enforcing === "nothing"
        ? enforcing
        : "nothing",
  };
}

function readRule(value: unknown): PluginRule | null {
  const r = asRecord(value);
  const id = typeof r?.id === "string" && r.id.length <= 64 ? r.id : null;
  const action = r?.action;
  if (!id || (action !== "allow" && action !== "ask" && action !== "never")) return null;
  const tools = names(r?.tools).slice(0, MAX_RULE_TOOLS);
  if (tools.length === 0) return null;
  const target = asRecord(r?.target);
  const pattern = typeof target?.pattern === "string" ? target.pattern : null;
  return {
    id,
    version: typeof r?.version === "number" ? r.version : 0,
    action,
    tools,
    pageNote: r?.note === PAGE_RULE_NOTE,
    target:
      target && pattern !== null && pattern.length <= 1_000
        ? { kind: typeof target.kind === "string" ? cut(target.kind, 16) : "path", pattern }
        : null,
  };
}

/**
 * One scope of the plugin's `get` answer, or null when it holds none. An
 * answer that can't be read whole throws: a rule left out could be a Never.
 */
export function readScope(answer: unknown, scope: string): RulesScope | null {
  const scopes = asRecord(asRecord(answer)?.scopes);
  if (!scopes) throw new Error(UNREADABLE_RULES);
  if (scopes[scope] === undefined) return null;
  const s = asRecord(scopes[scope]);
  if (!s || !Array.isArray(s.rules) || typeof s.version !== "number")
    throw new Error(UNREADABLE_RULES);
  const rules: PluginRule[] = [];
  for (const each of s.rules) {
    const rule = readRule(each);
    if (!rule) throw new Error(UNREADABLE_RULES);
    rules.push(rule);
    if (rules.length >= MAX_SCOPE_RULES) break;
  }
  return {
    version: typeof s.version === "number" ? s.version : 0,
    fallback: s.fallback === true,
    rules,
  };
}

/** A tool name or a rule id as the plugin writes them: no character JSON escapes. */
const PLAIN_NAME = /^[A-Za-z0-9_.*:-]{1,128}$/;
/** The longest pattern a kept copy holds, in JSON characters. */
export const MAX_KEPT_PATTERN_JSON = 402;
/** The most JSON characters one kept rule takes: its id, version, action, 16 tools and target. */
export const KEPT_RULE_CHARS = 2_700;
/** The most JSON characters one kept scope takes: its version, fallback and rules. */
export const KEPT_SCOPE_CHARS = MAX_SCOPE_RULES * (KEPT_RULE_CHARS + 1) + 120;

/** A scope as this client keeps its last read: names checked, patterns cut for display. */
export type KeptScope = { scope: RulesScope | null; readAt: number; incomplete: boolean };

/**
 * The copy of a scope this client keeps while the plugin may stop answering.
 * A rule whose names are not plain is left out, and the copy says so
 * (`incomplete`): a page then names no line from it.
 */
export function keptScope(scope: RulesScope | null, readAt: number): KeptScope {
  if (!scope) return { scope: null, readAt, incomplete: false };
  let incomplete = false;
  const rules: PluginRule[] = [];
  for (const rule of scope.rules) {
    if (!PLAIN_NAME.test(rule.id) || !rule.tools.every((t) => PLAIN_NAME.test(t))) {
      incomplete = true;
      continue;
    }
    let target = rule.target;
    if (target) {
      let pattern = target.pattern.slice(0, MAX_SHOWN_PATTERN_CHARS);
      while (JSON.stringify(pattern).length > MAX_KEPT_PATTERN_JSON) pattern = pattern.slice(0, -1);
      target = { kind: PLAIN_NAME.test(target.kind) ? target.kind.slice(0, 16) : "path", pattern };
    }
    rules.push({
      id: rule.id.slice(0, 64),
      version: rule.version,
      action: rule.action,
      tools: rule.tools.slice(0, MAX_RULE_TOOLS),
      target,
      pageNote: rule.pageNote === true,
    });
  }
  return {
    scope: { version: scope.version, fallback: scope.fallback, rules },
    readAt,
    incomplete,
  };
}

// Matching the gateway's lists ---------------------------------------------------------

/** The gateway's own spellings of a tool name (the plugin's README lists the same). */
const ALIASES: Record<string, string> = {
  bash: "exec",
  "apply-patch": "apply_patch",
  cron: "automations",
};
const canonical = (name: string) => ALIASES[name.toLowerCase()] ?? name.toLowerCase();

function globMatches(pattern: string, name: string): boolean {
  if (!pattern.includes("*")) return canonical(pattern) === canonical(name);
  const re = new RegExp(
    `^${pattern
      .toLowerCase()
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")}$`,
  );
  return re.test(name.toLowerCase());
}

/**
 * Whether a list entry names a tool: by name, an alias, a `*` pattern, or a
 * `group:<id>` of the gateway's catalog. A tool server's whole set is asked
 * for as `<server>__*`, which only an entry covering every name of it matches.
 */
export function entryNames(entry: string, tool: string, catalog: readonly CatalogTool[]): boolean {
  // `group:plugins` is every plugin's tools, a tool server's among them; a plugin's id, its tools.
  if (entry === "group:plugins")
    return tool.includes("__") || catalog.some((t) => t.id === tool && t.plugin !== null);
  if (entry.startsWith("group:")) {
    const group = entry.slice(6);
    return catalog.some((t) => t.group === group && t.id === tool);
  }
  if (catalog.some((t) => t.plugin === entry && t.id === tool)) return true;
  if (tool.endsWith("__*")) return entry === "*" || entry === tool || globMatches(entry, tool);
  return globMatches(entry, tool);
}

const listNames = (list: readonly string[], tool: string, catalog: readonly CatalogTool[]) =>
  list.find((entry) => entryNames(entry, tool, catalog)) ?? null;

/** An allow list leaves a tool out (`write` in it brings `apply_patch`). */
function leftOut(list: readonly string[] | null, tool: string, catalog: readonly CatalogTool[]) {
  if (!list) return false;
  if (listNames(list, tool, catalog)) return false;
  if (tool === "apply_patch" && listNames(list, "write", catalog)) return false;
  return true;
}

// The lines -----------------------------------------------------------------------------

export type LineValue = "allowed" | "limited" | "asks" | "never" | "unknown" | "not-offered";
/**
 * Who holds the line's value (section 2's marks): the gateway's settings for
 * every bot (`set`, the padlock), the gateway through the bot's own settings
 * (`gateway`), the rules plugin while it runs (`plugin`), a plugin rule
 * while it does not (`not-now`), or rules the plugin may enforce that this
 * client didn't read now (`unread`).
 */
export type LineMark = "set" | "gateway" | "plugin" | "not-now" | "unread" | null;

/** A thing a line says beside its value. */
export type LineException =
  | { kind: "every-deny"; tools: string[] }
  /** `entries`: the deny list's entries that name them, where they aren't the tools' own names. */
  | { kind: "bot-deny"; tools: string[]; entries?: string[] }
  /** Left out by an allow list: the gateway's for every bot, or the bot's own. */
  | { kind: "not-offered"; tools: string[]; by: "every" | "bot" }
  /** Left open by the settings read here, and not in the latest task's listing. */
  | { kind: "not-listed"; tools: string[] }
  | {
      kind: "rule";
      action: RuleAction;
      scope: "bot" | "every";
      pattern: string | null;
      tools: string[];
      id: string;
      version: number;
    }
  | { kind: "fallback"; scope: "bot" | "every" }
  /** The plugin's rules file is lost with no copy: it asks before every call but a question. */
  | { kind: "ask-every-call" }
  /** A tool server whose tools the gateway hasn't named in the latest task's listing. */
  | { kind: "unnamed" };

/** `entry`: an entry of the bot's deny list that names no tool the gateway lists now. */
export type LineKind = "group" | "exec" | "question" | "server" | "plugin" | "tool" | "entry";

export type ExecFacts = {
  /** The bot's own policy, the default for every bot, and the one that applies. */
  own: ExecPolicy | null;
  every: ExecPolicy | null;
  applies: ExecPolicy | "none";
};

export type PermissionLine = {
  /**
   * Stable within a gateway: a design line's id, `server:<name>`, `plugin:<id>`,
   * `tool:<name>` or `deny:<entry>`.
   */
  id: string;
  kind: LineKind;
  /** The line's words; for a tool by its own name, that name. */
  words: string;
  /**
   * The gateway's tool names behind it, as they exist on this gateway: for a
   * server, the ids the latest task's listing gave its tools, or none.
   */
  tools: string[];
  value: LineValue;
  mark: LineMark;
  exceptions: LineException[];
  /** What the line's choice shows checked; for Run commands, the policy. */
  choice: "allow" | "ask" | "never" | ExecPolicy | null;
  /** Whether the checked Ask is a rule of the plugin this line wrote (a whole-tool Ask of this bot). */
  ownAsk: boolean;
  /**
   * Whether Allow here can take that Ask off: every Ask of the bot's that makes
   * it is one this page writes (the line's tools exactly, no pattern, no note).
   */
  undoAsk: boolean;
  /**
   * Entries of the bot's deny list that name one of the line's tools and that
   * Allow here wouldn't take off (a group, a pattern, another tool's entry):
   * while one stays, Allow and Ask can't free the line.
   */
  heldBy: string[];
  exec: ExecFacts | null;
  /** In the bot's latest task's tools: yes, no, or not listed (no task, or the listing failed). */
  offered: "yes" | "no" | "unknown";
};

export type PermissionGroups = {
  never: string[];
  asks: string[];
  without: string[];
  unknown: string[];
  notOffered: string[];
};

/** Everything one bot's permissions page shows, as read now. Kept nowhere. */
export type BotPermissions = {
  botId: string;
  readAt: number;
  plugin: RulesPluginStatus;
  rules: RulesSource;
  enforcement: RulesEnforcement;
  /** "Ask when nothing else decides" is on, for the bot or every bot, in the rules shown. */
  fallback: { bot: boolean; every: boolean };
  /** The scopes' versions as read, for a write's compare-and-set; null when not read. */
  versions: { bot: number | null; every: number | null };
  offered: { status: Offered["status"]; taskKey: string | null; reason: string | null };
  configHash: string | null;
  /** Whether the gateway reports it is using the settings these lines are read from. */
  settingsApplied: "yes" | "no" | "unknown";
  /** The gateway's tool lists longer than this page reads, or not read whole. */
  listsCut: ToolList[];
  /** Settings that can remove tools and that this page doesn't evaluate: paths, or list entries. */
  unread: string[];
  lines: PermissionLine[];
  /** Lines past `MAX_LINES` not shown. */
  linesOmitted: number;
};

type LineDef = {
  id: string;
  kind: LineKind;
  words: string;
  tools: readonly string[];
};

/** The design's lines (section 4), in its order. */
export const LINE_DEFS: readonly LineDef[] = [
  { id: "read", kind: "group", words: "Read files", tools: ["read", "ls"] },
  { id: "files", kind: "group", words: "Change files", tools: ["write", "edit", "apply_patch"] },
  { id: "exec", kind: "exec", words: "Run commands", tools: ["exec", "process"] },
  { id: "web", kind: "group", words: "Search the web", tools: ["web_search", "web_fetch"] },
  { id: "message", kind: "group", words: "Message other bots", tools: ["sessions_send"] },
  {
    id: "tasks",
    kind: "group",
    words: "Look at its tasks",
    tools: ["sessions_list", "sessions_history"],
  },
  { id: "ask", kind: "question", words: "Ask you questions", tools: ["ask_user"] },
  { id: "routines", kind: "group", words: "Manage routines", tools: ["automations", "cron"] },
  { id: "browser", kind: "group", words: "Use the browser", tools: ["browser"] },
  {
    id: "gateway",
    kind: "group",
    words: "Change the gateway's settings",
    tools: ["gateway", "plugins"],
  },
  { id: "channels", kind: "group", words: "Send messages on channels", tools: ["message"] },
];

export type PermissionFacts = {
  botId: string;
  settings: ToolSettings;
  catalog: CatalogTool[];
  offered: Offered;
  plugin: RulesPluginStatus;
  rules: RulesSource;
  botScope: RulesScope | null;
  everyScope: RulesScope | null;
  now: number;
};

/**
 * What the rules plugin's rules do now, as far as this client knows: `read`,
 * enforced and read now; `ask-every-call`, its rules file lost with no copy,
 * so it asks before every call but a question; `none`, it isn't on this
 * gateway or says it isn't enforcing; `unread`, it may enforce rules this
 * client didn't read now (a copy it keeps, a read that failed, a status that
 * couldn't be read, a version too old to read).
 */
export type RulesEnforcement = "read" | "ask-every-call" | "none" | "unread";

export function rulesEnforcement(plugin: RulesPluginStatus, rules: RulesSource): RulesEnforcement {
  switch (plugin.kind) {
    case "unavailable":
      return "none";
    case "stopped":
      return plugin.answered ? "none" : "unread";
    case "unchecked":
    case "old":
      return "unread";
    case "running":
      if (plugin.enforcing === "ask-every-call") return "ask-every-call";
      return rules.from === "now" && plugin.enforcing !== "kept-copy" ? "read" : "unread";
  }
}

/**
 * Whether a rule is an Ask this page wrote for these tools: exactly them, no
 * pattern, and this page's note. An identical rule without the note was
 * written elsewhere and is left alone.
 */
export function pageAsk(
  rule: { action?: unknown; tools?: unknown; target?: unknown; note?: unknown; pageNote?: boolean },
  tools: readonly string[],
): boolean {
  const named = Array.isArray(rule.tools) ? rule.tools : [];
  return (
    rule.action === "ask" &&
    (rule.target === undefined || rule.target === null) &&
    (rule.note === PAGE_RULE_NOTE || rule.pageNote === true) &&
    named.length === tools.length &&
    tools.every((t) => named.includes(t))
  );
}

/** Whether the plugin is enforcing rules this page can show as held. */
export const pluginHolds = (plugin: RulesPluginStatus) =>
  plugin.kind === "running" && (plugin.enforcing === "rules" || plugin.enforcing === "nothing");

const ruleCovers = (rule: PluginRule, tool: string) =>
  rule.tools.some((name) =>
    tool.endsWith("__*")
      ? name === tool ||
        globMatches(name, tool) ||
        (name.endsWith("__*") && tool.startsWith(name.slice(0, -1)))
      : globMatches(name, tool),
  );

/** The lines of one bot, from its facts. */
export function permissionLines(facts: PermissionFacts): {
  lines: PermissionLine[];
  omitted: number;
} {
  const { settings, catalog } = facts;
  const exists = new Set(catalog.map((t) => t.id));
  const used = new Set<string>();
  const defs: LineDef[] = [];
  for (const def of LINE_DEFS) {
    const tools = def.tools.filter((t) => exists.has(t));
    if (tools.length === 0) continue;
    tools.forEach((t) => used.add(t));
    defs.push({ ...def, tools });
  }
  const listed = facts.offered.status === "listed" ? facts.offered.servers : [];
  const servers = [...new Set([...settings.servers, ...listed.map((each) => each.name)])];
  for (const server of servers.slice(0, MAX_TOOL_SERVERS)) {
    // Its tools as the gateway listed them; a server it hasn't listed has none here.
    defs.push({
      id: `server:${server}`,
      kind: "server",
      words: `Tool server ${server}`,
      tools: listed.find((each) => each.name === server)?.tools ?? [],
    });
  }
  const plugins = new Map<string, { label: string; tools: string[] }>();
  for (const tool of catalog) {
    if (used.has(tool.id)) continue;
    if (tool.plugin) {
      const entry = plugins.get(tool.plugin) ?? { label: tool.groupLabel, tools: [] };
      entry.tools.push(tool.id);
      plugins.set(tool.plugin, entry);
      used.add(tool.id);
    }
  }
  for (const [plugin, { label, tools }] of plugins)
    defs.push({ id: `plugin:${plugin}`, kind: "plugin", words: `From ${label}`, tools });
  for (const tool of catalog) {
    if (used.has(tool.id)) continue;
    defs.push({ id: `tool:${tool.id}`, kind: "tool", words: tool.id, tools: [tool.id] });
  }
  // An entry of the bot's deny list that names none of these (a server's tools the gateway no
  // longer lists, once denied) is a line of its own, so it can be seen and taken off.
  const named = defs.flatMap((def) => def.tools);
  for (const entry of settings.botDeny)
    if (!named.some((tool) => entryNames(entry, tool, catalog)))
      defs.push({ id: `deny:${entry}`, kind: "entry", words: entry, tools: [entry] });
  const lines = defs.slice(0, MAX_LINES).map((def) => lineOf(def, facts));
  return { lines, omitted: Math.max(0, defs.length - MAX_LINES) };
}

function lineOf(def: LineDef, facts: PermissionFacts): PermissionLine {
  const { settings, catalog } = facts;
  if (def.kind === "server" && def.tools.length === 0)
    // The gateway hasn't named this server's tools: nothing is claimed about them.
    return {
      id: def.id,
      kind: def.kind,
      words: def.words,
      tools: [],
      exec: null,
      offered: facts.offered.status === "listed" ? "no" : "unknown",
      ownAsk: false,
      undoAsk: false,
      heldBy: [],
      value: facts.offered.status === "listed" ? "not-offered" : "unknown",
      mark: null,
      exceptions: [{ kind: "unnamed" }],
      choice: null,
    };
  const everyDenied: string[] = [];
  const botDenied: string[] = [];
  const everyLeftOut: string[] = [];
  const botLeftOut: string[] = [];
  const open: string[] = [];
  for (const tool of def.tools) {
    if (listNames(settings.everyDeny, tool, catalog)) everyDenied.push(tool);
    else if (listNames(settings.botDeny, tool, catalog)) botDenied.push(tool);
    else if (leftOut(settings.everyAllow, tool, catalog)) everyLeftOut.push(tool);
    else if (leftOut(settings.botAllow, tool, catalog)) botLeftOut.push(tool);
    else open.push(tool);
  }
  const listing = facts.offered.status === "listed" ? facts.offered : null;
  // Tools the settings read here leave open that the latest task's listing doesn't have:
  // something this page doesn't read (a provider's or a profile's setting) may remove them.
  const unlisted =
    listing && def.kind !== "server" ? open.filter((t) => !listing.available.includes(t)) : [];
  const offered: PermissionLine["offered"] = !listing
    ? "unknown"
    : def.kind === "server" || def.tools.some((t) => listing.available.includes(t))
      ? "yes"
      : "no";
  const exec: ExecFacts | null =
    def.kind === "exec"
      ? {
          own: settings.botExec,
          every: settings.everyExec,
          applies: settings.botExec ?? settings.everyExec ?? "none",
        }
      : null;
  const base = {
    id: def.id,
    kind: def.kind,
    words: def.words,
    tools: [...def.tools],
    exec,
    offered,
    ownAsk: false,
    undoAsk: false,
    heldBy:
      def.kind === "entry"
        ? []
        : settings.botDeny.filter(
            (entry) =>
              def.tools.some((tool) => entryNames(entry, tool, catalog)) &&
              !takenOffBy(entry, def.tools),
          ),
  };
  const exceptions: LineException[] = [];
  const named = settings.botDeny.filter(
    (entry) =>
      !def.tools.includes(entry) && botDenied.some((tool) => entryNames(entry, tool, catalog)),
  );
  const botDeny = (): LineException => ({
    kind: "bot-deny",
    tools: botDenied,
    ...(named.length > 0 ? { entries: named } : {}),
  });
  const leftOutBy = (): LineException[] => [
    ...(everyLeftOut.length > 0
      ? [{ kind: "not-offered" as const, tools: everyLeftOut, by: "every" as const }]
      : []),
    ...(botLeftOut.length > 0
      ? [{ kind: "not-offered" as const, tools: botLeftOut, by: "bot" as const }]
      : []),
  ];
  // 1, 2: the gateway removes the tools: for every bot, or for this bot. A tool an allow list
  // leaves out is not offered, said with whose list it is.
  if (open.length === 0) {
    const denied = everyDenied.length + botDenied.length > 0;
    if (!denied) {
      if (everyLeftOut.length > 0 && botLeftOut.length > 0) exceptions.push(...leftOutBy());
      return {
        ...base,
        value: "not-offered",
        mark: botLeftOut.length > 0 ? "gateway" : "set",
        exceptions,
        choice: null,
      };
    }
    exceptions.push(...leftOutBy());
    // Said as a denial for every bot only when the settings for every bot remove the whole line.
    if (botDenied.length === 0 && botLeftOut.length === 0)
      return {
        ...base,
        value: "never",
        mark: "set",
        exceptions,
        choice: exec ? (exec.applies === "none" ? null : exec.applies) : "allow",
      };
    if (everyDenied.length > 0) exceptions.push({ kind: "every-deny", tools: everyDenied });
    if (botDenied.length === 0)
      // Part denied for every bot, the rest left out of the bot's own allow list: named, no choice.
      return {
        ...base,
        value: "never",
        mark: "gateway",
        exceptions,
        choice: exec ? (exec.applies === "none" ? null : exec.applies) : null,
      };
    if (named.length > 0) exceptions.push(botDeny());
    return {
      ...base,
      value: "never",
      mark: "gateway",
      exceptions,
      choice: exec ? "deny" : "never",
    };
  }
  if (everyDenied.length > 0) exceptions.push({ kind: "every-deny", tools: everyDenied });
  if (botDenied.length > 0) exceptions.push(botDeny());
  exceptions.push(...leftOutBy());
  if (unlisted.length > 0) exceptions.push({ kind: "not-listed", tools: unlisted });
  // A tool of the line no allow list offers leaves the rest as they are; a denied one limits the line.
  const partial = everyDenied.length + botDenied.length > 0;

  // 3 to 5: the rules plugin's rules for this bot and for every bot, as last read.
  const known = facts.rules.from !== null;
  const enforcement = rulesEnforcement(facts.plugin, facts.rules);
  const holds = enforcement === "read";
  const rules: { rule: PluginRule; scope: "bot" | "every" }[] = [];
  if (known) {
    for (const [scope, set] of [
      ["bot", facts.botScope],
      ["every", facts.everyScope],
    ] as const)
      for (const rule of set?.rules ?? [])
        if (open.some((tool) => ruleCovers(rule, tool))) rules.push({ rule, scope });
  }
  const covering = (r: PluginRule) => open.every((tool) => ruleCovers(r, tool));
  const whole = (r: PluginRule) => !r.target && covering(r);
  const wholeNever = rules.find((r) => r.rule.action === "never" && whole(r.rule));
  const asks = rules.filter((r) => r.rule.action === "ask");
  // An Ask on every tool of the line, with no pattern, makes it Asks first; any other limits it.
  const wholeAsk = asks.some((r) => whole(r.rule));
  const wholeAllow = rules.some((r) => r.rule.action === "allow" && whole(r.rule));
  // A Never that holds back only part of the line: under a pattern, or on some of its tools.
  const targetNevers = rules.filter((r) => r.rule.action === "never" && !whole(r.rule));
  const ownAsks = asks.filter((r) => r.scope === "bot" && whole(r.rule));
  const ownAsk = ownAsks.length > 0;
  const undoAsk = ownAsk && ownAsks.every((r) => pageAsk(r.rule, def.tools));
  for (const { rule, scope } of [...(wholeNever ? [wholeNever] : []), ...targetNevers, ...asks]) {
    if (exceptions.length >= MAX_EXCEPTIONS) break;
    exceptions.push({
      kind: "rule",
      action: rule.action,
      scope,
      pattern: rule.target ? cut(rule.target.pattern, MAX_SHOWN_PATTERN_CHARS) : null,
      tools: rule.tools.filter((t) =>
        open.some((tool) => ruleCovers({ ...rule, tools: [t] }, tool)),
      ),
      id: rule.id,
      version: rule.version,
    });
  }
  const fallbackOn =
    def.kind !== "question" &&
    known &&
    (facts.botScope?.fallback === true || facts.everyScope?.fallback === true);
  if (fallbackOn && exceptions.length < MAX_EXCEPTIONS)
    exceptions.push({ kind: "fallback", scope: facts.botScope?.fallback ? "bot" : "every" });
  const pluginPart = rules.length > 0 || fallbackOn;
  // With "Ask when nothing else decides" on, a line no whole-line rule decides may ask: Limited.
  const fallbackAsks = fallbackOn && !wholeAllow;
  const pluginMark: LineMark = holds ? "plugin" : "not-now";
  // Rules this client didn't read now may cover any line: Unknown, never Allowed. A plugin that
  // asks before every call holds every line as Asks first.
  const rulesOver = (line: PermissionLine): PermissionLine =>
    line.value === "never" && (line.mark === "gateway" || line.mark === "set")
      ? line
      : enforcement === "unread"
        ? { ...line, value: "unknown", mark: "unread" }
        : enforcement === "ask-every-call"
          ? {
              ...line,
              value: "asks",
              mark: "plugin",
              exceptions: [...line.exceptions, { kind: "ask-every-call" }],
            }
          : line;
  // What the latest task's listing shows over the settings: none of the line's open tools listed
  // is Not offered, held by nothing established here; some missing limits an Allowed line.
  const listed = (line: PermissionLine): PermissionLine =>
    unlisted.length === 0
      ? line
      : unlisted.length === open.length
        ? { ...line, value: "not-offered", mark: null }
        : line.value === "allowed"
          ? { ...line, value: "limited" }
          : line;

  // Run commands: the gateway's command policy decides after the plugin.
  if (exec) {
    const policy = exec.applies;
    const choice = policy === "none" ? null : policy;
    if (pluginPart && !holds)
      return listed(
        rulesOver({
          ...base,
          value: "unknown",
          mark: "not-now",
          exceptions,
          choice,
          ownAsk,
          undoAsk,
        }),
      );
    if (wholeNever)
      return listed(
        rulesOver({ ...base, value: "never", mark: "plugin", exceptions, choice, ownAsk, undoAsk }),
      );
    const limited = asks.length > 0 || targetNevers.length > 0 || partial || fallbackAsks;
    const value: LineValue =
      policy === "deny"
        ? "never"
        : policy === "full" || policy === "none"
          ? wholeAsk
            ? "asks"
            : limited
              ? "limited"
              : "allowed"
          : policy === "allowlist"
            ? wholeAsk
              ? "asks"
              : "limited"
            : "asks";
    const mark: LineMark =
      asks.length > 0 || targetNevers.length > 0 || fallbackAsks
        ? pluginMark
        : exec.own
          ? "gateway"
          : "set";
    return listed(rulesOver({ ...base, value, mark, exceptions, choice, ownAsk, undoAsk }));
  }
  // The bot's own deny on some of the line's tools is no one choice: none is checked, and Never
  // denies the rest. Never is checked only when the gateway removes every tool of the line.
  // A tool server's line is read-only (no namespace to write): no choice is checked.
  const choice = def.kind === "server" || botDenied.length > 0 ? null : ownAsk ? "ask" : "allow";
  if (def.kind === "question")
    return listed({
      ...base,
      value: partial ? "limited" : "allowed",
      mark: partial ? "gateway" : null,
      exceptions,
      choice: "allow",
    });
  if (pluginPart && !holds)
    return listed(
      rulesOver({
        ...base,
        value: "unknown",
        mark: "not-now",
        exceptions,
        choice,
        ownAsk,
        undoAsk,
      }),
    );
  if (wholeNever)
    return listed(
      rulesOver({ ...base, value: "never", mark: "plugin", exceptions, choice, ownAsk, undoAsk }),
    );
  if (wholeAsk)
    return listed(
      rulesOver({ ...base, value: "asks", mark: "plugin", exceptions, choice, ownAsk, undoAsk }),
    );
  if (asks.length > 0 || targetNevers.length > 0)
    return listed(
      rulesOver({ ...base, value: "limited", mark: "plugin", exceptions, choice, ownAsk, undoAsk }),
    );
  return listed(
    rulesOver({
      ...base,
      value: partial || fallbackAsks ? "limited" : "allowed",
      mark: partial ? (botDenied.length > 0 ? "gateway" : "set") : fallbackOn ? pluginMark : null,
      exceptions,
      choice,
      ownAsk,
      undoAsk,
    }),
  );
}

/** The page's view of a bot's facts. */
export function permissionsView(facts: PermissionFacts): BotPermissions {
  const { lines, omitted } = permissionLines(facts);
  const offered = facts.offered;
  return {
    botId: facts.botId,
    readAt: facts.now,
    plugin: facts.plugin,
    rules: facts.rules,
    enforcement: rulesEnforcement(facts.plugin, facts.rules),
    fallback: {
      bot: facts.rules.from !== null && facts.botScope?.fallback === true,
      every: facts.rules.from !== null && facts.everyScope?.fallback === true,
    },
    versions: {
      bot: facts.rules.from === "now" ? (facts.botScope?.version ?? 0) : null,
      every: facts.rules.from === "now" ? (facts.everyScope?.version ?? 0) : null,
    },
    offered: {
      status: offered.status,
      taskKey: offered.status === "listed" ? offered.taskKey : null,
      reason: offered.status === "failed" ? offered.reason.slice(0, 200) : null,
    },
    configHash: facts.settings.hash,
    settingsApplied: facts.settings.applied,
    listsCut: facts.settings.cut,
    unread: [
      ...facts.settings.unread,
      ...[
        ...(facts.settings.everyAllow ?? []),
        ...facts.settings.everyDeny,
        ...(facts.settings.botAllow ?? []),
        ...facts.settings.botDeny,
      ].filter(
        (entry) =>
          entry.startsWith("group:") &&
          entry !== "group:plugins" &&
          !facts.catalog.some((t) => t.group === entry.slice(6)),
      ),
    ].slice(0, MAX_EXCEPTIONS * 2),
    lines,
    linesOmitted: omitted,
  };
}

/** The lines by the glance's groups (section 4), by id, in order. */
export function permissionGroups(lines: readonly PermissionLine[]): PermissionGroups {
  const groups: PermissionGroups = {
    never: [],
    asks: [],
    without: [],
    unknown: [],
    notOffered: [],
  };
  for (const line of lines) {
    const key =
      line.value === "never"
        ? "never"
        : line.value === "asks" ||
            (line.value === "limited" &&
              line.exceptions.some((e) => e.kind === "rule" && e.action === "ask"))
          ? "asks"
          : line.value === "unknown"
            ? "unknown"
            : line.value === "not-offered"
              ? "notOffered"
              : "without";
    groups[key].push(line.id);
  }
  return groups;
}

// Writes -----------------------------------------------------------------------------

/** A line's choice: Allow, Ask or Never; Run commands takes the gateway's policies. */
export type PermissionChoice = "allow" | "ask" | "never" | "full" | "auto" | "exec-ask" | "deny";

export const PERMISSION_CHOICES: readonly PermissionChoice[] = [
  "allow",
  "ask",
  "never",
  "full",
  "auto",
  "exec-ask",
  "deny",
];

/** Why a choice can't be made on a line as shown, in words; null when it can. */
export function choiceRefusal(
  view: BotPermissions,
  line: PermissionLine,
  choice: PermissionChoice,
  admin: boolean,
): string | null {
  const execChoice =
    choice === "full" || choice === "auto" || choice === "exec-ask" || choice === "deny";
  if ((line.kind === "exec") !== execChoice) return "That choice isn't one of this line's.";
  if (line.kind === "server" && line.tools.length === 0)
    return "The gateway hasn't listed this server's tools for the bot's latest task, so Clawtrate can't name them to allow, ask or deny.";
  if (line.kind === "server")
    return "The gateway doesn't name one namespace that covers all of this server's tools and no other server's, so Clawtrate won't allow, ask or deny the whole server here.";
  if (line.value === "not-offered" && line.mark === "set")
    return "The gateway's settings for every bot don't offer this tool. Clawtrate can't change them.";
  if (line.value === "not-offered" && line.mark === "gateway")
    return "The bot's own allow list in the gateway's settings leaves this out. This page doesn't change allow lists.";
  if (line.mark === "set" && line.value === "never")
    return "The gateway's settings deny this for every bot. Clawtrate can't change them.";
  if (line.value === "never" && line.mark === "gateway" && line.choice === null && !line.exec)
    return "The gateway's settings for every bot deny some of these tools, and the bot's own allow list leaves out the rest. This page doesn't change allow lists.";
  if (
    (choice === "allow" || choice === "ask" || (execChoice && choice !== "deny")) &&
    line.heldBy.length > 0
  )
    return `This choice is held by ${line.heldBy.join(" and ")} in the bot's deny list.`;
  if (line.kind === "question" && choice === "ask") return "A question already asks you.";
  if (line.kind === "entry" && choice === "ask")
    return "This entry of the bot's deny list names no tool the gateway lists now, so there is nothing to ask about.";
  if (!admin) return "Changing what a bot may do needs admin access.";
  if (view.listsCut.includes("bot-deny"))
    return "The bot's deny list in the gateway's settings is longer than this page reads, or has an entry it can't read whole. Clawtrate won't replace it, so it can't change it here.";
  if (choice === "ask") {
    if (!pluginHolds(view.plugin) || view.rules.from !== "now")
      return "Asking needs Clawtrate's rules plugin running.";
    if (view.versions.bot === null && view.rules.from !== "now")
      return "The rules plugin's rules weren't read.";
  }
  if (choice === "allow" && line.ownAsk && !line.undoAsk)
    return "This Ask is a rule of Clawtrate's rules plugin that this page didn't write. It's changed on the rules page in Settings, Permissions, which isn't built yet.";
  if (
    choice === "allow" &&
    line.undoAsk &&
    (!pluginHolds(view.plugin) || view.rules.from !== "now")
  )
    return "Taking off this Ask needs Clawtrate's rules plugin running.";
  return null;
}

/** A merge patch of the config and the list paths it replaces whole. */
export type ConfigWrite = { patch: RawRecord; replacePaths: string[] };

const botPath = (botId: string) => ["agents", "entries", botId, "tools"] as const;

function nest(path: readonly string[], value: unknown): RawRecord {
  let out: unknown = value;
  for (let i = path.length - 1; i >= 0; i -= 1) out = { [path[i]!]: out };
  return out as RawRecord;
}

/** Whether Allow on a line of these tools takes this deny entry off. */
export function takenOffBy(entry: string, tools: readonly string[]): boolean {
  return tools.some(
    (tool) =>
      entry === tool ||
      (tool.endsWith("__*") && entry.startsWith(tool.slice(0, -1))) ||
      (!entry.includes("*") && canonical(entry) === canonical(tool)),
  );
}

/** The bot's deny list with the line's tools added, or taken out. */
export function denyWrite(
  botId: string,
  settings: ToolSettings,
  line: Pick<PermissionLine, "tools"> & { kind?: LineKind },
  deny: boolean,
  catalog: readonly CatalogTool[],
): ConfigWrite | null {
  const current = settings.botDeny;
  const next = deny
    ? [...current, ...line.tools.filter((t) => !listNames(current, t, catalog))]
    : current.filter(
        (entry) =>
          // An entry's own line takes off that entry and nothing else.
          (line.kind === "entry" && !line.tools.includes(entry)) ||
          (line.kind !== "entry" && !takenOffBy(entry, line.tools)),
      );
  if (next.length === current.length && next.every((e, i) => e === current[i])) return null;
  if (next.length > MAX_LIST_ENTRIES)
    throw new Error(
      `That would make the bot's deny list longer than this page reads back (${MAX_LIST_ENTRIES} entries).`,
    );
  const path = [...botPath(botId), "deny"];
  return { patch: nest(path, next.length > 0 ? next : null), replacePaths: [path.join(".")] };
}

/** Run commands' policy for the bot, with exec and process taken off its deny list unless Never. */
export function execWrite(
  botId: string,
  settings: ToolSettings,
  choice: "full" | "auto" | "exec-ask" | "deny",
  catalog: readonly CatalogTool[],
): ConfigWrite {
  const mode = choice === "exec-ask" ? "ask" : choice;
  const tools = botPath(botId);
  const replacePaths: string[] = [];
  const own: RawRecord = { exec: { mode } };
  if (settings.botExecLegacy) {
    // The legacy pair is replaced by the mode, the rest of the bot's exec block kept as it is.
    own.exec = { mode, security: null, ask: null };
  }
  if (mode !== "deny") {
    const deny = denyWrite(botId, settings, { tools: ["exec", "process"] }, false, catalog);
    if (deny) {
      own.deny = settings.botDeny.filter(
        (e) => !["exec", "process", "bash"].includes(canonical(e)),
      );
      if ((own.deny as string[]).length === 0) own.deny = null;
      replacePaths.push([...tools, "deny"].join("."));
    }
  }
  return { patch: nest(tools, own), replacePaths };
}

/**
 * A scope's rules as `set` takes them back, from the plugin's own `get`
 * answer: each rule with exactly what it says (id, action, tools, target,
 * note), so a save keeps every other rule as it is. Null when the scope's
 * answer can't be read whole.
 */
export function rulesForSet(answer: unknown, scope: string): RawRecord[] | null {
  const s = asRecord(asRecord(asRecord(answer)?.scopes)?.[scope]);
  if (!s) return [];
  if (!Array.isArray(s.rules)) return null;
  const out: RawRecord[] = [];
  for (const each of s.rules) {
    const r = asRecord(each);
    if (!r || typeof r.id !== "string") return null;
    const rule: RawRecord = { id: r.id, action: r.action, tools: r.tools };
    if (r.target !== undefined && r.target !== null) rule.target = r.target;
    if (typeof r.note === "string") rule.note = r.note;
    out.push(rule);
  }
  return out;
}

/** Whether a scope already holds a whole-tool Ask covering the line's tools. */
export function hasOwnAsk(scope: RulesScope | null, tools: readonly string[]): boolean {
  return (scope?.rules ?? []).some(
    (r) => r.action === "ask" && !r.target && tools.every((t) => r.tools.includes(t)),
  );
}

/** Whether the view read back shows the choice made on a line as it was. */
export function choiceShown(
  view: BotPermissions,
  made: Pick<PermissionLine, "id" | "kind" | "tools">,
  choice: PermissionChoice,
): boolean {
  const line = view.lines.find((each) => each.id === made.id);
  // A server's tools, once denied, are no longer listed: its deny entry is what shows it.
  if (choice === "never" && made.kind === "server") {
    const entry = view.lines.find((each) => each.id === `deny:${made.tools[0]}`);
    if (entry?.value === "never" && entry.mark === "gateway") return true;
  }
  // An entry taken off the deny list has no line any more.
  if (choice === "allow" && made.kind === "entry") return !line;
  if (!line) return false;
  switch (choice) {
    case "never":
      return line.value === "never" && line.mark === "gateway";
    case "allow":
      return line.choice === "allow" && line.value !== "never";
    case "ask":
      return line.choice === "ask";
    case "full":
    case "auto":
    case "deny":
      return line.exec?.own === choice;
    case "exec-ask":
      return line.exec?.own === "ask";
  }
}

/** The page's words for a line's value. */
export const VALUE_WORDS: Record<LineValue, string> = {
  allowed: "Allowed",
  limited: "Limited",
  asks: "Asks first",
  never: "Never",
  unknown: "Unknown",
  "not-offered": "Not offered",
};

/** The gateway's command policies, as the page says them (section 5). */
export const EXEC_WORDS: Record<ExecPolicy | "none", string> = {
  full: "Allow all",
  auto: "Review first",
  ask: "Ask",
  deny: "Never",
  allowlist: "Only listed commands",
  legacy: "Legacy setting: security and ask",
  none: "None set",
};
