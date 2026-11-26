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

  it("history's row of the reply the engine still streams is drawn from history, and again as the reply until the run ends", () => {
    // No history row names an item of the stream, so the row can't be known as the reply being
    // drawn: it is shown, and the reply is doubled for as long as the run streams it. Pinned so
    // that hiding it again is a deliberate change.
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
    expect(count(html, "Both logs are clean.")).toBe(2);
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

  it("on 2026.10.6, an answer the person read stays when a steer's text comes only as a preamble item", () => {
    // A text-only answer, then a steer: the gateway asks the model again, and its text beside the
    // next call comes only as a preamble item. That item is not the answer's.
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
    ]) {
      expect(count(html, "The logs are clean.")).toBe(1);
      expect(count(html, note)).toBe(1);
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
