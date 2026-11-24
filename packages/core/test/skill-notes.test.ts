// The gateway's skill-change note: recognized by its idempotency key on a row
// the gateway wrote itself, kept out of the default conversation and the rail's
// preview. Every name and text is invented.

import { describe, expect, it } from "vitest";
import {
  emptyActivity,
  gatewayPreviewOfNote,
  isSkillChangeNote,
  mapHistory,
  SKILL_NOTE_KEY_PREFIX,
  taskWithoutSkillNotes,
  tasksWithoutSkillNotes,
  type Task,
  type Transcript,
} from "../src/index.ts";

const RUN = "skill-workshop-review:0b6c1f2e-4d5a-4b7c-9e1f-2a3b4c5d6e7f";
const KEY = `${SKILL_NOTE_KEY_PREFIX}${RUN}`;
const NOTE_TEXT = "Learned: created `trail-check` (check the trail). Say undo to revert.";

/** The note as OpenClaw 2026.10.6 writes it into `chat.history` (`appendAssistantMessageToSessionTranscript`). */
const note = (at = 3_000, key: unknown = KEY) => ({
  role: "assistant",
  content: [{ type: "text", text: NOTE_TEXT }],
  api: "openclaw-transcript",
  provider: "openclaw",
  model: "delivery-mirror",
  stopReason: "stop",
  timestamp: at,
  idempotencyKey: key,
  __openclaw: { id: `note-${at}`, idempotencyKey: key, seq: 9 },
});
const user = (text: string, at: number) => ({
  role: "user",
  content: text,
  timestamp: at,
  __openclaw: { id: `u-${at}` },
});
const reply = (text: string, at: number, runId: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-completions",
  provider: "scripted",
  model: "dev-1",
  timestamp: at,
  __openclaw: { id: `a-${at}`, runId },
});
/**
 * A reply the gateway kept after `chat.abort` (`persistAbortedPartial`): its key is the
 * caller's `chat.send` key and `:assistant`, and the row is `gateway-injected`.
 */
const aborted = (text: string, sendKey: string, at = 4_000) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-responses",
  provider: "openclaw",
  model: "gateway-injected",
  stopReason: "stop",
  timestamp: at,
  idempotencyKey: `${sendKey}:assistant`,
  openclawAbort: { aborted: true, origin: "rpc", runId: sendKey },
  __openclaw: { id: `ab-${at}`, idempotencyKey: `${sendKey}:assistant` },
});

describe("F-560: the gateway's skill note is recognized by its key, on a row the gateway wrote", () => {
  it("is a note with the gateway's exact key, under __openclaw or on the row, on the gateway's own row", () => {
    expect(isSkillChangeNote(note())).toBe(true);
    const { __openclaw: _meta, ...topOnly } = note();
    expect(isSkillChangeNote(topOnly)).toBe(true);
    const { idempotencyKey: _key, ...metaOnly } = note();
    expect(isSkillChangeNote(metaOnly)).toBe(true);
  });

  it("a reply kept after an abort, sent with a key that looks like the gateway's, is not a note", () => {
    // The caller chose the key: the gateway keeps the aborted reply as `<key>:assistant`.
    expect(isSkillChangeNote(aborted("Half of my answer", KEY))).toBe(false);
    // Even if a key of exactly the gateway's shape reached such a row, the row is not the gateway's note.
    expect(
      isSkillChangeNote({ ...aborted("Half", KEY), idempotencyKey: KEY, __openclaw: {} }),
    ).toBe(false);
    const items = mapHistory([user("Go on", 1_000), aborted("Half of my answer", KEY, 2_000)]);
    expect(items.map((item) => [item.role, item.skillNote ?? false])).toEqual([
      ["user", false],
      ["assistant", false],
    ]);
  });

  it("the right key on a model's own row is not a note; nor is any row without the gateway's fields", () => {
    expect(isSkillChangeNote({ ...reply(NOTE_TEXT, 1, "r1"), idempotencyKey: KEY })).toBe(false);
    for (const field of ["api", "provider", "model"] as const) {
      expect(isSkillChangeNote({ ...note(), [field]: undefined }), field).toBe(false);
    }
    expect(isSkillChangeNote({ ...note(), model: "gateway-injected" })).toBe(false);
  });

  it("is not a note without the key: words alone never make one", () => {
    const { idempotencyKey: _key, __openclaw: _meta, ...bare } = note();
    expect(isSkillChangeNote(bare)).toBe(false);
    expect(isSkillChangeNote(reply(NOTE_TEXT, 1, "r1"))).toBe(false);
    expect(isSkillChangeNote({ ...note(), idempotencyKey: "run-1", __openclaw: {} })).toBe(false);
  });

  it("is not a note when the key is not exactly the gateway's shape", () => {
    for (const key of [
      SKILL_NOTE_KEY_PREFIX,
      `${SKILL_NOTE_KEY_PREFIX} `,
      `${SKILL_NOTE_KEY_PREFIX}   `,
      `${KEY} `,
      `${KEY}\n`,
      ` ${KEY}`,
      `x${KEY}`,
      `${KEY}:assistant`,
      KEY.toUpperCase(),
      `${SKILL_NOTE_KEY_PREFIX}0b6c1f2e-4d5a-4b7c-9e1f-2a3b4c5d6e7f`,
      `${SKILL_NOTE_KEY_PREFIX}skill-workshop-review:0b6c1f2e`,
      `${SKILL_NOTE_KEY_PREFIX}other-run:0b6c1f2e-4d5a-4b7c-9e1f-2a3b4c5d6e7f`,
      42,
      null,
      { prefix: SKILL_NOTE_KEY_PREFIX },
    ]) {
      expect(isSkillChangeNote(note(1, key)), JSON.stringify(key)).toBe(false);
    }
    // The key under __openclaw decides when both are there.
    expect(isSkillChangeNote({ ...note(), __openclaw: { idempotencyKey: "run-1" } })).toBe(false);
    // Only an assistant row: a user row with the same key is the person's.
    expect(isSkillChangeNote({ ...note(), role: "user" })).toBe(false);
    for (const row of [null, undefined, "note", [note()], 7]) {
      expect(isSkillChangeNote(row)).toBe(false);
    }
  });

  it("mapHistory gives the note an item of its own, marked; an unmarked look-alike stays a reply", () => {
    const items = mapHistory([
      user("Check the trail", 1_000),
      reply("The trail is open.", 2_000, "r1"),
      note(3_000),
      reply("Anything else?", 4_000, "r2"),
      { ...note(5_000), idempotencyKey: undefined, __openclaw: { id: "x" } },
    ]);
    expect(items.map((item) => [item.role, item.skillNote ?? false])).toEqual([
      ["user", false],
      ["assistant", false],
      ["assistant", true],
      ["assistant", false],
      ["assistant", false],
    ]);
    expect(items[2]!.blocks).toEqual([{ kind: "text", text: NOTE_TEXT, messageId: "note-3000" }]);
  });
});

/** The note's preview as the gateway lists it: its code marks gone. */
const LISTED = "Learned: created trail-check (check the trail). Say undo to revert.";
const task = (over: Partial<Task> = {}): Task => ({
  key: "agent:pip:trail",
  botId: "pip",
  sessionId: "s1",
  title: "Trail",
  preview: LISTED,
  updatedAt: 3_100,
  status: "done",
  unread: true,
  ...over,
});
/** History as this client loaded it at `loadedAt`, by this client's clock. */
const transcript = (rows: unknown[], loadedAt = 3_200): Transcript => ({
  ...emptyActivity,
  linkedRuns: {},
  interSession: [],
  mcpTools: {},
  sessionKey: "agent:pip:trail",
  status: "ready",
  items: mapHistory(rows),
  error: null,
  hasMore: false,
  live: null,
  loadedAt,
});
/** A note with this text. */
const noteSaying = (text: string, at = 3_000) => ({
  ...note(at),
  content: [{ type: "text", text }],
});

describe("F-560: the gateway's preview of a note, as it lists it", () => {
  it("is the note's text, trimmed, with its code marks and runs of space flattened", () => {
    expect(gatewayPreviewOfNote(`  ${NOTE_TEXT}\n`)).toBe(LISTED);
    expect(gatewayPreviewOfNote("💾 Learned: created `a`.\n\nSay   undo.")).toBe(
      "💾 Learned: created a. Say undo.",
    );
  });

  it("is cut to 240 characters with three dots, never inside a surrogate pair", () => {
    const long = `Learned: created \`trail-check\` (${"x".repeat(300)}).`;
    const listed = gatewayPreviewOfNote(long)!;
    expect(listed).toHaveLength(240);
    expect(listed.endsWith("x...")).toBe(true);
    const flat = `Learned: created trail-check (${"x".repeat(300)}).`;
    expect(listed).toBe(`${flat.slice(0, 237)}...`);
    // An emoji across the cut stays whole: the cut moves before it.
    const emoji = `${"y".repeat(236)}💾${"z".repeat(10)}`;
    expect(gatewayPreviewOfNote(emoji)).toBe(`${"y".repeat(236)}...`);
    expect(gatewayPreviewOfNote("y".repeat(240))).toBe("y".repeat(240));
  });

  it("is not known for Markdown the gateway would flatten another way", () => {
    for (const text of [
      "Learned: created **trail-check**.",
      "Learned: created _trail-check_.",
      "Learned: ~~old~~ new.",
      "Learned: [trail-check](https://example.com).",
      "Learned: <https://example.com>.",
      "# Learned",
      "- Learned: created trail-check.",
      "1. Learned",
      "Learned:\n> quoted",
      "Learned: ```code```",
      "`- item` learned",
      "Learned: escaped \\` mark",
      "   ",
    ]) {
      expect(gatewayPreviewOfNote(text), text).toBeNull();
    }
  });
});

describe("F-560: the rail's preview leaves out a note only when the listed preview is that note", () => {
  it("takes the preview from the last item before the notes, and changes nothing else", () => {
    const listed = task();
    const shown = taskWithoutSkillNotes(
      listed,
      transcript([
        user("Check the trail", 1_000),
        reply("The **trail** is open.", 2_000, "r1"),
        note(3_000),
        note(3_050),
      ]),
    );
    expect(shown).toEqual({ ...listed, preview: "The trail is open." });
  });

  it("keeps a newer reply's preview, whatever either clock says", () => {
    const history = [reply("The trail is open.", 2_000, "r1"), note(3_000)];
    // The host's clock 120 s ahead: its read of the history looks later than the newer row.
    const newer = task({ preview: "Here is the new route.", updatedAt: 5_005 });
    expect(taskWithoutSkillNotes(newer, transcript(history, 122_000))).toBe(newer);
    // And behind: the row looks later than the read, yet its preview is the note.
    const listed = task({ updatedAt: 9_000 });
    expect(taskWithoutSkillNotes(listed, transcript(history, 1_000)).preview).toBe(
      "The trail is open.",
    );
  });

  it("matches a long note by the gateway's cut preview, and nothing else", () => {
    const long = `Learned: created \`trail-check\` (${"x".repeat(300)}).`;
    const history = [reply("The trail is open.", 2_000, "r1"), noteSaying(long)];
    const cut = task({ preview: gatewayPreviewOfNote(long) });
    expect(taskWithoutSkillNotes(cut, transcript(history)).preview).toBe("The trail is open.");
    // The whole text is not what the gateway lists, so it is not taken for the note.
    const whole = task({ preview: long.replaceAll("`", "") });
    expect(taskWithoutSkillNotes(whole, transcript(history))).toBe(whole);
  });

  it("keeps the gateway's preview for a note it would format another way", () => {
    const text = "Learned: created **trail-check**. Say undo to revert.";
    const flattened = task({ preview: "Learned: created trail-check. Say undo to revert." });
    expect(
      taskWithoutSkillNotes(
        flattened,
        transcript([reply("The trail is open.", 2_000, "r1"), noteSaying(text)]),
      ),
    ).toBe(flattened);
  });

  it("is the gateway's row when the history does not end with a note, is not loaded, or was cut", () => {
    const listed = task();
    expect(taskWithoutSkillNotes(listed, undefined)).toBe(listed);
    expect(
      taskWithoutSkillNotes(
        listed,
        transcript([reply("The trail is open.", 2_000, "r1"), note(3_000), user("Thanks", 3_100)]),
      ),
    ).toBe(listed);
    expect(taskWithoutSkillNotes(listed, transcript([]))).toBe(listed);
    const cutNote = { ...note(3_000), __openclaw: { ...note(3_000).__openclaw, truncated: true } };
    expect(taskWithoutSkillNotes(listed, transcript([reply("Open.", 2_000, "r1"), cutNote]))).toBe(
      listed,
    );
  });

  it("a merged reply gives the text of its last row and leaves the time as the gateway has it", () => {
    const listed = task();
    const shown = taskWithoutSkillNotes(
      listed,
      transcript([
        user("Check the trail", 1_000),
        reply("Looking now.", 2_000, "r1"),
        reply("The trail is open.", 2_500, "r1"),
        note(3_000),
      ]),
    );
    expect(shown.preview).toBe("The trail is open.");
    expect(shown.updatedAt).toBe(listed.updatedAt);
    expect(taskWithoutSkillNotes(task(), transcript([note()]))).toEqual(task({ preview: null }));
  });

  it("loading or unloading a transcript never changes a task's time, so never the order", () => {
    const pip = task({ updatedAt: 3_100 });
    const otto = task({ key: "agent:otto:a", botId: "otto", updatedAt: 3_000, preview: "Done." });
    const byBot = { pip: [pip], otto: [otto] };
    expect(tasksWithoutSkillNotes(byBot, {})).toBe(byBot);
    const loaded = tasksWithoutSkillNotes(byBot, {
      "agent:pip:trail": transcript([reply("Open.", 2_000, "r1"), note()]),
    });
    expect(loaded.pip![0]).toEqual({ ...pip, preview: "Open." });
    expect(loaded.otto![0]).toBe(otto);
    expect(
      Object.values(loaded)
        .flat()
        .map((each) => [each.key, each.updatedAt]),
    ).toEqual(
      Object.values(byBot)
        .flat()
        .map((each) => [each.key, each.updatedAt]),
    );
  });
});
