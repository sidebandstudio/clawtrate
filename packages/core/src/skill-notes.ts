// The gateway's note that a background skill review saved or changed a skill ("💾 Learned: created
// `…` (…). Say "undo" to revert this skill change."). The bot did not say it, so the conversation
// folds it into the line of the run it follows ("Saved a skill: …") instead of drawing it as the
// bot's message. A bot's own message sent with its message tool can carry every field the note has
// on OpenClaw 2026.10.6, so a row is taken for the note only when its text also has the note's exact
// form, and the folded line always shows the note's own words. docs/decisions.md, "The gateway's
// skill notes", records what is left.

import { rowIdempotencyKey } from "./update-notice.ts";
import type { TranscriptItem } from "./types.ts";

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** The review's run id as the gateway makes it: this prefix and a lowercase UUID. */
export const SKILL_REVIEW_RUN_PREFIX = "skill-workshop-review:";
/** How the note's idempotency key begins; the review's run id follows it. */
export const SKILL_NOTE_KEY_PREFIX = `skill-workshop-notice:${SKILL_REVIEW_RUN_PREFIX}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A learned skill's name, as the skill workshop accepts one (OpenClaw 2026.10.6 and 2026.11.10). */
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** The verbs the note uses, one per kind of change (`ACTION_VERB`, both versions). */
export const SKILL_NOTE_ACTIONS = ["created", "updated", "archived", "restored"] as const;
export type SkillNoteAction = (typeof SKILL_NOTE_ACTIONS)[number];
/** The most skills one note is folded with; a longer note shows as the message it is. */
export const MAX_SKILL_NOTE_SKILLS = 16;
/** The longest note text folded; a longer one shows as the message it is. */
export const MAX_SKILL_NOTE_CHARS = 4_000;
/** A bot's id, as the mark may name one: what the gateway's undo takes. */
const AGENT_ID = /^[\w.-]{1,128}$/;

/** One change a note names: the skill and what was done. Its reason stays in the note's text. */
export type SkillNoteSkill = { name: string; action: SkillNoteAction };
/** One change as the note writes it, with the review's reason when it gives one. */
export type SkillNoteChange = SkillNoteSkill & { summary?: string };

/** What a history item that is the gateway's skill note carries (`TranscriptItem.skillNote`). */
export type SkillNote = {
  /** The review's id: the UUID its run id and the note's key end with. */
  reviewId: string;
  /** The skills the note names, in its order. */
  skills: SkillNoteSkill[];
  /**
   * The bot whose skills changed, as OpenClaw 2026.11.10's mark on the note names it: what the
   * gateway's own undo (`skills.workshop.undo`) takes. Null for a note without the mark
   * (2026.10.6), whose undo is the bot's, asked for in the task.
   */
  agentId: string | null;
  /**
   * In history, the latest time of any row stored before the note, every row of a merged turn
   * included: what a read-only viewer must have read through. Absent when an earlier row had none.
   */
  after?: number;
};

/** The note's text for these skills, as both versions write it (`formatWorkshopChangeNotice`). */
export function skillNoteText(skills: readonly SkillNoteChange[]): string {
  const changes = skills.map(
    ({ action, name, summary }) => `${action} \`${name}\`${summary ? ` (${summary})` : ""}`,
  );
  return `💾 Learned: ${changes.join("; ")}. Say "undo" to revert this skill change.`;
}

const NOTE_TEXT = /^💾 Learned: (.+)\. Say "undo" to revert this skill change\.$/s;
const CHANGE = /^(created|updated|archived|restored) `([a-z0-9][a-z0-9-]{0,62})`(?: \((.+)\))?$/s;
const CHANGE_START =
  /; (?=(?:created|updated|archived|restored) `[a-z0-9][a-z0-9-]{0,62}`(?: \(|; |$))/;

/**
 * The skills a note's text names, when the text has the note's exact form: the gateway's sentence
 * around changes of one of its verbs, each a skill name in code marks and perhaps a reason in
 * parentheses, joined by "; ". Null for anything else, even one character off: written again from
 * what was read, it must be the same text. A reason that itself reads as "; updated `name`" splits
 * there; the text is the same either way, and the folded line's full text is the note's own.
 */
export function skillNoteChanges(text: string): SkillNoteChange[] | null {
  if (text.length > MAX_SKILL_NOTE_CHARS) return null;
  const body = NOTE_TEXT.exec(text)?.[1];
  if (body === undefined) return null;
  const skills: SkillNoteChange[] = [];
  for (const part of body.split(CHANGE_START)) {
    const match = CHANGE.exec(part);
    if (!match || skills.length >= MAX_SKILL_NOTE_SKILLS) return null;
    const summary = match[3];
    skills.push({
      action: match[1] as SkillNoteAction,
      name: match[2]!,
      ...(summary !== undefined ? { summary } : {}),
    });
  }
  return skillNoteText(skills) === text ? skills : null;
}

/** OpenClaw 2026.11.10's mark on the note's row: its skills and bot, when the mark is whole. */
function markedSkills(
  mark: Record<string, unknown>,
  reviewId: string,
): { agentId: string; skills: SkillNoteChange[] } | null {
  const data = record(mark.data);
  if (
    mark.kind !== "plugin-notice" ||
    mark.pluginId !== "skill-workshop" ||
    mark.type !== "skills-changed" ||
    !data ||
    data.runId !== `${SKILL_REVIEW_RUN_PREFIX}${reviewId}` ||
    typeof data.agentId !== "string" ||
    !AGENT_ID.test(data.agentId) ||
    !Array.isArray(data.skills) ||
    data.skills.length === 0 ||
    data.skills.length > MAX_SKILL_NOTE_SKILLS
  )
    return null;
  const skills: SkillNoteChange[] = [];
  for (const each of data.skills) {
    const skill = record(each);
    const action = SKILL_NOTE_ACTIONS.find((verb) => verb === skill?.action);
    if (!skill || !action || typeof skill.name !== "string" || !SKILL_NAME.test(skill.name))
      return null;
    if (skill.summary !== undefined && (typeof skill.summary !== "string" || !skill.summary))
      return null;
    skills.push({
      name: skill.name,
      action,
      ...(typeof skill.summary === "string" ? { summary: skill.summary } : {}),
    });
  }
  return { agentId: data.agentId, skills };
}

/**
 * The skill note a `chat.history` row is, or null. Every one of these holds:
 * - the fields the gateway gives a row it writes into a transcript itself: an assistant row with
 *   `api: "openclaw-transcript"`, `provider: "openclaw"`, `model: "delivery-mirror"`, and none of
 *   a run's `__openclaw.runId` or `openclawAbort`, or a model reply's `responseId` or
 *   `openclawDelivery`;
 * - the key `skill-workshop-notice:skill-workshop-review:<lowercase uuid>`;
 * - one text block with the note's exact form (`skillNoteChanges`);
 * - on a gateway that marks its notes (`marked`: OpenClaw 2026.11.10 or newer), the mark
 *   (`openclawDeliveryMirror`: a `plugin-notice` of `skill-workshop`, `skills-changed`, naming the
 *   same review), whose skills written as the note are its text. Only the gateway's own plugin
 *   can write that mark. Without `marked`, a row with no mark at all.
 */
export function skillNoteOf(row: unknown, marked: boolean): SkillNote | null {
  const message = record(row);
  const meta = record(message?.__openclaw);
  if (
    message?.role !== "assistant" ||
    message.api !== "openclaw-transcript" ||
    message.provider !== "openclaw" ||
    message.model !== "delivery-mirror" ||
    meta?.runId !== undefined ||
    message.openclawAbort !== undefined ||
    message.responseId !== undefined ||
    message.openclawDelivery !== undefined
  )
    return null;
  const key = rowIdempotencyKey(message);
  if (!key?.startsWith(SKILL_NOTE_KEY_PREFIX)) return null;
  const reviewId = key.slice(SKILL_NOTE_KEY_PREFIX.length);
  if (!UUID.test(reviewId)) return null;
  const content = message.content;
  const block = Array.isArray(content) && content.length === 1 ? record(content[0]) : null;
  const text = typeof content === "string" ? content : block?.type === "text" ? block.text : null;
  if (typeof text !== "string") return null;
  const changes = skillNoteChanges(text);
  if (!changes) return null;
  const skills = (list: SkillNoteChange[]) => list.map(({ name, action }) => ({ name, action }));
  const mark = message.openclawDeliveryMirror;
  if (mark === undefined)
    return marked ? null : { reviewId, skills: skills(changes), agentId: null };
  const markRecord = record(mark);
  const fromMark = markRecord ? markedSkills(markRecord, reviewId) : null;
  if (!fromMark || skillNoteText(fromMark.skills) !== text) return null;
  return { reviewId, skills: skills(fromMark.skills), agentId: fromMark.agentId };
}

/**
 * What the run line says for its folded notes, in the notes' own words: "Saved a skill: <name>"
 * for a skill a note created, "Changed a skill: <name>" for one it updated, archived or restored,
 * and the plural with every name when there are more.
 */
export function skillNoteWords(notes: readonly Pick<SkillNote, "skills">[]): string {
  const saved: string[] = [];
  const changed: string[] = [];
  for (const { skills } of notes)
    for (const skill of skills) (skill.action === "created" ? saved : changed).push(skill.name);
  const phrase = (verb: string, names: string[]) =>
    names.length === 1
      ? `${verb} a skill: ${names[0]}`
      : `${verb} ${names.length} skills: ${names.join(", ")}`;
  return [
    ...(saved.length ? [phrase("Saved", saved)] : []),
    ...(changed.length ? [phrase("Changed", changed)] : []),
  ].join(" · ");
}

/** Whether an item is drawn as a folded skill note rather than as a message. */
export const isSkillNote = (item: TranscriptItem | undefined): boolean =>
  item?.skillNote !== undefined;

/** The last item that is not a skill note: what "Jump to latest" goes by. */
export function lastSaidItem(items: readonly TranscriptItem[]): TranscriptItem | undefined {
  return items.findLast((item) => !isSkillNote(item));
}
