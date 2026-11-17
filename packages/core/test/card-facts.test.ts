// Message cards claim no more than the gateway establishes: an explicit
// correction of a tool result is honoured even by a view that keeps state, a
// request time is not a delivery time, an uncertain recipient outcome stays
// uncertain, and a returned error stays visible when Stop wins the sender's run.

import { beforeEach, describe, expect, it } from "vitest";
import {
  linkedRunOf,
  selectMessageCards,
  type CardOptions,
  type LinkedRun,
  type SelectedCards,
} from "../src/cards.ts";
import {
  applyAgentEvent,
  emptyActivity,
  mergeHistoryRuns,
  RawTable,
  requestStop,
  runsFromHistory,
  settleVanishedRuns,
  type EngineContext,
  type Step,
  type TaskActivity,
} from "../src/runs.ts";

const KEY = "agent:pixel:main";
const PEER = "agent:atlas:main";
let raw: RawTable;
const ctx = (): EngineContext => ({ sessionKey: KEY, now: 5_000, raw });
beforeEach(() => {
  raw = new RawTable();
});

let seq = 0;
const event = (
  activity: TaskActivity,
  stream: string,
  data: Record<string, unknown>,
  ts?: number,
  runId = "run-s",
) => {
  seq += 1;
  return applyAgentEvent(
    activity,
    { runId, seq, stream, ts: ts ?? 1_000 + seq, sessionKey: KEY, data },
    ctx(),
  ).activity;
};

const MCP: CardOptions = {
  codingServers: ["coder"],
  mcpTools: { coder__send_message: { server: "coder", tool: "send_message" } },
};
const rawOf = (step: Step) => step.raw ?? raw.get(KEY, step.id);
const select = (
  activity: TaskActivity,
  extra: { previous?: SelectedCards; linkedRuns?: Record<string, LinkedRun> } = {},
) =>
  selectMessageCards(
    { runs: activity.runs, approvals: activity.approvals, linkedRuns: extra.linkedRuns ?? {} },
    { ...MCP, rawOf, ...(extra.previous ? { previous: extra.previous } : {}) },
  );

const mcpStart = (activity: TaskActivity, ts?: number) =>
  event(
    activity,
    "tool",
    { phase: "start", name: "coder__send_message", toolCallId: "m1", args: { message: "Fix it" } },
    ts,
  );
const mcpResult = (
  activity: TaskActivity,
  fields: {
    isError?: boolean;
    text?: string;
    details?: Record<string, unknown>;
    replace?: boolean;
    replaceable?: boolean;
  },
  ts?: number,
) =>
  event(
    activity,
    "tool",
    {
      phase: "result",
      name: "coder__send_message",
      toolCallId: "m1",
      isError: fields.isError ?? false,
      ...(fields.replace ? { replace: true } : {}),
      ...(fields.replaceable ? { replaceable: true } : {}),
      result: {
        content: [{ type: "text", text: fields.text ?? "ok" }],
        details: { mcpServer: "coder", mcpTool: "send_message", ...fields.details },
      },
    },
    ts,
  );

const started = () => event(emptyActivity, "lifecycle", { phase: "start" });

describe("an explicit correction of a tool result (D4)", () => {
  it("replaces a failed state a view kept, for MCP cards, live", () => {
    let activity = mcpResult(mcpStart(started()), {
      isError: true,
      text: "timeout",
      replaceable: true,
    });
    const before = select(activity);
    expect(before.mcpCalls[0]).toMatchObject({ state: "failed", error: "timeout" });
    activity = mcpResult(activity, { text: "delivered", replace: true });
    const fresh = select(activity).mcpCalls[0]!;
    const withPrevious = select(activity, { previous: before }).mcpCalls[0]!;
    expect([activity.runs[0]!.steps[0]!.status, fresh.state, withPrevious.state]).toEqual([
      "done",
      "returned",
      "returned",
    ]);
    expect(withPrevious).toMatchObject({ error: null, correction: 1 });
    // A repeat of the same result is not a correction: the kept state holds.
    expect(select(activity, { previous: select(activity) }).mcpCalls[0]!.state).toBe("returned");
  });

  it("replaces a failed state a view kept, for Messaged cards", () => {
    let activity = event(started(), "tool", {
      phase: "start",
      name: "sessions_send",
      toolCallId: "s1",
      args: { sessionKey: PEER, message: "hi" },
    });
    const sendResult = (base: TaskActivity, status: string, extra: Record<string, unknown>) =>
      event(base, "tool", {
        phase: "result",
        name: "sessions_send",
        toolCallId: "s1",
        isError: status === "error",
        ...extra,
        result: {
          content: [{ type: "text", text: status }],
          details: { status, sessionKey: PEER },
        },
      });
    activity = sendResult(activity, "error", { replaceable: true });
    const before = select(activity);
    expect(before.botMessages[0]!.state).toBe("failed");
    activity = sendResult(activity, "ok", { replace: true });
    expect(select(activity, { previous: before }).botMessages[0]!.state).toBe("sent");
  });

  it("is the same after a resync that takes the transcript's canonical copy, and on a fresh mount", () => {
    let activity = mcpResult(mcpStart(started()), {
      isError: true,
      text: "timeout",
      replaceable: true,
    });
    activity = event(activity, "lifecycle", { phase: "end" });
    const before = select(activity);
    const rows = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "m1",
            name: "coder__send_message",
            arguments: { message: "Fix it" },
          },
        ],
        __openclaw: { id: "a1", seq: 1, runId: "run-s" },
      },
      {
        role: "toolResult",
        toolCallId: "m1",
        isError: false,
        content: [{ type: "text", text: "delivered" }],
        details: { mcpServer: "coder", mcpTool: "send_message" },
        __openclaw: { id: "t1", seq: 2, runId: "run-s" },
      },
    ];
    const scratch = new RawTable();
    const history = runsFromHistory(rows, null, { ...ctx(), raw: scratch });
    const merge = mergeHistoryRuns(activity.runs, history, ctx());
    for (const stepId of merge.fromHistory) raw.set(KEY, stepId, scratch.get(KEY, stepId)!);
    const resynced = { ...activity, runs: merge.runs };
    expect(select(resynced, { previous: before }).mcpCalls[0]!.state).toBe("returned");
    const freshRaw = (step: Step) => step.raw ?? scratch.get(KEY, step.id);
    expect(
      selectMessageCards({ runs: history }, { ...MCP, rawOf: freshRaw }).mcpCalls[0]!.state,
    ).toBe("returned");
  });
});

describe("a request time is not a sent time (D5)", () => {
  it("a start-only Messaged card says when it was requested and claims no sent time", () => {
    const activity = event(
      started(),
      "tool",
      {
        phase: "start",
        name: "sessions_send",
        toolCallId: "s1",
        args: { sessionKey: PEER, message: "hi" },
      },
      1_001,
    );
    expect(select(activity).botMessages[0]).toMatchObject({
      state: "started",
      requestedAt: 1_001,
      sentAt: null,
      resultAt: null,
      recipientRunId: null,
    });
  });

  it("an MCP call's result time is when its result was seen; a stopped, unreturned call has none", () => {
    const activity = mcpStart(started(), 2_000);
    expect(select(activity).mcpCalls[0]).toMatchObject({
      requestedAt: 2_000,
      sentAt: null,
      resultAt: null,
    });
    const stopped = event(requestStop(activity, "run-s", 2_100), "lifecycle", {
      phase: "end",
      aborted: true,
    });
    expect(select(stopped).mcpCalls[0]).toMatchObject({
      state: "unknown",
      sentAt: null,
      resultAt: null,
    });
    const returned = mcpResult(activity, {}, 2_500);
    expect(select(returned).mcpCalls[0]).toMatchObject({
      requestedAt: 2_000,
      sentAt: null,
      resultAt: 2_500,
    });
  });
});

describe("an uncertain recipient outcome stays uncertain (D6)", () => {
  function acceptedSend(): TaskActivity {
    const activity = event(started(), "tool", {
      phase: "start",
      name: "sessions_send",
      toolCallId: "s1",
      args: { sessionKey: PEER, message: "hi" },
    });
    return event(activity, "tool", {
      phase: "result",
      name: "sessions_send",
      toolCallId: "s1",
      isError: false,
      result: {
        content: [{ type: "text", text: "{}" }],
        details: { status: "accepted", runId: "run-r", sessionKey: PEER },
      },
    });
  }

  it("a recipient run history could not settle is not completed-without-reply", () => {
    // History holds only a tool-use row for the recipient's run, and it is not in flight.
    const recipient = runsFromHistory(
      [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "x", name: "ls", arguments: {} }],
          stopReason: "toolUse",
          __openclaw: { id: "a1", seq: 1, runId: "run-r" },
        },
      ],
      null,
      ctx(),
    )[0]!;
    expect(recipient).toMatchObject({ state: "completed", outcomeKnown: false });
    const linked = { "run-r": linkedRunOf(recipient, PEER) };
    expect(linked["run-r"]!.outcomeKnown).toBe(false);
    const card = select(acceptedSend(), { linkedRuns: linked }).botMessages[0]!;
    expect(card.state).toBe("recipient-outcome-unknown");
  });

  it("a stopping recipient that vanished is not recipient-stopped", () => {
    const begun = event(emptyActivity, "lifecycle", { phase: "start" }, 1, "run-r");
    const run = requestStop(begun, "run-r", 2).runs[0]!;
    const [vanished] = settleVanishedRuns([run], new Set(["run-r"]), new Set(), null, ctx());
    expect(vanished).toMatchObject({ state: "stopped", outcomeKnown: false });
    const card = select(acceptedSend(), {
      linkedRuns: { "run-r": linkedRunOf(vanished!, PEER) },
    }).botMessages[0]!;
    expect(card.state).toBe("recipient-outcome-unknown");
  });

  it("with a previous Working card, it moves on to the uncertain outcome, never back", () => {
    const linked = (state: LinkedRun["state"], outcomeKnown: boolean) => ({
      "run-r": { id: "run-r", sessionKey: PEER, state, outcomeKnown, startedAt: 1, endedAt: null },
    });
    const working = select(acceptedSend(), { linkedRuns: linked("running", true) });
    expect(working.botMessages[0]!.state).toBe("working");
    const after = select(acceptedSend(), {
      previous: working,
      linkedRuns: linked("completed", false),
    });
    expect(after.botMessages[0]!.state).toBe("recipient-outcome-unknown");
  });
});

describe("Stop does not hide a returned MCP error (D8)", () => {
  it("keeps a definitive error returned during Stop as failed, with its text", () => {
    let activity = requestStop(mcpStart(started()), "run-s", 1_500);
    activity = mcpResult(activity, { isError: true, text: "thread not found" });
    activity = event(activity, "lifecycle", { phase: "end", aborted: true });
    expect(activity.runs[0]!.state).toBe("stopped");
    expect(select(activity).mcpCalls[0]).toMatchObject({
      state: "failed",
      error: "thread not found",
      deliveryUncertain: true,
    });
  });

  it("keeps an error returned before Stop as failed", () => {
    let before = mcpResult(mcpStart(started()), { isError: true, text: "thread not found" });
    before = event(requestStop(before, "run-s", 2_000), "lifecycle", {
      phase: "end",
      aborted: true,
    });
    expect(select(before).mcpCalls[0]).toMatchObject({
      state: "failed",
      error: "thread not found",
    });
  });

  it("treats only a result that says it was aborted as uncertain delivery, still with its error", () => {
    let activity = requestStop(mcpStart(started()), "run-s", 1_500);
    activity = mcpResult(activity, {
      isError: true,
      text: "Aborted",
      details: { status: "aborted" },
    });
    activity = event(activity, "lifecycle", { phase: "end", aborted: true });
    expect(select(activity).mcpCalls[0]).toMatchObject({
      state: "unknown",
      error: "Aborted",
      deliveryUncertain: true,
    });
  });

  it("an unreturned call closed by Stop is unknown with no error invented", () => {
    let activity = requestStop(mcpStart(started()), "run-s", 1_500);
    activity = event(activity, "lifecycle", { phase: "end", aborted: true });
    expect(select(activity).mcpCalls[0]).toMatchObject({ state: "unknown", error: null });
  });
});
