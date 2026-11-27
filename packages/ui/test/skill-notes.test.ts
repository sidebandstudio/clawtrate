// F-560: the gateway's skill note in the rail: not the bot's preview, and not a reason for a
// read-only viewer's unread mark; on a connection that writes, unread is the gateway's. The rows
// are the shape development gateways returned (packages/core/test/skill-notes.test.ts). The
// mounted conversation is checked in visual/skill-notes.visual.spec.ts.

import {
  emptyActivity,
  mapHistory,
  tasksWithoutSkillNotes,
  tasksWithoutUpdateNotices,
  type Task,
  type Transcript,
} from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { summarize, unreadSeenOf } from "../src/selection.ts";

const KEY = "agent:pip:trail";
/** The gateway's clock: rows and the list are its times. */
const T = 1_790_000_000_000;
const REVIEW = "0357efcc-6ce0-4f3f-9f39-c9cd6905189a";
const NOTE_KEY = `skill-workshop-notice:skill-workshop-review:${REVIEW}`;
const TEXT =
  '💾 Learned: created `trail-check` (check the trail before a hike). Say "undo" to revert this skill change.';
const LISTED =
  '💾 Learned: created trail-check (check the trail before a hike). Say "undo" to revert this skill change.';
const note = (text = TEXT, at = T + 40_000) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openclaw-transcript",
  provider: "openclaw",
  model: "delivery-mirror",
  stopReason: "stop",
  timestamp: at,
  idempotencyKey: NOTE_KEY,
  __openclaw: { id: "n1", idempotencyKey: NOTE_KEY, seq: 3 },
});
/** The note as OpenClaw 2026.11.10 writes it, with the skill workshop's mark. */
const markedNote = (at = T + 40_000) => ({
  ...note(TEXT, at),
  openclawDeliveryMirror: {
    kind: "plugin-notice",
    pluginId: "skill-workshop",
    type: "skills-changed",
    data: {
      agentId: "pip",
      runId: `skill-workshop-review:${REVIEW}`,
      skills: [
        { name: "trail-check", action: "created", summary: "check the trail before a hike" },
      ],
    },
  },
});
const replyRow = (text: string, at: number) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-completions",
  provider: "scripted",
  model: "dev-1",
  timestamp: at,
  __openclaw: { id: "a1", runId: "r1" },
});
const history = (rows: unknown[]): Transcript => ({
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
  loadedAt: 3_200,
});
const listed: Task = {
  key: KEY,
  botId: "pip",
  sessionId: "s1",
  title: "Trail",
  preview: LISTED,
  updatedAt: T + 40_100,
  status: "done",
  unread: true,
};
/** No update this device followed. */
const NO_UPDATES = { updated: [], gatewayId: "gw-a", mainKey: KEY };
/** An update this device followed, whose notice the gateway wrote into this task (F-590). */
const RUN = "3f2b8c1d-4e5a-4b6c-8d7e-9f0a1b2c3d4e";
const UPDATED = {
  updated: [{ gatewayId: "gw-a", runId: RUN, to: "2026.11.10", at: 1, succeededAt: T + 50_000 }],
  gatewayId: "gw-a",
  mainKey: KEY,
};
const UPDATE_TEXT = "✅ OpenClaw updated.";
const updateNotice = (at: number) => ({
  role: "assistant",
  content: [{ type: "text", text: UPDATE_TEXT }],
  api: "openclaw-transcript",
  provider: "openclaw",
  model: "delivery-mirror",
  stopReason: "stop",
  timestamp: at,
  idempotencyKey: `update-run-finished:${RUN}`,
  __openclaw: { id: "u1", idempotencyKey: `update-run-finished:${RUN}` },
});
const stateWith = (transcript: Transcript) =>
  ({
    bots: [],
    tasksByBot: { pip: [listed] },
    transcripts: { [KEY]: transcript },
    connection: { gatewayId: "gw-a" },
    openclawUpdating: null,
  }) as unknown as Parameters<typeof unreadSeenOf>[2];

describe("F-560: the skill note in the rail", () => {
  it("the bot's preview is its words before the note", () => {
    const transcript = history([replyRow("The trail is open.", T + 2_000), note()]);
    const quiet = tasksWithoutSkillNotes({ pip: [listed] }, { [KEY]: transcript }, NO_UPDATES);
    expect(summarize(quiet.pip!, {}, null).latest?.preview).toBe("The trail is open.");
  });

  it("a row with the note's fields and other words is the bot's preview, as any message", () => {
    const words = "The Saturday hike moved to Sunday at 9.";
    const transcript = history([replyRow("The trail is open.", T + 2_000), note(words)]);
    const shown = tasksWithoutSkillNotes(
      { pip: [{ ...listed, preview: words }] },
      { [KEY]: transcript },
      NO_UPDATES,
    );
    expect(summarize(shown.pip!, {}, null).latest?.preview).toBe(words);
  });

  it("with an update line and a skill note both after the reply, in either order, the preview is the reply", () => {
    const shown = (rows: unknown[], preview: string) => {
      const transcript = history(rows);
      const quiet = tasksWithoutSkillNotes(
        tasksWithoutUpdateNotices(
          { pip: [{ ...listed, preview }] },
          { [KEY]: transcript },
          UPDATED,
        ),
        { [KEY]: transcript },
        UPDATED,
      );
      return summarize(quiet.pip!, {}, null).latest?.preview;
    };
    const reply = replyRow("The trail is open.", T + 2_000);
    expect(shown([reply, updateNotice(T + 50_100), note(TEXT, T + 60_000)], LISTED)).toBe(
      "The trail is open.",
    );
    expect(shown([reply, note(TEXT, T + 40_000), updateNotice(T + 50_100)], UPDATE_TEXT)).toBe(
      "The trail is open.",
    );
  });

  it("on a read-only connection, a run of an update line and a skill note after the read, in either order, doesn't make the task unread", () => {
    const main = { ...listed, isMain: true };
    const state = (rows: unknown[], preview: string) =>
      ({
        bots: [
          {
            id: "pip",
            name: "Pip",
            emoji: null,
            avatarUrl: null,
            theme: null,
            model: null,
            isDefault: true,
          },
        ],
        tasksByBot: { pip: [{ ...main, preview, updatedAt: T + 70_000 }] },
        transcripts: { [KEY]: history(rows) },
        connection: { gatewayId: "gw-a" },
        openclawUpdating: { updated: UPDATED.updated },
      }) as unknown as Parameters<typeof unreadSeenOf>[2];
    const reply = replyRow("The trail is open.", T + 2_000);
    const seen = { [KEY]: T + 2_000 };
    expect(
      unreadSeenOf(
        seen,
        false,
        state([reply, updateNotice(T + 50_100), markedNote(T + 60_000)], LISTED),
      ),
    ).toEqual({ [KEY]: T + 70_000 });
    expect(
      unreadSeenOf(
        seen,
        false,
        state([reply, markedNote(T + 40_000), updateNotice(T + 50_100)], UPDATE_TEXT),
      ),
    ).toEqual({ [KEY]: T + 70_000 });
  });

  it("on a read-only connection the viewer's own memory goes past the note; on one that writes, unread is the gateway's", () => {
    const transcript = history([replyRow("The trail is open.", T + 2_000), markedNote()]);
    const seen = { [KEY]: T + 2_050 };
    const readOnly = unreadSeenOf(seen, false, stateWith(transcript));
    // An unmarked note (OpenClaw 2026.10.6), which a bot can imitate, is still to read.
    const unmarked = history([replyRow("The trail is open.", T + 2_000), note()]);
    expect(unreadSeenOf(seen, false, stateWith(unmarked))).toBe(seen);
    expect(readOnly).toEqual({ [KEY]: T + 40_100 });
    expect(summarize([listed], readOnly, null, readOnly).unread).toBe(false);
    // A viewer that read before the reply still has it to read.
    const early = { [KEY]: T + 1_000 };
    expect(unreadSeenOf(early, false, stateWith(transcript))).toBe(early);
    // A connection that writes reads none of it.
    expect(unreadSeenOf(seen, true, stateWith(transcript))).toEqual({});
  });
});
