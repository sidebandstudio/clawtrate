import type { Routine } from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import {
  draftOf,
  fieldsOfDraft,
  isoAt,
  newDraft,
  nextRuns,
  problems,
  shortestGap,
  usualZone,
  type Draft,
} from "../src/routines/draft.ts";
import { zonedTime } from "../src/routines/schedule.ts";

const NY = "America/New_York";
const NOW = zonedTime(2026, 11, 18, 10, 0, NY);
const routine = (over: Partial<Routine> = {}): Routine => ({
  id: "r",
  botId: "marlow",
  name: "Morning digest",
  enabled: true,
  schedule: { kind: "cron", expr: "0 8 * * 1-5", tz: NY, everyMs: null, at: null, name: null },
  payload: "agentTurn",
  text: "Summarise yesterday's notes.",
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
const draft = (over: Partial<Draft>): Draft => ({
  ...newDraft("marlow", [], NOW),
  name: "Check",
  text: "Do it.",
  ...over,
});

describe("F-195: at least five minutes apart", () => {
  it("is Clawtrate's floor for a repeating schedule", () => {
    expect(problems(draft({ when: "every", count: "4", unit: "minutes" }), NOW).when).toBe(
      "Routines run at least 5 minutes apart.",
    );
    expect(problems(draft({ when: "every", count: "5", unit: "minutes" }), NOW)).toEqual({});
    expect(problems(draft({ when: "every", count: "1", unit: "hours" }), NOW)).toEqual({});
  });

  it("holds for a cron expression by the real spacing of its runs, across hours and days, as the gateway reads it", () => {
    const floor = (cron: string) => problems(draft({ cron }), NOW).cron;
    for (const cron of ["*/5 * * * *", "0-1/4 * * * *", "0,59 8 * * *", "0 8 * * 1-5", "0 9 1 * *"])
      expect(floor(cron), cron).toBeUndefined();
    // 56 → 0 across the hour; 1, 8, … 57 → 1; 5 and 7 a minute apart.
    for (const cron of [
      "*/7 * * * *",
      "1-59/7 * * * *",
      "*/5,*/7 * * * *",
      "58,59 * * * *",
      "*/30 * * * * *",
    ])
      expect(floor(cron), cron).toBe("Routines run at least 5 minutes apart.");
    // Past midnight only when the next day runs too.
    expect(shortestGap("1,58 0,23 * * *", NY, NOW)).toBe(3);
    expect(shortestGap("1,58 0,23 * * 1", NY, NOW)).toBe(57);
    expect(floor("99 * * * *")).toMatch(/^The gateway can't read this: .*minute/u);
    expect(floor("0 9 * * MON")).toBeUndefined();
  });

  it("holds across the eight years from today, for a schedule whose first run is years away", () => {
    const floor = (cron: string) => problems(draft({ cron }), NOW).cron;
    expect(floor("0 0,1 8 * * * 2031")).toBe("Routines run at least 5 minutes apart.");
    expect(floor("0 0,1 8 * * * 2034")).toBe("Routines run at least 5 minutes apart.");
    expect(floor("0 0,10 8 * * * 2034")).toBeUndefined();
    // 23:59 on Jan 3 to 0:00 on Jan 4; Jan 1 and Jan 3 are not consecutive.
    expect(shortestGap("0 0,59 0,23 1,3,4 1 * 2033", NY, NOW)).toBe(1);
    expect(shortestGap("0 0,59 0,23 1,3 1 * 2033", NY, NOW)).toBe(59);
  });
});

describe("F-189: the draft", () => {
  it("reads a weekday schedule into the choice list, and keeps one the list can't say as written", () => {
    expect(draftOf(routine(), NOW)).toMatchObject({
      when: "weekdays",
      time: "08:00",
      tz: NY,
      locked: null,
    });
    const monthly = routine({
      schedule: {
        kind: "cron",
        expr: "0 9 1 * *",
        tz: "Europe/Berlin",
        everyMs: null,
        at: null,
        name: null,
      },
    });
    expect(draftOf(monthly, NOW).locked).toEqual(monthly.schedule);
    expect(fieldsOfDraft(draftOf(monthly, NOW)).schedule).toEqual(monthly.schedule);
  });

  it("previews a far-off Once schedule at the stored instant", () => {
    const at = "2035-01-01T08:00:37.000Z";
    const saved = routine({
      schedule: { kind: "at", at, expr: null, tz: null, everyMs: null, name: null },
    });
    expect(nextRuns(draftOf(saved, NOW), NOW)).toEqual([Date.parse(at)]);
  });

  it("previews three distinct cron instants across the spring gap", () => {
    const schedule = draft({ cron: "0 0,30 2,3 14 3 *", tz: NY });
    expect(nextRuns(schedule, NOW).map((ms) => new Date(ms).toISOString())).toEqual([
      "2027-03-14T07:00:00.000Z",
      "2027-03-14T07:30:00.000Z",
      "2028-03-14T06:00:00.000Z",
    ]);
  });

  it("writes Once as a time with its zone's offset", () => {
    expect(isoAt("2035-01-01", "09:00", NY)).toBe("2035-01-01T09:00:00-05:00");
    expect(isoAt("2035-07-01", "09:00", NY)).toBe("2035-07-01T09:00:00-04:00");
    expect(isoAt("2035-07-01", "09:00", "Asia/Kolkata")).toBe("2035-07-01T09:00:00+05:30");
    const once = draft({ when: "once", date: "2035-01-01", time: "09:00", tz: NY });
    expect(fieldsOfDraft(once).schedule).toMatchObject({
      kind: "at",
      at: "2035-01-01T09:00:00-05:00",
    });
    expect(problems({ ...once, date: "2020-01-01" }, NOW).when).toBe("Pick a time in the future.");
    // A cleared date or time is said, not thrown.
    expect(problems({ ...once, date: "" }, NOW).when).toBe("Choose a date.");
    expect(problems({ ...once, time: "" }, NOW).when).toBe("Choose a time.");
    expect(fieldsOfDraft({ ...once, date: "" }).schedule.at).toBeNull();
  });

  it("gives back a saved one-time schedule exactly when only the name changed", () => {
    const at = "2035-01-01T14:00:30.000Z";
    const saved = routine({
      schedule: { kind: "at", at, expr: null, tz: null, everyMs: null, name: null },
    });
    const opened = draftOf(saved, NOW);
    expect(fieldsOfDraft({ ...opened, name: "Renamed" }).schedule.at).toBe(at);
    // Changing its time writes the new one.
    expect(fieldsOfDraft({ ...opened, time: "23:59" }).schedule.at).not.toBe(at);
  });

  it("keeps a reminder's text and where it runs, and the time zone most of the bot's routines use", () => {
    const reminder = routine({ payload: "systemEvent", target: "main", text: "Stretch" });
    expect(fieldsOfDraft(draftOf(reminder, NOW))).toMatchObject({
      text: "Stretch",
      target: "main",
    });
    expect(
      usualZone(
        [
          routine(),
          routine({ id: "b", schedule: { ...routine().schedule, tz: "Europe/Paris" } }),
          routine({ id: "c" }),
        ],
        "marlow",
      ),
    ).toBe(NY);
  });

  it("asks for a name, an instruction and a day", () => {
    expect(problems(draft({ name: " ", text: "", when: "days", days: [] }), NOW)).toEqual({
      name: "Give it a name.",
      text: "Say what it should do.",
      when: "Choose at least one day.",
    });
  });
});
