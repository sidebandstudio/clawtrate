// State from history equals state from the live stream; a resync applied twice
// equals once; a slow history response never overwrites newer state; and what
// the client keeps for open tasks is bounded.

import { beforeEach, describe, expect, it } from "vitest";
import {
  applyAgentEvent,
  emptyActivity,
  MAX_RAW_BYTES,
  MAX_RAW_ENTRY_CHARS,
  MAX_RUNS_PER_TASK,
  MAX_SETTLED_APPROVALS,
  mergeHistoryRuns,
  RawTable,
  retainActivity,
  runsFromHistory,
  type EngineContext,
  type Run,
  type TaskActivity,
} from "../src/runs.ts";
import { agentEvent, KEY, openTask } from "./client-harness.ts";
import { deferred, sleep, until } from "./fake-gateway.ts";

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

const lsCall = { type: "toolCall", id: "call_1", name: "ls", arguments: { path: "." } };
const lsRow = {
  role: "toolResult",
  toolCallId: "call_1",
  toolName: "ls",
  isError: false,
  content: [{ type: "text", text: "a" }],
  __openclaw: { id: "t1", seq: 3, runId: "run-1" },
};

describe("resync is idempotent (F-107)", () => {
  it("keeps one continuing reasoning segment across a reload while the run is in flight", () => {
    let activity = feed(
      emptyActivity,
      agentEvent("run-1", 1, "lifecycle", { phase: "start" }),
      agentEvent("run-1", 2, "thinking", { text: "abc", delta: "abc" }),
    );
    const history = runsFromHistory(
      [
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "abc" }],
          __openclaw: { id: "a1", seq: 2, runId: "run-1" },
        },
      ],
      "run-1",
      ctx(),
    );
    activity = { ...activity, runs: mergeHistoryRuns(activity.runs, history, ctx()).runs };
    activity = feed(activity, agentEvent("run-1", 3, "thinking", { text: "abcd", delta: "d" }));
    expect(
      activity.runs[0]!.steps.map((step) => [step.id, step.status, step.output?.text]),
    ).toEqual([["reasoning:run-1:0", "running", "abcd"]]);
  });

  it("merging the same history twice gives the same runs as once", () => {
    const live = feed(
      emptyActivity,
      agentEvent("run-1", 1, "lifecycle", { phase: "start" }),
      agentEvent("run-1", 2, "tool", {
        phase: "start",
        name: "ls",
        toolCallId: "call_1",
        args: { path: "." },
      }),
    );
    const rows = [
      { role: "assistant", content: [lsCall], __openclaw: { id: "a1", seq: 2, runId: "run-1" } },
      lsRow,
    ];
    const once = mergeHistoryRuns(live.runs, runsFromHistory(rows, "run-1", ctx()), ctx()).runs;
    const twice = mergeHistoryRuns(once, runsFromHistory(rows, "run-1", ctx()), ctx()).runs;
    expect(twice).toEqual(once);
  });

  it("does not let a reload's history payload replace the live one the step shows", async () => {
    const { client, gateway, transcript } = await openTask();
    const big = "x".repeat(40_000);
    gateway.emit(
      "agent",
      agentEvent("run-1", 1, "tool", {
        phase: "start",
        name: "ls",
        toolCallId: "call_1",
        args: { path: "." },
      }),
    );
    gateway.emit(
      "agent",
      agentEvent("run-1", 2, "tool", {
        phase: "result",
        name: "ls",
        toolCallId: "call_1",
        isError: false,
        result: { content: [{ type: "text", text: big }], details: {} },
      }),
    );
    await until(() => transcript().runs[0]?.steps[0]?.status === "done");
    expect(transcript().runs[0]!.steps[0]!.raw).toBeNull();
    gateway.handlers["chat.history"] = () => ({
      messages: [
        { role: "assistant", content: [lsCall], __openclaw: { id: "a1", seq: 2, runId: "run-1" } },
        { ...lsRow, content: [{ type: "text", text: big }] },
      ],
      hasMore: false,
      inFlightRun: { runId: "run-1", text: "" },
    });
    gateway.emit("session.message", { sessionKey: KEY });
    await until(() => gateway.calls("chat.history").length === 2);
    await sleep(30);
    expect(client.stepRaw(KEY, "tool:call_1")?.source).toBe("live");
    client.stop();
  });
});

describe("runs history alone cannot show (F-097, F-107)", () => {
  it("rebuilds an in-flight run that has no assistant row yet from its snapshot", async () => {
    const { client, gateway, transcript } = await openTask({
      gateway: (() => {
        const { grantingGateway } = harness;
        const g = grantingGateway();
        g.handlers["chat.history"] = () => ({
          messages: [{ role: "user", content: "go", __openclaw: { id: "u1", seq: 1 } }],
          hasMore: false,
          inFlightRun: {
            runId: "run-9",
            text: "Working on it",
            startedAt: 1_000,
            events: [
              {
                stream: "tool",
                seq: 4,
                ts: 1_004,
                data: { phase: "start", name: "ls", toolCallId: "call_9", args: { path: "." } },
              },
            ],
          },
        });
        return g;
      })(),
    });
    expect(transcript().runs.map((run) => [run.id, run.state, run.text, run.anchorItemId])).toEqual(
      [["run-9", "running", "Working on it", "u1:0"]],
    );
    expect(transcript().runs[0]!.steps.map((step) => [step.id, step.status])).toEqual([
      ["tool:call_9", "running"],
    ]);
    expect(transcript().live).toEqual({ runId: "run-9", text: "Working on it" });
    client.stop();
    void gateway;
  });

  it("settles a run that left the gateway without a record, marking its outcome unknown", async () => {
    const { client, gateway, transcript } = await openTask();
    gateway.handlers["chat.abort"] = () => ({ ok: true, aborted: false, runIds: [] });
    gateway.emit("agent", agentEvent("run-x", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.length === 1);
    await client.stopRun(KEY, "run-x");
    // History has no row and no in-flight run: the run is over, but nothing says how.
    await until(() => transcript().runs[0]!.state !== "stopping");
    expect(transcript().runs[0]).toMatchObject({ state: "stopped", outcomeKnown: false });
    client.stop();
  });
});

describe("slow history responses never overwrite newer state (F-107)", () => {
  it("drops an older response that arrives after a newer one", async () => {
    const { client, gateway, transcript } = await openTask();
    const first = deferred<unknown>();
    let calls = 0;
    gateway.handlers["chat.history"] = () => {
      calls += 1;
      if (calls === 1) return first.promise;
      return {
        messages: [
          { role: "user", content: "one", __openclaw: { id: "u1", seq: 1 } },
          { role: "user", content: "two", __openclaw: { id: "u2", seq: 2 } },
        ],
        hasMore: false,
      };
    };
    gateway.emit("session.message", { sessionKey: KEY });
    await until(() => calls === 1);
    gateway.emit("session.message", { sessionKey: KEY });
    await sleep(400);
    first.resolve({
      messages: [{ role: "user", content: "one", __openclaw: { id: "u1", seq: 1 } }],
      hasMore: false,
    });
    await until(() => calls >= 2);
    await sleep(50);
    expect(transcript().items.map((item) => item.blocks[0])).toEqual([
      { kind: "text", text: "one" },
      { kind: "text", text: "two" },
    ]);
    client.stop();
  });

  it("drops a response for an earlier opening of the same task", async () => {
    const { client, gateway, transcript } = await openTask();
    const pending = deferred<unknown>();
    gateway.handlers["chat.history"] = () => pending.promise;
    gateway.emit("session.message", { sessionKey: KEY });
    await sleep(200);
    client.closeSession(KEY);
    gateway.handlers["chat.history"] = () => ({
      messages: [{ role: "user", content: "fresh", __openclaw: { id: "u9", seq: 9 } }],
      hasMore: false,
    });
    client.openSession(KEY);
    await until(() => transcript()?.items.length === 1);
    pending.resolve({
      messages: [{ role: "user", content: "stale", __openclaw: { id: "u1", seq: 1 } }],
      hasMore: false,
    });
    await sleep(50);
    expect(transcript().items.map((item) => item.blocks[0])).toEqual([
      { kind: "text", text: "fresh" },
    ]);
    client.stop();
  });
});

describe("bounded retention", () => {
  it("keeps at most MAX_RUNS_PER_TASK finished runs, never dropping an active one", () => {
    const runs: Run[] = [];
    let activity: TaskActivity = emptyActivity;
    for (let i = 0; i < MAX_RUNS_PER_TASK + 1; i += 1) {
      activity = feed(
        activity,
        agentEvent(`r${i}`, 1, "lifecycle", { phase: "start" }),
        agentEvent(`r${i}`, 2, "lifecycle", { phase: "end" }),
      );
    }
    activity = feed(activity, agentEvent("active", 1, "lifecycle", { phase: "start" }));
    void runs;
    const at = retainActivity({ ...activity, runs: activity.runs.slice(1) });
    expect(at.runs).toHaveLength(MAX_RUNS_PER_TASK + 1);
    const past = retainActivity(activity);
    expect(past.runs).toHaveLength(MAX_RUNS_PER_TASK + 1);
    expect(past.runs[0]!.id).toBe("r1");
    expect(past.runs.at(-1)!.id).toBe("active");
  });

  it("holds raw payloads within MAX_RAW_BYTES, evicting the oldest", () => {
    const table = new RawTable();
    const entry = (n: number) => ({
      source: "live" as const,
      runId: "r",
      call: "y".repeat(n),
      result: null,
    });
    const overhead = JSON.stringify(entry(0)).length;
    const full = entry(MAX_RAW_ENTRY_CHARS - overhead);
    const count = MAX_RAW_BYTES / MAX_RAW_ENTRY_CHARS;
    for (let i = 0; i < count; i += 1) table.set(KEY, `s${i}`, full);
    expect(table.total).toBe(MAX_RAW_BYTES);
    expect(table.get(KEY, "s0")).not.toBeNull();
    table.set(KEY, "one-more", entry(1));
    expect(table.get(KEY, "s0")).toBeNull();
    expect(table.get(KEY, "s1")).not.toBeNull();
    expect(table.get(KEY, "one-more")).not.toBeNull();
  });

  it(`keeps a raw payload of MAX_RAW_ENTRY_CHARS (${MAX_RAW_ENTRY_CHARS}) and not one past it`, () => {
    const table = new RawTable();
    const entry = (n: number) => ({
      source: "live" as const,
      runId: "r",
      call: "y".repeat(n),
      result: null,
    });
    const overhead = JSON.stringify(entry(0)).length;
    table.set(KEY, "at", entry(MAX_RAW_ENTRY_CHARS - overhead));
    table.set(KEY, "past", entry(MAX_RAW_ENTRY_CHARS - overhead + 1));
    expect(table.get(KEY, "at")).not.toBeNull();
    expect(table.get(KEY, "past")).toBeNull();
  });

  it("keeps no stream baseline for tasks nobody has open", async () => {
    const { client, gateway } = await openTask();
    gateway.emit("chat", {
      runId: "elsewhere",
      sessionKey: "agent:otto:other",
      seq: 1,
      state: "delta",
      deltaText: "hi",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    });
    await sleep(20);
    const streams = (client as unknown as { streams: { runs: Map<string, unknown> } }).streams;
    expect(streams.runs.size).toBe(0);
    client.stop();
  });
});

describe("settled approvals and questions are bounded", () => {
  it("keeps at most MAX_SETTLED_APPROVALS settled approvals and every pending one", () => {
    const approval = (id: string, status: "pending" | "denied") =>
      ({ id, status }) as unknown as TaskActivity["approvals"][number];
    const settled = Array.from({ length: MAX_SETTLED_APPROVALS + 1 }, (_, i) =>
      approval(`s${i}`, "denied"),
    );
    const at = retainActivity({
      ...emptyActivity,
      approvals: [approval("p", "pending"), ...settled.slice(1)],
    });
    expect(at.approvals).toHaveLength(MAX_SETTLED_APPROVALS + 1);
    const past = retainActivity({
      ...emptyActivity,
      approvals: [approval("p", "pending"), ...settled],
    });
    expect(past.approvals.map((each) => each.id)).toEqual([
      "p",
      ...settled.slice(1).map((each) => each.id),
    ]);
  });
});

describe("a resync through the client is idempotent (F-107)", () => {
  it("leaves the transcript the same when the same history is read again", async () => {
    const gateway = harness.grantingGateway();
    gateway.handlers["chat.history"] = () => ({
      messages: [
        { role: "user", content: "go", __openclaw: { id: "u1", seq: 1 } },
        { role: "assistant", content: [lsCall], __openclaw: { id: "a1", seq: 2, runId: "run-1" } },
        lsRow,
        {
          role: "assistant",
          content: "done",
          stopReason: "stop",
          __openclaw: { id: "a2", seq: 4, runId: "run-1" },
        },
      ],
      hasMore: false,
    });
    const { client, transcript } = await openTask({ gateway });
    await sleep(50);
    const once = transcript();
    const raws = once.runs.flatMap((run) => run.steps.map((step) => client.stepRaw(KEY, step.id)));
    const reads = gateway.calls("chat.history").length;
    gateway.emit("session.message", { sessionKey: KEY });
    await until(() => gateway.calls("chat.history").length > reads);
    await sleep(50);
    expect(transcript().runs).toEqual(once.runs);
    expect(transcript().items).toEqual(once.items);
    expect(
      transcript().runs.flatMap((run) => run.steps.map((step) => client.stepRaw(KEY, step.id))),
    ).toEqual(raws);
    client.stop();
  });
});

import * as harness from "./client-harness.ts";
