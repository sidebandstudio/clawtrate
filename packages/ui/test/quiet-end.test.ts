// What a person sees of a turn no person asked for that the bot answered quietly (#680), built from
// each OpenClaw version's frames as a development gateway sent them, names made up: on 2026.10.6 a
// lifecycle `end` (`terminalReply.disposition: "silent"`) and a `chat` `final` with no message; on
// 2026.11.10 a lifecycle `error` and a `chat` `error` marked `suppressErrorNotice`, with the gateway's
// "no answer" words. The conversation draws no ending for either, and the task's mark is no
// failure. The same 2026.11.10 end after a turn of reasoning only, which history keeps, is the
// failed-turn card, with the gateway's words, for an earlier turn (no message of the person's).

import {
  applyAgentEvent,
  applyChatEvent,
  emptyActivity,
  mergeHistoryRuns,
  newRun,
  RawTable,
  runsFromHistory,
  settleQuietEnds,
  type Run,
  type Task,
  type TaskActivity,
} from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { endingOf, failedTurnTitle, forEarlierMessage } from "../src/live.ts";
import { taskState } from "../src/selection.ts";

const KEY = "agent:otto:disk-space";
const NOW = 1_795_000_000_000;
const QUIET = "No answer was returned. Ask again if you still need one.";
const ctx = () => ({ sessionKey: KEY, now: NOW + 5_000, raw: new RawTable() });

const lifecycle = (runId: string, seq: number, data: Record<string, unknown>) => ({
  runId,
  seq,
  stream: "lifecycle",
  ts: NOW + seq,
  sessionKey: KEY,
  data,
});

/** A gateway turn of the task, ended as each version ends it, then history read once. */
function wake(version: "2026.10.6" | "2026.11.10", rows: unknown[] = []): Run {
  const c = ctx();
  let activity: TaskActivity = emptyActivity;
  activity = applyAgentEvent(activity, lifecycle("wake-1", 1, { phase: "start" }), c).activity;
  if (version === "2026.10.6") {
    activity = applyAgentEvent(
      activity,
      lifecycle("wake-1", 11, {
        phase: "end",
        stopReason: "stop",
        aborted: false,
        livenessState: "working",
        terminalReply: { disposition: "silent" },
        executionSettled: true,
      }),
      c,
    ).activity;
    activity = applyChatEvent(
      activity,
      { runId: "wake-1", sessionKey: KEY, seq: 11, state: "final", stopReason: "stop" },
      null,
      c,
    );
  } else {
    activity = applyAgentEvent(
      activity,
      lifecycle("wake-1", 15, {
        phase: "error",
        stopReason: "error",
        aborted: false,
        livenessState: "abandoned",
        error: QUIET,
        terminalReply: { disposition: "empty" },
        suppressErrorNotice: true,
        replayInvalid: true,
        executionSettled: true,
      }),
      c,
    ).activity;
    activity = applyChatEvent(
      activity,
      {
        runId: "wake-1",
        sessionKey: KEY,
        seq: 15,
        state: "error",
        errorMessage: QUIET,
        suppressErrorNotice: true,
        stopReason: "error",
      },
      null,
      c,
    );
  }
  const pending = new Set(
    activity.runs.filter((run) => run.quietEnd === "pending").map((r) => r.id),
  );
  const merged = mergeHistoryRuns(activity.runs, runsFromHistory(rows, null, c), c).runs;
  return settleQuietEnds(merged, pending).find((run) => run.id === "wake-1")!;
}

const task = (status: Task["status"]): Task =>
  ({ key: KEY, botId: "otto", title: "Disk space", status, updatedAt: NOW }) as Task;

describe("#680: a quiet answer looks the same on both versions", () => {
  it("the conversation draws no ending for it: no failed-turn card on either version", () => {
    const older = wake("2026.10.6");
    const newer = wake("2026.11.10");
    for (const run of [older, newer]) {
      expect(run.state).toBe("completed");
      expect(run.error).toBeNull();
      expect(run.text).toBe("");
      expect(run.steps).toEqual([]);
      expect(endingOf(run)).toBeNull();
    }
    // Before history has been read, too.
    const c = ctx();
    let pending: TaskActivity = {
      ...emptyActivity,
      runs: [{ ...newRun("wake-2", { state: "running", origin: "gateway", bound: true }, NOW) }],
    };
    pending = applyChatEvent(
      pending,
      {
        runId: "wake-2",
        sessionKey: KEY,
        seq: 2,
        state: "error",
        errorMessage: QUIET,
        suppressErrorNotice: true,
      },
      null,
      c,
    );
    expect(pending.runs[0]!.quietEnd).toBe("pending");
    expect(endingOf(pending.runs[0]!)).toBeNull();
  });

  it("a task done is marked as nothing; failed says its last run failed", () => {
    expect(taskState(task("done"), {}, null)).toBeNull();
    expect(taskState(task("failed"), {}, null)).toBe("failed");
  });

  it("2026.11.10: the same end after a turn of reasoning only is the failed-turn card, for an earlier turn", () => {
    const run = wake("2026.11.10", [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Only thinking, no answer." }],
        stopReason: "stop",
        timestamp: NOW + 2_000,
        __openclaw: { runId: "wake-1", id: "t-1", seq: 4 },
      },
    ]);
    expect(run.state).toBe("failed");
    expect(endingOf(run)).toEqual({ kind: "failed", reason: QUIET });
    // No message of the person's started it: there's nothing to send again.
    expect(forEarlierMessage(run, { outbox: [] })).toBe(true);
    expect(failedTurnTitle("Otto", true)).toBe("Otto couldn't finish an earlier turn");
  });
});
