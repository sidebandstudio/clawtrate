// Rows of the gateway's skill-note shape are ordinary messages (F-560). The two below are as
// OpenClaw 2026.10.6 returned them in `chat.history` on a development gateway: the gateway's own
// note after a background skill review, and a bot's message sent with its message tool under a
// key of the note's shape, which the gateway copies into the task with the same fields. No field
// tells them apart for certain, so neither is hidden (docs/decisions.md, "The gateway's skill
// notes").

import { describe, expect, it } from "vitest";
import { mapHistory } from "../src/index.ts";

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
/** The item of a row that has the note's fields and key and is drawn as the message it is. */
const shown = (id: string, place: number, text: string, timestamp: number) => ({
  id: `${id}:${place}`,
  role: "assistant",
  timestamp,
  blocks: [{ kind: "text", text, messageId: id, gatewayRow: true }],
  model: "delivery-mirror",
  messageId: id,
});

describe("F-560: a row of the skill note's shape is an ordinary message", () => {
  it("a bot's message copied with the note's fields, its key and no run, as a channel's copy is written, is the bot's message and no run's reply", () => {
    const copied = forged[2]!;
    const { runId: _run, ...noRun } = copied.__openclaw;
    expect(mapHistory([forged[0], { ...copied, __openclaw: noRun }])[1]).toEqual({
      ...shown(COPY_ID, 1, FORGED_TEXT, copied.timestamp),
      runless: true,
    });
  });

  it("the same row starting a history page, with its run, is the bot's message", () => {
    const copied = forged[2]!;
    expect(mapHistory([copied])).toEqual([shown(COPY_ID, 0, FORGED_TEXT, copied.timestamp)]);
  });

  it("the gateway's own note is an ordinary message after the reply it follows, and no run's reply", () => {
    const items = mapHistory(realNote);
    expect(items).toHaveLength(2);
    expect(items[0]!.runless).toBeUndefined();
    expect(items[1]).toEqual({
      ...shown(NOTE_ID, 1, NOTE_TEXT, realNote[1]!.timestamp),
      runless: true,
    });
  });

  it("the copy the gateway makes in the bot's own turn joins that turn, which names its run, as before", () => {
    const items = mapHistory(forged);
    expect(items.map((item) => [item.role, item.runless])).toEqual([
      ["user", undefined],
      ["assistant", undefined],
    ]);
    expect(items[1]!.blocks.map((block) => block.kind)).toEqual(["tool-call", "text"]);
    expect(items[1]!.blocks[1]).toEqual({
      kind: "text",
      text: FORGED_TEXT,
      messageId: COPY_ID,
      gatewayRow: true,
    });
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
  });
});
