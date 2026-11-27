// F-560: the gateway's skill note in the rail: not a reason for a read-only viewer's unread mark; on a connection that writes, unread is the gateway's. The rows
// are the shape development gateways returned (packages/core/test/skill-notes.test.ts). The
// mounted conversation is checked in visual/skill-notes.visual.spec.ts.

import { emptyActivity, mapHistory, type Task, type Transcript } from "@clawtrate/core";
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
const stateWith = (transcript: Transcript) =>
  ({
    bots: [],
    tasksByBot: { pip: [listed] },
    transcripts: { [KEY]: transcript },
    connection: { gatewayId: "gw-a" },
    openclawUpdating: null,
  }) as unknown as Parameters<typeof unreadSeenOf>[2];

describe("F-560: the skill note in the rail", () => {
  it("on a read-only connection the viewer's own memory goes past the note; on one that writes, unread is the gateway's", () => {
    const transcript = history([replyRow("The trail is open.", T + 2_000), note()]);
    const seen = { [KEY]: T + 2_050 };
    const readOnly = unreadSeenOf(seen, false, stateWith(transcript));
    expect(readOnly).toEqual({ [KEY]: T + 40_100 });
    expect(summarize([listed], readOnly, null, readOnly).unread).toBe(false);
    // A viewer that read before the reply still has it to read.
    const early = { [KEY]: T + 1_000 };
    expect(unreadSeenOf(early, false, stateWith(transcript))).toBe(early);
    // A connection that writes reads none of it.
    expect(unreadSeenOf(seen, true, stateWith(transcript))).toEqual({});
  });
});
