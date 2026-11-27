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
