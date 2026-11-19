// The words the usage pages say (docs/design/controls.md, sections 16 and 17):
// each figure is the gateway's for the period, zone and scope it names, or it
// says what it is short of.

import type { Budget, BudgetCount, UsageFigure, UsageReport } from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import {
  barText,
  botBars,
  botsLeftOut,
  budgetInput,
  budgetLine,
  budgetWindow,
  costHint,
  costValue,
  deviceTimeZone,
  figureLine,
  moreTasks,
  reportWindow,
  sourceBars,
  sourcesNote,
  warnedLine,
} from "../src/usage/words.ts";

const NY = "America/New_York";
const routine: Budget = {
  id: "routine:job1",
  botId: "otto",
  routineId: "job1",
  routineName: "Weekly cleanup",
  period: "daily",
  tokens: 1_000,
  timeZone: NY,
  setAt: 0,
};
const count = (change: Partial<BudgetCount>): BudgetCount => ({
  budgetId: routine.id,
  range: { startDate: "2026-11-19", endDate: "2026-11-19", timeZone: NY },
  used: 200,
  asOf: 0,
  counting: false,
  partial: false,
  error: null,
  ...change,
});

describe("a budget's count", () => {
  it("F-234: a count read from a capped list says it is partial", () => {
    expect(budgetLine(routine, count({ partial: true }))).toMatch(/, partial$/);
    expect(budgetLine(routine, count({}))).not.toMatch(/partial/);
  });
});

const figure = (change: Partial<UsageFigure>): UsageFigure => ({
  tokens: { input: 1_080, output: 720, cacheRead: 0, cacheWrite: 0, total: 1_800 },
  cost: { status: "estimate", usd: 0 },
  asOf: Date.UTC(2026, 10, 19, 15, 7),
  counting: false,
  ...change,
});

describe("a figure the gateway is still counting", () => {
  it("F-232: says so wherever it appears: the row, the cost and the budget's count", () => {
    const cold = figure({ counting: true });
    expect(figureLine(cold)).toBe("1,800 tokens so far · about $0.00 so far, still being counted");
    expect(figureLine(figure({}))).toMatch(
      /^1,800 tokens · about \$0\.00, as of \d{1,2}:07 [AP]M$/,
    );
    expect(costValue(cold.cost, true)).toBe("About $0.00 so far");
    expect(costHint(cold.cost, cold.asOf, true)).toBe(
      "The gateway's estimate so far from its configured prices, in US dollars, while the gateway is still counting.",
    );
    expect(budgetLine(routine, count({ counting: true }))).toMatch(/ so far$/);
    expect(warnedLine("Otto", routine, { ...count({ counting: true }), used: 900 }, 90)).toMatch(
      / so far\.$/,
    );
  });
});

describe("every bot's bars", () => {
  it("F-237: a bot whose read failed is Unavailable on its own bar, never a zero", () => {
    const report: UsageReport = {
      botId: null,
      period: "week",
      range: { startDate: "2026-11-16", endDate: "2026-11-19", timeZone: NY },
      figure: figure({}),
      bots: [
        { botId: "marlow", figure: figure({ counting: true }), error: null },
        { botId: "otto", figure: null, error: "usage.cost timed out after 60 seconds." },
      ],
      tasks: null,
      tasksOmitted: 0,
      tasksCapped: false,
      detailCounting: false,
      sources: null,
      detailError: null,
    };
    const bars = botBars(report, (id) => id[0]!.toUpperCase() + id.slice(1));
    expect(bars.map((bar) => `${bar.name}: ${barText(bar)}`)).toEqual([
      "Marlow: 1,800 tokens so far",
      "Otto: Unavailable",
    ]);
  });
});

describe("a budget's window and a report's", () => {
  // Thursday 19 November 2026 at 15:00 in Tokyo, 01:00 in New York.
  const NOW = Date.UTC(2026, 10, 19, 6);
  const weekly: Budget = { ...routine, id: "bot:otto", routineId: null, period: "weekly" };

  it("F-234: each names its own days and time zone; neither says it is the other's figure", () => {
    const words = budgetWindow(weekly, null, NOW);
    expect(words).toBe(
      `Counts the total the gateway reports this week (Nov 16 to Nov 19, ${NY === deviceTimeZone() ? "your time" : NY}): input, output and cache.`,
    );
    expect(words).not.toMatch(/same figure/);
    expect(
      reportWindow("today", {
        startDate: "2026-11-20",
        endDate: "2026-11-20",
        timeZone: "Asia/Tokyo",
      }),
    ).toBe(`today (Nov 20, ${deviceTimeZone() === "Asia/Tokyo" ? "your time" : "Asia/Tokyo"})`);
    expect(
      reportWindow("month", { startDate: "2026-10-21", endDate: "2026-11-19", timeZone: NY }),
    ).toMatch(/^the last 30 days \(Oct 21 to Nov 19, /);
  });

  it("F-234: changing a budget keeps the time zone it was set in; a new one counts in this device's", () => {
    const tokyo: Budget = { ...weekly, timeZone: "Asia/Tokyo" };
    const target = { botId: "otto", routineId: null, routineName: null };
    expect(budgetInput(target, tokyo, "weekly", 5_000).timeZone).toBe("Asia/Tokyo");
    expect(budgetInput(target, null, "weekly", 5_000).timeZone).toBe(deviceTimeZone());
  });
});

describe("sources and tasks", () => {
  it("F-237: the rest of a total still being counted is not shown, and what is shown says it is partial", () => {
    const counting = { people: 700, routines: 0, bots: 200, unattributed: null, partial: true };
    expect(sourceBars(counting).map((bar) => bar.name)).toEqual([
      "Messages from people",
      "Routines",
      "Messages from other bots",
    ]);
    expect(sourcesNote(counting, true)).toMatch(/still counting.*rest of its total isn't shown/);
    expect(sourceBars({ ...counting, unattributed: 800, partial: false }).at(-1)).toEqual({
      name: "Not attributed",
      tokens: 800,
    });
  });

  it("F-237: a count of more tasks after the gateway's cap says it covers the tasks listed", () => {
    expect(moreTasks(2, false)).toBe("2 more tasks");
    expect(moreTasks(192, true)).toBe("192 more tasks of the 200 listed");
  });

  it("F-237: bots the roster's bound left out are counted, so the page can say so", () => {
    expect(botsLeftOut(["bots[8<]", "tasksByBot.otto[3<]"])).toBe(8);
    expect(botsLeftOut(["bots[3].name"])).toBe(0);
    expect(botsLeftOut(undefined)).toBe(0);
  });
});
