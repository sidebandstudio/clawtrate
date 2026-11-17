// Reasoning identity (ruling 2) and live/history equivalence (ruling 3).
//
// Promised: a segment never overwrites another, whatever its length, since
// continuation is decided from the whole earlier text's length and digest; a
// step id is never used twice in a task for the life of the client; and ids
// are stable while the task stays open, across live streaming and any number
// of resyncs of the same window. Not promised: that a reasoning step keeps its
// id after the task is closed and reopened from a different window of history.
// So live state, a fresh rebuild and two resyncs are compared on the same
// steps in the same order with the same gateway-established fields and raw
// contents; ids are compared within a session only.

import { beforeEach, describe, expect, it } from "vitest";
import { applyApprovalRequested, normalizeApprovals, parseExecApproval } from "../src/approvals.ts";
import {
  applyAgentEvent,
  applyQuestionRequested,
  emptyActivity,
  MAX_STEPS_PER_RUN,
  mergeHistoryRuns,
  RawTable,
  retainActivity,
  runsFromHistory,
  type EngineContext,
  type StepRaw,
  type TaskActivity,
} from "../src/runs.ts";
import { agentEvent, grantingGateway, KEY, openTask, questionRecord } from "./client-harness.ts";
import { until } from "./fake-gateway.ts";

let raw: RawTable;
const ctx = (table = raw, ids?: { next(): number }): EngineContext => ({
  sessionKey: KEY,
  now: 5_000,
  raw: table,
  ...(ids ? { ids } : {}),
});
beforeEach(() => {
  raw = new RawTable();
});

const thinking = (seq: number, text: string, runId = "r") =>
  agentEvent(runId, seq, "thinking", { text, delta: text });

function feed(
  activity: TaskActivity,
  events: Array<ReturnType<typeof agentEvent>>,
  table = raw,
  ids?: { next(): number },
) {
  let next = activity;
  for (const event of events) {
    next = retainActivity(
      normalizeApprovals(applyAgentEvent(next, event, ctx(table, ids)).activity),
    );
  }
  return next;
}

const thinkingRow = (text: string, seq = 1, extra: unknown[] = [], runId = "r") => ({
  role: "assistant",
  content: [{ type: "thinking", thinking: text }, ...extra],
  __openclaw: { id: `a${seq}`, seq, runId },
});

/** What the gateway establishes about a raw payload, live (an event) or from history (a row). */
function rawFacts(entry: StepRaw | null) {
  if (!entry) return null;
  const call = (entry.call ?? null) as Record<string, unknown> | null;
  const result = (entry.result ?? null) as Record<string, unknown> | null;
  const data = (call?.data ?? call) as Record<string, unknown> | null;
  const text = (value: unknown) =>
    Array.isArray(value)
      ? value.map((part) => (part as { text?: string }).text ?? "").join("")
      : typeof value === "string"
        ? value
        : null;
  const resultBody = (result?.result ?? result) as Record<string, unknown> | null;
  return {
    thinking: call?.type === "thinking" ? call.thinking : (data?.text ?? null),
    name: data?.name ?? null,
    args: data?.args ?? data?.arguments ?? null,
    result: result ? { isError: result.isError === true, text: text(resultBody?.content) } : null,
  };
}

/** The steps' gateway-established fields and raw contents, in order; source tags, timestamps and ids left out. */
function facts(activity: TaskActivity, table: RawTable) {
  return activity.runs.map((run) => ({
    id: run.id,
    state: run.state,
    outcomeKnown: run.outcomeKnown,
    steps: run.steps.map((step) => ({
      kind: step.kind,
      status: step.status,
      title: step.title,
      toolName: step.toolName,
      toolCallId: step.toolCallId,
      argsText: step.argsText,
      output: step.kind === "reasoning" ? step.output : null,
      result: step.result,
      error: step.error,
      approvalId: step.approvalId,
      continuation: step.continuation,
      raw: rawFacts(table.get(KEY, step.id)),
    })),
  }));
}

const ids = (activity: TaskActivity) => activity.runs.flatMap((run) => run.steps.map((s) => s.id));

/** The same history read again: rebuilt aside, merged by run and step id, raw payloads carried over. */
function resync(
  activity: TaskActivity,
  rows: unknown[],
  inFlight: Record<string, unknown> | null,
  table: RawTable,
) {
  const scratch = new RawTable();
  const merge = mergeHistoryRuns(
    activity.runs,
    runsFromHistory(rows, inFlight, ctx(scratch)),
    ctx(table),
  );
  for (const [stepId, source] of merge.fromHistory) {
    const payload = scratch.get(KEY, source);
    if (payload) table.set(KEY, stepId, payload);
  }
  return retainActivity(normalizeApprovals({ ...activity, runs: merge.runs }));
}

describe("a restart is a new segment however long the earlier one (A4, B1)", () => {
  it("short: a fresh opening then a frame that does not extend it", () => {
    const fresh = runsFromHistory([thinkingRow("abc")], { runId: "r" }, ctx());
    const after = feed({ ...emptyActivity, runs: fresh }, [thinking(3, "xyz")]);
    const liveTable = new RawTable();
    const live = feed(emptyActivity, [thinking(1, "abc"), thinking(3, "xyz")], liveTable);
    expect(facts(after, raw)).toEqual(facts(live, liveTable));
    expect(after.runs[0]!.steps.map((step) => [step.status, step.output?.text])).toEqual([
      ["done", "abc"],
      ["running", "xyz"],
    ]);
  });

  const prefix = "p".repeat(16_000);
  const before = `${prefix}abc`;
  const restarted = `${prefix}xyz`;

  it("past the displayed prefix: live keeps the earlier segment and its raw call", () => {
    const live = feed(emptyActivity, [thinking(1, before), thinking(2, restarted)]);
    const steps = live.runs[0]!.steps;
    expect(steps.map((step) => [step.id, step.status])).toEqual([
      ["reasoning:r:0", "done"],
      ["reasoning:r:1", "running"],
    ]);
    expect((raw.get(KEY, "reasoning:r:0")!.call as { data: { text: string } }).data.text).toBe(
      before,
    );
    expect((raw.get(KEY, "reasoning:r:1")!.call as { data: { text: string } }).data.text).toBe(
      restarted,
    );
    expect(steps[0]!.continuation).toMatchObject({ length: before.length });
  });

  it("past the displayed prefix: live, a fresh opening and a rebuild of both rows agree", () => {
    const liveTable = new RawTable();
    const live = feed(emptyActivity, [thinking(1, before), thinking(2, restarted)], liveTable);
    const fresh = feed(
      { ...emptyActivity, runs: runsFromHistory([thinkingRow(before)], { runId: "r" }, ctx()) },
      [thinking(2, restarted)],
    );
    const historyTable = new RawTable();
    const history = {
      ...emptyActivity,
      runs: runsFromHistory(
        [thinkingRow(before, 1), thinkingRow(restarted, 2)],
        { runId: "r" },
        ctx(historyTable),
      ),
    };
    expect(facts(fresh, raw).map((run) => run.steps.map((step) => step.status))).toEqual([
      ["done", "running"],
    ]);
    // The same segments, in order, with the same whole-text evidence and raw text.
    const segments = (activity: TaskActivity, table: RawTable) =>
      facts(activity, table)[0]!.steps.map((step) => ({
        continuation: step.continuation,
        thinking: step.raw?.thinking,
      }));
    expect(segments(fresh, raw)).toEqual(segments(live, liveTable));
    expect(segments(history, historyTable)).toEqual(segments(live, liveTable));
  });

  it("past the displayed prefix: a frame that extends it continues the one segment", () => {
    const live = feed(emptyActivity, [thinking(1, before), thinking(2, `${before}d`)]);
    expect(live.runs[0]!.steps).toHaveLength(1);
    expect(live.runs[0]!.steps[0]!.continuation).toMatchObject({ length: before.length + 1 });
  });

  it("a segment with no evidence is never assumed to continue on a cumulative frame", () => {
    const fresh = runsFromHistory([thinkingRow("abc")], { runId: "r" }, ctx());
    const unknown = {
      ...fresh[0]!,
      steps: [{ ...fresh[0]!.steps[0]!, continuation: null }],
    };
    const after = feed({ ...emptyActivity, runs: [unknown] }, [thinking(3, "abcd")]);
    expect(after.runs[0]!.steps).toHaveLength(2);
  });
});

describe("a step id is never used twice (B2)", () => {
  function segments(count: number, allocator?: { next(): number }) {
    const events: Array<ReturnType<typeof agentEvent>> = [];
    let seq = 0;
    for (let i = 0; i < count; i += 1) {
      events.push(thinking((seq += 1), `segment${i}`));
      events.push(agentEvent("r", (seq += 1), "lifecycle", { phase: "model" }));
    }
    return feed(emptyActivity, events, raw, allocator);
  }

  it.each([MAX_STEPS_PER_RUN, MAX_STEPS_PER_RUN + 1, MAX_STEPS_PER_RUN + 2])(
    "after %i segments, retention drops the oldest without renumbering any",
    (count) => {
      const run = segments(count).runs[0]!;
      const all = run.steps.map((step) => step.id);
      expect(new Set(all).size).toBe(all.length);
      expect(run.omittedSteps).toBe(count - MAX_STEPS_PER_RUN);
      expect(all.at(-1)).toBe(`reasoning:r:${count - 1}`);
      expect(raw.get(KEY, `reasoning:r:${count - 1}`)!.call).toMatchObject({
        data: { text: `segment${count - 1}` },
      });
    },
  );

  it("through the client: a reopen from a cut history page reuses no id, and the next segment takes a new one", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.history"] = () => ({ messages: [], inFlightRun: { runId: "r" } });
    const { client, transcript } = await openTask({ gateway });
    const seen = new Set<string>();
    const note = () => {
      for (const id of ids(transcript())) seen.add(id);
    };
    let seq = 0;
    for (let i = 0; i < 3; i += 1) {
      gateway.emit("agent", agentEvent("r", (seq += 1), "thinking", { text: `segment-${i}` }));
      if (i < 2)
        gateway.emit("agent", agentEvent("r", (seq += 1), "lifecycle", { phase: "model" }));
    }
    await until(() => transcript().runs[0]?.steps.length === 3);
    note();
    const live = ids(transcript());
    // Resyncs of the same window keep every id.
    for (let i = 0; i < 2; i += 1) {
      const before = gateway.calls("chat.history").length;
      gateway.emit("session.message", { sessionKey: KEY });
      await until(() => gateway.calls("chat.history").length === before + 1);
      await until(() => transcript().status === "ready");
    }
    expect(ids(transcript())).toEqual(live);
    // Closed and reopened from a page whose start is cut: only the last segment's row remains.
    client.closeSession(KEY);
    gateway.handlers["chat.history"] = () => ({
      messages: [thinkingRow("segment-2", 41)],
      inFlightRun: { runId: "r" },
      hasMore: true,
    });
    client.openSession(KEY);
    await until(() => transcript()?.status === "ready" && transcript().runs.length === 1);
    const reopened = ids(transcript());
    expect(reopened).toEqual(["reasoning:r:ha41.0"]);
    for (const id of reopened) expect(live).not.toContain(id);
    note();
    // The next segment takes an id never used in this task.
    gateway.emit("agent", agentEvent("r", (seq += 1), "lifecycle", { phase: "model" }));
    gateway.emit("agent", agentEvent("r", seq + 1, "thinking", { text: "segment-3" }));
    await until(() => transcript().runs[0]!.steps.length === 2);
    const next = transcript().runs[0]!.steps.at(-1)!.id;
    expect(seen.has(next)).toBe(false);
    expect(client.stepRaw(KEY, next)!.call).toMatchObject({ data: { text: "segment-3" } });
    // A resync of this window keeps them too.
    const after = ids(transcript());
    const reads = gateway.calls("chat.history").length;
    gateway.emit("session.message", { sessionKey: KEY });
    await until(() => gateway.calls("chat.history").length === reads + 1);
    await until(() => transcript().status === "ready");
    expect(ids(transcript())).toEqual(after);
    client.stop();
  });
});

describe("live, fresh rebuild and two resyncs agree on what is promised (A6, ruling 3)", () => {
  const approval = parseExecApproval({
    id: "ap-1",
    request: {
      command: "rm -rf cache",
      sessionKey: KEY,
      runId: "r",
      toolCallId: "c2",
      allowedDecisions: ["allow-once", "deny"],
    },
    createdAtMs: 1,
    expiresAtMs: 9_000_000_000_000,
  })!;
  const question = questionRecord("ask_1", "r");
  const prefix = "q".repeat(16_000);
  const args = (id: string) => ({ path: id });
  const toolResult = (id: string) => ({
    phase: "result",
    name: "ls",
    toolCallId: id,
    isError: false,
    result: { content: [{ type: "text", text: "ok" }], details: {} },
  });
  const liveEvents = [
    agentEvent("r", 1, "lifecycle", { phase: "start" }),
    thinking(2, "first"),
    agentEvent("r", 3, "tool", { phase: "start", name: "ls", toolCallId: "c1", args: args("c1") }),
    agentEvent("r", 4, "tool", toolResult("c1")),
    agentEvent("r", 5, "lifecycle", { phase: "model" }),
    // A long segment, then a restart that shares its displayed prefix.
    thinking(6, `${prefix}second`),
    thinking(7, `${prefix}restart`),
    agentEvent("r", 8, "tool", { phase: "start", name: "rm", toolCallId: "c2", args: args("c2") }),
    agentEvent("r", 9, "lifecycle", { phase: "model" }),
    thinking(10, "fourth"),
  ];
  const rows = [
    { role: "user", content: "Clean up", __openclaw: { id: "u0", seq: 0 } },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "first" },
        { type: "toolCall", id: "c1", name: "ls", arguments: args("c1") },
      ],
      __openclaw: { id: "a1", seq: 1, runId: "r" },
    },
    {
      role: "toolResult",
      toolCallId: "c1",
      isError: false,
      content: [{ type: "text", text: "ok" }],
      __openclaw: { id: "t1", seq: 2, runId: "r" },
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: `${prefix}second` },
        { type: "thinking", thinking: `${prefix}restart` },
        { type: "toolCall", id: "c2", name: "rm", arguments: args("c2") },
      ],
      __openclaw: { id: "a2", seq: 3, runId: "r" },
    },
    thinkingRow("fourth", 4),
  ];
  const snapshot = { runId: "r", events: liveEvents.filter((event) => event.stream === "tool") };
  const withCards = (activity: TaskActivity, table: RawTable) =>
    normalizeApprovals(
      applyApprovalRequested(applyQuestionRequested(activity, question, ctx(table)), approval),
    );
  const cards = (activity: TaskActivity) => ({
    questions: activity.questions.map((each) => [each.id, each.status, each.runId]),
    approvals: activity.approvals.map((each) => [each.id, each.status, each.stepId]),
  });

  it("while reasoning still streams, and after the next frame", () => {
    let n = 0;
    const allocator = { next: () => n++ };
    const liveTable = new RawTable();
    const live = withCards(feed(emptyActivity, liveEvents, liveTable, allocator), liveTable);
    const freshTable = new RawTable();
    const fresh = withCards(
      { ...emptyActivity, runs: runsFromHistory(rows, snapshot, ctx(freshTable)) },
      freshTable,
    );
    const liveOnce = resync(live, rows, snapshot, liveTable);
    const liveTwice = resync(liveOnce, rows, snapshot, liveTable);
    const freshOnce = resync(fresh, rows, snapshot, freshTable);
    const freshTwice = resync(freshOnce, rows, snapshot, freshTable);
    // The same steps, in order, with the same established fields and raw contents.
    for (const [activity, table] of [
      [fresh, freshTable],
      [liveOnce, liveTable],
      [liveTwice, liveTable],
      [freshOnce, freshTable],
      [freshTwice, freshTable],
    ] as const) {
      expect(facts(activity, table)).toEqual(facts(live, liveTable));
      expect(cards(activity)).toEqual(cards(live));
    }
    expect(live.runs[0]!.steps.map((step) => [step.kind, step.status])).toEqual([
      ["reasoning", "done"],
      ["tool", "done"],
      ["reasoning", "done"],
      ["reasoning", "done"],
      ["tool", "waiting"],
      ["reasoning", "running"],
    ]);
    // Ids are stable within a session.
    expect(ids(liveTwice)).toEqual(ids(live));
    expect(ids(freshTwice)).toEqual(ids(fresh));
    // The next frame continues the streaming segment in both sessions alike.
    const nextLive = feed(liveTwice, [thinking(11, "fourth, more")], liveTable, allocator);
    const nextFresh = feed(freshTwice, [thinking(11, "fourth, more")], freshTable, allocator);
    expect(facts(nextFresh, freshTable)).toEqual(facts(nextLive, liveTable));
    expect(ids(nextLive)).toEqual(ids(live));
  });

  it("once the run has finished, history's copy settles both sessions alike, ids kept within each", () => {
    const finishedRows = [
      ...rows.slice(0, -1),
      {
        role: "toolResult",
        toolCallId: "c2",
        isError: false,
        content: [{ type: "text", text: "ok" }],
        __openclaw: { id: "t2", seq: 4, runId: "r" },
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "fourth" },
          { type: "text", text: "Done" },
        ],
        stopReason: "stop",
        __openclaw: { id: "a4", seq: 5, runId: "r" },
      },
    ];
    let n = 0;
    const allocator = { next: () => n++ };
    const liveTable = new RawTable();
    const live = feed(
      emptyActivity,
      [
        ...liveEvents,
        agentEvent("r", 11, "tool", { ...toolResult("c2"), name: "rm" }),
        agentEvent("r", 12, "assistant", { text: "Done" }),
        agentEvent("r", 13, "lifecycle", { phase: "end" }),
      ],
      liveTable,
      allocator,
    );
    const liveIds = ids(live);
    const once = resync(live, finishedRows, null, liveTable);
    const twice = resync(once, finishedRows, null, liveTable);
    const freshTable = new RawTable();
    const fresh = {
      ...emptyActivity,
      runs: runsFromHistory(finishedRows, null, ctx(freshTable)),
    };
    const freshTwice = resync(
      resync(fresh, finishedRows, null, freshTable),
      finishedRows,
      null,
      freshTable,
    );
    expect(ids(once)).toEqual(liveIds);
    expect(ids(twice)).toEqual(liveIds);
    expect(ids(freshTwice)).toEqual(ids(fresh));
    // The raw facts themselves, reasoning text included.
    expect(facts(twice, liveTable)).toEqual(facts(freshTwice, freshTable));
    const thinkingOf = (activity: TaskActivity, table: RawTable) =>
      activity.runs[0]!.steps.filter((step) => step.kind === "reasoning").map(
        (step) => rawFacts(table.get(KEY, step.id))?.thinking,
      );
    expect(thinkingOf(twice, liveTable)).toEqual([
      "first",
      `${prefix}second`,
      `${prefix}restart`,
      "fourth",
    ]);
    expect(thinkingOf(freshTwice, freshTable)).toEqual(thinkingOf(twice, liveTable));
    expect(twice.runs[0]).toMatchObject({ state: "completed", outcomeKnown: true });
  });

  it("repeated reasoning text pairs in order, and a resync never moves an id to another segment", () => {
    let n = 0;
    const allocator = { next: () => n++ };
    const liveTable = new RawTable();
    const live = feed(
      emptyActivity,
      [thinking(1, "abc"), agentEvent("r", 2, "lifecycle", { phase: "model" }), thinking(3, "abc")],
      liveTable,
      allocator,
    );
    // The first segment's last character never reached the live view.
    const repeatRows = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "abcd" },
          { type: "thinking", thinking: "abc" },
        ],
        stopReason: "stop",
        __openclaw: { id: "a1", seq: 1, runId: "r" },
      },
    ];
    const once = resync(live, repeatRows, null, liveTable);
    const twice = resync(once, repeatRows, null, liveTable);
    const freshTable = new RawTable();
    const fresh = { ...emptyActivity, runs: runsFromHistory(repeatRows, null, ctx(freshTable)) };
    const freshTwice = resync(
      resync(fresh, repeatRows, null, freshTable),
      repeatRows,
      null,
      freshTable,
    );
    expect(ids(live)).toEqual(["reasoning:r:0", "reasoning:r:1"]);
    expect(ids(once)).toEqual(ids(live));
    expect(ids(twice)).toEqual(ids(live));
    expect(ids(freshTwice)).toEqual(ids(fresh));
    // Each id keeps its own segment's text, read raw.
    const thinkingById = (activity: TaskActivity, table: RawTable) =>
      activity.runs[0]!.steps.map((step) => [step.id, rawFacts(table.get(KEY, step.id))?.thinking]);
    expect(thinkingById(twice, liveTable)).toEqual([
      ["reasoning:r:0", "abcd"],
      ["reasoning:r:1", "abc"],
    ]);
    expect(facts(twice, liveTable)).toEqual(facts(freshTwice, freshTable));
  });

  it("after retention dropped the oldest steps, a resync drops the same ones again", () => {
    const many = [
      agentEvent("r", 1, "lifecycle", { phase: "start" }),
      ...Array.from({ length: MAX_STEPS_PER_RUN + 4 }, (_, i) => [
        agentEvent("r", 2 + i * 2, "tool", {
          phase: "start",
          name: "ls",
          toolCallId: `m${i}`,
          args: args(`m${i}`),
        }),
        agentEvent("r", 3 + i * 2, "tool", toolResult(`m${i}`)),
      ]).flat(),
    ];
    const manyRows = [
      { role: "user", content: "Look", __openclaw: { id: "u0", seq: 0 } },
      ...Array.from({ length: MAX_STEPS_PER_RUN + 4 }, (_, i) => [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: `m${i}`, name: "ls", arguments: args(`m${i}`) }],
          __openclaw: { id: `a${i}`, seq: 1 + i * 2, runId: "r" },
        },
        {
          role: "toolResult",
          toolCallId: `m${i}`,
          isError: false,
          content: [{ type: "text", text: "ok" }],
          __openclaw: { id: `t${i}`, seq: 2 + i * 2, runId: "r" },
        },
      ]).flat(),
    ];
    const table = new RawTable();
    const streamed = feed(emptyActivity, many, table);
    const once = resync(streamed, manyRows, { runId: "r" }, table);
    const twice = resync(once, manyRows, { runId: "r" }, table);
    const fresh = retainActivity({
      ...emptyActivity,
      runs: runsFromHistory(manyRows, { runId: "r" }, ctx(new RawTable())),
    });
    expect(streamed.runs[0]!.omittedSteps).toBe(4);
    for (const each of [once, twice, fresh]) {
      expect(ids(each)).toEqual(ids(streamed));
      expect(each.runs[0]!.omittedSteps).toBe(4);
    }
  });
});
