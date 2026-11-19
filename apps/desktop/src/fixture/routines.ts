// The fixture's routines (docs/design/automation.md): scheduled jobs across
// the sample bots, their runs, and a run's conversation, answered as the
// engine answers the routine commands. Every name, instruction and result is
// made up. Times are from the fixture's clock; next runs follow each schedule.
//
// Address parameters (without one, the gateway has no routines, as every
// other scene's baseline was taken):
//   routines=on|empty|error|loading|running|scheduler-off|many
//     no routines, a failed read, still loading, Morning digest running now,
//     the gateway's scheduler off, or Morning digest with 27 recorded runs
// With `access=admin` (accounts.ts) the routines can be changed, and:
//   save=refused|noanswer|conflict   how the next save ends; `noanswer` then
//                                    finds it saved on "Check now"
//   pause=fail, run=already|fail, delete=fail   how those end
//   hooks=on                         the gateway's inbound hooks are on

import { zonedTime } from "@clawtrate/ui";
import type {
  BridgeCommand,
  ClawtrateState,
  NewRoutine,
  Routine,
  RoutineFields,
  RoutineRun,
  RoutineSchedule,
  RoutinesState,
  RunConversation,
} from "@clawtrate/core";

export type RoutineParams = {
  state: "none" | "ready" | "empty" | "error" | "loading" | "running" | "scheduler-off" | "many";
  save?: "refused" | "noanswer" | "conflict" | null;
  pause?: "fail" | null;
  run?: "already" | "fail" | null;
  remove?: "fail" | null;
  hooks?: boolean;
};

const oneOf = <T extends string>(value: string | null, options: readonly T[]): T | null =>
  options.includes(value as T) ? (value as T) : null;

export function routineParams(params: URLSearchParams): RoutineParams {
  const state = params.get("routines");
  return {
    state:
      state === "empty" ||
      state === "error" ||
      state === "loading" ||
      state === "running" ||
      state === "scheduler-off" ||
      state === "many"
        ? state
        : state === "on"
          ? "ready"
          : "none",
    save: oneOf(params.get("save"), ["refused", "noanswer", "conflict"] as const),
    pause: oneOf(params.get("pause"), ["fail"] as const),
    run: oneOf(params.get("run"), ["already", "fail"] as const),
    remove: oneOf(params.get("delete"), ["fail"] as const),
    hooks: params.get("hooks") === "on",
  };
}

const NY = "America/New_York";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const schedule = (over: Partial<RoutineSchedule>): RoutineSchedule => ({
  kind: "cron",
  expr: null,
  tz: null,
  everyMs: null,
  at: null,
  name: null,
  ...over,
});

const base = (over: Partial<Routine> & Pick<Routine, "id" | "botId" | "name">): Routine => ({
  enabled: true,
  schedule: schedule({}),
  payload: "agentTurn",
  text: "",
  textCut: false,
  target: "isolated",
  delivery: "none",
  deliveryChannel: null,
  nextRunAt: null,
  lastRunAt: null,
  lastStatus: null,
  lastError: null,
  runningAt: null,
  deleteAfterRun: false,
  gated: false,
  updatedAt: null,
  ...over,
});

/** The wall-clock day of `now` in `tz`, `days` later, at `hour:minute` there. */
function at(now: number, tz: string, days: number, hour: number, minute = 0): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  })
    .formatToParts(now + days * DAY)
    .map((part) => Number(part.value) || 0)
    .filter((value) => value > 0);
  const [month, day, year] = parts as [number, number, number];
  return zonedTime(year, month, day, hour, minute, tz);
}

/** The first day after `now`, within five weeks, whose `hour:minute` in `tz` passes `keep`. */
function nextDay(
  now: number,
  tz: string,
  hour: number,
  keep: (weekday: string, day: number) => boolean,
): number {
  for (let days = 0; days < 36; days += 1) {
    const time = at(now, tz, days, hour);
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(
      time,
    );
    const day = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: tz, day: "numeric" }).format(time),
    );
    if (time > now && keep(weekday, day)) return time;
  }
  return now + DAY;
}

/** The next weekday at 8:00 AM in New York after `now`. */
function nextWeekday8(now: number): number {
  for (let days = 0; days < 8; days += 1) {
    const time = at(now, NY, days, 8);
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: NY, weekday: "short" }).format(
      time,
    );
    if (time > now && weekday !== "Sat" && weekday !== "Sun") return time;
  }
  return now + DAY;
}

function nextAt(now: number, tz: string, hour: number, minute = 0): number {
  const today = at(now, tz, 0, hour, minute);
  return today > now ? today : at(now, tz, 1, hour, minute);
}

export const DIGEST = "routine-digest";

export function fixtureRoutineList(now: number, params: RoutineParams): Routine[] {
  const lastDigest = at(now, NY, now > at(now, NY, 0, 8) ? 0 : -1, 8);
  return [
    base({
      id: DIGEST,
      botId: "marlow",
      name: "Morning digest",
      schedule: schedule({ expr: "0 8 * * 1-5", tz: NY }),
      text: "Summarise the notes I added yesterday, and list anything I need to answer today.",
      nextRunAt: nextWeekday8(now),
      lastRunAt: lastDigest,
      lastStatus: "ok",
      runningAt: params.state === "running" ? now - 2 * MINUTE : null,
    }),
    base({
      id: "routine-draft",
      botId: "marlow",
      name: "Send the draft to Sam",
      schedule: schedule({ kind: "at", at: new Date(at(now, NY, 2, 9)).toISOString(), tz: NY }),
      text: "Send Sam the final draft of the newsletter intro.",
      nextRunAt: at(now, NY, 2, 9),
      deleteAfterRun: true,
    }),
    base({
      id: "routine-disk",
      botId: "otto",
      name: "Disk space watch",
      schedule: schedule({ kind: "every", everyMs: 30 * MINUTE }),
      text: "Check free space on the media box and say so only if it is under 10%.",
      nextRunAt: now + 12 * MINUTE,
      lastRunAt: now - 18 * MINUTE,
      lastStatus: "skipped",
    }),
    base({
      id: "routine-backup",
      botId: "otto",
      name: "Nightly backup check",
      schedule: schedule({ expr: "30 3 * * *", tz: NY }),
      text: "Check last night's backup finished and that its size is in line with the week before.",
      nextRunAt: nextAt(now, NY, 3, 30),
      lastRunAt: at(now, NY, 0, 3, 30) < now ? at(now, NY, 0, 3, 30) : at(now, NY, -1, 3, 30),
      lastStatus: "error",
      lastError: "The model didn't answer within 120 seconds.",
    }),
    base({
      id: "routine-cert",
      botId: "otto",
      name: "Certificate renewal",
      schedule: schedule({ expr: "0 9 1 * *", tz: "Europe/Berlin" }),
      text: "Renew the home server's certificate if it expires within 30 days.",
      nextRunAt: nextDay(now, "Europe/Berlin", 9, (_, day) => day === 1),
      lastRunAt: now - 18 * DAY,
      lastStatus: "ok",
    }),
    base({
      id: "routine-week",
      botId: "pip",
      name: "Plan the week",
      schedule: schedule({ expr: "0 17 * * 0", tz: "Europe/London" }),
      text: "Plan next week's dinners from what is in the fridge and the calendar.",
      nextRunAt: nextDay(now, "Europe/London", 17, (weekday) => weekday === "Sun"),
      lastRunAt: now - 3 * DAY,
      lastStatus: "ok",
    }),
    base({
      id: "routine-inbox",
      botId: "pip",
      name: "Inbox tidy-up",
      enabled: false,
      schedule: schedule({ expr: "0 16 * * 5", tz: NY }),
      text: "Archive newsletters older than a week.",
      lastRunAt: now - 6 * DAY,
      lastStatus: "ok",
    }),
    base({
      id: "routine-stretch",
      botId: "main",
      name: "Stretch break",
      schedule: schedule({ kind: "every", everyMs: 2 * HOUR }),
      payload: "systemEvent",
      target: "main",
      text: "Time to stand up and stretch.",
      delivery: "announce",
      nextRunAt: now + 40 * MINUTE,
      lastRunAt: now - 80 * MINUTE,
      lastStatus: "ok",
    }),
  ];
}

export function fixtureRoutines(now: number, params: RoutineParams): RoutinesState {
  if (params.state === "loading")
    return { status: "loading", error: null, schedulerOn: null, routines: [], omitted: 0 };
  if (params.state === "error")
    return {
      status: "error",
      error: "missing scope: operator.read",
      schedulerOn: null,
      routines: [],
      omitted: 0,
    };
  return {
    status: "loaded",
    error: null,
    schedulerOn: params.state !== "scheduler-off",
    routines:
      params.state === "empty" || params.state === "none" ? [] : fixtureRoutineList(now, params),
    omitted: 0,
  };
}

/** Routines a create in doubt made, by draft key: "Check now" finds them. */
const drafts = new Map<string, Routine>();

const run = (routine: Routine, runAt: number, over: Partial<RoutineRun> = {}): RoutineRun => ({
  jobId: routine.id,
  runId: `run-${routine.id}-${runAt}`,
  runAt,
  status: "ok",
  completion: "succeeded",
  error: null,
  summary: "Three notes from yesterday. The draft for Sam is ready to send.",
  durationMs: 2_600,
  model: "dev-1",
  provider: "scripted",
  inputTokens: 120,
  outputTokens: 80,
  totalTokens: 200,
  sessionKey: `agent:${routine.botId}:cron:${routine.id}:run:${runAt}`,
  manual: false,
  ...over,
});

/** Every run the fixture's gateway recorded for a routine, newest first; more than 20 with `routines=many`. */
export function fixtureRuns(routine: Routine, now: number, params: RoutineParams): RoutineRun[] {
  if (routine.lastRunAt === null) return [];
  if (routine.target === "main")
    return [
      run(routine, routine.lastRunAt, {
        summary: routine.text,
        sessionKey: null,
        model: null,
        provider: null,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        durationMs: 1_090,
      }),
    ];
  const count = params.state === "many" ? 27 : routine.id === DIGEST ? 6 : 3;
  // A cron schedule naming one weekday runs weekly; the others here run daily.
  const step =
    routine.schedule.kind === "every"
      ? routine.schedule.everyMs!
      : /\s\d$/u.test(routine.schedule.expr ?? "")
        ? 7 * DAY
        : DAY;
  return Array.from({ length: count }, (_, index) => {
    const runAt = routine.lastRunAt! - index * step;
    if (routine.id === DIGEST && index === 1)
      return run(routine, runAt - 3 * HOUR - 20 * MINUTE, {
        manual: true,
        runId: `manual:${routine.id}:${runAt}:1`,
        durationMs: 3_100,
        totalTokens: 214,
      });
    if (routine.id === DIGEST && index === 2)
      return run(routine, runAt, {
        status: "error",
        completion: "failed",
        error: "Channel is required (no configured channels detected).",
      });
    if (routine.id === DIGEST && index === 3)
      return run(routine, runAt, { status: "skipped", summary: null, totalTokens: null });
    if (routine.lastStatus === "error" && index === 0)
      return run(routine, runAt, {
        status: "error",
        completion: "failed",
        error: routine.lastError,
        summary: null,
      });
    if (routine.lastStatus === "skipped" && index === 0)
      return run(routine, runAt, { status: "skipped", summary: null, totalTokens: null });
    return run(routine, runAt);
  });
}

/** The newest run's conversation is kept; older ones are past the gateway's retention. */
function conversation(routine: Routine, runs: RoutineRun[], runId: string): RunConversation {
  if (runs[0]?.runId !== runId)
    return {
      status: "none",
      reason: "not-kept",
      error: "The recorded cron transcript is unavailable. Refresh the run and try again.",
    };
  return {
    status: "kept",
    message: routine.text,
    added:
      "Current time: Wednesday, November 18th, 2026 - 8:00 AM (America/New_York)\n\nThis is an unattended scheduled run. Nobody is present to clarify or approve, so complete the task with what you have.",
    items: [
      {
        id: "convo-1",
        role: "assistant",
        timestamp: runs[0]!.runAt + 900,
        model: "dev-1",
        blocks: [
          { kind: "reasoning", text: "First I should read yesterday's notes." },
          {
            kind: "tool-call",
            callId: "call-1",
            name: "read",
            argumentsText: '{\n  "path": "notes/yesterday.md"\n}',
            result: { isError: false, text: "Three notes." },
          },
        ],
      },
      {
        id: "convo-2",
        role: "assistant",
        timestamp: runs[0]!.runAt + 2_400,
        model: "dev-1",
        blocks: [
          {
            kind: "text",
            text: "Three notes from yesterday. The draft for Sam is ready to send. Two emails need an answer today: the venue's question about numbers and the printer's quote.",
          },
        ],
      },
    ],
    omitted: 0,
  };
}

const applied = (routine: Routine, fields: RoutineFields): Routine => ({
  ...routine,
  ...fields,
  updatedAt: Date.now(),
});

/** Answers to the routine commands, or undefined for any other command. */
export function routineCommand(
  command: BridgeCommand,
  get: () => ClawtrateState,
  now: number,
  params: RoutineParams,
  set: (state: ClawtrateState) => void,
): Promise<unknown> | undefined {
  const find = (id: string) => get().routines.routines.find((each) => each.id === id);
  const put = (change: (routines: Routine[]) => Routine[]) =>
    set({ ...get(), routines: { ...get().routines, routines: change(get().routines.routines) } });
  const replace = (next: Routine) =>
    put((all) =>
      all.some((each) => each.id === next.id)
        ? all.map((each) => (each.id === next.id ? next : each))
        : [...all, next],
    );
  const admin = () => get().connection.canAdmin;
  const later = <T>(ms: number, value: () => T) =>
    new Promise<T>((resolve) => setTimeout(() => resolve(value()), ms));
  // How the next save ends; a refusal or a conflict once, then saves work.
  const outcome = () => {
    const once = params.save ?? null;
    params.save = null;
    return once;
  };
  switch (command.type) {
    case "createRoutine": {
      if (!admin()) return Promise.resolve({ status: "not-sent", reason: "admin" });
      const input: NewRoutine = command.input;
      const made = base({
        ...input,
        id: `routine-${command.key.slice(0, 8)}`,
        nextRunAt: now + DAY,
      });
      const end = outcome();
      if (end === "refused")
        return later(400, () => ({
          status: "refused",
          error:
            "invalid cron.add params: CronPattern: invalid configuration format ('99 * * *'), exactly five, six, or seven space separated parts are required.",
        }));
      if (end === "noanswer") {
        drafts.set(command.key, made);
        return later(400, () => ({ status: "unknown", error: "gateway request timed out" }));
      }
      return later(400, () => {
        replace(made);
        return { status: "saved", routine: made };
      });
    }
    case "findCreatedRoutine": {
      const made = drafts.get(command.key) ?? null;
      if (made) replace(made);
      return later(300, () => made);
    }
    case "readRoutine":
      return later(300, () => find(command.id) ?? null);
    case "updateRoutine": {
      if (!admin()) return Promise.resolve({ status: "not-sent", reason: "admin" });
      const routine = find(command.id);
      if (!routine) return Promise.resolve({ status: "deleted" });
      const end = outcome();
      if (end === "conflict") {
        const theirs = {
          ...routine,
          text: `${routine.text} Keep it to three lines.`,
          updatedAt: Date.now(),
        };
        replace(theirs);
        return later(300, () => ({ status: "conflict", current: theirs }));
      }
      if (end === "refused")
        return later(400, () => ({
          status: "refused",
          error:
            "invalid cron.update params: CronDate: Failed to convert date to timezone 'Mars/Base'. Please provide a valid IANA timezone.",
        }));
      if (end === "noanswer") {
        replace(applied(routine, command.edit));
        return later(400, () => ({ status: "unknown", error: "gateway request timed out" }));
      }
      const next = applied(routine, command.edit);
      return later(400, () => {
        replace(next);
        return { status: "saved", routine: next };
      });
    }
    case "setRoutineEnabled": {
      const routine = find(command.id);
      if (!admin() || !routine) return Promise.resolve({ status: "not-sent", reason: "admin" });
      if (params.pause === "fail")
        return later(500, () => ({ status: "refused", error: "missing scope: operator.admin" }));
      const next = {
        ...routine,
        enabled: command.enabled,
        nextRunAt: command.enabled ? now + DAY : null,
      };
      return later(300, () => {
        replace(next);
        return { status: "saved", routine: next };
      });
    }
    case "runRoutineNow": {
      const routine = find(command.id);
      if (!admin() || !routine) return Promise.resolve({ status: "not-sent", reason: "admin" });
      if (params.run === "already") return later(300, () => ({ status: "already-running" }));
      if (params.run === "fail")
        return later(300, () => ({
          status: "refused",
          error: `Automation not found: ${routine.id}. List automations and retry with a current job id.`,
        }));
      return later(300, () => {
        replace({ ...routine, runningAt: Date.now() });
        setTimeout(() => {
          const ran = find(routine.id);
          if (ran) replace({ ...ran, runningAt: null, lastRunAt: Date.now(), lastStatus: "ok" });
        }, 2500);
        return { status: "started", runId: `manual:${routine.id}:${Date.now()}:1` };
      });
    }
    case "removeRoutine": {
      if (!admin()) return Promise.resolve({ status: "not-sent", reason: "admin" });
      if (params.remove === "fail")
        return later(400, () => ({ status: "refused", error: "missing scope: operator.admin" }));
      return later(300, () => {
        put((all) => all.filter((each) => each.id !== command.id));
        return { status: "removed" };
      });
    }
    case "readGatewayHooks":
      return Promise.resolve(admin() ? { enabled: params.hooks === true, path: "/hooks" } : null);
    case "refreshRoutines":
      return Promise.resolve();
    case "readRoutineRuns": {
      const routine = find(command.id);
      return Promise.resolve(routine ? fixtureRuns(routine, now, params).slice(0, 20) : []);
    }
    case "readCalendarRuns":
      return Promise.resolve(
        get()
          .routines.routines.flatMap((routine) => fixtureRuns(routine, now, params))
          .sort((a, b) => b.runAt - a.runAt)
          .slice(0, 200),
      );
    case "readRunConversation": {
      const routine = find(command.id);
      if (!routine) return Promise.reject(new Error("unknown routine"));
      if (!command.sessionKey)
        return Promise.resolve({ status: "none", reason: "no-session", error: null });
      return Promise.resolve(
        conversation(routine, fixtureRuns(routine, now, params), command.runId),
      );
    }
    default:
      return undefined;
  }
}
