// Where each run came from, and whether it has read anything from outside
// (docs/design/bots-in-clawtrate.md, sections 4.1 and 4.3). In memory only, and
// bounded: a run this store doesn't hold is never the person's ask.
//
// What the gateway tells a plugin, on every OpenClaw version this build knows:
//   before_prompt_build   once per model request of a run: its run id, session,
//                         bot, trigger, channel, workspace and the provenance of
//                         its input (needs hooks.allowConversationAccess)
//   before_model_resolve  the run's attachments (the same access)
//   before_tool_call      every tool call: its run id, call id and requester
//                         (channel, senderIsOwner); needs no access
//   before_message_write  a message that joins a run already under way
//   after_tool_call       the session a `sessions_spawn` or `sessions_create`
//                         made: every run in it is a task (C), and carries
//                         what the run that started it had read

export const KNOWN_VERSIONS = Object.freeze(["2026.10.6", "2026.11.10", "2026.11.11"]);

export const LIMITS = Object.freeze({
  /** Runs held at once. When full, ended runs leave first; a new run past the bound isn't held. */
  runs: 512,
  /** How long a run is held after it was last seen. */
  runMs: 24 * 60 * 60 * 1000,
  /** Tool calls remembered for the tools' own lookup (2026.10.6 gives a tool no run id). */
  calls: 2048,
  /** Runs dropped, or never seen starting, remembered so they don't come back as new while remembered. */
  lost: 512,
  /** Sessions a bot's own call made (tasks), remembered so their runs are C. */
  tasks: 512,
  /** How long a spawn waits for its task's first run before its session is known. */
  spawnWaitMs: 60_000,
  /** Spawns waiting for their task's first run, across every bot, and their read snapshots. */
  spawning: 64,
});

/**
 * Where a run came from, as the plugin's own fields tell it. `typed` is
 * "typed on the gateway's own chat channel": necessary for the person's ask,
 * never enough (only the device's record of what it sent can make it so).
 */
export const KINDS = Object.freeze([
  "typed",
  "chat-app",
  "bot-message",
  "task",
  "report",
  "routine",
  "check-in",
  "command-line",
  "unknown",
]);

/** What the source of outside content is called in a line ("after reading …"). */
export const SOURCES = Object.freeze({
  web: "a web page",
  file: "a file",
  command: "a command's output",
  task: "a task's history",
  reply: "another bot's reply",
  tasks: "its list of tasks",
  titles: "a task's title a bot gave",
  names: "a name a bot may have chosen",
  attachment: "a file sent with the message",
  message: "a message from another bot",
  steer: "a message that joined the run",
  tool: "a tool's result",
  lost: "something Clawtrate lost track of",
});

/**
 * Tools whose result is not outside content (4.3): `ask_user` (the person's
 * answer), `progress_card` (the bot's own plan) and the acceptance of
 * `sessions_spawn`. Tool Search's `tool_search` and `tool_describe` return the
 * catalog's own names and schemas, which a run without tool search has in its
 * prompt. The wrappers `tool_call` (`dispatch_action` on 2026.11.10) and Code Mode's `exec` and `wait` are
 * decided by the calls they make, each of which reaches the hook itself.
 * Clawtrate's own tools say themselves whether their answer is outside content.
 */
const NOT_OUTSIDE = new Set([
  "ask_user",
  "progress_card",
  "sessions_spawn",
  "tool_search",
  "tool_describe",
  "tool_call",
  "dispatch_action",
]);
const CODE_MODE_TOOLS = new Set(["exec", "wait"]);

/** The source a tool's result is named by. */
export function sourceOf(toolName) {
  const name = String(toolName ?? "").toLowerCase();
  if (/^(web_|x_search|browser|dir_fetch|file_fetch)/.test(name)) return "web";
  if (["read", "ls", "memory_get", "memory_search", "pdf", "view_image", "dir_list"].includes(name))
    return "file";
  if (["exec", "process", "bash", "code_execution"].includes(name)) return "command";
  if (name === "sessions_history" || name === "subagents") return "task";
  if (name === "sessions_send" || name === "conversations_send" || name === "conversations_turn")
    return "reply";
  if (name === "sessions_list" || name === "conversations_list") return "tasks";
  return "tool";
}

/** Whether a call's result counts as read from outside, by the call as the hook sees it. */
export function readsOutside(event) {
  const name = String(event?.toolName ?? "").toLowerCase();
  if (NOT_OUTSIDE.has(name)) return false;
  if (CODE_MODE_TOOLS.has(name) && event?.toolKind === "code_mode_exec") return false;
  if (name.startsWith("clawtrate_")) return false;
  return true;
}

const str = (v) => (typeof v === "string" && v.length > 0 ? v : null);

/**
 * What a run had read, for a task it starts: its first source, or `lost` when
 * the plugin doesn't hold the run (it may have read anything), or null.
 */
function readOf(run) {
  if (!run || run.lost) return { source: "lost", tool: null };
  return run.readOutside ? { source: run.readOutside.source, tool: run.readOutside.tool } : null;
}

/** A run's kind from what before_prompt_build saw (4.1's table). */
export function kindOf(facts) {
  const provenance = facts.provenance;
  if (facts.trigger === "cron") return "routine";
  if (facts.trigger === "heartbeat") return "check-in";
  // A task a bot started: by its session's form (a hidden task, both versions),
  // or because the plugin saw the call that made the session.
  if (facts.task || /^agent:[^:]+:subagent:/i.test(facts.sessionKey ?? "")) return "task";
  if (provenance && provenance.kind !== "external_user") {
    if (provenance.kind === "inter_session") {
      if (provenance.sourceTool === "sessions_spawn") return "task";
      if (provenance.sourceTool === "subagent_announce") return "report";
      return "bot-message";
    }
    return "unknown";
  }
  if (facts.trigger !== "user") return "unknown";
  if (facts.channel === null) return "command-line";
  if (facts.channel === "webchat") return "typed";
  return "chat-app";
}

/**
 * The origin of one call, for the holds (section 3.3's columns). Never A in
 * this build: A needs the device's record of what it sent (design step 3),
 * so a run typed here is B. `O` is the owner in a chat app.
 *   { origin: "B" | "O" | "C", read: source | null, kind, why }
 */
export function originOf(run, requester, { versionKnown }) {
  // A run the plugin can't vouch for may have read anything: C, with read on.
  if (!versionKnown) return { origin: "C", read: "lost", kind: "unknown", why: "version" };
  if (!run || run.lost) return { origin: "C", read: "lost", kind: "unknown", why: "unknown-run" };
  const read = run.readOutside?.source ?? null;
  if (run.kind === "typed") {
    // The gateway's own channel says every admin connection is the owner, so
    // senderIsOwner decides nothing here; and a requester on another channel
    // than the run's is not this run's.
    if (requester?.channel !== undefined && requester.channel !== "webchat")
      return { origin: "C", read, kind: run.kind, why: "requester" };
    return { origin: "B", read, kind: run.kind, why: "unconfirmed" };
  }
  if (run.kind === "chat-app") {
    const sameChannel = requester?.channel === run.channel;
    if (sameChannel && requester?.senderIsOwner === true)
      return { origin: "O", read, kind: run.kind, why: "owner" };
    return { origin: "C", read, kind: run.kind, why: "not-owner" };
  }
  return { origin: "C", read, kind: run.kind, why: run.kind };
}

/** The run facts this store keeps, from before_prompt_build's context. */
function factsFrom(ctx) {
  const p = ctx?.inputProvenance;
  return {
    sessionKey: str(ctx?.sessionKey),
    agentId: str(ctx?.agentId),
    trigger: str(ctx?.trigger),
    channel: str(ctx?.channel),
    workspaceDir: str(ctx?.workspaceDir),
    jobId: str(ctx?.jobId),
    provenance:
      p && typeof p === "object" && str(p.kind)
        ? {
            kind: p.kind,
            sourceTool: str(p.sourceTool),
            sourceSessionKey: str(p.sourceSessionKey),
          }
        : null,
  };
}

/** @typedef {{ runs: number, runMs: number, calls: number, lost: number, tasks: number, spawnWaitMs: number, spawning: number }} Limits */

export class RunOrigins {
  /** @param {{ now?: () => number, limits?: Limits }} [options] */
  constructor({ now = () => Date.now(), limits = LIMITS } = {}) {
    this.now = now;
    this.limits = limits;
    /** runId -> run */
    this.runs = new Map();
    /** `${sessionKey}\0${toolCallId}` -> runId, for a tool that isn't told its run */
    this.calls = new Map();
    /** runIds dropped while under way */
    this.lost = new Set();
    /** sessionKey -> the run under way in it */
    this.active = new Map();
    /** runIds whose message came with files, seen before the run's first prompt */
    this.attached = new Set();
    /** session key -> what the run that made it had read: a task's session */
    this.tasks = new Map();
    /** bot -> spawns whose session isn't known yet: { read, at, callId, from } */
    this.spawning = new Map();
    /**
     * When the lost set last forgot a run to make room. For a day after that,
     * a run the store hasn't seen can't be told from one it forgot, so a new run
     * is admitted as having read something it lost track of.
     */
    this.lostForgotAt = null;
    /** `${session}\0${callId}` -> what a spawn's starter had read as the call passed */
    this.snapshots = new Map();
    /** When a live spawn wait was last dropped at the bound (taskOf). */
    this.spawnDroppedAt = null;
  }

  /** Whether the store may have forgotten a lost run, so a new one can't be vouched for. */
  forgetting() {
    return this.lostForgotAt !== null && this.now() - this.lostForgotAt < this.limits.runMs;
  }

  /**
   * Every record held is no longer one the plugin can vouch for: conversation
   * access changed, or the config was written while runs were under way (an
   * access change may be among the writes). Each held run, each task session and
   * each spawn waiting for its first run counts as having lost track of what it read.
   */
  invalidate() {
    const lost = { source: "lost", tool: null };
    for (const run of this.runs.values()) {
      run.lost = true;
      run.readOutside = { ...lost, at: this.now() };
    }
    for (const key of this.tasks.keys()) this.tasks.set(key, lost);
    for (const list of this.spawning.values()) for (const w of list) w.read = lost;
    for (const key of this.snapshots.keys()) this.snapshots.set(key, lost);
  }

  /** before_prompt_build: a run starts (its first model request) or goes on. */
  sawPrompt(ctx) {
    const runId = str(ctx?.runId);
    if (!runId) return null;
    const known = this.runs.get(runId);
    if (known) {
      // A run unseen past the retention is lost, as a lookup would find it, not refreshed.
      if (known.lastSeenAt <= this.now() - this.limits.runMs) {
        this.sweep();
        return null;
      }
      known.lastSeenAt = this.now();
      return known;
    }
    // A run this store dropped, refused or saw only mid-way doesn't come back as
    // new while it is remembered (the last LIMITS.lost): whatever it had read is gone with it.
    if (this.lost.has(runId)) return null;
    const facts = factsFrom(ctx);
    const parent = this.taskOf(facts);
    facts.task = parent !== undefined;
    const maybe = facts.task ? null : this.maybeTaskOf(facts);
    // No positive evidence that this is the run's start while a lost run may
    // have been forgotten: it may be that run, back, with nothing it read.
    const unsure = this.forgetting() ? { source: "lost", tool: null } : null;
    const run = {
      runId,
      ...facts,
      kind: kindOf(facts),
      readOutside: parent
        ? { ...parent, at: this.now() }
        : unsure
          ? { ...unsure, at: this.now() }
          : null,
      attachments: false,
      steers: 0,
      ended: false,
      lost: false,
      maybe,
      firstSeenAt: this.now(),
      lastSeenAt: this.now(),
    };
    if (!this.admit(run)) {
      this.remember(this.lost, runId, this.limits.lost);
      return null;
    }
    if (run.sessionKey) this.active.set(run.sessionKey, runId);
    if (this.attached.delete(runId)) {
      run.attachments = true;
      this.markRead(run, "attachment", null);
    }
    return run;
  }

  /**
   * Whether a run's session is a task a bot's own call made, and what the run
   * that made it had read (null for nothing): undefined when it isn't one.
   * Only a session a spawn's result named, or a hidden task's, is one; a run
   * that may be an unnamed spawn's child is pending instead (maybeTaskOf).
   */
  taskOf(facts) {
    const key = facts.sessionKey;
    return key && this.tasks.has(key) ? this.tasks.get(key) : undefined;
  }

  /**
   * Whether a new run might be the child of a spawn whose result hasn't named
   * it yet: a run of that bot, in any session but its main one, started while
   * one of its spawns waits (or within the minute after a live wait was dropped
   * at the bound). Arrival order names nothing, so no wait is consumed: the run
   * is pending, C with something lost (pending()), until no wait it could belong
   * to is left; the result that names the child makes that session the task.
   */
  maybeTaskOf(facts) {
    const key = facts.sessionKey;
    if (!key || /^agent:[^:]+:main$/i.test(key) || facts.trigger !== "user") return null;
    const cutoff = this.now() - this.limits.spawnWaitMs;
    const waits = (facts.agentId ? (this.spawning.get(facts.agentId) ?? []) : [])
      .filter((w) => w.at > cutoff)
      .map((w) => w.id);
    const until =
      this.spawnDroppedAt !== null && this.spawnDroppedAt > cutoff
        ? this.spawnDroppedAt + this.limits.spawnWaitMs
        : 0;
    return waits.length || until ? { waits, until } : null;
  }

  /** Whether a run may still be an unnamed spawn's child (maybeTaskOf). */
  pending(run) {
    const maybe = run?.maybe;
    if (!maybe || run.task) return false;
    if (this.now() < maybe.until) return true;
    const cutoff = this.now() - this.limits.spawnWaitMs;
    for (const list of this.spawning.values())
      for (const w of list) if (w.at > cutoff && maybe.waits.includes(w.id)) return true;
    return false;
  }

  rememberTask(key, read) {
    this.tasks.delete(key);
    this.tasks.set(key, read);
    while (this.tasks.size > this.limits.tasks) this.tasks.delete(this.tasks.keys().next().value);
  }

  /**
   * A call that makes a task (`sessions_spawn`, `sessions_create`) passed: its first run is a task.
   * @param {string | null | undefined} [callId]
   * @param {string | null | undefined} [from] the session the call was made in
   */
  sawSpawn(run, bot, callId = null, from = null) {
    if (!bot) return;
    const read = readOf(run);
    const wait = {
      id: (this.waitIds = (this.waitIds ?? 0) + 1),
      read,
      at: this.now(),
      callId: str(callId),
      from: str(from),
      runId: run?.runId ?? null,
    };
    // What the starter had read as the call passed, kept until its result names the task.
    if (wait.callId)
      this.remember(this.snapshots, `${wait.from}\0${wait.callId}`, this.limits.spawning, read);
    // Expired waits leave, across every bot; past the bound the oldest live one is
    // dropped, and the minute after counts every new run as a lost task (taskOf).
    const cutoff = this.now() - this.limits.spawnWaitMs;
    for (const [key, list] of this.spawning) {
      const live = list.filter((w) => w.at > cutoff);
      if (live.length) this.spawning.set(key, live);
      else this.spawning.delete(key);
    }
    this.spawning.set(bot, [...(this.spawning.get(bot) ?? []), wait]);
    let total = 0;
    for (const list of this.spawning.values()) total += list.length;
    while (total > this.limits.spawning) {
      let oldest = null;
      for (const [key, list] of this.spawning)
        if (list.length && (!oldest || list[0].at < oldest.w.at)) oldest = { key, w: list[0] };
      if (!oldest) break;
      const left = this.spawning.get(oldest.key).slice(1);
      if (left.length) this.spawning.set(oldest.key, left);
      else this.spawning.delete(oldest.key);
      this.spawnDroppedAt = this.now();
      total -= 1;
    }
  }

  /**
   * A task-making call's result came back: its wait for a first run is over.
   * A call id is the model's and may repeat across sessions, so the wait ended
   * is the one that call made from that session.
   * @param {string | null | undefined} callId
   * @param {string | null | undefined} [from] the session the call was made in
   */
  dropSpawn(callId, from = null) {
    const id = str(callId);
    if (!id) return;
    const session = str(from);
    this.snapshots.delete(`${session}\0${id}`);
    for (const [bot, list] of this.spawning) {
      const left = list.filter((w) => w.callId !== id || w.from !== session);
      if (left.length === list.length) continue;
      if (left.length) this.spawning.set(bot, left);
      else this.spawning.delete(bot);
    }
  }

  /**
   * The session that call made, from its result: every run in it is a task,
   * those already started included, and carries what the starting run had read.
   * @param {string | null | undefined} [callId]
   * @param {string | null | undefined} [from] the session the call was made in
   */
  sawSpawned(run, sessionKey, callId = null, from = null) {
    if (!sessionKey) return;
    // What the starter had read when the call passed, not since; with no snapshot, lost.
    const snapshot = `${str(from)}\0${str(callId)}`;
    const read = this.snapshots.has(snapshot)
      ? this.snapshots.get(snapshot)
      : { source: "lost", tool: null };
    this.dropSpawn(callId, from);
    this.rememberTask(sessionKey, read);
    for (const held of this.runs.values()) {
      if (held.sessionKey !== sessionKey) continue;
      held.kind = "task";
      held.task = true;
      held.maybe = null;
      if (read && !held.readOutside) held.readOutside = { ...read, at: this.now() };
    }
  }

  /** Room for one more run: expired runs leave, then ended ones; else it isn't held. */
  admit(run) {
    this.sweep();
    if (this.runs.size >= this.limits.runs) {
      for (const [id, held] of this.runs) {
        if (!held.ended) continue;
        this.runs.delete(id);
        break;
      }
    }
    if (this.runs.size >= this.limits.runs) return false;
    this.runs.set(run.runId, run);
    return true;
  }

  /** Runs not seen for a day leave; one still under way is remembered as lost. */
  sweep() {
    const cutoff = this.now() - this.limits.runMs;
    for (const [id, run] of this.runs) {
      if (run.lastSeenAt > cutoff) continue;
      this.runs.delete(id);
      if (!run.ended) this.remember(this.lost, id, this.limits.lost);
      if (run.sessionKey && this.active.get(run.sessionKey) === id)
        this.active.delete(run.sessionKey);
    }
  }

  /** Adds to a bounded set (or, with an entry, a bounded map), oldest first out. */
  remember(set, value, max, entry = undefined) {
    if (set instanceof Map) {
      set.delete(value);
      set.set(value, entry);
    } else set.add(value);
    while (set.size > max) {
      set.delete(set.keys().next().value);
      if (set === this.lost) this.lostForgotAt = this.now();
    }
  }

  /** before_model_resolve: a message that came with files. */
  sawAttachments(ctx, event) {
    const runId = str(ctx?.runId);
    if (!runId || !Array.isArray(event?.attachments) || event.attachments.length === 0) return;
    const run = this.runs.get(runId);
    if (!run) {
      // Model resolution comes before the run's first prompt.
      this.remember(this.attached, runId, this.limits.lost);
      return;
    }
    run.attachments = true;
    this.markRead(run, "attachment", null);
  }

  /**
   * before_message_write: a person's or another session's message written
   * into a session while a run is under way joins that run (a steer). One no
   * person typed (another bot's, the system's) is outside content for it. So
   * is any steer into a chat app's run: in a shared chat it may be anyone's,
   * and no record will ever tell. A steer into a typed run is counted for
   * Clawtrate's own record, which will tell whether its device sent it.
   */
  sawMessage(event, ctx) {
    const message = event?.message;
    if (message?.role !== "user") return;
    const sessionKey = str(event?.sessionKey) ?? str(ctx?.sessionKey);
    const runId = sessionKey ? this.active.get(sessionKey) : undefined;
    const run = runId ? this.runs.get(runId) : undefined;
    if (!run || run.ended) return;
    const provenance = message.provenance;
    const kind = provenance?.kind;
    if (kind && kind !== "external_user") {
      // The run's own first message carries the run's own provenance (the
      // same kind, from the same session and tool), which already makes it C;
      // any other, another bot's or the system's, is a message that joined it.
      const own = run.provenance;
      if (
        own?.kind === kind &&
        own.sourceSessionKey === str(provenance.sourceSessionKey) &&
        own.sourceTool === str(provenance.sourceTool)
      )
        return;
      this.markRead(run, "message", null);
      return;
    }
    run.steers += 1;
    if (run.kind === "chat-app") this.markRead(run, "steer", null);
  }

  /** before_tool_call: which run the call is in, remembered for the tool's own lookup. */
  sawCall(event, ctx) {
    const runId = str(event?.runId) ?? str(ctx?.runId);
    const sessionKey = str(ctx?.sessionKey);
    const callId = str(event?.toolCallId) ?? str(ctx?.toolCallId);
    if (runId && sessionKey && callId) {
      this.calls.set(`${sessionKey}\0${callId}`, runId);
      while (this.calls.size > this.limits.calls) this.calls.delete(this.calls.keys().next().value);
    }
    return runId ? this.seen(runId) : null;
  }

  /**
   * A run a call or a result names: held, or lost. A run neither held nor lost
   * started before the plugin saw it (loaded, enabled or given conversation
   * access mid-way): it is lost from now on, so it doesn't come back as new
   * while it is remembered (the last LIMITS.lost lost runs).
   */
  seen(runId) {
    const run = this.lookup(runId);
    if (run) return run;
    this.remember(this.lost, runId, this.limits.lost);
    return { runId, kind: "unknown", lost: true };
  }

  /** A held run, or a lost one as `{ lost: true }`, or null. */
  lookup(runId) {
    const run = this.runs.get(runId);
    if (run) {
      if (run.lastSeenAt <= this.now() - this.limits.runMs) {
        this.sweep();
        return this.lost.has(runId) ? { runId, kind: "unknown", lost: true } : null;
      }
      return run;
    }
    return this.lost.has(runId) ? { runId, kind: "unknown", lost: true } : null;
  }

  /** The latest run held for a session, if any. */
  latestIn(sessionKey) {
    let found = null;
    for (const run of this.runs.values())
      if (run.sessionKey === sessionKey && (!found || run.firstSeenAt >= found.firstSeenAt))
        found = run;
    return found;
  }

  /**
   * The run a tool call belongs to, for a tool: by its own run id, else by session and call id.
   * @param {{ runId?: string, sessionKey?: string, toolCallId?: string }} call
   */
  runForTool({ runId, sessionKey, toolCallId }) {
    const id =
      str(runId) ??
      (str(sessionKey) && str(toolCallId) ? this.calls.get(`${sessionKey}\0${toolCallId}`) : null);
    return id ? this.lookup(id) : null;
  }

  /** The run read something from outside: kept with the first source, which a line names. */
  markRead(run, source, toolName) {
    if (!run || run.lost) return;
    run.lastSeenAt = this.now();
    if (run.readOutside) return;
    run.readOutside = { source, tool: str(toolName), at: this.now() };
  }

  /** agent_end: the run is over; it stays for lookups until it ages out or makes room. */
  sawEnd(ctx) {
    const runId = str(ctx?.runId);
    if (!runId) return;
    // Its spawns that never named a task wait no longer, whether or not the run
    // is held (a run first seen at its call still made them): no other run takes them.
    for (const [bot, list] of this.spawning) {
      const left = list.filter((w) => w.runId !== runId);
      if (left.length === list.length) continue;
      if (left.length) this.spawning.set(bot, left);
      else this.spawning.delete(bot);
    }
    const run = this.runs.get(runId);
    if (!run) return;
    run.ended = true;
    if (run.sessionKey && this.active.get(run.sessionKey) === runId)
      this.active.delete(run.sessionKey);
  }
}
