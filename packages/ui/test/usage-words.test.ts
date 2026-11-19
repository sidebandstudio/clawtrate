// The words the usage pages say (docs/design/controls.md, sections 16 and 17):
// each figure is the gateway's for the period, zone and scope it names, or it
// says what it is short of.

import type { Budget, BudgetCount } from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { budgetLine } from "../src/usage/words.ts";

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
