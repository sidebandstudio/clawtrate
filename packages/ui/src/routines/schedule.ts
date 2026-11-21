// A routine's schedule in words, its times in zones, and the calendar's
// occurrences (automation.md sections 4 and 5). The gateway gives only a
// routine's next run, so later occurrences are computed here from the
// schedule. A time the clock passes twice runs once, the first time, as the
// gateway's scheduler (OpenClaw 2026.10.6) does. What cannot be computed is
// drawn only at its next run.
//
// shortcut: a time the clocks skip is moved forward by the gap here, but the
// gateway skips it that day (as the editor's preview now does); fix with the
// gateway's rule in #224.

import type { Bot, Routine, RoutineRun, RoutineSchedule } from "@clawtrate/core";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "America/New_York" → "New York". */
export function zoneCity(tz: string): string {
  if (tz === "UTC" || tz === "Etc/UTC") return "UTC";
  return (tz.split("/").at(-1) ?? tz).replaceAll("_", " ");
}

/** Minutes since midnight on the wall clock in `tz`: where a time sits on a day's hour scale. */
export function wallMinutes(ms: number, tz: string): number {
  const parts = partsIn(ms, tz);
  return parts.hour * 60 + parts.minute;
}

/** The viewer's own zone. */
export function viewerZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

type Parts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
};

function partsIn(ms: number, tz: string): Parts {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    })
      .formatToParts(ms)
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(parts.weekday)),
  };
}

/** The instant a wall-clock time in `tz` names. */
export function zonedTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const offset = (at: number) => {
    const p = partsIn(at, tz);
    return (
      Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(at / MINUTE) * MINUTE
    );
  };
  const first = wall - offset(wall);
  const second = wall - offset(first);
  if (first === second) return second;
  // In a gap the offsets alternate. Croner uses the later instant.
  return wall - offset(second) === first ? Math.max(first, second) : second;
}

const clock = (ms: number, tz: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(ms);

/** "today 8:00 AM", "tomorrow 8:00 AM", "Fri 9:00 AM", "Nov 20 9:00 AM", "Jan 1, 2035 9:00 AM", in `tz`. */
export function when(ms: number, now: number, tz: string): string {
  const at = partsIn(ms, tz);
  const today = partsIn(now, tz);
  const days = Math.round(
    (Date.UTC(at.year, at.month - 1, at.day) - Date.UTC(today.year, today.month - 1, today.day)) /
      DAY,
  );
  const time = clock(ms, tz);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  if (days === -1) return `yesterday ${time}`;
  if (days > 1 && days < 7)
    return `${new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(ms)} ${time}`;
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    month: "short",
    day: "numeric",
    ...(at.year === today.year ? {} : { year: "numeric" }),
  }).format(ms);
  return `${date} ${time}`;
}

/** "Tomorrow, Thu Nov 19, 8:00 AM": the routine page's next run. */
export function fullWhen(ms: number, now: number, tz: string): string {
  const relative = when(ms, now, tz).split(" ")[0]!;
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(partsIn(ms, tz).year === partsIn(now, tz).year ? {} : { year: "numeric" }),
  })
    .format(ms)
    .replace(",", "");
  const time = clock(ms, tz);
  return relative === "today" || relative === "tomorrow" || relative === "yesterday"
    ? `${relative[0]!.toUpperCase()}${relative.slice(1)}, ${date}, ${time}`
    : `${date}, ${time}`;
}

/** A routine's zone for display: its own, or the gateway's for a cron schedule without one, or UTC for `at`. */
export function routineZone(schedule: RoutineSchedule): string | null {
  if (schedule.tz) return schedule.tz;
  return schedule.kind === "at" ? "UTC" : null;
}

type Field = { values: Set<number>; any: boolean };

/** One cron field: `*`, `n`, `a-b`, lists, and steps. Null for anything else (names, `L`, `#`, `?`). */
function field(text: string, min: number, max: number): Field | null {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/u.exec(part);
    if (!match) return null;
    const [, range, step] = match;
    const [from, to] =
      range === "*"
        ? [min, max]
        : range!.includes("-")
          ? range!.split("-").map(Number)
          : [Number(range), Number(range)];
    const by = step ? Number(step) : 1;
    if (from! < min || to! > max || from! > to! || by < 1) return null;
    for (let value = from!; value <= to!; value += by) values.add(value);
  }
  return { values, any: text === "*" };
}

export type Cron = { minute: Field; hour: Field; dom: Field; month: Field; dow: Field };

/** A five-field cron expression this client can read, or null. */
export function parseCron(expr: string): Cron | null {
  const fields = expr.trim().split(/\s+/u);
  if (fields.length !== 5) return null;
  const [minute, hour, dom, month, dowText] = fields as [string, string, string, string, string];
  const weekdays = dowText.replace(/sun|mon|tue|wed|thu|fri|sat/giu, (name) =>
    String(DAYS.findIndex((day) => day.slice(0, 3).toLowerCase() === name.toLowerCase())),
  );
  const dow = field(weekdays.replaceAll("?", "*"), 0, 7);
  const parsed = {
    minute: field(minute, 0, 59),
    hour: field(hour, 0, 23),
    dom: field(dom.replaceAll("?", "*"), 1, 31),
    month: field(month, 1, 12),
    dow,
  };
  if (!parsed.minute || !parsed.hour || !parsed.dom || !parsed.month || !dow) return null;
  // Croner expands ? to all days but counts the field as restricted for day matching.
  if (dom === "?") parsed.dom.any = false;
  if (dowText === "?") dow.any = false;
  if (dow.values.has(7)) dow.values.add(0);
  return parsed as Cron;
}

const timeOf = (hour: number, minute: number) => clock(Date.UTC(2000, 0, 1, hour, minute), "UTC");

const plural = (count: number, unit: string) => (count === 1 ? unit : `${count} ${unit}s`);

/** "every 30 minutes", "every 2 hours", "every day". */
function everyWords(everyMs: number): string {
  if (everyMs % DAY === 0) return `every ${plural(everyMs / DAY, "day")}`;
  if (everyMs % HOUR === 0) return `every ${plural(everyMs / HOUR, "hour")}`;
  if (everyMs % MINUTE === 0) return `every ${plural(everyMs / MINUTE, "minute")}`;
  return `every ${plural(Math.round(everyMs / 1000), "second")}`;
}

function cronDays(dow: Field): string | null {
  const days = [...dow.values].filter((day) => day !== 7).sort();
  const key = days.join(",");
  if (dow.any || key === "0,1,2,3,4,5,6") return "every day";
  if (key === "1,2,3,4,5") return "weekdays";
  if (key === "0,6") return "weekends";
  const names = days.map((day) => `${DAYS[day]}s`);
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * The schedule in words, without its zone: "Weekdays at 8:00 AM", "Every 30
 * minutes", "Once, Jan 1, 2035 at 9:00 AM". `written` is set when a cron
 * expression is shown as written instead.
 */
export function scheduleWords(schedule: RoutineSchedule): { text: string; written: boolean } {
  const capital = (text: string) => text[0]!.toUpperCase() + text.slice(1);
  switch (schedule.kind) {
    case "every":
      return { text: capital(everyWords(schedule.everyMs!)), written: false };
    case "at": {
      const tz = routineZone(schedule)!;
      const ms = Date.parse(schedule.at!);
      if (Number.isNaN(ms)) return { text: `Once, at ${schedule.at}`, written: true };
      const date = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(ms);
      return { text: `Once, ${date} at ${clock(ms, tz)}`, written: false };
    }
    case "cron": {
      const cron = parseCron(schedule.expr!);
      if (
        cron &&
        cron.minute.values.size === 1 &&
        cron.hour.values.size === 1 &&
        !cron.minute.any &&
        !cron.hour.any &&
        cron.dom.any &&
        cron.month.any
      ) {
        const days = cronDays(cron.dow);
        if (days)
          return {
            text: `${capital(days)} at ${timeOf([...cron.hour.values][0]!, [...cron.minute.values][0]!)}`,
            written: false,
          };
      }
      return { text: schedule.expr!, written: true };
    }
    default:
      return { text: `When the gateway decides (${schedule.name})`, written: true };
  }
}

/** The zone as a row says it: ", New York", ", gateway's time", "" for a repeating schedule. */
export function zoneWords(schedule: RoutineSchedule): string {
  if (schedule.kind === "every" || schedule.kind === "other") return "";
  const tz = routineZone(schedule);
  return tz ? zoneCity(tz) : "gateway's time";
}

/** Whether occurrences can be computed from the schedule, beyond the next run. */
export function computable(routine: Routine): boolean {
  if (routine.gated) return false;
  const { schedule } = routine;
  if (schedule.kind === "every" || schedule.kind === "at") return true;
  // A cron schedule with no zone runs in the gateway host's zone, which a client cannot read.
  return schedule.kind === "cron" && schedule.tz !== null && parseCron(schedule.expr!) !== null;
}

/**
 * What starts a routine, as far as the gateway says (automation.md section 6):
 * its schedule, a check or spacing set on it, or a trigger of another kind.
 */
export function triggerWords(routine: Routine): string {
  if (routine.schedule.kind === "other")
    return `The gateway's "${routine.schedule.name}" trigger, not a clock schedule.`;
  if (routine.gated) return "Its schedule, then a check or spacing set on it.";
  return "Its schedule only.";
}

/** Runs more than four times a day: drawn as one band per day, not as chips. */
export function frequent(routine: Routine): boolean {
  const { schedule } = routine;
  if (schedule.kind === "every") return schedule.everyMs! < 6 * HOUR;
  if (schedule.kind !== "cron") return false;
  const cron = parseCron(schedule.expr!);
  return cron !== null && cron.minute.values.size * cron.hour.values.size > 4;
}

/**
 * The scheduled times of a routine from `from` to `to`; empty for a paused one.
 * The gateway's next run is authoritative: nothing is drawn before it (a
 * top-of-the-hour run may be moved a few minutes later), and the times
 * computed after it follow the schedule.
 */
export function occurrences(routine: Routine, from: number, to: number): number[] {
  const next = routine.nextRunAt;
  if (!routine.enabled || next === null) return [];
  const own = next >= from && next < to ? [next] : [];
  if (!computable(routine) || routine.schedule.kind === "at") return own;
  return [...own, ...scheduled(routine.schedule, next, Math.max(from, next + 1), to)];
}

export function hasOccurrence(routine: Routine, from: number, to: number): boolean {
  const next = routine.nextRunAt;
  if (!routine.enabled || next === null || next >= to) return false;
  if (next >= from) return true;
  return (
    computable(routine) &&
    routine.schedule.kind !== "at" &&
    scheduled(routine.schedule, next, Math.max(from, next + 1), to, 1).length > 0
  );
}

function scheduled(
  schedule: RoutineSchedule,
  next: number,
  from: number,
  to: number,
  limit = 2_000,
): number[] {
  if (schedule.kind === "every") {
    const out: number[] = [];
    const step = schedule.everyMs!;
    let at = next + Math.ceil((from - next) / step) * step;
    while (at < to && out.length < limit) {
      out.push(at);
      at += step;
    }
    return out;
  }
  const cron = parseCron(schedule.expr!)!;
  const tz = schedule.tz!;
  const start = partsIn(from, tz);
  const times = new Set<number>();
  for (let offset = 0; offset * DAY <= to - from + DAY; offset += 1) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
    const [year, month, day, weekday] = [
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      date.getUTCDay(),
    ];
    if (!cron.month.values.has(month)) continue;
    // Cron's rule: with both day fields restricted, either may match.
    const domOk = cron.dom.values.has(day);
    const dowOk = cron.dow.values.has(weekday);
    if (cron.dom.any || cron.dow.any ? !(domOk && dowOk) : !(domOk || dowOk)) continue;
    for (const hour of [...cron.hour.values].sort((a, b) => a - b))
      for (const minute of [...cron.minute.values].sort((a, b) => a - b)) {
        let at = zonedTime(year, month, day, hour, minute, tz);
        const wall = partsIn(at, tz);
        // Passed twice (fall back): the gateway runs it once, the first time.
        // shortcut: assumes an hour's shift, as in every zone with daylight saving but Lord Howe's.
        const earlier = partsIn(at - HOUR, tz);
        if (earlier.hour === hour && earlier.minute === minute && earlier.day === wall.day)
          at -= HOUR;
        if (at >= from && at < to) {
          if (limit === 1) return [at];
          times.add(at);
        }
      }
  }
  // A skipped wall time can land on another occurrence after the gap.
  return [...times].sort((a, b) => a - b).slice(0, 2_000);
}

/**
 * Which run is which (automation.md section 7): its job's id and its `runId`,
 * or its job's id and its start while it runs or when it has no `runId`.
 */
export const runKey = (jobId: string, runId: string | null, runAt: number) =>
  runId === null ? `${jobId}:at:${runAt}` : `${jobId}:run:${runId}`;

/** "Succeeded · 2.6 s · 600 tokens", "Failed: …", and so on (automation.md section 6). */
export function runOutcome(run: RoutineRun): { text: string; mark: "failed" | "stopped" | null } {
  if (run.status === "error")
    return { text: `Failed: ${(run.error ?? "no reason given").split("\n")[0]}`, mark: "failed" };
  if (run.status === "skipped")
    return {
      text: run.error ? `Skipped: ${run.error.split("\n")[0]}` : "Skipped",
      mark: "stopped",
    };
  if (run.status === "ok" && run.completion === "failed")
    return {
      text: `Ran, but its result wasn't delivered${run.error ? `: ${run.error.split("\n")[0]}` : ""}`,
      mark: "failed",
    };
  if (run.status === "ok" && run.completion === "unknown")
    return { text: "Ran · whether it finished isn't known", mark: null };
  const parts = ["Succeeded"];
  if (run.durationMs !== null) parts.push(`${(run.durationMs / 1000).toFixed(1)} s`);
  if (run.totalTokens !== null) parts.push(`${run.totalTokens.toLocaleString("en-US")} tokens`);
  return { text: parts.join(" · "), mark: null };
}

/**
 * The routine's bot, or one named by its id when Clawtrate does not hold that
 * bot (it keeps at most `MAX_BOTS`): its routine is still listed and opened.
 */
export function ownerOf(bots: Bot[], botId: string): Bot {
  return (
    bots.find((each) => each.id === botId) ?? {
      id: botId,
      name: botId,
      emoji: null,
      avatarUrl: null,
      theme: null,
      model: null,
      isDefault: false,
    }
  );
}
