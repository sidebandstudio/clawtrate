// The holds on the tools a bot already has (docs/design/bots-in-clawtrate.md,
// section 3.3's side-door table), decided in before_tool_call for every bot
// the plugin serves. A tool a bot already had never gets more than its
// Clawtrate row gives the same origin; the one addition is the owner in a chat
// app (O). This build never establishes A (the person's ask needs the device's
// record, step 3), so a run typed here is B, and every hold says what it does
// for B, C and O.
//
// decide() returns one of:
//   { pass: true }                               not held, or held and allowed as it is
//   { pass: true, params, said }                 allowed with its parameters changed
//   { pass: true, journalRoutine: id }           allowed once the routine's definition is journaled
//   { approval: { title, description } }         OpenClaw's own approval, in the chat it came from
//   { block: true, reason }                      not done, said to the bot
// Any error while deciding a held call is a refusal (index.js).

import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** The bootstrap files a bot's instructions live in, and the one that holds its name. */
export const INSTRUCTION_FILES = Object.freeze(["agents.md", "soul.md", "tools.md", "user.md"]);
export const IDENTITY_FILE = "identity.md";
const FILE_TOOLS = new Set(["write", "edit", "apply_patch"]);
const SCHEDULER = new Set(["automations", "cron"]);
const OPENCLAW_TOOLS = new Set(["openclaw", "plugins", "gateway"]);
const GATEWAY_READS = new Set(["config.get", "config.schema.lookup"]);

/** Section 7.3's words, and the reasons a hold gives. */
export const SAID = Object.freeze({
  notDone:
    "Not done: Clawtrate doesn't make this change from something you read, another bot's message or someone other than your person. If your person wants it, they can ask you.",
  unconfirmed:
    "Not done: Clawtrate makes this change only when it can confirm your person asked for it in Clawtrate, and it can't yet. Nothing was changed.",
  noOneToAsk:
    "Not done: changing OpenClaw needs your person, and nobody is here to ask. Nothing was changed.",
  seenFirst: "It's set up and starts once your person has seen it in Clawtrate.",
  turnedOff: "It's set up but turned off until your person turns it on in Clawtrate.",
  failed: "Not done: Clawtrate couldn't check this call, so it wasn't made.",
  cantKeep:
    "Not done: Clawtrate couldn't keep this routine's definition to undo its removal, and nobody is here to ask. Nothing was changed.",
});

/** The scheduler's action, as the tool reads it. */
const actionOf = (params) =>
  String(params?.action ?? "")
    .trim()
    .toLowerCase();

/**
 * A new routine, stored turned off: `enabled: false` wherever the scheduler
 * reads the job from (`job`, its `data` or nested `job`, or the flat fields it
 * recovers when `job` is missing), with any other spelling of the key removed.
 */
export function storedOff(params) {
  const next = structuredClone(params);
  const off = (record) => {
    for (const key of Object.keys(record))
      if (key.trim().toLowerCase() === "enabled") delete record[key];
    record.enabled = false;
  };
  const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (isRecord(next.job) && Object.keys(next.job).length > 0) {
    off(next.job);
    if (isRecord(next.job.data)) off(next.job.data);
    if (isRecord(next.job.job)) off(next.job.job);
  }
  off(next);
  return next;
}

/** The paths a file tool call writes, as given: `path` (and its aliases), or a patch's file headers. */
export function writtenPaths(event) {
  const params = event?.params ?? {};
  const name = String(event?.toolName ?? "").toLowerCase();
  if (name !== "apply_patch") {
    const p = params.path ?? params.file_path ?? params.filePath ?? params.file;
    return typeof p === "string" ? [p] : [];
  }
  const out = new Set(Array.isArray(event?.derivedPaths) ? event.derivedPaths : []);
  const patch = String(params.input ?? params.patch ?? "");
  for (const m of patch.matchAll(/^\*\*\*\s*(?:Add|Update|Delete) File:\s*(.+?)\s*$/gim))
    out.add(m[1]);
  for (const m of patch.matchAll(/^\*\*\*\s*Move to:\s*(.+?)\s*$/gim)) out.add(m[1]);
  return [...out];
}

/** A path resolved as far as it exists, so a link or `..` can't hide a bootstrap file. */
function real(path) {
  try {
    return realpathSync(path);
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path));
    } catch {
      return resolve(path);
    }
  }
}

/**
 * Which bootstrap file a path is, if any: one of the five at the top of the
 * bot's workspace, compared without case. With no workspace known, any path
 * named like one counts.
 */
export function bootstrapFile(path, workspaceDir) {
  const file = basename(String(path)).toLowerCase();
  if (file !== IDENTITY_FILE && !INSTRUCTION_FILES.includes(file)) return null;
  if (!workspaceDir) return file;
  const full = real(isAbsolute(path) ? path : join(workspaceDir, path));
  return dirname(full).toLowerCase() === real(workspaceDir).toLowerCase() ? file : null;
}

/** The bot a send or a spawn reaches, by `agentId` or an agent session key; null when it can't be told. */
export function targetBot(event, caller) {
  const p = event?.params ?? {};
  const name = String(event?.toolName ?? "").toLowerCase();
  if (name === "conversations_send") return null;
  if (typeof p.agentId === "string" && p.agentId.trim()) return p.agentId.trim().toLowerCase();
  const key = typeof p.sessionKey === "string" ? p.sessionKey.trim() : "";
  const scoped = /^agent:([^:]+):/i.exec(key);
  if (scoped) return scoped[1].toLowerCase();
  // A label alone looks among the caller's own sessions; "main" is its own.
  if (!key || key === "main" || key === "current") return caller;
  if (name === "sessions_spawn") return caller;
  return null;
}

/** The routine a routine's own run is, from its session key (`agent:<bot>:cron:<id>…`). */
const ownRoutine = (sessionKey) => /^agent:[^:]+:cron:([^:]+)/.exec(sessionKey ?? "")?.[1] ?? null;

/** The reason for a refusal, by why the call isn't the person's ask. */
function notDone(origin) {
  if (origin.origin === "B" && !origin.read) return SAID.unconfirmed;
  return SAID.notDone;
}

/** Which hold a call is under, or null when it is none of section 3.3's side doors. */
export function holdOf(event, caller) {
  const name = String(event?.toolName ?? "").toLowerCase();
  if (SCHEDULER.has(name)) {
    const action = actionOf(event.params);
    return ["add", "update", "remove"].includes(action) ? `scheduler-${action}` : null;
  }
  if (FILE_TOOLS.has(name)) return "file";
  if (name === "heartbeat_respond")
    return event.params && "scratch" in event.params ? "notes" : null;
  if (name === "sessions_send" || name === "conversations_send") {
    const target = targetBot(event, caller);
    return target === caller ? null : "message";
  }
  if (name === "sessions_spawn") {
    const target = targetBot(event, caller);
    return target === caller ? null : "hand-off";
  }
  if (OPENCLAW_TOOLS.has(name)) {
    if (name === "gateway" && GATEWAY_READS.has(actionOf(event.params))) return null;
    return "openclaw";
  }
  return null;
}

/**
 * The decision for one held call. `run` is the run's record (its kind, its
 * session, its workspace); `reach` the bots in the caller's
 * `subagents.allowAgents`.
 */
export function decide({ event, origin, run, caller, reach = [], workspaceDir = null }) {
  const hold = holdOf(event, caller);
  if (!hold) return { pass: true };
  const { origin: o, read } = origin;
  const ownerNothingRead = o === "O" && !read;

  switch (hold) {
    case "scheduler-add":
      if (ownerNothingRead) return { pass: true };
      if (o === "O") return { pass: true, params: storedOff(event.params), said: SAID.turnedOff };
      if (o === "B" && !read)
        return { pass: true, params: storedOff(event.params), said: SAID.seenFirst };
      return { block: true, reason: notDone(origin) };

    case "scheduler-update":
      return ownerNothingRead ? { pass: true } : { block: true, reason: notDone(origin) };

    case "scheduler-remove": {
      if (ownerNothingRead)
        return {
          approval: {
            title: "Delete a routine",
            description:
              "Your bot wants to delete one of its routines. Its runs stay in its history.",
          },
        };
      // A routine that ends itself: only that routine, only from its own run,
      // and only once its whole definition is journaled (index.js does that,
      // and refuses when it can't).
      const id = String(event.params?.jobId ?? event.params?.id ?? "");
      if (run?.kind === "routine" && id && (run.jobId ?? ownRoutine(run.sessionKey)) === id)
        return { pass: true, journalRoutine: id };
      return { block: true, reason: notDone(origin) };
    }

    case "file": {
      const files = writtenPaths(event).map((p) => bootstrapFile(p, workspaceDir));
      if (files.every((f) => f === null)) return { pass: true };
      if (ownerNothingRead) return { pass: true };
      // Another bot's files, from a task another bot started in its workspace: clawtrate_bot change.
      const startedBy = /^agent:([^:]+):/.exec(run?.provenance?.sourceSessionKey ?? "")?.[1];
      if (run?.kind === "task" && startedBy && startedBy !== caller)
        return { block: true, reason: notDone(origin) };
      if (files.some((f) => f !== null && f !== IDENTITY_FILE))
        return { block: true, reason: notDone(origin) };
      // Its own IDENTITY.md: done, as the bot's own; not from a chat-app sender who isn't the owner.
      if (origin.kind === "chat-app" && o !== "O") return { block: true, reason: notDone(origin) };
      return { pass: true };
    }

    case "notes":
      // A check-in's notes: the bot's own block or not done (3.2). Telling its
      // own notes from a person's needs Clawtrate's record (a later step).
      return { block: true, reason: notDone(origin) };

    case "message":
    case "hand-off": {
      if (ownerNothingRead) return { pass: true };
      const target = targetBot(event, caller);
      if (o === "B" && !read && target !== null && reach.includes(target)) return { pass: true };
      return { block: true, reason: notDone(origin) };
    }

    case "openclaw":
      if (ownerNothingRead)
        return {
          approval: {
            title: "Change OpenClaw",
            description:
              "Your bot wants to change OpenClaw itself with the tools OpenClaw gave it.",
          },
        };
      return { block: true, reason: o === "C" ? SAID.noOneToAsk : notDone(origin) };
  }
  return { block: true, reason: SAID.failed };
}

/** What each kind of change does for this origin, in words, for clawtrate_here. */
export function describeHolds(origin) {
  const { origin: o, read } = origin;
  if (o === "O" && !read)
    return [
      "Your owner asked in a chat app: your scheduler, file and message tools work as usual, and Clawtrate records what they change. Deleting a routine or changing OpenClaw asks your owner in this chat first.",
    ];
  if (o === "O")
    return [
      "A new routine is set up turned off until your person turns it on in Clawtrate.",
      "Changes to your instructions or an existing routine, messages to other bots, and changes to OpenClaw aren't made after you've read something.",
    ];
  if (o === "B" && !read)
    return [
      "A new routine is set up turned off, and starts once your person has seen it in Clawtrate.",
      "A rename by editing IDENTITY.md is done, shown as your own.",
      "Changes to your other instructions, an existing routine or your check-in notes, deleting a routine, and changes to OpenClaw aren't made until Clawtrate can confirm your person asked.",
      "A message or hand-off goes only to bots you can already reach.",
    ];
  return [
    "A rename by editing IDENTITY.md is done, shown as your own.",
    "New routines, changes to your instructions or routines, messages and hand-offs to other bots, and changes to OpenClaw aren't made from this run.",
  ];
}
