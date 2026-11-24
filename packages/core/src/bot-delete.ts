// Deleting a bot (docs/parity.md F-050, F-276, F-464): what the dialog reads
// before it lists what goes and what stays, and the delete itself. The
// gateway's `agents.delete {agentId, deleteFiles}` needs `operator.admin`. It
// always removes the bot's settings, channel routes, routines, saved command
// approvals and task records; with `deleteFiles` it also tries to move the
// bot's folders to the Trash on its own machine, keeping any folder another
// bot still uses. An `ok` answer can still list paths it couldn't move
// (`failed`) or say it couldn't clear the task records (`purgeFailed`). The
// gateway journals the delete, but neither its answer nor the journal gives an
// id a second request could name, and the list proves no absence (OpenClaw
// 2026.10.6): so nothing is ever sent again. What is left is the gateway's.
//
// Every read and the delete go through one connection to one gateway, named
// by its identity: the host binds the context before anything here runs.
// Nothing here is kept in the state: each read and each delete answers the
// dialog that asked.

import { AdminNeededError } from "./accounts-engine.ts";
import { sha256Hex, utf8Bytes } from "./bytes.ts";
import { asRecord, mapAgents, type RawRecord } from "./mapping.ts";
import { MAX_PATH_CHARS, MAX_REASON_CHARS, workspacePath } from "./machines.ts";
import { sameStamp, type GatewayStamp } from "./types.ts";

/** Paths of one kind (moved, or not moved) an answer is shown with; past it, counted. */
export const MAX_DELETE_PATHS = 32;
/**
 * Room for a delete's outcome, encoded, in one answer to a window: well inside every host's limit
 * on a result, the web host's 262,144 characters included. Paths past it are counted.
 */
export const MAX_DELETE_RESULT_CHARS = 131_072;
/** Other bots named as using the same workspace folder; past it, counted. */
export const MAX_SHARED_NAMES = 8;
/** A name shown in the dialog; a longer one is cut for display, and confirmed by the bot's id. */
export const MAX_SHOWN_NAME_CHARS = 256;

/**
 * Whether the bot's workspace folder may be offered for removal. `shared`: another bot the
 * gateway lists has the same folder, one inside it, or one around it. `unknown`: the bot's
 * folder, or another bot's, isn't reported.
 */
export type FolderStatus = "own" | "shared" | "unknown";

/** What the dialog showed of the bot. A delete is sent only while all of it is unchanged. */
export type BotDeleteReview = {
  /** SHA-256 of the bot's whole name as the gateway gives it, however long; null when unlisted. */
  nameDigest: string | null;
  /** The gateway's creation record; null when it keeps none for this bot. */
  createdAt: number | null;
  /** The bot's workspace folder as the gateway reports it. */
  workspace: string | null;
  folder: FolderStatus;
  /** Other bots whose folder is the same, inside or around it, by name. */
  sharedWith: string[];
  sharedOmitted: number;
};

/**
 * What the person types to confirm a delete: the bot's name, or its id when the gateway gives it
 * no name (`unnamed`) or a name that can't be typed in one line (`untypable`: a line break or
 * another control character, a lone surrogate, or longer than `MAX_SHOWN_NAME_CHARS`).
 */
export type ConfirmTarget = { text: string; by: "name" | "unnamed" | "untypable" };

/** What the dialog shows before anything is removed, from one `agents.list` read. */
export type BotDeleteRead = BotDeleteReview & {
  /** Where it was read: the delete is sent only to this gateway, on this target. */
  stamp: GatewayStamp;
  botId: string;
  /** The bot's name for display, cut at `MAX_SHOWN_NAME_CHARS`; its id when the gateway gives none. */
  name: string | null;
  confirm: ConfirmTarget;
  /** The gateway lists the bot now. */
  listed: boolean;
  /** The gateway's default bot, Clawtrate's Main Bot: never deleted from Clawtrate. */
  main: boolean;
};

export type DeletedPath = { path: string; method: "trash" | "missing" };
export type FailedPath = { path: string; reason: string };

export type ChangedReason =
  | "gone"
  | "main"
  /** Another creation record: possibly another bot with the same id. */
  | "replaced"
  /** The workspace folder the gateway reports isn't the one the dialog showed. */
  | "moved"
  /** Another bot now uses the folder, or other bots than the dialog named. */
  | "shared"
  /** Anything else the dialog showed. */
  | "changed"
  /** Removing files was asked for a bot whose folder can't be offered for removal. */
  | "files";

/**
 * How a delete went. `listed` is what an `agents.list` read after it says: the bot is still
 * listed, it isn't, or nothing can be said (null: the read failed, wasn't whole, or a newer list
 * had been read since). Only the gateway's own answer names paths.
 */
export type BotDeleteOutcome =
  /** Nothing was sent: what the dialog showed is no longer what the gateway has. */
  | { kind: "changed"; reason: ChangedReason; read: BotDeleteRead }
  /**
   * Nothing was sent, for a reason before the delete: access, another delete under way, another
   * gateway or connection, or a bot list that couldn't be read. The only refusal that proves it.
   */
  | { kind: "not-sent"; message: string }
  /**
   * Nothing was sent: the bot list read just before wasn't whole, or a newer one had been shown
   * since. It decides nothing and hands back no facts; the dialog reads again.
   */
  | { kind: "unread"; message: string }
  /**
   * The request left the host, and no `ok: true` for the bot came back: no answer, an error of
   * any kind, or another answer. Only reading the list follows.
   */
  | {
      kind: "unconfirmed";
      message: string;
      deleteFiles: boolean;
      listed: boolean | null;
      listedAs?: string;
    }
  /** The gateway answered `ok: true` for the bot asked about: the one evidence of a delete. */
  | {
      kind: "answered";
      deleteFiles: boolean;
      removedBindings: number;
      removed: DeletedPath[];
      /** Paths past `MAX_DELETE_PATHS`: moved to the Trash, and already gone. */
      removedOmitted: number;
      missingOmitted: number;
      failed: FailedPath[];
      failedOmitted: number;
      purgeFailed: boolean;
      listed: boolean | null;
      /**
       * With `listed`, the name the gateway gives the bot it lists under this id: a list read
       * establishes only that some bot has the id, not that it is the one deleted.
       */
      listedAs?: string;
    };

/** Whether an answer leaves something to clean up: a path not moved or task records not cleared. */
export const partialCleanup = (outcome: BotDeleteOutcome): boolean =>
  outcome.kind === "answered" &&
  (outcome.failed.length > 0 || outcome.failedOmitted > 0 || outcome.purgeFailed);

/** Whether the folder can be offered for removal: off for a bot with no creation record. */
export const canRemoveFolder = (read: Pick<BotDeleteRead, "folder" | "createdAt">): boolean =>
  read.folder === "own" && read.createdAt !== null;

/** One connection to one gateway, checked by the host to be the one the dialog read. */
export type BotDeleteContext = {
  /** The gateway and target this connection was bound to. */
  stamp: { gatewayId: string; target: number };
  request(method: string, params: unknown): Promise<unknown>;
  /**
   * `agents.list`, its answer also shown as the bot list when it is whole and the newest, so the
   * rail follows what the dialog reads. `current()` asks, at the moment it is called, whether
   * this read is still the newest list the host has shown, on the connection still open: a read
   * that isn't is never shown, decided on or acted on.
   */
  readBots(): Promise<{ result: unknown; current(): boolean }>;
  admin(): boolean;
  /** Whether the window that asked is still there: a delete is sent only while it is. */
  wanted(): boolean;
  /** The gateway answered `ok` for this bot: what this host still held for it goes, at once. */
  deleted(botId: string): void;
};

export type DeleteRequest = {
  botId: string;
  /** Where the dialog read. */
  stamp: GatewayStamp;
  deleteFiles: boolean;
  /** What the dialog showed of the bot. */
  reviewed: BotDeleteReview;
  /** What the person typed to confirm: sent only when it is the bot's `ConfirmTarget`. */
  typed: string;
};

const rec = (value: unknown): RawRecord => asRecord(value) ?? {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const cap = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value);
const text = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.length > 0 ? cap(value, max) : null;
const errorText = (error: unknown) =>
  cap(error instanceof Error ? error.message : String(error), MAX_REASON_CHARS);

/**
 * A folder path compared loosely: either slash, no trailing one, any case. A case alias on a
 * case-insensitive volume is then the same folder; on a case-sensitive one this only errs
 * toward keeping a folder.
 */
const folderKey = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const inside = (child: string, parent: string) =>
  parent === "" || child === parent || child.startsWith(`${parent}/`);
/** The same folder, or one inside the other. */
export const foldersOverlap = (a: string, b: string): boolean => {
  const x = folderKey(a);
  const y = folderKey(b);
  return inside(x, y) || inside(y, x);
};

const ROSTER_ERROR = "The gateway's bot list didn't come back whole.";
const STALE_ERROR = "The bot list changed while Clawtrate read it.";
/** An id as the protocol has one: a non-empty string with nothing around it. */
const plainId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;

/** Whether an `agents.list` answer is whole enough to decide on, or to show as the bot list. */
/** Every bot id a whole `agents.list` answer lists, system agents too; null when it isn't whole. */
export function rosterIds(result: unknown): Set<string> | null {
  try {
    return new Set(roster(result).agents.map((agent) => agent.id as string));
  } catch {
    return null;
  }
}

export function wholeRoster(result: unknown): boolean {
  try {
    roster(result);
    return true;
  } catch {
    return false;
  }
}

/**
 * An `agents.list` answer, whole: every field the protocol requires (`defaultId`, `mainKey`,
 * `scope`, `agents`), a default bot and every bot with one distinct id, none of them blank or
 * padded, so the default bot can't slip past the comparison that refuses it.
 */
function roster(result: unknown): { defaultId: string; agents: RawRecord[] } {
  const answer = asRecord(result);
  const defaultId = answer?.defaultId;
  if (
    !answer ||
    !Array.isArray(answer.agents) ||
    !plainId(defaultId) ||
    typeof answer.mainKey !== "string" ||
    answer.mainKey === "" ||
    (answer.scope !== "per-sender" && answer.scope !== "global")
  )
    throw new Error(ROSTER_ERROR);
  const agents: RawRecord[] = [];
  const ids = new Set<string>();
  for (const row of answer.agents) {
    const agent = asRecord(row);
    const id = agent?.id;
    if (!agent || !plainId(id) || ids.has(id)) throw new Error(ROSTER_ERROR);
    ids.add(id);
    agents.push(agent);
  }
  return { defaultId, agents };
}

/** The name the gateway gives a bot, as the bot list shows it; null when it gives none. */
function givenName(agent: RawRecord): string | null {
  const named = (value: unknown) =>
    typeof value === "string" && value.trim() !== "" ? value : null;
  return named(asRecord(agent.identity)?.name) ?? named(agent.name);
}

/** What confirms deleting a bot with this name; `name` whole, null when the gateway gives none. */
export function confirmTargetOf(name: string | null, botId: string): ConfirmTarget {
  if (name === null) return { text: botId, by: "unnamed" };
  if (
    name.length > MAX_SHOWN_NAME_CHARS ||
    /[\p{Cc}\u2028\u2029]/u.test(name) ||
    // A lone surrogate draws as a replacement character that nothing typed can match.
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(name)
  )
    return { text: botId, by: "untypable" };
  return { text: name.trim(), by: "name" };
}

/**
 * The digest of a bot's whole name, null for none. Its JSON form is hashed, so no two names share
 * one: a lone surrogate, which UTF-8 can't carry, is kept as its escape.
 */
export const nameDigestOf = (name: string | null): string =>
  sha256Hex(utf8Bytes(JSON.stringify(name)));

/** Whether what was typed confirms: exact, case and all, with spaces around it ignored. */
export const confirmMatches = (typed: string, target: ConfirmTarget): boolean =>
  typed.trim() === target.text;

/** The dialog's facts for one bot, from an `agents.list` answer; throws on a list not whole. */
export function deleteFacts(result: unknown, botId: string, stamp: GatewayStamp): BotDeleteRead {
  const { defaultId, agents } = roster(result);
  const self = agents.find((agent) => agent.id === botId);
  const given = self ? givenName(self) : null;
  const workspace = self ? workspacePath(self.workspace) : null;
  const names = new Map(mapAgents(result).map((bot) => [bot.id, bot.name]));
  const others = agents.filter((agent) => agent.id !== botId);
  const sharing: string[] = [];
  let unknown = workspace === null;
  for (const agent of others) {
    const theirs = workspacePath(agent.workspace);
    if (theirs === null) unknown = true;
    else if (workspace !== null && foldersOverlap(workspace, theirs))
      sharing.push(cap(names.get(String(agent.id)) ?? String(agent.id), MAX_SHOWN_NAME_CHARS));
  }
  const createdAt = self?.createdAt;
  return {
    stamp,
    botId,
    listed: self !== undefined,
    main: defaultId === botId,
    name: self ? cap(given ?? botId, MAX_SHOWN_NAME_CHARS) : null,
    // The whole name, so a rename past the part shown still counts as a change.
    nameDigest: self ? nameDigestOf(given) : null,
    confirm: confirmTargetOf(given, botId),
    createdAt:
      typeof createdAt === "number" && Number.isSafeInteger(createdAt) && createdAt >= 0
        ? createdAt
        : null,
    workspace,
    folder: sharing.length > 0 ? "shared" : unknown ? "unknown" : "own",
    sharedWith: sharing.slice(0, MAX_SHARED_NAMES),
    sharedOmitted: Math.max(0, sharing.length - MAX_SHARED_NAMES),
  };
}

/** What of a read the dialog showed, to send back with the delete. */
export const reviewOf = (read: BotDeleteRead): BotDeleteReview => ({
  nameDigest: read.nameDigest,
  createdAt: read.createdAt,
  workspace: read.workspace,
  folder: read.folder,
  sharedWith: [...read.sharedWith],
  sharedOmitted: read.sharedOmitted,
});

/** Why a fresh read no longer matches what the dialog showed, or null when all of it does. */
function changedSince(read: BotDeleteRead, reviewed: BotDeleteReview): ChangedReason | null {
  if (!read.listed) return "gone";
  if (read.createdAt !== reviewed.createdAt) return "replaced";
  if (read.workspace !== reviewed.workspace) return "moved";
  const sameSharing =
    read.folder === reviewed.folder &&
    read.sharedOmitted === reviewed.sharedOmitted &&
    read.sharedWith.length === reviewed.sharedWith.length &&
    read.sharedWith.every((name, n) => name === reviewed.sharedWith[n]);
  if (!sameSharing) return read.folder === "shared" ? "shared" : "changed";
  if (read.nameDigest !== reviewed.nameDigest) return "changed";
  return null;
}

/** The paths of an `agents.delete` answer, as the gateway reported them, bounded. */
export function readDeleteAnswer(result: unknown): {
  removedBindings: number;
  removed: DeletedPath[];
  removedOmitted: number;
  missingOmitted: number;
  failed: FailedPath[];
  failedOmitted: number;
  purgeFailed: boolean;
} {
  const answer = rec(result);
  // A path is shown whole or not at all: one cut short could name its parent folder.
  const whole = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 && value.length <= MAX_PATH_CHARS ? value : null;
  const removed: DeletedPath[] = [];
  let longTrash = 0;
  let longMissing = 0;
  for (const row of list(answer.removed).map(rec)) {
    if (row.method !== "trash" && row.method !== "missing") continue;
    const path = whole(row.path);
    if (path) removed.push({ path, method: row.method });
    // Too long to show: counted under what happened to it.
    else if (typeof row.path === "string" && row.path.length > MAX_PATH_CHARS) {
      if (row.method === "trash") longTrash += 1;
      else longMissing += 1;
    }
  }
  const failed: FailedPath[] = [];
  let unreadable = 0;
  for (const row of list(answer.failed).map(rec)) {
    const path = whole(row.path);
    // A failure without a path that can be shown still is one: it is counted, never dropped.
    if (!path) unreadable += 1;
    else failed.push({ path, reason: text(row.reason, MAX_REASON_CHARS) ?? "no reason given" });
  }
  const bindings = answer.removedBindings;
  return {
    removedBindings:
      typeof bindings === "number" && Number.isSafeInteger(bindings) && bindings > 0 ? bindings : 0,
    removed: removed.slice(0, MAX_DELETE_PATHS),
    // Past the cap each keeps its method: one already gone is never counted as moved.
    removedOmitted:
      removed.slice(MAX_DELETE_PATHS).filter((each) => each.method === "trash").length + longTrash,
    missingOmitted:
      removed.slice(MAX_DELETE_PATHS).filter((each) => each.method === "missing").length +
      longMissing,
    failed: failed.slice(0, MAX_DELETE_PATHS),
    failedOmitted: Math.max(0, failed.length - MAX_DELETE_PATHS) + unreadable,
    purgeFailed: answer.purgeFailed === true,
  };
}

/**
 * The dialog's read: `agents.list` (`operator.read`), never kept. Its facts are shown only when
 * the read is whole and still the newest list the host has; otherwise it is refused, and the
 * dialog offers Read again.
 */
export async function readBotDelete(ctx: BotDeleteContext, botId: string): Promise<BotDeleteRead> {
  const read = await ctx.readBots();
  const facts = deleteFacts(read.result, botId, ctx.stamp);
  if (!read.current()) throw new Error(`${STALE_ERROR} Read again.`);
  return facts;
}

/**
 * Delete a bot: the one path that sends `agents.delete`, and it sends it at most once. The bot
 * list is read first. Unless it is whole and still the newest list the host has shown, on the
 * connection still open, it decides nothing and hands back nothing (`unread`): the dialog reads
 * again. That check comes before any fact of the read is used, and nothing is awaited between
 * it and the send. Then the gateway's default bot is refused before anything else, and nothing
 * is sent unless everything the dialog showed of the bot is unchanged: its name, creation
 * record, folder and the bots that share it. The folder is removed only when it is the bot's own
 * and the gateway keeps a creation record for the bot. Anything that stops the delete before the
 * send is `not-sent`, `unread` or `changed`, and so is a confirmation whose typed text isn't the
 * bot's `ConfirmTarget` in this read; nothing after the send throws. The gateway's `ok`
 * for the bot is passed on at once, then the list is read again on the same connection.
 */
export async function deleteBot(
  ctx: BotDeleteContext,
  request: DeleteRequest,
): Promise<BotDeleteOutcome> {
  const { botId, deleteFiles, reviewed } = request;
  let before: { result: unknown; current(): boolean };
  try {
    if (!ctx.admin()) throw new AdminNeededError("Deleting a bot");
    if (!sameStamp(request.stamp, ctx.stamp))
      throw new Error("This delete was asked for another gateway, so nothing was sent.");
    before = await ctx.readBots();
  } catch (error) {
    return { kind: "not-sent", message: errorText(error) };
  }
  let read: BotDeleteRead;
  try {
    read = deleteFacts(before.result, botId, ctx.stamp);
  } catch (error) {
    return { kind: "unread", message: `${errorText(error)} Nothing was sent.` };
  }
  // Before any fact of this read is returned or acted on. From here to the send nothing is
  // awaited, so this is also the check at the point of send: a list a newer one superseded
  // decides nothing and says nothing.
  if (!before.current()) return { kind: "unread", message: `${STALE_ERROR} Nothing was sent.` };
  const changed = (reason: ChangedReason) => ({ kind: "changed" as const, reason, read });
  // The Main Bot first: no other answer of this read can lead past it.
  if (read.main) return changed("main");
  const reason = changedSince(read, reviewed);
  if (reason) return changed(reason);
  if (deleteFiles && !canRemoveFolder(read)) return changed("files");
  // What was typed is checked here too, against this read: no window can send without it.
  if (!confirmMatches(request.typed, read.confirm))
    return {
      kind: "not-sent",
      message: "What was typed isn't what the dialog asks for, so nothing was sent.",
    };
  if (!ctx.wanted())
    return {
      kind: "not-sent",
      message: "The window that asked for this delete closed. Nothing was sent.",
    };
  let sent: Promise<unknown>;
  try {
    sent = ctx.request("agents.delete", { agentId: botId, deleteFiles });
  } catch (error) {
    return { kind: "not-sent", message: errorText(error) };
  }
  let answer: unknown;
  let failure: unknown = null;
  try {
    answer = await sent;
  } catch (error) {
    failure = error;
  }
  // Only `ok: true` for the bot asked about says the gateway deleted it.
  const confirmed = failure === null && rec(answer).ok === true && rec(answer).agentId === botId;
  if (confirmed) ctx.deleted(botId);
  const { listed, listedAs } = await readListed(ctx, botId);
  const after = { listed, ...(listedAs === undefined ? {} : { listedAs }) };
  // Whatever failed once the request left, only reading the list follows: an error doesn't
  // establish what the gateway did.
  if (failure !== null)
    return { kind: "unconfirmed", message: errorText(failure), deleteFiles, ...after };
  if (!confirmed)
    return {
      kind: "unconfirmed",
      message: "its answer didn't say this bot was deleted",
      deleteFiles,
      ...after,
    };
  return fitAnswer({ kind: "answered", deleteFiles, ...readDeleteAnswer(answer), ...after });
}

type Answered = Extract<BotDeleteOutcome, { kind: "answered" }>;

/**
 * An answer within `MAX_DELETE_RESULT_CHARS` encoded: what the gateway confirmed always stays, and
 * as many paths as fit, those it couldn't move first, each list in order; the rest are counted.
 */
function fitAnswer(outcome: Answered): Answered {
  // Room for the counts to grow by a few digits each.
  let room =
    MAX_DELETE_RESULT_CHARS - JSON.stringify({ ...outcome, removed: [], failed: [] }).length - 64;
  // One that doesn't fit is skipped, and the scan goes on: a shorter one after it may.
  const keep = <T>(items: T[]): T[] => {
    const kept: T[] = [];
    for (const item of items) {
      const size = JSON.stringify(item).length + 1;
      if (size > room) continue;
      room -= size;
      kept.push(item);
    }
    return kept;
  };
  // Every path not moved is weighed before any moved one.
  const failed = keep(outcome.failed);
  const removed = keep(outcome.removed);
  const left = outcome.removed.filter((each) => !removed.includes(each));
  return {
    ...outcome,
    removed,
    removedOmitted: outcome.removedOmitted + left.filter((each) => each.method === "trash").length,
    missingOmitted:
      outcome.missingOmitted + left.filter((each) => each.method === "missing").length,
    failed,
    failedOmitted: outcome.failedOmitted + outcome.failed.length - failed.length,
  };
}

/**
 * Whether the gateway lists a bot under this id, and its name as the gateway gives it, from a
 * whole read that is still the newest the host has; null when it can't say.
 */
async function readListed(
  ctx: BotDeleteContext,
  botId: string,
): Promise<{ listed: boolean | null; listedAs?: string }> {
  try {
    const after = await ctx.readBots();
    const facts = deleteFacts(after.result, botId, ctx.stamp);
    if (!after.current()) return { listed: null };
    return facts.listed && facts.name !== null
      ? { listed: true, listedAs: facts.name }
      : { listed: facts.listed };
  } catch {
    return { listed: null };
  }
}
