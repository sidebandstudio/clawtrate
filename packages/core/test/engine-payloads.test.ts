// Payload shapes from the pinned gateway source that the engine must read
// correctly: aborted history rows, native tool output and replacement, attempt
// versus definitive lifecycle errors, and bounded display text.

import { beforeEach, describe, expect, it } from "vitest";
import {
  applyAgentEvent,
  emptyActivity,
  MAX_STEP_TEXT,
  RawTable,
  runsFromHistory,
  type EngineContext,
  type TaskActivity,
} from "../src/runs.ts";
import { projectDetails } from "../src/actions.ts";
import { mapHistory, MAX_MCP_APP_NAME_CHARS } from "../src/mapping.ts";
import { MAX_TOOL_FACTS_CHARS } from "../src/state-bounds.ts";

const KEY = "agent:otto:task";
let raw: RawTable;
const ctx = (): EngineContext => ({ sessionKey: KEY, now: 5_000, raw });
beforeEach(() => {
  raw = new RawTable();
});

let seq = 0;
function agent(
  activity: TaskActivity,
  stream: string,
  data: Record<string, unknown>,
  runId = "run-1",
) {
  seq += 1;
  return applyAgentEvent(
    activity,
    { runId, seq, stream, ts: 1_000 + seq, sessionKey: KEY, data },
    ctx(),
  ).activity;
}

describe("aborted runs in history (F-097, F-107)", () => {
  it("reads the gateway's injected aborted-partial row as stopped, not completed", () => {
    const runs = runsFromHistory(
      [
        { role: "user", content: "go", __openclaw: { id: "u1", seq: 1 } },
        {
          role: "assistant",
          content: [{ type: "text", text: "Partial answer" }],
          stopReason: "stop",
          provider: "openclaw",
          model: "gateway-injected",
          openclawAbort: { aborted: true, origin: "rpc", runId: "run-1" },
          __openclaw: { id: "a1", seq: 2 },
        },
      ],
      null,
      ctx(),
    );
    expect(runs.map((run) => [run.id, run.state, run.outcomeKnown])).toEqual([
      ["run-1", "stopped", true],
    ]);
  });

  it("does not claim success when history cannot establish how a run ended", () => {
    const runs = runsFromHistory(
      [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
          stopReason: "toolUse",
          __openclaw: { id: "a1", seq: 2, runId: "run-1" },
        },
      ],
      null,
      ctx(),
    );
    expect(runs[0]).toMatchObject({ state: "completed", outcomeKnown: false });
    const done = runsFromHistory(
      [
        {
          role: "assistant",
          content: "ok",
          stopReason: "stop",
          __openclaw: { id: "a1", seq: 2, runId: "run-2" },
        },
      ],
      null,
      ctx(),
    );
    expect(done[0]).toMatchObject({ state: "completed", outcomeKnown: true });
  });
});

describe("native tool events (F-091, F-093, F-294, F-432)", () => {
  const nativeId = "agentsapi:remote-1:turn-1:item-1";

  it("streams command output correlated by toolCallId, not only a command: item id", () => {
    let activity = agent(emptyActivity, "tool", {
      phase: "start",
      name: "shell",
      toolCallId: nativeId,
      args: { command: "ls" },
    });
    activity = agent(activity, "command_output", {
      itemId: nativeId,
      toolCallId: nativeId,
      phase: "delta",
      name: "shell",
      output: "file-a\n",
      status: "running",
    });
    expect(activity.runs[0]!.steps[0]!.output?.text).toBe("file-a\n");
    // The ordinary exec producer still correlates through `command:<toolCallId>`.
    activity = agent(activity, "tool", {
      phase: "start",
      name: "exec",
      toolCallId: "call_2",
      args: {},
    });
    activity = agent(activity, "command_output", {
      itemId: "command:call_2",
      phase: "delta",
      output: "x",
    });
    expect(activity.runs[0]!.steps[1]!.output?.text).toBe("x");
  });

  it("reads a native result: output as the text, result as the details", () => {
    let activity = agent(emptyActivity, "tool", {
      phase: "start",
      name: "shell",
      toolCallId: nativeId,
      args: {},
    });
    activity = agent(activity, "tool", {
      phase: "result",
      itemId: nativeId,
      toolCallId: nativeId,
      name: "shell",
      status: "failed",
      isError: true,
      result: { exitCode: 2, failureKind: "exit" },
      output: "native failure",
      replaceable: true,
    });
    expect(activity.runs[0]!.steps[0]).toMatchObject({
      status: "failed",
      result: { text: "native failure" },
      error: "native failure",
    });
  });

  it("accepts the canonical replacement of a replaceable result, even after the run ended", () => {
    let activity = agent(emptyActivity, "tool", {
      phase: "start",
      name: "shell",
      toolCallId: nativeId,
      args: {},
    });
    activity = agent(activity, "tool", {
      phase: "result",
      toolCallId: nativeId,
      name: "shell",
      isError: true,
      result: {},
      output: "first projection",
      replaceable: true,
    });
    activity = agent(activity, "lifecycle", { phase: "end" });
    activity = agent(activity, "tool", {
      phase: "result",
      toolCallId: nativeId,
      name: "shell",
      isError: false,
      result: { exitCode: 0 },
      output: "canonical result",
      replaceable: true,
      replace: true,
    });
    const run = activity.runs[0]!;
    expect(run.state).toBe("completed");
    expect(run.steps[0]).toMatchObject({
      status: "done",
      result: { text: "canonical result" },
      error: null,
    });
    expect((raw.get(KEY, `tool:${nativeId}`)!.result as { output: string }).output).toBe(
      "canonical result",
    );
    // A replacement for a result that was not replaceable is ignored.
    let plain = agent(
      emptyActivity,
      "tool",
      { phase: "start", name: "read", toolCallId: "c9", args: {} },
      "run-2",
    );
    plain = agent(
      plain,
      "tool",
      {
        phase: "result",
        toolCallId: "c9",
        name: "read",
        isError: false,
        result: { content: [{ type: "text", text: "a" }] },
      },
      "run-2",
    );
    plain = agent(
      plain,
      "tool",
      {
        phase: "result",
        toolCallId: "c9",
        name: "read",
        isError: true,
        replace: true,
        result: { content: [{ type: "text", text: "b" }] },
      },
      "run-2",
    );
    expect(plain.runs[0]!.steps[0]!.result?.text).toBe("a");
  });
});

describe("attempt errors versus definitive terminal events (F-102)", () => {
  it("keeps running after a retryable lifecycle error and completes on the fallback's end", () => {
    let activity = agent(emptyActivity, "lifecycle", { phase: "start" });
    activity = agent(activity, "lifecycle", { phase: "error", error: "provider overloaded" });
    expect(activity.runs[0]).toMatchObject({
      state: "running",
      attemptErrors: ["provider overloaded"],
    });
    activity = agent(activity, "assistant", {
      text: "Fallback answer",
      delta: "Fallback answer",
      itemId: "i1",
    });
    activity = agent(activity, "lifecycle", { phase: "end", stopReason: "stop" });
    expect(activity.runs[0]).toMatchObject({ state: "completed", text: "Fallback answer" });
  });

  it("ends on a definitive error: settled, fallback exhausted, or a non-failure classification", () => {
    for (const data of [
      { phase: "error", error: "x", executionSettled: true },
      { phase: "error", error: "x", fallbackExhaustedFailure: true },
    ]) {
      const activity = agent(
        agent(emptyActivity, "lifecycle", { phase: "start" }),
        "lifecycle",
        data,
      );
      expect(activity.runs[0]!.state).toBe("failed");
    }
    const timedOut = agent(agent(emptyActivity, "lifecycle", { phase: "start" }), "lifecycle", {
      phase: "error",
      error: "slow",
      timeoutPhase: "provider",
    });
    expect(timedOut.runs[0]).toMatchObject({ state: "failed", error: { kind: "timeout" } });
    const cancelled = agent(agent(emptyActivity, "lifecycle", { phase: "start" }), "lifecycle", {
      phase: "error",
      status: "cancelled",
    });
    expect(cancelled.runs[0]!.state).toBe("stopped");
  });

  it("classifies an end by its terminal facts", () => {
    const end = (data: Record<string, unknown>) =>
      agent(agent(emptyActivity, "lifecycle", { phase: "start" }), "lifecycle", {
        phase: "end",
        ...data,
      }).runs[0]!;
    expect(end({}).state).toBe("completed");
    expect(end({ aborted: true }).state).toBe("stopped");
    expect(end({ stopReason: "superseded" }).state).toBe("stopped");
    expect(end({ status: "timeout" })).toMatchObject({
      state: "failed",
      error: { kind: "timeout" },
    });
    expect(end({ status: "error", stopReason: "error" }).state).toBe("failed");
    expect(end({ livenessState: "blocked" }).state).toBe("failed");
  });
});

describe("bounded display text", () => {
  it("caps a failed step's error like its result", () => {
    const huge = "e".repeat(1_000_000);
    let activity = agent(emptyActivity, "tool", {
      phase: "start",
      name: "exec",
      toolCallId: "c1",
      args: {},
    });
    activity = agent(activity, "tool", {
      phase: "result",
      toolCallId: "c1",
      name: "exec",
      isError: true,
      result: { content: [{ type: "text", text: huge }], details: {} },
    });
    const step = activity.runs[0]!.steps[0]!;
    expect(step.result!.text.length).toBe(MAX_STEP_TEXT);
    expect(step.error!.length).toBeLessThanOrEqual(MAX_STEP_TEXT);
    const history = runsFromHistory(
      [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "c2", name: "exec", arguments: {} }],
          __openclaw: { id: "a", seq: 1, runId: "r" },
        },
        {
          role: "toolResult",
          toolCallId: "c2",
          isError: true,
          content: [{ type: "text", text: huge }],
          __openclaw: { id: "t", seq: 2, runId: "r" },
        },
      ],
      null,
      ctx(),
    );
    expect(history[0]!.steps[0]!.error!.length).toBeLessThanOrEqual(MAX_STEP_TEXT);
  });

  it("caps a run's error message", () => {
    const activity = agent(agent(emptyActivity, "lifecycle", { phase: "start" }), "lifecycle", {
      phase: "error",
      error: "x".repeat(100_000),
      executionSettled: true,
    });
    expect(activity.runs[0]!.error!.message.length).toBeLessThanOrEqual(MAX_STEP_TEXT);
  });
});

describe("F-615 a result the gateway marks as an MCP App", () => {
  const app = (more: Record<string, unknown> = {}) => ({
    viewId: "mcp-app-1",
    serverName: "coder",
    toolName: "show_board",
    uiResourceUri: "ui://coder/board",
    toolCallId: "call_1",
    originSessionKey: KEY,
    ...more,
  });
  const details = (mcpApp = app()) => ({
    mcpServer: "coder",
    mcpTool: "show_board",
    mcpAppPreview: { kind: "canvas", view: { id: mcpApp.viewId }, mcpApp },
  });
  const kept = { serverName: "coder", toolName: "show_board", viewId: "mcp-app-1" };

  it("keeps the app's server, tool and view from the live stream", () => {
    let activity = agent(emptyActivity, "tool", {
      phase: "start",
      name: "coder__show_board",
      toolCallId: "call_1",
      args: {},
    });
    activity = agent(activity, "tool", {
      phase: "result",
      name: "coder__show_board",
      toolCallId: "call_1",
      result: { content: [{ type: "text", text: '{"threads":0}' }], details: details() },
    });
    expect(activity.runs[0]!.steps[0]!.details?.mcpApp).toEqual(kept);
  });

  it("keeps the same from history, on the step and on the history block", () => {
    const rows = [
      {
        role: "user",
        content: "show the coding board",
        __openclaw: { id: "u1", seq: 1, runId: "r" },
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "coder__show_board", arguments: {} }],
        __openclaw: { id: "a1", seq: 2, runId: "r" },
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "coder__show_board",
        content: [{ type: "text", text: '{"threads":0}' }],
        details: details(),
        __openclaw: { id: "t1", seq: 3, runId: "r" },
      },
    ];
    const runs = runsFromHistory(rows, null, ctx());
    expect(runs[0]!.steps.find((step) => step.kind === "tool")?.details?.mcpApp).toEqual(kept);
    const block = mapHistory(rows)
      .flatMap((item) => item.blocks)
      .find((each) => each.kind === "tool-call");
    expect(block?.kind === "tool-call" && block.result?.facts?.mcpApp).toEqual(kept);
  });

  it("cuts the names to their bound and leaves out a view id past its own", () => {
    const long = app({
      serverName: "s".repeat(500),
      toolName: "t".repeat(500),
      viewId: "v".repeat(200),
    });
    const fromHistory = mapHistory([
      { role: "assistant", content: [{ type: "toolCall", id: "c", name: "x", arguments: {} }] },
      { role: "toolResult", toolCallId: "c", content: "{}", details: details(long) },
    ])[0]!.blocks[0]!;
    const facts = fromHistory.kind === "tool-call" ? fromHistory.result?.facts : null;
    const step = projectDetails(details(long));
    for (const each of [facts, step]) {
      expect(each?.mcpApp).toEqual({
        serverName: "s".repeat(MAX_MCP_APP_NAME_CHARS - 2),
        toolName: "t".repeat(MAX_MCP_APP_NAME_CHARS - 2),
      });
    }
    expect(JSON.stringify(facts).length).toBeLessThanOrEqual(MAX_TOOL_FACTS_CHARS);
  });
});
