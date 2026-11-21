import {
  initialConnectionState,
  initialState,
  type BridgeCommand,
  type ClawtrateState,
  type Routine,
  type RoutineFields,
  type RoutineRun,
} from "@clawtrate/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DIGEST,
  fixtureRoutines,
  releaseRoutineReads,
  routineCommands,
  type RoutineParams,
} from "../src/fixture/routines.ts";

const GATEWAY = "fixture-gateway";

/** One fixture bridge's routine host, with admin on a confirmed gateway. */
function host(params: Partial<RoutineParams> = {}) {
  const now = Date.now();
  const all: RoutineParams = { state: "ready", ...params };
  let state: ClawtrateState = {
    ...initialState,
    connection: { ...initialConnectionState, canAdmin: true, gatewayId: GATEWAY },
    routines: fixtureRoutines(now, all),
  };
  const commands = routineCommands(now, all);
  const send = <T>(command: BridgeCommand) =>
    commands(
      command,
      () => state,
      (next) => (state = next),
    ) as Promise<T>;
  const ask = async <T>(command: BridgeCommand): Promise<T> => {
    const answer = send<T>(command);
    await vi.runAllTimersAsync();
    return answer;
  };
  return { send, ask, routines: () => state.routines.routines };
}

const fields = (name: string): RoutineFields => ({
  name,
  text: "List the three articles worth reading first.",
  schedule: {
    kind: "cron",
    expr: "0 8 * * 5",
    tz: "America/New_York",
    everyMs: null,
    at: null,
    name: null,
  },
  target: "isolated",
  delivery: "none",
});

const editOf = (routine: Routine, change: Partial<RoutineFields>) => {
  const original: RoutineFields = {
    name: routine.name,
    text: routine.text,
    schedule: routine.schedule,
    target: routine.target,
    delivery: routine.delivery,
  };
  return {
    type: "updateRoutine",
    id: routine.id,
    original,
    edit: { ...original, ...change },
    expected: { ...original, updatedAt: routine.updatedAt },
    gateway: GATEWAY,
  } as BridgeCommand;
};

const conversationOf = (run: RoutineRun) =>
  ({
    type: "readRunConversation",
    id: run.jobId,
    runId: run.runId,
    runAt: run.runAt,
    sessionKey: run.sessionKey,
  }) as BridgeCommand;

describe("the fixture's routine host", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("finds a create in doubt only on the bridge it was sent to", async () => {
    vi.useFakeTimers();
    const sent = host({ save: "noanswer" });
    const other = host();
    const input = fields("In doubt");
    const create = { type: "createRoutine", input: { ...input, botId: "otto" }, key: "draft-0001" };
    expect(await sent.ask({ ...create, gateway: GATEWAY } as BridgeCommand)).toMatchObject({
      status: "unknown",
    });
    const check = { type: "checkRoutineCreate", key: "draft-0001", input, gateway: GATEWAY };
    expect(await other.ask(check as BridgeCommand)).toEqual({ status: "missing" });
    expect(other.routines().some((each) => each.name === "In doubt")).toBe(false);
    expect(await sent.ask(check as BridgeCommand)).toMatchObject({ status: "matches" });
  });

  it("a create in doubt found and then deleted stays deleted when checked again", async () => {
    vi.useFakeTimers();
    const { ask, routines } = host({ save: "noanswer" });
    const input = fields("In doubt");
    await ask({
      type: "createRoutine",
      input: { ...input, botId: "otto" },
      key: "draft-0001",
      gateway: GATEWAY,
    } as BridgeCommand);
    const check = { type: "checkRoutineCreate", key: "draft-0001", input, gateway: GATEWAY };
    const found = await ask<{ status: string; routine: Routine }>(check as BridgeCommand);
    expect(found.status).toBe("matches");
    await ask({ type: "removeRoutine", id: found.routine.id } as BridgeCommand);
    expect(await ask(check as BridgeCommand)).toEqual({ status: "missing" });
    expect(routines().some((each) => each.id === found.routine.id)).toBe(false);
  });

  it("an update answered after a delete reports the routine deleted and leaves it deleted", async () => {
    vi.useFakeTimers();
    const { send, routines } = host();
    const digest = routines().find((each) => each.id === DIGEST)!;
    const original: RoutineFields = {
      name: digest.name,
      text: digest.text,
      schedule: digest.schedule,
      target: digest.target,
      delivery: digest.delivery,
    };
    // The update goes first; the delete is answered before it.
    const update = send({
      type: "updateRoutine",
      id: DIGEST,
      original,
      edit: { ...original, name: "Morning digest, short" },
      expected: { ...original, updatedAt: digest.updatedAt },
      gateway: GATEWAY,
    } as BridgeCommand);
    const remove = send({ type: "removeRoutine", id: DIGEST } as BridgeCommand);
    await vi.runAllTimersAsync();
    expect(await remove).toEqual({ status: "removed" });
    expect(await update).toEqual({ status: "deleted" });
    expect(routines().some((each) => each.id === DIGEST)).toBe(false);
  });

  it("Run now records the run under the id it returned, and the runs before it keep theirs", async () => {
    vi.useFakeTimers();
    const { ask } = host();
    const runs = () => ask<RoutineRun[]>({ type: "readRoutineRuns", id: DIGEST } as BridgeCommand);
    const before = await runs();
    const started = await ask<{ status: string; runId: string }>({
      type: "runRoutineNow",
      id: DIGEST,
    } as BridgeCommand);
    expect(started.status).toBe("started");
    const after = await runs();
    expect(after[0]).toMatchObject({ runId: started.runId, manual: true });
    expect(after.slice(1)).toEqual(before);
  });

  it("Run now keeps a failed run before it as failed, and a later schedule edit rewrites no run", async () => {
    vi.useFakeTimers();
    const { ask, routines } = host();
    const BACKUP = "routine-backup";
    const runs = () => ask<RoutineRun[]>({ type: "readRoutineRuns", id: BACKUP } as BridgeCommand);
    const before = await runs();
    expect(before[0]).toMatchObject({ status: "error" });
    await ask({ type: "runRoutineNow", id: BACKUP } as BridgeCommand);
    const after = await runs();
    expect(after.slice(1)).toEqual(before);
    const backup = routines().find((each) => each.id === BACKUP)!;
    const original: RoutineFields = {
      name: backup.name,
      text: backup.text,
      schedule: backup.schedule,
      target: backup.target,
      delivery: backup.delivery,
    };
    expect(
      await ask({
        type: "updateRoutine",
        id: BACKUP,
        original,
        edit: { ...original, schedule: { ...original.schedule, expr: "0 5 * * 1" } },
        expected: { ...original, updatedAt: backup.updatedAt },
        gateway: GATEWAY,
      } as BridgeCommand),
    ).toMatchObject({ status: "saved" });
    expect(await runs()).toEqual(after);
  });

  it("a create sent again with the same draft key keeps one routine, as the gateway's upsert does", async () => {
    vi.useFakeTimers();
    const { ask, routines } = host();
    const create = (name: string) =>
      ask<{ status: string; routine: Routine }>({
        type: "createRoutine",
        input: { ...fields(name), botId: "otto" },
        key: "draft-0001",
        gateway: GATEWAY,
      } as BridgeCommand);
    const first = await create("Weekly reading list");
    const second = await create("Weekly reading list, short");
    expect(second.routine.id).toBe(first.routine.id);
    const kept = routines().filter((each) => each.id === first.routine.id);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.name).toBe("Weekly reading list, short");
  });

  it("creates whose draft keys start alike make two routines", async () => {
    vi.useFakeTimers();
    const { ask, routines } = host();
    const create = (key: string) =>
      ask<{ status: string; routine: Routine }>({
        type: "createRoutine",
        input: { ...fields(key), botId: "otto" },
        key,
        gateway: GATEWAY,
      } as BridgeCommand);
    const first = await create("draft-0001");
    const second = await create("draft-0002");
    expect(second.routine.id).not.toBe(first.routine.id);
    expect(routines().filter((each) => each.name.startsWith("draft-"))).toHaveLength(2);
  });

  it("an edit answered after a run ended keeps the run ended", async () => {
    vi.useFakeTimers();
    const { send, routines } = host();
    const digest = () => routines().find((each) => each.id === DIGEST)!;
    void send({ type: "runRoutineNow", id: DIGEST } as BridgeCommand);
    // The run starts at 300 ms and ends at 2.8 s; the edit goes out while it runs and lands after.
    await vi.advanceTimersByTimeAsync(2_600);
    expect(digest().runningAt).not.toBeNull();
    const update = send(editOf(digest(), { name: "Morning digest, short" }));
    await vi.runAllTimersAsync();
    expect(await update).toMatchObject({ status: "saved" });
    expect(digest()).toMatchObject({ name: "Morning digest, short", runningAt: null });
  });

  it("a pause answered after a delete reports the routine deleted", async () => {
    vi.useFakeTimers();
    const { send, routines } = host();
    const remove = send({ type: "removeRoutine", id: DIGEST } as BridgeCommand);
    const pause = send({ type: "setRoutineEnabled", id: DIGEST, enabled: false } as BridgeCommand);
    await vi.runAllTimersAsync();
    expect(await remove).toEqual({ status: "removed" });
    expect(await pause).toEqual({ status: "deleted" });
    expect(routines().some((each) => each.id === DIGEST)).toBe(false);
  });

  it("two runs started on a frozen clock get their own ids and session keys", async () => {
    vi.useFakeTimers();
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const { ask } = host();
    const runNow = () =>
      ask<{ runId: string }>({ type: "runRoutineNow", id: DIGEST } as BridgeCommand);
    const first = await runNow();
    const second = await runNow();
    expect(second.runId).not.toBe(first.runId);
    const [newest, previous] = await ask<RoutineRun[]>({
      type: "readRoutineRuns",
      id: DIGEST,
    } as BridgeCommand);
    expect([newest!.runId, previous!.runId]).toEqual([second.runId, first.runId]);
    expect(newest!.sessionKey).not.toBe(previous!.sessionKey);
  });

  it("Run now answered after a delete is refused", async () => {
    vi.useFakeTimers();
    const { send } = host();
    const remove = send({ type: "removeRoutine", id: DIGEST } as BridgeCommand);
    const started = send({ type: "runRoutineNow", id: DIGEST } as BridgeCommand);
    await vi.runAllTimersAsync();
    expect(await remove).toEqual({ status: "removed" });
    expect(await started).toMatchObject({ status: "refused" });
  });

  it("a run's conversation shows the instruction it ran with after the routine is edited", async () => {
    vi.useFakeTimers();
    const { ask, routines } = host();
    await ask({ type: "runRoutineNow", id: DIGEST } as BridgeCommand);
    const digest = routines().find((each) => each.id === DIGEST)!;
    await ask(editOf(digest, { text: "Only list what needs an answer today." }));
    const [ran] = await ask<RoutineRun[]>({ type: "readRoutineRuns", id: DIGEST } as BridgeCommand);
    expect(await ask(conversationOf(ran!))).toMatchObject({
      status: "kept",
      message: expect.stringMatching(/^Summarise the notes I added yesterday/u),
    });
  });

  it("the newest scheduled run's conversation stays readable after Run now", async () => {
    vi.useFakeTimers();
    const { ask } = host();
    const runs = () => ask<RoutineRun[]>({ type: "readRoutineRuns", id: DIGEST } as BridgeCommand);
    const [scheduled] = await runs();
    expect(await ask(conversationOf(scheduled!))).toMatchObject({ status: "kept" });
    await ask({ type: "runRoutineNow", id: DIGEST } as BridgeCommand);
    const [manual, before] = await runs();
    expect(before).toEqual(scheduled);
    expect(await ask(conversationOf(before!))).toMatchObject({ status: "kept" });
    expect(await ask(conversationOf(manual!))).toMatchObject({ status: "kept" });
  });

  it("a retry that saves after a create in doubt is what Check now finds", async () => {
    vi.useFakeTimers();
    const { ask, routines } = host({ save: "noanswer" });
    const create = (name: string) =>
      ask<{ status: string; routine: Routine }>({
        type: "createRoutine",
        input: { ...fields(name), botId: "otto" },
        key: "draft-0001",
        gateway: GATEWAY,
      } as BridgeCommand);
    expect(await create("First")).toMatchObject({ status: "unknown" });
    const saved = await create("Second");
    expect(saved.status).toBe("saved");
    const check = { type: "checkRoutineCreate", key: "draft-0001", gateway: GATEWAY };
    expect(await ask({ ...check, input: fields("Second") } as BridgeCommand)).toMatchObject({
      status: "matches",
    });
    expect(routines().find((each) => each.id === saved.routine.id)!.name).toBe("Second");
  });

  it("two Run now calls that overlap both stay in the history", async () => {
    vi.useFakeTimers();
    const { send, ask } = host();
    const runNow = () =>
      send<{ runId: string }>({ type: "runRoutineNow", id: DIGEST } as BridgeCommand);
    const first = runNow();
    await vi.advanceTimersByTimeAsync(310);
    const second = runNow();
    await vi.runAllTimersAsync();
    const runs = await ask<RoutineRun[]>({ type: "readRoutineRuns", id: DIGEST } as BridgeCommand);
    expect(runs.slice(0, 2).map((each) => each.runId)).toEqual([
      (await second).runId,
      (await first).runId,
    ]);
  });

  it("a schedule edit before the history is read leaves the runs before it as they ran", async () => {
    vi.useFakeTimers();
    const { ask, routines } = host();
    const BACKUP = "routine-backup";
    const backup = routines().find((each) => each.id === BACKUP)!;
    await ask(editOf(backup, { schedule: { ...backup.schedule, expr: "0 5 * * 1" } }));
    const [last, before] = await ask<RoutineRun[]>({
      type: "readRoutineRuns",
      id: BACKUP,
    } as BridgeCommand);
    // Daily, as it was scheduled when they ran, not weekly as it is now.
    expect(last!.runAt - before!.runAt).toBe(24 * 60 * 60_000);
  });

  it("a run of a removed routine never lands on one made again under its id", async () => {
    vi.useFakeTimers();
    const { send, ask, routines } = host();
    const create = {
      type: "createRoutine",
      input: { ...fields("Reading list"), botId: "otto" },
      key: "draft-0001",
      gateway: GATEWAY,
    } as BridgeCommand;
    const { routine } = await ask<{ routine: Routine }>(create);
    const started = send({ type: "runRoutineNow", id: routine.id } as BridgeCommand);
    await vi.advanceTimersByTimeAsync(300);
    expect(await started).toMatchObject({ status: "started" });
    // Removed and made again while the run is still going.
    void send({ type: "removeRoutine", id: routine.id } as BridgeCommand);
    await vi.advanceTimersByTimeAsync(300);
    void send(create);
    await vi.runAllTimersAsync();
    expect(routines().find((each) => each.id === routine.id)).toMatchObject({
      lastRunAt: null,
      runningAt: null,
    });
    expect(await ask({ type: "readRoutineRuns", id: routine.id } as BridgeCommand)).toEqual([]);
  });

  it("a history read held while its routine is removed and made again answers for the new one", async () => {
    vi.useFakeTimers();
    const key = "draft-held";
    const id = `routine-${key}`;
    const { ask, send } = host({ hold: id });
    const create = (name: string) =>
      ask({
        type: "createRoutine",
        input: { ...fields(name), botId: "otto" },
        key,
        gateway: GATEWAY,
      } as BridgeCommand);
    await create("First");
    await ask({ type: "runRoutineNow", id } as BridgeCommand);
    const read = send<RoutineRun[]>({ type: "readRoutineRuns", id } as BridgeCommand);
    await ask({ type: "removeRoutine", id } as BridgeCommand);
    await create("Second");
    releaseRoutineReads();
    await vi.runAllTimersAsync();
    expect(await read).toEqual([]);
  });

  it("a conversation read held while its routine is removed and made again seeds no history from the removed one", async () => {
    vi.useFakeTimers();
    const key = "draft-held";
    const id = `routine-${key}`;
    const { ask, send } = host({ hold: id });
    const create = (name: string) =>
      ask({
        type: "createRoutine",
        input: { ...fields(name), botId: "otto" },
        key,
        gateway: GATEWAY,
      } as BridgeCommand);
    await create("First");
    const started = await ask<{ runId: string }>({ type: "runRoutineNow", id } as BridgeCommand);
    const read = send({
      type: "readRunConversation",
      id,
      runId: started.runId,
      runAt: 0,
      sessionKey: "agent:otto:cron:held",
    } as BridgeCommand);
    await ask({ type: "removeRoutine", id } as BridgeCommand);
    await create("Second");
    releaseRoutineReads();
    await vi.runAllTimersAsync();
    await read;
    const after = send<RoutineRun[]>({ type: "readRoutineRuns", id } as BridgeCommand);
    releaseRoutineReads();
    await vi.runAllTimersAsync();
    expect(await after).toEqual([]);
  });

  it("a removed sample routine made again from its key starts with no runs", async () => {
    vi.useFakeTimers();
    const { ask } = host();
    await ask({ type: "removeRoutine", id: DIGEST } as BridgeCommand);
    expect(await ask({ type: "readRoutineRuns", id: DIGEST } as BridgeCommand)).toEqual([]);
    await ask({
      type: "createRoutine",
      input: { ...fields("Morning digest again"), botId: "marlow" },
      key: DIGEST.replace(/^routine-/u, ""),
      gateway: GATEWAY,
    } as BridgeCommand);
    expect(await ask({ type: "readRoutineRuns", id: DIGEST } as BridgeCommand)).toEqual([]);
  });

  it("a conversation asked for by its run's time, with no run id, is found", async () => {
    vi.useFakeTimers();
    const { ask } = host();
    const [newest] = await ask<RoutineRun[]>({
      type: "readRoutineRuns",
      id: DIGEST,
    } as BridgeCommand);
    const read = (runId: string | null) =>
      ask<{ status: string }>({
        type: "readRunConversation",
        id: DIGEST,
        runId,
        runAt: newest!.runAt,
        sessionKey: newest!.sessionKey,
      } as BridgeCommand);
    const byId = await read(newest!.runId);
    expect(byId.status).not.toBe("none");
    expect(await read(null)).toEqual(byId);
  });

  it("two edits out at once to different fields both stand, as the gateway's patches do", async () => {
    vi.useFakeTimers();
    const { send, routines } = host();
    const digest = routines().find((each) => each.id === DIGEST)!;
    const original: RoutineFields = {
      name: digest.name,
      text: digest.text,
      schedule: digest.schedule,
      target: digest.target,
      delivery: digest.delivery,
    };
    const update = (edit: RoutineFields) =>
      send({
        type: "updateRoutine",
        id: DIGEST,
        original,
        edit,
        expected: { ...original, updatedAt: digest.updatedAt },
        gateway: GATEWAY,
      } as BridgeCommand);
    const renamed = update({ ...original, name: "Morning digest, short" });
    const retexted = update({ ...original, text: "Summarise only what changed." });
    await vi.runAllTimersAsync();
    expect(await renamed).toMatchObject({ status: "saved" });
    expect(await retexted).toMatchObject({ status: "saved" });
    expect(routines().find((each) => each.id === DIGEST)).toMatchObject({
      name: "Morning digest, short",
      text: "Summarise only what changed.",
    });
  });
});
