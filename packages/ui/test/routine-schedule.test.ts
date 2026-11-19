import type { Routine } from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import {
  fullWhen,
  frequent,
  occurrences,
  runOutcome,
  scheduleWords,
  triggerWords,
  wallMinutes,
  when,
  zonedTime,
  zoneWords,
} from "../src/routines/schedule.ts";

const NY = "America/New_York";
// Wed Nov 18 2026, 10:00 AM in New York.
const NOW = zonedTime(2026, 11, 18, 10, 0, NY);
const schedule = (over: Partial<Routine["schedule"]>): Routine["schedule"] => ({
  kind: "cron",
  expr: null,
  tz: null,
  everyMs: null,
  at: null,
  name: null,
  ...over,
});
const routine = (over: Partial<Routine> = {}): Routine => ({
  id: "r",
  botId: "marlow",
  name: "Morning digest",
  enabled: true,
  schedule: schedule({ expr: "0 8 * * 1-5", tz: NY }),
  payload: "agentTurn",
  text: "",
  target: "isolated",
  delivery: "none",
  deliveryChannel: null,
  nextRunAt: zonedTime(2026, 11, 19, 8, 0, NY),
  lastRunAt: null,
  lastStatus: null,
  lastError: null,
  runningAt: null,
  deleteAfterRun: false,
  gated: false,
  updatedAt: null,
  ...over,
});

describe("F-191: a schedule in words", () => {
  it("names the common cron schedules and shows any other as written", () => {
    expect(scheduleWords(schedule({ expr: "0 8 * * 1-5", tz: NY }))).toEqual({
      text: "Weekdays at 8:00 AM",
      written: false,
    });
    expect(scheduleWords(schedule({ expr: "30 3 * * *" })).text).toBe("Every day at 3:30 AM");
    expect(scheduleWords(schedule({ expr: "0 17 * * 0" })).text).toBe("Sundays at 5:00 PM");
    expect(scheduleWords(schedule({ expr: "0 9 * * 1,4" })).text).toBe(
      "Mondays and Thursdays at 9:00 AM",
    );
    expect(scheduleWords(schedule({ expr: "0 9 1 * *" }))).toEqual({
      text: "0 9 1 * *",
      written: true,
    });
  });
  it("says repeating and one-off schedules, and the zone each is in", () => {
    expect(scheduleWords(schedule({ kind: "every", everyMs: 1_800_000 })).text).toBe(
      "Every 30 minutes",
    );
    expect(scheduleWords(schedule({ kind: "every", everyMs: 7_200_000 })).text).toBe(
      "Every 2 hours",
    );
    expect(scheduleWords(schedule({ kind: "at", at: "2035-01-01T09:00:00Z" })).text).toBe(
      "Once, Jan 1, 2035 at 9:00 AM",
    );
    expect(zoneWords(schedule({ expr: "0 8 * * *", tz: NY }))).toBe("New York");
    expect(zoneWords(schedule({ expr: "0 8 * * *" }))).toBe("gateway's time");
    expect(zoneWords(schedule({ kind: "at", at: "2035-01-01T09:00:00Z" }))).toBe("UTC");
    expect(zoneWords(schedule({ kind: "every", everyMs: 60_000 }))).toBe("");
  });
});

describe("F-353: times in a zone", () => {
  it("say the day relative to now in that zone", () => {
    const next = zonedTime(2026, 11, 19, 8, 0, NY);
    expect(when(next, NOW, NY)).toBe("tomorrow 8:00 AM");
    expect(fullWhen(next, NOW, NY)).toBe("Tomorrow, Thu Nov 19, 8:00 AM");
    // The same instant in Berlin is 2:00 PM.
    expect(when(next, NOW, "Europe/Berlin")).toBe("tomorrow 2:00 PM");
    expect(when(zonedTime(2026, 11, 20, 9, 0, NY), NOW, NY)).toBe("Fri 9:00 AM");
  });
  it("cross a daylight-saving change at the wall-clock time", () => {
    // New York leaves daylight time on Nov 1, 2026: 8:00 AM is 12:00 UTC before and 13:00 after.
    expect(new Date(zonedTime(2026, 10, 30, 8, 0, NY)).toISOString()).toBe(
      "2026-10-30T12:00:00.000Z",
    );
    expect(new Date(zonedTime(2026, 11, 2, 8, 0, NY)).toISOString()).toBe(
      "2026-11-02T13:00:00.000Z",
    );
  });
});

describe("F-197: occurrences", () => {
  const week = [NOW, NOW + 7 * 86_400_000] as const;
  it("follow the cron schedule in the routine's zone", () => {
    const times = occurrences(routine(), ...week).map((ms) => when(ms, NOW, NY));
    expect(times).toEqual([
      "tomorrow 8:00 AM",
      "Fri 8:00 AM",
      "Mon 8:00 AM",
      "Tue 8:00 AM",
      "Nov 25 8:00 AM",
    ]);
  });
  it("step a repeating schedule from its next run, and leave a paused routine out", () => {
    const every = routine({
      schedule: schedule({ kind: "every", everyMs: 30 * 60_000 }),
      nextRunAt: NOW + 10 * 60_000,
    });
    expect(occurrences(every, NOW, NOW + 3_600_000)).toEqual([NOW + 600_000, NOW + 2_400_000]);
    expect(frequent(every)).toBe(true);
    expect(frequent(routine())).toBe(false);
    expect(occurrences(routine({ enabled: false }), ...week)).toEqual([]);
  });
  // The expected instants are what OpenClaw 2026.10.6's own scheduler
  // (`computeNextRunAtMs`, croner) returned for these schedules, one after another.
  const iso = (times: number[]) => times.map((ms) => new Date(ms).toISOString());
  it("skip a time the clock skips (spring forward), as the gateway does", () => {
    const daily = routine({
      schedule: schedule({ expr: "30 2 * * *", tz: NY }),
      nextRunAt: Date.parse("2026-03-07T07:30:00Z"),
    });
    expect(
      iso(
        occurrences(daily, Date.parse("2026-03-07T00:00:00Z"), Date.parse("2026-03-11T00:00:00Z")),
      ),
    ).toEqual(["2026-03-07T07:30:00.000Z", "2026-03-09T06:30:00.000Z", "2026-03-10T06:30:00.000Z"]);
  });
  it("run a time the clock passes twice (fall back) once, the first time, as the gateway does", () => {
    const daily = routine({
      schedule: schedule({ expr: "30 1 * * *", tz: NY }),
      nextRunAt: Date.parse("2026-10-31T05:30:00Z"),
    });
    expect(
      iso(
        occurrences(daily, Date.parse("2026-10-31T00:00:00Z"), Date.parse("2026-11-03T00:00:00Z")),
      ),
    ).toEqual(["2026-10-31T05:30:00.000Z", "2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"]);
    const halfHours = routine({
      schedule: schedule({ expr: "*/30 1-2 * * *", tz: NY }),
      nextRunAt: Date.parse("2026-11-01T05:00:00Z"),
    });
    expect(
      iso(
        occurrences(
          halfHours,
          Date.parse("2026-11-01T04:10:00Z"),
          Date.parse("2026-11-01T12:00:00Z"),
        ),
      ),
    ).toEqual([
      "2026-11-01T05:00:00.000Z",
      "2026-11-01T05:30:00.000Z",
      "2026-11-01T07:00:00.000Z",
      "2026-11-01T07:30:00.000Z",
    ]);
  });
  it("start at the gateway's next run, even when it is a few minutes after the written time", () => {
    const staggered = routine({ nextRunAt: zonedTime(2026, 11, 19, 8, 3, NY) });
    expect(
      occurrences(staggered, ...week)
        .map((ms) => when(ms, NOW, NY))
        .slice(0, 2),
    ).toEqual(["tomorrow 8:03 AM", "Fri 8:00 AM"]);
    expect(occurrences(routine({ nextRunAt: null }), ...week)).toEqual([]);
  });
  it("sit on the day's hour scale by the wall clock, also on a day of 23 hours", () => {
    // Sun Mar 8 2026 in New York: 8:00 AM is seven hours after midnight, drawn at eight.
    const eight = zonedTime(2026, 3, 8, 8, 0, NY);
    expect(wallMinutes(eight, NY)).toBe(8 * 60);
  });
  it("draw a schedule it cannot compute only at its next run", () => {
    const zoneless = routine({ schedule: schedule({ expr: "0 8 * * *" }) });
    expect(occurrences(zoneless, ...week)).toEqual([zoneless.nextRunAt]);
    const gated = routine({ gated: true });
    expect(occurrences(gated, ...week)).toEqual([gated.nextRunAt]);
  });
});

describe("F-188: what starts a routine", () => {
  it("is its schedule, its schedule then a check, or another kind of trigger, by what the gateway says", () => {
    expect(triggerWords(routine())).toBe("Its schedule only.");
    expect(triggerWords(routine({ schedule: schedule({ kind: "every", everyMs: 60_000 }) }))).toBe(
      "Its schedule only.",
    );
    expect(triggerWords(routine({ gated: true }))).toBe(
      "Its schedule, then a check or spacing set on it.",
    );
    for (const name of ["on-exit", "stream"])
      expect(triggerWords(routine({ schedule: schedule({ kind: "other", name }) }))).toBe(
        `The gateway's "${name}" trigger, not a clock schedule.`,
      );
  });
});

describe("F-190: a run's outcome", () => {
  const run = {
    jobId: "r",
    runId: "x",
    runAt: NOW,
    status: "ok" as const,
    completion: "succeeded" as const,
    error: null,
    summary: null,
    durationMs: 2_600,
    model: null,
    provider: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: 200,
    sessionKey: null,
    manual: false,
  };
  it("reads as the design words it", () => {
    expect(runOutcome(run)).toEqual({ text: "Succeeded · 2.6 s · 200 tokens", mark: null });
    expect(runOutcome({ ...run, status: "error", error: "Channel is required.\nmore" })).toEqual({
      text: "Failed: Channel is required.",
      mark: "failed",
    });
    expect(runOutcome({ ...run, status: "skipped" })).toEqual({ text: "Skipped", mark: "stopped" });
    expect(runOutcome({ ...run, completion: "failed" }).text).toBe(
      "Ran, but its result wasn't delivered",
    );
  });
});
