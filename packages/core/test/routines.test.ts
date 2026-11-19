// The routines engine against payloads shaped as a development gateway
// (2026.10.6) returned them (docs/decisions.md, "Routines: what the gateway
// returns"), and the client applying the `cron` event it sends.

import { describe, expect, it } from "vitest";
import { ClawtrateClient } from "../src/client.ts";
import {
  applyCronEvent,
  initialRoutinesState,
  MAX_ROUTINE_RUNS,
  parseRoutine,
  RoutinesEngine,
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

function engine(handlers: Record<string, (params: Record<string, unknown>) => unknown>) {
  let state: RoutinesState = initialRoutinesState;
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

describe("F-191 the routine list", () => {
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
  it("F-024 started marks it running from the event's runAtMs, and finished clears that with its last run", () => {
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

describe("F-355 a routine's runs", () => {
  it("are the 20 most recent, newest first, however many the gateway returns", async () => {
    // Out of order and more than 20, so both the cut and the order are the engine's.
    const entries = Array.from({ length: 27 }, (_, index) =>
      runEntry(1_000_000 + ((index * 7) % 27) * 60_000),
    );
    const { routines, requests } = engine({ "cron.runs": () => ({ entries, total: 27 }) });
    const runs = await routines.runs(JOB);
    expect(requests[0]!.params).toEqual({ id: JOB, limit: MAX_ROUTINE_RUNS });
    expect(runs).toHaveLength(20);
    expect(runs.map((run) => run.runAt)).toEqual(
      Array.from({ length: 20 }, (_, index) => 1_000_000 + (26 - index) * 60_000),
    );
  });

  it("F-190 carry how each ended, its usage and whether it was started by hand", async () => {
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

describe("F-193 a run's conversation", () => {
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

  it("shows the message recorded with the run, not the routine's current instruction", async () => {
    const { routines, requests } = engine({
      "cron.history": () =>
        recorded("first text\nCurrent time: Wednesday\n\nThis is an unattended scheduled run."),
    });
    const conversation = await routines.conversation(JOB, "run-1", SESSION);
    expect(requests[0]!.params).toEqual({ id: JOB, runId: "run-1" });
    expect(conversation).toMatchObject({
      status: "kept",
      message: "first text",
      added: "Current time: Wednesday\n\nThis is an unattended scheduled run.",
    });
    expect(conversation.status === "kept" && conversation.items[0]!.blocks).toEqual([
      { kind: "text", text: "Three notes from yesterday." },
    ]);
  });

  it("is not kept without positive evidence: another run's session, no scheduler row, or a refusal", async () => {
    for (const result of [
      recorded("text", { sourceSessionKey: "agent:marlow:cron:other" }),
      recorded("text", { sourceTool: "chat" }),
      { messages: [] },
    ]) {
      const { routines } = engine({ "cron.history": () => result });
      expect(await routines.conversation(JOB, "run-1", SESSION)).toMatchObject({
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
    expect(await routines.conversation(JOB, "run-1", SESSION)).toEqual({
      status: "none",
      reason: "not-kept",
      error: "The recorded cron transcript is unavailable. Refresh the run and try again.",
    });
  });

  it("is not asked for when the run had no session of its own (a reminder in the main conversation)", async () => {
    const { routines, requests } = engine({});
    expect(await routines.conversation(JOB, "run-1", null)).toEqual({
      status: "none",
      reason: "no-session",
      error: null,
    });
    expect(requests).toEqual([]);
  });
});

describe("the client", () => {
  it("F-024 reads routines on connect and applies the gateway's cron events to them", async () => {
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
