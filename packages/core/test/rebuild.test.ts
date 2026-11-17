// A task rebuilt from history equals the same task followed live: the
// reasoning segment streaming at the moment of a fresh opening stays one
// segment, the in-flight snapshot's progress joins the persisted rows, and the
// same history or snapshot applied twice changes nothing.

import { beforeEach, describe, expect, it } from "vitest";
import {
  applyAgentEvent,
  emptyActivity,
  mergeHistoryRuns,
  RawTable,
  runsFromHistory,
  type EngineContext,
  type Run,
  type TaskActivity,
} from "../src/runs.ts";
import { agentEvent, grantingGateway, KEY, openTask } from "./client-harness.ts";
import { until } from "./fake-gateway.ts";

let raw: RawTable;
const ctx = (): EngineContext => ({ sessionKey: KEY, now: 5_000, raw });
beforeEach(() => {
  raw = new RawTable();
});

function feed(activity: TaskActivity, ...events: Array<ReturnType<typeof agentEvent>>) {
  let next = activity;
  for (const event of events) next = applyAgentEvent(next, event, ctx()).activity;
  return next;
}

/** What a view shows of a run's steps. */
const shape = (run: Run | undefined) =>
  run?.steps.map((step) => ({
    id: step.id,
    kind: step.kind,
    status: step.status,
    text: step.output?.text ?? step.result?.text ?? null,
  }));

const thinkingRow = (text: string, seq: number, extra: unknown[] = []) => ({
  role: "assistant",
  content: [{ type: "thinking", thinking: text }, ...extra],
  __openclaw: { id: `a${seq}`, seq, runId: "run-1" },
});

describe("a fresh opening during a reasoning segment (C6)", () => {
  it("keeps the streaming segment open, so the next cumulative frame continues it", () => {
    const fresh = runsFromHistory([thinkingRow("abc", 2)], { runId: "run-1" }, ctx());
    expect(shape(fresh[0])).toEqual([
      { id: "reasoning:run-1:0", kind: "reasoning", status: "running", text: "abc" },
    ]);
    const after = feed(
      { ...emptyActivity, runs: fresh },
      agentEvent("run-1", 5, "thinking", { text: "abcd", delta: "d" }),
    );
    // As the live view has it: one segment.
    const live = feed(
      emptyActivity,
      agentEvent("run-1", 1, "lifecycle", { phase: "start" }),
      agentEvent("run-1", 2, "thinking", { text: "abc", delta: "abc" }),
      agentEvent("run-1", 5, "thinking", { text: "abcd", delta: "d" }),
    );
    expect(shape(after.runs[0])).toEqual(shape(live.runs[0]));
    expect(shape(after.runs[0])).toEqual([
      { id: "reasoning:run-1:0", kind: "reasoning", status: "running", text: "abcd" },
    ]);
    // The raw lookup follows the segment: the latest frame.
    expect(raw.get(KEY, "reasoning:run-1:0")!.call).toMatchObject({ data: { text: "abcd" } });
  });

  it("closes the segment when the rows already moved past it, as the live view does", () => {
    const fresh = runsFromHistory(
      [thinkingRow("abc", 2, [{ type: "text", text: "Here is the answer" }])],
      { runId: "run-1" },
      ctx(),
    );
    expect(fresh[0]!.steps[0]!.status).toBe("done");
    const after = feed(
      { ...emptyActivity, runs: fresh },
      agentEvent("run-1", 5, "thinking", { text: "next", delta: "next" }),
    );
    expect(after.runs[0]!.steps.map((step) => [step.id, step.status])).toEqual([
      ["reasoning:run-1:0", "done"],
      ["reasoning:run-1:1", "running"],
    ]);
  });

  it("through the client: a fresh opening then the next frame shows one segment and its raw frame", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.history"] = () => ({
      messages: [
        { role: "user", content: "Think", __openclaw: { id: "u1", seq: 1 } },
        thinkingRow("abc", 2),
      ],
      inFlightRun: { runId: "run-1" },
    });
    const { client, transcript } = await openTask({ gateway });
    expect(transcript().runs[0]!.steps.map((step) => [step.id, step.status])).toEqual([
      ["reasoning:run-1:0", "running"],
    ]);
    gateway.emit("agent", agentEvent("run-1", 5, "thinking", { text: "abcd", delta: "d" }));
    await until(() => transcript().runs[0]!.steps[0]!.output?.text === "abcd");
    expect(transcript().runs[0]!.steps).toHaveLength(1);
    expect(client.stepRaw(KEY, "reasoning:run-1:0")!.call).toMatchObject({
      data: { text: "abcd" },
    });
    // A resync while it streams keeps it one open segment.
    gateway.emit("session.message", { sessionKey: KEY });
    await until(() => gateway.calls("chat.history").length === 2);
    await until(() => transcript().status === "ready");
    gateway.emit("agent", agentEvent("run-1", 6, "thinking", { text: "abcde", delta: "e" }));
    await until(() => transcript().runs[0]!.steps[0]!.output?.text === "abcde");
    expect(transcript().runs[0]!.steps.map((step) => [step.id, step.status])).toEqual([
      ["reasoning:run-1:0", "running"],
    ]);
    client.stop();
  });
});

const toolCall = (id: string) => ({ type: "toolCall", id, name: "ls", arguments: { path: id } });
const toolResultRow = (id: string, seq: number, text = "ok") => ({
  role: "toolResult",
  toolCallId: id,
  isError: false,
  content: [{ type: "text", text }],
  __openclaw: { id: `t${seq}`, seq, runId: "run-1" },
});
const toolEvent = (
  seq: number,
  phase: string,
  id: string,
  extra: Record<string, unknown> = {},
) => ({
  runId: "run-1",
  seq,
  stream: "tool",
  ts: 1_000 + seq,
  data: { phase, name: "ls", toolCallId: id, args: { path: id }, ...extra },
});

describe("the in-flight snapshot joins the persisted rows (D2)", () => {
  const rows = [
    { role: "user", content: "Look around", __openclaw: { id: "u1", seq: 1 } },
    {
      role: "assistant",
      content: [{ type: "thinking", thinking: "first" }, toolCall("old-1")],
      __openclaw: { id: "a2", seq: 2, runId: "run-1" },
    },
    toolResultRow("old-1", 3),
    {
      role: "assistant",
      content: [{ type: "thinking", thinking: "second" }, toolCall("old-2")],
      __openclaw: { id: "a4", seq: 4, runId: "run-1" },
    },
    toolResultRow("old-2", 5),
  ];
  // The progress snapshot repeats the run's tool events, including persisted ones, and carries no thinking.
  const snapshot = {
    runId: "run-1",
    events: [
      toolEvent(3, "start", "old-1"),
      toolEvent(4, "result", "old-1", {
        isError: false,
        result: { content: [{ type: "text", text: "ok" }] },
      }),
      toolEvent(8, "start", "old-2"),
      toolEvent(9, "result", "old-2", {
        isError: false,
        result: { content: [{ type: "text", text: "ok" }] },
      }),
      toolEvent(12, "start", "new"),
    ],
  };

  it("shows the current step after the persisted iterations, without repeating any", () => {
    const fresh = runsFromHistory(rows, snapshot, ctx());
    expect(fresh[0]!.steps.map((step) => [step.id, step.status])).toEqual([
      ["reasoning:run-1:0", "done"],
      ["tool:old-1", "done"],
      ["reasoning:run-1:1", "done"],
      ["tool:old-2", "done"],
      ["tool:new", "running"],
    ]);
    expect(fresh[0]!.lastSeq).toBe(12);
  });

  it("applying the same snapshot twice equals once", () => {
    const once = runsFromHistory(rows, snapshot, ctx());
    const merged = mergeHistoryRuns(once, runsFromHistory(rows, snapshot, ctx()), ctx()).runs;
    expect(shape(merged[0])).toEqual(shape(once[0]));
    const again = mergeHistoryRuns(merged, runsFromHistory(rows, snapshot, ctx()), ctx()).runs;
    expect(again).toEqual(merged);
  });

  it("through the client: a long task opened mid-run shows its current step", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.history"] = () => ({ messages: rows, inFlightRun: snapshot });
    const { client, transcript } = await openTask({ gateway });
    expect(transcript().runs[0]!.steps.map((step) => step.id)).toEqual([
      "reasoning:run-1:0",
      "tool:old-1",
      "reasoning:run-1:1",
      "tool:old-2",
      "tool:new",
    ]);
    // A later frame for the current step lands on it.
    gateway.emit("agent", {
      ...toolEvent(13, "result", "new", {
        isError: false,
        result: { content: [{ type: "text", text: "done" }] },
      }),
      sessionKey: KEY,
    });
    await until(() => transcript().runs[0]!.steps.at(-1)!.status === "done");
    expect(transcript().runs[0]!.steps).toHaveLength(5);
    client.stop();
  });
});

describe("live and history agree on a finished multi-iteration run (D4 of the first review)", () => {
  const liveEvents = [
    agentEvent("run-1", 1, "lifecycle", { phase: "start" }),
    agentEvent("run-1", 2, "thinking", { text: "first", delta: "first" }),
    agentEvent("run-1", 3, "tool", {
      phase: "start",
      name: "ls",
      toolCallId: "c1",
      args: { path: "c1" },
    }),
    agentEvent("run-1", 4, "tool", {
      phase: "result",
      name: "ls",
      toolCallId: "c1",
      isError: false,
      result: { content: [{ type: "text", text: "ok" }], details: {} },
    }),
    agentEvent("run-1", 5, "lifecycle", { phase: "model" }),
    agentEvent("run-1", 6, "thinking", { text: "second", delta: "second" }),
    agentEvent("run-1", 7, "tool", {
      phase: "start",
      name: "ls",
      toolCallId: "c2",
      args: { path: "c2" },
    }),
    agentEvent("run-1", 8, "tool", {
      phase: "result",
      name: "ls",
      toolCallId: "c2",
      isError: true,
      result: { content: [{ type: "text", text: "denied" }], details: {} },
    }),
    agentEvent("run-1", 9, "assistant", { text: "Done", delta: "Done" }),
    agentEvent("run-1", 10, "lifecycle", { phase: "end" }),
  ];
  const historyRows = [
    { role: "user", content: "Go", __openclaw: { id: "u1", seq: 1 } },
    {
      role: "assistant",
      content: [{ type: "thinking", thinking: "first" }, toolCall("c1")],
      __openclaw: { id: "a2", seq: 2, runId: "run-1" },
    },
    toolResultRow("c1", 3),
    {
      role: "assistant",
      content: [{ type: "thinking", thinking: "second" }, toolCall("c2")],
      __openclaw: { id: "a4", seq: 4, runId: "run-1" },
    },
    { ...toolResultRow("c2", 5, "denied"), isError: true },
    {
      role: "assistant",
      content: [{ type: "text", text: "Done" }],
      stopReason: "stop",
      __openclaw: { id: "a6", seq: 6, runId: "run-1" },
    },
  ];

  it("a fresh rebuild, a live run merged with history, and a second resync agree step for step", () => {
    const live = feed(emptyActivity, ...liveEvents);
    const merge = mergeHistoryRuns(live.runs, runsFromHistory(historyRows, null, ctx()), ctx());
    const fresh = runsFromHistory(historyRows, null, ctx());
    expect(shape(merge.runs[0])).toEqual(shape(fresh[0]));
    expect(shape(fresh[0])).toEqual([
      { id: "reasoning:run-1:0", kind: "reasoning", status: "done", text: "first" },
      { id: "tool:c1", kind: "tool", status: "done", text: "ok" },
      { id: "reasoning:run-1:1", kind: "reasoning", status: "done", text: "second" },
      { id: "tool:c2", kind: "tool", status: "failed", text: "denied" },
    ]);
    expect(merge.runs[0]).toMatchObject({ state: "completed", outcomeKnown: true });
    expect(fresh[0]).toMatchObject({ state: "completed", outcomeKnown: true });
    // Every step the merge took from history brings its raw payload; none is missing.
    expect([...merge.fromHistory].sort()).toEqual(["reasoning:run-1:0", "reasoning:run-1:1"]);
    const twice = mergeHistoryRuns(merge.runs, runsFromHistory(historyRows, null, ctx()), ctx());
    expect(twice.runs).toEqual(merge.runs);
  });

  it("where history cannot say how the run ended, both say the outcome is unknown", () => {
    const unfinished = historyRows.slice(0, 3);
    const fresh = runsFromHistory(unfinished, null, ctx());
    expect(fresh[0]).toMatchObject({ state: "completed", outcomeKnown: false });
    const live = feed(emptyActivity, ...liveEvents.slice(0, 4));
    const merged = mergeHistoryRuns(live.runs, runsFromHistory(unfinished, null, ctx()), ctx());
    expect(merged.runs[0]).toMatchObject({ state: "completed", outcomeKnown: false });
  });
});
