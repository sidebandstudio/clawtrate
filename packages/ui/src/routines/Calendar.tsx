// The calendar (automation.md section 4, F-197): a column per day in the
// viewer's own time, the runs the gateway recorded on past days and the
// scheduled times from now on, which the gateway does not list and are
// computed from each schedule. A routine that runs more than four times a day
// is one band per day; its recorded runs still show as chips.

import type { Bot, Routine, RoutineRun } from "@clawtrate/core";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Avatar } from "../Avatar.tsx";
import { useBridge } from "../bridge.tsx";
import { BackIcon, ChevronIcon } from "../icons.tsx";
import { DAY, frequent, occurrences, scheduleWords, viewerZone, zoneCity } from "./schedule.ts";

const HOUR_PX = 28;

type Chip = {
  key: string;
  routine: Routine;
  at: number;
  past: boolean;
  failed: boolean;
  running: boolean;
  /** Drawn only at its next run: the rest is the gateway's to decide. */
  guessed: boolean;
};

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function addDays(ms: number, days: number): number {
  const date = new Date(ms);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

const dayName = (ms: number, now: number) =>
  startOfDay(ms) === startOfDay(now)
    ? "Today"
    : new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(ms);
const dateName = (ms: number) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(ms);
const timeName = (ms: number) =>
  new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(ms);

/** The runs the gateway recorded, for the calendar's past; read again as routines run. */
function useRecordedRuns(revision: string): RoutineRun[] {
  const bridge = useBridge();
  const [runs, setRuns] = useState<RoutineRun[]>([]);
  useEffect(() => {
    let live = true;
    bridge.invoke({ type: "readCalendarRuns" }).then(
      (read) => live && setRuns(read),
      () => live && setRuns([]),
    );
    return () => {
      live = false;
    };
  }, [bridge, revision]);
  return runs;
}

export function Calendar({
  routines,
  bots,
  days,
  now,
  onOpen,
}: {
  routines: Routine[];
  bots: Bot[];
  days: number;
  now: number;
  onOpen: (id: string) => void;
}) {
  const [start, setStart] = useState(() => startOfDay(now));
  const columns = Array.from({ length: days }, (_, index) => addDays(start, index));
  const end = addDays(start, days);
  const revision = routines.map((each) => `${each.id}:${each.lastRunAt}`).join(",");
  const recorded = useRecordedRuns(revision);
  const byId = useMemo(() => new Map(routines.map((each) => [each.id, each])), [routines]);
  const botOf = (routine: Routine) => bots.find((each) => each.id === routine.botId);

  const chips: Chip[] = [];
  for (const run of recorded) {
    const routine = byId.get(run.jobId);
    if (!routine || run.runAt < start || run.runAt >= end) continue;
    chips.push({
      key: `run:${run.runId ?? run.runAt}`,
      routine,
      at: run.runAt,
      past: true,
      failed: run.status === "error" || run.completion === "failed",
      running: false,
      guessed: false,
    });
  }
  for (const routine of routines) {
    if (routine.runningAt !== null && routine.runningAt >= start && routine.runningAt < end)
      chips.push({
        key: `running:${routine.id}`,
        routine,
        at: routine.runningAt,
        past: false,
        failed: false,
        running: true,
        guessed: false,
      });
    if (frequent(routine)) continue;
    const from = Math.max(start, now);
    const guessed = occurrences(routine, from, end);
    for (const at of guessed)
      chips.push({
        key: `next:${routine.id}:${at}`,
        routine,
        at,
        past: false,
        failed: false,
        running: false,
        guessed: guessed.length === 1 && routine.nextRunAt === at && routine.gated,
      });
  }
  chips.sort((a, b) => a.at - b.at || a.routine.name.localeCompare(b.routine.name));
  const bands = routines.filter((each) => each.enabled && frequent(each));

  const move = (by: number) => setStart((current) => addDays(current, by));
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    move(event.key === "ArrowLeft" ? -1 : 1);
  };
  const range =
    days === 1
      ? `${dayName(start, now)}, ${dateName(start)}`
      : `${dateName(start)} – ${dateName(addDays(end, -1))}`;

  return (
    <div className="r-calendar" data-testid="calendar" data-days={days}>
      <div className="r-cal-bar">
        <button
          type="button"
          className="icon-button"
          aria-label={days === 1 ? "Previous day" : `Previous ${days} days`}
          onClick={() => move(-days)}
        >
          <BackIcon />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={days === 1 ? "Next day" : `Next ${days} days`}
          onClick={() => move(days)}
        >
          <ChevronIcon />
        </button>
        <button
          type="button"
          className="button"
          data-variant="quiet"
          disabled={start === startOfDay(now)}
          onClick={() => setStart(startOfDay(now))}
        >
          Today
        </button>
        <span className="r-cal-range" aria-live="polite" data-testid="calendar-range">
          {range}
        </span>
        <span className="r-zone">Your time, {zoneCity(viewerZone())}</span>
      </div>
      <div
        className="r-cal-scroll"
        tabIndex={0}
        role="region"
        aria-label={`Routines, ${range}. Left and Right move a day.`}
        onKeyDown={onKey}
      >
        <div
          className="r-cal"
          style={{ ["--days" as string]: days, ["--hour" as string]: `${HOUR_PX}px` }}
        >
          <div className="r-cal-corner" aria-hidden="true" />
          {columns.map((day) => (
            <div
              key={`head:${day}`}
              className="r-cal-dayhead"
              data-today={day === startOfDay(now) || undefined}
              aria-hidden="true"
            >
              {dayName(day, now)}
              <small>{dateName(day)}</small>
            </div>
          ))}
          {bands.length > 0 && (
            <>
              <div className="r-cal-corner" aria-hidden="true" />
              {columns.map((day) => (
                <div key={`bands:${day}`} className="r-cal-bands">
                  {bands.map((routine) => (
                    <button
                      key={routine.id}
                      type="button"
                      className="r-cal-band"
                      title={`${scheduleWords(routine.schedule).text} · ${routine.name}`}
                      onClick={() => onOpen(routine.id)}
                    >
                      {scheduleWords(routine.schedule).text} · {routine.name}
                    </button>
                  ))}
                </div>
              ))}
            </>
          )}
          <div className="r-cal-hours" aria-hidden="true">
            {Array.from({ length: 12 }, (_, index) => index * 2)
              .slice(1)
              .map((hour) => (
                <span key={hour} style={{ top: hour * HOUR_PX }}>
                  {timeName(new Date(2000, 0, 1, hour).getTime()).replace(":00", "")}
                </span>
              ))}
          </div>
          {columns.map((day) => {
            const mine = chips.filter((chip) => chip.at >= day && chip.at < addDays(day, 1));
            const label = new Intl.DateTimeFormat("en-US", {
              weekday: "long",
              month: "short",
              day: "numeric",
            }).format(day);
            return (
              <ul
                key={`day:${day}`}
                className="r-cal-day"
                aria-label={label}
                data-testid="calendar-day"
              >
                {startOfDay(now) === day && (
                  <li
                    className="r-now"
                    aria-hidden="true"
                    style={{ top: ((now - day) / DAY) * 24 * HOUR_PX }}
                  />
                )}
                {mine.map((chip, index) => {
                  const bot = botOf(chip.routine);
                  // Chips at the same time stack below one another.
                  const before = mine
                    .slice(0, index)
                    .filter((other) => Math.abs(other.at - chip.at) < 45 * 60_000).length;
                  const outcome = chip.running
                    ? ", running"
                    : chip.past
                      ? chip.failed
                        ? ", failed"
                        : ", ran"
                      : "";
                  return (
                    <li
                      key={chip.key}
                      className="r-occ-slot"
                      style={{ top: ((chip.at - day) / DAY) * 24 * HOUR_PX + before * 24 }}
                    >
                      <button
                        type="button"
                        className="r-occ"
                        data-testid="occurrence"
                        data-past={chip.past || undefined}
                        data-outcome={chip.failed ? "failed" : undefined}
                        aria-label={`${chip.routine.name}, ${bot?.name ?? chip.routine.botId}, ${label} ${timeName(chip.at)}${outcome}`}
                        title={`${timeName(chip.at)}${chip.guessed ? ", and later, as the gateway decides" : ""}`}
                        onClick={() => onOpen(chip.routine.id)}
                      >
                        {chip.running && (
                          <span className="glyph" data-state="working" aria-hidden="true" />
                        )}
                        {bot && <Avatar bot={bot} />}
                        <span>{chip.routine.name}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            );
          })}
        </div>
      </div>
    </div>
  );
}
