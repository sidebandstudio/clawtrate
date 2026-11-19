// The words the usage pages say (docs/design/controls.md, sections 16 and 17):
// each figure is the gateway's for the period, zone and scope it names, or it
// says what it is short of.

import type { Budget, BudgetCount, UsageFigure, UsageReport } from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import {
  barText,
  botBars,
  botsLeftOut,
  budgetFailure,
  budgetInput,
  CONTEXT_HINT,
  contextValue,
  budgetLine,
  budgetWindow,
  costHint,
  costValue,
  deviceTimeZone,
  figureLine,
  meterTone,
  moreTasks,
  reachedLine,
  reportFits,
  reportWindow,
  sourceBars,
  sourcesNote,
  stillClosed,
  warnedLine,
  warningWords,
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
    // A routine that can't be counted apart any more: no number, said as unavailable.
    expect(
      budgetLine(
        routine,
        count({ used: null, error: "Usage for this routine can't be counted separately." }),
      ),
    ).toBe("1,000 tokens today, count unavailable");
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

describe("a cost the gateway's answer didn't give", () => {
  it("F-232: is unavailable, said as the answer's gap, not as a missing price", () => {
    expect(costValue({ status: "unavailable", unpriced: 0 })).toBe("Unavailable");
    expect(costHint({ status: "unavailable", unpriced: 0 }, null)).toBe(
      "Cost unavailable: the gateway's answer gave no cost, at a time the gateway didn't give.",
    );
  });
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
    // A recount that failed keeps the earlier count's state, and says it failed.
    expect(budgetLine(routine, count({ counting: true, error: "read timed out" }))).toBe(
      "200 of 1,000 tokens today so far, refresh failed",
    );
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
    // Each bar is told apart by its bot, even when two bots share a name.
    expect(botBars(report, () => "Helper").map((bar) => bar.id)).toEqual(["marlow", "otto"]);
    expect(bars.map((bar) => `${bar.name}: ${barText(bar)}`)).toEqual([
      "Marlow: 1,800 tokens so far, still being counted",
      "Otto: Unavailable",
    ]);
    // A settled bar names its own time: each bot's figure is read on its own.
    const settled = botBars(
      { ...report, bots: [{ botId: "pip", figure: figure({}), error: null }] },
      () => "Pip",
    )[0]!;
    expect(barText(settled)).toMatch(/^1,800 tokens, as of \d{1,2}:07 [AP]M$/);
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
      id: "unattributed",
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

describe("a report kept while another is read", () => {
  it("F-237: is shown only for the same bot and the same days, so no other period's figures stand in", () => {
    const week = { startDate: "2026-11-16", endDate: "2026-11-19", timeZone: NY };
    const report = { botId: "otto", period: "week", range: week } as UsageReport;
    expect(reportFits(report, "otto", "week", week)).toBe(true);
    // Today, after This week: another period.
    expect(reportFits(report, "otto", "today", { ...week, startDate: "2026-11-19" })).toBe(false);
    // On a Monday the week is today, the same day: still another period, said as its own.
    const monday = { startDate: "2026-11-16", endDate: "2026-11-16", timeZone: NY };
    expect(reportFits({ ...report, range: monday }, "otto", "today", monday)).toBe(false);
    // The same period after the date's rollover: other days.
    expect(reportFits(report, "otto", "week", { ...week, endDate: "2026-11-20" })).toBe(false);
    // Another bot, or every bot.
    expect(reportFits(report, "pip", "week", week)).toBe(false);
    expect(reportFits(report, null, "week", week)).toBe(false);
    expect(reportFits(report, "otto", "week", { ...week, timeZone: "Asia/Tokyo" })).toBe(false);
  });
});

describe("the open task's context", () => {
  it("F-233: is the latest prompt the gateway reported against the model's window, with no output in it", () => {
    expect(contextValue({ used: 120, window: 128_000, fresh: true })).toBe(
      "120 tokens in the latest prompt, of the model's 128,000",
    );
    expect(contextValue({ used: 120, window: 128_000, fresh: false })).toMatch(/^about 120 /);
    expect(CONTEXT_HINT).toMatch(/output isn't part of it/);
    expect(CONTEXT_HINT).not.toMatch(/counts input, output/);
    expect(CONTEXT_HINT).toMatch(/Breakdown unavailable/);
  });
});

describe("a budget reached", () => {
  it("S17 says runs continue when the warning appears, and its meter is a warning's, not a stop's", () => {
    const weekly: Budget = { ...routine, id: "bot:otto", routineId: null, period: "weekly" };
    expect(reachedLine("Otto", weekly)).toBe(
      "Otto has reached its weekly warning budget. Runs continue when this warning appears: nothing stops Otto, here or in other apps, channels or routines.",
    );
    expect(warningWords("Otto")).toMatch(/Runs continue when it appears/);
    expect(meterTone(799, 1_000)).toBeUndefined();
    expect(meterTone(800, 1_000)).toBe("warn");
    expect(meterTone(1_000, 1_000)).toBe("warn");
    expect(meterTone(2_400, 1_000)).toBe("warn");
  });
});

describe("a closed provider note", () => {
  it("F-236: stays closed only while its window is reported at the figure it was closed at", () => {
    const closedAt91 = new Map([["openai:Weekly", 91]]);
    // Still 91: still closed, the same map.
    const same = stillClosed(closedAt91, new Map([["openai:Weekly", 91]]));
    expect(same).toBe(closedAt91);
    // 92: it comes back, and is not kept closed for 91.
    const at92 = stillClosed(closedAt91, new Map([["openai:Weekly", 92]]));
    expect([...at92]).toEqual([]);
    // Back to 91 afterwards: still shown, since nothing was kept.
    expect([...stillClosed(at92, new Map([["openai:Weekly", 91]]))]).toEqual([]);
    // A window no longer reported is forgotten.
    expect([...stillClosed(closedAt91, new Map())]).toEqual([]);
  });
});

describe("a budget change that failed", () => {
  it("F-234: one whose answer was lost says it couldn't be confirmed, never that it wasn't saved", () => {
    expect(
      budgetFailure(
        "set",
        "The change couldn't be confirmed: Connection lost. The gateway doesn't hold it now; what it holds is shown.",
      ),
    ).toMatch(/^The change couldn't be confirmed/);
    expect(budgetFailure("remove", "Not connected.")).toBe(
      "Couldn't remove the budget: Not connected.",
    );
  });
});

describe("counts on screen", () => {
  it("S19 are full numbers, never shortened", () => {
    const weekly: Budget = { ...routine, id: "bot:otto", routineId: null, tokens: 2_500_000 };
    expect(budgetLine(weekly, count({ used: 1_640_000 }))).toBe(
      "1,640,000 of 2,500,000 tokens today",
    );
    expect(budgetLine(weekly, null)).toBe("2,500,000 tokens today, not counted yet");
    expect(warnedLine("Otto", weekly, { ...count({}), used: 2_050_000 }, 82)).toBe(
      "Otto has used 82% of its daily budget: 2,050,000 of 2,500,000 tokens.",
    );
    expect(barText({ id: "otto", name: "Otto", tokens: 41_200 })).toBe("41,200 tokens");
  });
});
