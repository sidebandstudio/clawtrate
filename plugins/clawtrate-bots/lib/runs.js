// The hooks that fill the run-origin store, the three read tools, and the
// method that reads one run's record (index.js registers them).

import { DESCRIPTIONS, botsAnswer, hereAnswer, readLimit, tasksAnswer } from "./here.js";
import { KNOWN_VERSIONS, RunOrigins, originOf, readsOutside, sourceOf } from "./origins.js";
import { readParam } from "./params.js";

/** The calls that make a task: a bot's own or another bot's (2026.11.10 adds `sessions_create`). */
const MAKES_TASK = new Set(["sessions_spawn", "sessions_create"]);

/** The session a task-making call's result names, from its details or its JSON text. */
export function madeSession(result) {
  const pick = (v) =>
    isObject(v)
      ? typeof v.childSessionKey === "string"
        ? v.childSessionKey
        : typeof v.sessionKey === "string"
          ? v.sessionKey
          : null
      : null;
  const direct = pick(result?.details) ?? pick(result);
  if (direct) return direct;
  for (const block of Array.isArray(result?.content) ? result.content : []) {
    try {
      const found = pick(JSON.parse(String(block?.text ?? "")));
      if (found) return found;
    } catch {
      // not JSON
    }
  }
  return null;
}

/**
 * Whether a task-making call's result says it made no task: both versions report
 * a refusal or a failure as a result whose status is `error` or `forbidden`
 * (2026.10.6 dist/sessions-spawn-tool-CMHR26Kp.mjs; the same in 2026.11.10).
 */
export function spawnFailed(result) {
  const statusOf = (v) => (isObject(v) && typeof v.status === "string" ? v.status : null);
  let status = statusOf(result?.details);
  for (const block of Array.isArray(result?.content) ? result.content : []) {
    if (status) break;
    try {
      status = statusOf(JSON.parse(String(block?.text ?? "")));
    } catch {
      // not JSON
    }
  }
  return status === "error" || status === "forbidden";
}

export const READ_TOOLS = Object.freeze(["clawtrate_here", "clawtrate_tasks", "clawtrate_bots"]);
const NONE = { type: "object", additionalProperties: false, properties: {} };
const PARAMETERS = {
  clawtrate_here: NONE,
  clawtrate_tasks: {
    type: "object",
    additionalProperties: false,
    properties: {
      state: { type: "string", enum: ["working", "done", "failed"] },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
  },
  clawtrate_bots: {
    type: "object",
    additionalProperties: false,
    properties: {
      find: {
        type: "string",
        minLength: 1,
        maxLength: 80,
        description: "The name your person used.",
      },
    },
  },
};
/**
 * The host can load this module more than once (a copy for the hooks, another
 * for the methods), so the store lives in one process-wide slot.
 */
export const STATE_KEY = Symbol.for("clawtrate-bots.runs.v1");

/** Whether the gateway is a version whose hook fields this build knows. */
export function versionKnown(version) {
  const m = /^v?(\d{4}\.\d{1,2}\.\d{1,3})(?![\d])/.exec(String(version ?? ""));
  return m !== null && KNOWN_VERSIONS.includes(m[1]);
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (value) => ({ content: [{ type: "text", text: value }], details: {} });

/** The plugin's own conversation access, as the gateway's config says it. */
export function conversationAccess(config) {
  return config?.plugins?.entries?.["clawtrate-bots"]?.hooks?.allowConversationAccess === true;
}

/** How a bot runs commands, in words, from its exec policy (agent's own, else the gateway's). */
export function commandsIn(config, agentId) {
  const entry =
    config?.agents?.entries?.[agentId] ?? config?.agents?.list?.find?.((a) => a?.id === agentId);
  const exec = entry?.tools?.exec ?? config?.tools?.exec ?? {};
  if (exec.mode === "deny" || exec.security === "deny") return "not allowed";
  if (exec.ask === "always" || exec.ask === "on-miss" || exec.mode === "ask")
    return "only after asking";
  return "without asking";
}

function botEntry(config, agentId) {
  return (
    config?.agents?.entries?.[agentId] ??
    config?.agents?.list?.find?.((a) => a?.id === agentId) ??
    null
  );
}

/** The bot as clawtrate_here describes it, from the gateway's config. */
export function botFacts(config, agentId) {
  const entry = botEntry(config, agentId) ?? {};
  const model = entry.model?.primary ?? entry.model ?? config?.agents?.defaults?.model?.primary;
  const every = entry.heartbeat?.every;
  return {
    name: entry.identity?.name ?? entry.name ?? null,
    model: typeof model === "string" ? model : null,
    effort: entry.thinkingDefault ?? config?.agents?.defaults?.thinkingDefault ?? null,
    commands: commandsIn(config, agentId),
    checkIns: typeof every === "string" && every !== "0" ? `every ${every}` : "off",
  };
}

/** The bots in the caller's `subagents.allowAgents`: its reach, never itself. */
export function reachOf(config, agentId) {
  const allow = botEntry(config, agentId)?.subagents?.allowAgents;
  return Array.isArray(allow)
    ? allow.filter((id) => typeof id === "string" && id !== agentId).map((id) => id.toLowerCase())
    : [];
}

/** Every other bot's id on the gateway: not itself, not the gateway's own. */
export function otherBots(config, agentId) {
  const system = config?.agents?.defaults?.systemAgent?.agentId;
  const ids = Object.keys(config?.agents?.entries ?? {}).concat(
    (config?.agents?.list ?? []).map?.((a) => a?.id) ?? [],
  );
  return [...new Set(ids)].filter(
    (id) => typeof id === "string" && id !== agentId && id !== system,
  );
}

/** The other bots as clawtrate_bots lists them (at most `limit`), with whether each is in reach. */
export function botsFacts(config, agentId, limit = 50) {
  const reach = reachOf(config, agentId);
  return otherBots(config, agentId)
    .slice(0, limit)
    .map((id) => {
      const other = botEntry(config, id) ?? {};
      const model = other.model?.primary ?? other.model;
      return {
        id,
        name: other.identity?.name ?? other.name ?? null,
        inReach: reach.includes("*") || reach.includes(id.toLowerCase()),
        account: typeof model === "string" ? `its own account (model ${model})` : null,
      };
    });
}

/** A session's row, from the session store's entry. */
function taskOf(sessionKey, entry, agentId) {
  const by =
    typeof entry?.spawnedBy === "string" ? /^agent:([^:]+):/.exec(entry.spawnedBy)?.[1] : null;
  return {
    sessionKey,
    title: entry?.label ?? entry?.displayName ?? null,
    startedBy: by ? (by === agentId ? "you" : by) : null,
    state: entry?.abortedLastRun ? "failed" : (entry?.status ?? null),
    lastActivityAt: Number.isFinite(entry?.updatedAt) ? entry.updatedAt : null,
  };
}

export function createRuns(api, options = {}) {
  const slots = options.slots ?? globalThis;
  slots[STATE_KEY] ??= new RunOrigins(options.now ? { now: options.now } : {});
  const origins = slots[STATE_KEY];
  const known = versionKnown(options.version ?? api.runtime?.version);
  const config = () => options.config?.() ?? api.runtime?.config?.current?.() ?? {};
  const sessions = (agentId) =>
    options.sessions?.(agentId) ??
    api.runtime?.agent?.session?.listSessionEntries?.({
      agentId,
      readOnly: true,
      includeParticipants: false,
    }) ??
    [];

  /**
   * Whether conversation access is on, noting a change since the last look.
   * A config write replaces the gateway's runtime snapshot; across one (it may
   * have turned access off and on again unseen) or an access change, no record
   * held is one the plugin can vouch for.
   */
  function observe() {
    const cfg = config();
    const access = conversationAccess(cfg);
    const seen = origins.seenConfig;
    if (seen && (seen.cfg !== cfg || seen.access !== access)) origins.invalidate();
    origins.seenConfig = { cfg, access };
    return access;
  }

  // What fills the store. Each handler only records; none decides a call.
  api.on("before_model_resolve", (event, ctx) => {
    observe();
    origins.sawAttachments(ctx, event);
  });
  api.on("before_prompt_build", (_event, ctx) => {
    observe();
    origins.sawPrompt(ctx);
  });
  api.on("before_message_write", (event, ctx) => {
    observe();
    origins.sawMessage(event, ctx);
  });
  api.on("agent_end", (_event, ctx) => origins.sawEnd(ctx));
  api.on("after_tool_call", (event, ctx) => {
    observe();
    const runId = event?.runId ?? ctx?.runId;
    const run =
      typeof runId === "string" && runId
        ? origins.seen(runId)
        : origins.runForTool({
            sessionKey: ctx?.sessionKey,
            toolCallId: event?.toolCallId ?? ctx?.toolCallId,
          });
    if (MAKES_TASK.has(String(event?.toolName))) {
      const callId = event?.toolCallId ?? ctx?.toolCallId;
      // A failed call made no task: its wait for one is over. The tools report
      // most failures as a result, not an error.
      if (event?.error || spawnFailed(event?.result)) origins.dropSpawn(callId, ctx?.sessionKey);
      else origins.sawSpawned(run, madeSession(event?.result), callId, ctx?.sessionKey);
    }
    if (readsOutside(event) && run && !run.lost)
      origins.markRead(run, sourceOf(event.toolName), event.toolName);
    // The holds' own bookkeeping of a call's result (lib/hooks.js).
    return options.afterToolCall?.(event);
  });

  /**
   * A call's origin. With conversation access off the plugin no longer sees a
   * run's prompts or the messages that join it, so a record it kept from before
   * may be missing what the run read: every run is C, with something read.
   */
  const vouched = (origin) =>
    observe() ? origin : { origin: "C", read: "lost", kind: "unknown", why: "access" };

  /**
   * The call's run and origin, recorded before any hold decides it; the run
   * is marked read from outside for every call but those 4.3 leaves out, at
   * the call, so a later call in the same Code Mode cell already sees it.
   */
  function sawCall(event, ctx) {
    const run = origins.sawCall(event, ctx);
    const origin = vouched(originOf(run, ctx?.requester, { versionKnown: known }));
    return { run, origin };
  }
  function afterDecision(run, event, allowed, ctx) {
    if (!allowed) return;
    // A task's first run may start before its result comes back: wait for it.
    if (MAKES_TASK.has(String(event?.toolName))) {
      let bot;
      try {
        bot = readParam(event?.params, "agentId");
      } catch {
        // Two spellings disagree: the hold refuses it, and nothing starts.
      }
      origins.sawSpawn(
        run,
        (bot ?? ctx?.agentId ?? run?.agentId ?? "").toLowerCase() || null,
        event?.toolCallId ?? ctx?.toolCallId,
        ctx?.sessionKey,
      );
    }
    if (run && !run.lost && readsOutside(event))
      origins.markRead(run, sourceOf(event.toolName), event.toolName);
  }

  /** The origin a read tool answers for: its own run, by run id or by session and call id. */
  function originFor(toolCtx, toolCallId) {
    const run = origins.runForTool({
      runId: toolCtx?.runId,
      sessionKey: toolCtx?.sessionKey,
      toolCallId,
    });
    const origin = vouched(
      originOf(
        run,
        toolCtx?.requester ??
          (toolCtx?.messageChannel
            ? { channel: toolCtx.messageChannel, senderIsOwner: toolCtx.senderIsOwner }
            : undefined),
        { versionKnown: known },
      ),
    );
    return { run, origin: { ...origin, channel: run?.channel ?? null } };
  }

  const tools = {
    clawtrate_here: (toolCtx, toolCallId) => {
      const cfg = config();
      const agentId = toolCtx?.agentId;
      const { origin } = originFor(toolCtx, toolCallId);
      const key = toolCtx?.sessionKey ?? "";
      const entry = sessions(agentId).find?.((s) => s?.sessionKey === key)?.entry;
      const task = taskOf(key, entry, agentId);
      // The same origin for both halves of the answer: with conversation access
      // off it is already "unknown", C, with something read (vouched).
      return hereAnswer({
        origin,
        session: {
          kind: /^agent:[^:]+:main$/.test(key) ? "main" : "task",
          title: task.title,
          startedBy: task.startedBy,
        },
        bot: botFacts(cfg, agentId),
        holds: options.describeHolds?.(origin) ?? [],
      });
    },
    clawtrate_tasks: (toolCtx, _id, params) => {
      const limit = readLimit(params?.limit);
      const state = params?.state;
      if (state !== undefined && !["working", "done", "failed"].includes(state))
        throw new Error("state must be working, done or failed.");
      const agentId = toolCtx?.agentId;
      // Its own tasks, and the tasks it started under other bots (design section 8).
      // Every other bot, not only the 50 clawtrate_bots lists: a task may be under any of them.
      const others = otherBots(config(), agentId);
      const mine = (s) =>
        typeof s?.sessionKey === "string" && s.sessionKey.startsWith(`agent:${agentId}:`);
      const startedByMe = (s) =>
        typeof s?.entry?.spawnedBy === "string" &&
        s.entry.spawnedBy.startsWith(`agent:${agentId}:`);
      const rows = [
        ...(sessions(agentId).filter?.(mine) ?? []),
        ...others.flatMap((other) => sessions(other).filter?.(startedByMe) ?? []),
      ]
        .map((s) => taskOf(s.sessionKey, s.entry, agentId))
        .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
      return { ...tasksAnswer({ tasks: rows ?? [], limit, state }), source: "titles" };
    },
    clawtrate_bots: (toolCtx, _id, params) => {
      const find = params?.find;
      if (find !== undefined && (typeof find !== "string" || !find.trim() || find.length > 80))
        throw new Error("find must be a name of 1 to 80 characters.");
      return {
        // With find, the whole roster is searched; the answer is bounded either way.
        ...botsAnswer({
          bots: botsFacts(config(), toolCtx?.agentId, find === undefined ? 50 : Infinity),
          find,
        }),
        source: "names",
      };
    },
  };

  for (const name of READ_TOOLS) {
    api.registerTool?.(
      (toolCtx) => ({
        name,
        label: name,
        description: DESCRIPTIONS[name],
        parameters: PARAMETERS[name],
        async execute(toolCallId, params) {
          let answer;
          try {
            answer = tools[name](toolCtx, toolCallId, isObject(params) ? params : {});
          } catch (error) {
            return text(`Clawtrate couldn't answer: ${error.message}`);
          }
          if (typeof answer === "string") return text(answer);
          // Text a bot may have written reaches the model: the run has read outside content.
          if (answer.outside) {
            const { run } = originFor(toolCtx, toolCallId);
            if (run && !run.lost) origins.markRead(run, answer.source, name);
          }
          return text(answer.text);
        },
      }),
      { name },
    );
  }

  // One run's record, for Clawtrate's own check of whose ask a call was, and for the checks.
  api.registerGatewayMethod?.(
    "clawtrate-bots.runs.get",
    async (opts) => {
      // By run id, or the latest run in a session (a routine's run has no id a client knows).
      const sessionKey = typeof opts.params?.sessionKey === "string" ? opts.params.sessionKey : "";
      const byKey = !opts.params?.runId && sessionKey ? origins.latestIn(sessionKey) : null;
      const runId =
        byKey?.runId ?? (typeof opts.params?.runId === "string" ? opts.params.runId : "");
      // With conversation access off no record is vouched for (C, something lost).
      if (!observe()) return opts.respond(true, { runId, known: false, why: "access" });
      const run = runId ? origins.lookup(runId) : null;
      opts.respond(true, {
        runId,
        known: run !== null && !run.lost,
        ...(run && !run.lost
          ? {
              kind: run.kind,
              runId: run.runId,
              agentId: run.agentId,
              sessionKey: run.sessionKey,
              trigger: run.trigger,
              channel: run.channel,
              provenance: run.provenance?.kind ?? null,
              readOutside: run.readOutside
                ? { source: run.readOutside.source, tool: run.readOutside.tool }
                : null,
              attachments: run.attachments,
              steers: run.steers,
              ended: run.ended,
            }
          : {}),
      });
    },
    { scope: "operator.read" },
  );

  return { origins, sawCall, afterDecision, tools, known };
}
