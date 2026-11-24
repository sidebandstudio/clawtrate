// The gateway's note that a background skill review saved or changed a skill
// ("Learned: created `…`. Say "undo" to revert this skill change."). It is
// machinery, not something the bot said: with commands hidden it stays out of
// the conversation and the sidebar's preview (`mapHistory` tags its item,
// `taskWithoutSkillNotes` keeps it out of the rail).
// docs/decisions.md, "The gateway's skill notes", records what marks it.

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * How the gateway's idempotency key for the note begins (OpenClaw 2026.10.6,
 * `postWorkshopChangeNotice`); the review's run id follows it.
 */
export const SKILL_NOTE_KEY_PREFIX = "skill-workshop-notice:";

/**
 * The whole key, as the gateway makes it: the prefix, then the review's run id,
 * `skill-workshop-review:` and a `randomUUID()` (`runSkillExperienceReviewInner`).
 */
const SKILL_NOTE_KEY =
  /^skill-workshop-notice:skill-workshop-review:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Whether a `chat.history` row (or the message of a `session.message` event)
 * is the gateway's skill-change note. Both must hold:
 * - its idempotency key, under `__openclaw` or else on the row, is exactly the
 *   gateway's shape (`SKILL_NOTE_KEY`), so a key a client chose, or one the
 *   gateway derives from it such as an aborted reply's `<key>:assistant`, is not;
 * - it is a row the gateway wrote into the transcript itself: the fields
 *   `appendAssistantMessageToSessionTranscript` gives every such row, for the
 *   note written directly and for the one mirrored from a channel. A model's
 *   reply, or a reply the gateway kept after an abort (`gateway-injected`), has
 *   others.
 *
 * Its wording is never read.
 */
export function isSkillChangeNote(row: unknown): boolean {
  const message = record(row);
  if (
    message?.role !== "assistant" ||
    message.api !== "openclaw-transcript" ||
    message.provider !== "openclaw" ||
    message.model !== "delivery-mirror"
  )
    return false;
  const key = record(message.__openclaw)?.idempotencyKey ?? message.idempotencyKey;
  return typeof key === "string" && SKILL_NOTE_KEY.test(key);
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
 * The `lastMessagePreview` the gateway lists for a note with this text, when it is the task's last
 * message with text: OpenClaw 2026.10.6's `projectSessionDisplayMessage(message, {flattenMarkdown:
 * true})`, which trims the text, flattens its Markdown to one line and cuts it to 240 characters
 * with "...". Only plain text and inline code are repeated here; for any other Markdown the answer
 * is null, so the gateway's own preview is shown.
 */
export function gatewayPreviewOfNote(text: string): string | null {
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
