// What the conversation draws of a running run's text beside its calls and its reply, from the
// engine's run and history's rows of it, as OpenClaw 2026.11.10 sends them: no `preamble` item,
// each text an `assistant` item of its own (conversation.md 7.6). Every name and text is invented.

import {
  applyAgentEvent,
  emptyActivity,
  enforceState,
  initialState,
  mapHistory,
  RawTable,
  readingContextOf,
  replyRow,
  unfollowed,
  type ClawtrateBridge,
  type Run,
  type TaskActivity,
  type Transcript,
} from "@clawtrate/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ActionScope, ItemFeed, RunFeed } from "../src/actions/feed.tsx";
import { BridgeProvider } from "../src/bridge.tsx";
import { CardScope } from "../src/cards/TranscriptCards.tsx";
import { RunReply } from "../src/LiveTurn.tsx";

// "Show commands" and "Show thinking" read the device's storage, which a markup render has none
// of: off, as by default.
vi.mock("../src/preferences.ts", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useShowCommands: () => [false, () => {}],
  useShowThinking: () => [false, () => {}],
}));

// A markup render has no store to subscribe to: the state the card scope reads.
vi.mock("../src/bridge.tsx", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useClawtrateState: () => initialState,
}));

const KEY = "agent:otto:logs";
const RUN = "run-1";

/** The run as the engine holds it after these `agent` events, within the state's bounds. */
function transcriptOf(
  events: Array<[string, Record<string, unknown>]>,
  rows: unknown[] = [],
): Transcript {
  const raw = new RawTable();
  let activity: TaskActivity = emptyActivity;
  events.forEach(([stream, data], i) => {
    const payload = { runId: RUN, seq: i + 1, stream, ts: 1_000 + i, sessionKey: KEY, data };
    activity = applyAgentEvent(activity, payload, { sessionKey: KEY, now: 5_000, raw }).activity;
  });
  const transcript: Transcript = {
    ...activity,
    sessionKey: KEY,
    status: "ready",
    items: mapHistory(rows),
    error: null,
    hasMore: false,
    live: null,
    linkedRuns: {},
    interSession: [],
    mcpTools: {},
    loadedAt: 1,
  };
  return enforceState({ ...initialState, transcripts: { [KEY]: transcript } }).transcripts[KEY]!;
}

/** The conversation's drawing of the run's history rows and of the run itself. */
function draw(transcript: Transcript): string {
  const run = transcript.runs[0]!;
  // Whenever history gives up a block as the reply's row, the live reply shows those words: no
  // words leave the screen (#872). Checked here by the words, which the app never compares.
  const given = replyRow(run, transcript.items);
  if (given) {
    const block = transcript.items.find((item) => item.id === given.itemId)!.blocks[given.block]!;
    expect(block.kind === "text" && run.text.includes(block.text.trim())).toBe(true);
  }
  const bridge = {
    invoke: () => Promise.reject(new Error("not in this test")),
    send: () => Promise.reject(new Error("not in this test")),
  } as unknown as ClawtrateBridge;
  const scope = createElement(ActionScope, {
    taskKey: KEY,
    transcript,
    engineRuns: [run],
    lost: false,
    readOnly: true,
    ctx: readingContextOf(transcript),
    children: [
      ...transcript.items.map((item) => createElement(ItemFeed, { key: item.id, itemId: item.id })),
      createElement(RunFeed, {
        key: "run",
        runId: RUN,
        reply: (each: Run) => createElement(RunReply, { run: each }),
      }),
    ],
  });
  return renderToStaticMarkup(
    createElement(BridgeProvider, {
      bridge,
      children: createElement(CardScope, { taskKey: KEY, transcript, children: scope }),
    }),
  );
}

const count = (html: string, text: string) => html.split(text).length - 1;
const said = (itemId: string, text: string): Array<[string, Record<string, unknown>]> => [
  ["assistant", { text, delta: text, itemId }],
];
const call = (id: string): Array<[string, Record<string, unknown>]> => [
  ["item", { itemId: `tool:${id}`, toolCallId: id, name: "ls", kind: "tool", phase: "start" }],
  ["tool", { toolCallId: id, name: "ls", phase: "start", args: { path: "." } }],
  ["tool", { toolCallId: id, name: "ls", phase: "result", result: { content: [] } }],
  ["item", { itemId: `tool:${id}`, toolCallId: id, name: "ls", kind: "tool", phase: "end" }],
];
const start: Array<[string, Record<string, unknown>]> = [["lifecycle", { phase: "start" }]];

describe("F-088: text beside a call is known by its item, never by its words", () => {
  it("two items with the same words, each beside its own call, are each drawn", () => {
    const html = draw(
      transcriptOf([
        ...start,
        ...said("m:1", "Checking logs."),
        ...call("c1"),
        ...said("m:2", "Checking logs."),
        ...call("c2"),
        ...said("m:3", "Both logs are clean."),
      ]),
    );
    expect(count(html, "Checking logs.")).toBe(2);
    expect(count(html, "Both logs are clean.")).toBe(1);
  });

  it("a reply with the same words as text beside an earlier call is drawn as the reply", () => {
    const html = draw(
      transcriptOf([
        ...start,
        ...said("m:1", "Checking logs."),
        ...call("c1"),
        ...said("m:2", "Checking logs."),
      ]),
    );
    expect(count(html, "Checking logs.")).toBe(2);
    expect(html).toContain('data-testid="live-turn"');
  });

  it("text beside a call longer than its bound is drawn once, before the call, cut as the bound says", () => {
    const long = `First I read every log. ${"Line by line, before I answer. ".repeat(90)}The end.`;
    expect(long.length).toBeGreaterThan(2_800);
    const live = draw(transcriptOf([...start, ...said("m:1", long), ...call("c1")]));
    expect(count(live, "First I read every log.")).toBe(1);
    // The part past the bound is not drawn anywhere, and nothing is drawn as the reply.
    expect(live).not.toContain("The end.");
    expect(live).not.toContain('data-testid="live-turn"');

    // The next item streams, and history now holds the call's row with the whole text before it.
    const rows = [
      {
        role: "assistant",
        content: [
          { type: "text", text: long },
          { type: "toolCall", id: "c1", name: "ls", arguments: { path: "." } },
        ],
        __openclaw: { id: "a1", seq: 2, runId: RUN },
      },
    ];
    const later = draw(
      transcriptOf(
        [...start, ...said("m:1", long), ...call("c1"), ...said("m:2", "All clean.")],
        rows,
      ),
    );
    expect(count(later, "First I read every log.")).toBe(1);
    expect(later).not.toContain("The end.");
    expect(count(later, "All clean.")).toBe(1);
  });

  it("on 2026.10.6, the text its preamble item and the stream both carry is drawn once, before the call", () => {
    const text = "Checking logs.";
    const preamble = (phase: string): [string, Record<string, unknown>] => [
      "item",
      { itemId: "commentary-0-a1", kind: "preamble", title: "Preamble", phase, progressText: text },
    ];
    const html = draw(
      transcriptOf([
        ...start,
        ...said("m:1", text),
        preamble("update"),
        preamble("end"),
        ...call("c1"),
      ]),
    );
    expect(count(html, text)).toBe(1);
    expect(html).not.toContain('data-testid="live-turn"');
  });

  it("history's row of the reply the engine still streams is drawn once, as the reply, while the run goes on", () => {
    // No history row names an item of the stream. The reply's item was the first to begin after
    // a call this client saw start, so its row is the first text history holds after that call's
    // block: drawn once, as the reply, where the run draws it (#872). Was drawn twice until #872.
    const rows = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking logs." },
          { type: "toolCall", id: "c1", name: "ls", arguments: { path: "." } },
        ],
        __openclaw: { id: "a1", seq: 2, runId: RUN },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Both logs are clean." }],
        __openclaw: { id: "a2", seq: 4, runId: RUN },
      },
    ];
    const html = draw(
      transcriptOf(
        [
          ...start,
          ...said("m:1", "Checking logs."),
          ...call("c1"),
          ...said("m:2", "Both logs are clean."),
        ],
        rows,
      ),
    );
    expect(count(html, "Checking logs.")).toBe(1);
    expect(count(html, "Both logs are clean.")).toBe(1);
    expect(html).toContain('data-testid="live-turn"');
  });

  it("text the run wrote before a person's message steered it stays where it was while the run answers", () => {
    const rows = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "c1", name: "ls", arguments: { path: "." } },
          { type: "text", text: "An interim note." },
        ],
        __openclaw: { id: "a1", seq: 2, runId: RUN },
      },
      { role: "user", content: "Also check the cache.", __openclaw: { id: "u2", seq: 3 } },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking the cache." },
          { type: "toolCall", id: "c2", name: "ls", arguments: { path: "cache" } },
        ],
        __openclaw: { id: "a2", seq: 4, runId: RUN },
      },
    ];
    const html = draw(
      transcriptOf(
        [
          ...start,
          ...call("c1"),
          ...said("m:1", "An interim note."),
          ...said("m:2", "Checking the cache."),
          ...call("c2"),
          ...said("m:3", "All clean."),
        ],
        rows,
      ),
    );
    expect(count(html, "An interim note.")).toBe(1);
    expect(count(html, "Checking the cache.")).toBe(1);
    expect(count(html, "All clean.")).toBe(1);
  });

  it("text the run wrote before a person's message stays while history holds only the rows before it", () => {
    // The history read every send schedules holds the run's row and the person's message, not
    // the steered run's next row.
    const rows = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "c1", name: "ls", arguments: { path: "." } },
          { type: "text", text: "An interim note." },
        ],
        __openclaw: { id: "a1", seq: 2, runId: RUN },
      },
      { role: "user", content: "Also check the cache.", __openclaw: { id: "u2", seq: 3 } },
    ];
    const html = draw(
      transcriptOf(
        [
          ...start,
          ...call("c1"),
          ...said("m:1", "An interim note."),
          ...said("m:2", "Checking the cache."),
          ...call("c2"),
          ...said("m:3", "All clean."),
        ],
        rows,
      ),
    );
    expect(count(html, "An interim note.")).toBe(1);
    expect(count(html, "Checking the cache.")).toBe(1);
    expect(count(html, "All clean.")).toBe(1);
  });

  it("text written after a call stays while the run's next message streams, with no message of the person's", () => {
    // OpenClaw 2026.11.10 rereads history at each row it writes: the earlier row, not the next.
    const rows = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "c1", name: "ls", arguments: { path: "." } },
          { type: "text", text: "The listing is in." },
        ],
        __openclaw: { id: "a1", seq: 2, runId: RUN },
      },
    ];
    const html = draw(
      transcriptOf(
        [
          ...start,
          ...call("c1"),
          ...said("m:1", "The listing is in."),
          ...said("m:2", "Now the summary."),
        ],
        rows,
      ),
    );
    expect(count(html, "The listing is in.")).toBe(1);
    expect(count(html, "Now the summary.")).toBe(1);
  });

  it("on 2026.10.6, text its preamble item holds is drawn twice until its call starts, then once", () => {
    // The gateway sends the preamble item after the message's text and before the call's start.
    // Until the call starts, nothing ties the preamble to the stream's item, so the text is also
    // the reply: drawn twice for that moment, never left out. Pinned so that changing it is deliberate.
    const text = "Checking logs.";
    const preamble = (phase: string): [string, Record<string, unknown>] => [
      "item",
      { itemId: "commentary-0-a1", kind: "preamble", title: "Preamble", phase, progressText: text },
    ];
    const before = [...start, ...said("m:1", text), preamble("update"), preamble("end")];
    const waiting = draw(transcriptOf(before));
    expect(count(waiting, text)).toBe(2);
    expect(waiting).toContain('data-testid="live-turn"');
    const started = draw(transcriptOf([...before, ...call("c1")]));
    expect(count(started, text)).toBe(1);
    expect(started).not.toContain('data-testid="live-turn"');
  });

  it("on 2026.10.6, an answer the person read stays the reply when a steer's text comes only as a preamble item, through each call it starts", () => {
    // A text-only answer, then a steer: the gateway asks the model again, and its text beside the
    // next calls comes only as a preamble item. That item is not the answer's, and neither call
    // of that message moves the answer beside itself.
    const note = "Now checking the cache.";
    const preamble = (phase: string): [string, Record<string, unknown>] => [
      "item",
      { itemId: "commentary-0-b2", kind: "preamble", title: "Preamble", phase, progressText: note },
    ];
    const before = [
      ...start,
      ...said("m:1", "The logs are clean."),
      ["lifecycle", { phase: "model" }] as [string, Record<string, unknown>],
      preamble("update"),
      preamble("end"),
    ];
    for (const html of [
      draw(transcriptOf(before)),
      draw(transcriptOf([...before, ...call("c2")])),
      draw(transcriptOf([...before, ...call("c2"), ...call("c3")])),
    ]) {
      expect(count(html, "The logs are clean.")).toBe(1);
      expect(count(html, note)).toBe(1);
      // Still the reply, where it was read: not moved beside either call.
      const reply = html.slice(html.indexOf('data-testid="live-turn"'));
      expect(html).toContain('data-testid="live-turn"');
      expect(reply).toContain("The logs are clean.");
    }
  });

  it("a preamble item that ends with no text takes nothing: the reply is drawn, and no empty bubble", () => {
    const bare: [string, Record<string, unknown>] = [
      "item",
      { itemId: "commentary-0-c3", kind: "preamble", title: "Preamble", phase: "end" },
    ];
    const before = [...start, ...said("m:1", "All clean."), bare];
    for (const html of [
      draw(transcriptOf(before)),
      draw(transcriptOf([...before, ...call("c1")])),
    ]) {
      expect(count(html, "All clean.")).toBe(1);
      expect(html).not.toMatch(/<div class="bubble"[^>]*>\s*<\/div>/);
      expect(count(html, 'class="bubble"')).toBe(count(html, "All clean."));
    }
  });
});

// The reply's own row in history while the run still draws it (#872, #738): known by where it
// stands after a call this client saw start, or after the run's own start, never by its words.
describe("#872: a reply history already holds is drawn once while its run goes on", () => {
  const user = {
    role: "user",
    content: "Look for my old notes.",
    __openclaw: { id: "u1", seq: 1 },
  };
  const row = (
    id: string,
    seq: number,
    content: unknown[],
    extra: Record<string, unknown> = {},
  ) => ({
    role: "assistant",
    content,
    ...extra,
    __openclaw: { id, seq, runId: RUN },
  });
  const text = (value: string) => ({ type: "text", text: value });
  const toolCall = (id: string) => ({ type: "toolCall", id, name: "ls", arguments: { path: "." } });
  /** The run keyed to the person's row, as this client's own message is once history holds it. */
  const keyed = (transcript: Transcript): Transcript => ({
    ...transcript,
    runs: transcript.runs.map((run) => ({
      ...run,
      anchorItemId: transcript.items[0]!.id,
      anchorKeyed: true as const,
    })),
  });
  const model: Array<[string, Record<string, unknown>]> = [["lifecycle", { phase: "model" }]];

  it("a plain answer whose row history holds is drawn once, as the reply", () => {
    const answer = "Your notes are in the drawer.";
    const html = draw(
      keyed(transcriptOf([...start, ...said("m:0", answer)], [user, row("a1", 2, [text(answer)])])),
    );
    expect(count(html, answer)).toBe(1);
    expect(html).toContain('data-testid="live-turn"');
  });

  it("a later item's reply leaves the earlier text history holds where it was read", () => {
    // Two texts after one call: the second is not the first to begin after it, so the first's
    // row is not taken for the reply's.
    const html = draw(
      transcriptOf(
        [...start, ...call("c1"), ...said("m:1", "The listing is in."), ...said("m:2", "Done.")],
        [user, row("a1", 2, [toolCall("c1")]), row("a2", 4, [text("The listing is in.")])],
      ),
    );
    expect(count(html, "The listing is in.")).toBe(1);
    expect(count(html, "Done.")).toBe(1);
  });

  it("a reply with the words of the text beside its call is drawn twice: once beside, once as the reply", () => {
    const words = "Checking logs.";
    const html = draw(
      transcriptOf(
        [...start, ...said("m:1", words), ...call("c1"), ...said("m:2", words)],
        [user, row("a1", 2, [text(words), toolCall("c1")]), row("a2", 4, [text(words)])],
      ),
    );
    expect(count(html, words)).toBe(2);
  });

  it("a row the gateway wrote itself after the call is not the reply's: both are drawn", () => {
    // A delivery's mirror, never streamed, may stand after the call before the reply's row is.
    const mirror = row("a2", 4, [text("Sent to the team channel.")], {
      provider: "openclaw",
      model: "delivery-mirror",
    });
    const html = draw(
      transcriptOf(
        [...start, ...call("c1"), ...said("m:1", "I told the team.")],
        [user, row("a1", 2, [toolCall("c1")]), mirror],
      ),
    );
    expect(count(html, "Sent to the team channel.")).toBe(1);
    expect(count(html, "I told the team.")).toBe(1);
  });

  it("after a read that subscribes again, the reply history holds is drawn twice until the run ends", () => {
    // A client that was away may have missed an item since the call: the row can't be tied.
    // Pinned, so that changing it is deliberate.
    const reply = "Both logs are clean.";
    const before = transcriptOf(
      [...start, ...call("c1"), ...said("m:1", reply)],
      [user, row("a1", 2, [toolCall("c1")]), row("a2", 4, [text(reply)])],
    );
    const html = draw({ ...before, runs: before.runs.map(unfollowed) });
    expect(count(html, reply)).toBe(2);
    expect(html).toContain('data-testid="live-turn"');
  });

  it("a history row is given up only where the live reply shows the same words", () => {
    const long = `First I read every log. ${"Line by line, before I answer. ".repeat(90)}The end.`;
    const arrangements: Array<[Array<[string, Record<string, unknown>]>, unknown[]]> = [
      // The reply after a call, in a message of its own: given up.
      [
        [...start, ...call("c1"), ...said("m:1", "Clean.")],
        [user, row("a1", 2, [toolCall("c1")]), row("a2", 4, [text("Clean.")])],
      ],
      // Text after the call in the call's own row, the next message streaming: kept.
      [
        [...start, ...said("m:1", `${long}\n\nShort.`), ...call("c1"), ...said("m:2", "Next.")],
        [user, row("a1", 2, [text(long), toolCall("c1"), text("Short.")])],
      ],
      // The reply's row not written yet, an earlier text after the call there: kept.
      [
        [...start, ...call("c1"), ...said("m:1", "Reading."), ...said("m:2", "Done.")],
        [user, row("a1", 2, [toolCall("c1")]), row("a2", 4, [text("Reading.")])],
      ],
      // A plain answer whose row is written: given up.
      [
        [...start, ...said("m:0", "All clean.")],
        [user, row("a1", 2, [text("All clean.")])],
      ],
    ];
    const given = arrangements.map(([events, rows]) => {
      const transcript = keyed(transcriptOf(events, rows));
      const run = transcript.runs[0]!;
      const tied = replyRow(run, transcript.items);
      if (!tied) return null;
      const block = transcript.items.find((item) => item.id === tied.itemId)!.blocks[tied.block]!;
      return block.kind === "text" && run.text.includes(block.text.trim());
    });
    expect(given).toEqual([true, null, null, true]);
  });

  it("text after the call in the call's own row stays when the next message streams", () => {
    // Long text, a call, then short text, in one message: the text beside the call is cut to its
    // bound, so the short text is on screen only from history. The next message's item is the
    // first since the call, and the short text is the first after the call's block, but in the
    // call's own row: not the next message's.
    const long = `First I read every log. ${"Line by line, before I answer. ".repeat(90)}The end.`;
    const short = "One more look at the cache.";
    const html = draw(
      transcriptOf(
        [...start, ...said("m:1", `${long}\n\n${short}`), ...call("c1"), ...said("m:2", "Next.")],
        [user, row("a1", 2, [text(long), toolCall("c1"), text(short)])],
      ),
    );
    expect(count(html, short)).toBe(1);
    expect(count(html, "Next.")).toBe(1);
  });

  it("the gateway's placeholder for a message too large is never taken for the reply's row", () => {
    const placeholder = {
      role: "assistant",
      content: [{ type: "text", text: "[chat.history omitted: message too large]" }],
      __openclaw: { id: "a2", seq: 4, runId: RUN, truncated: true, reason: "oversized" },
    };
    const html = draw(
      transcriptOf(
        [...start, ...call("c1"), ...said("m:1", "A very long answer.")],
        [user, row("a1", 2, [toolCall("c1")]), placeholder],
      ),
    );
    expect(count(html, "[chat.history omitted: message too large]")).toBe(1);
    expect(count(html, "A very long answer.")).toBe(1);
  });

  it("a history row that belongs to no run the transcript knows is drawn as it is", () => {
    // A page that starts with a bot's row: no person's row before it, no call of a known run.
    const html = draw(
      transcriptOf(
        [...start, ...call("c1"), ...said("m:1", "All clean.")],
        [
          {
            role: "assistant",
            content: [text("An older note.")],
            __openclaw: { id: "a0", seq: 1 },
          },
          user,
          row("a1", 2, [toolCall("c1")]),
        ],
      ),
    );
    expect(count(html, "An older note.")).toBe(1);
    expect(count(html, "All clean.")).toBe(1);
  });

  it("#738: text in a message before a steer, its action in the next message with no text, is drawn once", () => {
    const note = "The logs are clean.";
    const steer = {
      role: "user",
      content: "Also list the cache.",
      __openclaw: { id: "u2", seq: 3 },
    };
    const html = draw(
      keyed(
        transcriptOf(
          [...start, ...said("m:0", note), ...model, ...call("c2")],
          [user, row("a1", 2, [text(note)]), steer, row("a2", 4, [toolCall("c2")])],
        ),
      ),
    );
    expect(count(html, note)).toBe(1);
    expect(html).toContain('data-testid="live-turn"');
  });
});
