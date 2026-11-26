// The run engine, driven by sequences of protocol payloads shaped like what
// OpenClaw 2026.10.6 sends (capability map rows 6, 7 and 19). Test names carry
// the parity rows they support.

import { beforeEach, describe, expect, it } from "vitest";
import {
  activeRun,
  applyAgentEvent,
  applyChatEvent,
  applyQuestionRequested,
  applyQuestionResolved,
  bindRun,
  cancelQueuedRun,
  emptyActivity,
  failRun,
  failRunStart,
  MAX_STEP_TEXT,
  mergeHistoryRuns,
  queueLocalRun,
  RAW_INLINE_LIMIT,
  RawTable,
  reconcileOutbox,
  registerSteerAlias,
  retainActivity,
  requestStop,
  revertStop,
  runsFromHistory,
  settleRunFromWait,
  startLocalRun,
  startQueuedRun,
  type EngineContext,
  type OutgoingMessage,
  type Run,
  type Step,
  type TaskActivity,
} from "../src/runs.ts";
import { MAX_PREAMBLES_PER_RUN } from "../src/state-bounds.ts";

const KEY = "agent:otto:disk-space";
let raw: RawTable;
const ctx = (now = 5_000): EngineContext => ({ sessionKey: KEY, now, raw });

beforeEach(() => {
  raw = new RawTable();
});

const agent = (runId: string, seq: number, stream: string, data: Record<string, unknown>) => ({
  runId,
  seq,
  stream,
  ts: 1_000 + seq,
  sessionKey: KEY,
  data,
});
const chat = (runId: string, seq: number, state: string, extra: Record<string, unknown> = {}) => ({
  runId,
  sessionKey: KEY,
  seq,
  state,
  ...extra,
});

type Frame =
  | { event: "agent"; payload: ReturnType<typeof agent> }
  | { event: "chat"; payload: ReturnType<typeof chat>; text?: string };

function play(frames: Frame[], start: TaskActivity = emptyActivity) {
  let activity = start;
  for (const frame of frames) {
    if (frame.event === "agent") {
      activity = applyAgentEvent(activity, frame.payload, ctx()).activity;
    } else {
      activity = applyChatEvent(activity, frame.payload, frame.text ?? null, ctx());
    }
  }
  return { activity };
}

const A = (runId: string, seq: number, stream: string, data: Record<string, unknown>): Frame => ({
  event: "agent",
  payload: agent(runId, seq, stream, data),
});
const C = (runId: string, seq: number, state: string, extra = {}, text?: string): Frame => ({
  event: "chat",
  payload: chat(runId, seq, state, extra),
  ...(text !== undefined ? { text } : {}),
});

const lsResult = { content: [{ type: "text", text: '"AGENTS.md"\n"notes/"' }], details: {} };

/** Reasoning, a tool and more reasoning, in the order row 19 recorded live. */
function toolRun(runId = "run-1"): Frame[] {
  return [
    A(runId, 1, "lifecycle", { phase: "start", startedAt: 1_001 }),
    A(runId, 2, "lifecycle", { phase: "model", provider: "scripted", model: "dev-1" }),
    A(runId, 3, "thinking", { text: "Look before", delta: "Look before" }),
    A(runId, 4, "thinking", { text: "Look before guessing.", delta: " guessing." }),
    A(runId, 5, "item", {
      itemId: "tool:call_1",
      toolCallId: "call_1",
      name: "ls",
      kind: "tool",
      phase: "start",
      title: "List files",
      status: "running",
      startedAt: 1_005,
    }),
    A(runId, 6, "tool", { phase: "start", name: "ls", toolCallId: "call_1", args: { path: "." } }),
    A(runId, 7, "tool", {
      phase: "result",
      name: "ls",
      toolCallId: "call_1",
      isError: false,
      result: lsResult,
    }),
    A(runId, 8, "item", {
      itemId: "tool:call_1",
      toolCallId: "call_1",
      kind: "tool",
      phase: "end",
      status: "completed",
      endedAt: 1_008,
    }),
    A(runId, 9, "lifecycle", { phase: "model", provider: "scripted", model: "dev-1" }),
    A(runId, 10, "thinking", { text: "Now answer.", delta: "Now answer." }),
    A(runId, 11, "assistant", {
      text: "**Found** the cache.",
      delta: "**Found** the cache.",
      itemId: `${runId}:2`,
    }),
    A(runId, 12, "lifecycle", { phase: "finishing" }),
    A(runId, 13, "lifecycle", { phase: "end", stopReason: "stop", aborted: false, endedAt: 1_013 }),
  ];
}

/** The same run as `chat.history` keeps it. */
const toolRunHistory = [
  {
    role: "user",
    content: "The disk is 94% full.",
    timestamp: 100,
    __openclaw: { id: "u1", seq: 1 },
  },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Look before guessing." },
      { type: "toolCall", id: "call_1", name: "ls", arguments: { path: "." } },
    ],
    model: "dev-1",
    timestamp: 110,
    __openclaw: { id: "a1", seq: 2, runId: "run-1" },
  },
  {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "ls",
    isError: false,
    content: lsResult.content,
    details: {},
    timestamp: 120,
    __openclaw: { id: "t1", seq: 3, runId: "run-1" },
  },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Now answer." },
      { type: "text", text: "**Found** the cache." },
    ],
    model: "dev-1",
    stopReason: "stop",
    timestamp: 130,
    __openclaw: { id: "a2", seq: 4, runId: "run-1" },
  },
];

/** What the interface draws from a step; timing and raw differ by source. */
function view(step: Step) {
  return {
    id: step.id,
    kind: step.kind,
    title: step.title,
    toolName: step.toolName,
    toolCallId: step.toolCallId,
    status: step.status,
    args: step.argsText?.text ?? null,
    output: step.output?.text ?? null,
    result: step.result?.text ?? null,
    error: step.error,
    failureKind: step.failureKind,
  };
}

function message(id: string, extra: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    id,
    text: "Clear it.",
    mode: "new",
    status: "sending",
    runId: null,
    messageSeq: null,
    leftAt: null,
    createdAt: 1_000,
    error: null,
    attachments: [],
    ...extra,
  };
}

const only = (activity: TaskActivity, id = "run-1"): Run => {
  const run = activity.runs.find((each) => each.id === id);
  if (!run) throw new Error(`no run ${id}`);
  return run;
};

describe("run states: the §5.6 table (F-468)", () => {
  it("(none) to running when the user sends to an idle task (F-081)", () => {
    const activity = startLocalRun(emptyActivity, message("m1"), 1_000);
    expect(only(activity, "m1")).toMatchObject({ state: "running", origin: "local", bound: false });
    expect(activeRun(activity)?.id).toBe("m1");
  });

  it("running to completed when the gateway reports the run finished (F-089)", () => {
    const { activity } = play(toolRun());
    expect(only(activity)).toMatchObject({
      state: "completed",
      endedAt: 1_013,
      finishedBeforeStop: false,
    });
    expect(activeRun(activity)).toBeUndefined();
  });

  it("running to completed on a chat final alone", () => {
    const { activity } = play([
      C("run-1", 1, "delta", { deltaText: "Hi" }, "Hi"),
      C("run-1", 2, "final", {
        message: { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
      }),
    ]);
    expect(only(activity)).toMatchObject({
      state: "completed",
      text: "Hi there",
      textComplete: true,
    });
  });

  it("(none) to queued with Queue after this turn, then queued to running once the active run ends (F-421)", () => {
    let activity = startLocalRun(emptyActivity, message("m1"), 1_000);
    activity = bindRun(activity, "m1", "run-1");
    activity = queueLocalRun(activity, message("m2", { mode: "queue", status: "queued" }), 1_100);
    expect(only(activity, "m2").state).toBe("queued");
    activity = play([C("run-1", 9, "final", {})], activity).activity;
    expect(activeRun(activity)).toBeUndefined();
    activity = startQueuedRun(activity, "m2", 1_200);
    expect(only(activity, "m2")).toMatchObject({ state: "running", startedAt: 1_200 });
  });

  it("queued to cancelled, and a cancelled run never starts (F-420)", () => {
    let activity = queueLocalRun(
      emptyActivity,
      message("m2", { mode: "queue", status: "queued" }),
      1_000,
    );
    activity = cancelQueuedRun(activity, "m2", 1_100);
    expect(only(activity, "m2")).toMatchObject({ state: "cancelled", endedAt: 1_100 });
    expect(startQueuedRun(activity, "m2", 1_200)).toBe(activity);
  });

  it("running to waiting on a question, waiting to running when it is answered (F-292)", () => {
    let { activity } = play([A("run-1", 1, "lifecycle", { phase: "start" })]);
    activity = applyQuestionRequested(activity, questionRecord("ask_1"), ctx());
    expect(only(activity)).toMatchObject({ state: "waiting" });
    expect(only(activity).pendingCards).toEqual([{ id: "ask_1", kind: "question", since: 2_000 }]);
    activity = applyQuestionResolved(activity, {
      id: "ask_1",
      status: "answered",
      answers: { answers: { color: ["Blue"] } },
    });
    expect(only(activity).state).toBe("running");
    expect(only(activity).closedCards).toMatchObject([{ id: "ask_1", reason: "answered" }]);
    expect(activity.questions[0]).toMatchObject({
      status: "answered",
      answers: { color: ["Blue"] },
    });
  });

  it("waiting to running when the question is dismissed or expires; the bot carries on", () => {
    for (const [status, expected] of [
      ["cancelled", "dismissed"],
      ["expired", "expired"],
    ] as const) {
      let { activity } = play([A("run-1", 1, "lifecycle", { phase: "start" })]);
      activity = applyQuestionRequested(activity, questionRecord("ask_1"), ctx());
      activity = applyQuestionResolved(activity, { id: "ask_1", status });
      expect(only(activity).state).toBe("running");
      expect(activity.questions[0]!.status).toBe(expected);
      expect(only(activity).closedCards[0]!.reason).toBe(expected);
    }
  });

  it("running to waiting on an approval, and waiting stays waiting while another card is pending", () => {
    let { activity } = play([
      A("run-1", 1, "lifecycle", { phase: "start" }),
      A("run-1", 2, "lifecycle", { phase: "waiting-approval", approvalId: "ap-1" }),
    ]);
    expect(only(activity).state).toBe("waiting");
    activity = applyQuestionRequested(activity, questionRecord("ask_1"), ctx());
    activity = play(
      [A("run-1", 3, "lifecycle", { phase: "approval-resolved", approvalId: "ap-1" })],
      activity,
    ).activity;
    expect(only(activity).state).toBe("waiting");
    expect(only(activity).pendingCards.map((card) => card.id)).toEqual(["ask_1"]);
    activity = applyQuestionResolved(activity, {
      id: "ask_1",
      status: "answered",
      answers: { answers: {} },
    });
    expect(only(activity).state).toBe("running");
  });

  it("waiting to completed: pending cards close as the run ended, their actions not taken (F-418)", () => {
    let { activity } = play([
      A("run-1", 1, "lifecycle", { phase: "start" }),
      A("run-1", 2, "lifecycle", { phase: "waiting-approval", approvalId: "ap-1" }),
    ]);
    activity = play(
      [A("run-1", 3, "lifecycle", { phase: "end", aborted: false })],
      activity,
    ).activity;
    expect(only(activity)).toMatchObject({ state: "completed", pendingCards: [] });
    expect(only(activity).closedCards).toMatchObject([{ id: "ap-1", reason: "run-ended" }]);
  });

  it("a steer leaves pending cards pending, as the gateway does (F-468; differs from §5.6)", () => {
    let { activity } = play([
      A("run-1", 1, "lifecycle", { phase: "start" }),
      A("run-1", 2, "lifecycle", { phase: "waiting-approval", approvalId: "ap-1" }),
    ]);
    // The steer send returns its own run id, which the gateway settles at once with an empty final.
    activity = registerSteerAlias(activity, "steer-run", "run-1");
    activity = play([C("steer-run", 1, "final", {})], activity).activity;
    expect(activity.runs.map((run) => run.id)).toEqual(["run-1"]);
    expect(only(activity)).toMatchObject({ state: "waiting" });
    expect(only(activity).pendingCards.map((card) => card.id)).toEqual(["ap-1"]);
  });

  it("drops a steer's own run when its events arrived before the send answered", () => {
    let { activity } = play([
      A("run-1", 1, "lifecycle", { phase: "start" }),
      C("steer-run", 1, "final", {}),
    ]);
    expect(activity.runs).toHaveLength(2);
    activity = registerSteerAlias(activity, "steer-run", "run-1");
    expect(activity.runs.map((run) => run.id)).toEqual(["run-1"]);
  });

  it("running or waiting to stopping; pending cards close as cancelled (F-097)", () => {
    let { activity } = play([
      A("run-1", 1, "lifecycle", { phase: "start" }),
      A("run-1", 2, "lifecycle", { phase: "waiting-approval", approvalId: "ap-1" }),
    ]);
    activity = applyQuestionRequested(activity, questionRecord("ask_1"), ctx());
    activity = requestStop(activity, "run-1", 3_000);
    expect(only(activity)).toMatchObject({
      state: "stopping",
      stopRequestedAt: 3_000,
      pendingCards: [],
    });
    // Held until the stop takes, so a refused Stop can restore them.
    expect(only(activity).suspendedCards.map((card) => card.id)).toEqual(["ap-1", "ask_1"]);
    const stopped = play([C("run-1", 9, "aborted", {})], activity).activity;
    expect(only(stopped).closedCards.map((card) => card.reason)).toEqual([
      "cancelled",
      "cancelled",
    ]);
    // The gateway then cancels the question because the run was aborted.
    activity = applyQuestionResolved(activity, { id: "ask_1", status: "cancelled" });
    expect(activity.questions[0]!.status).toBe("cancelled");
  });

  it("stopping to stopped when the gateway confirms; a tool in flight fails as Aborted (F-097, F-099, F-299)", () => {
    let { activity } = play(toolRun().slice(0, 6));
    activity = requestStop(activity, "run-1", 3_000);
    activity = play(
      [
        A("run-1", 7, "tool", {
          phase: "result",
          name: "ls",
          toolCallId: "call_1",
          isError: true,
          result: { content: [{ type: "text", text: "Aborted" }], details: {} },
        }),
        C("run-1", 8, "aborted", { stopReason: "rpc" }),
        A("run-1", 9, "lifecycle", { phase: "end", status: "cancelled", aborted: true }),
      ],
      activity,
    ).activity;
    const run = only(activity);
    expect(run).toMatchObject({ state: "stopped", finishedBeforeStop: false });
    // Completed steps stay; the reasoning segment is closed, the tool is failed.
    expect(run.steps.map((step) => [step.kind, step.status, step.error])).toEqual([
      ["reasoning", "done", null],
      ["tool", "failed", "Aborted"],
    ]);
  });

  it("stopping to completed when the run finished before the stop took effect (F-419)", () => {
    let { activity } = play(toolRun().slice(0, 11));
    activity = requestStop(activity, "run-1", 3_000);
    activity = play(toolRun().slice(11), activity).activity;
    expect(only(activity)).toMatchObject({ state: "completed", finishedBeforeStop: true });
  });

  it("a stop the gateway refused returns the run to running with the reason", () => {
    let { activity } = play([A("run-1", 1, "lifecycle", { phase: "start" })]);
    activity = revertStop(requestStop(activity, "run-1", 3_000), "run-1", "missing scope");
    expect(only(activity)).toMatchObject({ state: "running", stopError: "missing scope" });
  });

  it("running, waiting or stopping to failed on a gateway error (F-102)", () => {
    const viaChat = play([
      A("run-1", 1, "lifecycle", { phase: "start" }),
      C("run-1", 2, "error", { errorMessage: "⚠️ Coder Slow Task failed", errorKind: "tool" }),
    ]).activity;
    expect(only(viaChat)).toMatchObject({
      state: "failed",
      error: { message: "⚠️ Coder Slow Task failed", kind: "tool" },
    });

    let waiting = play([
      A("run-1", 1, "lifecycle", { phase: "start" }),
      A("run-1", 2, "lifecycle", { phase: "waiting-approval", approvalId: "ap-1" }),
    ]).activity;
    waiting = play(
      [
        A("run-1", 3, "lifecycle", {
          phase: "error",
          error: "provider timeout",
          executionSettled: true,
        }),
      ],
      waiting,
    ).activity;
    expect(only(waiting)).toMatchObject({
      state: "failed",
      error: { message: "provider timeout" },
    });
    expect(only(waiting).closedCards[0]!.reason).toBe("run-failed");

    let stopping = play([A("run-1", 1, "lifecycle", { phase: "start" })]).activity;
    stopping = requestStop(stopping, "run-1", 3_000);
    stopping = play([C("run-1", 2, "error", { errorMessage: "boom" })], stopping).activity;
    expect(only(stopping).state).toBe("failed");
  });

  it("running to failed at the turn limit (F-100)", () => {
    let activity = bindRun(startLocalRun(emptyActivity, message("m1"), 1_000), "m1", "run-1");
    activity = failRun(
      activity,
      "run-1",
      { message: "Stopped at the 50-minute turn limit.", kind: "turn-limit" },
      ctx(),
    );
    expect(only(activity)).toMatchObject({ state: "failed", error: { kind: "turn-limit" } });
  });

  it("(none) or queued to failed when the gateway refuses to start the run (F-075)", () => {
    let activity = startLocalRun(emptyActivity, message("m1"), 1_000);
    activity = queueLocalRun(activity, message("m2", { mode: "queue", status: "queued" }), 1_000);
    for (const id of ["m1", "m2"]) {
      activity = failRunStart(
        activity,
        id,
        { message: "budget exhausted", kind: "not-started" },
        ctx(),
      );
      expect(only(activity, id)).toMatchObject({
        state: "failed",
        error: { message: "budget exhausted" },
      });
    }
  });

  it("a terminal state is final: later events never change it", () => {
    let { activity } = play(toolRun());
    const before = only(activity);
    activity = play(
      [
        C("run-1", 20, "error", { errorMessage: "late" }),
        A("run-1", 21, "thinking", { text: "late", delta: "late" }),
        A("run-1", 22, "lifecycle", { phase: "waiting-approval" }),
      ],
      activity,
    ).activity;
    expect(only(activity)).toBe(before);
    activity = requestStop(activity, "run-1", 9_000);
    expect(only(activity)).toBe(before);
  });

  it("binds a local run to the gateway's id, folding in a run its events already made", () => {
    let activity = startLocalRun(emptyActivity, message("m1"), 1_000);
    activity = play([A("run-1", 1, "lifecycle", { phase: "start" })], activity).activity;
    expect(activity.runs).toHaveLength(2);
    activity = bindRun(activity, "m1", "run-1");
    expect(activity.runs).toHaveLength(1);
    expect(only(activity)).toMatchObject({
      origin: "local",
      messageId: "m1",
      bound: true,
      startedAt: 1_000,
    });
  });
});

describe("streaming text (F-095, F-433)", () => {
  it("takes text from chat deltas and ignores agent assistant text for that run", () => {
    const { activity } = play([
      C("run-1", 1, "delta", { deltaText: "Hel" }, "Hel"),
      A("run-1", 2, "assistant", { text: "Hello", delta: "lo", itemId: "run-1:1" }),
      C("run-1", 3, "delta", { deltaText: "lo" }, "Hello"),
    ]);
    expect(only(activity)).toMatchObject({
      textSource: "chat",
      text: "Hello",
      textComplete: false,
    });
  });

  it("takes text from agent assistant events when they come first, and never double-counts", () => {
    const { activity } = play([
      A("run-1", 1, "assistant", { text: "Hel", delta: "Hel", itemId: "run-1:1" }),
      A("run-1", 2, "assistant", { text: "Hello", delta: "lo", itemId: "run-1:1" }),
      C("run-1", 3, "delta", { deltaText: "lo" }, "HelloHello"),
    ]);
    expect(only(activity)).toMatchObject({ textSource: "agent", text: "Hello" });
  });

  it("keeps the text of a reply cut off by a failed run, and marks it incomplete", () => {
    const { activity } = play([
      C("run-1", 1, "delta", { deltaText: "Partial" }, "Partial"),
      C("run-1", 2, "error", { errorMessage: "provider overloaded" }),
    ]);
    expect(only(activity)).toMatchObject({ state: "failed", text: "Partial", textComplete: false });
  });
});

describe("steps from tool events (F-090, F-091, F-093, F-294, F-432)", () => {
  it("builds ordered reasoning and tool steps with the raw call and result as sent", () => {
    const { activity } = play(toolRun());
    const run = only(activity);
    expect(run.steps.map(view)).toEqual([
      {
        id: "reasoning:run-1:s:0",
        kind: "reasoning",
        title: "Reasoning",
        toolName: null,
        toolCallId: null,
        status: "done",
        args: null,
        output: "Look before guessing.",
        result: null,
        error: null,
        failureKind: null,
      },
      {
        id: "tool:call_1",
        kind: "tool",
        title: "Ls",
        toolName: "ls",
        toolCallId: "call_1",
        status: "done",
        args: JSON.stringify({ path: "." }, null, 2),
        output: null,
        result: '"AGENTS.md"\n"notes/"',
        error: null,
        failureKind: null,
      },
      {
        id: "reasoning:run-1:t.call_1:0",
        kind: "reasoning",
        title: "Reasoning",
        toolName: null,
        toolCallId: null,
        status: "done",
        args: null,
        output: "Now answer.",
        result: null,
        error: null,
        failureKind: null,
      },
    ]);
    const tool = run.steps[1]!;
    expect(tool).toMatchObject({ startedAt: 1_005, endedAt: 1_008 });
    expect(tool.raw).toEqual({
      source: "live",
      runId: "run-1",
      call: { phase: "start", name: "ls", toolCallId: "call_1", args: { path: "." } },
      result: {
        phase: "result",
        name: "ls",
        toolCallId: "call_1",
        isError: false,
        result: lsResult,
      },
    });
  });

  it("a run with reasoning and no tool still has steps (F-423)", () => {
    const { activity } = play([
      A("run-1", 1, "lifecycle", { phase: "start" }),
      A("run-1", 2, "lifecycle", { phase: "model" }),
      A("run-1", 3, "thinking", { text: "Short", delta: "Short" }),
      A("run-1", 4, "assistant", { text: "Echo: hi", delta: "Echo: hi", itemId: "run-1:1" }),
      A("run-1", 5, "lifecycle", { phase: "finishing" }),
      A("run-1", 6, "lifecycle", { phase: "model" }),
      A("run-1", 7, "lifecycle", { phase: "end", aborted: false }),
    ]);
    const run = only(activity);
    expect(run.steps.map((step) => [step.kind, step.status, step.output?.text])).toEqual([
      ["reasoning", "done", "Short"],
    ]);
    expect(run.steps[0]!.raw).toMatchObject({
      source: "live",
      call: { stream: "thinking", seq: 3 },
    });
  });

  it("a plain reply with no exposed reasoning has no steps (F-423)", () => {
    const { activity } = play([
      A("run-1", 1, "lifecycle", { phase: "start" }),
      C("run-1", 2, "final", { message: { role: "assistant", content: "Echo: hi" } }),
    ]);
    expect(only(activity).steps).toEqual([]);
  });

  it("starts a new reasoning segment when the text does not extend the previous one", () => {
    const { activity } = play([
      A("run-1", 1, "thinking", { text: "First thought", delta: "First thought" }),
      A("run-1", 2, "thinking", { text: "Second", delta: "Second" }),
    ]);
    expect(only(activity).steps.map((step) => [step.id, step.status, step.output?.text])).toEqual([
      ["reasoning:run-1:s:0", "done", "First thought"],
      ["reasoning:run-1:s:1", "running", "Second"],
    ]);
  });

  it("shows partial output while a tool runs (F-432)", () => {
    const { activity } = play([
      A("run-1", 1, "tool", {
        phase: "start",
        name: "read",
        toolCallId: "c1",
        args: { path: "a" },
      }),
      A("run-1", 2, "tool", {
        phase: "update",
        name: "read",
        toolCallId: "c1",
        partialResult: { content: [{ type: "text", text: "line 1" }], details: {} },
      }),
    ]);
    expect(only(activity).steps[0]).toMatchObject({
      status: "running",
      output: { text: "line 1" },
    });
  });

  it("every tool error is a failed step with the error text and failure kind (F-294)", () => {
    const { activity } = play([
      A("run-1", 1, "tool", {
        phase: "start",
        name: "exec",
        toolCallId: "c1",
        args: { command: "sleep 99" },
      }),
      A("run-1", 2, "tool", {
        phase: "result",
        name: "exec",
        toolCallId: "c1",
        isError: true,
        result: {
          content: [{ type: "text", text: "Command timed out" }],
          details: {
            status: "failed",
            failureKind: "overall-timeout",
            timedOut: true,
            exitSignal: "SIGTERM",
          },
        },
      }),
      A("run-1", 3, "tool", {
        phase: "start",
        name: "exec",
        toolCallId: "c2",
        args: { command: "false" },
      }),
      A("run-1", 4, "tool", {
        phase: "result",
        name: "exec",
        toolCallId: "c2",
        isError: false,
        result: {
          content: [{ type: "text", text: "(Command exited with code 1)" }],
          details: { status: "completed", exitCode: 1, exitReason: "exit" },
        },
      }),
    ]);
    const [timedOut, nonZero] = only(activity).steps;
    expect(timedOut).toMatchObject({
      status: "failed",
      error: "Command timed out",
      failureKind: "overall-timeout",
    });
    // A non-zero exit is not an error.
    expect(nonZero).toMatchObject({ status: "done", error: null, failureKind: null });
  });

  it("keeps bot-to-bot and MCP calls as ordinary steps with their names and arguments", () => {
    const sendArgs = {
      sessionKey: "agent:atlas:main",
      message: "Please list three colours.",
      timeoutSeconds: 60,
    };
    const { activity } = play([
      A("run-1", 1, "tool", {
        phase: "start",
        name: "sessions_send",
        toolCallId: "c1",
        args: sendArgs,
      }),
      A("run-1", 2, "tool", {
        phase: "result",
        name: "sessions_send",
        toolCallId: "c1",
        isError: false,
        result: {
          content: [{ type: "text", text: "ok" }],
          details: {
            runId: "run-9",
            sessionKey: "agent:atlas:main",
            status: "ok",
            reply: "Red, green, blue.",
          },
        },
      }),
      A("run-1", 3, "tool", {
        phase: "start",
        name: "coder__send_message",
        toolCallId: "c2",
        args: { message: "Fix the failing login test" },
      }),
    ]);
    const [send, mcp] = only(activity).steps;
    expect(send).toMatchObject({ kind: "tool", toolName: "sessions_send", status: "done" });
    expect((send!.raw!.call as { args: unknown }).args).toEqual(sendArgs);
    expect(
      (send!.raw!.result as { result: { details: { reply: string } } }).result.details.reply,
    ).toBe("Red, green, blue.");
    expect(mcp).toMatchObject({
      kind: "tool",
      toolName: "coder__send_message",
      title: "Coder Send Message",
    });
  });

  it("keeps long output without carrying it on every snapshot", () => {
    const huge = "x".repeat(MAX_STEP_TEXT * 4);
    let { activity } = play([
      A("run-1", 1, "tool", { phase: "start", name: "exec", toolCallId: "c1", args: {} }),
    ]);
    for (let seq = 2; seq < 12; seq += 1) {
      activity = play(
        [A("run-1", seq, "command_output", { itemId: "command:c1", phase: "delta", output: huge })],
        activity,
      ).activity;
    }
    const streaming = only(activity).steps[0]!;
    expect(streaming.output!.text.length).toBe(MAX_STEP_TEXT);
    expect(streaming.output!.totalChars).toBe(huge.length * 10);

    activity = play(
      [
        A("run-1", 12, "tool", {
          phase: "result",
          name: "exec",
          toolCallId: "c1",
          isError: false,
          result: { content: [{ type: "text", text: huge }], details: {} },
        }),
      ],
      activity,
    ).activity;
    const done = only(activity).steps[0]!;
    // Its start, and its end and line count as they arrived, where a tool writes its notices.
    expect(done.result).toMatchObject({
      text: huge.slice(0, MAX_STEP_TEXT),
      totalChars: huge.length,
      tail: huge.slice(-400),
    });
    // Too large to travel inline; the exact payload stays in the raw table.
    expect(done.raw).toBeNull();
    expect(done.rawSize).toBeGreaterThan(RAW_INLINE_LIMIT);
    const kept = raw.get(KEY, "tool:c1")!;
    expect(
      (kept.result as { result: { content: Array<{ text: string }> } }).result.content[0]!.text,
    ).toBe(huge);
  });
});

describe("sequence numbers (F-107)", () => {
  it("drops repeated and older frames, so cumulative text and output never restart or double", () => {
    const frames = toolRun().slice(0, 4);
    const once = play(frames).activity;
    const replayed = play([...frames, frames[2]!, frames[3]!, frames[1]!]).activity;
    expect(replayed).toEqual(once);
    let output = play([
      A("run-1", 1, "tool", { phase: "start", name: "exec", toolCallId: "c1", args: {} }),
    ]).activity;
    const delta = A("run-1", 2, "command_output", {
      itemId: "command:c1",
      phase: "delta",
      output: "line\n",
    });
    output = play([delta, delta], output).activity;
    expect(output.runs[0]!.steps[0]!.output?.text).toBe("line\n");
  });

  it("treats a forward jump as coalescing, not loss: the run goes on", () => {
    const frames = toolRun();
    const { activity } = play([...frames.slice(0, 3), ...frames.slice(6)]);
    expect(only(activity).state).toBe("completed");
  });
});

describe("rebuilding from history (F-107, F-093)", () => {
  it("F-120: a run a message from another bot started is anchored to that message's row, by the run's key", () => {
    // As chat.history shows it in the recipient's task: the incoming message is an assistant
    // row with inter-session provenance and the key `${runId}:user` of the run it started.
    const rows = [
      { role: "user", content: "Reply with a note.", __openclaw: { id: "u1", seq: 1 } },
      {
        role: "assistant",
        content: [{ type: "text", text: "A note." }],
        __openclaw: { id: "a1", seq: 2, runId: "run-1" },
      },
      {
        role: "assistant",
        content: "Could you look over the plan?",
        idempotencyKey: "run-2:user",
        provenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:atlas:main",
          sourceTool: "sessions_send",
        },
        __openclaw: { id: "m1", seq: 3, idempotencyKey: "run-2:user" },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Happy to help." }],
        __openclaw: { id: "a2", seq: 4, runId: "run-2" },
      },
    ];
    const runs = runsFromHistory(rows, null, ctx());
    expect(runs.map((run) => [run.id, run.anchorItemId])).toEqual([
      ["run-1", "u1:0"],
      ["run-2", "m1:2"],
    ]);
  });

  it("gives the same runs and steps a reload shows as the live stream did", () => {
    const live = only(play(toolRun()).activity);
    raw = new RawTable();
    const [rebuilt] = runsFromHistory(toolRunHistory, null, ctx());
    expect(rebuilt).toMatchObject({
      id: "run-1",
      state: "completed",
      anchorItemId: "u1:0",
      model: "dev-1",
    });
    // The same steps in the same order; a rebuilt reasoning segment's id is in the history namespace.
    const withoutReasoningId = (step: Parameters<typeof view>[0]) =>
      step.kind === "reasoning" ? { ...view(step), id: null } : view(step);
    expect(rebuilt!.steps.map(withoutReasoningId)).toEqual(live.steps.map(withoutReasoningId));
    expect(rebuilt!.steps[0]!.id).toBe("reasoning:run-1:s:0");
    expect(rebuilt!.steps[1]!.raw).toEqual({
      source: "history",
      runId: "run-1",
      call: toolRunHistory[1]!.content[1],
      result: toolRunHistory[2],
    });
  });

  it("reads stopped and failed runs, the in-flight run, and the truncated flag", () => {
    const rows = [
      { role: "user", content: "a", __openclaw: { id: "u1", seq: 1 } },
      {
        role: "assistant",
        content: "cut",
        stopReason: "aborted",
        __openclaw: { id: "a1", seq: 2, runId: "r1" },
      },
      { role: "user", content: "b", __openclaw: { id: "u2", seq: 3 } },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "c1", name: "exec", arguments: {} }],
        __openclaw: { id: "a2", seq: 4, runId: "r2" },
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        content: [{ type: "text", text: "y".repeat(8_000) }],
        isError: false,
        __openclaw: { id: "t2", seq: 5, runId: "r2", truncated: true, reason: "size" },
      },
      {
        role: "assistant",
        content: "oops",
        stopReason: "error",
        errorMessage: "provider down",
        __openclaw: { id: "a3", seq: 6, runId: "r2" },
      },
      { role: "user", content: "c", __openclaw: { id: "u3", seq: 7 } },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "c3", name: "read", arguments: {} }],
        __openclaw: { id: "a4", seq: 8, runId: "r3" },
      },
    ];
    const runs = runsFromHistory(rows, "r3", ctx());
    expect(runs.map((run) => [run.id, run.state, run.anchorItemId])).toEqual([
      ["r1", "stopped", "u1:0"],
      ["r2", "failed", "u2:2"],
      ["r3", "running", "u3:6"],
    ]);
    expect(runs[1]!.error?.message).toBe("provider down");
    expect(runs[1]!.steps[0]).toMatchObject({ status: "done", truncated: true });
    expect(runs[2]!.steps[0]!.status).toBe("running");
  });

  it("merges a reload into live runs without duplicating runs or steps", () => {
    const live = play(toolRun()).activity;
    const history = runsFromHistory(toolRunHistory, null, ctx());
    const merged = mergeHistoryRuns(live.runs, history, ctx()).runs;
    expect(merged).toHaveLength(1);
    expect(merged[0]!.steps).toHaveLength(3);
    // Live raw frames win over history ones for steps the user watched.
    expect(merged[0]!.steps[1]!.raw?.source).toBe("live");
  });

  it("recovers a terminal state lost in a gap from history", () => {
    const live = play(toolRun().slice(0, 8)).activity;
    expect(only(live).state).toBe("running");
    const merged = mergeHistoryRuns(
      live.runs,
      runsFromHistory(toolRunHistory, null, ctx()),
      ctx(),
    ).runs;
    expect(merged[0]!.state).toBe("completed");
    // Ids are their places: the segment seen live keeps its id, the one lost in the gap takes its own.
    expect(merged[0]!.steps.map((step) => step.id)).toEqual([
      "reasoning:run-1:s:0",
      "tool:call_1",
      "reasoning:run-1:t.call_1:0",
    ]);
  });

  it("keeps a run history does not know yet, and keeps queued runs last", () => {
    let activity = play(toolRun()).activity;
    activity = startLocalRun(activity, message("m2"), 2_000);
    activity = queueLocalRun(activity, message("m3", { mode: "queue", status: "queued" }), 2_100);
    const merged = mergeHistoryRuns(
      activity.runs,
      runsFromHistory(toolRunHistory, null, ctx()),
      ctx(),
    ).runs;
    expect(merged.map((run) => [run.id, run.state])).toEqual([
      ["run-1", "completed"],
      ["m2", "running"],
      ["m3", "queued"],
    ]);
  });
});

describe("outbox reconciliation (F-075, F-107)", () => {
  const rows = [
    { role: "user", content: "older", __openclaw: { id: "u0", seq: 3 } },
    { role: "user", content: "Clear it.", __openclaw: { id: "u1", seq: 6, idempotencyKey: "m1" } },
    { role: "user", content: [{ type: "text", text: "Second" }], __openclaw: { id: "u2", seq: 8 } },
    { role: "user", content: "Third one", __openclaw: { id: "u3", seq: 10 } },
  ];

  it("matches by idempotency key, then by messageSeq, and never by text", () => {
    let activity: TaskActivity = {
      ...emptyActivity,
      outbox: [
        message("m1", { status: "sent" }),
        message("m2", { status: "sent", text: "Second", messageSeq: 8 }),
        message("m3", { status: "failed", text: "Third one" }),
        message("m5", { status: "queued", text: "Later" }),
      ],
    };
    activity = startLocalRun(activity, activity.outbox[0]!, 1_000);
    activity = reconcileOutbox(activity, rows);
    // m3's text is in history, but nothing ties that row to it: it stays to be retried or deleted.
    expect(activity.outbox.map((each) => each.id)).toEqual(["m3", "m5"]);
    expect(only(activity, "m1")).toMatchObject({ messageId: null, anchorItemId: "u1:1" });
  });

  it("is idempotent, so reloading twice never duplicates a message", () => {
    const activity: TaskActivity = {
      ...emptyActivity,
      outbox: [message("m1", { status: "sent" })],
    };
    const once = reconcileOutbox(activity, rows);
    expect(reconcileOutbox(once, rows)).toBe(once);
    expect(once.outbox).toEqual([]);
  });
});

function questionRecord(id: string, runId = "run-1") {
  return {
    id,
    questions: [
      {
        questionId: "color",
        header: "Color",
        question: "Which color?",
        options: [{ label: "Blue" }, { label: "Green", description: "Like grass" }],
        isOther: true,
      },
    ],
    agentId: "otto",
    sessionKey: KEY,
    runId,
    createdAtMs: 2_000,
    expiresAtMs: 902_000,
    status: "pending",
  };
}

describe("question cards", () => {
  it("maps the record the gateway sent, keeping it raw", () => {
    const record = questionRecord("ask_1");
    const activity = applyQuestionRequested(emptyActivity, record, ctx());
    expect(activity.questions).toEqual([
      {
        id: "ask_1",
        runId: "run-1",
        status: "pending",
        questions: [
          {
            id: "color",
            header: "Color",
            question: "Which color?",
            options: [
              { index: 0, label: "Blue", description: null, value: null },
              { index: 1, label: "Green", description: "Like grass", value: null },
            ],
            optionsOmitted: 0,
            multiSelect: false,
            allowsOther: true,
          },
        ],
        createdAt: 2_000,
        expiresAt: 902_000,
        answers: null,
        submitting: false,
        error: null,
        raw: record,
        ordinary: true,
        sent: null,
        settledBy: [],
      },
    ]);
    // A question for a run not seen yet brings the run in, waiting.
    expect(only(activity).state).toBe("waiting");
  });

  it("does not reopen a stopping run", () => {
    let { activity } = play([A("run-1", 1, "lifecycle", { phase: "start" })]);
    activity = requestStop(activity, "run-1", 3_000);
    activity = applyQuestionRequested(activity, questionRecord("ask_1"), ctx());
    expect(only(activity)).toMatchObject({ state: "stopping", pendingCards: [] });
  });
});

describe("structured endings and best-effort reasoning segments", () => {
  it("keeps the terminal event's own timeout fields rather than reading the error text", () => {
    const { activity } = play([
      A("run-1", 1, "lifecycle", { phase: "start" }),
      A("run-1", 2, "lifecycle", {
        phase: "error",
        error: "Request timed out",
        stopReason: "timeout",
        timeoutPhase: "model",
        providerStarted: true,
      }),
    ]);
    expect(only(activity)).toMatchObject({
      state: "failed",
      ending: { stopReason: "timeout", timeoutPhase: "model", providerStarted: true, status: null },
    });
    const chatTimeout = play([
      C("run-2", 1, "error", { errorMessage: "Timed out", errorKind: "timeout" }),
    ]).activity;
    expect(only(chatTimeout, "run-2").error).toMatchObject({
      message: "Timed out",
      kind: "timeout",
    });
  });

  it("a wrong live split never duplicates reasoning once history has the run", () => {
    // A replacement update that does not extend the text looks like a new segment live.
    const live = play([
      A("run-1", 1, "thinking", { text: "Check the disk", delta: "Check the disk" }),
      A("run-1", 2, "thinking", { text: "Check the cache first", delta: "Check the cache first" }),
      A("run-1", 3, "lifecycle", { phase: "end", aborted: false }),
    ]).activity;
    expect(only(live).steps.filter((step) => step.kind === "reasoning")).toHaveLength(2);
    const history = runsFromHistory(
      [
        { role: "user", content: "go", __openclaw: { id: "u1", seq: 1 } },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Check the cache first" },
            { type: "text", text: "Done" },
          ],
          stopReason: "stop",
          __openclaw: { id: "a1", seq: 2, runId: "run-1" },
        },
      ],
      null,
      ctx(),
    );
    const merged = mergeHistoryRuns(live.runs, history, ctx()).runs;
    expect(merged[0]!.steps.map((step) => step.output?.text)).toEqual(["Check the cache first"]);
  });

  it("does not add history reasoning to a run still in flight, so nothing shows twice", () => {
    const live = play([A("run-1", 1, "thinking", { text: "Looking", delta: "Looking" })]).activity;
    const history = runsFromHistory(
      [
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "Looking at it" }],
          __openclaw: { id: "a1", seq: 2, runId: "run-1" },
        },
      ],
      "run-1",
      ctx(),
    );
    const merged = mergeHistoryRuns(live.runs, history, ctx()).runs;
    expect(merged[0]!.steps.map((step) => step.output?.text)).toEqual(["Looking"]);
  });
});

describe("text beside a tool call (conversation.md 7.6)", () => {
  it("keeps a preamble item before the call it came with, its updates in place, and the call's projections", () => {
    let activity = emptyActivity;
    const apply = (seq: number, stream: string, data: Record<string, unknown>) => {
      activity = applyAgentEvent(activity, agent("run-1", seq, stream, data), ctx()).activity;
    };
    apply(1, "lifecycle", { phase: "start" });
    apply(2, "item", { kind: "preamble", itemId: "p1", phase: "update", progressText: "Reading" });
    apply(3, "item", {
      kind: "preamble",
      itemId: "p1",
      phase: "update",
      progressText: "Reading the log first.",
    });
    apply(4, "item", {
      kind: "preamble",
      itemId: "p1",
      phase: "end",
      progressText: "Reading the log first.",
    });
    apply(5, "item", {
      kind: "tool",
      toolCallId: "c1",
      name: "exec",
      phase: "start",
      commandBearing: true,
    });
    apply(6, "tool", {
      toolCallId: "c1",
      name: "exec",
      phase: "start",
      args: { command: "du -sh /srv", content: "x".repeat(9000) },
    });
    apply(7, "tool", {
      toolCallId: "c1",
      name: "exec",
      phase: "result",
      result: {
        content: [{ type: "text", text: "1G" }],
        details: { status: "completed", exitCode: 0, aggregated: "y".repeat(9000) },
      },
    });
    const run = only(activity);
    expect(run.preambles).toEqual([
      { id: "p1", text: "Reading the log first.", ended: true, beforeCall: "c1" },
    ]);
    expect(run.steps[0]).toMatchObject({
      commandBearing: true,
      args: { command: "du -sh /srv" },
      details: { status: "completed", exitCode: 0 },
    });
    expect(run.steps[0]!.details).not.toHaveProperty("aggregated");
  });
});

describe("text beside a tool call on a gateway that sends no preamble item (OpenClaw 2026.11.10)", () => {
  const BESIDE = "I will look first, then answer that message.";
  const ANSWER = "This answers m-1.";
  /** One `assistant` item: its first event carries `text`, the next only `delta`, as both versions send. */
  const said = (seq: number, itemId: string, text: string): Frame[] => {
    const cut = Math.ceil(text.length / 2);
    return [
      A("run-1", seq, "assistant", { text: text.slice(0, cut), delta: text.slice(0, cut), itemId }),
      A("run-1", seq + 1, "assistant", { delta: text.slice(cut), itemId }),
    ];
  };
  const itemTool = (seq: number, id: string, phase: string): Frame =>
    A("run-1", seq, "item", { itemId: `tool:${id}`, toolCallId: id, name: "ls", kind: "tool", phase });
  const tool = (seq: number, id: string, phase: string): Frame =>
    A("run-1", seq, "tool", {
      toolCallId: id,
      name: "ls",
      phase,
      ...(phase === "start" ? { args: { path: "." } } : { result: lsResult }),
    });
  /** A call as its sender sees it: the item, then the tool events. */
  const call = (seq: number, id: string): Frame[] => [
    itemTool(seq, id, "start"),
    tool(seq + 1, id, "start"),
    tool(seq + 2, id, "result"),
    itemTool(seq + 3, id, "end"),
  ];
  const start = A("run-1", 1, "lifecycle", { phase: "start", startedAt: 1_001 });
  const end = (seq: number): Frame[] => [
    A("run-1", seq, "lifecycle", { phase: "end", endedAt: 2_000 }),
    // 2026.11.10's final message joins every text of the run with blank lines.
    C("run-1", seq + 1, "final", {
      message: { role: "assistant", content: [{ type: "text", text: `${BESIDE}\n\n${ANSWER}` }] },
    }),
  ];

  it("F-088: the text streaming when a call starts is the text beside that call, and the answer after it is the reply", () => {
    const run = only(
      play([start, ...said(2, "s:1", BESIDE), ...call(4, "c1"), ...said(8, "s:2", ANSWER), ...end(10)])
        .activity,
    );
    expect(run.preambles).toEqual([{ id: "s:1", text: BESIDE, ended: true, beforeCall: "c1" }]);
    expect(run.text).toBe(ANSWER);
    expect(run.state).toBe("completed");
  });

  it("F-088: a client that did not send the message sees only the call's item, and places the text the same way", () => {
    const frames = [start, ...said(2, "s:1", BESIDE), itemTool(4, "c1", "start")];
    const live = only(play(frames).activity);
    expect(live.preambles).toEqual([{ id: "s:1", text: BESIDE, ended: true, beforeCall: "c1" }]);
    // Until the next text comes, the run's text is the same text: shown once, beside its call.
    expect(live.text).toBe(BESIDE);
  });

  it("F-088: the sender's tool start alone places it too", () => {
    const run = only(play([start, ...said(2, "s:1", BESIDE), tool(4, "c1", "start")]).activity);
    expect(run.preambles).toEqual([{ id: "s:1", text: BESIDE, ended: true, beforeCall: "c1" }]);
  });

  it("F-088: text beside each of two calls stays beside its own call, in order", () => {
    const second = "The coding agent picked it up.";
    const run = only(
      play([
        start,
        ...said(2, "s:1", BESIDE),
        ...call(4, "c1"),
        ...said(8, "s:2", second),
        ...call(10, "c2"),
        ...said(14, "s:3", ANSWER),
        ...end(16),
      ]).activity,
    );
    expect(run.preambles).toEqual([
      { id: "s:1", text: BESIDE, ended: true, beforeCall: "c1" },
      { id: "s:2", text: second, ended: true, beforeCall: "c2" },
    ]);
    expect(run.text).toBe(ANSWER);
  });

  it("F-088: two calls of one message share its text, which stays before the first", () => {
    const run = only(
      play([start, ...said(2, "s:1", BESIDE), ...call(4, "c1"), ...call(8, "c2")]).activity,
    );
    expect(run.preambles).toEqual([{ id: "s:1", text: BESIDE, ended: true, beforeCall: "c1" }]);
  });

  it("F-088: a run keeps the texts beside its newest calls, within the bound", () => {
    const frames: Frame[] = [start];
    for (let i = 1; i <= MAX_PREAMBLES_PER_RUN + 2; i += 1)
      frames.push(...said(i * 10, `s:${i}`, `Step ${i} next.`), ...call(i * 10 + 2, `c${i}`));
    const run = only(play(frames).activity);
    expect(run.preambles?.map((p) => p.beforeCall)).toEqual(
      Array.from({ length: MAX_PREAMBLES_PER_RUN }, (_, i) => `c${i + 3}`),
    );
  });

  it("F-088: a call with no text before it, or after text already placed, adds none", () => {
    expect(only(play([start, ...call(2, "c1"), ...said(6, "s:2", ANSWER)]).activity).preambles).toBe(
      undefined,
    );
    const blank = only(play([start, ...said(2, "s:1", "  \n"), ...call(4, "c1")]).activity);
    expect(blank.preambles).toBe(undefined);
  });

  it("F-088: on 2026.10.6, whose preamble item holds the text, nothing is added", () => {
    // `#reply-to` on 2026.10.6: the text is also on the assistant stream, then the item comes.
    const preamble = (seq: number, phase: string): Frame =>
      A("run-1", seq, "item", {
        kind: "preamble",
        title: "Preamble",
        phase,
        progressText: BESIDE,
        itemId: "commentary-0-a1",
      });
    const run = only(
      play([
        start,
        ...said(2, "s:1", BESIDE),
        preamble(4, "update"),
        preamble(5, "end"),
        ...call(6, "c1"),
        // A second message with only a call: the stream's text is still the first item's.
        ...call(10, "c2"),
        ...said(14, "s:2", ANSWER),
        A("run-1", 16, "lifecycle", { phase: "end", endedAt: 2_000 }),
        C("run-1", 17, "final", {
          message: { role: "assistant", content: [{ type: "text", text: ANSWER }] },
        }),
      ]).activity,
    );
    expect(run.preambles).toEqual([
      { id: "commentary-0-a1", text: BESIDE, ended: true, beforeCall: "c1" },
    ]);
    // `#think #steps` on 2026.10.6: the text is only in the item.
    const quiet = only(play([start, preamble(2, "update"), preamble(3, "end"), ...call(4, "c1")]).activity);
    expect(quiet.preambles).toEqual([
      { id: "commentary-0-a1", text: BESIDE, ended: true, beforeCall: "c1" },
    ]);
  });

  it("F-088: a preamble item that came with other words still keeps its call, and the stream's text is not added beside it", () => {
    const run = only(
      play([
        start,
        ...said(2, "s:1", `${BESIDE} [[reply_to_current]]`),
        A("run-1", 4, "item", { kind: "preamble", phase: "end", progressText: BESIDE, itemId: "p" }),
        ...call(5, "c1"),
      ]).activity,
    );
    expect(run.preambles).toEqual([{ id: "p", text: BESIDE, ended: true, beforeCall: "c1" }]);
  });

  it("F-088: text with no item id, or from the chat stream alone, stays the run's text", () => {
    const bare = only(
      play([
        start,
        A("run-1", 2, "assistant", { text: BESIDE, delta: BESIDE }),
        ...call(3, "c1"),
      ]).activity,
    );
    expect(bare.preambles).toBe(undefined);
    expect(bare.text).toBe(BESIDE);
    const chatOnly = only(
      play([
        start,
        C("run-1", 2, "delta", {}, BESIDE),
        itemTool(3, "c1", "start"),
      ]).activity,
    );
    expect(chatOnly.preambles).toBe(undefined);
    expect(chatOnly.text).toBe(BESIDE);
  });
});

describe("retention says what it dropped, where (round 1, items 2 and 5)", () => {
  /** A run of `n` finished reads, with text written before call `textBefore`. */
  function longRun(n: number, textBefore: number) {
    let activity = emptyActivity;
    let seq = 0;
    const apply = (stream: string, data: Record<string, unknown>) => {
      seq += 1;
      activity = applyAgentEvent(activity, agent("run-1", seq, stream, data), ctx()).activity;
    };
    apply("lifecycle", { phase: "start", startedAt: 1_000 });
    for (let i = 1; i <= n; i += 1) {
      if (i === textBefore)
        apply("item", {
          kind: "preamble",
          itemId: "p",
          phase: "end",
          progressText: "Now the last ones.",
        });
      apply("tool", {
        toolCallId: `c${i}`,
        name: "read",
        phase: "start",
        args: { path: `f${i}.md` },
      });
      apply("tool", {
        toolCallId: `c${i}`,
        name: "read",
        phase: "result",
        result: { content: [{ type: "text", text: "x" }] },
      });
      activity = retainActivity(activity);
    }
    apply("lifecycle", { phase: "end", endedAt: 90_000 });
    return only(retainActivity(activity));
  }

  it("keeps 128 of 400 calls and counts the 272 others, as actions and in line before the first kept", () => {
    const run = longRun(400, 390);
    const tools = run.steps.filter((step) => step.kind === "tool");
    expect(tools).toHaveLength(128);
    expect(run.omittedTools).toBe(272);
    expect(tools[0]!.omittedBefore).toBe(272);
    expect(tools.slice(1).every((step) => !step.omittedBefore)).toBe(true);
  });

  it("anchors text by its call's id, so dropping older calls never moves it", () => {
    const run = longRun(400, 390);
    expect(run.preambles).toEqual([
      { id: "p", text: "Now the last ones.", ended: true, beforeCall: "c390" },
    ]);
    expect(run.steps.some((step) => step.toolCallId === "c390")).toBe(true);
  });

  it("moves text before a dropped call to the next call kept", () => {
    const run = longRun(400, 5);
    expect(run.preambles?.[0]?.beforeCall).toBe(
      run.steps.find((s) => s.kind === "tool")!.toolCallId,
    );
  });
});

describe("times history rows give are not the call's own", () => {
  it("marks steps and runs built from rows, so no duration is read from them", () => {
    const rows = [
      { role: "user", content: "Read it.", timestamp: 1_000, __openclaw: { id: "u1" } },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.md" } }],
        timestamp: 2_000,
        __openclaw: { id: "a1", runId: "run-h" },
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read",
        content: [{ type: "text", text: "x" }],
        timestamp: 2_200,
        __openclaw: { id: "r1", runId: "run-h" },
      },
    ];
    const [run] = runsFromHistory(rows, null, ctx());
    expect(run!.endFromRows).toBe(true);
    expect(run!.steps[0]!.rowTimes).toBe(true);
  });
});

describe("the gateway's title for a call", () => {
  it("is kept from its item events, as sent", () => {
    let activity = emptyActivity;
    activity = applyAgentEvent(
      activity,
      agent("run-1", 1, "lifecycle", { phase: "start" }),
      ctx(),
    ).activity;
    activity = applyAgentEvent(
      activity,
      agent("run-1", 2, "item", {
        kind: "tool",
        toolCallId: "c1",
        name: "skills_search",
        phase: "start",
        title: "Skill Search",
      }),
      ctx(),
    ).activity;
    expect(only(activity).steps[0]!.gatewayTitle).toBe("Skill Search");
  });
});

describe("a run settled from its agent.wait record (F-097)", () => {
  const started = () => play([A("run-1", 1, "lifecycle", { phase: "start" })]).activity;
  const wait = (activity: TaskActivity, record: Record<string, unknown>) =>
    settleRunFromWait(activity, "run-1", { runId: "run-1", ...record }, ctx());

  it("F-097: a record of a run still going, or one the gateway does not know, leaves it running", () => {
    expect(only(wait(started(), { status: "timeout" })).state).toBe("running");
    expect(only(wait(started(), { status: "pending", timeoutPhase: "queue" })).state).toBe(
      "running",
    );
  });

  it("F-097: a run cut short by revoked access ends as stopped, as OpenClaw reads the record", () => {
    const record = {
      status: "error",
      error: "unauthorized",
      stopReason: "auth-revoked",
      endedAt: 4_000,
    };
    expect(only(wait(started(), record))).toMatchObject({ state: "stopped", endedAt: 4_000 });
  });

  it("F-097: the gateway's end replaces one only inferred, and not one established", () => {
    const inferred: TaskActivity = {
      ...started(),
      runs: [{ ...only(started()), state: "completed", outcomeKnown: false, endedAt: 3_000 }],
    };
    const record = { status: "error", error: "aborted", stopReason: "rpc", endedAt: 4_000 };
    expect(only(wait(inferred, record))).toMatchObject({
      state: "stopped",
      outcomeKnown: true,
      endedAt: 4_000,
    });
    const established = { ...inferred, runs: [{ ...only(inferred), outcomeKnown: true }] };
    expect(only(wait(established, record)).state).toBe("completed");
  });
});
