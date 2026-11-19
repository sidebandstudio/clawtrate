// The plugin's own files, in a folder of its own in the gateway's state
// folder: the rules (rules.json) and the decision record (decisions.jsonl).
//
// The rules file is written whole and atomically: a temporary file in the
// same folder, flushed, then renamed over the old one, and the folder
// flushed. It is read again whenever it changes on disk (by its size,
// modification time and inode), and checked as strictly as a `set`. A file
// that cannot be used is a lost policy, never an empty one (RulesStore).
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
  truncateSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  RULES_SCHEMA,
  RuleError,
  checkStoredScope,
  holdsRules,
  isScopeId,
  LIMITS,
} from "./rules.js";

export const STORE_DIR = "clawtrate-tool-rules";
export const RULES_FILE = "rules.json";
export const DECISIONS_FILE = "decisions.jsonl";
const FORMAT = "clawtrate-tool-rules";
/** The largest rules file read, and so the largest written. */
export const MAX_RULES_BYTES = 8 * 1024 * 1024;

/** Kept this long, and at most this many, newest first. */
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_DECISIONS = 50_000;
/** The largest decision record read at start; 50,000 records are well under it. */
export const MAX_DECISIONS_BYTES = 64 * 1024 * 1024;

/** A call id as the gateway's audit log writes it, so the two can be joined. */
export const hashCallId = (toolCallId) =>
  typeof toolCallId === "string" && toolCallId.length > 0
    ? `sha256:${createHash("sha256").update(toolCallId).digest("hex")}`
    : null;

/** Write every byte of `bytes` to `fd`, or throw: a write that makes no progress fails. */
function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (!Number.isInteger(written) || written <= 0) {
      throw Object.assign(new Error("a write made no progress"), { code: "EIO" });
    }
    offset += written;
  }
}

/**
 * Write `text` to `path` atomically: a temporary file, written whole and
 * flushed, then renamed over it. Anything short of that throws before the
 * rename, so the old file stays as it was.
 */
export function writeFileAtomic(dir, name, text) {
  const target = join(dir, name);
  const temp = join(dir, `.${name}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeAll(fd, Buffer.from(text, "utf8"));
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
 * The rules store in `dir`, in one of three states, never confused:
 *
 *   none   there is no rules file: nothing was ever saved, nothing to enforce
 *   read   the file was read and checked: its rules are enforced
 *   lost   a file is there (or was, in this process) and cannot be used:
 *          unreadable, too large, another schema, or not a valid store. The
 *          last good copy this process read, if any, is kept and enforced;
 *          with none, the plugin asks before every call
 *
 * `view()` is the state now. `onStateChange` is called on every change of
 * state or of its reason, `onExternalChange` when the file changed by
 * anything but this store's own write.
 */
export class RulesStore {
  constructor(dir, { now = Date.now } = {}) {
    this.dir = dir;
    this.path = join(dir, RULES_FILE);
    this.now = now;
    this.seen = undefined;
    /** The fingerprint last looked at, read or not; `seen` is the one last read. */
    this.observed = undefined;
    /** The last rules this process read or wrote, with when. */
    this.good = null;
    /** @type {{ kind: "none" | "read" | "lost" | "unread", scopes: Map<string, any> | null, readAt: number | null, problem: string | null }} */
    this.state = { kind: "unread", scopes: null, readAt: null, problem: null };
    this.onExternalChange = () => {};
    /** @type {(next: ReturnType<RulesStore["view"]>, before: { kind: string, problem: string | null }) => void} */
    this.onStateChange = () => {};
  }

  #set(state, external) {
    const before = this.state;
    this.state = state;
    if (state.kind === "read") this.good = { scopes: state.scopes, readAt: state.readAt };
    if (before.kind !== state.kind || before.problem !== state.problem) {
      this.onStateChange(this.#view(), { kind: before.kind, problem: before.problem });
    }
    if (external) this.onExternalChange();
  }

  #lost(problem) {
    return { kind: "lost", scopes: null, readAt: null, problem };
  }

  /** Read the file again if it changed on disk. Never throws. */
  refresh() {
    let stat;
    try {
      stat = statOrNull(this.path);
    } catch (error) {
      const changed = this.seen !== "error";
      this.seen = "error";
      this.observed = "error";
      if (changed) {
        this.#set(this.#lost(`the rules file cannot be read (${error.code ?? "error"})`), true);
      }
      return;
    }
    const key = statKey(stat);
    if (key === this.seen) return;
    const first = this.seen === undefined && this.observed === undefined;
    // The file changed since it was last looked at, not only since it was last read.
    const external = !first && key !== this.observed;
    this.seen = key;
    this.observed = key;
    let next;
    // No file: nothing was saved, unless this process read rules from one or knew them lost.
    if (stat !== null) {
      next = this.#read(stat);
    } else if (this.good || this.state.kind === "lost") {
      next = this.#lost("the rules file is gone");
    } else {
      next = { kind: "none", scopes: new Map(), readAt: null, problem: null };
    }
    // A read that failed with an I/O error is tried again at the next refresh;
    // contents that were read and found invalid are remembered until the file changes.
    if (next.retry) this.seen = undefined;
    const { retry: _retry, ...state } = next;
    this.#set(state, external);
  }

  #read(stat) {
    if (!stat.isFile()) return this.#lost("the rules file is not a file");
    if (stat.size > MAX_RULES_BYTES) {
      return this.#lost("the rules file is larger than the plugin reads");
    }
    let text;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      return {
        ...this.#lost(`the rules file cannot be read (${error.code ?? "error"})`),
        retry: true,
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return this.#lost("the rules file is not JSON");
    }
    try {
      return { kind: "read", scopes: parseRules(parsed), readAt: this.now(), problem: null };
    } catch (error) {
      if (error instanceof RuleError) return this.#lost(error.message);
      throw error;
    }
  }

  #view() {
    const { kind, scopes, readAt, problem } = this.state;
    if (kind !== "lost") return { kind, scopes, enforced: scopes, readAt, problem, kept: null };
    return {
      kind,
      scopes: null,
      // The rules enforced while lost: the last good copy, or none (ask every call).
      enforced: this.good?.scopes ?? null,
      readAt: null,
      problem,
      kept: this.good ? { readAt: this.good.readAt } : null,
    };
  }

  /** The state now, after looking at the file. */
  view() {
    this.refresh();
    return this.#view();
  }

  /** The rules as read now: an empty map with no file, null when they are lost. */
  scopes() {
    return this.view().scopes;
  }

  problem() {
    return this.view().problem;
  }

  /**
   * Write `scopes` as the whole store, and take it as read. A store the
   * reader would refuse is not written: a RuleError, and nothing changes on
   * disk or in memory.
   */
  write(scopes) {
    const text = `${JSON.stringify(serializeRules(scopes), null, 2)}\n`;
    const size = Buffer.byteLength(text, "utf8");
    if (size > MAX_RULES_BYTES) {
      throw new RuleError(
        "store_too_large",
        `the rules would take ${size} bytes, more than the ${MAX_RULES_BYTES} the plugin reads; nothing was saved`,
        { limit: MAX_RULES_BYTES, size },
      );
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(this.dir, RULES_FILE, text);
    // Written, but not read: another writer can replace the file between the
    // rename and any look at it, so the next look reads the file installed.
    this.seen = undefined;
    try {
      this.observed = statKey(statOrNull(this.path));
    } catch {
      this.observed = undefined;
    }
    this.#set({ kind: "read", scopes, readAt: this.now(), problem: null }, false);
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
  // The envelope exactly: a missing or malformed `scopes` is not an empty store.
  if (Object.keys(parsed).sort().join() !== "format,schema,scopes") {
    throw new RuleError("bad_store", "the rules file is not a valid rules store");
  }
  const raw = parsed.scopes;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RuleError("bad_store", "the rules file's scopes are not a valid rules store");
  }
  const entries = Object.entries(raw);
  if (entries.length > LIMITS.scopeEntries) {
    throw new RuleError("bad_store", "the rules file holds more scopes than the plugin allows");
  }
  const scopes = new Map();
  for (const [id, scope] of entries) {
    if (!isScopeId(id)) throw new RuleError("bad_store", `${id} is not a scope`);
    scopes.set(id, checkStoredScope(id, scope));
  }
  if (
    [...scopes].filter(([id, scope]) => id !== "*" && holdsRules(scope)).length > LIMITS.botScopes
  ) {
    throw new RuleError("bad_store", "the rules file holds more bot scopes than the plugin allows");
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
  /** The rules' state when the call was decided: none, read, kept (a copy) or lost. */
  "rules",
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
    /** Where a record too large to read at start is set aside, for thirty days. */
    this.oversizePath = `${this.path}.oversize`;
    this.now = now;
    this.retentionMs = retentionMs;
    this.max = max;
    this.records = [];
    this.byId = new Map();
    /** Lines in the file beyond one per record kept: answers, and records since dropped. */
    this.extraLines = 0;
    this.expiryPending = false;
    /** A torn last line still to repair: "end", the byte length to keep, or null. */
    this.tornTail = null;
    /** Records and answers kept in memory that a failed write left off the disk. */
    this.unsaved = 0;
    this.problem = null;
    this.#load();
  }

  #load() {
    let text;
    try {
      // A file past the cap is not read into memory: it is set aside, and a new one started.
      if (statSync(this.path).size > MAX_DECISIONS_BYTES) {
        renameSync(this.path, this.oversizePath);
        // Stamped with when it was set aside, which its removal counts from.
        const asideAt = this.now() / 1000;
        utimesSync(this.oversizePath, asideAt, asideAt);
        this.problem = `the decision record was larger than ${MAX_DECISIONS_BYTES} bytes; it was set aside as ${DECISIONS_FILE}.oversize and a new one started`;
        return;
      }
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.problem = `the decision record cannot be read (${error.code ?? "error"})`;
      }
      return;
    }
    // A last line with no newline was torn by a write that did not finish: cut
    // it (or end it, if it is whole) before anything is appended after it.
    if (text.length > 0 && !text.endsWith("\n")) {
      const cut = text.lastIndexOf("\n") + 1;
      const whole = parseLine(text.slice(cut)) !== null;
      this.tornTail = whole ? "end" : Buffer.byteLength(text.slice(0, cut));
      if (this.#repairTail() && !whole) text = text.slice(0, cut);
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
    this.prune();
    this.#maintain();
  }

  /**
   * Drop records past the retention or the cap, oldest first, and rewrite the
   * file when it holds a fifth more lines than records kept.
   */
  #maintain(force = false) {
    const cutoff = this.now() - this.retentionMs;
    let drop = 0;
    while (drop < this.records.length && this.records[drop].at < cutoff) drop += 1;
    this.expiryPending ||= drop > 0;
    drop = Math.max(drop, this.records.length - this.max);
    if (drop > 0) {
      for (const record of this.records.slice(0, drop)) this.byId.delete(record.id);
      this.records = this.records.slice(drop);
      this.extraLines += drop;
    }
    // Rewritten only when asked (expiry) or when the file holds a fifth more
    // lines than records kept, never once per append.
    const bloated = this.extraLines > 0 && this.extraLines >= this.records.length / 5;
    if (!bloated && !force && !this.expiryPending) return;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const lines = this.records.map((record) => JSON.stringify(record));
      writeFileAtomic(this.dir, DECISIONS_FILE, lines.length > 0 ? `${lines.join("\n")}\n` : "");
      this.extraLines = 0;
      this.tornTail = null;
      this.unsaved = 0;
      this.expiryPending = false;
      this.problem = null;
    } catch (error) {
      this.problem = `the decision record cannot be written (${error.code ?? "error"})`;
    }
  }

  /**
   * End or cut a torn last line (`tornTail`: "end", or the byte length to keep).
   * On failure, nothing is appended after it, and `status` says so.
   */
  #repairTail() {
    if (this.tornTail === null) return true;
    try {
      if (this.tornTail === "end") appendFileSync(this.path, "\n");
      else truncateSync(this.path, this.tornTail);
      this.tornTail = null;
      return true;
    } catch (error) {
      this.problem = `the decision record's last line is torn and could not be repaired (${error.code ?? "error"}); nothing is appended after it`;
      return false;
    }
  }

  /**
   * Append one line. While anything is not on disk (a failed write, a torn
   * line that could not be cut), nothing is appended: the whole retained set
   * is written instead, and the problem is cleared only when that succeeds.
   */
  #append(value) {
    if (this.unsaved > 0 || !this.#repairTail()) {
      this.unsaved += 1;
      this.#maintain(true);
      return;
    }
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      appendFileSync(this.path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      if (!this.expiryPending) this.problem = null;
    } catch (error) {
      this.unsaved += 1;
      this.problem = `the decision record cannot be written (${error.code ?? "error"})`;
    }
  }

  /**
   * Drop the records past the retention from memory and from the file now,
   * whether or not any call is being made.
   */
  prune() {
    const cutoff = this.now() - this.retentionMs;
    this.#pruneOversize(cutoff);
    if (this.expiryPending || (this.records.length > 0 && this.records[0].at < cutoff)) {
      this.#maintain(true);
    }
  }

  /** Remove a record set aside as oversized once it was set aside before `cutoff`. */
  #pruneOversize(cutoff) {
    try {
      if (statSync(this.oversizePath).mtimeMs < cutoff) rmSync(this.oversizePath, { force: true });
    } catch {
      // None set aside, or it cannot be looked at: the next prune looks again.
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
   * `before` (a time, exclusive), at most `limit`. `cursor` is a record's id,
   * from a page's `nextCursor`: the page goes on after that record in the
   * list's own order, so records of the same millisecond are not skipped. A
   * cursor whose record has left the record names nothing older: an empty page.
   * @param {{ agentId?: string, sessionKey?: string, runId?: string, before?: number, cursor?: string, limit: number }} filter
   */
  list({ agentId, sessionKey, runId, before, cursor, limit }) {
    const cutoff = this.now() - this.retentionMs;
    const out = [];
    let hasMore = false;
    let start = this.records.length - 1;
    if (cursor !== undefined) {
      const after = this.byId.get(cursor);
      start = after ? this.records.lastIndexOf(after) - 1 : -1;
    }
    for (let i = start; i >= 0; i -= 1) {
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
    return { records: out, hasMore, ...(hasMore ? { nextCursor: out.at(-1).id } : {}) };
  }
}
