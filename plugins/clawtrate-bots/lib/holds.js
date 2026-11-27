// The holds on the tools a bot already has (docs/design/bots-in-clawtrate.md,
// section 3.3's side-door table), decided in before_tool_call for every bot
// the plugin serves. A tool a bot already had never gets more than its
// Clawtrate row gives the same origin; the one addition is the owner in a chat
// app (O). This build never establishes A (the person's ask needs the device's
// record, step 3), so a run typed here is B, and every hold says what it does
// for B, C and O.
//
// Every hold reads a call the way the tool reads it: parameters in either
// spelling the tool accepts (lib/params.js), paths in every form the file
// tools expand. Where the plugin can't be sure what a call acts on, it refuses.
//
// decide() returns one of:
//   { pass: true }                               not held, or held and allowed as it is
//   { pass: true, params, said }                 allowed with its parameters changed
//   { pass: true, endsRoutine: id }              a routine ending itself: journaled once it succeeds
//   { approval: { title, description } }         OpenClaw's own approval, in the chat it came from
//   { block: true, reason }                      not done, said to the bot
// Any error while deciding a held call is a refusal (lib/hooks.js).

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { Ambiguous, botOfKey, readFirst, readParam } from "./params.js";

/** The bootstrap files a bot's instructions live in, and the one that holds its name. */
export const INSTRUCTION_FILES = Object.freeze(["agents.md", "soul.md", "tools.md", "user.md"]);
export const IDENTITY_FILE = "identity.md";
/** The check-in's standing instructions, held as the check-in's notes are. */
export const CHECK_IN_FILE = "heartbeat.md";
const HELD_FILES = new Set([...INSTRUCTION_FILES, IDENTITY_FILE, CHECK_IN_FILE]);
/** Tools that write a file by path: the workspace's, and the paired node's (`file_write`). */
const FILE_TOOLS = new Set(["write", "edit", "apply_patch", "file_write"]);
const SCHEDULER = new Set(["automations", "cron"]);
const OPENCLAW_TOOLS = new Set(["openclaw", "plugins", "gateway"]);
const GATEWAY_READS = new Set(["config.get", "config.schema.lookup"]);
/** Tools that message another conversation; `conversations_turn` also waits for its reply. */
const MESSAGE_TOOLS = new Set(["sessions_send", "conversations_send", "conversations_turn"]);
/** Tools that start work in a session: a task of its own, or of another bot (a hand-off). */
const HAND_OFF_TOOLS = new Set(["sessions_spawn", "sessions_create"]);

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
  ambiguous:
    "Not done: this call names its target twice, differently, so Clawtrate can't tell what it would change. Nothing was changed.",
  notesTheirs:
    "Not done: these notes hold someone else's words, your person's or ones brought in. Clawtrate lets a bot replace only notes it wrote itself. Nothing was changed.",
  notesTooLong: "Not done: a bot's own notes are at most 2 KiB. Nothing was changed.",
  notesUnseen:
    "Not done: Clawtrate couldn't see the notes this would replace, so it can't tell whose they are. Nothing was changed.",
});

/** A bot's own notes, at most (design 3.2 and 9). */
export const NOTES_MAX_BYTES = 2 * 1024;

/** The scheduler's action, as the tool reads it. */
const actionOf = (params) => (readParam(params, "action") ?? "").toLowerCase();

const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

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
  if (isRecord(next.job) && Object.keys(next.job).length > 0) {
    off(next.job);
    if (isRecord(next.job.data)) off(next.job.data);
    if (isRecord(next.job.job)) off(next.job.job);
  }
  off(next);
  return next;
}

/**
 * The notes a call writes: `heartbeat_respond`'s `scratch`, or the scheduler's
 * `scratch_set` `content` (null clears them). Undefined when the call names none.
 */
export function notesWritten(event) {
  const params = isRecord(event?.params) ? event.params : {};
  if (String(event?.toolName ?? "").toLowerCase() === "heartbeat_respond")
    return typeof params.scratch === "string" ? params.scratch : undefined;
  if (params.content === null) return null;
  return typeof params.content === "string" ? params.content : undefined;
}

/** The paths a file tool call writes, as given: `path` (and its aliases), or a patch's file headers. */
export function writtenPaths(event) {
  const params = isRecord(event?.params) ? event.params : {};
  const name = String(event?.toolName ?? "").toLowerCase();
  if (name !== "apply_patch") {
    return ["path", "file_path", "filePath", "file", "destination"]
      .map((key) => params[key])
      .filter((p) => typeof p === "string");
  }
  const out = new Set(Array.isArray(event?.derivedPaths) ? event.derivedPaths : []);
  const patch = String(params.input ?? params.patch ?? "");
  for (const m of patch.matchAll(/^\*\*\*\s*(?:Add|Update|Delete) File:\s*(.+?)\s*$/gim))
    out.add(m[1]);
  for (const m of patch.matchAll(/^\*\*\*\s*Move to:\s*(.+?)\s*$/gim)) out.add(m[1]);
  return [...out];
}

/**
 * A Windows drive alias as 2026.11.10's file tools map it on Windows
 * (dist/path-utils-CpYoiF7W.mjs, `normalizeLocalWindowsDrivePath`): `/c/…`,
 * `/mnt/c/…` and `/cygdrive/c/…`, with or without a leading `@`, become `C:\…`.
 */
export function driveAlias(path) {
  return path.replace(
    /^(@?)\/(?:(?:cygdrive|mnt)\/)?([a-z])(?:\/|$)(.*)$/i,
    (_m, at, drive, rest) => `${at}${drive.toUpperCase()}:\\${rest.replaceAll("/", "\\")}`,
  );
}

/**
 * A path as the file tools expand it (2026.10.6 dist/path-utils-S10YpSZj.mjs:27-43,
 * dist/sandbox-paths-B9nRw-P0.mjs:20-28, dist/agent-tools.before-tool-call.decision-C9Brjb-Y.mjs:75-81;
 * the same in 2026.11.10): a malformed `</arg_value>` suffix cut, one leading
 * `@` dropped, `file://` read as a file URL, `~` as the home folder, and a
 * relative path taken from the bot's workspace. With `drive`, a Windows drive
 * alias is mapped first, as 2026.11.10 does on Windows.
 * @param {{ drive?: boolean, pathApi?: typeof nodePath }} [options]
 */
export function expandPath(raw, cwd, { drive = false, pathApi = nodePath } = {}) {
  let path = String(raw);
  const xml = path.indexOf("</arg_value>");
  if (xml !== -1) path = path.slice(0, xml);
  path = path.trim();
  if (drive) path = driveAlias(path);
  if (path.startsWith("@")) path = path.slice(1);
  if (path.toLowerCase().startsWith("file://")) {
    try {
      path = fileURLToPath(path);
    } catch {
      // the tool keeps it as it is
    }
  }
  const home = process.env.HOME || homedir();
  if (path === "~") path = home;
  else if (path.startsWith("~/") || (pathApi === nodePath.win32 && path.startsWith("~\\")))
    path = pathApi.join(home, path.slice(2));
  return pathApi.isAbsolute(path) ? path : pathApi.resolve(cwd ?? ".", path);
}

/**
 * Every path a call's spelling can mean on this gateway: as both versions'
 * file tools read it, and on Windows also with the drive alias mapped
 * (2026.11.10 maps it; 2026.10.6 doesn't, so either may be the one written).
 * @param {{ platform?: string, pathApi?: typeof nodePath }} [options]
 */
export function pathForms(raw, cwd, { platform = process.platform, pathApi = nodePath } = {}) {
  const forms = [expandPath(raw, cwd, { pathApi })];
  if (platform === "win32") forms.push(expandPath(raw, cwd, { drive: true, pathApi }));
  return [...new Set(forms)];
}

/** A path resolved as far as it exists, so a link or `..` can't hide a bootstrap file. */
function real(path, pathApi = nodePath) {
  if (pathApi !== nodePath) return pathApi.resolve(path);
  try {
    return realpathSync(path);
  } catch {
    try {
      return nodePath.join(realpathSync(nodePath.dirname(path)), nodePath.basename(path));
    } catch {
      return nodePath.resolve(path);
    }
  }
}

/**
 * Which held file a path is, and whose: one of the bootstrap files or
 * HEARTBEAT.md at the top of a bot's workspace, compared without case, in any
 * of the forms the path can take (pathForms). `workspaces` maps each bot to its
 * workspace. With no workspace known for the caller, any path so named counts
 * as its own.
 *   { file, bot } | null
 * @param {{ platform?: string, pathApi?: typeof nodePath }} [forms]
 */
export function heldFile(raw, caller, workspaces = {}, forms = {}) {
  const pathApi = forms.pathApi ?? nodePath;
  const own = workspaces[caller] ?? null;
  for (const form of pathForms(raw, own, forms)) {
    const full = real(form, pathApi);
    const file = pathApi.basename(full).toLowerCase();
    if (!HELD_FILES.has(file)) continue;
    const dir = pathApi.dirname(full).toLowerCase();
    for (const [bot, ws] of Object.entries(workspaces))
      if (ws && real(ws, pathApi).toLowerCase() === dir) return { file, bot };
    if (!own) return { file, bot: caller };
  }
  return null;
}

/**
 * The bot a message or a hand-off reaches, read as the tool reads it. A
 * hand-off goes to `agentId`, else the caller. A message (`sessions_send`,
 * the scheduler's `wake`) goes to its session key first (2026.10.6
 * dist/sessions-spawn-tool-CMHR26Kp.mjs:1719-1735, cron-tool-B3cH3Sr5.mjs:1582-1592;
 * the same in 2026.11.10), then to a label, then to `agentId`'s main
 * conversation, else the caller's own. Null when it can't be told, which
 * counts as another bot: a bare session id, a chat conversation, a label
 * with no `agentId` that no single session has, or a call whose `agentId`
 * names another bot than its session key does.
 */
/** @param {((label: string) => string | null) | null} [resolveLabel] */
export function targetBot(event, caller, resolveLabel = null) {
  const p = event?.params;
  const name = String(event?.toolName ?? "").toLowerCase();
  if (name === "conversations_send" || name === "conversations_turn") return null;
  const agent = readParam(p, "agentId")?.toLowerCase();
  if (HAND_OFF_TOOLS.has(name)) return agent ?? caller;
  const key = readParam(p, "sessionKey");
  if (key) {
    const target = botOfKey(key) ?? (key === "main" || key === "current" ? caller : null);
    return agent && agent !== target ? null : target;
  }
  // A label with no agentId is looked up among every bot's sessions, as the
  // gateway does (2026.10.6 dist/sessions-resolve-DAzKLWTo.mjs:300-324, an exact
  // match on the trimmed label; the same in 2026.11.10): its bot when exactly one
  // session has it, else it can't be told.
  const label = readParam(p, "label");
  if (label) return agent ?? (resolveLabel ? resolveLabel(label) : null);
  return agent ?? caller;
}

/** The reason for a refusal, by why the call isn't the person's ask. */
function notDone(origin) {
  if (origin.origin === "B" && !origin.read) return SAID.unconfirmed;
  return SAID.notDone;
}

/** A requester OpenClaw didn't resolve as its owner, on a chat app (not the gateway's own channel). */
const strangerIn = (requester) =>
  typeof requester?.channel === "string" &&
  requester.channel !== "webchat" &&
  requester.senderIsOwner !== true;

/** Which hold a call is under, or null when it is none of section 3.3's side doors. */
/** @param {((label: string) => string | null) | null} [resolveLabel] */
export function holdOf(event, caller, resolveLabel = null) {
  const name = String(event?.toolName ?? "").toLowerCase();
  if (SCHEDULER.has(name)) {
    const action = actionOf(event.params);
    if (action === "bind") return "scheduler-update";
    if (action === "scratch_set") return "notes";
    // A routine's own run re-arming it for later: more work scheduled.
    if (action === "next_check") return "rearm";
    if (action === "wake") {
      const target = targetBot(event, caller, resolveLabel);
      return target === caller ? "scheduler-wake" : "message";
    }
    return ["add", "update", "remove", "run"].includes(action) ? `scheduler-${action}` : null;
  }
  if (FILE_TOOLS.has(name)) return "file";
  if (name === "personal_instructions")
    return actionOf(event.params) === "set" ? "user-file" : null;
  if (name === "heartbeat_respond")
    return isRecord(event.params) && "scratch" in event.params ? "notes" : null;
  // A conversation's goal keeps the bot working on it, turn after turn
  // (2026.11.10 binds a continuation to it as it is made).
  if (name === "create_goal") return "goal";
  if (MESSAGE_TOOLS.has(name))
    return targetBot(event, caller, resolveLabel) === caller ? null : "message";
  if (HAND_OFF_TOOLS.has(name))
    return targetBot(event, caller, resolveLabel) === caller ? null : "hand-off";
  if (OPENCLAW_TOOLS.has(name)) {
    if (name === "gateway" && GATEWAY_READS.has(actionOf(event.params))) return null;
    return "openclaw";
  }
  return null;
}

/**
 * The decision for one held call. `run` is the run's record (its kind, its
 * session, its routine); `reach` the bots in the caller's
 * `subagents.allowAgents`; `workspaces` each bot's workspace; `enabled(id)`
 * whether a routine is on, as far as the plugin knows (null when it doesn't);
 * `requester` the hook's own requester.
 */
export function decide(input) {
  try {
    return decideCall(input);
  } catch (error) {
    if (error instanceof Ambiguous) return { block: true, reason: SAID.ambiguous };
    throw error;
  }
}

function decideCall({
  event,
  origin,
  run,
  caller,
  reach = [],
  workspaces = {},
  enabled = () => null,
  requester,
  resolveLabel = null,
  notes = null,
}) {
  const hold = holdOf(event, caller, resolveLabel);
  if (!hold) return { pass: true };
  const { origin: o, read } = origin;
  const ownerNothingRead = o === "O" && !read;
  const no = { block: true, reason: notDone(origin) };

  switch (hold) {
    case "scheduler-add":
      if (ownerNothingRead) return { pass: true };
      if (o === "O") return { pass: true, params: storedOff(event.params), said: SAID.turnedOff };
      if (o === "B" && !read)
        return { pass: true, params: storedOff(event.params), said: SAID.seenFirst };
      return no;

    case "scheduler-update":
      return ownerNothingRead ? { pass: true } : no;

    case "scheduler-run": {
      // Firing a routine now acts again: a routine stored turned off waits as
      // its row says; one already on runs as the bot's own only with nothing read.
      if (ownerNothingRead) return { pass: true };
      const id = readFirst(event.params, ["jobId", "id"]);
      return o === "B" && !read && id && enabled(id) === true ? { pass: true } : no;
    }

    case "scheduler-wake":
    case "goal":
      // More work for its own conversation: not after reading, nor from C.
      return read || o === "C" ? no : { pass: true };

    case "rearm":
      // Only a routine's own run can re-arm it (the gateway refuses any other):
      // not after reading something from outside.
      return read ? no : { pass: true };

    case "scheduler-remove": {
      if (ownerNothingRead)
        return {
          approval: {
            title: "Delete a routine",
            description:
              "Your bot wants to delete one of its routines. Its runs stay in its history.",
          },
        };
      // A routine may always end itself, from its own run (the gateway refuses
      // any other routine's id there). The id is read as the tool reads it.
      const id = readFirst(event.params, ["jobId", "id"]);
      const own = run?.jobId ?? /^agent:[^:]+:cron:([^:]+)/.exec(run?.sessionKey ?? "")?.[1];
      if (run?.kind === "routine" && id && own === id) return { pass: true, endsRoutine: id };
      return no;
    }

    case "file": {
      const files = writtenPaths(event)
        .map((p) => heldFile(p, caller, workspaces))
        .filter((f) => f !== null);
      if (files.length === 0) return { pass: true };
      if (ownerNothingRead) return { pass: true };
      // Another bot's files (by path, or from a task another bot started in
      // its workspace) are clawtrate_bot's change: not done.
      const startedBy = botOfKey(run?.provenance?.sourceSessionKey);
      if (run?.kind === "task" && startedBy && startedBy !== caller) return no;
      if (files.some((f) => f.bot !== caller)) return no;
      if (files.some((f) => INSTRUCTION_FILES.includes(f.file))) return no;
      // The check-in's standing instructions, as its notes: not after reading.
      if (files.some((f) => f.file === CHECK_IN_FILE) && read) return no;
      // Its own IDENTITY.md: done, as the bot's own; not from a chat-app
      // sender who isn't the owner, by the run's record or the hook's own requester.
      if (files.some((f) => f.file === IDENTITY_FILE)) {
        if ((origin.kind === "chat-app" && o !== "O") || strangerIn(requester)) return no;
      }
      return { pass: true };
    }

    case "user-file":
      // personal_instructions set writes a person's USER.md: the instructions row.
      return ownerNothingRead ? { pass: true } : no;

    case "notes": {
      // The check-in's notes and a routine's own notes (design 3.2): not after
      // reading something from outside; at most 2 KiB; and only over notes that
      // are empty or that this bot wrote itself through a journaled write.
      if (read) return no;
      const next = notesWritten(event);
      if (next === undefined) return no;
      if (Buffer.byteLength(next ?? "") > NOTES_MAX_BYTES)
        return { block: true, reason: SAID.notesTooLong };
      if (!notes || typeof notes.current !== "string")
        return { block: true, reason: SAID.notesUnseen };
      if (notes.current.trim() !== "" && notes.owned !== true)
        return { block: true, reason: SAID.notesTheirs };
      return { pass: true, notesWrite: { scope: notes.scope, previous: notes.current, next } };
    }

    case "message":
    case "hand-off": {
      if (ownerNothingRead) return { pass: true };
      const target = targetBot(event, caller, resolveLabel);
      if (o === "B" && !read && target !== null && reach.includes(target)) return { pass: true };
      return no;
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
      "Changes to your instructions or an existing routine, running a routine now, messages to other bots, notes and changes to OpenClaw aren't made after you've read something.",
    ];
  if (o === "B" && !read)
    return [
      "A new routine is set up turned off, and starts once your person has seen it in Clawtrate.",
      "A rename by editing IDENTITY.md is done, shown as your own.",
      "Changes to your other instructions or an existing routine, deleting a routine, and changes to OpenClaw aren't made until Clawtrate can confirm your person asked.",
      "A message or hand-off goes only to bots you can already reach.",
    ];
  return [
    "A rename by editing IDENTITY.md is done, shown as your own.",
    "New routines, running or changing a routine, changes to your instructions, messages and hand-offs to other bots, and changes to OpenClaw aren't made from this run.",
  ];
}
