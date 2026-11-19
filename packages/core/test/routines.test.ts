// The routines engine against payloads shaped as a development gateway
// (2026.10.6) returned them (docs/decisions.md, "Routines: what the gateway
// returns"), and the client applying the `cron` event it sends.

import { describe, expect, it } from "vitest";
import { ClawtrateClient } from "../src/client.ts";
import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import {
  applyCronEvent,
  fieldsOf,
  initialRoutinesState,
  MAX_ROUTINE_RUNS,
  parseRoutine,
  patchOf,
  RoutinesEngine,
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
  access: { admin: boolean; connected: boolean } = { admin: false, connected: true },
) {
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
    connected: () => access.connected,
    admin: () => access.admin,
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

const refused = (message: string) =>
  new GatewayProtocolRequestError({ code: "INVALID_REQUEST", message });
const ADMIN = { admin: true, connected: true };

describe("changing routines needs admin", () => {
  it("F-189 F-350 F-351 F-352: below admin nothing is sent, whatever asked for it", async () => {
    const { routines, requests } = engine({});
    const fields = fieldsOf(parseRoutine(job())!);
    expect(await routines.create({ ...fields, botId: "marlow" }, "k1")).toEqual({
      status: "not-sent",
      reason: "admin",
    });
    expect(await routines.update(JOB, fields, { ...fields, name: "New" })).toMatchObject({
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

  it("says why the gateway refused, and an answer that never came is unknown, not saved", async () => {
    const bad = engine(
      {
        "cron.add": () => {
          throw refused(
            "invalid cron.add params: CronPattern: invalid configuration format ('99 * * *')",
          );
        },
      },
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
  const original = fieldsOf(parseRoutine(once)!);

  it("writes only what changed: a new name leaves the saved time as it is", async () => {
    const { routines, requests } = engine(
      {
        "cron.get": () => once,
        "cron.update": (params) => ({ ...once, ...(params.patch as Record<string, unknown>) }),
      },
      ADMIN,
    );
    // The editor may hold the same instant written with an offset.
    const edit: RoutineFields = {
      ...original,
      name: "New year note",
      schedule: { ...original.schedule, at: "2035-01-01T09:00:00-05:00" },
    };
    expect(await routines.update(JOB, original, edit)).toMatchObject({
      status: "saved",
      routine: { name: "New year note", schedule: { at: "2035-01-01T14:00:00.000Z" } },
    });
    expect(requests.at(-1)).toEqual({
      method: "cron.update",
      params: { id: JOB, patch: { name: "New year note" } },
    });
  });

  it("writes nothing when another client changed it since the editor opened, and gives back the new version", async () => {
    const { routines, requests } = engine(
      { "cron.get": () => ({ ...once, payload: { kind: "agentTurn", message: "Theirs." } }) },
      ADMIN,
    );
    expect(await routines.update(JOB, original, { ...original, name: "Mine" })).toMatchObject({
      status: "conflict",
      current: { text: "Theirs." },
    });
    expect(requests.map((r) => r.method)).toEqual(["cron.get"]);
  });

  it("says when it was deleted elsewhere, and keeps the gateway's reason for a refusal", async () => {
    const gone = engine(
      {
        "cron.get": () => {
          throw refused(
            `Automation not found: ${JOB}. List automations and retry with a current job id.`,
          );
        },
      },
      ADMIN,
    );
    expect(await gone.routines.update(JOB, original, { ...original, name: "x" })).toEqual({
      status: "deleted",
    });
    const bad = engine(
      {
        "cron.get": () => once,
        "cron.update": () => {
          throw refused("invalid cron.update params: CronPattern: invalid configuration format");
        },
      },
      ADMIN,
    );
    expect(
      await bad.routines.update(JOB, original, {
        ...original,
        schedule: { kind: "cron", expr: "99 * * *", tz: null, everyMs: null, at: null, name: null },
      }),
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
      ADMIN,
    );
    const pending = routines.update(JOB, original, { ...original, name: "Late" });
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
      ADMIN,
    );
    expect(await routines.setEnabled(JOB, false)).toMatchObject({
      status: "saved",
      routine: { enabled: false, nextRunAt: null },
    });
    expect(requests[0]!.params).toEqual({ id: JOB, patch: { enabled: false } });
    const stale = engine({ "cron.update": () => job() }, ADMIN);
    expect(await stale.routines.setEnabled(JOB, false)).toMatchObject({ status: "unknown" });
  });

  it("F-351: run now forces a run, and says when one is already in progress or it was refused", async () => {
    const answers = [
      { ok: true, enqueued: true, runId: `manual:${JOB}:1:1` },
      { ok: true, ran: false, reason: "already-running" },
    ];
    const { routines, requests } = engine({ "cron.run": () => answers.shift() }, ADMIN);
    expect(await routines.runNow(JOB)).toEqual({ status: "started", runId: `manual:${JOB}:1:1` });
    expect(requests[0]!.params).toEqual({ id: JOB, mode: "force" });
    expect(await routines.runNow(JOB)).toEqual({ status: "already-running" });
    const bad = engine(
      {
        "cron.run": () => {
          throw refused("Automation not found: x.");
        },
      },
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
      ADMIN,
    );
    await routines.load();
    expect(await routines.remove(JOB)).toEqual({ status: "removed" });
    expect(state().routines).toEqual([]);
    const gone = engine(
      {
        "cron.remove": () => {
          throw refused(`Automation not found: ${JOB}.`);
        },
      },
      ADMIN,
    );
    expect(await gone.routines.remove(JOB)).toEqual({ status: "removed" });
  });

  it("F-349: reads the gateway's hooks from its config, with admin", async () => {
    const { routines } = engine(
      {
        "config.get": () => ({
          config: { hooks: { enabled: true, path: "/hooks", token: "__OPENCLAW_REDACTED__" } },
        }),
      },
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
