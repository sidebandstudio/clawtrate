// Managing a bot's tasks from the rail: new, rename, pin, mark unread or read,
// archive, restore and delete, and the bot's Archived list. Every call stays at
// `operator.write`, the interactive tier: the parameters are only those the
// gateway's own policy admits at write (`resolveSessionsPatchRequiredScope`,
// `resolveSessionsCreateRequiredScope` and `resolveSessionsDeleteRequiredScope`
// in OpenClaw 2026.10.6's `session-method-scopes-base`), so none of them can
// ask for admin. Nothing here is kept: the Archived list is an answer, read
// again each time, and the task list itself is the client's, updated by the
// gateway's `sessions.changed`.

import { asRecord, mapSessionRow, plainPreview, type RawRecord } from "./mapping.ts";

/** The longest label the gateway takes (`SESSION_LABEL_MAX_LENGTH`). */
export const MAX_TASK_LABEL_CHARS = 512;
/** Archived tasks one read lists; past it `more` is true. */
export const MAX_ARCHIVED_LISTED = 50;
/** How long a stop may take before an archive or delete gives up waiting for it. */
export const STOP_SETTLE_MS = 15_000;
/** Between two reads of a task's row while a stop settles. */
export const STOP_POLL_MS = 250;
/** The name a bot's replacement first task takes (F-424); labels are unique per bot. */
export const MAIN_LABEL = "Main";
/** Labels tried for the replacement Main before it is made without one. */
const MAIN_ATTEMPTS = 5;

/** What these actions need from the client: the gateway, the write tier, and time. */
export type TaskActionContext = {
  request: (method: string, params: unknown) => Promise<unknown>;
  /** Resolves once the connection holds `operator.write`; asks for it when the client does not mean to hold it. */
  ensureWrite: () => Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

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
export class ActiveRunError extends Error {
  constructor() {
    super("This task is still working. Stop it first.");
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

export async function listArchived(ctx: TaskActionContext, botId: string): Promise<ArchivedList> {
  const result = asRecord(await ctx.request("sessions.list", archivedListParams(botId)));
  const rows = Array.isArray(result?.sessions) ? result.sessions : [];
  const tasks: ArchivedTask[] = [];
  for (const entry of rows) {
    const row = asRecord(entry);
    const task = row && mapArchivedRow(row, botId);
    if (task) tasks.push(task);
  }
  tasks.sort(
    (a, b) =>
      (b.archivedAt ?? b.updatedAt ?? 0) - (a.archivedAt ?? a.updatedAt ?? 0) ||
      a.key.localeCompare(b.key),
  );
  return {
    tasks: tasks.slice(0, MAX_ARCHIVED_LISTED),
    more: tasks.length > MAX_ARCHIVED_LISTED || result?.hasMore === true,
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
 * gateway's own row says nothing does. Returns the row it last read.
 */
export async function stopAndSettle(ctx: TaskActionContext, key: string): Promise<RawRecord> {
  await ctx.request("chat.abort", { sessionKey: key });
  const deadline = ctx.now() + STOP_SETTLE_MS;
  for (;;) {
    const row = await describe(ctx, key);
    if (!row) throw new Error(`The gateway has no task ${key}.`);
    if (!isActive(row)) return row;
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

async function call(ctx: TaskActionContext, method: string, params: unknown): Promise<unknown> {
  try {
    return await ctx.request(method, params);
  } catch (error) {
    throw actionError(error);
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
 * A bot's replacement first task, "Main" (F-424). Labels are unique per bot and
 * an archived task keeps its label, so "Main 2" and on are tried, then none.
 */
export async function newMainTask(ctx: TaskActionContext, botId: string): Promise<CreatedTask> {
  await ctx.ensureWrite();
  for (let attempt = 1; attempt <= MAIN_ATTEMPTS; attempt += 1) {
    const label = attempt === 1 ? MAIN_LABEL : `${MAIN_LABEL} ${attempt}`;
    try {
      return created(await ctx.request("sessions.create", newTaskParams(botId, label)), botId);
    } catch (error) {
      if (!/label already in use/.test(error instanceof Error ? error.message : String(error)))
        throw actionError(error);
    }
  }
  return created(await call(ctx, "sessions.create", newTaskParams(botId, null)), botId);
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
): Promise<void> {
  await ctx.ensureWrite();
  let row = await describe(ctx, key);
  if (row && isActive(row)) {
    if (!options.stop) throw new ActiveRunError();
    row = await stopAndSettle(ctx, key);
  }
  if (row?.archived === true) return;
  await call(ctx, "sessions.patch", archiveParams(key, sessionIdOf(row, key), true));
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
