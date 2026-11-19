// The rules: their shape, their limits, and how a `set` becomes a scope's
// new rules. Pure functions: no I/O, no clock (callers pass the time).
//
// A scope is "*" (every bot) or one bot's id. Each holds:
//
//   { version, fallback, rules: [rule] }
//
// `version` counts the scope's saves, for compare-and-set; `fallback` is
// "Ask when nothing else decides". A rule:
//
//   { id, version, action: "allow" | "ask" | "never",
//     tools: [<tool> | "<server>__<pattern>"],
//     target?: { kind: "path" | "command", pattern },
//     note?, setAt, setBy }
//
// `version` counts the rule's own changes, so a decision can name the rule
// as it was. A rule's `note` is the person's own words and is never evaluated.

import { TARGET_KINDS } from "./targets.js";

export const RULES_SCHEMA = 1;
export const EVERY_BOT = "*";

/** Clawtrate's choices (design section 6): per scope, and per pattern. */
export const LIMITS = Object.freeze({
  allow: 20,
  ask: 20,
  never: 50,
  patternLength: 1000,
  noteLength: 1000,
  toolsPerRule: 16,
  toolNameLength: 128,
  /** Bots whose scope holds a rule or the fallback. */
  botScopes: 64,
  /** Scopes kept at all, emptied ones included, which keep their revision. */
  scopeEntries: 1000,
});

/** Whether a scope holds anything that decides a call. */
export const holdsRules = (scope) => scope.rules.length > 0 || scope.fallback;

export const ACTIONS = ["allow", "ask", "never"];
const ACTION_WORDS = { allow: "Allow", ask: "Ask first", never: "Never" };

const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TOOL_NAME = /^[a-z0-9][a-z0-9._-]*$/;
// A server's tools: `<server>__<pattern>`, `*` only after the separator.
const SERVER_TOOL = /^[a-z0-9][a-z0-9._-]*?__[a-z0-9._*-]*$/;
const RULE_ID = /^[0-9a-f]{12}$/;
/** The gateway's own aliases for tool names (OpenClaw 2026.10.6, tool-policy-shared). */
const TOOL_ALIASES = new Map([
  ["bash", "exec"],
  ["apply-patch", "apply_patch"],
  ["cron", "automations"],
]);
/** Never asked about or blocked: a question already asks the person. */
export const EXEMPT_TOOL = "ask_user";

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export class RuleError extends Error {
  constructor(reason, message, details = {}) {
    super(message);
    this.reason = reason;
    this.details = details;
  }
}

export const isScopeId = (scope) =>
  scope === EVERY_BOT || (typeof scope === "string" && AGENT_ID.test(scope));

/** A tool entry as the gateway names tools: lower case, aliases resolved. */
function canonicalTool(entry) {
  if (typeof entry !== "string") return null;
  const lower = entry.trim().toLowerCase();
  if (lower.length === 0 || lower.length > LIMITS.toolNameLength) return null;
  if (lower.includes("*")) return SERVER_TOOL.test(lower) ? lower : null;
  const name = TOOL_ALIASES.get(lower) ?? lower;
  return TOOL_NAME.test(name) ? name : null;
}

/** A path pattern as stored: names joined by `/`, no `..`, not absolute; `**` a whole name. */
function canonicalPathPattern(pattern) {
  if (pattern.startsWith("/") || pattern.startsWith("~") || /[\\:]/.test(pattern)) return null;
  const names = [];
  for (const name of pattern.split("/")) {
    if (name === "" || name === ".") continue;
    if (name === "..") return null;
    if (name.includes("**") && name !== "**") return null;
    // `**/**` is `**`.
    if (name === "**" && names.at(-1) === "**") continue;
    names.push(name);
  }
  return names.length > 0 ? names.join("/") : null;
}

/** A command pattern as stored: one line, runs of blanks as one space. */
function canonicalCommandPattern(pattern) {
  if (/[\r\n]/.test(pattern)) return null;
  const text = pattern.replace(/[ \t]+/g, " ").trim();
  return text.length > 0 ? text : null;
}

/**
 * @typedef {{ id?: string, action: "allow" | "ask" | "never", tools: string[],
 *   target?: { kind: "path" | "command", pattern: string }, note?: string }} Rule
 */

/**
 * One rule from a `set`, checked and in its stored form without its
 * bookkeeping (`id` is kept when given). Throws a RuleError saying why not.
 * @returns {Rule}
 */
export function checkRule(raw, index) {
  const at = `rule ${index + 1}`;
  if (!isPlainObject(raw)) throw new RuleError("bad_rule", `${at} is not an object`);
  for (const key of Object.keys(raw)) {
    if (!["id", "action", "tools", "target", "note"].includes(key)) {
      throw new RuleError("bad_rule", `${at} has ${key}, which a rule does not take`);
    }
  }
  if (raw.id !== undefined && (typeof raw.id !== "string" || !RULE_ID.test(raw.id))) {
    throw new RuleError("bad_rule", `${at} has an id that is not a rule id`);
  }
  if (!ACTIONS.includes(raw.action)) {
    throw new RuleError("bad_rule", `${at}: action must be allow, ask or never`);
  }
  if (!Array.isArray(raw.tools) || raw.tools.length === 0) {
    throw new RuleError("bad_rule", `${at}: tools must name at least one tool`);
  }
  if (raw.tools.length > LIMITS.toolsPerRule) {
    throw new RuleError("limit", `${at} names more than ${LIMITS.toolsPerRule} tools`, {
      limit: LIMITS.toolsPerRule,
    });
  }
  const tools = [];
  for (const entry of raw.tools) {
    const tool = canonicalTool(entry);
    if (tool === null) {
      throw new RuleError("bad_rule", `${at}: ${JSON.stringify(entry)} is not a tool name`);
    }
    if (tool === EXEMPT_TOOL) {
      throw new RuleError("exempt_tool", `${at}: ask_user is never asked about or blocked`);
    }
    if (!tools.includes(tool)) tools.push(tool);
  }
  /** @type {Rule} */
  const rule = { action: raw.action, tools };
  if (raw.id !== undefined) rule.id = raw.id;
  if (raw.target !== undefined) {
    const target = raw.target;
    if (
      !isPlainObject(target) ||
      Object.keys(target).sort().join() !== "kind,pattern" ||
      !["path", "command"].includes(target.kind) ||
      typeof target.pattern !== "string"
    ) {
      throw new RuleError(
        "bad_rule",
        `${at}: target must be { kind: "path" | "command", pattern }`,
      );
    }
    if (target.pattern.length > LIMITS.patternLength) {
      throw new RuleError(
        "limit",
        `${at}: a pattern is at most ${LIMITS.patternLength} characters`,
        { limit: LIMITS.patternLength, length: target.pattern.length },
      );
    }
    const wrong = tools.filter((tool) => TARGET_KINDS[tool] !== target.kind);
    if (wrong.length > 0) {
      throw new RuleError(
        "bad_rule",
        `${at}: a ${target.kind} target applies only to ${Object.keys(TARGET_KINDS)
          .filter((tool) => TARGET_KINDS[tool] === target.kind)
          .join(", ")}, not ${wrong.join(", ")}`,
      );
    }
    const pattern =
      target.kind === "path"
        ? canonicalPathPattern(target.pattern)
        : canonicalCommandPattern(target.pattern);
    if (pattern === null) {
      throw new RuleError(
        "bad_rule",
        target.kind === "path"
          ? `${at}: a path pattern is a path in the bot's workspace, without .., ~, \\ or :, and ** only as a whole name`
          : `${at}: a command pattern is one line`,
      );
    }
    rule.target = { kind: target.kind, pattern };
  }
  if (raw.note !== undefined) {
    if (typeof raw.note !== "string" || raw.note.length > LIMITS.noteLength) {
      throw new RuleError(
        raw.note?.length > LIMITS.noteLength ? "limit" : "bad_rule",
        `${at}: a note is text of at most ${LIMITS.noteLength} characters`,
        { limit: LIMITS.noteLength },
      );
    }
    if (raw.note.length > 0) rule.note = raw.note;
  }
  return rule;
}

/** The parts of a rule a change is measured on. */
const content = (rule) =>
  JSON.stringify([rule.action, rule.tools, rule.target ?? null, rule.note ?? null]);

/** Refuse a scope past any of its limits, counting each action's rules. */
export function checkLimits(scopeId, rules) {
  const counts = { allow: 0, ask: 0, never: 0 };
  for (const rule of rules) {
    if (isPlainObject(rule) && ACTIONS.includes(rule.action)) counts[rule.action] += 1;
  }
  for (const action of ACTIONS) {
    const count = counts[action];
    if (count > LIMITS[action]) {
      throw new RuleError(
        "limit",
        `${scopeId === EVERY_BOT ? "the rules for every bot" : `scope ${scopeId}`} would hold ${count} ${action} rules; a scope holds at most ${LIMITS[action]}`,
        { action, limit: LIMITS[action], count },
      );
    }
  }
}

/**
 * The scope a `set` makes, from the scope as stored (or undefined) and the
 * request's rules and fallback. A rule that keeps its id keeps its version
 * unless its content changed; a new rule gets `newId()` and version 1.
 * Throws a RuleError and changes nothing when anything is wrong.
 */
export function nextScope(scopeId, stored, request, { now, setBy, newId }) {
  if (!Array.isArray(request.rules)) throw new RuleError("bad_request", "rules must be a list");
  if (typeof request.fallback !== "boolean") {
    throw new RuleError("bad_request", "fallback must be true or false");
  }
  // Counted before each rule is read, so a scope past a limit is refused as that.
  checkLimits(scopeId, request.rules);
  const old = new Map((stored?.rules ?? []).map((rule) => [rule.id, rule]));
  const seen = new Set();
  const rules = request.rules.map((raw, index) => {
    const checked = checkRule(raw, index);
    if (checked.id === undefined) {
      let id = newId();
      while (old.has(id) || seen.has(id)) id = newId();
      seen.add(id);
      return { id, version: 1, ...withoutId(checked), setAt: now, setBy };
    }
    if (seen.has(checked.id)) {
      throw new RuleError("bad_rule", `rule ${index + 1} repeats the id ${checked.id}`);
    }
    seen.add(checked.id);
    const before = old.get(checked.id);
    if (!before) {
      throw new RuleError(
        "unknown_rule",
        `rule ${index + 1} names ${checked.id}, which is not a rule of this scope`,
      );
    }
    if (content(before) === content(checked)) return before;
    return {
      id: checked.id,
      version: before.version + 1,
      ...withoutId(checked),
      setAt: now,
      setBy,
    };
  });
  return { version: (stored?.version ?? 0) + 1, fallback: request.fallback, rules };
}

function withoutId(rule) {
  const { id: _id, ...rest } = rule;
  return rest;
}

/**
 * A stored scope, checked again when the store is read: the same shape and
 * limits a `set` allows, with its bookkeeping. Throws a RuleError.
 */
export function checkStoredScope(scopeId, scope) {
  if (!isScopeId(scopeId)) throw new RuleError("bad_store", `${scopeId} is not a scope`);
  if (
    !isPlainObject(scope) ||
    !Number.isSafeInteger(scope.version) ||
    scope.version < 1 ||
    typeof scope.fallback !== "boolean" ||
    !Array.isArray(scope.rules)
  ) {
    throw new RuleError("bad_store", `scope ${scopeId} is not a stored scope`);
  }
  checkLimits(scopeId, scope.rules);
  const ids = new Set();
  return {
    version: scope.version,
    fallback: scope.fallback,
    rules: scope.rules.map((rule, index) => {
      if (!isPlainObject(rule)) throw new RuleError("bad_store", `a rule of ${scopeId} is not one`);
      const { version, setAt, setBy, ...rest } = rule;
      const checked = checkRule(rest, index);
      if (
        checked.id === undefined ||
        ids.has(checked.id) ||
        !Number.isSafeInteger(version) ||
        version < 1 ||
        !Number.isSafeInteger(setAt) ||
        !(setBy === null || typeof setBy === "string")
      ) {
        throw new RuleError("bad_store", `rule ${index + 1} of ${scopeId} is not a stored rule`);
      }
      ids.add(checked.id);
      return { ...checked, version, setAt, setBy };
    }),
  };
}

/** A rule in the words the app uses: "Ask first · notes/**", "Never · write, edit". */
export function ruleLabel(rule) {
  const what = rule.target ? rule.target.pattern : rule.tools.join(", ");
  const text = `${ACTION_WORDS[rule.action]} · ${what}`;
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

/** Whose rule it is, in words: "Otto's" needs a name the plugin does not have. */
export const scopeWords = (scopeId) =>
  scopeId === EVERY_BOT ? "the rule for every bot" : `${scopeId}'s rule`;
