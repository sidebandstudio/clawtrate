// The words the usage pages say (docs/design/controls.md, sections 16 and 17):
// each figure is the gateway's for the period, zone and scope it names, or it
// says what it is short of.

import type { Budget, BudgetCount, UsageFigure } from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { budgetLine, costHint, costValue, figureLine, warnedLine } from "../src/usage/words.ts";

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
