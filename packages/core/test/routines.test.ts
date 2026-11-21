// The routines engine against payloads shaped as a development gateway
// (2026.10.6) returned them (docs/decisions.md, "Routines: what the gateway
// returns"), and the client applying the `cron` event it sends.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ClawtrateClient } from "../src/client.ts";
import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import * as protocol from "@openclaw/gateway-protocol";
import {
  applyCronEvent,
  fieldsOf,
  initialRoutinesState,
  MAX_CALENDAR_RUNS,
  MAX_ROUTINE_RUNS,
  MAX_ROUTINES,
  MAX_RUN_MESSAGE_CHARS,
  parseRoutine,
  patchOf,
  RETRY_MS,
  RoutinesEngine,
  RUNNING_RECHECK_MS,
  type RoutineFields,
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
  access: {
    admin: boolean;
    connected: boolean;
    /** The connection's confirmed gateway identity; null means not read yet. */
    identity?: string | null;
    withdrawn?: (owner: object) => boolean;
  } = { admin: false, connected: true },
) {
  let state: RoutinesState = start;
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const routines = new RoutinesEngine({
    request: async (method, params) => {
      requests.push({ method, params: params as Record<string, unknown> });
      // Every request is one the pinned 2026.10.6 schema accepts.
      const name = `validate${method.replace(/(^|\.)(\w)/gu, (_, __, c: string) => c.toUpperCase())}Params`;
      const validate = (
        protocol as unknown as Record<string, ((value: unknown) => boolean) & { errors?: unknown }>
      )[name];
      if (!validate) throw new Error(`no schema for ${method}`);
      if (!validate(params))
        throw new Error(`${method} params: ${JSON.stringify(validate.errors)}`);
      const handler = handlers[method];
      if (!handler) throw new Error(`unexpected ${method}`);
      return handler(params as Record<string, unknown>);
    },
    get: () => state,
    update: (change) => {
      state = change(state);
    },
    connected: () => access.connected,
    admin: () => access.admin,
    identity: () => (access.identity === undefined ? "gateway-1" : access.identity),
    withdrawn: access.withdrawn ?? (() => false),
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

  it("offers a copy after a deletion only when recovery can write the job again (F-189)", () => {
    expect(parseRoutine(job())?.canRecreate).toBe(true);
    // The gateway anchors every new every-job; the copy carries the phase (below).
    expect(
      parseRoutine(job({ schedule: { kind: "every", everyMs: 3_600_000, anchorMs: 60_000 } }))
        ?.canRecreate,
    ).toBe(true);
    const oneShot = job({
      schedule: { kind: "at", at: "2035-01-01T14:00:00.000Z" },
      deleteAfterRun: true,
      state: {},
    });
    expect(parseRoutine(oneShot)?.canRecreate).toBe(true);
    // A paused routine must not come back running: cron.add takes no enabled.
    expect(parseRoutine(job({ enabled: false }))?.canRecreate).toBe(false);
    // The form writes wakeMode now alone.
    expect(parseRoutine(job({ wakeMode: "next-heartbeat" }))?.canRecreate).toBe(false);
    // The gateway defaults a new one-shot to deleting itself.
    expect(parseRoutine({ ...oneShot, deleteAfterRun: false })?.canRecreate).toBe(false);
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

  it("F-350: a pause the gateway confirms while the list is read is not undone by that older read", async () => {
    let answer: (value: unknown) => void = () => {};
    let reads = 0;
    const { routines, state } = engine(
      {
        "cron.status": () => ({ enabled: true }),
        "cron.list": () => {
          reads += 1;
          // The first read is the gateway's answer from before the pause landed.
          if (reads === 1) return new Promise((resolve) => (answer = resolve));
          return { jobs: [job({ enabled: false })], hasMore: false };
        },
        "cron.update": () => job({ enabled: false }),
      },
      { ...initialRoutinesState, status: "loaded", routines: [parseRoutine(job())!] },
      ADMIN,
    );
    const loading = routines.load();
    await until(() => reads === 1);
    expect(await routines.setEnabled(JOB, false)).toMatchObject({ status: "saved" });
    answer({ jobs: [job()], hasMore: false });
    await loading;
    expect(reads).toBe(2);
    expect(state().routines[0]).toMatchObject({ enabled: false });
    routines.onClose();
  });

  it("retries an initial list when events invalidate every immediate read", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const { routines, state } = engine({
      "cron.status": () => ({ enabled: true }),
      "cron.list": () => {
        reads += 1;
        if (reads > 3) return { jobs: [], hasMore: false };
        routines.onEvent({ jobId: JOB, action: "removed" });
        return { jobs: [job()], hasMore: false };
      },
    });
    await routines.load();
    expect(state()).toMatchObject({ status: "loading", routines: [] });
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(state()).toMatchObject({ status: "loaded", routines: [] });
    routines.onClose();
  });

  it("a fresh read changes the revision, so a bot's own read is made again after a reconnect", async () => {
    const { routines, state } = engine({
      "cron.status": () => ({ enabled: true }),
      "cron.list": () => ({ jobs: [job()], hasMore: false }),
    });
    await routines.load();
    const first = state().revision;
    await routines.load();
    expect(state().revision).not.toBe(first);
    routines.onClose();
  });

  it("uses the gateway's finish fields when the event has no job snapshot", () => {
    const current = parseRoutine(job({}, { runningAtMs: 20, lastRunStatus: "ok" }))!;
    const finished = applyCronEvent([current], {
      jobId: JOB,
      action: "finished",
      runAtMs: 20,
      durationMs: 5,
      status: "error",
      error: "The job failed.",
      nextRunAtMs: 50,
    });
    expect(finished[0]).toMatchObject({
      runningAt: null,
      lastRunAt: 20,
      lastEndedAt: 25,
      lastStatus: "error",
      lastError: "The job failed.",
      nextRunAt: 50,
    });
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

const refused = (message: string) =>
  new GatewayProtocolRequestError({ code: "INVALID_REQUEST", message });
/** The pinned gateway's answer for a job that no longer exists. */
const missing = (id: string) =>
  new GatewayProtocolRequestError({
    code: "INVALID_REQUEST",
    message: `Automation not found: ${id}. List automations and retry with a current job id.`,
    details: { code: "CRON_JOB_NOT_FOUND", jobId: id },
  });
const ADMIN = { admin: true, connected: true };

describe("changing routines needs admin", () => {
  it("F-189 F-350 F-351 F-352: below admin nothing is sent, whatever asked for it", async () => {
    const { routines, requests } = engine({});
    const expected = parseRoutine(job())!;
    const fields = fieldsOf(expected);
    expect(await routines.create({ ...fields, botId: "marlow" }, "k1")).toEqual({
      status: "not-sent",
      reason: "admin",
    });
    expect(await routines.update(JOB, fields, { ...fields, name: "New" }, expected)).toMatchObject({
      status: "not-sent",
    });
    expect(await routines.setEnabled(JOB, false)).toMatchObject({ status: "not-sent" });
    expect(await routines.runNow(JOB)).toMatchObject({ status: "not-sent" });
    expect(await routines.remove(JOB)).toMatchObject({ status: "not-sent" });
    expect(await routines.hooks()).toBeNull();
    expect(requests).toEqual([]);
  });
});

describe("F-189: creating a routine", () => {
  const input = { ...fieldsOf(parseRoutine(job())!), botId: "marlow" };

  it("adds it under the draft's own key, results kept with the run, and calls it saved only from the gateway's answer", async () => {
    const { routines, requests, state } = engine(
      {
        "cron.add": (params) => ({
          created: true,
          job: job({ declarationKey: params.declarationKey }),
        }),
      },
      initialRoutinesState,
      ADMIN,
    );
    const result = await routines.create(input, "draft-1");
    expect(requests[0]).toEqual({
      method: "cron.add",
      params: {
        name: "Morning digest",
        agentId: "marlow",
        schedule: { kind: "cron", expr: "0 8 * * 1-5", tz: "America/New_York" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Summarise yesterday's notes." },
        delivery: { mode: "none" },
        declarationKey: "clawtrate:draft-1",
      },
    });
    expect(result).toMatchObject({ status: "saved", routine: { id: JOB } });
    expect(state().routines.map((r) => r.id)).toEqual([JOB]);
  });

  it.each([
    { name: "plain text", prefix: "a".repeat(4_094) },
    { name: "quoted text", prefix: '"'.repeat(2_047) },
  ])(
    "F-189: confirms the full $name instruction in create and edit replies before clipping it for display",
    async ({ prefix }) => {
      const text = prefix + "x";
      const original = parseRoutine(job())!;
      const fields = fieldsOf(original);
      for (const [reply, status] of [
        [text, "saved"],
        [prefix + "y", "unknown"],
      ]) {
        const answer = job({ payload: { kind: "agentTurn", message: reply } });
        const { routines } = engine(
          {
            "cron.add": () => ({ created: true, job: answer }),
            "cron.get": () => job(),
            "cron.update": () => answer,
          },
          initialRoutinesState,
          ADMIN,
        );
        const edit = { ...fields, text };
        const results = [
          await routines.create({ ...edit, botId: "marlow" }, "draft-1"),
          await routines.update(JOB, fields, edit, original),
        ];
        for (const result of results) {
          expect(result.status).toBe(status);
          if (result.status === "saved") {
            expect(result.routine.textCut).toBe(true);
            expect(result.routine.text.length).toBeLessThan(text.length);
          }
        }
      }
    },
  );

  it("sends nothing before the gateway's identity is confirmed, so a draft cannot reach a replacement gateway", async () => {
    const { routines, requests } = engine({ "cron.add": () => job() }, initialRoutinesState, {
      ...ADMIN,
      identity: null,
    });
    expect(await routines.create(input, "draft-1")).toMatchObject({
      status: "not-sent",
      reason: "gateway",
    });
    expect(requests).toEqual([]);
  });

  it("sends nothing for a draft that never learned its gateway, though a gateway is confirmed now", async () => {
    const { routines, requests } = engine({ "cron.add": () => job() }, initialRoutinesState, ADMIN);
    expect(await routines.create(input, "draft-1", {}, null)).toMatchObject({
      status: "not-sent",
      reason: "gateway",
    });
    expect(requests).toEqual([]);
  });

  it("sends nothing to a confirmed replacement gateway either: the write waits for its draft's own gateway", async () => {
    const once = job();
    const expected = parseRoutine(once)!;
    const { routines, requests } = engine(
      { "cron.add": () => job(), "cron.get": () => once, "cron.update": () => once },
      initialRoutinesState,
      ADMIN,
    );
    expect(
      await routines.create(input, "draft-1", {}, "the gateway the draft was opened on"),
    ).toMatchObject({ status: "not-sent", reason: "gateway" });
    expect(
      await routines.update(
        JOB,
        fieldsOf(expected),
        { ...fieldsOf(expected), name: "x" },
        expected,
        {},
        "another gateway",
      ),
    ).toMatchObject({ status: "not-sent", reason: "gateway" });
    expect(requests).toEqual([]);
    // Its own gateway, confirmed: the write goes out.
    expect(await routines.create(input, "draft-2", {}, "gateway-1")).toMatchObject({
      status: "saved",
    });
    expect(requests.map((r) => r.method)).toEqual(["cron.add"]);
  });

  it("a recovery copy keeps the schedule's anchor and stagger (F-189)", async () => {
    const anchored = fieldsOf(
      parseRoutine(job({ schedule: { kind: "every", everyMs: 3_600_000, anchorMs: 60_000 } }))!,
    );
    const staggered = fieldsOf(
      parseRoutine(
        job({
          schedule: { kind: "cron", expr: "0 8 * * 1-5", tz: "America/New_York", staggerMs: 5 },
        }),
      )!,
    );
    const { routines, requests } = engine(
      {
        "cron.add": (params) => ({
          created: true,
          job: job({ name: params.name, schedule: params.schedule, payload: params.payload }),
        }),
      },
      initialRoutinesState,
      ADMIN,
    );
    expect(await routines.create({ ...anchored, botId: "marlow" }, "draft-1")).toMatchObject({
      status: "saved",
    });
    expect(requests[0]!.params).toMatchObject({
      schedule: { kind: "every", everyMs: 3_600_000, anchorMs: 60_000 },
    });
    expect(await routines.create({ ...staggered, botId: "marlow" }, "draft-2")).toMatchObject({
      status: "saved",
    });
    expect(requests[1]!.params).toMatchObject({
      schedule: { kind: "cron", expr: "0 8 * * 1-5", tz: "America/New_York", staggerMs: 5 },
    });
    // A new routine of the form's own carries neither: the gateway anchors it at now.
    await routines.create({ ...fieldsOf(parseRoutine(job())!), botId: "marlow" }, "draft-3");
    expect(requests[2]!.params).toMatchObject({
      schedule: { kind: "cron", expr: "0 8 * * 1-5", tz: "America/New_York" },
    });
  });

  it("says why the gateway refused, and an answer that never came is unknown, not saved", async () => {
    const bad = engine(
      {
        "cron.add": () => {
          throw refused(
            "invalid cron.add params: CronPattern: invalid configuration format ('99 * * *')",
          );
        },
      },
      initialRoutinesState,
      ADMIN,
    );
    expect(await bad.routines.create(input, "k")).toEqual({
      status: "refused",
      error: "invalid cron.add params: CronPattern: invalid configuration format ('99 * * *')",
    });
    const silent = engine(
      {
        "cron.add": () => {
          throw new Error("gateway request timed out");
        },
      },
      initialRoutinesState,
      ADMIN,
    );
    expect(await silent.routines.create(input, "k")).toMatchObject({ status: "unknown" });
    expect(silent.state().routines).toEqual([]);
  });

  it("finds a create in doubt by the draft's key only, never another routine of the same name and bot", async () => {
    const { routines } = engine({
      "cron.list": () => ({
        jobs: [
          job({ id: "theirs", declarationKey: "clawtrate:someone-else" }),
          job({ id: "other-client" }),
        ],
        hasMore: false,
      }),
    });
    expect(await routines.findCreated("draft-1")).toBeNull();
    const found = engine({
      "cron.list": () => ({
        jobs: [
          job({ id: "other-client" }),
          job({ id: "mine", declarationKey: "clawtrate:draft-1" }),
        ],
        hasMore: false,
      }),
    });
    expect((await found.routines.findCreated("draft-1"))?.id).toBe("mine");
  });

  it("F-189: a find answered after the connection changed is refused, though the answer has the draft's routine", async () => {
    let answer!: (value: unknown) => void;
    const access = { ...ADMIN, identity: "gateway-1" as string | null };
    const { routines } = engine(
      { "cron.list": () => new Promise((resolve) => (answer = resolve)) },
      initialRoutinesState,
      access,
    );
    const find = routines.findCreated("draft-1", "gateway-1");
    void find.catch(() => {});
    await Promise.resolve();
    // The connection drops and another gateway answers while the list is out.
    routines.onClose();
    access.identity = "gateway-2";
    answer({ jobs: [job({ id: "mine", declarationKey: "clawtrate:draft-1" })], hasMore: false });
    await expect(find).rejects.toThrow("Another gateway is connected now");
  });

  it("writes a one-time schedule as a time with its offset, never a zone beside it", () => {
    const original = fieldsOf(parseRoutine(job())!);
    const at = {
      ...original.schedule,
      kind: "at" as const,
      expr: null,
      tz: null,
      at: "2035-01-01T09:00:00-05:00",
    };
    expect(patchOf(original, { ...original, schedule: at }, "agentTurn")).toEqual({
      schedule: { kind: "at", at: "2035-01-01T09:00:00-05:00" },
    });
    // A wall time with no offset is not written: the gateway would read it as UTC.
    expect(
      patchOf(
        original,
        { ...original, schedule: { ...at, at: "2035-01-01T09:00:00" } },
        "agentTurn",
      ),
    ).toEqual({});
  });
});

describe("F-189: changing a routine", () => {
  const once = job({
    schedule: { kind: "at", at: "2035-01-01T14:00:00.000Z" },
    deleteAfterRun: true,
  });
  const expected = parseRoutine(once)!;
  const original = fieldsOf(expected);

  it("writes only what changed: a new name leaves the saved time as it is", async () => {
    const { routines, requests } = engine(
      {
        "cron.get": () => once,
        "cron.update": (params) => ({ ...once, ...(params.patch as Record<string, unknown>) }),
      },
      initialRoutinesState,
      ADMIN,
    );
    // The editor may hold the same instant written with an offset.
    const edit: RoutineFields = {
      ...original,
      name: "New year note",
      schedule: { ...original.schedule, at: "2035-01-01T09:00:00-05:00" },
    };
    expect(await routines.update(JOB, original, edit, expected)).toMatchObject({
      status: "saved",
      routine: { name: "New year note", schedule: { at: "2035-01-01T14:00:00.000Z" } },
    });
    expect(requests.at(-1)).toEqual({
      method: "cron.update",
      params: { id: JOB, patch: { name: "New year note" } },
    });
  });

  it("writes nothing for a viewer that went away while its read was on its way", async () => {
    let gone = false;
    const { routines, requests } = engine(
      {
        "cron.get": () => {
          // The initiating viewer was disposed while the gateway was asked.
          gone = true;
          return once;
        },
      },
      initialRoutinesState,
      { ...ADMIN, withdrawn: () => gone },
    );
    expect(
      await routines.update(JOB, original, { ...original, name: "Mine" }, expected, {}),
    ).toMatchObject({ status: "not-sent", reason: "offline" });
    expect(requests.map((r) => r.method)).toEqual(["cron.get"]);
  });

  it("writes nothing when another client changed it since the editor opened, and gives back the new version", async () => {
    const { routines, requests } = engine(
      { "cron.get": () => ({ ...once, payload: { kind: "agentTurn", message: "Theirs." } }) },
      initialRoutinesState,
      ADMIN,
    );
    expect(
      await routines.update(JOB, original, { ...original, name: "Mine" }, expected),
    ).toMatchObject({
      status: "conflict",
      current: { text: "Theirs." },
    });
    expect(requests.map((r) => r.method)).toEqual(["cron.get"]);
  });

  it("says when it was deleted elsewhere, and keeps the gateway's reason for a refusal", async () => {
    const gone = engine(
      {
        "cron.get": () => {
          throw missing(JOB);
        },
      },
      initialRoutinesState,
      ADMIN,
    );
    expect(await gone.routines.update(JOB, original, { ...original, name: "x" }, expected)).toEqual(
      {
        status: "deleted",
      },
    );
    const bad = engine(
      {
        "cron.get": () => once,
        "cron.update": () => {
          throw refused("invalid cron.update params: CronPattern: invalid configuration format");
        },
      },
      initialRoutinesState,
      ADMIN,
    );
    expect(
      await bad.routines.update(
        JOB,
        original,
        {
          ...original,
          schedule: {
            kind: "cron",
            expr: "99 * * *",
            tz: null,
            everyMs: null,
            at: null,
            name: null,
          },
        },
        expected,
      ),
    ).toEqual({
      status: "refused",
      error: "invalid cron.update params: CronPattern: invalid configuration format",
    });
  });

  it("keeps a reminder a reminder: its text is written as a system event, never as a bot's turn", () => {
    const reminder = parseRoutine(
      job({ sessionTarget: "main", payload: { kind: "systemEvent", text: "Stretch" } }),
    )!;
    expect(
      patchOf(fieldsOf(reminder), { ...fieldsOf(reminder), text: "Stand up" }, "systemEvent"),
    ).toEqual({
      payload: { kind: "systemEvent", text: "Stand up" },
    });
    // A command or script is never written from here.
    expect(patchOf(fieldsOf(reminder), { ...fieldsOf(reminder), text: "rm" }, "other")).toEqual({});
  });

  it("checks for a newer revision after the person acknowledged a conflict", async () => {
    const current = { ...once, updatedAtMs: 30, name: "Theirs" };
    const { routines, requests } = engine(
      { "cron.get": () => current },
      initialRoutinesState,
      ADMIN,
    );
    const acknowledged = { ...parseRoutine(current)!, updatedAt: 29 };
    expect(
      await routines.update(JOB, original, { ...original, name: "Mine" }, acknowledged),
    ).toMatchObject({
      status: "conflict",
      current: { updatedAt: 30 },
    });
    expect(requests.map((request) => request.method)).toEqual(["cron.get"]);
  });

  it("F-189: holds the write to the definition it checked, so another editor's save in between is a conflict, not overwritten", async () => {
    const theirs = { ...once, updatedAtMs: 31, name: "Theirs", configRevision: "r2" };
    let reads = 0;
    const { routines, requests } = engine(
      {
        "cron.get": () => (reads++ === 0 ? { ...once, configRevision: "r1" } : theirs),
        "cron.update": () => {
          throw new GatewayProtocolRequestError({
            code: "INVALID_REQUEST",
            message: "cron job definition no longer matches the loaded version",
            details: { code: "CRON_JOB_CHANGED" },
          });
        },
      },
      initialRoutinesState,
      ADMIN,
    );
    expect(
      await routines.update(JOB, original, { ...original, name: "Mine" }, expected),
    ).toMatchObject({ status: "conflict", current: { name: "Theirs", updatedAt: 31 } });
    expect(requests.find((request) => request.method === "cron.update")?.params).toMatchObject({
      expectedConfigRevision: "r1",
    });
  });

  it("F-350 F-351 F-352: after a reconnect, a row's pause, run and delete send nothing until this connection's list is read", async () => {
    const { routines, requests, state } = engine(
      {
        "cron.status": () => ({ enabled: true }),
        "cron.list": () => ({ jobs: [once], hasMore: false }),
        "cron.update": () => ({ ...once, enabled: false }),
      },
      { ...initialRoutinesState, status: "loaded", routines: [expected] },
      ADMIN,
    );
    // The connection drops and another comes back at the address: the rows shown are the old one's.
    const shownOn = state().listedOn;
    routines.onClose();
    expect(await routines.setEnabled(JOB, false)).toEqual({
      status: "not-sent",
      reason: "gateway",
    });
    expect(await routines.runNow(JOB)).toEqual({ status: "not-sent", reason: "gateway" });
    expect(await routines.remove(JOB)).toEqual({ status: "not-sent", reason: "gateway" });
    expect(requests).toEqual([]);
    await routines.load();
    expect(state().listedOn).not.toBe(shownOn);
    // A row still on screen from the old list carries its list: refused, however late it is sent.
    expect(await routines.setEnabled(JOB, false, null, shownOn)).toEqual({
      status: "not-sent",
      reason: "gateway",
    });
    expect(await routines.remove(JOB, null, shownOn)).toEqual({
      status: "not-sent",
      reason: "gateway",
    });
    expect(requests).toEqual([
      { method: "cron.status", params: {} },
      expect.objectContaining({ method: "cron.list" }),
    ]);
    expect(await routines.setEnabled(JOB, false, null, state().listedOn)).toMatchObject({
      status: "saved",
    });
  });

  it("F-350: a pause that answers after the routine's removal was confirmed does not bring it back", async () => {
    const reply = Promise.withResolvers<unknown>();
    const sent = Promise.withResolvers<void>();
    const { routines, state } = engine(
      {
        "cron.update": () => {
          sent.resolve();
          return reply.promise;
        },
        "cron.remove": () => ({ ok: true, removed: true }),
      },
      { ...initialRoutinesState, status: "loaded", routines: [expected] },
      ADMIN,
    );
    const pausing = routines.setEnabled(JOB, false);
    await sent.promise;
    expect(await routines.remove(JOB)).toEqual({ status: "removed" });
    reply.resolve({ ...once, enabled: false });
    expect(await pausing).toEqual({ status: "deleted" });
    expect(state().routines).toEqual([]);
  });

  it("F-196: a read-back bound to no confirmed gateway is refused, though the host has no identity either", async () => {
    const { routines, requests } = engine({ "cron.get": () => once }, initialRoutinesState, {
      ...ADMIN,
      identity: null,
    });
    // The zone save's write went nowhere it could name, so a matching read proves nothing.
    await expect(routines.readOne(JOB, null)).rejects.toThrow();
    expect(requests).toEqual([]);
    // A read that names no gateway, as the page's own reads do, still reads.
    expect(await routines.readOne(JOB)).toMatchObject({ id: JOB });
  });

  it("F-189: only the gateway's not-found code says a routine is gone, not a refusal that says the words", async () => {
    const { routines } = engine(
      {
        "cron.get": () => {
          throw refused("delivery target not found for this account");
        },
      },
      initialRoutinesState,
      ADMIN,
    );
    expect(await routines.update(JOB, original, { ...original, name: "x" }, expected)).toEqual({
      status: "refused",
      error: "delivery target not found for this account",
    });
    await expect(routines.readOne(JOB)).rejects.toThrow(/not found for this account/u);
  });

  it("F-189: an answer for the routine that can't be read is not taken to mean it was deleted", async () => {
    for (const answer of ["unexpected", { ...once, id: "another-routine" }]) {
      const { routines } = engine({ "cron.get": () => answer }, initialRoutinesState, ADMIN);
      await expect(routines.readOne(JOB)).rejects.toThrow(/couldn't be read/u);
    }
  });

  it("F-189: a schedule change Clawtrate can't write is refused, not saved as a change to nothing", async () => {
    const { routines, requests } = engine({ "cron.get": () => once }, initialRoutinesState, ADMIN);
    const result = await routines.update(
      JOB,
      original,
      {
        ...original,
        schedule: {
          kind: "at",
          at: "2035-01-02T09:00:00",
          expr: null,
          tz: null,
          everyMs: null,
          name: null,
        },
      },
      expected,
    );
    expect(result).toEqual({ status: "refused", error: "Clawtrate can't write this schedule." });
    expect(requests.map((request) => request.method)).toEqual(["cron.get"]);
  });

  it("does not restore a removed routine when its in-flight save answers", async () => {
    const reply = Promise.withResolvers<unknown>();
    const sent = Promise.withResolvers<void>();
    const { routines, state } = engine(
      {
        "cron.get": () => once,
        "cron.update": () => {
          sent.resolve();
          return reply.promise;
        },
      },
      { ...initialRoutinesState, routines: [expected] },
      ADMIN,
    );
    const pending = routines.update(JOB, original, { ...original, name: "Late" }, expected);
    await sent.promise;
    routines.onEvent({ action: "removed", jobId: JOB });
    routines.onEvent({ action: "removed", jobId: "another-routine" });
    reply.resolve({ ...once, name: "Late" });
    expect(await pending).toEqual({ status: "deleted" });
    expect(state().routines).toEqual([]);
  });

  it("does not apply an answer from a connection that has since closed", async () => {
    let release: () => void = () => {};
    const { routines, state } = engine(
      {
        "cron.get": () => once,
        "cron.update": () =>
          new Promise((resolve) => {
            release = () => resolve({ ...once, name: "Late" });
          }),
      },
      initialRoutinesState,
      ADMIN,
    );
    const pending = routines.update(JOB, original, { ...original, name: "Late" }, expected);
    // Once `cron.update` is under way.
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 0));
    routines.onClose();
    release();
    expect(await pending).toMatchObject({ status: "saved" });
    expect(state().routines).toEqual([]);
  });
});

describe("F-350 F-351 F-352: pause, run now and delete", () => {
  it("F-350: pausing writes enabled alone and is done only when the gateway shows it paused", async () => {
    const { routines, requests } = engine(
      { "cron.update": () => job({ enabled: false }, { nextRunAtMs: undefined }) },
      initialRoutinesState,
      ADMIN,
    );
    expect(await routines.setEnabled(JOB, false)).toMatchObject({
      status: "saved",
      routine: { enabled: false, nextRunAt: null },
    });
    expect(requests[0]!.params).toEqual({ id: JOB, patch: { enabled: false } });
    const stale = engine({ "cron.update": () => job() }, initialRoutinesState, ADMIN);
    expect(await stale.routines.setEnabled(JOB, false)).toMatchObject({ status: "unknown" });
  });

  it("F-351: run now forces a run, and says when one is already in progress or it was refused", async () => {
    const answers = [
      { ok: true, enqueued: true, runId: `manual:${JOB}:1:1` },
      { ok: true, ran: false, reason: "already-running" },
    ];
    const { routines, requests } = engine(
      { "cron.run": () => answers.shift() },
      initialRoutinesState,
      ADMIN,
    );
    expect(await routines.runNow(JOB)).toEqual({ status: "started", runId: `manual:${JOB}:1:1` });
    expect(requests[0]!.params).toEqual({ id: JOB, mode: "force" });
    expect(await routines.runNow(JOB)).toEqual({ status: "already-running" });
    const bad = engine(
      {
        "cron.run": () => {
          throw refused("Automation not found: x.");
        },
      },
      initialRoutinesState,
      ADMIN,
    );
    expect(await bad.routines.runNow(JOB)).toEqual({
      status: "refused",
      error: "Automation not found: x.",
    });
  });

  it("F-352: deleting removes it from the list; one already gone counts as deleted", async () => {
    const { routines, state } = engine(
      {
        "cron.list": () => ({ jobs: [job()], hasMore: false }),
        "cron.status": () => ({ enabled: true }),
        "cron.remove": () => ({ ok: true, removed: true }),
      },
      initialRoutinesState,
      ADMIN,
    );
    await routines.load();
    expect(await routines.remove(JOB)).toEqual({ status: "removed" });
    expect(state().routines).toEqual([]);
    const gone = engine(
      {
        "cron.remove": () => {
          throw missing(JOB);
        },
      },
      initialRoutinesState,
      ADMIN,
    );
    expect(await gone.routines.remove(JOB)).toEqual({ status: "removed" });
  });

  it("F-352: an answer that does not say removed leaves the routine listed", async () => {
    const { routines, state } = engine(
      {
        "cron.list": () => ({ jobs: [job()], hasMore: false }),
        "cron.status": () => ({ enabled: true }),
        "cron.remove": () => ({ ok: true }),
      },
      initialRoutinesState,
      ADMIN,
    );
    await routines.load();
    expect(await routines.remove(JOB)).toMatchObject({
      status: "unknown",
      error: "The gateway answered, but didn't remove it.",
    });
    expect(state().routines.map((r) => r.id)).toEqual([JOB]);
  });

  it("F-349: reads the gateway's hooks from its config, with admin", async () => {
    const { routines } = engine(
      {
        "config.get": () => ({
          config: { hooks: { enabled: true, path: "/hooks", token: "__OPENCLAW_REDACTED__" } },
        }),
      },
      initialRoutinesState,
      ADMIN,
    );
    expect(await routines.hooks()).toEqual({ enabled: true, path: "/hooks" });
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
