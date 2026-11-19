// The routines engine against payloads shaped as a development gateway
// (2026.10.6) returned them (docs/decisions.md, "Routines: what the gateway
// returns"), and the client applying the `cron` event it sends.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ClawtrateClient } from "../src/client.ts";
import {
  applyCronEvent,
  initialRoutinesState,
  MAX_CALENDAR_RUNS,
  MAX_ROUTINE_RUNS,
  MAX_ROUTINES,
  MAX_RUN_MESSAGE_CHARS,
  parseRoutine,
  RETRY_MS,
  RoutinesEngine,
  RUNNING_RECHECK_MS,
  type RoutinesState,
} from "../src/routines.ts";
import { FAST, grantingGateway, URL_A } from "./client-harness.ts";
import { memoryStorage, testHost, tokenKey, until } from "./fake-gateway.ts";

const JOB = "b848f781-dd42-4069-ba05-d104990bec2c";
const SESSION = `agent:marlow:cron:${JOB}:run:eca6999e`;

const job = (overrides: Record<string, unknown> = {}, state: Record<string, unknown> = {}) => ({
  id: JOB,
  agentId: "marlow",
  name: "Morning digest",
  enabled: true,
  schedule: { kind: "cron", expr: "0 8 * * 1-5", tz: "America/New_York" },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "Summarise yesterday's notes.", toolsAllow: ["*"] },
  delivery: { mode: "none" },
  state: { nextRunAtMs: 1_795_093_200_000, ...state },
  updatedAtMs: 1_795_045_912_086,
  ...overrides,
});
const heartbeat = {
  id: "d01dee63",
  declarationKey: "heartbeat:main",
  agentId: "main",
  name: "heartbeat-main",
  enabled: true,
  schedule: { kind: "every", everyMs: 1_800_000 },
  sessionTarget: "main",
  payload: { kind: "heartbeat" },
  state: { nextRunAtMs: 1 },
};
const runEntry = (runAtMs: number, extra: Record<string, unknown> = {}) => ({
  ts: runAtMs + 1815,
  jobId: JOB,
  action: "finished",
  status: "ok",
  completionStatus: "succeeded",
  summary: "Done.",
  runId: `manual:${JOB}:${runAtMs}:1`,
  runAtMs,
  durationMs: 1815,
  model: "dev-1",
  provider: "scripted",
  usage: { input_tokens: 360, output_tokens: 240, total_tokens: 600 },
  sessionKey: SESSION,
  jobName: "Morning digest",
  ...extra,
});

function engine(
  handlers: Record<string, (params: Record<string, unknown>) => unknown>,
  start: RoutinesState = initialRoutinesState,
) {
  let state: RoutinesState = start;
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const routines = new RoutinesEngine({
    request: async (method, params) => {
      requests.push({ method, params: params as Record<string, unknown> });
      const handler = handlers[method];
      if (!handler) throw new Error(`unexpected ${method}`);
      return handler(params as Record<string, unknown>);
    },
    get: () => state,
    update: (change) => {
      state = change(state);
    },
  });
  return { routines, requests, state: () => state };
}

describe("F-191: the routine list", () => {
  it("reads every page with paused routines, leaves check-in jobs out, and says whether the scheduler runs", async () => {
    const second = job(
      { id: "j2", name: "Inbox tidy-up", enabled: false },
      { nextRunAtMs: undefined },
    );
    const { routines, requests, state } = engine({
      "cron.status": () => ({ enabled: false, nextWakeAtMs: null }),
      "cron.list": (params) =>
        params.offset === 0
          ? { jobs: [heartbeat, job()], hasMore: true, nextOffset: 2 }
          : { jobs: [second], hasMore: false, nextOffset: null },
    });
    await routines.load();
    expect(requests.filter((r) => r.method === "cron.list").map((r) => r.params)).toEqual([
      { includeDisabled: true, limit: 200, offset: 0 },
      { includeDisabled: true, limit: 200, offset: 2 },
    ]);
    expect(state().status).toBe("loaded");
    expect(state().schedulerOn).toBe(false);
    expect(state().routines.map((r) => [r.name, r.enabled, r.nextRunAt])).toEqual([
      ["Morning digest", true, 1_795_093_200_000],
      ["Inbox tidy-up", false, null],
    ]);
  });

  it("reads a job as the gateway gave it: schedule, zone, instruction, where it runs and its results", () => {
    expect(parseRoutine(job())).toMatchObject({
      botId: "marlow",
      schedule: { kind: "cron", expr: "0 8 * * 1-5", tz: "America/New_York" },
      payload: "agentTurn",
      text: "Summarise yesterday's notes.",
      target: "isolated",
      delivery: "none",
    });
    // No delivery is the gateway's default, which announces (observed: `{mode: "announce"}`).
    expect(parseRoutine(job({ delivery: undefined }))?.delivery).toBe("announce");
    expect(
      parseRoutine(
        job({ sessionTarget: "main", payload: { kind: "systemEvent", text: "Stretch break" } }),
      ),
    ).toMatchObject({ payload: "systemEvent", text: "Stretch break", target: "main" });
    expect(parseRoutine(heartbeat)).toBeNull();
  });

  it("keeps the error when a read fails", async () => {
    const { routines, state } = engine({
      "cron.status": () => {
        throw new Error("missing scope: operator.read");
      },
    });
    await routines.load();
    expect(state()).toMatchObject({ status: "error", error: "missing scope: operator.read" });
    routines.onClose();
  });

  it("keeps 200 routines, counts the rest from the gateway's total, and refills a place a removal empties", async () => {
    let first = 0;
    let total = 450;
    const jobs = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => job({ id: `j${first + from + index}` }));
    const { routines, requests, state } = engine({
      "cron.status": () => ({ enabled: true }),
      "cron.list": (params) => {
        const offset = params.offset as number;
        const count = Math.min(200, total - offset);
        return {
          jobs: jobs(offset, count),
          total,
          hasMore: offset + count < total,
          nextOffset: offset + count < total ? offset + count : null,
        };
      },
    });
    await routines.load();
    expect(state().routines).toHaveLength(MAX_ROUTINES);
    expect(state().omitted).toBe(250);
    // The first page filled the cap: the rest is counted, not read.
    expect(requests.filter((r) => r.method === "cron.list")).toHaveLength(1);
    first = 1;
    total = 449;
    routines.onEvent({ jobId: "j0", action: "removed" });
    await until(() => state().omitted === 249);
    expect(state().routines).toHaveLength(MAX_ROUTINES);
    expect(state().routines.some((r) => r.id === "j0")).toBe(false);
  });
});

describe("F-024: the list stays true when events and reads cross", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("an event that arrives while the list is read keeps that older read from being shown", async () => {
    let answer: (value: unknown) => void = () => {};
    let reads = 0;
    const { routines, state } = engine(
      {
        "cron.status": () => ({ enabled: true }),
        "cron.list": () => {
          reads += 1;
          // The first read is the gateway's answer from before the run finished.
          if (reads === 1) return new Promise((resolve) => (answer = resolve));
          return { jobs: [job({}, { lastRunAtMs: 5, lastRunStatus: "ok" })], hasMore: false };
        },
      },
      {
        ...initialRoutinesState,
        status: "loaded",
        routines: [parseRoutine(job({}, { runningAtMs: 5 }))!],
      },
    );
    const loading = routines.load();
    await until(() => reads === 1);
    routines.onEvent({ jobId: JOB, action: "finished", job: job(), runAtMs: 5, status: "ok" });
    expect(state().routines[0]!.runningAt).toBeNull();
    answer({ jobs: [job({}, { runningAtMs: 5 })], hasMore: false });
    await loading;
    expect(reads).toBe(2);
    expect(state().routines[0]).toMatchObject({ runningAt: null, lastRunAt: 5 });
    routines.onClose();
  });

  it("an older finish does not clear a newer start, and a start older than the last run marks nothing", () => {
    const running = applyCronEvent([parseRoutine(job({}, { lastRunAtMs: 10 }))!], {
      jobId: JOB,
      action: "started",
      job: job({}, { runningAtMs: 20, lastRunAtMs: 10 }),
      runAtMs: 20,
    });
    expect(running[0]!.runningAt).toBe(20);
    const late = applyCronEvent(running, {
      jobId: JOB,
      action: "finished",
      job: job({}, { lastRunAtMs: 10 }),
      runAtMs: 10,
      status: "ok",
    });
    expect(late).toBe(running);
    const stale = applyCronEvent([parseRoutine(job({}, { lastRunAtMs: 30 }))!], {
      jobId: JOB,
      action: "started",
      job: job({}, { runningAtMs: 20 }),
      runAtMs: 20,
    });
    expect(stale[0]!.runningAt).toBeNull();
  });

  it("a finish never brings back a routine removed while it ran, and an older start or finish replaces nothing newer", () => {
    const listed = [parseRoutine(job({}, { runningAtMs: 20, lastRunAtMs: 10 }))!];
    const gone = applyCronEvent(listed, { jobId: JOB, action: "removed" });
    // OpenClaw finishes a run whose job was removed while it ran, with that job's snapshot.
    expect(
      applyCronEvent(gone, {
        jobId: JOB,
        action: "finished",
        job: job({}, { lastRunAtMs: 20, lastRunStatus: "ok" }),
        runAtMs: 20,
        status: "ok",
      }),
    ).toEqual([]);
    const done = [parseRoutine(job({}, { lastRunAtMs: 30, lastRunStatus: "ok" }))!];
    expect(
      applyCronEvent(done, {
        jobId: JOB,
        action: "finished",
        job: job({}, { lastRunAtMs: 20, lastRunStatus: "error" }),
        runAtMs: 20,
        status: "error",
      }),
    ).toBe(done);
    const running = [parseRoutine(job({}, { runningAtMs: 40, lastRunAtMs: 30 }))!];
    expect(
      applyCronEvent(running, {
        jobId: JOB,
        action: "started",
        job: job({}, { runningAtMs: 35, lastRunAtMs: 30 }),
        runAtMs: 35,
      }),
    ).toBe(running);
  });

  it("a finish for a routine not listed reads the list again, and a check-in's does not", async () => {
    let reads = 0;
    const { routines, state } = engine(
      {
        "cron.status": () => ({ enabled: true }),
        "cron.list": () => {
          reads += 1;
          return { jobs: [], hasMore: false };
        },
      },
      { ...initialRoutinesState, status: "loaded" },
    );
    routines.onEvent({ jobId: heartbeat.id, action: "finished", job: heartbeat, runAtMs: 5 });
    routines.onEvent({ jobId: JOB, action: "finished", job: job(), runAtMs: 5, status: "ok" });
    expect(state().routines).toEqual([]);
    await until(() => reads === 1);
    expect(state().routines).toEqual([]);
    routines.onClose();
  });

  it("keeps one list read in flight: a refresh asked for meanwhile reads again after it", async () => {
    let answer: (value: unknown) => void = () => {};
    let reads = 0;
    const { routines } = engine({
      "cron.status": () => ({ enabled: true }),
      "cron.list": () => {
        reads += 1;
        if (reads === 1) return new Promise((resolve) => (answer = resolve));
        return { jobs: [], hasMore: false };
      },
    });
    const first = routines.load();
    await until(() => reads === 1);
    const second = routines.load();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(reads).toBe(1);
    answer({ jobs: [], hasMore: false });
    await Promise.all([first, second]);
    expect(reads).toBe(2);
    routines.onClose();
  });

  it("does not try again a refusal another try would get: a missing scope, an unknown method, no connection", async () => {
    vi.useFakeTimers();
    const refusals = [
      Object.assign(new Error("missing scope: operator.read"), {
        details: { code: "MISSING_SCOPE" },
      }),
      new Error("unknown method: cron.list"),
      Object.assign(new Error("not connected"), { name: "NotSentError" }),
    ];
    for (const refusal of refusals) {
      let reads = 0;
      const { routines, state } = engine({
        "cron.status": () => ({ enabled: true }),
        "cron.list": () => {
          reads += 1;
          throw refusal;
        },
      });
      await routines.load();
      expect(state()).toMatchObject({ status: "error", error: refusal.message });
      await vi.advanceTimersByTimeAsync(RETRY_MS * 2);
      expect(reads).toBe(1);
    }
  });

  it("a dropped finished is found by reading the list again while a routine is marked running", async () => {
    vi.useFakeTimers();
    let running = true;
    const { routines, state } = engine({
      "cron.status": () => ({ enabled: true }),
      "cron.list": () => ({
        jobs: [job({}, running ? { runningAtMs: 5 } : { lastRunAtMs: 5, lastRunStatus: "ok" })],
        hasMore: false,
      }),
    });
    await routines.load();
    expect(state().routines[0]!.runningAt).toBe(5);
    // The run finishes; its event never arrives (the gateway sends `cron` with dropIfSlow).
    running = false;
    await vi.advanceTimersByTimeAsync(RUNNING_RECHECK_MS);
    expect(state().routines[0]).toMatchObject({ runningAt: null, lastRunAt: 5 });
    routines.onClose();
  });

  it("a failed refresh is tried again, and the stale mark goes once it reads", async () => {
    vi.useFakeTimers();
    let fail = false;
    let running = true;
    const { routines, state } = engine({
      "cron.status": () => ({ enabled: true }),
      "cron.list": () => {
        if (fail) throw new Error("request timed out");
        return { jobs: [job({}, running ? { runningAtMs: 5 } : {})], hasMore: false };
      },
    });
    await routines.load();
    fail = true;
    running = false;
    await routines.load();
    expect(state()).toMatchObject({ status: "error", error: "request timed out" });
    expect(state().routines[0]!.runningAt).toBe(5);
    fail = false;
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(state()).toMatchObject({ status: "loaded", error: null });
    expect(state().routines[0]!.runningAt).toBeNull();
    routines.onClose();
  });

  it("says a one-shot removed itself only when its successful finish came just before", () => {
    const oneShot = (over: Record<string, unknown> = {}) =>
      job({
        deleteAfterRun: true,
        schedule: { kind: "at", at: "2026-11-20T09:00:00-05:00" },
        ...over,
      });
    const once = parseRoutine(oneShot())!;
    const start = { ...initialRoutinesState, status: "loaded" as const, routines: [once] };
    const self = engine({}, start);
    // The gateway clears a consumed one-shot's next run in the snapshot it finishes with.
    self.routines.onEvent({
      jobId: JOB,
      action: "finished",
      job: { ...oneShot(), state: { lastRunAtMs: 7, lastRunStatus: "ok" } },
      status: "ok",
      completionStatus: "succeeded",
      runAtMs: 7,
    });
    self.routines.onEvent({ jobId: JOB, action: "removed" });
    expect(self.state().removed).toEqual({ id: JOB, ranOnce: true, runAt: 7 });
    // Removed by someone, after a run that ended some time before.
    const manual = engine({}, start);
    manual.routines.onEvent({
      jobId: JOB,
      action: "finished",
      job: oneShot(),
      status: "ok",
      runAtMs: 7,
    });
    manual.routines.onEvent({ jobId: JOB, action: "updated", job: oneShot({ name: "Renamed" }) });
    manual.routines.onEvent({ jobId: JOB, action: "removed" });
    expect(manual.state().removed).toEqual({ id: JOB, ranOnce: false, runAt: null });
    // Removed while running: the run is cancelled, and nothing ran once.
    const cancelled = engine({}, start);
    cancelled.routines.onEvent({
      jobId: JOB,
      action: "finished",
      job: oneShot(),
      status: "error",
      runAtMs: 7,
    });
    cancelled.routines.onEvent({ jobId: JOB, action: "removed" });
    expect(cancelled.state().removed).toMatchObject({ ranOnce: false });
    // Run now before its time succeeds and keeps the schedule; a deletion after it is someone's.
    const forced = engine({}, start);
    forced.routines.onEvent({
      jobId: JOB,
      action: "finished",
      job: oneShot(),
      status: "ok",
      completionStatus: "succeeded",
      runAtMs: 7,
      nextRunAtMs: 1_795_093_200_000,
    });
    forced.routines.onEvent({ jobId: JOB, action: "removed" });
    expect(forced.state().removed).toEqual({ id: JOB, ranOnce: false, runAt: 7 });
  });
});

describe("the cron event", () => {
  const list = [parseRoutine(job())!];
  it("added puts the new routine in the list", () => {
    const next = applyCronEvent(list, {
      jobId: "new",
      action: "added",
      job: job({ id: "new", name: "Plan the week" }),
    });
    expect(next.map((r) => r.name)).toEqual(["Morning digest", "Plan the week"]);
  });
  it("updated replaces it with the job the event carries", () => {
    const next = applyCronEvent(list, {
      jobId: JOB,
      action: "updated",
      job: job({ enabled: false }),
    });
    expect(next[0]!.enabled).toBe(false);
  });
  it("F-024: started marks it running from the event's runAtMs, and finished clears that with its last run", () => {
    const started = applyCronEvent(list, {
      jobId: JOB,
      action: "started",
      job: job({}, { runningAtMs: 1_795_045_912_353 }),
      runAtMs: 1_795_045_912_353,
    });
    expect(started[0]!.runningAt).toBe(1_795_045_912_353);
    const finished = applyCronEvent(started, {
      jobId: JOB,
      action: "finished",
      job: job({}, { lastRunAtMs: 1_795_045_912_353, lastRunStatus: "ok" }),
      status: "ok",
    });
    expect(finished[0]).toMatchObject({
      runningAt: null,
      lastStatus: "ok",
      lastRunAt: 1_795_045_912_353,
    });
  });
  it("removed takes it out", () => {
    expect(applyCronEvent(list, { jobId: JOB, action: "removed" })).toEqual([]);
  });
  it("a check-in job's events change nothing", () => {
    expect(
      applyCronEvent(list, { jobId: heartbeat.id, action: "started", job: heartbeat, runAtMs: 1 }),
    ).toBe(list);
  });
});

describe("F-355: a routine's runs", () => {
  it("are at most 20, in the gateway's order: newest finished first", async () => {
    const entries = Array.from({ length: 27 }, (_, index) => runEntry(1_000_000 - index * 60_000));
    const { routines, requests } = engine({ "cron.runs": () => ({ entries, total: 27 }) });
    const runs = await routines.runs(JOB);
    expect(requests[0]!.params).toEqual({ id: JOB, limit: MAX_ROUTINE_RUNS });
    expect(runs.map((run) => run.runAt)).toEqual(
      entries.slice(0, 20).map((entry) => entry.runAtMs),
    );
  });

  it("keep a run that started earlier but finished later above one that started after it", async () => {
    // Overlapping runs: A started at 100 and finished at 900, B started at 200 and finished at 300.
    const entries = [
      runEntry(100, { ts: 900, runId: "A" }),
      runEntry(200, { ts: 300, runId: "B" }),
    ];
    const { routines } = engine({ "cron.runs": () => ({ entries }) });
    expect((await routines.runs(JOB)).map((run) => run.runId)).toEqual(["A", "B"]);
  });

  it("F-190: carry how each ended, its usage and whether it was started by hand", async () => {
    const { routines } = engine({
      "cron.runs": () => ({
        entries: [
          runEntry(2, {
            status: "error",
            completionStatus: "failed",
            error: "Channel is required (no configured channels detected).",
            runId: "run-2",
          }),
          runEntry(1),
        ],
      }),
    });
    expect(await routines.runs(JOB)).toMatchObject([
      {
        status: "error",
        error: "Channel is required (no configured channels detected).",
        manual: false,
      },
      { status: "ok", completion: "succeeded", totalTokens: 600, durationMs: 1815, manual: true },
    ]);
  });
});

describe("F-197: the calendar's recorded runs", () => {
  it("pages back until runs finished before the dates shown, and keeps those that started in them", async () => {
    const DAY = 86_400_000;
    const from = 10 * DAY;
    const to = 17 * DAY;
    // A busy routine fills the first page; the quiet one's run is further back.
    const busy = Array.from({ length: 200 }, (_, index) =>
      runEntry(to - 1 - index * 60_000, { jobId: "busy" }),
    );
    const quiet = [runEntry(from + DAY), runEntry(from - DAY)];
    const { routines, requests } = engine({
      "cron.runs": (params) =>
        params.offset === 0
          ? { entries: busy, hasMore: true, nextOffset: 200 }
          : { entries: quiet, hasMore: false, nextOffset: null },
    });
    const read = await routines.calendarRuns(from, to);
    expect(requests.map((r) => r.params)).toEqual([
      { scope: "all", limit: 200, offset: 0 },
      { scope: "all", limit: 200, offset: 200 },
    ]);
    expect(read.partial).toBe(false);
    expect(read.runs).toHaveLength(201);
    expect(read.runs.at(-1)!.runAt).toBe(from + DAY);
  });

  it("is partial when the most it reads does not reach back to the dates' start", async () => {
    const { routines, requests } = engine({
      "cron.runs": (params) => ({
        entries: Array.from({ length: 200 }, (_, index) =>
          runEntry(10_000_000 - (params.offset as number) - index),
        ),
        hasMore: true,
        nextOffset: (params.offset as number) + 200,
      }),
    });
    const read = await routines.calendarRuns(0, 20_000_000);
    expect(read.partial).toBe(true);
    expect(requests).toHaveLength(MAX_CALENDAR_RUNS / 200);
  });

  it("passes a failed read on", async () => {
    const { routines } = engine({
      "cron.runs": () => {
        throw new Error("request timed out");
      },
    });
    await expect(routines.calendarRuns(0, 1)).rejects.toThrow("request timed out");
  });
});

describe("F-193: a run's conversation", () => {
  const recorded = (content: string, provenance: Record<string, unknown> = {}) => ({
    messages: [
      {
        role: "assistant",
        content,
        provenance: {
          kind: "internal_system",
          sourceTool: "cron",
          jobId: JOB,
          sourceSessionKey: SESSION,
          ...provenance,
        },
      },
      { role: "assistant", content: [{ type: "text", text: "Three notes from yesterday." }] },
    ],
  });

  const RUN = { runId: "run-1", runAt: 1_795_045_912_353, sessionKey: SESSION };

  it("shows the message recorded with the run, whole, not the routine's current instruction", async () => {
    const recordedText =
      "first text\nCurrent time: Wednesday\n\nThis is an unattended scheduled run.";
    const { routines, requests } = engine({ "cron.history": () => recorded(recordedText) });
    const conversation = await routines.conversation(JOB, RUN);
    expect(requests[0]!.params).toEqual({ id: JOB, runId: "run-1", limit: 200 });
    expect(conversation).toMatchObject({ status: "kept", message: recordedText });
    expect(conversation.status === "kept" && conversation.items[0]!.blocks).toEqual([
      { kind: "text", text: "Three notes from yesterday." },
    ]);
  });

  it("returns a long recorded instruction with the gateway's footer whole, and says when one is cut", async () => {
    const footer =
      "\n\nThis is an unattended scheduled run. Nobody is present to clarify or approve, so complete the task with what you have.";
    const long = `${"a".repeat(4_096)}${footer}`;
    const { routines } = engine({ "cron.history": () => recorded(long) });
    expect(await routines.conversation(JOB, RUN)).toMatchObject({
      status: "kept",
      message: long,
      messageCut: false,
    });
    const huge = engine({
      "cron.history": () => recorded("b".repeat(MAX_RUN_MESSAGE_CHARS + 10)),
    });
    const cut = await huge.routines.conversation(JOB, RUN);
    expect(cut).toMatchObject({ status: "kept", messageCut: true });
    expect(cut.status === "kept" && cut.message.length).toBeLessThanOrEqual(MAX_RUN_MESSAGE_CHARS);
  });

  it("is not kept without positive evidence: another run's session, no scheduler row, or a refusal", async () => {
    for (const result of [
      recorded("text", { sourceSessionKey: "agent:marlow:cron:other" }),
      recorded("text", { sourceTool: "chat" }),
      { messages: [] },
    ]) {
      const { routines } = engine({ "cron.history": () => result });
      expect(await routines.conversation(JOB, RUN)).toMatchObject({
        status: "none",
        reason: "not-kept",
      });
    }
    const { routines } = engine({
      "cron.history": () => {
        throw new Error(
          "The recorded cron transcript is unavailable. Refresh the run and try again.",
        );
      },
    });
    expect(await routines.conversation(JOB, RUN)).toEqual({
      status: "none",
      reason: "not-kept",
      error: "The recorded cron transcript is unavailable. Refresh the run and try again.",
    });
  });

  it("passes any other failure on, so it reads as a failed read, not a missing conversation", async () => {
    const { routines } = engine({
      "cron.history": () => {
        throw new Error("request timed out after 30000ms");
      },
    });
    await expect(routines.conversation(JOB, RUN)).rejects.toThrow("request timed out");
  });

  it("asks by the run's start when it has a session but no run id", async () => {
    const { routines, requests } = engine({ "cron.history": () => recorded("text") });
    await routines.conversation(JOB, { ...RUN, runId: null });
    expect(requests[0]!.params).toEqual({ id: JOB, runAtMs: RUN.runAt, limit: 200 });
  });

  it("reads older pages back to the scheduler's message, and says when it is further back than it reads", async () => {
    const reply = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
    const pages: Record<string, unknown> = {
      first: { messages: [reply("newest")], nextCursor: "older" },
      older: { messages: recorded("text").messages },
    };
    const { routines, requests } = engine({
      "cron.history": (params) => pages[(params.cursor as string | undefined) ?? "first"],
    });
    const read = await routines.conversation(JOB, RUN);
    expect(requests.map((r) => r.params.cursor)).toEqual([undefined, "older"]);
    expect(read.status === "kept" && read.items.map((item) => item.blocks)).toEqual([
      [{ kind: "text", text: "Three notes from yesterday." }],
      [{ kind: "text", text: "newest" }],
    ]);
    const endless = engine({
      "cron.history": () => ({ messages: [reply("more")], nextCursor: "again" }),
    });
    expect(await endless.routines.conversation(JOB, RUN)).toEqual({
      status: "none",
      reason: "too-long",
      error: null,
    });
  });

  it("is not asked for when the run had no session of its own (a reminder in the main conversation)", async () => {
    const { routines, requests } = engine({});
    expect(await routines.conversation(JOB, { ...RUN, sessionKey: null })).toEqual({
      status: "none",
      reason: "no-session",
      error: null,
    });
    expect(requests).toEqual([]);
  });
});

describe("the client", () => {
  it("F-024: reads routines on connect and applies the gateway's cron events to them", async () => {
    const gateway = grantingGateway();
    gateway.handlers["cron.status"] = () => ({ enabled: true });
    gateway.handlers["cron.list"] = () => ({ jobs: [job()], hasMore: false });
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: JSON.stringify({
        token: "device-token",
        grantedScopes: ["operator.read"],
        heldScopes: ["operator.read"],
      }),
    });
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await until(() => client.state.routines.status === "loaded");
    gateway.emit("cron", {
      jobId: JOB,
      action: "started",
      job: job({}, { runningAtMs: 5 }),
      runAtMs: 5,
    });
    await until(() => client.state.routines.routines[0]?.runningAt === 5);
    gateway.emit("cron", { jobId: JOB, action: "finished", job: job(), status: "ok" });
    await until(() => client.state.routines.routines[0]?.runningAt === null);
    gateway.emit("cron", { jobId: JOB, action: "removed" });
    await until(() => client.state.routines.routines.length === 0);
    client.stop();
  });
});
