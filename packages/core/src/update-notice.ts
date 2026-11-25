// The gateway's notice that an update of OpenClaw finished ("✅ OpenClaw updated. For details,
// …"). The gateway writes it into the main bot's main conversation after the restart, as an
// assistant row; the bot did not say it. It shows as a quiet line of Clawtrate's own words,
// "OpenClaw updated to <version>", only when this device followed that run and saw the
// gateway's record say it succeeded. Every field of the row can also be written by a bot,
// through the `message` tool's copy of what it sends into the conversation, so this device's own
// knowledge of the run is what makes the line true. docs/decisions.md, "The gateway's update
// notice", records why.

import { cleanLine } from "./gateway-names.ts";
import type { ClawtrateState, Transcript, TranscriptItem } from "./types.ts";

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** An update run id as the gateway writes one: a UUID, or `ocm:` and a job id. */
export const UPDATE_RUN_ID =
  /^(ocm:[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
/** How the notice's idempotency key begins; the update run's id follows it. */
export const UPDATE_NOTICE_KEY_PREFIX = "update-run-finished:";
/** The longest part of the gateway's sentence the line's disclosure shows. */
export const MAX_UPDATE_NOTICE_CHARS = 400;

/** The idempotency key a history row was stored under: under `__openclaw`, or else on the row. */
export function rowIdempotencyKey(row: unknown): string | null {
  const message = record(row);
  const key = record(message?.__openclaw)?.idempotencyKey ?? message?.idempotencyKey;
  return typeof key === "string" ? key : null;
}

/**
 * The update run a `chat.history` row says it is the finished notice of, or null. Only fields
 * the gateway sets are read, never the text: an assistant row with `api: "openclaw-transcript"`,
 * `provider: "openclaw"`, `model: "delivery-mirror"` (what `appendAssistantMessageToSessionTranscript`
 * gives every row it writes, OpenClaw 2026.10.6), none of a model reply's `__openclaw.runId`,
 * `responseId` or `openclawDelivery`, and the key `update-run-finished:<run id>`. A bot can still
 * write such a row, so a run id here says nothing until this device's own record of the run
 * matches it (`updateNoticeLine`).
 */
export function updateNoticeRunId(row: unknown): string | null {
  const message = record(row);
  if (
    message?.role !== "assistant" ||
    message.api !== "openclaw-transcript" ||
    message.provider !== "openclaw" ||
    message.model !== "delivery-mirror" ||
    record(message.__openclaw)?.runId !== undefined ||
    message.responseId !== undefined ||
    message.openclawDelivery !== undefined
  )
    return null;
  const key = rowIdempotencyKey(message);
  if (!key?.startsWith(UPDATE_NOTICE_KEY_PREFIX)) return null;
  const runId = key.slice(UPDATE_NOTICE_KEY_PREFIX.length);
  return UPDATE_RUN_ID.test(runId) ? runId : null;
}

/**
 * An update this device's own press started, followed until the gateway's record said it
 * succeeded and the same gateway, reconnected, reported the new version (`OpenClawUpdates`,
 * outcome "updated", `mine`).
 */
export type UpdatedRun = {
  /** The gateway's identity. */
  gatewayId: string;
  runId: string;
  /** The version it went to, as this device's record of the run has it. */
  to: string;
  /** When this device saw it, on this device's clock: only its age is read. */
  at: number;
};

/** The updates kept, the latest last. */
export const MAX_UPDATED_RUNS = 16;
/** How long one is kept. Past it, the gateway's notice shows as the message it is. */
export const UPDATED_RUN_MAX_AGE_MS = 365 * 24 * 60 * 60_000;

/** What the conversation draws for an update notice this device can vouch for. */
export type UpdateNoticeLine = {
  version: string;
  /** The gateway's own sentence: one line, cleaned, at most `MAX_UPDATE_NOTICE_CHARS`. */
  text: string;
};

/** An item's text blocks, joined: the gateway's words, as it wrote them. */
export const updateNoticeText = (item: TranscriptItem) =>
  item.blocks.map((block) => (block.kind === "text" ? block.text : "")).join("\n");

/**
 * The main bot's main conversation, where the gateway writes its notice: the task of the default
 * bot that is its main session (`isMain`). Null while none is listed.
 */
export function mainConversationKey(
  state: Pick<ClawtrateState, "bots" | "tasksByBot">,
): string | null {
  const main = state.bots.find((bot) => bot.isDefault);
  return (main && state.tasksByBot[main.id]?.find((task) => task.isMain === true)?.key) ?? null;
}

/** What decides whether a notice is drawn as the line, from the state once per render. */
export type UpdateNoticeScope = {
  /** The updates this device's own press started and saw succeed. */
  updated: readonly UpdatedRun[] | undefined;
  /** The gateway connected now. */
  gatewayId: string | null;
  /** The only conversation the line is drawn in (`mainConversationKey`). */
  mainKey: string | null;
};

export function updateNoticeScope(
  state: Pick<ClawtrateState, "bots" | "tasksByBot" | "connection" | "openclawUpdating">,
): UpdateNoticeScope {
  return {
    updated: state.openclawUpdating?.updated,
    gatewayId: state.connection.gatewayId,
    mainKey: mainConversationKey(state),
  };
}

/**
 * The line an item of conversation `taskKey` is drawn as, or null for every other item: it is
 * the first row of its conversation with the notice's key and fields (`TranscriptItem.updateRunId`),
 * the conversation is the main bot's main one on the gateway connected now, where the gateway
 * writes its notice and keeps a key once, and this device's own press started that run and saw it
 * succeed on that gateway. In any other conversation the same row is a bot's message. The version
 * is this device's, never the row's.
 */
export function updateNoticeLine(
  item: TranscriptItem | undefined,
  taskKey: string,
  scope: UpdateNoticeScope,
): UpdateNoticeLine | null {
  const runId = item?.updateRunId;
  const { updated, gatewayId, mainKey } = scope;
  if (!runId || gatewayId === null || mainKey === null || taskKey !== mainKey) return null;
  const run = updated?.find((each) => each.gatewayId === gatewayId && each.runId === runId);
  if (!run) return null;
  return { version: run.to, text: cleanLine(updateNoticeText(item), MAX_UPDATE_NOTICE_CHARS) };
}

/**
 * After an update of gateway `gatewayId` this app followed to "Updated", the conversation to read
 * again for the gateway's notice: the main bot's main one, while that gateway is the one connected
 * and the conversation is followed (`tracked`). Null otherwise: one not followed is read whole when
 * it is opened.
 */
export function mainToReadAgain(
  state: Pick<ClawtrateState, "bots" | "tasksByBot" | "connection">,
  gatewayId: string,
  tracked: (key: string) => boolean,
): string | null {
  if (state.connection.gatewayId !== gatewayId) return null;
  const key = mainConversationKey(state);
  return key !== null && tracked(key) ? key : null;
}

/** Whether a conversation's loaded history holds a row naming itself the notice of run `runId`. */
export function holdsUpdateNotice(
  transcript: Pick<Transcript, "items"> | undefined,
  runId: string,
): boolean {
  return transcript?.items.some((item) => item.updateRunId === runId) === true;
}

/** The longest list preview the gateway makes (`SESSION_LAST_MESSAGE_PREVIEW_DEFAULT_CHARS`). */
const LIST_PREVIEW_MAX_CHARS = 240;
/**
 * Text whose flattening this does not repeat: links and images (`[`), autolinks (`<`), emphasis
 * and strikethrough (`*`, `_`, `~`), escapes, fenced code, and a heading, quote or list marker at
 * the start of a line.
 */
const UNMIRRORED_MARKDOWN = /[[\]<>*_~\\]|```|^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s/m;
const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/**
 * The `lastMessagePreview` the gateway lists for a row with this text, when it is the task's last
 * message with text (the proof that the listed preview is the notice): OpenClaw 2026.10.6's `projectSessionDisplayMessage(message, {flattenMarkdown:
 * true})`, which trims the text, flattens its Markdown to one line and cuts it to 240 characters
 * with "...". Only plain text and inline code are repeated here; for any other Markdown the answer
 * is null, so the gateway's own preview is shown.
 */
export function gatewayPreviewOf(text: string): string | null {
  if (UNMIRRORED_MARKDOWN.test(text)) return null;
  const code = text.trim().replace(/`([^`]*)`/g, "$1");
  if (UNMIRRORED_MARKDOWN.test(code)) return null;
  const flat = code.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  if (flat.length <= LIST_PREVIEW_MAX_CHARS) return flat;
  let end = LIST_PREVIEW_MAX_CHARS - 3;
  if (isHighSurrogate(flat.charCodeAt(end - 1)) && isLowSurrogate(flat.charCodeAt(end))) end -= 1;
  return `${flat.slice(0, end)}...`;
}
