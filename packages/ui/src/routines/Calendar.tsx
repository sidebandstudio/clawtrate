// The calendar (automation.md section 4, F-197): a column per day in the
// viewer's own time, the runs the gateway recorded on those days and the
// scheduled times from the gateway's next run on, which the gateway does not
// list and are computed from each schedule. A routine that runs more than four
// times a day is one band on each coming day it runs; its recorded runs still
// show as chips.

import type { Bot, Routine } from "@clawtrate/core";
import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Avatar } from "../Avatar.tsx";
import { useBridge } from "../bridge.tsx";
import { Note } from "../bots/parts.tsx";
import { BackIcon, ChevronIcon } from "../icons.tsx";
import { useKeyedRead } from "./read.ts";
import {
  frequent,
  occurrences,
  ownerOf,
  runKey,
  scheduleWords,
  viewerZone,
  wallMinutes,
  zoneCity,
} from "./schedule.ts";

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
/** "Thu Nov 19": a day's list and every chip and band in it are named by it. */
const dayLabel = (ms: number) =>
  new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" })
    .format(ms)
    .replace(",", "");
const timeName = (ms: number) =>
  new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(ms);

/** A top-of-the-hour cron schedule may start up to 5 minutes late, which the gateway does on purpose. */
const mayStagger = (routine: Routine) =>
  routine.schedule.kind === "cron" && /^0\s/u.test(routine.schedule.expr ?? "");

export function Calendar({
  gateway,
  routines,
  bots,
  days,
  now,
  onOpen,
}: {
  /** The gateway the routines are from: a read for another is never shown. */
  gateway: string;
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
  const bridge = useBridge();
  // Read again for other dates, another gateway's routines, or as routines run.
  const [recorded, retry] = useKeyedRead(`${gateway}:${start}:${end}:${revision}`, () =>
    bridge.invoke({ type: "readCalendarRuns", from: start, to: end }),
  );
  const byId = useMemo(() => new Map(routines.map((each) => [each.id, each])), [routines]);
  const viewer = viewerZone();
  const gridRef = useRef<HTMLDivElement>(null);

  const chips: Chip[] = [];
  for (const run of recorded.status === "ready" ? recorded.value.runs : []) {
    const routine = byId.get(run.jobId);
    if (!routine) continue;
    chips.push({
      key: runKey(run.jobId, run.runId, run.runAt),
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
        key: runKey(routine.id, null, routine.runningAt),
        routine,
        at: routine.runningAt,
        past: false,
        failed: false,
        running: true,
        guessed: false,
      });
    if (frequent(routine)) continue;
    const ahead = occurrences(routine, Math.max(start, now), end);
    for (const at of ahead)
      chips.push({
        key: `next:${routine.id}:${at}`,
        routine,
        at,
        past: false,
        failed: false,
        running: false,
        guessed: ahead.length === 1 && routine.nextRunAt === at && routine.gated,
      });
  }
  chips.sort((a, b) => a.at - b.at || a.routine.name.localeCompare(b.routine.name));
  // A band only on a day it still runs: from now on, and on the gateway's next run for what is not computed.
  const bands = columns.map((day) =>
    routines.filter(
      (each) =>
        frequent(each) &&
        addDays(day, 1) > now &&
        occurrences(each, Math.max(day, now), addDays(day, 1)).length > 0,
    ),
  );
  const headId = useId();

  const move = (by: number) => setStart((current) => addDays(current, by));
  // Left and Right: the chip closest in time on the nearest earlier or later day that has one.
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const chip = (event.target as HTMLElement).closest<HTMLElement>("[data-minute]");
    const lists = [...(gridRef.current?.querySelectorAll<HTMLElement>(".r-cal-day") ?? [])];
    const day = chip ? lists.findIndex((list) => list.contains(chip)) : -1;
    if (!chip || day < 0) return;
    event.preventDefault();
    const minute = Number(chip.dataset.minute);
    const step = event.key === "ArrowLeft" ? -1 : 1;
    for (let other = day + step; other >= 0 && other < lists.length; other += step) {
      const candidates = [...lists[other]!.querySelectorAll<HTMLElement>("[data-minute]")];
      if (candidates.length === 0) continue;
      const closest = candidates.reduce((best, each) =>
        Math.abs(Number(each.dataset.minute) - minute) <
        Math.abs(Number(best.dataset.minute) - minute)
          ? each
          : best,
      );
      closest.focus();
      return;
    }
  };
  const range =
    days === 1
      ? `${dayName(start, now)} ${dateName(start)}`
      : `${dayName(start, now)} ${dateName(start)} to ${dayLabel(addDays(end, -1))}`;
  const top = (at: number) => (wallMinutes(at, viewer) / 60) * HOUR_PX;

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
          onClick={() => setStart(startOfDay(now))}
        >
          Today
        </button>
        <span className="r-cal-range" role="status" data-testid="calendar-range">
          {range}
        </span>
        <span className="r-zone">Your time, {zoneCity(viewer)}</span>
      </div>
      {recorded.status === "error" ? (
        <Note tone="warn" testId="calendar-error">
          <p>
            <strong>Couldn&apos;t load the runs on these days.</strong> {recorded.error}
          </p>
          <button type="button" className="button" data-size="sm" onClick={retry}>
            Try again
          </button>
        </Note>
      ) : (
        recorded.status === "ready" &&
        recorded.value.partial && (
          <Note testId="calendar-partial">
            <p>
              <strong>Some runs on these days aren&apos;t shown.</strong> The gateway recorded more
              runs since then than Clawtrate reads at once.
            </p>
          </Note>
        )
      )}
      <div className="r-cal-scroll">
        <div
          ref={gridRef}
          className="r-cal"
          role="group"
          aria-label="Routines by day"
          style={{ ["--days" as string]: days, ["--hour" as string]: `${HOUR_PX}px` }}
          onKeyDown={onKey}
        >
          <div className="r-cal-corner" aria-hidden="true" />
          {columns.map((day, index) => (
            <div
              key={`head:${day}`}
              id={`${headId}-${index}`}
              className="r-cal-dayhead"
              data-today={day === startOfDay(now) || undefined}
            >
              {dayName(day, now)} <small>{dateName(day)}</small>
            </div>
          ))}
          {bands.some((each) => each.length > 0) && (
            <>
              <div className="r-cal-corner" aria-hidden="true" />
              {columns.map((day, index) => (
                <div key={`bands:${day}`} className="r-cal-bands">
                  {bands[index]!.map((routine) => {
                    const words = `${scheduleWords(routine.schedule).text} · ${routine.name}`;
                    return (
                      <button
                        key={routine.id}
                        type="button"
                        className="r-cal-band"
                        aria-label={`${words}, ${dayLabel(day)}`}
                        title={words}
                        onClick={() => onOpen(routine.id)}
                      >
                        {words}
                      </button>
                    );
                  })}
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
          {columns.map((day, dayIndex) => {
            const mine = chips.filter((chip) => chip.at >= day && chip.at < addDays(day, 1));
            const label = dayLabel(day);
            const empty = mine.length === 0 && bands[dayIndex]!.length === 0;
            // Chips that start less than an hour apart share the row side by side, in time order.
            const groups: Chip[][] = [];
            for (const chip of mine) {
              const group = groups.at(-1);
              const last = group?.at(-1);
              if (
                group &&
                last &&
                Math.abs(wallMinutes(chip.at, viewer) - wallMinutes(last.at, viewer)) < 60
              )
                group.push(chip);
              else groups.push([chip]);
            }
            const place = new Map(
              groups.flatMap((group) =>
                group.map((chip, index) => [chip.key, { index, of: group.length }] as const),
              ),
            );
            return (
              <ul
                key={`day:${day}`}
                className="r-cal-day"
                aria-labelledby={`${headId}-${dayIndex}`}
                aria-describedby={empty ? `${headId}-${dayIndex}-empty` : undefined}
                data-testid="calendar-day"
              >
                {empty && (
                  <li id={`${headId}-${dayIndex}-empty`} hidden>
                    Nothing scheduled
                  </li>
                )}
                {startOfDay(now) === day && (
                  <li className="r-now" aria-hidden="true" style={{ top: top(now) }} />
                )}
                {mine.map((chip) => {
                  const bot = ownerOf(bots, chip.routine.botId);
                  const { index, of } = place.get(chip.key)!;
                  const outcome = chip.running
                    ? ", running"
                    : chip.past
                      ? chip.failed
                        ? ", failed"
                        : ", ran"
                      : "";
                  const later = chip.guessed
                    ? ", and later, as the gateway decides"
                    : !chip.past && !chip.running && mayStagger(chip.routine)
                      ? ", may start up to 5 minutes later"
                      : "";
                  return (
                    <li
                      key={chip.key}
                      className="r-occ-slot"
                      style={{
                        top: top(chip.at),
                        left: `${(index / of) * 100}%`,
                        right: `${((of - 1 - index) / of) * 100}%`,
                      }}
                    >
                      <button
                        type="button"
                        className="r-occ"
                        data-testid="occurrence"
                        data-past={chip.past || undefined}
                        data-outcome={chip.failed ? "failed" : undefined}
                        data-minute={wallMinutes(chip.at, viewer)}
                        aria-label={`${chip.routine.name}, ${bot.name}, ${label} ${timeName(chip.at)}${outcome}`}
                        title={`${timeName(chip.at)}${later}`}
                        onClick={() => onOpen(chip.routine.id)}
                      >
                        {chip.running && (
                          <span className="glyph" data-state="working" aria-hidden="true" />
                        )}
                        <Avatar bot={bot} />
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
