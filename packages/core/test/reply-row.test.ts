// The reply's own row in history while its run is still drawn (#872, #738): known by where it
// stands after a call this connection saw start, or after the run's own start, never by its
// words. Every name and text is invented.

import { describe, expect, it } from "vitest";
import { mapHistory } from "../src/mapping.ts";
import { applyAgentEvent, emptyActivity, RawTable, replyRow, type Run } from "../src/runs.ts";
import { agentEvent, openTask, questionRecord } from "./client-harness.ts";
import { until } from "./fake-gateway.ts";

describe("what the stream was followed from is forgotten when frames may have been missed", () => {
  const followedRun = async () => {
    const opened = await openTask();
    const { gateway, transcript } = opened;
    const events = [
      agentEvent("run-9", 1, "lifecycle", { phase: "start", startedAt: 1_001 }),
      agentEvent("run-9", 2, "tool", {
        toolCallId: "c1",
        name: "ls",
        phase: "start",
        args: { path: "." },
      }),
      agentEvent("run-9", 3, "tool", {
        toolCallId: "c1",
        name: "ls",
        phase: "result",
        result: { content: [] },
      }),
      agentEvent("run-9", 4, "assistant", {
        text: "All clean.",
        delta: "All clean.",
        itemId: "s:2",
      }),
    ];
    for (const payload of events) gateway.emit("agent", payload);
    await until(() => transcript().runs[0]?.text === "All clean.");
    expect(transcript().runs[0]!.textAfter).toEqual({ call: "c1" });
    return opened;
  };

  it("a new connection forgets it at once, before the task is read again", async () => {
    const { client, gateway, transcript } = await followedRun();
    // The read the reconnect makes is not answered: what is forgotten is the hello's doing.
    gateway.handlers["chat.history"] = () => new Promise(() => {});
    gateway.dropAll();
    await until(() => client.state.connection.status === "connected");
    const run = transcript().runs[0]!;
    expect(run.text).toBe("All clean.");
    expect(run.followed).toBeUndefined();
    expect(run.textAfter).toBeUndefined();
    client.stop();
  });

  it("a run whose task was not open when its frames came is not followed when the task opens", async () => {
    const { client, gateway } = await openTask();
    const other = "agent:otto:other-task";
    const frames = [
      agentEvent("run-7", 1, "lifecycle", { phase: "start", startedAt: 1_001 }, other),
      agentEvent(
        "run-7",
        2,
        "assistant",
        { text: "Which one?", delta: "Which one?", itemId: "s:0" },
        other,
      ),
    ];
    for (const payload of frames) gateway.emit("agent", payload);
    // A run waiting on a question is the one a task carries when it opens.
    gateway.emit("question.requested", questionRecord("ask_1", "run-7", other));
    client.openSession(other);
    await until(() => client.state.transcripts[other]?.status === "ready");
    const run = client.state.transcripts[other]!.runs.find((each) => each.id === "run-7")!;
    expect(run.text).toBe("Which one?");
    expect(run.followed).toBeUndefined();
    expect(run.textAfter).toBeUndefined();
    client.stop();
  });
});

describe("replyRow: the row is the reply's only where nothing else can stand", () => {
  const RUN = "run-1";
  const KEY_ = "agent:otto:logs";
  /** The engine's run after these `agent` events. */
  const runOf = (events: Array<[string, Record<string, unknown>]>): Run => {
    const raw = new RawTable();
    let activity = emptyActivity;
    events.forEach(([stream, data], i) => {
      const payload = { runId: RUN, seq: i + 1, stream, ts: 1_000 + i, sessionKey: KEY_, data };
      activity = applyAgentEvent(activity, payload, { sessionKey: KEY_, now: 5_000, raw }).activity;
    });
    return activity.runs[0]!;
  };
  const start: [string, Record<string, unknown>] = ["lifecycle", { phase: "start" }];
  const tool = (id: string): Array<[string, Record<string, unknown>]> => [
    ["tool", { toolCallId: id, name: "ls", phase: "start", args: { path: "." } }],
    ["tool", { toolCallId: id, name: "ls", phase: "result", result: { content: [] } }],
  ];
  const said = (itemId: string, text: string): [string, Record<string, unknown>] => [
    "assistant",
    { text, delta: text, itemId },
  ];
  const user = { role: "user", content: "List the logs.", __openclaw: { id: "u1", seq: 1 } };
  const row = (id: string, seq: number, content: unknown[], runId: string | null = RUN) => ({
    role: "assistant",
    content,
    __openclaw: { id, seq, ...(runId ? { runId } : {}) },
  });
  const text = (value: string) => ({ type: "text", text: value });
  const call = (id: string) => ({ type: "toolCall", id, name: "ls", arguments: { path: "." } });

  it("the first text after the call's block, in the call's row or the next of its run", () => {
    const run = runOf([start, ...tool("c1"), said("s:1", "Clean.")]);
    const items = mapHistory([user, row("a1", 2, [call("c1")]), row("a2", 4, [text("Clean.")])]);
    expect(replyRow(run, items)).toEqual({ itemId: items[1]!.id, block: 1 });
  });

  it("another call's block before any text: none", () => {
    // The two calls of one message started in the other order from the one their row holds.
    const run = runOf([start, ...tool("c1"), said("s:1", "Clean.")]);
    const items = mapHistory([
      user,
      row("a1", 2, [call("c1"), call("c2")]),
      row("a2", 4, [text("Clean.")]),
    ]);
    expect(replyRow(run, items)).toBeNull();
  });

  it("a person's message between the call and the text (a steer): none", () => {
    const run = runOf([start, ...tool("c1"), said("s:1", "Clean.")]);
    const steer = { role: "user", content: "And the cache?", __openclaw: { id: "u2", seq: 3 } };
    const items = mapHistory([
      user,
      row("a1", 2, [call("c1")]),
      steer,
      row("a2", 4, [text("Clean.")]),
    ]);
    expect(replyRow(run, items)).toBeNull();
  });

  it("from the run's start, only after the person's row the run is keyed to", () => {
    const run = runOf([start, said("s:0", "Clean.")]);
    const items = mapHistory([user, row("a1", 2, [text("Clean.")])]);
    expect(replyRow({ ...run, anchorItemId: items[0]!.id, anchorKeyed: true }, items)).toEqual({
      itemId: items[1]!.id,
      block: 0,
    });
    // Drawn under that row only for want of a better place: not the row it came from.
    expect(replyRow({ ...run, anchorItemId: items[0]!.id }, items)).toBeNull();
  });

  it("a row that names no run after the person's row: none", () => {
    const run = runOf([start, said("s:0", "Clean.")]);
    const items = mapHistory([user, row("a1", 2, [text("A note the gateway added.")], null)]);
    expect(items[1]!.runless).toBe(true);
    expect(replyRow({ ...run, anchorItemId: items[0]!.id, anchorKeyed: true }, items)).toBeNull();
  });

  it("a call's second start frame does not count its items again", () => {
    // Both a `tool` start and an `item` start come for one call, in either order.
    const itemStart: [string, Record<string, unknown>] = [
      "item",
      { itemId: "tool:c1", toolCallId: "c1", name: "ls", kind: "tool", phase: "start" },
    ];
    const run = runOf([
      start,
      ...tool("c1"),
      said("s:1", "Reading."),
      itemStart,
      said("s:2", "Clean."),
    ]);
    expect(run.followed).toEqual({ call: "c1", items: 2 });
    expect(run.textAfter).toBeUndefined();
  });

  it("an item that was not the first since the call: none", () => {
    const run = runOf([start, ...tool("c1"), said("s:1", "Reading."), said("s:2", "Clean.")]);
    expect(run.textAfter).toBeUndefined();
    const items = mapHistory([user, row("a1", 2, [call("c1")]), row("a2", 4, [text("Reading.")])]);
    expect(replyRow(run, items)).toBeNull();
  });
});

// F-551's run (`#think #tool-fail`): reasoning, a failed read, then the answer in a message of its
// own, with each version's frames in the order a client watching the task received them on a
// development gateway, and the rows of the history read that held the answer while the run was
// still drawn. Ids and the workspace path are made up; the frames' other fields are as sent.
describe("F-551's run on each version: the answer's row is known while the run goes on", () => {
  const RUN = "run-551";
  const KEY_ = "agent:pip:old-notes";
  const ANSWER = "That file does not exist, so the step failed. I will carry on without it.";
  const BESIDE = "I thought it over first. This is the answer that follows the reasoning.";
  const play = (frames: Array<[number, string, Record<string, unknown>]>): Run => {
    const raw = new RawTable();
    let activity = emptyActivity;
    for (const [seq, stream, data] of frames) {
      const payload = { runId: RUN, seq, stream, ts: 1_000 + seq, sessionKey: KEY_, data };
      activity = applyAgentEvent(activity, payload, { sessionKey: KEY_, now: 5_000, raw }).activity;
    }
    return activity.runs[0]!;
  };
  const user = {
    role: "user",
    content: "Look for my old notes. #think #tool-fail",
    idempotencyKey: `${RUN}:user`,
    __openclaw: { id: "u-1", seq: 1, idempotencyKey: `${RUN}:user` },
  };
  const failed = {
    role: "toolResult",
    toolCallId: "call_read_1",
    toolName: "read",
    content: [{ type: "text", text: '{"status":"error","tool":"read","error":"File not found."}' }],
    isError: true,
    __openclaw: { id: "r-3", seq: 3, runId: RUN },
  };
  const answerRow = {
    role: "assistant",
    content: [{ type: "text", text: ANSWER }],
    api: "openai-completions",
    provider: "scripted",
    model: "dev-1",
    __openclaw: { id: "a-4", seq: 4, runId: RUN },
  };

  it("on 2026.11.10: one row holds the reasoning, the text beside the call and the call", () => {
    const stream = "5f0c2d8e-0000-4000-8000-00000000a11c";
    const run = play([
      [3, "lifecycle", { phase: "start", startedAt: 1_003 }],
      [5, "lifecycle", { phase: "model", provider: "scripted", model: "dev-1" }],
      [6, "thinking", { text: "The user wants", delta: "The user wants", itemId: "think-1" }],
      [
        10,
        "assistant",
        { text: "I thought it over", delta: "I thought it over", itemId: `${stream}:1` },
      ],
      [13, "assistant", { delta: BESIDE.slice("I thought it over".length), itemId: `${stream}:1` }],
      [
        18,
        "thinking",
        { phase: "persisted", itemId: "think-1", messageId: "a-2", messageRunId: RUN },
      ],
      [
        19,
        "item",
        {
          itemId: "tool:call_read_1",
          toolCallId: "call_read_1",
          name: "read",
          kind: "tool",
          phase: "start",
          title: "Read",
          status: "running",
        },
      ],
      [
        22,
        "item",
        {
          itemId: "tool:call_read_1",
          toolCallId: "call_read_1",
          name: "read",
          kind: "tool",
          phase: "end",
          title: "Read",
          status: "failed",
        },
      ],
      [23, "lifecycle", { phase: "model", provider: "scripted", model: "dev-1" }],
      [
        24,
        "assistant",
        { text: "That file does not", delta: "That file does not", itemId: `${stream}:2` },
      ],
      [
        27,
        "assistant",
        { delta: ANSWER.slice("That file does not".length), itemId: `${stream}:2` },
      ],
      [29, "lifecycle", { phase: "finishing", stopReason: "stop", aborted: false }],
    ]);
    expect(run.text).toBe(ANSWER);
    expect(run.textAfter).toEqual({ call: "call_read_1" });
    const items = mapHistory([
      user,
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "The user wants to see reasoning first." },
          { type: "text", text: BESIDE },
          { type: "thinking", thinking: "I will read my old notes. They may not exist." },
          {
            type: "toolCall",
            id: "call_read_1",
            name: "read",
            arguments: { path: "missing/old-notes.md" },
          },
        ],
        api: "openai-completions",
        provider: "scripted",
        model: "dev-1",
        __openclaw: { id: "a-2", seq: 2, runId: RUN },
      },
      failed,
      answerRow,
    ]);
    expect(replyRow(run, items)).toEqual({ itemId: items[1]!.id, block: 4 });
  });
});
