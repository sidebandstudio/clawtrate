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

describe("the fixture's routine host", () => {
  afterEach(() => {
    vi.useRealTimers();
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
});
