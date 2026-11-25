// The gateway's notice that an update of OpenClaw finished ("✅ OpenClaw updated. For details,
// …"). The gateway writes it into the main bot's main conversation after the restart, as an
// assistant row; the bot did not say it. It shows as a quiet line of Clawtrate's own words,
// "OpenClaw updated to <version>", only when this device followed that run and saw the
// gateway's record say it succeeded. Every field of the row can also be written by a bot,
// through the `message` tool's copy of what it sends into the conversation, so this device's own
// knowledge of the run is what makes the line true. docs/decisions.md, "The gateway's update
// notice", records why.

import { cleanLine } from "./gateway-names.ts";
import type { TranscriptItem } from "./types.ts";

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
 * An update this device followed until the gateway's record said it succeeded and the same
 * gateway, reconnected, reported the new version (`OpenClawUpdates`, outcome "updated").
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
 * The line an item is drawn as, or null for every other item: it is the first row of its
 * conversation with the notice's key and fields (`TranscriptItem.updateRunId`), the conversation
 * is on the gateway connected now (`gatewayId`), and this device saw that run on that gateway
 * succeed (`updated`). The version is this device's, never the row's.
 */
export function updateNoticeLine(
  item: TranscriptItem | undefined,
  updated: readonly UpdatedRun[] | undefined,
  gatewayId: string | null,
): UpdateNoticeLine | null {
  const runId = item?.updateRunId;
  if (!runId || gatewayId === null) return null;
  const run = updated?.find((each) => each.gatewayId === gatewayId && each.runId === runId);
  if (!run) return null;
  return { version: run.to, text: cleanLine(updateNoticeText(item), MAX_UPDATE_NOTICE_CHARS) };
}
