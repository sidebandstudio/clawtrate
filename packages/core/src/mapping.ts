// Pure mapping from gateway payloads to view models. Inputs are treated as
// untrusted `unknown` values: a field with the wrong type is ignored rather than
// trusted, so a newer gateway adding or changing fields cannot crash the UI.

import type {
  Bot,
  Task,
  TaskContext,
  TaskStatus,
  ToolResult,
  TranscriptBlock,
  TranscriptItem,
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
    });
  }
  return bots.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

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
 * Gateway previews are the start of the last message, often markdown. Reduce
 * them to readable plain text for a two-line list preview.
 */
export function plainPreview(text: string | null): string | null {
  if (!text) return null;
  const plain = text
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

/** One session row to a task, or null for rows the sidebar should not show. */
export function mapSessionRow(row: RawRecord): Task | null {
  const key = sessionRowKey(row);
  if (!key || !isTaskSession(row)) return null;
  const botId = str(row.agentId) ?? botIdFromSessionKey(key);
  if (!botId) return null;
  return {
    key,
    botId,
    sessionId: str(row.sessionId),
    title: str(row.label) ?? str(row.derivedTitle) ?? str(row.displayName) ?? fallbackTitle(key),
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
  };
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

/** Group tasks under their bot: pinned first, then newest first. */
export function groupTasks(rows: Iterable<RawRecord>): Record<string, Task[]> {
  const grouped: Record<string, Task[]> = {};
  for (const row of rows) {
    const task = mapSessionRow(row);
    if (!task) continue;
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
  return JSON.stringify(value ?? {}, null, 2);
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
        argumentsText: prettyArguments(block.arguments ?? block.input),
        result: null,
      });
    }
  }
  return blocks;
}

function meta(message: RawRecord): RawRecord {
  return asRecord(message.__openclaw) ?? {};
}

const SYSTEM_ROW_TEXT: Record<string, string> = {
  compaction: "Earlier messages were compacted",
  reset: "Session was reset",
};

/**
 * `chat.history` messages to display items. Consecutive assistant messages of
 * one run (tool rounds) become a single assistant turn, and each tool result is
 * attached to the call that produced it.
 */
export function mapHistory(messages: unknown): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let currentRun: string | null = null;
  const pendingCalls = new Map<string, Extract<TranscriptBlock, { kind: "tool-call" }>>();
  /** The item each pending call is in, so a cut result marks it. */
  const callItems = new Map<string, TranscriptItem>();

  arr(messages).forEach((entry, index) => {
    const message = asRecord(entry);
    if (!message) return;
    const info = meta(message);
    const id = `${str(info.id) ?? `row-${index}`}:${index}`;
    const timestamp = num(message.timestamp) ?? num(info.recordTimestampMs);
    const kind = str(info.kind);
    // The gateway cut this row to its display length.
    const cutByGateway = info.truncated === true;

    if (kind && SYSTEM_ROW_TEXT[kind]) {
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
        if (!text.trim()) return;
        items.push({
          id,
          role: "user",
          timestamp,
          blocks: [{ kind: "text", text }],
          model: null,
          ...(cutByGateway ? { truncated: true } : {}),
        });
        return;
      }
      case "assistant": {
        const blocks = assistantBlocks(message.content);
        for (const block of blocks) {
          if (block.kind === "tool-call" && block.callId) pendingCalls.set(block.callId, block);
        }
        const runId = str(info.runId);
        const previous = items.at(-1);
        let item: TranscriptItem;
        if (previous?.role === "assistant" && runId !== null && runId === currentRun) {
          previous.blocks.push(...blocks);
          item = previous;
        } else {
          currentRun = runId;
          if (blocks.length === 0) return;
          item = { id, role: "assistant", timestamp, blocks, model: str(message.model) };
          items.push(item);
        }
        if (cutByGateway) item.truncated = true;
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
        call.result = result;
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

/** Visible text from a streaming `chat` event's message snapshot. */
export function liveTextFromChatMessage(message: unknown): string {
  return textOf(asRecord(message)?.content);
}
