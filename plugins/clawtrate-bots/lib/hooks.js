// before_tool_call for every bot the plugin serves: it records the call's run
// (lib/runs.js), decides the call's hold (lib/holds.js), and refuses a held
// call whenever it can't decide it. Both OpenClaw versions also block a call
// when this hook throws or takes 15 seconds (their global hook runner runs
// before_tool_call fail-closed); the hook doesn't rely on that.

import { createHash } from "node:crypto";
import { SAID, decide, describeHolds, holdOf } from "./holds.js";
import { botOfKey, readFirst } from "./params.js";
import { createRuns, reachOf } from "./runs.js";

/** Routines the plugin knows, newest last: what the gateway reported, and its own full copy. */
export const DEFINITIONS_MAX = 512;
/** A routine that ended itself is kept this long, at most this many, oldest first out. */
export const ENDED = Object.freeze({
  namespace: "routines-ended",
  maxEntries: 256,
  overflowPolicy: "evict-oldest",
  defaultTtlMs: 90 * 24 * 60 * 60 * 1000,
});
export const DEFINITION_MAX_BYTES = 64 * 1024;
/** What the gateway's cron_changed report of a routine leaves out. */
export const NOT_REPORTED = Object.freeze([
  "delivery",
  "sessionKey",
  "deleteAfterRun",
  "failureAlert",
]);
/**
 * Notes a bot wrote itself, through a held and journaled write: per notes
 * (`check-in:<bot>`, `routine:<job>`), who wrote them last and their hash, and
 * one journal entry per write with the notes before and after (design 3.2, 9).
 */
export const NOTES = Object.freeze({
  namespace: "notes-written",
  maxEntries: 512,
  overflowPolicy: "evict-oldest",
  defaultTtlMs: 365 * 24 * 60 * 60 * 1000,
});
/** The notes as their hash compares them: the gateway shows them trimmed. */
export const notesHash = (text) =>
  createHash("sha256")
    .update(String(text ?? "").trim())
    .digest("hex");
/**
 * A check-in's notes as the run's own prompt shows them: 2026.10.6 appends
 * them last, after "Heartbeat monitor scratch:" (dist/heartbeat-runner-run-PCcyazhe.mjs,
 * `appendHeartbeatScratch`), and leaves them out when there are none.
 */
export function checkInNotesOf(prompt) {
  const marker = "\n\nHeartbeat monitor scratch:\n";
  const at = String(prompt).lastIndexOf(marker);
  return at === -1
    ? ""
    : String(prompt)
        .slice(at + marker.length)
        .trim();
}
/** Removals let through and waiting for their result, at most this many. */
const ENDING_MAX = 64;
const DEFINITIONS_KEY = Symbol.for("clawtrate-bots.definitions.v1");
const SCHEDULER = new Set(["automations", "cron"]);

const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/** As JSON: the gateway's report leaves absent fields undefined, which the store refuses. */
const asJson = (v) => JSON.parse(JSON.stringify(v));
const jobIdOf = (params) => {
  try {
    return readFirst(params, ["jobId", "id"]);
  } catch {
    return undefined;
  }
};

/** The routine a scheduler `add` made, from its result's details or JSON text. */
export function addedId(result) {
  const pick = (v) =>
    isRecord(v) ? (typeof v.id === "string" ? v.id : isRecord(v.job) ? v.job.id : null) : null;
  const direct = pick(result?.details);
  if (typeof direct === "string") return direct;
  for (const block of Array.isArray(result?.content) ? result.content : []) {
    try {
      const found = pick(JSON.parse(String(block?.text ?? "")));
      if (typeof found === "string") return found;
    } catch {
      // not JSON
    }
  }
  return null;
}

/** A tool result's JSON: its details, else its first text block parsed. */
function resultJson(result) {
  if (isRecord(result?.details) && Object.keys(result.details).length > 0) return result.details;
  for (const block of Array.isArray(result?.content) ? result.content : []) {
    try {
      return JSON.parse(String(block?.text ?? ""));
    } catch {
      // not JSON
    }
  }
  return null;
}

/** Whether a scheduler call's result says it failed. */
const failedResult = (event) =>
  Boolean(event?.error) ||
  event?.result?.details?.ok === false ||
  event?.result?.details?.removed === false;

export function createHooks(api, options = {}) {
  const slots = options.slots ?? globalThis;
  slots[DEFINITIONS_KEY] ??= { definitions: new Map(), ending: new Map(), noting: new Map() };
  slots[DEFINITIONS_KEY].noting ??= new Map();
  const { definitions, ending, noting } = slots[DEFINITIONS_KEY];
  const ended = options.ended ?? api.runtime?.state?.openKeyedStore?.(ENDED);
  const notesStore = options.notes ?? api.runtime?.state?.openKeyedStore?.(NOTES);
  const now = options.now ?? Date.now;
  const config = () => options.config?.() ?? api.runtime?.config?.current?.() ?? {};

  function know(id, change) {
    const known = definitions.get(id) ?? {};
    definitions.delete(id);
    definitions.set(id, { ...known, ...change });
    while (definitions.size > DEFINITIONS_MAX) definitions.delete(definitions.keys().next().value);
  }

  /**
   * A routine that ended itself, journaled once its removal succeeded: the
   * plugin's own full copy when it has one (then Undo can make it again),
   * else what the gateway last reported, which leaves out NOT_REPORTED.
   */
  async function settleEnd(pending) {
    const known = definitions.get(pending.jobId) ?? {};
    const full = known.full ?? null;
    let definition = full ?? known.reported ?? null;
    if (definition && Buffer.byteLength(JSON.stringify(definition)) > DEFINITION_MAX_BYTES)
      definition = null;
    const complete = full !== null && definition === full;
    await ended?.registerIfAbsent(`${pending.jobId}:${pending.runId}`, {
      jobId: pending.jobId,
      agentId: pending.agentId,
      runId: pending.runId,
      definition,
      complete,
      notReported: complete ? [] : NOT_REPORTED,
      at: now(),
    });
  }

  /** A notes write let through, journaled once it succeeded, and its writer kept. */
  async function settleNotes(pending) {
    const at = now();
    const entry = { ...pending, nextHash: notesHash(pending.next), at };
    await notesStore?.register(
      `journal:${pending.scope}:${String(at).padStart(16, "0")}:${pending.runId}`,
      entry,
    );
    await notesStore?.register(`owner:${pending.scope}`, {
      agentId: pending.agentId,
      nextHash: entry.nextHash,
      at,
    });
  }

  /** What a notes write would replace, and whether this bot wrote it: see holds.js "notes". */
  async function notesContext(event, run, caller) {
    const name = String(event?.toolName ?? "").toLowerCase();
    let scope;
    let current;
    if (name === "heartbeat_respond") {
      scope = caller ? `check-in:${caller}` : null;
      current = run?.checkInNotes;
    } else {
      // 2026.11.10's scratch_set needs the revision its run's scratch_get read.
      const job = run?.jobId ?? null;
      scope = job ? `routine:${job}` : null;
      const seen = run?.routineNotes;
      const expected = event?.params?.expectedRevision ?? event?.params?.expected_revision;
      if (seen && seen.jobId === job && seen.revision === expected) current = seen.content;
    }
    if (!scope || typeof current !== "string") return { scope, current: undefined };
    if (current.trim() === "") return { scope, current, owned: false };
    const owner = await notesStore?.lookup(`owner:${scope}`);
    return {
      scope,
      current,
      owned: owner?.agentId === caller && owner?.nextHash === notesHash(current),
    };
  }

  async function afterToolCall(event, _ctx, run) {
    const name = String(event?.toolName ?? "");
    const callId = String(event?.toolCallId ?? "");
    const failed = failedResult(event);
    const wrote = noting.get(callId);
    if (wrote) {
      noting.delete(callId);
      if (!failed) await settleNotes(wrote);
    }
    if (!SCHEDULER.has(name)) return;
    const action = String(event?.params?.action ?? "").toLowerCase();
    if (action === "scratch_get" && !failed && run && !run.lost) {
      // The routine's notes and their revision, as its own run read them.
      const read = resultJson(event.result);
      if (isRecord(read))
        run.routineNotes = {
          jobId: run.jobId ?? null,
          content: typeof read.scratch?.content === "string" ? read.scratch.content : "",
          revision: read.currentRevision,
        };
    }
    if (action === "add" && !failed) {
      // The plugin's own full copy of a routine made through a call it held.
      const id = addedId(event.result);
      const job = isRecord(event.params?.job) ? event.params.job : null;
      if (id && job) know(id, { full: asJson({ ...job, id }) });
    }
    if ((action === "update" || action === "bind") && !failed) {
      // A change it didn't copy: its own copy is no longer the whole routine.
      const id = jobIdOf(event.params);
      if (id) know(id, { full: undefined });
    }
    const pending = ending.get(callId);
    if (pending) {
      ending.delete(callId);
      if (!failed) await settleEnd(pending);
    }
  }

  const runs = createRuns(api, {
    ...options,
    describeHolds,
    afterToolCall,
    notesOf: checkInNotesOf,
  });

  api.on("cron_changed", async (event) => {
    const id = typeof event?.jobId === "string" ? event.jobId : null;
    if (!id) return;
    if (event.action === "removed") {
      // A removal let through, confirmed by the gateway itself.
      for (const [callId, pending] of ending)
        if (pending.jobId === id) {
          ending.delete(callId);
          await settleEnd(pending).catch(() => {});
        }
      definitions.delete(id);
      return;
    }
    if (!isRecord(event.job)) return;
    const { state: _state, ...reported } = event.job;
    know(id, { reported: asJson(reported), enabled: event.job.enabled === true });
  });

  // A routine that ended itself, as journaled: what step 3's line and Undo read.
  api.registerGatewayMethod?.(
    "clawtrate-bots.routines.ended",
    async (opts) => {
      const jobId = typeof opts.params?.jobId === "string" ? opts.params.jobId : "";
      // Its entries' keys are `<jobId>:<runId>`, and ";" sorts right after ":".
      const rows =
        jobId && ended
          ? await ended.entriesInKeyRange({
              keyStartInclusive: `${jobId}:`,
              keyEndExclusive: `${jobId};`,
              limit: 16,
            })
          : [];
      const found = rows.filter((row) => row.value?.jobId === jobId).at(-1)?.value ?? null;
      opts.respond(true, { jobId, entry: found });
    },
    { scope: "operator.read" },
  );

  const sessionsOf = (agentId) =>
    options.sessions?.(agentId) ??
    api.runtime?.agent?.session?.listSessionEntries?.({
      agentId,
      readOnly: true,
      includeParticipants: false,
    }) ??
    [];

  /**
   * The bot a label with no agentId reaches, as the gateway resolves it: the one
   * session among every bot's whose label is exactly that, trimmed; null when
   * none or several have it (the gateway refuses either), so it is held.
   */
  function labelBot(cfg, label) {
    const want = String(label).trim();
    const ids = new Set([
      ...Object.keys(cfg?.agents?.entries ?? {}),
      ...(Array.isArray(cfg?.agents?.list) ? cfg.agents.list.map((a) => a?.id) : []),
    ]);
    const keys = new Set();
    for (const id of ids) {
      if (typeof id !== "string" || !id) continue;
      for (const row of sessionsOf(id) ?? [])
        if (row?.entry?.label === want && typeof row.sessionKey === "string")
          keys.add(row.sessionKey);
    }
    return keys.size === 1 ? botOfKey([...keys][0]) : null;
  }

  /** Every bot's workspace, so a write to another bot's files is told from the caller's own. */
  function workspaces(cfg, caller, run) {
    if (options.workspaces) return options.workspaces(caller);
    const ids = new Set([
      ...Object.keys(cfg?.agents?.entries ?? {}),
      ...(Array.isArray(cfg?.agents?.list) ? cfg.agents.list.map((a) => a?.id) : []),
      caller,
    ]);
    const out = {};
    for (const id of ids) {
      if (typeof id !== "string" || !id) continue;
      try {
        const ws = api.runtime?.agent?.resolveAgentWorkspaceDir?.(cfg, id);
        if (typeof ws === "string" && ws) out[id.toLowerCase()] = ws;
      } catch {
        // unknown: that bot's files are told only by name
      }
    }
    if (caller && run?.workspaceDir) out[caller] = run.workspaceDir;
    return out;
  }

  api.on("before_tool_call", async (event, ctx) => {
    let run;
    let decision;
    try {
      const seen = runs.sawCall(event, ctx);
      run = seen.run;
      const caller = String(ctx?.agentId ?? run?.agentId ?? "").toLowerCase() || null;
      const cfg = config();
      decision = decide({
        event,
        origin: seen.origin,
        run,
        caller,
        reach: reachOf(cfg, caller),
        workspaces: workspaces(cfg, caller, run),
        // Whether a routine is on, as the gateway last reported it (cron_changed):
        // never the plugin's own copy, which an operator's change makes stale.
        enabled: (id) => definitions.get(id)?.enabled ?? null,
        requester: ctx?.requester,
        resolveLabel: (label) => labelBot(cfg, label),
        notes: holdOf(event, caller) === "notes" ? await notesContext(event, run, caller) : null,
      });
      if (decision.notesWrite) {
        noting.set(String(event?.toolCallId ?? ""), {
          ...decision.notesWrite,
          agentId: caller,
          runId: run?.runId ?? null,
        });
        while (noting.size > ENDING_MAX) noting.delete(noting.keys().next().value);
      }
      if (decision.endsRoutine) {
        ending.set(String(event?.toolCallId ?? ""), {
          jobId: decision.endsRoutine,
          agentId: run?.agentId ?? caller,
          runId: run?.runId ?? null,
        });
        while (ending.size > ENDING_MAX) ending.delete(ending.keys().next().value);
      }
    } catch (error) {
      api.logger?.warn?.(
        `clawtrate-bots: couldn't check a ${event?.toolName} call: ${error?.message}`,
      );
      let held = true;
      try {
        held = holdOf(event, ctx?.agentId ?? null) !== null;
      } catch {
        // can't tell whether it is held: refuse
      }
      return held ? { block: true, blockReason: SAID.failed } : undefined;
    }
    runs.afterDecision(run, event, !decision.block, ctx);
    if (decision.block) return { block: true, blockReason: decision.reason };
    if (decision.approval)
      return {
        requireApproval: {
          ...decision.approval,
          severity: "warning",
          allowedDecisions: ["allow-once", "deny"],
        },
      };
    if (decision.params) return { params: decision.params };
    return undefined;
  });

  return { ...runs, definitions, ending, noting };
}
