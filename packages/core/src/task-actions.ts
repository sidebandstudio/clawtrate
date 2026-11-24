// Managing a bot's tasks from the rail: new, rename, pin, mark unread or read,
// archive, restore and delete, and the bot's Archived list. Every call stays at
// `operator.write`, the interactive tier: the parameters are only those the
// gateway's own policy admits at write (`resolveSessionsPatchRequiredScope`,
// `resolveSessionsCreateRequiredScope` and `resolveSessionsDeleteRequiredScope`
// in OpenClaw 2026.10.6's `session-method-scopes-base`), so none of them can
// ask for admin. Nothing here is kept: the Archived list is an answer, read
// again each time, and the task list itself is the client's, updated by the
// gateway's `sessions.changed`.

import { jsonTextLength } from "./bounds.ts";
import { externalChannelOf } from "./channels.ts";
import { asRecord, mapSessionRow, plainPreview, type RawRecord } from "./mapping.ts";
import { MAX_ID_CHARS } from "./state-bounds.ts";

/** A message the gateway did not take because the task it was written in is gone (F-278). */
export const TASK_DELETED_ELSEWHERE = "This task was deleted elsewhere.";
/** A message the gateway did not take because the task it was written in was archived (F-277). */
export const TASK_ARCHIVED_ELSEWHERE = "This task was archived elsewhere.";
/**
 * A message the gateway did not take because its task was reset elsewhere and now holds the next
 * session under its key (`previousSessionId` names the one it was written for) (F-278).
 */
export const TASK_RESET_ELSEWHERE = "This task was reset elsewhere.";

/**
 * A message the gateway refused because its task was deleted, archived or reset elsewhere: sent
 * again to the same session it would be refused the same way, so it offers a new task instead,
 * and Resend only once its task is live again (F-278, F-277).
 */
export function refusedElsewhere(message: { status: string; error: string | null }): boolean {
  return (
    message.status === "failed" &&
    (message.error === TASK_DELETED_ELSEWHERE ||
      message.error === TASK_ARCHIVED_ELSEWHERE ||
      message.error === TASK_RESET_ELSEWHERE)
  );
}
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
export function mapArchivedRow(row: RawRecord, botId: string): ArchivedTask | null {
  if (row.archived !== true) return null;
  // The task list's own mapping refuses archived rows; read the rest the same way.
  const task = mapSessionRow({ ...row, archived: false });
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

/** A bot's archived tasks; chats from external channels only with `showChannelChats`, as the list. */
export async function listArchived(
  ctx: TaskActionContext,
  botId: string,
  options: { showChannelChats?: boolean } = {},
): Promise<ArchivedList> {
  const tasks: ArchivedTask[] = [];
  let more: boolean;
  // A page of channel chats left out lists nothing, so read on until the group is full.
  for (let pages = 1, offset = 0; ; pages += 1) {
    const params = archivedListParams(botId);
    const result = asRecord(
      await ctx.request("sessions.list", offset > 0 ? { ...params, offset } : params),
    );
    const rows = Array.isArray(result?.sessions) ? result.sessions : [];
    for (const entry of rows) {
      const row = asRecord(entry);
      if (row && options.showChannelChats !== true && externalChannelOf(row)) continue;
      const task = row && mapArchivedRow(row, botId);
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
  const row = asRecord(asRecord(await ctx.request("sessions.describe", { key }))?.session);
  if (typeof row?.sessionId === "string" && jsonTextLength(row.sessionId) > MAX_ID_CHARS)
    throw new Error("That task's session can't be named.");
  return row;
}

/**
 * The key no longer holds the selected session. A Stop may already have been sent.
 */
export const TASK_GONE = "This task was already deleted or reset elsewhere.";

export const OPEN_TASK_FIRST = "Open the task first so its session can be confirmed.";

export async function describeSelected(
  ctx: TaskActionContext,
  key: string,
  sessionId: string,
): Promise<RawRecord> {
  if (!sessionId || sessionId.trim() !== sessionId) throw new Error(OPEN_TASK_FIRST);
  return selectedRow(await describe(ctx, key), key, sessionId);
}

function selectedRow(row: RawRecord | null, key: string, sessionId: string): RawRecord {
  if (!row || row.sessionId !== sessionId || (row.key !== undefined && row.key !== key))
    throw new Error(TASK_GONE);
  return row;
}

function isActive(row: RawRecord): boolean {
  return row.hasActiveRun === true || row.status === "running" || row.status === "queued";
}

function sessionIdOf(row: RawRecord | null, key: string): string {
  const id = row?.sessionId;
  if (typeof id !== "string" || !id) throw new Error(`The gateway has no task ${key}.`);
  return id;
}

export async function stopNamedRuns(
  ctx: TaskActionContext,
  key: string,
  row: RawRecord,
): Promise<string[]> {
  const ids = row.activeRunIds;
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    !ids.every(
      (id): id is string =>
        typeof id === "string" &&
        id.length > 0 &&
        id.trim() === id &&
        jsonTextLength(id) <= MAX_ID_CHARS,
    )
  )
    throw new Error("Couldn't stop this task. The gateway didn't name its active runs.");
  const runIds = [...new Set(ids)];
  await Promise.all(runIds.map((runId) => ctx.request("chat.abort", { sessionKey: key, runId })));
  return runIds;
}

async function stopAndSettle(
  ctx: TaskActionContext,
  key: string,
  sessionId: string,
  row: RawRecord,
): Promise<RawRecord> {
  await stopNamedRuns(ctx, key, row);
  const deadline = ctx.now() + STOP_SETTLE_MS;
  for (;;) {
    const current = await describeSelected(ctx, key, sessionId);
    if (!isActive(current)) return current;
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
      if (
        asRecord(params)?.expectedSessionId &&
        /^Session .+ changed before (patch|deletion)\. Retry\.$/s.test(message)
      )
        throw new Error(TASK_GONE, { cause: error });
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
 * archive is refused with `ActiveRunError` and nothing is asked. With
 * `sessionId`, a missing or different session at the first check prevents Stop and Archive.
 */
export async function archiveTask(
  ctx: TaskActionContext,
  key: string,
  options: { stop: boolean; sessionId: string },
): Promise<ArchiveResult> {
  await ctx.ensureWrite();
  const mark = ctx.runMark(key);
  let row = await describeSelected(ctx, key, options.sessionId);
  if (isActive(row)) {
    if (!options.stop) throw new ActiveRunError();
    row = await stopAndSettle(ctx, key, options.sessionId, row);
  } else if (!options.stop && ctx.runMark(key) !== mark) {
    // A run started, or the row turned active, while the check was under way: archiving now
    // would stop it, so nothing is sent and the person is asked.
    throw new ActiveRunError();
  }
  if (row?.archived === true) return { stoppedRun: false };
  const sent = { run: ctx.runMark(key), stop: ctx.stopMark(key) };
  await call(ctx, "sessions.patch", archiveParams(key, options.sessionId, true));
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
 * saved to memory during the task is the bot's, and stays. With `sessionId`,
 * a different session at the first check prevents Stop, Archive and Delete.
 */
export async function deleteTask(
  ctx: TaskActionContext,
  key: string,
  options: { sessionId: string },
): Promise<void> {
  await ctx.ensureWrite();
  const { sessionId } = options;
  if (!sessionId || sessionId.trim() !== sessionId) throw new Error(OPEN_TASK_FIRST);
  const first = await describe(ctx, key);
  if (!first) return;
  let row = selectedRow(first, key, sessionId);
  if (isActive(row)) row = await stopAndSettle(ctx, key, options.sessionId, row);
  if (row.archived !== true) await call(ctx, "sessions.patch", archiveParams(key, sessionId, true));
  try {
    await call(ctx, "sessions.delete", deleteParams(key, sessionId));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === `Session ${key} is not archived. Archive it first, then delete it.`
    ) {
      await describeSelected(ctx, key, sessionId);
    }
    throw error;
  }
}
