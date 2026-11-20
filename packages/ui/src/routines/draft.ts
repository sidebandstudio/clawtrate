// The editor's draft (automation.md section 9): what the form holds, how it
// becomes a schedule the gateway takes, the checks made before any request,
// and the preview. A draft opened on a routine keeps the routine's own fields
// (`original`), so a save writes only what the person changed.

import type { Routine, RoutineFields, RoutineSchedule } from "@clawtrate/core";
import { Cron } from "croner";
import {
  occurrences,
  parseCron,
  viewerZone,
  zonedTime,
  type Cron as ParsedCron,
} from "./schedule.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Clawtrate's floor (F-195); the gateway itself takes a one-second interval. */
export const MIN_GAP_MINUTES = 5;
export const MAX_NAME_CHARS = 80;

export type WhenKind = "daily" | "weekdays" | "days" | "every" | "once";

export type Draft = {
  botId: string;
  name: string;
  text: string;
  when: WhenKind;
  /** "08:00", for the daily kinds and Once. */
  time: string;
  /** Cron weekdays, 0 for Sunday. */
  days: number[];
  count: string;
  unit: "minutes" | "hours";
  /** "2026-11-20", for Once. */
  date: string;
  /** The zone the times are in; "auto" writes this device's zone as a fixed name. */
  tz: string;
  /** A cron expression from More: while filled, it replaces the choice list. */
  cron: string;
  target: Routine["target"];
  delivery: Routine["delivery"];
  /** A schedule the form does not write (section 9): kept exactly as it is. */
  locked: RoutineSchedule | null;
  /**
   * The routine's schedule and the fields it was read into: while those fields
   * stay as they were, the schedule is written back as the gateway gave it, so
   * a new name never moves a saved time.
   */
  from: { key: string; schedule: RoutineSchedule } | null;
};

const scheduleKey = (draft: Draft) =>
  JSON.stringify([
    draft.when,
    draft.time,
    draft.days,
    draft.count,
    draft.unit,
    draft.date,
    draft.tz,
    draft.cron,
  ]);

const pad = (value: number) => String(value).padStart(2, "0");

function wall(ms: number, tz: string): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(ms)
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

/** A daily kind the choice list writes: one time, every day of the month and year. */
function plain(cron: ParsedCron | null): cron is ParsedCron {
  return (
    cron !== null &&
    !cron.minute.any &&
    !cron.hour.any &&
    cron.minute.values.size === 1 &&
    cron.hour.values.size === 1 &&
    cron.dom.any &&
    cron.month.any
  );
}

const sorted = (days: Iterable<number>) =>
  [...new Set([...days].map((day) => day % 7))].sort((a, b) => a - b);

/** The zone most of a bot's routines use, for a new one (section 9). */
export function usualZone(routines: Routine[], botId: string): string | null {
  const counts = new Map<string, number>();
  for (const each of routines)
    if (each.botId === botId && each.schedule.tz)
      counts.set(each.schedule.tz, (counts.get(each.schedule.tz) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

export function newDraft(botId: string, routines: Routine[], now: number): Draft {
  return {
    botId,
    name: "",
    text: "",
    when: "weekdays",
    time: "08:00",
    days: [1],
    count: "30",
    unit: "minutes",
    date: wall(now + DAY, viewerZone()).date,
    tz: usualZone(routines, botId) ?? "auto",
    cron: "",
    target: "isolated",
    delivery: "none",
    locked: null,
    from: null,
  };
}

/** A routine's draft: its schedule in the choice list when the list can say it, else kept as written. */
export function draftOf(routine: Routine, now: number): Draft {
  const draft = readDraft(routine, now);
  return { ...draft, from: { key: scheduleKey(draft), schedule: routine.schedule } };
}

function readDraft(routine: Routine, now: number): Draft {
  const base: Draft = {
    ...newDraft(routine.botId, [], now),
    name: routine.name,
    text: routine.text,
    target: routine.target,
    delivery: routine.delivery,
    tz: routine.schedule.tz ?? "auto",
  };
  const { schedule } = routine;
  if (routine.gated) return { ...base, locked: schedule };
  if (schedule.kind === "every") {
    const hours = schedule.everyMs! % HOUR === 0;
    const minutes = schedule.everyMs! % MINUTE === 0;
    if (!minutes) return { ...base, locked: schedule };
    return {
      ...base,
      when: "every",
      count: String(schedule.everyMs! / (hours ? HOUR : MINUTE)),
      unit: hours ? "hours" : "minutes",
    };
  }
  if (schedule.kind === "at") {
    const ms = Date.parse(schedule.at!);
    if (Number.isNaN(ms)) return { ...base, locked: schedule };
    // The gateway keeps the instant only; it is shown in this device's zone.
    const tz = viewerZone();
    return { ...base, when: "once", tz: "auto", ...wall(ms, tz) };
  }
  if (schedule.kind === "cron" && schedule.tz) {
    const cron = parseCron(schedule.expr!);
    if (plain(cron)) {
      const days = sorted(cron.dow.values);
      const time = `${pad([...cron.hour.values][0]!)}:${pad([...cron.minute.values][0]!)}`;
      const when: WhenKind =
        cron.dow.any || days.length === 7
          ? "daily"
          : days.join() === "1,2,3,4,5"
            ? "weekdays"
            : "days";
      return { ...base, when, time, days: when === "days" ? days : base.days };
    }
  }
  return { ...base, locked: schedule };
}

export const zoneOf = (draft: Draft) => (draft.tz === "auto" ? viewerZone() : draft.tz);

const schedule = (over: Partial<RoutineSchedule>): RoutineSchedule => ({
  kind: "cron",
  expr: null,
  tz: null,
  everyMs: null,
  at: null,
  name: null,
  ...over,
});

/** An ISO time with this zone's offset at that moment: the gateway reads an `at` without one as UTC. */
export function isoAt(date: string, time: string, tz: string): string | null {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  if (![year, month, day, hour, minute].every((value) => Number.isInteger(value))) return null;
  const wallMs = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  const ms = zonedTime(year!, month!, day!, hour!, minute!, tz);
  const offset = Math.round((wallMs - ms) / MINUTE);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${date}T${time}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** The schedule the draft writes; the locked one as it was. */
export function scheduleOf(draft: Draft): RoutineSchedule {
  if (draft.locked) return draft.locked;
  if (draft.from && draft.from.key === scheduleKey(draft)) return draft.from.schedule;
  const tz = zoneOf(draft);
  if (draft.cron.trim()) return schedule({ expr: draft.cron.trim().split(/\s+/u).join(" "), tz });
  if (draft.when === "every") {
    const count = Number(draft.count);
    return schedule({
      kind: "every",
      everyMs: Math.round(count * (draft.unit === "hours" ? HOUR : MINUTE)),
    });
  }
  if (draft.when === "once") return schedule({ kind: "at", at: isoAt(draft.date, draft.time, tz) });
  const [hour, minute] = draft.time.split(":").map(Number);
  const days =
    draft.when === "daily" ? "*" : draft.when === "weekdays" ? "1-5" : sorted(draft.days).join(",");
  return schedule({ expr: `${minute ?? 0} ${hour ?? 0} * * ${days}`, tz });
}

export function fieldsOfDraft(draft: Draft): RoutineFields {
  return {
    name: draft.name.trim(),
    text: draft.text,
    schedule: scheduleOf(draft),
    target: draft.target,
    delivery: draft.delivery,
  };
}

const gaps = new Map<string, number | null | Error>();
/** F-195's window: 2,922 calendar days (eight years), today included whole. */
const WINDOW_DAYS = 2_922;

/**
 * The shortest time between two consecutive runs of a cron expression, in
 * minutes, on the schedule's nominal wall clock (automation.md section 9),
 * across F-195's window from today's date in `tz`. Read by croner 10.0.1 with
 * the gateway's own options (OpenClaw 2026.10.6 reads every cron schedule
 * so). Exact below the floor; above it, a gap the schedule really has. Null
 * when it runs at most once in the window. Throws the reader's error for an
 * expression the gateway would refuse, such as an out-of-range field.
 */
export function shortestGap(expr: string, tz: string, now: number): number | null {
  const today = Date.parse(`${wall(now, tz).date}T00:00:00Z`);
  const key = `${today} ${expr.trim()}`;
  let gap = gaps.get(key);
  if (gap === undefined) {
    try {
      const cron = new Cron(expr.trim(), { catch: false, paused: true, utcOffset: 0 });
      const end = today + WINDOW_DAYS * DAY;
      const next = (after: number) => {
        const at = cron.nextRun(new Date(after))?.getTime();
        return at !== undefined && at < end ? at : null;
      };
      const floor = MIN_GAP_MINUTES * MINUTE;
      let shortest = Infinity;
      const first = next(today - 1_000);
      if (first !== null) {
        // Every date that fires fires at the same times of day, so its first
        // date gives the spacing within a day, and every two consecutive dates
        // share one overnight spacing.
        const day = first - (first % DAY);
        let last = first;
        let after = next(first);
        for (; after !== null && after < day + DAY && shortest >= floor; after = next(after)) {
          shortest = Math.min(shortest, after - last);
          last = after;
        }
        if (after !== null && shortest >= floor) {
          shortest = Math.min(shortest, after - last);
          const overnight = first + DAY - last;
          for (let date = day, run: number | null = after; overnight < shortest && run !== null;) {
            const runDate = run - (run % DAY);
            if (runDate === date + DAY) shortest = overnight;
            date = runDate;
            run = next(date + last - day);
          }
        }
      }
      gap = shortest === Infinity ? null : shortest / MINUTE;
    } catch (error) {
      gap = error instanceof Error ? error : new Error(String(error));
    }
    if (gaps.size > 64) gaps.clear();
    gaps.set(key, gap);
  }
  if (gap instanceof Error) throw gap;
  return gap;
}

export type Problems = Partial<Record<"name" | "text" | "when" | "cron", string>>;

const FLOOR = "Routines run at least 5 minutes apart.";

/** What stops a save, before any request is made (section 9). */
export function problems(draft: Draft, now: number, textLocked = false): Problems {
  const out: Problems = {};
  if (!draft.name.trim()) out.name = "Give it a name.";
  else if (draft.name.trim().length > MAX_NAME_CHARS)
    out.name = `Keep the name to ${MAX_NAME_CHARS} characters.`;
  if (!textLocked && !draft.text.trim()) out.text = "Say what it should do.";
  if (draft.locked) return out;
  if (draft.cron.trim()) {
    try {
      if ((shortestGap(draft.cron, zoneOf(draft), now) ?? Infinity) < MIN_GAP_MINUTES)
        out.cron = FLOOR;
    } catch (error) {
      out.cron = `The gateway can't read this: ${(error as Error).message}`;
    }
    return out;
  }
  if (draft.when === "every") {
    const minutes = Number(draft.count) * (draft.unit === "hours" ? 60 : 1);
    if (
      !Number.isFinite(minutes) ||
      !Number.isInteger(Number(draft.count)) ||
      Number(draft.count) < 1
    )
      out.when = "Enter a whole number.";
    else if (minutes < MIN_GAP_MINUTES) out.when = FLOOR;
  }
  if (draft.when === "days" && draft.days.length === 0) out.when = "Choose at least one day.";
  if (draft.when === "once") {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(draft.date)) out.when = "Choose a date.";
    else if (!/^\d{2}:\d{2}$/u.test(draft.time)) out.when = "Choose a time.";
    else {
      const at = scheduleOf(draft).at;
      if (!at || Date.parse(at) <= now) out.when = "Pick a time in the future.";
    }
  } else if (draft.when !== "every" && !/^\d{2}:\d{2}$/u.test(draft.time))
    out.when = "Choose a time.";
  return out;
}

/** The next three runs of what the draft writes, for the preview. */
export function nextRuns(draft: Draft, now: number): number[] {
  const schedule = scheduleOf(draft);
  if (schedule.kind === "cron") {
    try {
      const cron = new Cron(schedule.expr!, {
        catch: false,
        paused: true,
        ...(schedule.tz ? { timezone: schedule.tz } : {}),
      });
      // The bulk iterator can revisit an instant during a daylight-saving gap.
      const runs = [];
      while (runs.length < 3) {
        const next = cron.nextRun(new Date(now))?.getTime();
        if (next === undefined || next <= now) break;
        runs.push(next);
        now = next;
      }
      return runs;
    } catch {
      return [];
    }
  }
  if (schedule.kind === "at") {
    const at = Date.parse(schedule.at ?? "");
    return at > now ? [at] : [];
  }
  const probe = {
    enabled: true,
    gated: false,
    schedule,
    nextRunAt: schedule.kind === "every" ? now + schedule.everyMs! : null,
  } as Routine;
  return occurrences(probe, now, now + 400 * DAY).slice(0, 3);
}
