// Reasoning identity and live/history equivalence.
//
// A reasoning step's id is a pure function of its place in its run: the run,
// the nearest tool call before it (or the run's start), and the count of
// reasoning blocks since. Live and history compute it alike, so nothing is
// matched. Promised: a segment never overwrites another, whatever its length;
// no id is used twice in a task; on a resync of the same window a card keeps
// its id whenever the blocks before it since its anchor are the same in
// number. Not promised: when history shows a block, since the same anchor,
// that the live stream never showed on its own, the cards after it there
// shift by one; nothing across a reopening or a different window.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
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
const ctx = (table = raw): EngineContext => ({ sessionKey: KEY, now: 5_000, raw: table });
beforeEach(() => {
  raw = new RawTable();
});

const thinking = (seq: number, text: string, runId = "r") =>
  agentEvent(runId, seq, "thinking", { text, delta: text });

function feed(activity: TaskActivity, events: Array<ReturnType<typeof agentEvent>>, table = raw) {
  let next = activity;
  for (const event of events) {
    next = retainActivity(normalizeApprovals(applyAgentEvent(next, event, ctx(table)).activity));
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
  for (const stepId of merge.fromHistory) {
    const payload = scratch.get(KEY, stepId);
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
      ["reasoning:r:s:0", "done"],
      ["reasoning:r:s:1", "running"],
    ]);
    expect((raw.get(KEY, "reasoning:r:s:0")!.call as { data: { text: string } }).data.text).toBe(
      before,
    );
    expect((raw.get(KEY, "reasoning:r:s:1")!.call as { data: { text: string } }).data.text).toBe(
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

describe("reasoning ids cannot collide, whatever characters the gateway's ids hold", () => {
  it("a run whose id holds the separator and another run's tool anchor give two ids", () => {
    // Run `r:t.c` at its start, and run `r` after tool `c:s`, both read `reasoning:r:t.c:s:0` unencoded.
    const first = feed(emptyActivity, [thinking(1, "at the start", "r:t.c")], raw);
    const second = feed(
      emptyActivity,
      [
        agentEvent("r", 1, "tool", { phase: "start", name: "read", toolCallId: "c:s", args: {} }),
        agentEvent("r", 2, "tool", {
          phase: "result",
          name: "read",
          toolCallId: "c:s",
          isError: false,
          result: { content: [{ type: "text", text: "ok" }] },
        }),
        thinking(3, "after the tool"),
      ],
      raw,
    );
    const a = first.runs[0]!.steps.find((step) => step.kind === "reasoning")!.id;
    const b = second.runs[0]!.steps.find((step) => step.kind === "reasoning")!.id;
    expect(a).not.toBe(b);
    expect(raw.get(KEY, a)!.call).toMatchObject({ data: { text: "at the start" } });
    expect(raw.get(KEY, b)!.call).toMatchObject({ data: { text: "after the tool" } });
  });

  it("leaves ordinary ids as they were", () => {
    const run = feed(emptyActivity, [thinking(1, "plain", "3af2093c-c659-48cf")], raw).runs[0]!;
    expect(run.steps[0]!.id).toBe("reasoning:3af2093c-c659-48cf:s:0");
  });
});

describe("tool calls whose id is absent or repeated", () => {
  type Part = { reasoning: string } | { tool: string | null };
  /** The same run as history rows and as live events; its step ids from each, in order. */
  function bothWays(parts: Part[]) {
    const rows: unknown[] = [{ role: "user", content: "Go", __openclaw: { id: "u0", seq: 0 } }];
    const events: Array<ReturnType<typeof agentEvent>> = [];
    let content: unknown[] = [];
    let seq = 1;
    let eventSeq = 0;
    const emit = (stream: string, data: Record<string, unknown>) =>
      events.push(agentEvent("r", (eventSeq += 1), stream, data));
    emit("lifecycle", { phase: "start" });
    for (const part of parts) {
      if ("reasoning" in part) {
        content.push({ type: "thinking", thinking: part.reasoning });
        emit("thinking", { text: part.reasoning, delta: part.reasoning });
        emit("lifecycle", { phase: "model" });
        continue;
      }
      const id = part.tool;
      content.push({ type: "toolCall", ...(id ? { id } : {}), name: "ls", arguments: {} });
      rows.push({
        role: "assistant",
        content,
        __openclaw: { id: `a${seq}`, seq: seq++, runId: "r" },
      });
      rows.push({
        role: "toolResult",
        ...(id ? { toolCallId: id } : {}),
        isError: false,
        content: [{ type: "text", text: "ok" }],
        __openclaw: { id: `t${seq}`, seq: seq++, runId: "r" },
      });
      content = [];
      emit("tool", { phase: "start", name: "ls", ...(id ? { toolCallId: id } : {}), args: {} });
      emit("tool", {
        phase: "result",
        name: "ls",
        ...(id ? { toolCallId: id } : {}),
        isError: false,
        result: { content: [{ type: "text", text: "ok" }], details: {} },
      });
      emit("lifecycle", { phase: "model" });
    }
    content.push({ type: "text", text: "Done" });
    rows.push({
      role: "assistant",
      content,
      stopReason: "stop",
      __openclaw: { id: `a${seq}`, seq, runId: "r" },
    });
    const live = feed(emptyActivity, events, raw).runs[0]!.steps.map((step) => step.id);
    const history = runsFromHistory(rows, null, ctx(new RawTable()))[0]!.steps.map(
      (step) => step.id,
    );
    return { live, history };
  }

  it("a repeated call id is one step, and it does not move the anchor: reasoning after it counts on from the call before, so no id repeats", () => {
    const { live, history } = bothWays([
      { tool: "a" },
      { reasoning: "one" },
      { tool: "b" },
      { reasoning: "two" },
      { tool: "a" },
      { reasoning: "three" },
    ]);
    expect(live).toEqual([
      "tool:a",
      "reasoning:r:t.a:0",
      "tool:b",
      "reasoning:r:t.b:0",
      "reasoning:r:t.b:1",
    ]);
    expect(history).toEqual(live);
  });

  it("a call with no id makes no step and does not move the anchor, live or from history", () => {
    const { live, history } = bothWays([
      { reasoning: "one" },
      { tool: null },
      { reasoning: "two" },
    ]);
    expect(live).toEqual(["reasoning:r:s:0", "reasoning:r:s:1"]);
    expect(history).toEqual(live);
  });
});

describe("a step id is never used twice (B2)", () => {
  function segments(count: number) {
    const events: Array<ReturnType<typeof agentEvent>> = [];
    let seq = 0;
    for (let i = 0; i < count; i += 1) {
      events.push(thinking((seq += 1), `segment${i}`));
      events.push(agentEvent("r", (seq += 1), "lifecycle", { phase: "model" }));
    }
    return feed(emptyActivity, events, raw);
  }

  it.each([MAX_STEPS_PER_RUN, MAX_STEPS_PER_RUN + 1, MAX_STEPS_PER_RUN + 2])(
    "after %i segments, retention drops the oldest without renumbering any",
    (count) => {
      const run = segments(count).runs[0]!;
      const all = run.steps.map((step) => step.id);
      expect(new Set(all).size).toBe(all.length);
      expect(run.omittedSteps).toBe(count - MAX_STEPS_PER_RUN);
      expect(all.at(-1)).toBe(`reasoning:r:s:${count - 1}`);
      expect(raw.get(KEY, `reasoning:r:s:${count - 1}`)!.call).toMatchObject({
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
    // The page does not show the run's start: its reasoning is numbered from the cut, never as `s`.
    expect(reopened).toEqual(["reasoning:r:c:0"]);
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
    const liveTable = new RawTable();
    const live = withCards(feed(emptyActivity, liveEvents, liveTable), liveTable);
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
    const nextLive = feed(liveTwice, [thinking(11, "fourth, more")], liveTable);
    const nextFresh = feed(freshTwice, [thinking(11, "fourth, more")], freshTable);
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

/** One finished run's reasoning, streamed live as `segments` with a `model` boundary between each, then resynced with `blocks`. */
function reasoningResync(segments: string[], blocks: string[]) {
  const liveTable = new RawTable();
  const events: Array<ReturnType<typeof agentEvent>> = [];
  segments.forEach((text, i) => {
    if (i > 0) events.push(agentEvent("r", i * 2, "lifecycle", { phase: "model" }));
    events.push(thinking(i * 2 + 1, text));
  });
  const live = feed(emptyActivity, events, liveTable);
  const rows = [
    {
      role: "assistant",
      content: blocks.map((text) => ({ type: "thinking", thinking: text })),
      stopReason: "stop",
      __openclaw: { id: "a1", seq: 1, runId: "r" },
    },
  ];
  const once = resync(live, rows, null, liveTable);
  const twice = resync(once, rows, null, liveTable);
  const byId = (activity: TaskActivity) =>
    activity.runs[0]!.steps.map((step) => [
      step.id,
      rawFacts(liveTable.get(KEY, step.id))?.thinking,
    ]);
  return { live, once, twice, byId };
}

describe("reasoning ids are their places, so a resync of the same window moves none (D1)", () => {
  it("abc, abc reconciled with abcd, abc keeps both ids, each on its own block", () => {
    const { live, once, twice, byId } = reasoningResync(["abc", "abc"], ["abcd", "abc"]);
    expect(ids(live)).toEqual(["reasoning:r:s:0", "reasoning:r:s:1"]);
    expect(ids(once)).toEqual(ids(live));
    expect(byId(twice)).toEqual([
      ["reasoning:r:s:0", "abcd"],
      ["reasoning:r:s:1", "abc"],
    ]);
  });

  it("a, then abc, reconciled with abc, abc does not give the first block the second card's id", () => {
    const { live, once, twice, byId } = reasoningResync(["a", "abc"], ["abc", "abc"]);
    expect(ids(live)).toEqual(["reasoning:r:s:0", "reasoning:r:s:1"]);
    expect(ids(once)).toEqual(ids(live));
    expect(ids(twice)).toEqual(ids(live));
    expect(byId(twice)).toEqual([
      ["reasoning:r:s:0", "abc"],
      ["reasoning:r:s:1", "abc"],
    ]);
  });

  it("one combined live card keeps its id for the first block, and the next block follows with its own", () => {
    const { live, once, byId } = reasoningResync(["first\nsecond"], ["first", "second"]);
    expect(ids(live)).toEqual(["reasoning:r:s:0"]);
    expect(byId(once)).toEqual([
      ["reasoning:r:s:0", "first"],
      ["reasoning:r:s:1", "second"],
    ]);
  });
});

/** A small seeded generator, so a failing case can be replayed. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Item = { kind: "reasoning"; text: string } | { kind: "tool"; id: string };

describe("reasoning ids follow from the history sequence, however the live stream showed it (property)", () => {
  /** The pure function: each reasoning block's id from the nearest tool before it and the count since. */
  function expectedIds(items: Item[]): string[] {
    let anchor = "s";
    let n = 0;
    return items.map((item) => {
      if (item.kind === "tool") {
        anchor = `t.${item.id}`;
        n = 0;
        return `tool:${item.id}`;
      }
      return `reasoning:r:${anchor}:${n++}`;
    });
  }

  const stats = { cases: 0, unshown: 0 };
  // The generator reaches both sides of the promise: cases where every block was shown, and
  // cases where one was combined or never shown.
  afterAll(() => {
    expect(stats.cases).toBe(300);
    expect(stats.unshown).toBeGreaterThan(50);
    expect(stats.cases - stats.unshown).toBeGreaterThan(50);
  });

  for (let seed = 1; seed <= 300; seed += 1) {
    it(`case ${seed}`, () => {
      const next = random(seed);
      const pick = <T>(list: T[]) => list[Math.floor(next() * list.length)]!;
      // A run: reasoning blocks and tool calls. Repeated, prefix-sharing texts make matching by text fail.
      const items: Item[] = [];
      let tools = 0;
      for (let i = 0, count = 1 + Math.floor(next() * 10); i < count; i += 1) {
        items.push(
          next() < 0.7
            ? { kind: "reasoning", text: pick(["a", "ab", "abc", "abcd", "x", "abc"]) }
            : { kind: "tool", id: `c${(tools += 1)}` },
        );
      }
      // History: one assistant row per model call, ending at each tool call, then the reply.
      const rows: unknown[] = [{ role: "user", content: "Go", __openclaw: { id: "u0", seq: 0 } }];
      let content: unknown[] = [];
      let seq = 1;
      for (const item of items) {
        if (item.kind === "reasoning") {
          content.push({ type: "thinking", thinking: item.text });
          continue;
        }
        content.push({ type: "toolCall", id: item.id, name: "ls", arguments: {} });
        rows.push({
          role: "assistant",
          content,
          __openclaw: { id: `a${seq}`, seq: seq++, runId: "r" },
        });
        rows.push({
          role: "toolResult",
          toolCallId: item.id,
          isError: false,
          content: [{ type: "text", text: "ok" }],
          __openclaw: { id: `t${seq}`, seq: seq++, runId: "r" },
        });
        content = [];
      }
      content.push({ type: "text", text: "Done" });
      rows.push({
        role: "assistant",
        content,
        stopReason: "stop",
        __openclaw: { id: `a${seq}`, seq, runId: "r" },
      });

      // Live: blocks of one model call may arrive combined into one card (as the gateway
      // joins them), separately, with a missed tail, or not at all; each card in pieces.
      const events: Array<ReturnType<typeof agentEvent>> = [];
      let eventSeq = 0;
      const emit = (stream: string, data: Record<string, unknown>) =>
        events.push(agentEvent("r", (eventSeq += 1), stream, data));
      /** For each block, the live card that showed it first, and whether it was that card's first block. */
      const shown: Array<{ card: number; first: boolean } | null> = items.map(() => null);
      let cards = 0;
      let open: { text: string; blocks: number[] } | null = null;
      const close = () => {
        if (!open) return;
        const text = next() < 0.3 && open.text.length > 1 ? open.text.slice(0, -1) : open.text;
        for (let end = 1; end <= text.length; end += 1 + Math.floor(next() * 2))
          emit("thinking", { text: text.slice(0, end), delta: "" });
        emit("thinking", { text, delta: "" });
        open = null;
        emit("lifecycle", { phase: "model" });
      };
      emit("lifecycle", { phase: "start" });
      items.forEach((item, index) => {
        if (item.kind === "tool") {
          close();
          emit("tool", { phase: "start", name: "ls", toolCallId: item.id, args: {} });
          emit("tool", {
            phase: "result",
            name: "ls",
            toolCallId: item.id,
            isError: false,
            result: { content: [{ type: "text", text: "ok" }], details: {} },
          });
          emit("lifecycle", { phase: "model" });
          return;
        }
        const way = next();
        if (way < 0.1) return; // Never shown live.
        if (open && way < 0.45) {
          open.text += `\n${item.text}`;
          open.blocks.push(index);
          shown[index] = { card: cards - 1, first: false };
          return;
        }
        close();
        open = { text: item.text, blocks: [index] };
        shown[index] = { card: cards, first: true };
        cards += 1;
      });
      close();
      emit("assistant", { text: "Done" });
      emit("lifecycle", { phase: "end" });

      const table = new RawTable();
      const live = feed(emptyActivity, events, table);
      const liveReasoning = live.runs[0]!.steps.filter((step) => step.kind === "reasoning");
      expect(liveReasoning).toHaveLength(cards);
      const once = resync(live, rows, null, table);
      const twice = resync(once, rows, null, table);
      const expected = expectedIds(items);
      // The run says when its reasoning ids changed, and only then.
      const reasoningIds = (activity: TaskActivity) =>
        activity.runs[0]!.steps.filter((step) => step.kind === "reasoning").map((step) => step.id);
      const changed = reasoningIds(live).join() !== reasoningIds(once).join();
      expect(once.runs[0]!.reasoningRevision).toBe(changed ? 1 : 0);
      expect(twice.runs[0]!.reasoningRevision).toBe(once.runs[0]!.reasoningRevision);
      stats.cases += 1;
      if (shown.some((each, i) => items[i]!.kind === "reasoning" && !each?.first))
        stats.unshown += 1;

      // The ids are the pure function of history's sequence, and none is used twice.
      expect(ids(once)).toEqual(expected);
      expect(new Set(ids(once)).size).toBe(expected.length);
      expect(twice).toEqual(once);
      // The raw record behind each reasoning step is found by the same id.
      items.forEach((item, index) => {
        if (item.kind === "reasoning")
          expect(rawFacts(table.get(KEY, expected[index]!))?.thinking).toBe(item.text);
      });
      // Each card the live stream showed keeps its id on the first block it showed, unless an
      // earlier block since the same anchor was never shown on its own (the stated non-promise).
      items.forEach((item, index) => {
        const card = shown[index];
        if (!card?.first) return;
        let unshownBefore = false;
        for (let i = index - 1; i >= 0 && items[i]!.kind === "reasoning"; i -= 1)
          if (!shown[i]?.first) unshownBefore = true;
        const before = liveReasoning[card.card]!.id;
        if (!unshownBefore) expect(before).toBe(expected[index]);
        // Shifted or not, its old id is one the run's history gives, never one outside it.
        else expect(expected).toContain(before);
      });
    });
  }
});

describe("a run still in flight numbers its next reasoning from what history showed", () => {
  it("after a gap that hid a tool call, the next live block takes the id history will give it", () => {
    const table = new RawTable();
    const live = feed(
      emptyActivity,
      [agentEvent("r", 1, "lifecycle", { phase: "start" }), thinking(2, "a")],
      table,
    );
    // Missed in a gap: tool c1 and the reasoning after it.
    const rows = [
      { role: "user", content: "Go", __openclaw: { id: "u0", seq: 0 } },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "a" },
          { type: "toolCall", id: "c1", name: "ls", arguments: {} },
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
      thinkingRow("b", 3, [{ type: "text", text: "so" }]),
    ];
    const resynced = resync(live, rows, { runId: "r" }, table);
    expect(resynced.runs[0]).toMatchObject({ reasoningAnchor: "t.c1", nextReasoning: 1 });
    const next = feed(
      resynced,
      [agentEvent("r", 9, "lifecycle", { phase: "model" }), thinking(10, "c")],
      table,
    );
    expect(ids(next)).toEqual(["reasoning:r:s:0", "tool:c1", "reasoning:r:t.c1:1"]);
  });
});

describe("a run says when a reconciliation changed its reasoning ids (R7-2)", () => {
  const row = (content: unknown[]) => ({
    role: "assistant",
    content,
    stopReason: "stop",
    __openclaw: { id: "a1", seq: 1, runId: "r" },
  });

  it("a missed tool anchor changes the id of the reasoning after it, and the counter says so", () => {
    const table = new RawTable();
    // A gap hid tool c; the reasoning after it arrived before the history reply.
    const live = feed(emptyActivity, [thinking(1, "after")], table);
    expect(live.runs[0]!.reasoningRevision).toBe(0);
    const rows = [
      row([
        { type: "toolCall", id: "c", name: "exec", arguments: {} },
        { type: "thinking", thinking: "after" },
      ]),
    ];
    const once = resync(live, rows, null, table);
    expect(ids(once)).toEqual(["tool:c", "reasoning:r:t.c:0"]);
    expect(once.runs[0]!.reasoningRevision).toBe(1);
    // The same history again changes nothing more.
    expect(resync(once, rows, null, table).runs[0]!.reasoningRevision).toBe(1);
  });

  it("does not increase when a reconciliation changes no reasoning id", () => {
    const table = new RawTable();
    const live = feed(
      emptyActivity,
      [
        thinking(1, "first"),
        agentEvent("r", 2, "tool", { phase: "start", name: "ls", toolCallId: "c1", args: {} }),
        agentEvent("r", 3, "lifecycle", { phase: "model" }),
        thinking(4, "second"),
      ],
      table,
    );
    const rows = [
      row([
        { type: "thinking", thinking: "first" },
        { type: "toolCall", id: "c1", name: "ls", arguments: {} },
        { type: "thinking", thinking: "second" },
        { type: "text", text: "Done" },
      ]),
    ];
    // In flight, and once the run has finished.
    const inFlight = resync(live, rows, { runId: "r" }, table);
    expect(inFlight.runs[0]!.reasoningRevision).toBe(0);
    const finished = resync(inFlight, rows, null, table);
    expect(ids(finished)).toEqual(ids(live));
    expect(finished.runs[0]!.reasoningRevision).toBe(0);
  });
});
