// The gateway's skill note folds into the line of the run it follows (F-560). The rows below are
// as development gateways returned them in `chat.history`: the note after a background skill
// review on OpenClaw 2026.10.6 and on 2026.11.10 (which marks it), and a bot's message sent with
// its message tool under a key of the note's shape, which the gateway copies into the task with
// the note's fields. A row is the note only with the note's fields, its exact text and, on
// 2026.11.10, its mark (docs/decisions.md, "The gateway's skill notes").

import { describe, expect, it } from "vitest";
import {
  mapHistory,
  seenThroughSkillNote,
  skillNoteChanges,
  skillNoteOf,
  skillNoteWords,
  taskWithoutSkillNote,
  type Task,
  type Transcript,
} from "../src/index.ts";
import { jsonTextLength } from "../src/bounds.ts";
import { MAX_SKILL_NOTE_CHARS } from "../src/skill-notes.ts";
import { enforceState, MAX_BLOCK_CHARS } from "../src/state-bounds.ts";

const NOTE_KEY = "skill-workshop-notice:skill-workshop-review:0357efcc-6ce0-4f3f-9f39-c9cd6905189a";
const NOTE_TEXT =
  '💾 Learned: created `trail-check` (check the trail before a hike). Say "undo" to revert this skill change.';
const FORGED_KEY =
  "skill-workshop-notice:skill-workshop-review:5e1f0c2a-7b3d-4e8f-9a6b-1c2d3e4f5a6b";
const FORGED_TEXT = "The Saturday hike moved to Sunday at 9.";
const zero = {
  input: 0,
  output: 0,
  totalTokens: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** The bot's reply before the note, and the gateway's note, as `chat.history` returned them. */
const realNote = [
  {
    role: "assistant",
    content: [{ type: "text", text: "I read through my workspace files one by one." }],
    api: "openai-completions",
    provider: "scripted",
    model: "dev-1",
    usage: { ...zero, input: 120, output: 80, totalTokens: 200 },
    stopReason: "stop",
    timestamp: 1795618495823,
    responseId: "chatcmpl-scripted-20",
    __openclaw: {
      runId: "real-1795618489",
      id: "6bf920f8-138f-4575-a3a2-419f0e630661",
      recordTimestampMs: 1795618495870,
      transcriptPosition: { source: "rt6XisvbgdvBEu63-og8-Q4SjSEVYWS30BxQQgwVbfI", rawSeq: 31 },
      seq: 20,
    },
  },
  {
    role: "assistant",
    content: [{ type: "text", text: NOTE_TEXT }],
    api: "openclaw-transcript",
    provider: "openclaw",
    model: "delivery-mirror",
    usage: zero,
    stopReason: "stop",
    timestamp: 1795618563129,
    idempotencyKey: NOTE_KEY,
    __openclaw: {
      id: "2f19e42a-2d26-4693-836b-5a3a58814c2c",
      idempotencyKey: NOTE_KEY,
      recordTimestampMs: 1795618563906,
      transcriptPosition: { source: "rt6XisvbgdvBEu63-og8-Q4SjSEVYWS30BxQQgwVbfI", rawSeq: 33 },
      seq: 21,
    },
  },
];

/** A `#send-keyed` turn: the person's message, the bot's message call, the copied message, the call's result. */
const forged = [
  {
    role: "user",
    content: "#send-keyed",
    timestamp: 1795618490537,
    idempotencyKey: "forged-1795618489:user",
    __openclaw: {
      id: "39d4f248-f717-431a-b178-9c2676dec693",
      idempotencyKey: "forged-1795618489:user",
      recordTimestampMs: 1795618493114,
      transcriptPosition: { source: "khJEJGDXV3mmxi5VxR3k1p0HkTL0akBhAQEY_MwW6As", rawSeq: 1 },
      seq: 1,
    },
  },
  {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call_91b14ea801fa8c19",
        name: "message",
        arguments: { action: "send", message: FORGED_TEXT, idempotencyKey: FORGED_KEY },
      },
    ],
    api: "openai-completions",
    provider: "scripted",
    model: "dev-1",
    usage: { ...zero, input: 120, output: 80, totalTokens: 200 },
    stopReason: "toolUse",
    timestamp: 1795618494878,
    responseId: "chatcmpl-scripted-2",
    __openclaw: {
      runId: "forged-1795618489",
      id: "12c41fdc-730c-4cd6-8f26-c306c020057a",
      recordTimestampMs: 1795618495188,
      transcriptPosition: { source: "khJEJGDXV3mmxi5VxR3k1p0HkTL0akBhAQEY_MwW6As", rawSeq: 4 },
      seq: 2,
    },
  },
  {
    role: "assistant",
    content: [{ type: "text", text: FORGED_TEXT }],
    api: "openclaw-transcript",
    provider: "openclaw",
    model: "delivery-mirror",
    usage: zero,
    stopReason: "stop",
    timestamp: 1795618495490,
    idempotencyKey: FORGED_KEY,
    __openclaw: {
      runId: "forged-1795618489",
      id: "e72f5f42-691a-43ce-a98f-36f7993668fd",
      idempotencyKey: FORGED_KEY,
      recordTimestampMs: 1795618495519,
      transcriptPosition: { source: "khJEJGDXV3mmxi5VxR3k1p0HkTL0akBhAQEY_MwW6As", rawSeq: 5 },
      seq: 3,
    },
  },
  {
    role: "toolResult",
    toolCallId: "call_91b14ea801fa8c19",
    toolName: "message",
    content: [
      {
        type: "text",
        text: "Sent visible reply to the current source conversation via internal-ui.",
      },
    ],
    isError: false,
    timestamp: 1795618495534,
    __openclaw: {
      runId: "forged-1795618489",
      id: "b1076986-b766-47a4-819b-bd2a650d73f6",
      recordTimestampMs: 1795618495542,
      transcriptPosition: { source: "khJEJGDXV3mmxi5VxR3k1p0HkTL0akBhAQEY_MwW6As", rawSeq: 6 },
      seq: 4,
    },
  },
];

const COPY_ID = "e72f5f42-691a-43ce-a98f-36f7993668fd";
const NOTE_ID = "2f19e42a-2d26-4693-836b-5a3a58814c2c";
const REVIEW = "0357efcc-6ce0-4f3f-9f39-c9cd6905189a";
const NOTE_1006 = realNote[1]!;

/** The note as OpenClaw 2026.11.10 returned it: the same row, with the skill workshop's mark. */
const NOTE_1110 = {
  role: "assistant",
  content: [{ type: "text", text: NOTE_TEXT }],
  api: "openclaw-transcript",
  provider: "openclaw",
  model: "delivery-mirror",
  usage: zero,
  stopReason: "stop",
  timestamp: 1795763600317,
  openclawDeliveryMirror: {
    kind: "plugin-notice",
    pluginId: "skill-workshop",
    type: "skills-changed",
    data: {
      agentId: "main",
      runId: `skill-workshop-review:${REVIEW}`,
      skills: [
        { name: "trail-check", action: "created", summary: "check the trail before a hike" },
      ],
    },
  },
  idempotencyKey: NOTE_KEY,
  __openclaw: {
    id: "8d1c2b4e-5f60-4a7b-9c8d-0e1f2a3b4c5d",
    idempotencyKey: NOTE_KEY,
    recordTimestampMs: 1795763600350,
    transcriptPosition: { source: "pQ3vZ8rT1sW4yU6xA9bC2dE5fG7hJ0kL", rawSeq: 36 },
    seq: 21,
  },
};

/** The item of a row that has the note's fields and key and is drawn as the message it is. */
const shown = (id: string, place: number, text: string, timestamp: number) => ({
  id: `${id}:${place}`,
  role: "assistant",
  timestamp,
  blocks: [{ kind: "text", text, messageId: id }],
  model: "delivery-mirror",
  messageId: id,
});
/** The note with other text, as a bot can write it. */
const withText = <T extends { content: unknown }>(row: T, text: string): T => ({
  ...row,
  content: [{ type: "text", text }],
});
/** A bot's copied message with no run, as a send to a channel is copied into the task. */
const { runId: _run, ...copyMeta } = forged[2]!.__openclaw;
const channelCopy = { ...forged[2]!, __openclaw: copyMeta };

describe("F-560: the gateway's skill note, on each version", () => {
  it("2026.10.6: the note after the reply it follows is a skill note, no run's reply, unmarked", () => {
    const items = mapHistory(realNote);
    expect(items).toHaveLength(2);
    expect(items[0]!.skillNote).toBeUndefined();
    expect(items[1]).toEqual({
      ...shown(NOTE_ID, 1, NOTE_TEXT, NOTE_1006.timestamp),
      runless: true,
      skillNote: {
        reviewId: REVIEW,
        skills: [{ name: "trail-check", action: "created" }],
        agentId: null,
        after: realNote[0]!.timestamp,
      },
    });
  });

  it("2026.11.10: the marked note is a skill note naming its bot, for the gateway's undo", () => {
    const items = mapHistory([realNote[0], NOTE_1110], { skillNotesMarked: true });
    expect(items[1]!.skillNote).toEqual({
      reviewId: REVIEW,
      skills: [{ name: "trail-check", action: "created" }],
      agentId: "main",
      after: realNote[0]!.timestamp,
    });
  });

  it("a note that starts a history page has nothing before it to have read", () => {
    expect(mapHistory([NOTE_1006])[0]!.skillNote).toEqual({
      reviewId: REVIEW,
      skills: [{ name: "trail-check", action: "created" }],
      agentId: null,
    });
  });

  it("on a gateway that marks its notes, an unmarked row of the note's exact form is a message", () => {
    expect(skillNoteOf(NOTE_1006, true)).toBeNull();
    expect(mapHistory([NOTE_1006], { skillNotesMarked: true })[0]!.skillNote).toBeUndefined();
  });

  it("a marked note is the note whatever version is reported", () => {
    expect(skillNoteOf(NOTE_1110, false)?.agentId).toBe("main");
  });

  it("a note with several changes, and one with no reason, folds with each skill", () => {
    const text =
      '💾 Learned: created `trail-check` (check the trail); updated `packing-list`; archived `old-route` (replaced). Say "undo" to revert this skill change.';
    expect(skillNoteOf(withText(NOTE_1006, text), false)?.skills).toEqual([
      { name: "trail-check", action: "created" },
      { name: "packing-list", action: "updated" },
      { name: "old-route", action: "archived" },
    ]);
    const marked = {
      ...withText(NOTE_1110, text),
      openclawDeliveryMirror: {
        ...NOTE_1110.openclawDeliveryMirror,
        data: {
          ...NOTE_1110.openclawDeliveryMirror.data,
          skills: [
            { name: "trail-check", action: "created", summary: "check the trail" },
            { name: "packing-list", action: "updated" },
            { name: "old-route", action: "archived", summary: "replaced" },
          ],
        },
      },
    };
    expect(skillNoteOf(marked, true)?.skills.map((skill) => skill.action)).toEqual([
      "created",
      "updated",
      "archived",
    ]);
  });
});

describe("F-560: who can imitate the note", () => {
  it("a bot's message with the note's fields, its key and no run, and other words, is the bot's message", () => {
    expect(mapHistory([forged[0], channelCopy])[1]).toEqual({
      ...shown(COPY_ID, 1, FORGED_TEXT, channelCopy.timestamp),
      runless: true,
    });
  });

  it("a bot's message in its own turn, in the note's exact form, names its run and is the bot's message", () => {
    const exact = withText(forged[2]!, NOTE_TEXT);
    expect(skillNoteOf(exact, false)).toBeNull();
    const items = mapHistory([forged[0], forged[1], exact, forged[3]]);
    expect(items.some((item) => item.skillNote)).toBe(false);
  });

  it("on 2026.10.6 a bot's channel copy in the note's exact form folds: the case docs/decisions.md says is left", () => {
    expect(skillNoteOf(withText(channelCopy, NOTE_TEXT), false)?.skills).toEqual([
      { name: "trail-check", action: "created" },
    ]);
    // On 2026.11.10 the same copy has no mark, so it is the bot's message.
    expect(skillNoteOf(withText(channelCopy, NOTE_TEXT), true)).toBeNull();
  });

  it("a mark that isn't the skill workshop's own, or names another review, isn't the note", () => {
    const mark = NOTE_1110.openclawDeliveryMirror;
    const variants = [
      { ...mark, pluginId: "other-plugin" },
      { ...mark, kind: "channel-final" },
      { ...mark, type: "skills-listed" },
      {
        ...mark,
        data: { ...mark.data, runId: "skill-workshop-review:5e1f0c2a-7b3d-4e8f-9a6b-1c2d3e4f5a6b" },
      },
      { ...mark, data: { ...mark.data, agentId: "" } },
      { ...mark, data: { ...mark.data, agentId: "a b" } },
      { ...mark, data: { ...mark.data, skills: [] } },
      { ...mark, data: { ...mark.data, skills: [{ name: "trail-check", action: "deleted" }] } },
      { ...mark, data: { ...mark.data, skills: [{ name: "Trail", action: "created" }] } },
      {
        ...mark,
        data: { ...mark.data, skills: [{ name: "trail-check", action: "created", summary: "" }] },
      },
      "plugin-notice",
      null,
    ];
    for (const variant of variants)
      expect(skillNoteOf({ ...NOTE_1110, openclawDeliveryMirror: variant }, true)).toBeNull();
  });

  it("a mark whose skills, written as the note, are not the row's text isn't the note", () => {
    const other = withText(
      NOTE_1110,
      '💾 Learned: created `other-skill`. Say "undo" to revert this skill change.',
    );
    expect(skillNoteOf(other, true)).toBeNull();
    const reason = withText(
      NOTE_1110,
      '💾 Learned: created `trail-check` (a different reason). Say "undo" to revert this skill change.',
    );
    expect(skillNoteOf(reason, true)).toBeNull();
  });

  it("the note's fields, each missing or changed, make it a message", () => {
    const { __openclaw: meta, ...rest } = NOTE_1006;
    const variants: unknown[] = [
      { ...NOTE_1006, role: "user" },
      { ...NOTE_1006, api: "openai-responses" },
      { ...NOTE_1006, provider: "scripted" },
      { ...NOTE_1006, model: "gateway-injected" },
      { ...NOTE_1006, responseId: "chatcmpl-1" },
      { ...NOTE_1006, openclawDelivery: { mediaUrls: [] } },
      { ...NOTE_1006, openclawAbort: { aborted: true, runId: "send-1" } },
      { ...NOTE_1006, __openclaw: { ...meta, runId: "real-1" } },
      { ...rest, idempotencyKey: undefined, __openclaw: { ...meta, idempotencyKey: undefined } },
      { ...NOTE_1006, content: [...NOTE_1006.content, { type: "text", text: "more" }] },
      { ...NOTE_1006, content: [{ type: "image", data: "" }] },
    ];
    for (const variant of variants) expect(skillNoteOf(variant, false)).toBeNull();
  });

  it("a key of another shape isn't the note's", () => {
    for (const key of [
      `${NOTE_KEY} `,
      NOTE_KEY.toUpperCase(),
      "skill-workshop-notice:skill-workshop-review:",
      "skill-workshop-notice:skill-workshop-review:not-a-uuid",
      `${NOTE_KEY}:assistant`,
      `x${NOTE_KEY}`,
      "skill-workshop-notice:0357efcc-6ce0-4f3f-9f39-c9cd6905189a",
    ]) {
      const row = {
        ...NOTE_1006,
        idempotencyKey: key,
        __openclaw: { ...NOTE_1006.__openclaw, idempotencyKey: key },
      };
      expect(skillNoteOf(row, false)).toBeNull();
    }
  });

  it("a reply the gateway kept after an abort names its run there, so it stays the run's reply", () => {
    const kept = {
      role: "assistant",
      content: [{ type: "text", text: "Two folders were skipped because" }],
      api: "openai-responses",
      provider: "openclaw",
      model: "gateway-injected",
      stopReason: "stop",
      timestamp: 2_000,
      openclawAbort: { aborted: true, origin: "rpc", runId: "send-1" },
      __openclaw: { id: "kept-1" },
    };
    expect(mapHistory([kept])[0]!.runless).toBeUndefined();
    expect(mapHistory([kept])[0]!.skillNote).toBeUndefined();
  });
});

describe("F-560: the note's exact form", () => {
  it("text one character off isn't the note's", () => {
    const variants = [
      `${NOTE_TEXT} `,
      ` ${NOTE_TEXT}`,
      NOTE_TEXT.replace("💾 ", ""),
      NOTE_TEXT.replace("created", "Created"),
      NOTE_TEXT.replace("created", "deleted"),
      NOTE_TEXT.replace("`trail-check`", "trail-check"),
      NOTE_TEXT.replace("`trail-check`", "`Trail-Check`"),
      NOTE_TEXT.replace(" (check", "(check"),
      NOTE_TEXT.replace("(check", "( check"),
      NOTE_TEXT.replace("hike)", "hike )"),
      NOTE_TEXT.replace("hike)", "hike) "),
      NOTE_TEXT.replace('Say "undo"', "Say undo"),
      NOTE_TEXT.replace("change.", "change"),
      '💾 Learned: . Say "undo" to revert this skill change.',
      '💾 Learned: created `trail-check` ()". Say "undo" to revert this skill change.',
      '💾 Learned: created `trail-check`;. Say "undo" to revert this skill change.',
      '💾 Learned: created `trail-check` (a);  updated `b`. Say "undo" to revert this skill change.',
    ];
    for (const text of variants) {
      expect(text).not.toBe(NOTE_TEXT);
      expect(skillNoteChanges(text), text).toBeNull();
    }
  });

  it("the exact form round-trips, with or without reasons", () => {
    expect(skillNoteChanges(NOTE_TEXT)).toEqual([
      { action: "created", name: "trail-check", summary: "check the trail before a hike" },
    ]);
    expect(
      skillNoteChanges(
        '💾 Learned: restored `a1`; updated `b-2`. Say "undo" to revert this skill change.',
      ),
    ).toEqual([
      { action: "restored", name: "a1" },
      { action: "updated", name: "b-2" },
    ]);
  });

  it("more than 8 skills, or a text past its bound, shows as the message it is", () => {
    const many = Array.from({ length: 9 }, (_, index) => `created \`s${index}\``).join("; ");
    expect(
      skillNoteChanges(`💾 Learned: ${many}. Say "undo" to revert this skill change.`),
    ).toBeNull();
    const long = `💾 Learned: created \`a\` (${"x".repeat(4_000)}). Say "undo" to revert this skill change.`;
    expect(skillNoteChanges(long)).toBeNull();
  });
});

describe("F-560: the folded line's words", () => {
  it("says what was saved or changed, by name", () => {
    const one = (action: "created" | "updated" | "archived" | "restored") => [
      { skills: [{ name: "trail-check", action }] },
    ];
    expect(skillNoteWords(one("created"))).toBe("Saved a skill: trail-check");
    expect(skillNoteWords(one("updated"))).toBe("Changed a skill: trail-check");
    expect(skillNoteWords(one("archived"))).toBe("Changed a skill: trail-check");
    expect(skillNoteWords(one("restored"))).toBe("Changed a skill: trail-check");
    expect(
      skillNoteWords([
        {
          skills: [
            { name: "a", action: "created" },
            { name: "b", action: "updated" },
          ],
        },
        { skills: [{ name: "c", action: "created" }] },
      ]),
    ).toBe("Saved 2 skills: a, c · Changed a skill: b");
  });
});

/** A task whose listed preview is what the gateway lists, and its loaded history. */
const task = (preview: string | null, updatedAt: number | null): Task =>
  ({ key: "agent:main:t", botId: "main", title: "T", preview, updatedAt }) as unknown as Task;
const loaded = (rows: unknown[], hasMore = false): Transcript =>
  ({ items: mapHistory(rows), hasMore }) as unknown as Transcript;
const LISTED_NOTE =
  '💾 Learned: created trail-check (check the trail before a hike). Say "undo" to revert this skill change.';
const REPLY = "I read through my workspace files one by one.";
/** No update this device followed: no update line anywhere. */
const NO_UPDATES = { updated: [], gatewayId: "gw-a", mainKey: "agent:main:t" };

describe("F-560: the note is not the bot's preview, and doesn't mark the task unread", () => {
  it("the listed preview of the note the history ends with shows the reply before it", () => {
    expect(taskWithoutSkillNote(task(LISTED_NOTE, 3), loaded(realNote), NO_UPDATES).preview).toBe(
      REPLY,
    );
  });

  it("a newer listed preview, or one the gateway made of other text, stays", () => {
    expect(
      taskWithoutSkillNote(task("Something newer", 3), loaded(realNote), NO_UPDATES).preview,
    ).toBe("Something newer");
    const other = withText(channelCopy, FORGED_TEXT);
    expect(
      taskWithoutSkillNote(task(FORGED_TEXT, 3), loaded([realNote[0], other]), NO_UPDATES).preview,
    ).toBe(FORGED_TEXT);
  });

  it("with nothing before the note, the title shows", () => {
    expect(
      taskWithoutSkillNote(task(LISTED_NOTE, 3), loaded([NOTE_1006]), NO_UPDATES).preview,
    ).toBeNull();
  });

  it("a read-only viewer that read the reply has read the task through the note", () => {
    const at = NOTE_1006.timestamp + 5;
    const seen = realNote[0]!.timestamp;
    expect(seenThroughSkillNote(task(LISTED_NOTE, at), seen, loaded(realNote))).toBe(at);
    // One that read before the reply hasn't.
    expect(seenThroughSkillNote(task(LISTED_NOTE, at), seen - 1, loaded(realNote))).toBe(seen - 1);
    // Nor when the listed row has something newer than the note.
    expect(seenThroughSkillNote(task("Newer", at), seen, loaded(realNote))).toBe(seen);
    // A note alone on a page that isn't the whole history proves nothing.
    expect(seenThroughSkillNote(task(LISTED_NOTE, at), seen, loaded([NOTE_1006], true))).toBe(seen);
    expect(seenThroughSkillNote(task(LISTED_NOTE, at), seen, loaded([NOTE_1006]))).toBe(at);
  });
});

describe("F-560: the note's mark is kept whole in the state", () => {
  it("the review's id, the longest skill name and the longest bot id survive the state's bounds", () => {
    const name = `a${"b".repeat(62)}`;
    const agentId = "c".repeat(128);
    const text = `💾 Learned: updated \`${name}\`. Say "undo" to revert this skill change.`;
    const row = {
      ...withText(NOTE_1110, text),
      openclawDeliveryMirror: {
        ...NOTE_1110.openclawDeliveryMirror,
        data: {
          ...NOTE_1110.openclawDeliveryMirror.data,
          agentId,
          skills: [{ name, action: "updated" }],
        },
      },
    };
    const items = mapHistory([row], { skillNotesMarked: true });
    expect(items[0]!.skillNote).toEqual({
      reviewId: REVIEW,
      skills: [{ name, action: "updated" }],
      agentId,
    });
    const transcript = { items } as unknown as Transcript;
    const kept = enforceState({ transcripts: { t: transcript } } as never) as unknown as {
      transcripts: Record<string, Transcript>;
    };
    expect(kept.transcripts.t!.items[0]!.skillNote).toEqual(items[0]!.skillNote);
  });
});

describe("F-560: a folded note's words are never cut", () => {
  const sized = (chars: number) => {
    const head = "💾 Learned: created `a` (";
    const tail = '). Say "undo" to revert this skill change.';
    const base = jsonTextLength(`${head}${tail}`);
    return `${head}${"x".repeat(chars - base)}${tail}`;
  };
  const kept = (text: string) => {
    const items = mapHistory([withText(NOTE_1006, text)]);
    const state = enforceState({
      transcripts: { t: { items } as unknown as Transcript },
    } as never) as unknown as { transcripts: Record<string, Transcript> };
    return { item: items[0]!, kept: state.transcripts.t!.items[0]! };
  };

  it("folds a note only as long as the state keeps a text block whole", () => {
    expect(MAX_SKILL_NOTE_CHARS).toBe(MAX_BLOCK_CHARS);
    const longest = sized(MAX_BLOCK_CHARS);
    expect(jsonTextLength(longest)).toBe(MAX_BLOCK_CHARS);
    const { item, kept: inState } = kept(longest);
    expect(item.skillNote).toBeDefined();
    expect(inState.cut).toBeUndefined();
    expect(inState.blocks[0]).toMatchObject({ kind: "text", text: longest });
  });

  it("a note one character longer, which the state would cut, is the message it is", () => {
    const { item, kept: inState } = kept(sized(MAX_BLOCK_CHARS + 1));
    expect(item.skillNote).toBeUndefined();
    expect(inState.cut).toBeDefined();
  });
});
