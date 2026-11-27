// A turn no person asked for that ended with reasoning only, rebuilt from history after a reload
// (#766), with OpenClaw 2026.11.10's rows and task row as a development gateway kept them, names
// made up. Its history holds the event's user row and the run's reasoning-only rows, each
// `stopReason: "stop"`; the gateway's record of the failure (`run-failed-before-reply`,
// `display: false`) isn't returned. The task's row names the run (`lastRunId`) with
// `status: "failed"`, `lastRunError` and `suppressErrorNotice: true`. A later run of the task
// replaces all three. 2026.10.6 never sends the mark.

import { describe, expect, it } from "vitest";
import { MAX_ERROR_CHARS, RawTable, runsFromHistory, type Run } from "../src/runs.ts";
import { failedByRow } from "../src/quiet-end.ts";
import { neverRan } from "../src/not-run.ts";
import { grantingGateway, KEY, openTask } from "./client-harness.ts";
import { sleep, type FakeGateway } from "./fake-gateway.ts";

const T0 = 1_795_000_000_000;
const QUIET = "No answer was returned. Ask again if you still need one.";

type Row = Record<string, unknown>;

/** The task's row after such a turn, naming its run. */
const markedRow = (runId: string, over: Row = {}): Row => ({
  key: KEY,
  agentId: "otto",
  status: "failed",
  hasActiveRun: false,
  lastRunError: QUIET,
  lastRunId: runId,
  suppressErrorNotice: true,
  abortedLastRun: false,
  updatedAt: T0 + 5_000,
  ...over,
});

const personRow = {
  role: "user",
  content: "#text",
  timestamp: T0,
  idempotencyKey: "send-1:user",
  provenance: { kind: "external_user" },
  __openclaw: { id: "u-1", seq: 1, idempotencyKey: "send-1:user" },
};
const replyRow = (runId: string, seq: number, text = "A plain reply.") => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason: "stop",
  timestamp: T0 + 1_000 + seq,
  __openclaw: { runId, id: `a-${seq}`, seq },
});
/** The event the gateway woke the task with: a user row keyed by the event, not by the run. */
const eventRow = (id: string, seq: number) => ({
  role: "user",
  content: "Exec completed (otto-job, code 0) :: the command finished",
  timestamp: T0 + 2_000 + seq,
  idempotencyKey: id,
  provenance: { kind: "internal_system", sourceTool: "cron" },
  __openclaw: { id: `e-${seq}`, idempotencyKey: id, seq },
});
/** One attempt's row of a turn that ended with reasoning only. */
const thinkingRow = (runId: string, seq: number) => ({
  role: "assistant",
  content: [{ type: "thinking", thinking: "Only thinking, no answer." }],
  stopReason: "stop",
  timestamp: T0 + 2_000 + seq,
  __openclaw: { runId, id: `t-${seq}`, seq },
});
const toolCallRow = (runId: string, seq: number) => ({
  role: "assistant",
  content: [{ type: "toolCall", id: `call-${seq}`, name: "read", arguments: { path: "notes.md" } }],
  stopReason: "toolUse",
  timestamp: T0 + 2_000 + seq,
  __openclaw: { runId, id: `c-${seq}`, seq },
});
const toolResultRow = (runId: string, seq: number) => ({
  role: "toolResult",
  toolCallId: `call-${seq - 1}`,
  toolName: "read",
  content: [{ type: "text", text: "Nothing new." }],
  timestamp: T0 + 2_000 + seq,
  __openclaw: { runId, id: `r-${seq}`, seq },
});

/** The gateway as a reload finds it: the task's row and its history, nothing live. */
function gatewayWith(row: Row, messages: unknown[]): FakeGateway {
  const gateway = grantingGateway();
  gateway.handlers["agents.list"] = () => ({
    defaultId: "otto",
    agents: [{ id: "otto", identity: { name: "Otto" } }],
  });
  gateway.handlers["sessions.subscribe"] = () => ({
    subscribed: true,
    list: { sessions: [row], hasMore: false },
  });
  gateway.handlers["sessions.list"] = () => ({ sessions: [row], hasMore: false });
  gateway.handlers["chat.history"] = () => ({ messages, hasMore: false });
  return gateway;
}

/** Open the task cold, as after a reload, and give back its runs and its row's status. */
async function reload(row: Row, messages: unknown[]) {
  const { client, transcript } = await openTask({ gateway: gatewayWith(row, messages) });
  await sleep(30);
  const runs = transcript().runs;
  const status = client.state.tasksByBot.otto?.find((each) => each.key === KEY)?.status;
  client.stop();
  return { run: (id: string) => runs.find((each) => each.id === id), status };
}

describe("#766: after a reload, a gateway turn that answered nothing is the failure its row names", () => {
  it("2026.11.10: a wake that ended with reasoning only is failed with the row's words, for an earlier turn", async () => {
    const { run, status } = await reload(markedRow("wake-1"), [
      personRow,
      replyRow("send-1", 2),
      eventRow("evt-1", 3),
      thinkingRow("wake-1", 4),
      thinkingRow("wake-1", 6),
      thinkingRow("wake-1", 8),
    ]);
    const failed = run("wake-1")!;
    expect(failed).toMatchObject({ origin: "history", state: "failed" });
    expect(failed.error).toEqual({ message: QUIET, kind: null, quiet: true });
    // No message of the person's started it: no position stands in for one (#686).
    expect(failed.anchorItemId).toBeNull();
    // It ran: not a message the gateway couldn't run.
    expect(neverRan(failed)).toBe(false);
    // The run before it, which answered, is as it was.
    expect(run("send-1")).toMatchObject({ state: "completed", error: null });
    // The sidebar and the conversation agree.
    expect(status).toBe("failed");
  });

  it("a gateway turn asked again after reasoning only that then said nothing keeps one reasoning row: failed too", async () => {
    const { run } = await reload(markedRow("wake-2"), [
      eventRow("evt-2", 3),
      thinkingRow("wake-2", 4),
    ]);
    expect(run("wake-2")).toMatchObject({ state: "failed", error: { message: QUIET } });
  });

  it("a step before the reasoning is no answer: the run is still the failure", async () => {
    const { run } = await reload(markedRow("wake-3"), [
      eventRow("evt-3", 3),
      toolCallRow("wake-3", 4),
      toolResultRow("wake-3", 5),
      thinkingRow("wake-3", 6),
    ]);
    expect(run("wake-3")?.state).toBe("failed");
  });

  it("a queued run's rows under the gateway's id: the row naming either id fails the one run", async () => {
    // A person's keyed send run by the gateway under its own id, which history pairs with the send.
    const rows = [
      {
        ...personRow,
        idempotencyKey: "send-9:user",
        __openclaw: { id: "u-9", seq: 1, idempotencyKey: "send-9:user" },
      },
      thinkingRow("gw-9", 2),
      thinkingRow("gw-9", 3),
    ];
    for (const named of ["gw-9", "send-9"]) {
      const { run } = await reload(markedRow(named), rows);
      const failed = run("send-9")!;
      expect(failed).toMatchObject({ state: "failed", error: { message: QUIET } });
      // Its own message is keyed: the failure sits under it.
      expect(failed.anchorKeyed).toBe(true);
      expect(failed.anchorItemId).toBe("u-9:0");
    }
  });
});

describe("#766: no other run takes the row's failure, and a run that answered never does", () => {
  it("an older turn of reasoning only stays as history built it when the row names a later run", async () => {
    const rows = [
      eventRow("evt-1", 1),
      thinkingRow("wake-1", 2),
      eventRow("evt-2", 3),
      thinkingRow("wake-2", 4),
    ];
    const later = await reload(markedRow("wake-2"), rows);
    expect(later.run("wake-2")?.state).toBe("failed");
    expect(later.run("wake-1")).toMatchObject({ state: "completed", error: null });
    // A later run with no row of its own (a quiet answer) named by the row: none fails.
    const quiet = await reload(markedRow("wake-3"), rows);
    expect(quiet.run("wake-1")?.state).toBe("completed");
    expect(quiet.run("wake-2")?.state).toBe("completed");
    // A later run that answered: the row no longer reports a failure.
    const answered = await reload(
      { key: KEY, agentId: "otto", status: "done", lastRunId: "wake-4", updatedAt: T0 + 9_000 },
      [...rows, eventRow("evt-4", 5), replyRow("wake-4", 6)],
    );
    expect(answered.run("wake-2")?.state).toBe("completed");
  });

  it("a run that answered, with text in any row or quietly (#680): never failed by its row", async () => {
    for (const rows of [
      [eventRow("evt-5", 1), thinkingRow("wake-5", 2), replyRow("wake-5", 3)],
      [eventRow("evt-5", 1), replyRow("wake-5", 2), thinkingRow("wake-5", 3)],
      [
        eventRow("evt-5", 1),
        {
          ...replyRow("wake-5", 2),
          content: [
            { type: "text", text: "Reading first." },
            { type: "toolCall", id: "call-2", name: "read", arguments: {} },
          ],
          stopReason: "toolUse",
        },
        toolResultRow("wake-5", 3),
        thinkingRow("wake-5", 4),
      ],
      [eventRow("evt-5", 1), { ...thinkingRow("wake-5", 2), content: "An answer as a string." }],
      // A step that ends the run, and no row that answered nothing: #680's quiet answer.
      [eventRow("evt-5", 1), { ...toolCallRow("wake-5", 2), stopReason: "stop" }],
    ]) {
      const { run } = await reload(markedRow("wake-5"), rows);
      expect(run("wake-5")).toMatchObject({ state: "completed", error: null });
    }
  });
});

describe("#766: only the gateway's mark, with the run and its words, makes the rule", () => {
  const rows = [eventRow("evt-1", 1), thinkingRow("wake-1", 2), thinkingRow("wake-1", 3)];

  it("2026.10.6, and a person's turn on 2026.11.10, send no mark: the run is as history built it", async () => {
    const { run, status } = await reload(markedRow("wake-1", { suppressErrorNotice: false }), rows);
    expect(run("wake-1")).toMatchObject({ state: "completed", error: null });
    expect(status).toBe("failed");
    const { suppressErrorNotice: _mark, ...unmarked } = markedRow("wake-1");
    expect((await reload(unmarked, rows)).run("wake-1")?.state).toBe("completed");
  });

  it("the rule alone: a mark not `true`, or no run or words named, leaves the runs as they are", () => {
    const built = runsFromHistory(rows, null, { sessionKey: KEY, now: T0, raw: new RawTable() });
    const same = (row: Row | undefined) => failedByRow(built, rows, row, {}) === built;
    expect(same(undefined)).toBe(true);
    for (const over of [
      { suppressErrorNotice: "true" },
      { suppressErrorNotice: 1 },
      { lastRunError: "" },
      { lastRunError: "   " },
      { lastRunError: null },
      { lastRunError: { message: QUIET } },
      { lastRunId: undefined },
      { lastRunId: "" },
      { lastRunId: 7 },
      { lastRunId: "wake-9" },
    ])
      expect(same(markedRow("wake-1", over))).toBe(true);
    const [failed] = failedByRow(built, rows, markedRow("wake-1"), {}) as [Run];
    expect(failed.state).toBe("failed");
    // The row's words are kept as any run's error is: within its bound.
    const long = "x".repeat(MAX_ERROR_CHARS + 50);
    const [capped] = failedByRow(built, rows, markedRow("wake-1", { lastRunError: long }), {});
    expect(capped!.error!.message).toHaveLength(MAX_ERROR_CHARS);
  });

  it("the rule alone: a run whose end history only infers, or that failed or stopped, isn't touched", () => {
    const ctx = { sessionKey: KEY, now: T0, raw: new RawTable() };
    // Its last row stops for a tool: its end isn't known from its rows.
    const open = [eventRow("evt-1", 1), toolCallRow("wake-1", 2)];
    const inferred = runsFromHistory(open, null, ctx);
    expect(inferred[0]!.outcomeKnown).toBe(false);
    expect(failedByRow(inferred, open, markedRow("wake-1"), {})).toBe(inferred);
    const errored = [eventRow("evt-1", 1), { ...thinkingRow("wake-1", 2), stopReason: "error" }];
    const failed = runsFromHistory(errored, null, ctx);
    expect(failedByRow(failed, errored, markedRow("wake-1"), {})).toBe(failed);
  });
});
