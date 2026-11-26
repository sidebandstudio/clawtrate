// Where each run came from, and whether it has read anything from outside
// (docs/design/bots-in-clawtrate.md, sections 4.1 and 4.3). In memory only, and
// bounded: a run this store doesn't hold is never the person's ask.
//
// What the gateway tells a plugin, on both OpenClaw versions this build knows:
//   before_prompt_build   once per model request of a run: its run id, session,
//                         bot, trigger, channel, workspace and the provenance of
//                         its input (needs hooks.allowConversationAccess)
//   before_model_resolve  the run's attachments (the same access)
//   before_tool_call      every tool call: its run id, call id and requester
//                         (channel, senderIsOwner); needs no access
//   before_message_write  a message that joins a run already under way

export const KNOWN_VERSIONS = Object.freeze(["2026.10.6", "2026.11.10"]);

export const LIMITS = Object.freeze({
  /** Runs held at once. When full, ended runs leave first; a new run past the bound isn't held. */
  runs: 512,
  /** How long a run is held after it was last seen. */
  runMs: 24 * 60 * 60 * 1000,
  /** Tool calls remembered for the tools' own lookup (2026.10.6 gives a tool no run id). */
  calls: 2048,
  /** Runs dropped while under way, remembered so they never come back as new. */
  lost: 512,
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

/** A run's kind from what before_prompt_build saw (4.1's table). */
export function kindOf(facts) {
  const provenance = facts.provenance;
  if (facts.trigger === "cron") return "routine";
  if (facts.trigger === "heartbeat") return "check-in";
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
  if (!versionKnown) return { origin: "C", read: null, kind: "unknown", why: "version" };
  if (!run) return { origin: "C", read: null, kind: "unknown", why: "unknown-run" };
  const read = run.readOutside?.source ?? null;
  if (run.lost) return { origin: "C", read, kind: run.kind, why: "lost" };
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

/** @typedef {{ runs: number, runMs: number, calls: number, lost: number }} Limits */

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
  }

  /** before_prompt_build: a run starts (its first model request) or goes on. */
  sawPrompt(ctx) {
    const runId = str(ctx?.runId);
    if (!runId) return null;
    const known = this.runs.get(runId);
    if (known) {
      known.lastSeenAt = this.now();
      return known;
    }
    // A run this store dropped while it was under way never comes back as new:
    // whatever it had read is gone with it.
    if (this.lost.has(runId)) return null;
    const facts = factsFrom(ctx);
    const run = {
      runId,
      ...facts,
      kind: kindOf(facts),
      readOutside: null,
      attachments: false,
      steers: 0,
      ended: false,
      lost: false,
      firstSeenAt: this.now(),
      lastSeenAt: this.now(),
    };
    if (!this.admit(run)) return null;
    if (run.sessionKey) this.active.set(run.sessionKey, runId);
    if (this.attached.delete(runId)) {
      run.attachments = true;
      this.markRead(run, "attachment", null);
    }
    return run;
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

  remember(set, value, max) {
    set.add(value);
    while (set.size > max) set.delete(set.values().next().value);
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
   * person typed (another bot's, the system's) is outside content for it.
   */
  sawMessage(event, ctx) {
    const message = event?.message;
    if (message?.role !== "user") return;
    const sessionKey = str(event?.sessionKey) ?? str(ctx?.sessionKey);
    const runId = sessionKey ? this.active.get(sessionKey) : undefined;
    const run = runId ? this.runs.get(runId) : undefined;
    if (!run || run.ended) return;
    const kind = message.provenance?.kind;
    if (kind && kind !== "external_user") {
      // The run's own first message carries the run's own provenance, which
      // already makes it C; any other is a message that joined it.
      if (run.provenance?.kind === kind) return;
      this.markRead(run, "message", null);
      return;
    }
    run.steers += 1;
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
    return runId ? this.lookup(runId) : null;
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
    const run = runId ? this.runs.get(runId) : undefined;
    if (!run) return;
    run.ended = true;
    if (run.sessionKey && this.active.get(run.sessionKey) === runId)
      this.active.delete(run.sessionKey);
  }
}
