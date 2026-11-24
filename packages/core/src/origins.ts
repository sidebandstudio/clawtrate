// Which sessions another tool opened with a bot, not the person: an API client
// calling the gateway's HTTP API, a scheduled run, a plugin, a voice session or
// the gateway's own housekeeping. They stay out of a bot's task list unless
// "Show sessions from other tools" is on, as channel chats do (`channels.ts`).
// Told apart only by what OpenClaw 2026.10.6 records on the session row, never
// by a title: docs/research/session-origins.md.

import { isMainSession } from "./channels.ts";
import { sessionRowKey, type RawRecord } from "./mapping.ts";

/**
 * `createdVia` values the gateway records for a session another tool opened: an agent run asked
 * for by an API or the CLI (`run`), a scheduled job (`cron`), a plugin, a voice session (`talk`),
 * the gateway's own work (`internal`). `operator` is a person through an operator client, such as
 * Clawtrate; `spawn` is a bot's own work; `channel` is the channel rule's.
 */
const OTHER_TOOL_VIA = new Set(["run", "cron", "plugin", "talk", "internal"]);
/**
 * The gateway's route classes for other surfaces (`sessionClassificationForRow`), read only when a
 * row records no `createdVia`: older rows, and those the HTTP API makes.
 */
const OTHER_TOOL_CLASS = new Set([
  "acp",
  "cron",
  "dreaming",
  "explicit",
  "harness",
  "heartbeat",
  "hook",
  "node",
  "system",
  "tui",
  "voice",
]);
/** Keys the gateway's HTTP APIs make (`resolveGatewayRequestContext`, prefixes `openai` and `openresponses`). */
const HTTP_API_KEY = /^agent:[^:]+:(?:openai|openresponses)(?:-user)?:/i;

/**
 * Whether another tool opened this session, from the row alone: its recorded
 * `createdVia`, else the gateway's `classification` of its route, else a key
 * of the gateway's HTTP APIs. A bot's main session never is, nor one the
 * person, the bot or a channel made; a row with none of these facts is not
 * placed, and so is listed.
 */
export function isOtherToolSession(row: RawRecord): boolean {
  if (isMainSession(row)) return false;
  const via = row.createdVia;
  if (typeof via === "string") return OTHER_TOOL_VIA.has(via);
  if (typeof row.classification === "string" && OTHER_TOOL_CLASS.has(row.classification))
    return true;
  const key = sessionRowKey(row);
  return key !== null && HTTP_API_KEY.test(key);
}
