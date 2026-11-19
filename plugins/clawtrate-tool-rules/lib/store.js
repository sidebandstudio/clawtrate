// The plugin's own files, in a folder of its own in the gateway's state
// folder: the rules (rules.json) and the decision record (decisions.jsonl).
//
// The rules file is written whole and atomically: a temporary file in the
// same folder, flushed, then renamed over the old one, and the folder
// flushed. It is read again whenever it changes on disk (by its size,
// modification time and inode), and checked as strictly as a `set`; when it
// cannot be read the rules are unavailable and nothing is enforced.
//
// The decision record is metadata only, one JSON object per line, appended
// as calls are decided and compacted (rewritten atomically) when it holds
// records older than the retention or more than its cap.

import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { RULES_SCHEMA, RuleError, checkStoredScope, isScopeId, LIMITS } from "./rules.js";

export const STORE_DIR = "clawtrate-tool-rules";
export const RULES_FILE = "rules.json";
export const DECISIONS_FILE = "decisions.jsonl";
const FORMAT = "clawtrate-tool-rules";
/** The largest rules file read; a full store of every scope is well under it. */
const MAX_RULES_BYTES = 8 * 1024 * 1024;

/** Kept this long, and at most this many, newest first. */
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_DECISIONS = 50_000;

/** A call id as the gateway's audit log writes it, so the two can be joined. */
export const hashCallId = (toolCallId) =>
  typeof toolCallId === "string" && toolCallId.length > 0
    ? `sha256:${createHash("sha256").update(toolCallId).digest("hex")}`
    : null;

/** Write `text` to `path` atomically: a temporary file, flushed and renamed over it. */
export function writeFileAtomic(dir, name, text) {
  const target = join(dir, name);
  const temp = join(dir, `.${name}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temp, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  try {
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Not every platform can flush a folder; the rename is still atomic.
  }
}

const statKey = (stat) =>
  stat ? `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` : "none";

function statOrNull(path) {
  try {
    return statSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * The rules store in `dir`. `scopes()` is the map the evaluator reads, or
 * null with `problem()` saying why when the file cannot be read.
 */
export class RulesStore {
  constructor(dir) {
    this.dir = dir;
    this.path = join(dir, RULES_FILE);
    this.seen = undefined;
    /** @type {{ scopes: Map<string, any> | null, problem: string | null }} */
    this.state = { scopes: null, problem: "not read yet" };
    /** Called after the rules on disk changed by anything but this store's own write. */
    this.onExternalChange = () => {};
  }

  /** Read the file again if it changed on disk. Never throws. */
  refresh() {
    let stat;
    try {
      stat = statOrNull(this.path);
    } catch (error) {
      this.seen = undefined;
      this.state = {
        scopes: null,
        problem: `the rules file cannot be read (${error.code ?? "error"})`,
      };
      return;
    }
    const key = statKey(stat);
    if (key === this.seen) return;
    const first = this.seen === undefined;
    this.seen = key;
    this.state = stat === null ? { scopes: new Map(), problem: null } : this.#read(stat);
    if (!first) this.onExternalChange();
  }

  #read(stat) {
    if (stat.size > MAX_RULES_BYTES) {
      return { scopes: null, problem: "the rules file is larger than the plugin reads" };
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (error) {
      return {
        scopes: null,
        problem:
          error instanceof SyntaxError
            ? "the rules file is not JSON"
            : `the rules file cannot be read (${error.code ?? "error"})`,
      };
    }
    try {
      return { scopes: parseRules(parsed), problem: null };
    } catch (error) {
      if (error instanceof RuleError) return { scopes: null, problem: error.message };
      throw error;
    }
  }

  scopes() {
    this.refresh();
    return this.state.scopes;
  }

  problem() {
    this.refresh();
    return this.state.problem;
  }

  /** Write `scopes` as the whole store, and take it as read. */
  write(scopes) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(this.dir, RULES_FILE, `${JSON.stringify(serializeRules(scopes), null, 2)}\n`);
    this.seen = statKey(statOrNull(this.path));
    this.state = { scopes, problem: null };
  }
}

export function serializeRules(scopes) {
  return {
    format: FORMAT,
    schema: RULES_SCHEMA,
    scopes: Object.fromEntries([...scopes].sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}

/** The scopes of a parsed rules file, checked as strictly as a `set`. Throws a RuleError. */
export function parseRules(parsed) {
  if (parsed === null || typeof parsed !== "object" || parsed.format !== FORMAT) {
    throw new RuleError("bad_store", "the rules file is not a rules store of this plugin");
  }
  if (parsed.schema !== RULES_SCHEMA) {
    throw new RuleError(
      "bad_store",
      `the rules file has schema ${JSON.stringify(parsed.schema)}; this plugin reads schema ${RULES_SCHEMA}`,
    );
  }
  const entries = Object.entries(parsed.scopes ?? {});
  if (entries.filter(([id]) => id !== "*").length > LIMITS.botScopes) {
    throw new RuleError("bad_store", "the rules file holds more bot scopes than the plugin allows");
  }
  const scopes = new Map();
  for (const [id, scope] of entries) {
    if (!isScopeId(id)) throw new RuleError("bad_store", `${id} is not a scope`);
    scopes.set(id, checkStoredScope(id, scope));
  }
  return scopes;
}

const DECISION_KEYS = [
  "id",
  "at",
  "agentId",
  "sessionKey",
  "runId",
  "callId",
  "tool",
  "decision",
  "source",
  "answer",
  "answeredAt",
];
const pick = (value) => Object.fromEntries(DECISION_KEYS.map((key) => [key, value[key] ?? null]));

/** A line of the decision record as stored, or null when it is not one. */
function parseLine(line) {
  try {
    const value = JSON.parse(line);
    if (value && typeof value === "object" && typeof value.id === "string") return value;
  } catch {
    // A torn last line, or one written by something else: not a record.
  }
  return null;
}

/**
 * The decision record in `dir`: metadata only, oldest first in memory. An
 * answer to an ask is appended as its own line and joined to its record by id.
 */
export class DecisionLog {
  constructor(dir, { now = Date.now, retentionMs = RETENTION_MS, max = MAX_DECISIONS } = {}) {
    this.dir = dir;
    this.path = join(dir, DECISIONS_FILE);
    this.now = now;
    this.retentionMs = retentionMs;
    this.max = max;
    this.records = [];
    this.byId = new Map();
    /** Lines in the file beyond one per record kept: answers, and records since dropped. */
    this.extraLines = 0;
    this.problem = null;
    this.#load();
  }

  #load() {
    let text;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.problem = `the decision record cannot be read (${error.code ?? "error"})`;
      }
      return;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      const value = parseLine(line);
      if (!value) {
        this.extraLines += 1;
      } else if (value.decision === undefined) {
        const record = this.byId.get(value.id);
        if (record)
          Object.assign(record, { answer: value.answer ?? null, answeredAt: value.at ?? null });
        this.extraLines += 1;
      } else {
        const record = pick(value);
        this.records.push(record);
        this.byId.set(record.id, record);
      }
    }
    this.#maintain();
  }

  /**
   * Drop records past the retention or the cap, oldest first, and rewrite the
   * file when it holds a fifth more lines than records kept.
   */
  #maintain() {
    const cutoff = this.now() - this.retentionMs;
    let drop = 0;
    while (drop < this.records.length && this.records[drop].at < cutoff) drop += 1;
    drop = Math.max(drop, this.records.length - this.max);
    if (drop > 0) {
      for (const record of this.records.slice(0, drop)) this.byId.delete(record.id);
      this.records = this.records.slice(drop);
      this.extraLines += drop;
    }
    const bloated = this.extraLines > 0 && this.extraLines >= this.records.length / 5;
    if (drop === 0 && !bloated) return;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const lines = this.records.map((record) => JSON.stringify(record));
      writeFileAtomic(this.dir, DECISIONS_FILE, lines.length > 0 ? `${lines.join("\n")}\n` : "");
      this.extraLines = 0;
    } catch (error) {
      this.problem = `the decision record cannot be written (${error.code ?? "error"})`;
    }
  }

  #append(value) {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      appendFileSync(this.path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      this.problem = null;
    } catch (error) {
      this.problem = `the decision record cannot be written (${error.code ?? "error"})`;
    }
  }

  /** Add a record; returns its id. */
  add(fields) {
    const record = { ...pick(fields), id: randomBytes(8).toString("hex"), at: this.now() };
    this.records.push(record);
    this.byId.set(record.id, record);
    this.#append(record);
    if (this.records.length > this.max || this.records[0].at < this.now() - this.retentionMs) {
      this.#maintain();
    }
    return record.id;
  }

  /** Record the answer to an ask: the decision word the gateway gave the plugin, nothing else. */
  answer(id, answer) {
    const record = this.byId.get(id);
    if (!record) return;
    const at = this.now();
    Object.assign(record, { answer, answeredAt: at });
    this.#append({ id, answer, at });
    this.extraLines += 1;
    if (this.extraLines >= this.records.length / 5) this.#maintain();
  }

  /**
   * Records newest first, filtered: `agentId`, `sessionKey`, `runId`,
   * `before` (a time, exclusive), at most `limit`.
   * @param {{ agentId?: string, sessionKey?: string, runId?: string, before?: number, limit: number }} filter
   */
  list({ agentId, sessionKey, runId, before, limit }) {
    const cutoff = this.now() - this.retentionMs;
    const out = [];
    let hasMore = false;
    for (let i = this.records.length - 1; i >= 0; i -= 1) {
      const record = this.records[i];
      if (record.at < cutoff) break;
      if (before !== undefined && record.at >= before) continue;
      if (agentId !== undefined && record.agentId !== agentId) continue;
      if (sessionKey !== undefined && record.sessionKey !== sessionKey) continue;
      if (runId !== undefined && record.runId !== runId) continue;
      if (out.length === limit) {
        hasMore = true;
        break;
      }
      out.push({ ...record });
    }
    return { records: out, hasMore };
  }
}
