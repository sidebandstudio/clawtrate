// Managing a bot's tasks from the rail: new, rename, pin, mark unread or read,
// archive, restore and delete, and the bot's Archived list. Every call stays at
// `operator.write`, the interactive tier: the parameters are only those the
// gateway's own policy admits at write (`resolveSessionsPatchRequiredScope`,
// `resolveSessionsCreateRequiredScope` and `resolveSessionsDeleteRequiredScope`
// in OpenClaw 2026.10.6's `session-method-scopes-base`), so none of them can
// ask for admin. Nothing here is kept: the Archived list is an answer, read
// again each time, and the task list itself is the client's, updated by the
// gateway's `sessions.changed`.

import { externalChannelOf } from "./channels.ts";
import { isOtherToolSession } from "./origins.ts";
import { asRecord, mapSessionRow, plainPreview, type RawRecord } from "./mapping.ts";

/** The longest label the gateway takes (`SESSION_LABEL_MAX_LENGTH`). */
export const MAX_TASK_LABEL_CHARS = 512;
/** Archived tasks one read lists; past it `more` is true. */
export const MAX_ARCHIVED_LISTED = 50;
/** Pages one Archived read takes at most, when the channel chats it leaves out thin them. */
export const MAX_ARCHIVED_PAGES = 10;
/** How long a stop may take before an archive or delete gives up waiting for it. */
export const STOP_SETTLE_MS = 15_000;
/** Between two reads of a task's row while a stop settles. */
export const STOP_POLL_MS = 250;
/**
 * A bot's canonical main task: the key the gateway treats as the bot's main
 * session (`isMain`), which it never archives or deletes, and which
 * `sessions.create` makes once: a second create of the same key while the
 * first is under way is refused with "session changed before sessions.create;
 * retry the request", and the retry answers the same session.
 */
export function mainTaskKey(botId: string): string {
  return `agent:${botId}:main`;
}
/** Times a create of the canonical main is retried after the gateway says another made it meanwhile. */
const MAIN_ATTEMPTS = 4;

/** What these actions need from the client: the gateway, the write tier, and time. */
export type TaskActionContext = {
  request: (method: string, params: unknown) => Promise<unknown>;
  /** Resolves once the connection holds `operator.write`; asks for it when the client does not mean to hold it. */
  ensureWrite: () => Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /**
   * What the engine knows, from the gateway's events and rows, of a task's runs:
   * a token that changes when a run starts or the row turns active. Archive reads
   * it before and after its own check, and sends nothing if it moved.
   */
  runMark: (key: string) => string;
  /** Moves each time a run of the task is seen to end as stopped (`WaitingIndex.stopMark`). */
  stopMark: (key: string) => number;
  /**
   * The engine's own Stop (`ClawtrateClient.stopRun`) for each run of the task it
   * follows that is running or waiting. Answers how many of its runs are now
   * running, waiting or stopping: 0 when it follows none.
   */
  stopRuns: (key: string) => Promise<number>;
  /** Whether a run of the task the engine follows is still running, waiting or stopping. */
  runsActive: (key: string) => boolean;
};

/** How long an archive waits for the end of a run that started while its request was out. */
export const ARCHIVE_STOP_WAIT_MS = 3_000;

/** What an archive did beyond archiving: a run that had just started was stopped by it. */
export type ArchiveResult = { stoppedRun: boolean };

/** An archived task, as the Archived group shows it. */
export type ArchivedTask = {
  key: string;
  botId: string;
  sessionId: string | null;
  title: string;
  preview: string | null;
  archivedAt: number | null;
  updatedAt: number | null;
};

export type ArchivedList = { tasks: ArchivedTask[]; more: boolean };

/** Archive or delete was asked of a task whose run is still active, without "Stop and …". */
/** What an archive refused because the task is working says; it crosses the bridge as a message. */
export const ACTIVE_RUN_MESSAGE = "This task is still working. Stop it first.";

export class ActiveRunError extends Error {
  constructor() {
    super(ACTIVE_RUN_MESSAGE);
    this.name = "ActiveRunError";
  }
}

// Parameters -------------------------------------------------------------------

/** A label as the gateway takes it: trimmed, 1 to 512 characters, one line. */
export function taskLabel(value: string): string {
  const label = value.replace(/\s+/g, " ").trim();
  if (!label) throw new Error("A task needs a name.");
  if (label.length > MAX_TASK_LABEL_CHARS)
    throw new Error(`A task's name can be at most ${MAX_TASK_LABEL_CHARS} characters.`);
  return label;
}

/** A new, empty task: only `agentId` and `label`, which keeps `sessions.create` at write. */
export function newTaskParams(botId: string, label: string | null): Record<string, unknown> {
  return { agentId: botId, ...(label ? { label: taskLabel(label) } : {}) };
}

/** The bot's canonical main task: `agentId` and its key, still write (the key is not incognito). */
export function mainTaskParams(botId: string): Record<string, unknown> {
  return { agentId: botId, key: mainTaskKey(botId) };
}

export function renameParams(key: string, label: string): Record<string, unknown> {
  return { key, label: taskLabel(label) };
}

export function pinParams(key: string, pinned: boolean): Record<string, unknown> {
  return { key, pinned };
}

/**
 * Mark unread, or read. A read that the person did not ask for (opening the
 * task) names the unread marker it saw, so it never clears a "Mark as unread"
 * made since on another device (`expectedMarkedUnreadAt`, null for none).
 */
export function unreadParams(
  key: string,
  unread: boolean,
  seenMarker?: number | null,
): Record<string, unknown> {
  return {
    key,
    unread,
    ...(unread || seenMarker === undefined ? {} : { expectedMarkedUnreadAt: seenMarker }),
  };
}

/** Archive or restore. The gateway requires the session id it is meant for. */
export function archiveParams(
  key: string,
  sessionId: string,
  archived: boolean,
): Record<string, unknown> {
  return { key, archived, expectedSessionId: sessionId };
}

/** Delete an archived task and its transcript: `archivedOnly` is what keeps it at write. */
export function deleteParams(key: string, sessionId: string): Record<string, unknown> {
  return { key, archivedOnly: true, deleteTranscript: true, expectedSessionId: sessionId };
}

/** The Archived group's read: one bot's archived tasks, newest first. */
export function archivedListParams(botId: string): Record<string, unknown> {
  return {
    agentId: botId,
    archived: true,
    limit: MAX_ARCHIVED_LISTED + 1,
    includeDerivedTitles: true,
    includeLastMessage: true,
  };
}

// Reading ---------------------------------------------------------------------

/** An archived row to what the group shows; any other row is not one. */
export function mapArchivedRow(
  row: RawRecord,
  botId: string,
  firstMessageTitle?: (key: string) => string | null,
): ArchivedTask | null {
  if (row.archived !== true) return null;
  // The task list's own mapping refuses archived rows; read the rest the same way.
  const key = typeof row.key === "string" ? row.key : null;
  const task = mapSessionRow(
    { ...row, archived: false },
    { firstMessage: key ? (firstMessageTitle?.(key) ?? null) : null },
  );
  if (!task || task.botId !== botId) return null;
  const archivedAt = typeof row.archivedAt === "number" ? row.archivedAt : null;
  return {
    key: task.key,
    botId,
    sessionId: task.sessionId,
    title: task.title,
    preview: plainPreview(
      typeof row.lastMessagePreview === "string" ? row.lastMessagePreview : null,
    ),
    archivedAt,
    updatedAt: task.updatedAt,
  };
}

/**
 * A bot's archived tasks; chats from external channels only with `showChannelChats`, and sessions
 * another tool opened only with `showOtherToolSessions`, as the list.
 */
export async function listArchived(
  ctx: TaskActionContext,
  botId: string,
  options: {
    showChannelChats?: boolean;
    showOtherToolSessions?: boolean;
    /** The title a task's first message makes, as the task list has it (`taskTitle`). */
    firstMessageTitle?: (key: string) => string | null;
  } = {},
): Promise<ArchivedList> {
  const tasks: ArchivedTask[] = [];
  let more: boolean;
  // A page of channel chats or other tools' sessions left out lists nothing, so read on until the
  // group is full.
  for (let pages = 1, offset = 0; ; pages += 1) {
    const params = archivedListParams(botId);
    const result = asRecord(
      await ctx.request("sessions.list", offset > 0 ? { ...params, offset } : params),
    );
    const rows = Array.isArray(result?.sessions) ? result.sessions : [];
    for (const entry of rows) {
      const row = asRecord(entry);
      if (row && options.showChannelChats !== true && externalChannelOf(row)) continue;
      if (row && options.showOtherToolSessions !== true && isOtherToolSession(row)) continue;
      const task = row && mapArchivedRow(row, botId, options.firstMessageTitle);
      if (task) tasks.push(task);
    }
    const next = result?.nextOffset;
    more = result?.hasMore === true;
    if (!more || tasks.length > MAX_ARCHIVED_LISTED || pages >= MAX_ARCHIVED_PAGES) break;
    if (typeof next !== "number" || next <= offset) break;
    offset = next;
  }
  tasks.sort(
    (a, b) =>
      (b.archivedAt ?? b.updatedAt ?? 0) - (a.archivedAt ?? a.updatedAt ?? 0) ||
      a.key.localeCompare(b.key),
  );
  return {
    tasks: tasks.slice(0, MAX_ARCHIVED_LISTED),
    more: tasks.length > MAX_ARCHIVED_LISTED || more,
  };
}

/** One task's row as the gateway has it now, or null when it has none. */
async function describe(ctx: TaskActionContext, key: string): Promise<RawRecord | null> {
  return asRecord(asRecord(await ctx.request("sessions.describe", { key }))?.session);
}

function isActive(row: RawRecord): boolean {
  return row.hasActiveRun === true || row.status === "running" || row.status === "queued";
}

function sessionIdOf(row: RawRecord | null, key: string): string {
  const id = row?.sessionId;
  if (typeof id !== "string" || !id) throw new Error(`The gateway has no task ${key}.`);
  return id;
}

/**
 * Stop whatever runs in a task, then wait, within `STOP_SETTLE_MS`, until the
 * gateway's own row says nothing does and the engine's runs of it have ended.
 * Returns the row it last read.
 *
 * A run the engine follows is stopped by the engine's Stop, as the Stop button
 * does: it is `stopping` until the gateway says how it ended, one the gateway has
 * not named yet is aborted once it is named, and the follow-ups queued behind it
 * are parked when it stops, so none is sent into the task being archived. Only
 * when the engine follows no run of the task (another device's, or a task not open
 * here) does the gateway's own abort of the session's runs stop it.
 */
export async function stopAndSettle(ctx: TaskActionContext, key: string): Promise<RawRecord> {
  if ((await ctx.stopRuns(key)) === 0) await ctx.request("chat.abort", { sessionKey: key });
  const deadline = ctx.now() + STOP_SETTLE_MS;
  for (;;) {
    const row = await describe(ctx, key);
    if (!row) throw new Error(`The gateway has no task ${key}.`);
    if (!isActive(row) && !ctx.runsActive(key)) return row;
    if (ctx.now() >= deadline)
      throw new Error("The task's run did not stop in time. Nothing was archived or deleted.");
    await ctx.sleep(STOP_POLL_MS);
  }
}

// Acting -----------------------------------------------------------------------

/** A gateway refusal in the person's words, where the gateway's own is not. */
export function actionError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const inUse = /^label already in use: (.*)$/s.exec(message);
  if (inUse) return new Error(`Another task of this bot is already called "${inUse[1]}".`);
  return error instanceof Error ? error : new Error(message);
}

/**
 * The gateway's answer to a change made while its own session routing changed under it
 * (a bot added or removed, its configuration reloaded): `SessionMutationFactsUnavailableError`,
 * "retry after session storage is ready" (OpenClaw 2026.10.6, `session-sharing-preparation`).
 */
const ROUTING_CHANGED = /retry after session storage is ready/;
/** Times a change the gateway asked to retry is sent again. */
export const ROUTING_ATTEMPTS = 4;
/** Between two attempts of such a change. */
const ROUTING_RETRY_MS = 250;

/**
 * One change on the gateway. A patch or a delete is sent again when the gateway asks for it,
 * up to `ROUTING_ATTEMPTS` times: each names the session it is for (`expectedSessionId`),
 * so a repeat changes nothing the first did not. A create names nothing and is never repeated.
 */
async function call(ctx: TaskActionContext, method: string, params: unknown): Promise<unknown> {
  const repeatable = method === "sessions.patch" || method === "sessions.delete";
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await ctx.request(method, params);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!repeatable || attempt >= ROUTING_ATTEMPTS || !ROUTING_CHANGED.test(message))
        throw actionError(error);
      await ctx.sleep(ROUTING_RETRY_MS);
    }
  }
}

/** The created task's key and its row as the answer gives it, for the list until `sessions.changed` lands. */
export type CreatedTask = { key: string; row: RawRecord };

function created(result: unknown, botId: string): CreatedTask {
  const answer = asRecord(result);
  const key = answer?.key;
  if (typeof key !== "string" || !key) throw new Error("The gateway did not name the new task.");
  const entry = asRecord(answer?.entry) ?? {};
  const row: RawRecord = { key, agentId: botId };
  for (const field of ["sessionId", "label", "updatedAt", "createdAt"] as const) {
    if (entry[field] !== undefined) row[field] = entry[field];
  }
  if (typeof answer?.sessionId === "string") row.sessionId = answer.sessionId;
  return { key, row };
}

/** A new, empty task under a bot. Nothing runs until the person writes in it. */
export async function newTask(
  ctx: TaskActionContext,
  botId: string,
  label: string | null,
): Promise<CreatedTask> {
  const params = newTaskParams(botId, label);
  await ctx.ensureWrite();
  return created(await call(ctx, "sessions.create", params), botId);
}

/**
 * A bot's replacement first task (F-424): its canonical main, titled "Main",
 * empty. However many clients ask at once, the gateway makes one session for
 * the key; a client whose create met another's retries and is answered with
 * that same session, so every client selects the same task.
 */
export async function newMainTask(ctx: TaskActionContext, botId: string): Promise<CreatedTask> {
  await ctx.ensureWrite();
  for (let attempt = 1; ; attempt += 1) {
    try {
      return created(await ctx.request("sessions.create", mainTaskParams(botId)), botId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= MAIN_ATTEMPTS || !/session changed before sessions\.create/.test(message))
        throw actionError(error);
    }
  }
}

export async function renameTask(
  ctx: TaskActionContext,
  key: string,
  label: string,
): Promise<void> {
  const params = renameParams(key, label);
  await ctx.ensureWrite();
  await call(ctx, "sessions.patch", params);
}

export async function pinTask(ctx: TaskActionContext, key: string, pinned: boolean): Promise<void> {
  await ctx.ensureWrite();
  await call(ctx, "sessions.patch", pinParams(key, pinned));
}

export async function markTask(
  ctx: TaskActionContext,
  key: string,
  unread: boolean,
  seenMarker?: number | null,
): Promise<void> {
  await ctx.ensureWrite();
  await call(ctx, "sessions.patch", unreadParams(key, unread, seenMarker));
}

/**
 * Archive a task. One whose run is active is archived only with `stop`, after
 * the gateway confirms the run stopped ("Stop and archive"); without it, the
 * archive is refused with `ActiveRunError` and nothing is asked.
 */
export async function archiveTask(
  ctx: TaskActionContext,
  key: string,
  options: { stop: boolean },
): Promise<ArchiveResult> {
  await ctx.ensureWrite();
  const mark = ctx.runMark(key);
  let row = await describe(ctx, key);
  if (row && isActive(row)) {
    if (!options.stop) throw new ActiveRunError();
    row = await stopAndSettle(ctx, key);
  } else if (!options.stop && ctx.runMark(key) !== mark) {
    // A run started, or the row turned active, while the check was under way: archiving now
    // would stop it, so nothing is sent and the person is asked.
    throw new ActiveRunError();
  }
  if (row?.archived === true) return { stoppedRun: false };
  const sent = { run: ctx.runMark(key), stop: ctx.stopMark(key) };
  await call(ctx, "sessions.patch", archiveParams(key, sessionIdOf(row, key), true));
  if (options.stop) return { stoppedRun: false };
  // The gateway's archive ends anything running in the task (its drain), and has no guard
  // against a run that starts while the request is out. When a run started meanwhile, its own
  // end event says whether the archive stopped it; that end comes with or just after the answer.
  if (ctx.stopMark(key) === sent.stop && ctx.runMark(key) !== sent.run) {
    const deadline = ctx.now() + ARCHIVE_STOP_WAIT_MS;
    while (ctx.stopMark(key) === sent.stop && ctx.now() < deadline) await ctx.sleep(STOP_POLL_MS);
  }
  return { stoppedRun: ctx.stopMark(key) !== sent.stop };
}

export async function restoreTask(ctx: TaskActionContext, key: string): Promise<void> {
  await ctx.ensureWrite();
  const row = await describe(ctx, key);
  if (row?.archived !== true) return;
  await call(ctx, "sessions.patch", archiveParams(key, sessionIdOf(row, key), false));
}

/**
 * Delete a task and its transcript, after the person confirmed. An active run
 * is stopped first and the stop confirmed; the task is archived, then deleted
 * with `archivedOnly`, the only delete the write tier may make. What the bot
 * saved to memory during the task is the bot's, and stays.
 */
export async function deleteTask(ctx: TaskActionContext, key: string): Promise<void> {
  await ctx.ensureWrite();
  let row = await describe(ctx, key);
  if (!row) return;
  if (isActive(row)) row = await stopAndSettle(ctx, key);
  const sessionId = sessionIdOf(row, key);
  if (row.archived !== true) await call(ctx, "sessions.patch", archiveParams(key, sessionId, true));
  await call(ctx, "sessions.delete", deleteParams(key, sessionId));
}
