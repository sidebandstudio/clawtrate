// The gateway's skill-change note on each surface, with "Show commands" off and
// on: the conversation, the bot's preview in the rail, and the unread mark, which
// stays the gateway's. "Jump to latest" is checked in the mounted conversation
// (visual/skill-notes.visual.spec.ts). Every name and text is invented.

import {
  emptyActivity,
  mapHistory,
  SKILL_NOTE_KEY_PREFIX,
  tasksWithoutSkillNotes,
  type Task,
  type Transcript,
} from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { conversationItems } from "../src/Conversation.tsx";
import { summarize } from "../src/selection.ts";
import { isUnread, markSeen, unreadCount } from "../src/unread.ts";

const KEY = "agent:pip:trail";
const NOTE_TEXT = "Learned: created `trail-check`. Say undo to revert.";
const user = (id: string, text: string, at: number) => ({
  role: "user",
  content: text,
  timestamp: at,
  __openclaw: { id },
});
const reply = (id: string, text: string, at: number, runId = "r1") => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-completions",
  provider: "scripted",
  model: "dev-1",
  timestamp: at,
  __openclaw: { id, runId },
});
/** The note as OpenClaw 2026.10.6 writes it. */
const note = (id: string, at: number) => ({
  role: "assistant",
  content: [{ type: "text", text: NOTE_TEXT }],
  api: "openclaw-transcript",
  provider: "openclaw",
  model: "delivery-mirror",
  timestamp: at,
  __openclaw: {
    id,
    idempotencyKey: `${SKILL_NOTE_KEY_PREFIX}skill-workshop-review:0b6c1f2e-4d5a-4b7c-9e1f-2a3b4c5d6e7f`,
  },
});
const history = (rows: unknown[], loadedAt = 3_200): Transcript => ({
  ...emptyActivity,
  linkedRuns: {},
  interSession: [],
  mcpTools: {},
  sessionKey: KEY,
  status: "ready",
  items: mapHistory(rows),
  error: null,
  hasMore: false,
  live: null,
  loadedAt,
});
const transcript = history([
  user("u1", "Check the trail", 1_000),
  reply("a1", "The trail is open.", 2_000),
  note("n1", 3_000),
]);
/** The row as the gateway lists it once the note is in: its preview, a later time. */
const listed: Task = {
  key: KEY,
  botId: "pip",
  sessionId: "s1",
  title: "Trail",
  preview: "Learned: created trail-check. Say undo to revert.",
  updatedAt: 3_100,
  status: "done",
  unread: true,
};
const byBot = { pip: [listed] };
const texts = (items: Transcript["items"]) =>
  items.map((item) => item.blocks.map((block) => (block.kind === "text" ? block.text : "")).join());
describe("F-560: a skill note is shown only with commands shown", () => {
  it("the conversation leaves the note out by default and shows it in place with commands on", () => {
    expect(texts(conversationItems(transcript, false))).toEqual([
      "Check the trail",
      "The trail is open.",
    ]);
    expect(texts(conversationItems(transcript, true))).toEqual([
      "Check the trail",
      "The trail is open.",
      NOTE_TEXT,
    ]);
  });

  it("the bot's preview in the rail is the bot's reply by default, the note with commands on", () => {
    const quiet = summarize(tasksWithoutSkillNotes(byBot, { [KEY]: transcript }).pip!, {}, null);
    expect(quiet.latest?.preview).toBe("The trail is open.");
    expect(summarize(byBot.pip, {}, null).latest?.preview).toBe(listed.preview);
  });
});

describe("F-560: the unread mark is the gateway's, with or without the note hidden", () => {
  it("a newer reply on the list keeps its preview, and the unread mark and order are unchanged", () => {
    const newer: Task = { ...listed, preview: "Here is the new route.", updatedAt: 5_000 };
    const shown = tasksWithoutSkillNotes({ pip: [newer] }, { [KEY]: transcript });
    expect(shown.pip![0]).toBe(newer);
  });

  it("a read-only viewer who saw only the first row of a merged reply keeps the unread mark", () => {
    const merged = history([
      user("u1", "Check the trail", 1_000),
      reply("a1", "Looking now.", 2_000),
      reply("a2", "The trail is open.", 2_500),
      note("n1", 3_000),
    ]);
    const task: Task = { ...listed, updatedAt: 2_600 };
    // Seen as of the first row only.
    const seen = markSeen({}, { ...task, updatedAt: 2_050 });
    const quiet = tasksWithoutSkillNotes({ pip: [task] }, { [KEY]: merged });
    expect(quiet.pip![0]!.preview).toBe("The trail is open.");
    expect(isUnread(quiet.pip![0]!, seen)).toBe(true);
    expect(unreadCount(quiet, seen, null)).toBe(unreadCount({ pip: [task] }, seen, null));
    expect(summarize(quiet.pip!, seen, null, seen).unread).toBe(true);
  });

  it("loading and unloading history leave the latest task and the unread count as they were", () => {
    const other: Task = {
      ...listed,
      key: "agent:pip:other",
      preview: "Done.",
      updatedAt: 3_050,
      unread: false,
    };
    const lists = { pip: [listed, other] };
    const loaded = tasksWithoutSkillNotes(lists, { [KEY]: transcript });
    const unloaded = tasksWithoutSkillNotes(lists, {});
    expect(summarize(loaded.pip!, {}, null).latest?.key).toBe(KEY);
    expect(summarize(unloaded.pip!, {}, null).latest?.key).toBe(KEY);
    expect(unreadCount(loaded, {}, null)).toBe(unreadCount(unloaded, {}, null));
  });
});
