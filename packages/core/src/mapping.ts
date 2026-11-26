// Pure mapping from gateway payloads to view models. Inputs are treated as
// untrusted `unknown` values: a field with the wrong type is ignored rather than
// trusted, so a newer gateway adding or changing fields cannot crash the UI.

import { cutText, jsonTextLength } from "./bounds.ts";
import { utf8Length } from "./encoding.ts";
import { channelChatTitle, externalChannelOf, stripChannelMetadata } from "./channels.ts";
import { isOtherToolSession } from "./origins.ts";
import {
  gatewayPreviewOf,
  rowIdempotencyKey,
  UPDATE_NOTICE_KEY_PREFIX,
  updateNoticeLine,
  updateNoticeRunId,
  updateNoticeText,
  type UpdateNoticeScope,
} from "./update-notice.ts";
import type {
  Bot,
  Task,
  TaskContext,
  TaskStarter,
  TaskStatus,
  ToolResult,
  TranscriptBlock,
  TranscriptItem,
  Transcript,
  ChatFile,
  ChatPicture,
  SentAttachment,
} from "./types.ts";

export type RawRecord = Record<string, unknown>;

export function asRecord(value: unknown): RawRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RawRecord)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Only image data URIs and https URLs are rendered; anything else could leak a credential or fail. */
export function safeAvatarUrl(value: unknown): string | null {
  const url = str(value);
  if (!url) return null;
  if (/^data:image\/(png|jpeg|webp|gif);base64,/i.test(url)) return url;
  if (/^https:\/\//i.test(url)) return url;
  return null;
}

/** `agents.list` result to bots, default bot first, system agents hidden. */
export function mapAgents(result: unknown): Bot[] {
  const record = asRecord(result);
  if (!record) return [];
  const defaultId = str(record.defaultId);
  // With no owner the gateway still names a `defaultId`: only its first bot (F-562).
  const ownerless = record.selectionRequired === true;
  const bots: Bot[] = [];
  for (const entry of arr(record.agents)) {
    const agent = asRecord(entry);
    const id = str(agent?.id);
    if (!agent || !id || agent.kind === "system") continue;
    const identity = asRecord(agent.identity) ?? {};
    const model = asRecord(agent.model);
    bots.push({
      id,
      name: str(identity.name) ?? str(agent.name) ?? id,
      emoji: str(identity.emoji),
      avatarUrl: safeAvatarUrl(identity.avatarUrl),
      theme: str(identity.theme),
      model: str(model?.primary) ?? (typeof agent.model === "string" ? agent.model : null),
      isDefault: id === defaultId,
      ...(ownerless && id === defaultId ? { ownerless: true } : {}),
    });
  }
  return bots.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

/**
 * The run id the gateway gives a bot's turn that reports on a task it started, or on a follow-up
 * it sent there: `announce:v1:<task key>:<that task's run id>` (OpenClaw 2026.10.6).
 */
export const REPORT_RUN_PREFIX = "announce:v1:";

/** `agent:<id>:<rest>` keys carry their agent; other keys fall back to the row's agentId. */
export function botIdFromSessionKey(key: string): string | null {
  const match = /^agent:([^:]+):/.exec(key);
  return match ? match[1]! : null;
}

export function sessionRowKey(row: RawRecord): string | null {
  return str(row.key) ?? str(row.sessionKey);
}

/** Merge a delta into a cached row: present fields replace, `null` clears, omitted fields stay. */
export function mergeSessionRow(base: RawRecord | undefined, patch: RawRecord): RawRecord {
  return { ...base, ...patch };
}

/**
 * The row carried by a `sessions.changed` event. Newer gateways nest the full
 * row under `session`; the flat payload carries the same fields for older readers.
 */
export function sessionChangeRow(payload: unknown): RawRecord | null {
  const record = asRecord(payload);
  if (!record) return null;
  const nested = asRecord(record.session);
  const row = nested ? { ...nested } : { ...record };
  delete row.session;
  // Normalize to `key`, the field `sessions.list` rows use.
  const key = str(row.key) ?? str(row.sessionKey) ?? str(record.sessionKey) ?? str(record.key);
  if (key) row.key = key;
  if (!str(row.agentId) && str(record.agentId)) row.agentId = record.agentId;
  return row;
}

export function isSessionRemoval(payload: unknown): boolean {
  const record = asRecord(payload);
  const reason = str(record?.reason);
  return reason === "delete" || reason === "deleted" || record?.deleted === true;
}

/**
 * Gateway previews are the start of the last message, often markdown, and for
 * a channel turn wrapped in what the gateway wrote around it. Reduce them to
 * readable plain text for a two-line list preview.
 */
export function plainPreview(text: string | null): string | null {
  if (!text) return null;
  const plain = stripChannelMetadata(text)
    .split("\n")
    .filter((line) => !/^\s*\|?\s*:?-{3,}/.test(line)) // table separator rows
    .join(" ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links and images
    .replace(/[*_~`]+/g, "") // emphasis and code marks
    .replace(/(^|\s)(#{1,6}|>|[-+]|\d+\.)\s+/g, "$1") // headings, quotes, list markers
    .replace(/\s*\|\s*/g, " · ") // table cells
    .replace(/(\s*·\s*)+/g, " · ")
    .replace(/^\s*·\s*|\s*·\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain || null;
}

function taskStatus(row: RawRecord): TaskStatus {
  const status = str(row.status);
  if (status === "running") return "running";
  if (status === "queued") return row.hasActiveRun === true ? "running" : "queued";
  if (row.hasActiveRun === true) return "running";
  if (status === "failed" || status === "error" || status === "timeout" || str(row.lastRunError))
    return "failed";
  if (status === "interrupted" || status === "killed") return "stopped";
  if (status === "done") return "done";
  return "idle";
}

/**
 * A title for a row that names none: a bot's main task is "Main", and a task
 * made empty from the rail ("New task", `agent:<bot>:dashboard:<id>`) is
 * "New task" until it is renamed or its first message gives it a title.
 */
function fallbackTitle(key: string): string {
  const rest = key.split(":").slice(2).join(":") || key;
  if (rest === "main") return "Main";
  if (/^dashboard:[0-9a-f-]{8,}$/i.test(rest)) return "New task";
  return rest;
}

/**
 * Whether a session belongs in the task list. Mirrors the gateway's own
 * `excludeCron` and `excludeSubagents` filters (2026.10.6), so rows that arrive
 * through `sessions.changed` follow the same rules as the initial snapshot.
 * Only the key and fields present on the row are consulted.
 */
export function isTaskSession(row: RawRecord): boolean {
  const key = sessionRowKey(row);
  if (!key) return false;
  if (row.archived === true) return false;
  const lower = key.toLowerCase();
  if (/^(?:cron:|agent::*[^:]+:+cron:+[^:])/u.test(lower)) return false;
  const rest = /^agent:[^:]+:(.*)$/u.exec(lower)?.[1] ?? "";
  if (lower.startsWith("subagent:") || rest.startsWith("subagent:")) return false;
  if (str(row.spawnedBy) && !rest.startsWith("dashboard:") && !str(row.category)) return false;
  return true;
}

/** Whether a key alone rules a session out, before any row data is known. */
export function isExcludedSessionKey(key: string): boolean {
  return !isTaskSession({ key });
}

/** The bot a session row belongs to: its own `agentId`, else the one its key names. */
export function rowBotOf(key: string, row: RawRecord): string | null {
  return str(row.agentId) ?? botIdFromSessionKey(key);
}

/** One session row to a task, or null for rows the sidebar should not show. */
export function mapSessionRow(row: RawRecord): Task | null {
  const key = sessionRowKey(row);
  if (!key || !isTaskSession(row)) return null;
  const botId = rowBotOf(key, row);
  if (!botId) return null;
  const channel = externalChannelOf(row);
  return {
    key,
    botId,
    sessionId: str(row.sessionId),
    title: channel
      ? channelChatTitle(row, channel)
      : (str(row.label) ?? str(row.derivedTitle) ?? str(row.displayName) ?? fallbackTitle(key)),
    preview: plainPreview(str(row.lastMessagePreview)),
    updatedAt: num(row.updatedAt) ?? num(row.lastActivityAt) ?? num(row.createdAt),
    status: taskStatus(row),
    unread: row.unread === true,
    ...((typeof row.isMain === "boolean" ? row.isMain : /^agent:[^:]+:main$/.test(key))
      ? { isMain: true }
      : {}),
    ...(row.pinned === true ? { pinned: true } : {}),
    ...(row.markedUnreadAt !== undefined ? { unreadMarker: num(row.markedUnreadAt) } : {}),
    ...contextOf(row),
    ...(str(row.thinkingLevel) ? { effort: str(row.thinkingLevel)! } : {}),
    ...(isOtherToolSession(row) ? { otherTool: true as const } : {}),
    ...(channel ? { channel } : {}),
    ...startedByOf(row),
  };
}

/**
 * Who started a task a bot started with `sessions_spawn`, only from the gateway's own fields:
 * `createdVia: "spawn"`, and `spawnedBy`, the task it was started from, whose bot started it
 * (the gateway's `createdActor` names the same bot). Nothing the bot wrote, its label or brief,
 * counts.
 */
function startedByOf(row: RawRecord): { startedBy: TaskStarter } | Record<string, never> {
  if (row.createdVia !== "spawn") return {};
  const fromKey = str(row.spawnedBy);
  const botId = fromKey ? botIdFromSessionKey(fromKey) : null;
  return fromKey && botId ? { startedBy: { botId, fromKey } } : {};
}

/**
 * When a bot started the task in `chat.history`'s `sessionInfo`, the time the gateway created it
 * (`createdAt`), so `mapHistory` can find the brief; null for any other task, and when the
 * history read does not reach the task's first row (`hasMore`).
 */
export function startedTaskSince(history: unknown): number | null {
  const record = asRecord(history);
  const info = asRecord(record?.sessionInfo);
  if (!info || info.createdVia !== "spawn" || record?.hasMore === true) return null;
  return num(info.createdAt);
}

/**
 * Context use from a session row: `totalTokens` (the latest run's context, as
 * the gateway counts it) out of `contextTokens` (the model's context window).
 */
function contextOf(row: RawRecord): { context: TaskContext } | Record<string, never> {
  const used = num(row.totalTokens);
  const window = num(row.contextTokens);
  if (used === null || window === null || window <= 0) return {};
  return { context: { used, window, fresh: row.totalTokensFresh !== false } };
}

/** Rows from a `sessions.list` result, keyed by session key. */
export function sessionRowsFromList(result: unknown): RawRecord[] {
  const record = asRecord(result);
  return arr(record?.sessions).flatMap((entry) => {
    const row = asRecord(entry);
    return row && sessionRowKey(row) ? [row] : [];
  });
}

/**
 * Group tasks under their bot: pinned first, then newest first. Chats from an
 * external channel are left out unless `showChannelChats`, and sessions another
 * tool opened unless `showOtherToolSessions`, so nothing derived from the list
 * (a bot's preview, unread, recency, the badge) counts them.
 */
export function groupTasks(
  rows: Iterable<RawRecord>,
  options: { showChannelChats?: boolean; showOtherToolSessions?: boolean } = {},
): Record<string, Task[]> {
  const grouped: Record<string, Task[]> = {};
  for (const row of rows) {
    const task = mapSessionRow(row);
    if (!task || (task.channel && options.showChannelChats !== true)) continue;
    if (task.otherTool && options.showOtherToolSessions !== true) continue;
    (grouped[task.botId] ??= []).push(task);
  }
  for (const tasks of Object.values(grouped)) {
    tasks.sort(
      (a, b) =>
        Number(b.pinned === true) - Number(a.pinned === true) ||
        (b.updatedAt ?? 0) - (a.updatedAt ?? 0) ||
        a.key.localeCompare(b.key),
    );
  }
  return grouped;
}

const MAX_TOOL_RESULT_CHARS = 8000;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return arr(content)
    .map((part) => {
      const block = asRecord(part);
      return block && block.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .join("");
}

function prettyArguments(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value === undefined ? null : value, null, 2);
}

/**
 * The pictures a bot's message hands over: its `image` blocks that the gateway
 * holds as artifacts. The address a block names is never kept, so never used.
 */
function assistantPictures(content: unknown): ChatPicture[] {
  const size = (value: unknown) => {
    const n = num(value);
    return n !== null && Number.isInteger(n) && n > 0 ? n : null;
  };
  return arr(content).flatMap((part) => {
    const block = asRecord(part);
    const artifactId = block?.type === "image" ? str(block.artifactId) : null;
    if (!block || !artifactId) return [];
    return [
      {
        artifactId,
        alt: str(block.alt),
        prompt: null,
        mimeType: str(block.mimeType),
        width: size(block.width),
        height: size(block.height),
        sizeBytes: size(block.sizeBytes),
      },
    ];
  });
}

/** The longest preview of a file-only message kept (`TranscriptItem.filesPreview`): two sidebar lines. */
const MAX_FILES_PREVIEW_CHARS = 200;

/** The longest file name shown or offered for saving, in UTF-8 bytes: what macOS, Linux and Windows file systems all take. */
export const MAX_FILE_NAME_BYTES = 255;

/** As much of `text` as fits in `bytes` UTF-8 bytes, cut between characters. */
function fitBytes(text: string, bytes: number): string {
  let out = "";
  let used = 0;
  for (const char of text) {
    const size = utf8Length(char);
    if (used + size > bytes) break;
    out += char;
    used += size;
  }
  return out;
}

/**
 * A file name a gateway gave, safe to show and to offer for saving: its last
 * path part only, with control, format (zero-width, direction, soft hyphen,
 * tag) and separator characters and lone surrogates taken out, at most
 * `MAX_FILE_NAME_BYTES` UTF-8 bytes, cut between characters with its extension
 * kept, so the name shown is the name saved. "File" when nothing is left.
 */
export function cleanFileName(raw: unknown): string {
  const last = (typeof raw === "string" ? raw : "").split(/[/\\]/).at(-1) ?? "";
  const name = last
    .replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, "")
    .trim()
    .replace(/^\.+$/, "");
  if (!name) return "File";
  if (utf8Length(name) <= MAX_FILE_NAME_BYTES) return name;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
  const room = MAX_FILE_NAME_BYTES - utf8Length("…") - utf8Length(extension);
  return `${fitBytes(name.slice(0, name.length - extension.length), room)}…${extension}`;
}

/** A media type as the gateway names it, lower-cased, or null for anything else. */
const mediaType = (value: unknown): string | null => {
  const type = str(value);
  return type && /^[\w.+-]{1,64}\/[\w.+-]{1,128}$/.test(type) ? type.toLowerCase() : null;
};

/** Blocks the gateway hands a file over in (OpenClaw 2026.10.6, `buildManagedMediaBlock`). */
const KNOWN_FILES = new Set(["attachment", "audio", "video"]);

/** Blocks of a bot's message that are never a file it hands over. */
const NOT_FILES = new Set([
  "text",
  "thinking",
  "redacted_thinking",
  "toolCall",
  "tool_use",
  "image",
]);

/**
 * The files that aren't pictures a bot's message hands over (F-115), in its
 * order: `attachment` blocks (documents), `audio` and `video` blocks, any other
 * block that names an artifact, and `attachment_error` blocks, which name a
 * file the gateway couldn't hand over. A block missing a field still gives a
 * file, from what it has. The address a block names is never kept, so never used.
 */
function assistantFiles(content: unknown): ChatFile[] {
  return arr(content).flatMap((part) => {
    const block = asRecord(part);
    const type = str(block?.type);
    if (!block || !type || NOT_FILES.has(type)) return [];
    const failed = type === "attachment_error";
    const fact = type === "attachment" || failed ? (asRecord(block.attachment) ?? {}) : block;
    const artifactId = failed ? null : str(fact.artifactId);
    // A block of a kind the gateway names files with is a row even without an id; another needs one.
    if (!failed && !KNOWN_FILES.has(type) && !artifactId) return [];
    const size = num(fact.sizeBytes);
    return [
      {
        artifactId,
        name: cleanFileName(str(fact.label) ?? str(fact.fileName) ?? str(fact.title)),
        mimeType: mediaType(fact.mimeType),
        sizeBytes: size !== null && Number.isInteger(size) && size >= 0 ? size : null,
      },
    ];
  });
}

/** Most files one message may carry (`chat.send`'s own limit, as `attachments.ts` keeps it). */
const MAX_SENT_ATTACHMENTS = 20;
const MAX_SENT_NAME_CHARS = 255;

/** A person's row's `__openclaw.media` entries, in order: the same list for its files and their references. */
const sentFacts = (info: RawRecord): RawRecord[] =>
  arr(info.media)
    .slice(0, MAX_SENT_ATTACHMENTS)
    .flatMap((entry) => {
      const fact = asRecord(entry);
      return fact ? [fact] : [];
    });

/**
 * The files a person's row carried: the gateway's `__openclaw.media` entries, in
 * their order, by name, type and size. The `media://inbound` reference an entry
 * names stays in the host (`sentSources`), never in the view.
 */
function sentAttachments(info: RawRecord): SentAttachment[] {
  return sentFacts(info).flatMap((fact) => {
    // An entry with no name is still a file the message carried.
    const name = str(fact.fileName) ?? (fact.kind === "image" ? "Picture" : "File");
    const size = num(fact.sizeBytes);
    const type = str(fact.contentType);
    return [
      {
        fileName:
          name.length > MAX_SENT_NAME_CHARS ? `${name.slice(0, MAX_SENT_NAME_CHARS - 1)}…` : name,
        mimeType: type && /^[\w.+-]{1,64}\/[\w.+-]{1,128}$/.test(type) ? type.toLowerCase() : null,
        sizeBytes: size !== null && Number.isInteger(size) && size >= 0 ? size : null,
      },
    ];
  });
}

/** The longest reference kept, and the most kept for one task: as many as its history shows files. */
export const MAX_INBOUND_REF_CHARS = 512;
export const MAX_SENT_SOURCES = 40;

/**
 * A person's attachment as their row names it (`__openclaw.media[].url`), exactly
 * `media://inbound/<id>`: one segment that isn't `.` or `..`, with no `/`, `\`, `?`, `#`, `%`,
 * space or control character, so nothing is decoded and nothing else is named. Null otherwise;
 * an entry's `path`, or any other address, is never one.
 */
export function inboundRef(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_INBOUND_REF_CHARS) return null;
  // eslint-disable-next-line no-control-regex
  const match = /^media:\/\/inbound\/([^/\\?#%\s\u0000-\u001f\u007f]+)$/.exec(value);
  return match && match[1] !== "." && match[1] !== ".." ? value : null;
}

/**
 * Each file's reference on a person's own rows (`inboundRef`), by the key a row is asked for
 * under (its idempotency key, or else its id) and the file's place among the row's files:
 * `${rowKey}\u0000${index}`. Never a bot's or the gateway's row, and never an entry without a
 * reference in that exact form. The newest `MAX_SENT_SOURCES` are kept, as the state keeps the
 * newest files. The host keeps these (`readSentPicture`); the view never has them.
 */
export function sentSources(messages: unknown): Map<string, string> {
  const sources = new Map<string, string>();
  const rows = new Set<string>();
  for (const entry of [...arr(messages)].reverse()) {
    const message = asRecord(entry);
    if (message?.role !== "user" || gatewayTurn(message, false)) continue;
    const info = meta(message);
    const rowKey = str(info.idempotencyKey) ?? str(message.idempotencyKey) ?? str(info.id);
    // The first row of a key, newest first, is the one its message shows.
    if (!rowKey || rowKey.length > MAX_INBOUND_REF_CHARS || rows.has(rowKey)) continue;
    rows.add(rowKey);
    const facts = sentFacts(info);
    for (let index = facts.length - 1; index >= 0; index -= 1) {
      if (sources.size >= MAX_SENT_SOURCES) return sources;
      const ref = inboundRef(facts[index]!.url);
      if (ref) sources.set(`${rowKey}\u0000${index}`, ref);
    }
  }
  return sources;
}

function assistantBlocks(content: unknown): TranscriptBlock[] {
  if (typeof content === "string") return content.trim() ? [{ kind: "text", text: content }] : [];
  const blocks: TranscriptBlock[] = [];
  for (const part of arr(content)) {
    const block = asRecord(part);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      blocks.push({ kind: "text", text: block.text });
    } else if (
      block.type === "thinking" &&
      typeof block.thinking === "string" &&
      block.thinking.trim()
    ) {
      blocks.push({ kind: "reasoning", text: block.thinking });
    } else if (block.type === "toolCall" || block.type === "tool_use") {
      blocks.push({
        kind: "tool-call",
        callId: str(block.id) ?? "",
        name: str(block.name) ?? "tool",
        // Absent arguments are said to be absent; an explicit null stays null.
        ...("arguments" in block || "input" in block
          ? { argumentsText: prettyArguments("arguments" in block ? block.arguments : block.input) }
          : { argumentsText: "", argumentsAbsent: true }),
        result: null,
      });
    }
  }
  return blocks;
}

/**
 * The description an earlier `image_generate` call asked for, when `runId` is the
 * turn the gateway runs by itself to deliver that call's background task
 * (`image_generate:<taskId>:ok:…`): the call whose result named the task.
 */
function imagePrompt(runId: string | null, items: TranscriptItem[]): string | null {
  const task = runId ? /^image_generate:(tool:image_generate:[^:\s]+):ok:/.exec(runId)?.[1] : null;
  if (!task) return null;
  for (const item of [...items].reverse())
    for (const block of item.blocks)
      if (
        block.kind === "tool-call" &&
        block.name === "image_generate" &&
        block.result?.text.includes(`(${task})`)
      ) {
        try {
          const prompt = asRecord(JSON.parse(block.argumentsText))?.prompt;
          return typeof prompt === "string" && prompt.trim() ? prompt.trim() : null;
        } catch {
          return null;
        }
      }
  return null;
}

function meta(message: RawRecord): RawRecord {
  return asRecord(message.__openclaw) ?? {};
}

const SYSTEM_ROW_TEXT: Record<string, string> = {
  compaction: "Earlier messages were compacted",
  reset: "Session was reset",
};

/**
 * A turn the gateway wrote itself: a user row whose `provenance.kind` is
 * `internal_system` (OpenClaw 2026.10.6 and 2026.11.10, `input-provenance`). It shows
 * as a line saying what the gateway did. The restart recovery's prompt names a
 * restart the gateway believes happened; the line says only that it resumed a turn.
 * On 2026.11.10 that recovery is a session event of its own, `source: "restart"`, whose
 * text is the gateway's prompt to the bot (`session-restart-resume.ts`); on 2026.10.6 a
 * `restart` event is the restart sentinel's queued message, which keeps today's line.
 * `event` is the row's text when it is a system event the gateway woke the task with
 * (`mapHistory`'s `gatewayEvents`, `isSessionEventRow`), not its own prompt to the bot.
 */
function gatewayTurn(
  message: RawRecord,
  events: boolean,
): { line: string; event: string | null } | null {
  const provenance = asRecord(message.provenance) ?? asRecord(meta(message).provenance);
  if (provenance?.kind !== "internal_system") return null;
  const source = str(provenance.sourceTool)?.toLowerCase();
  if (source === "main_session_restart_recovery" || (events && source === "restart"))
    return { line: "The gateway resumed an earlier turn by itself", event: null };
  return {
    line: "The gateway started a turn by itself",
    event: events && isSessionEventRow(message) ? eventText(textOf(message.content)) : null,
  };
}

/**
 * The row the gateway's own session event path writes (OpenClaw 2026.11.10,
 * `session-event-context.ts`): its delivery names the event's occurrence
 * (`__openclaw.transport.messageId`), the key it is stored under, and no person sent it
 * (no `__openclaw.senderId`). The provenance alone is not enough: a client with
 * `operator.write` can have `agent` write it on a row of its own, which the gateway stores
 * under `<its key>:user`, with no such delivery and the client's person as its sender.
 */
function isSessionEventRow(message: RawRecord): boolean {
  const info = meta(message);
  const key = str(message.idempotencyKey);
  return (
    key !== null &&
    str(info.idempotencyKey) === key &&
    str(asRecord(info.transport)?.messageId) === key &&
    (info.senderId === undefined || info.senderId === null)
  );
}

/** The most of a system event's text kept, in JSON characters as the state counts them: within one block's bound. */
export const MAX_EVENT_TEXT_CHARS = 2_000;

/**
 * A system event's text as content from elsewhere: a command's output, a scheduled event's
 * words, what a bot or a plugin woke the task with. Control and format characters go, line
 * breaks stay (at most one blank line in a row), cut to `MAX_EVENT_TEXT_CHARS` with "…".
 * Null when nothing is left.
 */
export function eventText(raw: string): string | null {
  const text = raw
    .replace(/\r\n?/g, "\n")
    .replace(/(?:(?![\n\t])[\p{Cc}\p{Cs}\u2028\u2029]|(?!\p{Join_Control})\p{Cf})+/gu, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return null;
  if (jsonTextLength(text) <= MAX_EVENT_TEXT_CHARS) return text;
  return `${cutText(text, MAX_EVENT_TEXT_CHARS - 1).trimEnd()}…`;
}

/** The row's own time (`timestamp`, kept as written when a row is copied) is at or after `since`. */
function isWrittenSince(message: RawRecord, since: number | null): boolean {
  const written = num(message.timestamp);
  return since !== null && written !== null && written >= since;
}

/**
 * How soon after the gateway created a task its brief is stored: it writes the brief as it
 * creates the task (30 to 332 ms on OpenClaw 2026.10.6). A first row stored later is not the
 * brief: a transcript the gateway started over by itself (a daily or idle reset) keeps the task's
 * creation time, and its first row is the person's.
 */
export const BRIEF_WINDOW_MS = 30_000;

/**
 * `chat.history` messages to display items. Consecutive assistant messages of
 * one run (tool rounds) become a single assistant turn, and each tool result is
 * attached to the call that produced it.
 */
export function mapHistory(
  messages: unknown,
  options: {
    /**
     * In a task a bot started, when the gateway created it (`startedTaskSince`). The first row
     * it stored from then on, of any role, is the bot's brief when it is a user row, a turn's own
     * input (`<run>:user`), stored within `BRIEF_WINDOW_MS` of then: the gateway writes the brief
     * as the task's first turn, and a forked task's copied rows keep the earlier times they were
     * written. A reset's row, stored after the task was made, or a row with no time ends the
     * search: nothing after it is the brief.
     */
    startedAt?: number | null;
    /**
     * The gateway writes a system event it wakes a task with as the text of its own user row
     * (OpenClaw 2026.11.10, which has no heartbeat): that row's line then carries the event's
     * text. On 2026.10.6 the same row holds the gateway's heartbeat or completion prompt, so it
     * stays the line alone. Only the gateway's reported version tells them apart.
     */
    gatewayEvents?: boolean;
  } = {},
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const startedAt = options.startedAt ?? null;
  let briefSought = startedAt !== null;
  let currentRun: string | null = null;
  // The user rows between two assistant rows can all join at the same tool boundary.
  let precedingRun: string | null = null;
  const pendingUsers: TranscriptItem[] = [];
  const pendingCalls = new Map<string, Extract<TranscriptBlock, { kind: "tool-call" }>>();
  /** The item each pending call is in, so a cut result marks it. */
  const callItems = new Map<string, TranscriptItem>();
  /** The update notice keys rows were stored under so far: only the first can be the notice. */
  const noticeKeys = new Set<string>();
  /** The latest time of any row so far, for what a notice comes after. */
  let latestAt: number | null = null;
  /** A row so far had no time: what a later notice comes after is not known. */
  let timeUnknown = false;

  arr(messages).forEach((entry, index) => {
    const message = asRecord(entry);
    if (!message) return;
    const info = meta(message);
    const id = `${str(info.id) ?? `row-${index}`}:${index}`;
    const timestamp = num(message.timestamp) ?? num(info.recordTimestampMs);
    const before = timeUnknown ? null : latestAt;
    if (timestamp === null) timeUnknown = true;
    else if (latestAt === null || timestamp > latestAt) latestAt = timestamp;
    const kind = str(info.kind);
    const storedKey = rowIdempotencyKey(message);
    const firstOfKey =
      storedKey?.startsWith(UPDATE_NOTICE_KEY_PREFIX) === true && !noticeKeys.has(storedKey);
    if (firstOfKey) noticeKeys.add(storedKey!);
    // The gateway cut this row to its display length.
    const cutByGateway = info.truncated === true;
    // The first row the task stored itself, of any role (a reset's row too), ends the search for
    // the brief; so does a row with no time, which could be the task's own or a copied one.
    let first = false;
    if (briefSought && num(message.timestamp) === null) briefSought = false;
    else if (briefSought && isWrittenSince(message, startedAt)) {
      briefSought = false;
      first = message.role === "user";
    }

    if (kind && SYSTEM_ROW_TEXT[kind]) {
      precedingRun = null;
      pendingUsers.length = 0;
      items.push({
        id,
        role: "system",
        timestamp,
        blocks: [{ kind: "text", text: SYSTEM_ROW_TEXT[kind] }],
        model: null,
      });
      currentRun = null;
      return;
    }

    switch (message.role) {
      case "user": {
        const text = textOf(message.content);
        currentRun = null;
        const turn = gatewayTurn(message, options.gatewayEvents === true);
        if (turn) {
          precedingRun = null;
          pendingUsers.length = 0;
          items.push({
            id,
            role: "system",
            timestamp,
            blocks: [
              { kind: "text", text: turn.line },
              ...(turn.event ? [{ kind: "text" as const, text: turn.event }] : []),
            ],
            model: null,
            ...(turn.event ? { gatewayEvent: true as const } : {}),
          });
          return;
        }
        const attachments = sentAttachments(info);
        // A message that is only files still shows: its files are what it said.
        if (!text.trim() && attachments.length === 0) return;
        const messageId = str(info.id);
        const replyTo = replyReference(info);
        const idempotencyKey = str(info.idempotencyKey) ?? str(message.idempotencyKey);
        const brief =
          first &&
          idempotencyKey?.endsWith(":user") === true &&
          num(message.timestamp)! - startedAt! <= BRIEF_WINDOW_MS;
        const user: TranscriptItem = {
          id,
          role: "user",
          timestamp,
          blocks: text.trim() ? [{ kind: "text", text }] : [],
          model: null,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(cutByGateway ? { truncated: true } : {}),
          ...(messageId ? { messageId } : {}),
          ...(replyTo ? { replyTo } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(brief ? { brief: true as const } : {}),
        };
        items.push(user);
        if (precedingRun !== null) pendingUsers.push(user);
        return;
      }
      case "assistant": {
        const blocks = assistantBlocks(message.content);
        for (const block of blocks) {
          if (block.kind === "tool-call" && block.callId) pendingCalls.set(block.callId, block);
        }
        const runId = str(info.runId);
        const pictures = assistantPictures(message.content);
        const files = assistantFiles(message.content);
        const prompt = pictures.length > 0 ? imagePrompt(runId, items) : null;
        for (const picture of pictures) picture.prompt = prompt;
        if (runId !== null && runId === precedingRun) {
          for (const user of pendingUsers) user.steered = true;
        }
        pendingUsers.length = 0;
        precedingRun = runId;
        const previous = items.at(-1);
        let item: TranscriptItem;
        if (previous?.role === "assistant" && runId !== null && runId === currentRun) {
          previous.blocks.push(...blocks);
          item = previous;
        } else {
          // An empty row starts no turn: a later row of its run gets one of its own, never the last.
          if (blocks.length === 0 && pictures.length === 0 && files.length === 0) return;
          currentRun = runId;
          item = { id, role: "assistant", timestamp, blocks, model: str(message.model) };
          if (runId?.startsWith(REPORT_RUN_PREFIX)) item.reportRunId = runId;
          // A row that names no run, not even as a reply kept after an abort, is no run's reply.
          if (runId === null && str(asRecord(message.openclawAbort)?.runId) === null) {
            item.runless = true;
          }
          // Perhaps the gateway's update notice: the first row with its key, never a later one.
          const updateRunId = firstOfKey ? updateNoticeRunId(message) : null;
          if (updateRunId) {
            item.updateRunId = updateRunId;
            // Unknown when an earlier row had no time: then no read is proof of reading it.
            if (before !== null) item.updateNoticeAfter = before;
            // The row's own time, never the store's: what the line's rule compares.
            const written = num(message.timestamp);
            if (written !== null) item.updateNoticeWrittenAt = written;
          }
          items.push(item);
        }
        // A reaction or a reply names the row whose text a bubble shows: each bubble its own row.
        const rowId = str(info.id);
        // The same picture twice in one turn is drawn once, where it first came.
        const held = new Set((item.pictures ?? []).map((picture) => picture.artifactId));
        const added = pictures.filter((picture) => {
          if (held.has(picture.artifactId)) return false;
          held.add(picture.artifactId);
          if (rowId) picture.messageId = rowId;
          return true;
        });
        if (added.length > 0) item.pictures = [...(item.pictures ?? []), ...added];
        // Files likewise: once each, where it first came; one the gateway couldn't hand over has no id.
        const handed = new Set((item.files ?? []).map((file) => file.artifactId));
        const more = files.filter((file) => {
          if (file.artifactId !== null && handed.has(file.artifactId)) return false;
          handed.add(file.artifactId);
          if (rowId) file.messageId = rowId;
          return true;
        });
        if (more.length > 0) item.files = [...(item.files ?? []), ...more];
        // When the item's last row with text or files had files only: their names, for the sidebar.
        if (blocks.some((block) => block.kind === "text" && block.text.trim()))
          delete item.filesPreview;
        else if (files.length > 0)
          item.filesPreview = files
            .map((file) => file.name)
            .join(", ")
            .slice(0, MAX_FILES_PREVIEW_CHARS);
        if (cutByGateway) item.truncated = true;
        if (rowId) {
          for (const block of blocks)
            if (block.kind === "text" && block.text.trim()) {
              block.messageId = rowId;
              item.messageId = rowId;
            }
        }
        // An answer the gateway delivered as a reply names what it answers on its own row
        // (`openclawDelivery.replyToId`), so only that row's bubbles join the thread.
        const answers = str(asRecord(message.openclawDelivery)?.replyToId);
        if (answers) {
          for (const block of blocks)
            if (block.kind === "text" && block.text.trim()) block.replyToId = answers;
        }
        for (const block of blocks) {
          if (block.kind === "tool-call" && block.callId) callItems.set(block.callId, item);
        }
        return;
      }
      case "toolResult":
      case "tool": {
        const callId = str(message.toolCallId) ?? str(message.tool_call_id);
        const call = callId ? pendingCalls.get(callId) : undefined;
        if (!call) return;
        const text = textOf(message.content);
        const result: ToolResult = {
          isError: message.isError === true,
          text:
            text.length > MAX_TOOL_RESULT_CHARS
              ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n… (${text.length - MAX_TOOL_RESULT_CHARS} more characters)`
              : text,
        };
        const facts = historyFacts(message.details);
        // Cut by the gateway when it stored the row, or here at this app's cap.
        const cut = cutByGateway || text.length > MAX_TOOL_RESULT_CHARS;
        call.result = { ...result, ...(facts ? { facts } : {}), ...(cut ? { clipped: true } : {}) };
        const holder = callItems.get(callId!);
        if (cutByGateway && holder) holder.truncated = true;
        return;
      }
      default:
        return;
    }
  });
  return items;
}

/**
 * A user row's reply reference (`__openclaw.replyToId`). Its text is the preview stored beside it
 * (`replyToPreview {text, senderLabel?}`), or else the message history attached at read time
 * (`replyToMessage {ok, message}`). Cut to its bound here. Nothing else makes a user row a reply.
 */
function replyReference(info: RawRecord): TranscriptItem["replyTo"] | null {
  const id = str(info.replyToId);
  if (!id) return null;
  const preview = asRecord(info.replyToPreview);
  const attached = asRecord(info.replyToMessage);
  const original = attached?.ok === true ? asRecord(attached.message) : null;
  const text = str(preview?.text) ?? (original ? textOf(original.content).trim() || null : null);
  return {
    id,
    text: text === null ? null : text.length > 480 ? `${text.slice(0, 479)}…` : text,
    sender: str(preview?.senderLabel),
  };
}

/** Visible text from a streaming `chat` event's message snapshot. */
export function liveTextFromChatMessage(message: unknown): string {
  return textOf(asRecord(message)?.content);
}

/**
 * The detail keys of a history row the reading reads: those the gateway's
 * chat display projection keeps that say how a call ended, and a diff's line
 * counts (the diff itself is in the step's raw payload).
 */
function historyFacts(details: unknown): Record<string, unknown> | null {
  const d = asRecord(details);
  if (!d) return null;
  const out: Record<string, unknown> = {};
  if (typeof d.exitCode === "number" && Number.isFinite(d.exitCode)) out.exitCode = d.exitCode;
  for (const key of ["ok", "changed", "created"] as const)
    if (typeof d[key] === "boolean") out[key] = d[key];
  if (typeof d.diff === "string") {
    const rows = d.diff.split("\n");
    out.diffStat = {
      added: rows.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length,
      removed: rows.filter((l) => l.startsWith("-") && !l.startsWith("---")).length,
    };
  }
  return Object.keys(out).length ? out : null;
}

/** The start of a message read for a preview in place of the gateway's: more than two lines show. */
const MAX_PREVIEW_SOURCE_CHARS = 400;

/**
 * A task's preview when its loaded history ends with a bot's message that is only files (F-115):
 * that message's files' names. The gateway lists the last row with text, the one before it, so
 * only that preview, or none, is replaced; any other is the gateway's.
 */
export function taskWithFilePreview(task: Task, transcript: Transcript | undefined): Task {
  const items = transcript?.items ?? [];
  const last = items.at(-1);
  const preview = last?.role === "assistant" ? last.filesPreview : undefined;
  if (!preview) return task;
  let before: string | null = null;
  for (let index = items.length - 1; index >= 0 && before === null; index -= 1) {
    const text = items[index]!.blocks.findLast(
      (block) => block.kind === "text" && block.text.trim(),
    );
    if (text?.kind === "text") before = plainPreview(text.text.slice(0, MAX_PREVIEW_SOURCE_CHARS));
  }
  if (task.preview !== null && task.preview !== before) return task;
  return preview === task.preview ? task : { ...task, preview };
}

/** Every listed task as `taskWithFilePreview` shows it, by bot. */
export function tasksWithFilePreviews(
  tasksByBot: Record<string, Task[]>,
  transcripts: Record<string, Transcript>,
): Record<string, Task[]> {
  let changed = false;
  const shown: Record<string, Task[]> = {};
  for (const [botId, tasks] of Object.entries(tasksByBot)) {
    shown[botId] = tasks.map((task) => {
      const named = taskWithFilePreview(task, transcripts[task.key]);
      if (named !== task) changed = true;
      return named;
    });
  }
  return changed ? shown : tasksByBot;
}

/**
 * When a task's loaded history ends with an update line (`updateNoticeLine`) and its listed
 * preview is the one the gateway makes of that notice (`gatewayPreviewOf`): the item before the line, or null when there is none. Undefined otherwise:
 * the listed row then has something newer, or the line is not this device's to draw.
 */
function beforeUpdateNotice(
  task: Task,
  transcript: Transcript | undefined,
  scope: UpdateNoticeScope,
): TranscriptItem | null | undefined {
  const items = transcript?.items ?? [];
  const last = items.at(-1);
  if (!last || last.truncated === true || task.preview === null) return undefined;
  if (!updateNoticeLine(last, task.key, scope)) return undefined;
  const listed = gatewayPreviewOf(updateNoticeText(last));
  if (listed === null || plainPreview(listed) !== task.preview) return undefined;
  return items.at(-2) ?? null;
}

/**
 * A task's preview in the sidebar when its listed preview is the update notice its loaded history
 * ends with (F-590): the text of the last item before it (null when none has text, so the title
 * shows). The notice is not what the bot last said.
 * No time is changed, so the order is the gateway's.
 */
export function taskWithoutUpdateNotice(
  task: Task,
  transcript: Transcript | undefined,
  scope: UpdateNoticeScope,
): Task {
  if (beforeUpdateNotice(task, transcript, scope) === undefined) return task;
  const items = transcript!.items;
  let preview: string | null = null;
  for (let index = items.length - 2; index >= 0 && preview === null; index -= 1) {
    const item = items[index]!;
    // An earlier update line is not what the bot said either.
    if (item.role === "system" || updateNoticeLine(item, task.key, scope)) continue;
    // A bot's message that is only files reads as their names, as the rail shows it (F-115).
    if (item.role === "assistant" && item.filesPreview) {
      preview = item.filesPreview;
      continue;
    }
    const text = item.blocks.findLast((block) => block.kind === "text" && block.text.trim());
    if (text?.kind === "text") preview = plainPreview(text.text.slice(0, MAX_PREVIEW_SOURCE_CHARS));
  }
  return preview === task.preview ? task : { ...task, preview };
}

/** Every listed task as `taskWithoutUpdateNotice` shows it, by bot. */
export function tasksWithoutUpdateNotices(
  tasksByBot: Record<string, Task[]>,
  transcripts: Record<string, Transcript>,
  scope: UpdateNoticeScope,
): Record<string, Task[]> {
  if (!scope.updated?.length || scope.mainKey === null) return tasksByBot;
  let changed = false;
  const shown: Record<string, Task[]> = {};
  for (const [botId, tasks] of Object.entries(tasksByBot)) {
    shown[botId] = tasks.map((task) => {
      const quiet = taskWithoutUpdateNotice(task, transcripts[task.key], scope);
      if (quiet !== task) changed = true;
      return quiet;
    });
  }
  return changed ? shown : tasksByBot;
}

/**
 * For a viewer that keeps its own memory of what it read (a read-only connection), when it read a
 * task through, past an update notice that is all that came since: when the task's listed preview
 * is the notice its loaded history ends with, and the viewer read the task at or after the latest
 * row before it (`updateNoticeAfter`, so every row of a merged turn; both are the gateway's times),
 * the task's own time. Otherwise `seenAt`. On a
 * connection that writes, the gateway keeps unread, and the notice doesn't raise it: writing it
 * moves only the row's `updatedAt` (OpenClaw 2026.10.6, `deriveSessionUnread`).
 */
export function seenThroughUpdateNotice(
  task: Task,
  seenAt: number | undefined,
  transcript: Transcript | undefined,
  scope: UpdateNoticeScope,
): number | undefined {
  if (seenAt === undefined || task.updatedAt === null || task.updatedAt <= seenAt) return seenAt;
  if (beforeUpdateNotice(task, transcript, scope) === undefined) return seenAt;
  // Back through earlier update lines (two updates with nothing between them) to the first: what
  // came before it is what the viewer must have read.
  const items = transcript!.items;
  let first = items.length - 1;
  while (first > 0 && updateNoticeLine(items[first - 1], task.key, scope)) first -= 1;
  if (first === 0) {
    // Nothing loaded before the line: the conversation had nothing else only if it is all loaded.
    return transcript!.hasMore ? seenAt : task.updatedAt;
  }
  const after = items[first]!.updateNoticeAfter;
  if (after === undefined || seenAt < after) return seenAt;
  return task.updatedAt;
}
