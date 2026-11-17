// Step identities are stable and state rebuilt from history equals state
// from the live stream: a reasoning segment restarted after a fresh opening is
// a new segment, ids never repeat when retention drops older steps, and live,
// rebuilt and resynced-twice state agree field by field for a run with
// reasoning, tools, a question and an approval, while it streams and after.

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
  type Run,
  type TaskActivity,
} from "../src/runs.ts";
import { agentEvent, KEY, questionRecord } from "./client-harness.ts";

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

const shape = (run: Run | undefined) =>
  run?.steps.map((step) => [step.id, step.status, step.output?.text ?? null]);

const thinkingRow = (text: string, seq = 1, extra: unknown[] = []) => ({
  role: "assistant",
  content: [{ type: "thinking", thinking: text }, ...extra],
  __openclaw: { id: `a${seq}`, seq, runId: "r" },
});

describe("a fresh opening, then a reasoning frame that does not extend the persisted one (B1)", () => {
  it("starts a new segment, as the live view does, and leaves the persisted one done", () => {
    const fresh = runsFromHistory([thinkingRow("abc")], { runId: "r" }, ctx());
    const after = feed({ ...emptyActivity, runs: fresh }, [thinking(3, "xyz")]);
    const liveTable = new RawTable();
    const live = feed(emptyActivity, [thinking(1, "abc"), thinking(3, "xyz")], liveTable);
    expect(shape(after.runs[0])).toEqual(shape(live.runs[0]));
    expect(shape(after.runs[0])).toEqual([
      ["reasoning:r:0", "done", "abc"],
      ["reasoning:r:1", "running", "xyz"],
    ]);
    // Each segment's raw lookup is its own: the persisted block, then the new frame.
    expect(raw.get(KEY, "reasoning:r:0")!.call).toMatchObject({
      type: "thinking",
      thinking: "abc",
    });
    expect(raw.get(KEY, "reasoning:r:1")!.call).toMatchObject({ data: { text: "xyz" } });
  });

  it("continues the segment when the frame extends it, and a resync twice changes nothing", () => {
    const fresh = runsFromHistory([thinkingRow("abc")], { runId: "r" }, ctx());
    const after = feed({ ...emptyActivity, runs: fresh }, [thinking(3, "abcd")]);
    expect(shape(after.runs[0])).toEqual([["reasoning:r:0", "running", "abcd"]]);
    const once = mergeHistoryRuns(
      after.runs,
      runsFromHistory([thinkingRow("abc")], { runId: "r" }, ctx(new RawTable())),
      ctx(),
    ).runs;
    const twice = mergeHistoryRuns(
      once,
      runsFromHistory([thinkingRow("abc")], { runId: "r" }, ctx(new RawTable())),
      ctx(),
    ).runs;
    expect(shape(once[0])).toEqual(shape(after.runs[0]));
    expect(twice).toEqual(once);
    // The next restart after the resync is still a new segment.
    const restarted = feed({ ...emptyActivity, runs: twice }, [thinking(4, "xyz")]);
    expect(shape(restarted.runs[0])).toEqual([
      ["reasoning:r:0", "done", "abcd"],
      ["reasoning:r:1", "running", "xyz"],
    ]);
  });

  it("a segment whose text was not kept is not assumed to continue on a cumulative frame", () => {
    const fresh = runsFromHistory([thinkingRow("abc")], { runId: "r" }, ctx());
    const stubbed: Run = {
      ...fresh[0]!,
      steps: [{ ...fresh[0]!.steps[0]!, output: null, bodyOmitted: true }],
    };
    const after = feed({ ...emptyActivity, runs: [stubbed] }, [thinking(3, "xyz")]);
    expect(after.runs[0]!.steps.map((step) => step.id)).toEqual(["reasoning:r:0", "reasoning:r:1"]);
  });
});

describe("reasoning ids never repeat when retention drops older steps (B2)", () => {
  function segments(count: number, withTool = false) {
    const events: Array<ReturnType<typeof agentEvent>> = [];
    let seq = 0;
    for (let i = 0; i < count; i += 1) {
      events.push(thinking((seq += 1), `segment${i}`));
      if (withTool && i % 2 === 0) {
        events.push(
          agentEvent("r", (seq += 1), "tool", { phase: "start", name: "ls", toolCallId: `t${i}` }),
        );
        events.push(
          agentEvent("r", (seq += 1), "tool", {
            phase: "result",
            name: "ls",
            toolCallId: `t${i}`,
            result: { content: [{ type: "text", text: "ok" }] },
          }),
        );
      }
      events.push(agentEvent("r", (seq += 1), "lifecycle", { phase: "model" }));
    }
    return feed(emptyActivity, events);
  }

  it.each([MAX_STEPS_PER_RUN, MAX_STEPS_PER_RUN + 1, MAX_STEPS_PER_RUN + 2])(
    "after %i segments: unique ids, the right omission count and each raw lookup its own",
    (count) => {
      const run = segments(count).runs[0]!;
      const ids = run.steps.map((step) => step.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(run.steps).toHaveLength(MAX_STEPS_PER_RUN);
      expect(run.omittedSteps).toBe(count - MAX_STEPS_PER_RUN);
      expect(ids.at(-1)).toBe(`reasoning:r:${count - 1}`);
      expect(run.steps.at(-1)!.output!.text).toBe(`segment${count - 1}`);
      expect(raw.get(KEY, `reasoning:r:${count - 1}`)!.call).toMatchObject({
        data: { text: `segment${count - 1}` },
      });
      expect(run.nextReasoning).toBe(count);
    },
  );

  it("with tool steps between segments", () => {
    const run = segments(200, true).runs[0]!;
    const ids = run.steps.map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(run.steps.length + run.omittedSteps).toBe(300);
    expect(ids.at(-1)).toBe("reasoning:r:199");
  });

  it("a history page that cut a run's start names its segments by row, not by a position it cannot know", () => {
    const rows = [thinkingRow("late", 41)];
    const cut = runsFromHistory(rows, null, ctx(), { startCut: true })[0]!;
    expect(cut.steps.map((step) => step.id)).toEqual(["reasoning:r:@41.0"]);
    const whole = runsFromHistory(
      [{ role: "user", content: "go", __openclaw: { id: "u1", seq: 40 } }, ...rows],
      null,
      ctx(),
      { startCut: true },
    )[0]!;
    expect(whole.steps.map((step) => step.id)).toEqual(["reasoning:r:0"]);
  });
});

/** Everything a view shows of a task that the gateway's events and its history both establish. */
function view(activity: TaskActivity, table: RawTable) {
  return {
    runs: activity.runs.map((run) => ({
      id: run.id,
      state: run.state,
      outcomeKnown: run.outcomeKnown,
      omittedSteps: run.omittedSteps,
      nextReasoning: run.nextReasoning,
      pendingCards: run.pendingCards.map((card) => [card.id, card.kind]),
      steps: run.steps.map((step) => ({
        id: step.id,
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
        bodyOmitted: step.bodyOmitted,
        correction: step.correction,
        rawAvailable: table.get(KEY, step.id) !== null,
      })),
    })),
    questions: activity.questions.map((question) => [question.id, question.status, question.runId]),
    approvals: activity.approvals.map((approval) => [
      approval.id,
      approval.status,
      approval.stepId,
      approval.runEnded,
    ]),
  };
}

describe("live, rebuilt and resynced twice agree field by field (A6, ruling 3)", () => {
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
  const args = (id: string) => ({ path: id });
  const live = [
    agentEvent("r", 1, "lifecycle", { phase: "start" }),
    thinking(2, "first"),
    agentEvent("r", 3, "tool", { phase: "start", name: "ls", toolCallId: "c1", args: args("c1") }),
    agentEvent("r", 4, "tool", {
      phase: "result",
      name: "ls",
      toolCallId: "c1",
      isError: false,
      result: { content: [{ type: "text", text: "ok" }], details: {} },
    }),
    agentEvent("r", 5, "lifecycle", { phase: "model" }),
    thinking(6, "second"),
    agentEvent("r", 7, "tool", { phase: "start", name: "rm", toolCallId: "c2", args: args("c2") }),
    agentEvent("r", 8, "lifecycle", { phase: "model" }),
    // A restarted reasoning segment while the call waits on its approval.
    thinking(9, "third"),
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
        { type: "thinking", thinking: "second" },
        { type: "toolCall", id: "c2", name: "rm", arguments: args("c2") },
      ],
      __openclaw: { id: "a2", seq: 3, runId: "r" },
    },
    {
      role: "assistant",
      content: [{ type: "thinking", thinking: "third" }],
      __openclaw: { id: "a3", seq: 4, runId: "r" },
    },
  ];
  // The snapshot repeats the tool events, as the gateway's progress snapshot does.
  const snapshot = { runId: "r", events: live.filter((event) => event.stream === "tool") };

  const withCards = (activity: TaskActivity, table: RawTable) =>
    normalizeApprovals(
      applyApprovalRequested(applyQuestionRequested(activity, question, ctx(table)), approval),
    );

  function liveState() {
    const table = new RawTable();
    return { table, activity: withCards(feed(emptyActivity, live, table), table) };
  }
  function rebuilt() {
    const table = new RawTable();
    const runs = runsFromHistory(rows, snapshot, ctx(table));
    return { table, activity: withCards({ ...emptyActivity, runs }, table) };
  }
  function resync(activity: TaskActivity, table: RawTable) {
    const scratch = new RawTable();
    const merge = mergeHistoryRuns(
      activity.runs,
      runsFromHistory(rows, snapshot, ctx(scratch)),
      ctx(table),
    );
    for (const stepId of merge.fromHistory) {
      const payload = scratch.get(KEY, stepId);
      if (payload) table.set(KEY, stepId, payload);
    }
    return retainActivity(normalizeApprovals({ ...activity, runs: merge.runs }));
  }

  it("while reasoning still streams", () => {
    const a = liveState();
    const b = rebuilt();
    const once = resync(a.activity, a.table);
    const twice = resync(once, a.table);
    const rebuiltOnce = resync(b.activity, b.table);
    expect(view(b.activity, b.table)).toEqual(view(a.activity, a.table));
    expect(view(once, a.table)).toEqual(view(a.activity, a.table));
    expect(view(twice, a.table)).toEqual(view(once, a.table));
    expect(view(rebuiltOnce, b.table)).toEqual(view(b.activity, b.table));
    expect(view(a.activity, a.table).runs[0]!.steps.map((step) => [step.id, step.status])).toEqual([
      ["reasoning:r:0", "done"],
      ["tool:c1", "done"],
      ["reasoning:r:1", "done"],
      ["tool:c2", "waiting"],
      ["reasoning:r:2", "running"],
    ]);
    // Events delivered again after the resync change nothing.
    expect(view(feed(twice, live, a.table), a.table)).toEqual(view(twice, a.table));
    // The next frame continues the streaming segment in both.
    const nextLive = feed(twice, [thinking(10, "third, more")], a.table);
    const nextRebuilt = feed(rebuiltOnce, [thinking(10, "third, more")], b.table);
    expect(view(nextRebuilt, b.table)).toEqual(view(nextLive, a.table));
  });

  it("after retention dropped the oldest steps", () => {
    const many = [
      agentEvent("r", 1, "lifecycle", { phase: "start" }),
      ...Array.from({ length: MAX_STEPS_PER_RUN + 4 }, (_, i) => [
        agentEvent("r", 2 + i * 2, "tool", {
          phase: "start",
          name: "ls",
          toolCallId: `m${i}`,
          args: args(`m${i}`),
        }),
        agentEvent("r", 3 + i * 2, "tool", {
          phase: "result",
          name: "ls",
          toolCallId: `m${i}`,
          isError: false,
          result: { content: [{ type: "text", text: "ok" }], details: {} },
        }),
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
    const fresh = retainActivity({
      ...emptyActivity,
      runs: runsFromHistory(manyRows, { runId: "r" }, ctx(new RawTable())),
    });
    const merge = (activity: TaskActivity) =>
      retainActivity({
        ...activity,
        runs: mergeHistoryRuns(
          activity.runs,
          runsFromHistory(manyRows, { runId: "r" }, ctx(new RawTable())),
          ctx(table),
        ).runs,
      });
    const once = merge(streamed);
    const twice = merge(once);
    const ids = (activity: TaskActivity) => activity.runs[0]!.steps.map((step) => step.id);
    expect(streamed.runs[0]!.omittedSteps).toBe(4);
    expect(ids(once)).toEqual(ids(streamed));
    expect(once.runs[0]!.omittedSteps).toBe(4);
    expect(ids(twice)).toEqual(ids(once));
    expect(twice.runs[0]!.omittedSteps).toBe(4);
    expect(ids(fresh)).toEqual(ids(streamed));
    expect(fresh.runs[0]!.omittedSteps).toBe(4);
  });
});
