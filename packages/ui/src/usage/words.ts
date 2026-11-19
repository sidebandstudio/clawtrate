// Every word the usage pages, the budget form and its lines say
// (docs/design/controls.md, sections 16 to 18), from the gateway's figures.

import {
  budgetPercent,
  currentCount,
  type Budget,
  type BudgetCount,
  type BudgetPeriod,
  type UsageCost,
  type UsagePeriod,
  type UsageState,
} from "@clawtrate/core";
import { clock } from "../bots/words.ts";

/** A count in full: 1,640,000. */
export const full = (n: number): string => n.toLocaleString("en-US");

/** A count in short, for meters and bars: 1.64M, 41k, 1.8k, 900. */
export function short(n: number): string {
  const trim = (text: string) => text.replace(/\.?0+$/, "");
  if (n >= 1e6) return `${trim((n / 1e6).toFixed(2))}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${trim((n / 1e3).toFixed(1))}k`;
  return String(Math.round(n));
}

/** The device's own time zone: the person's, for periods and new budgets. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export const PERIODS: Array<[UsagePeriod, string]> = [
  ["today", "Today"],
  ["week", "This week"],
  ["month", "30 days"],
];

/** "today" for a Daily budget, "this week" for a Weekly one. */
export const periodWord = (period: BudgetPeriod): string =>
  period === "daily" ? "today" : "this week";
export const kindWord = (period: BudgetPeriod): string => (period === "daily" ? "daily" : "weekly");

/** When the gateway's figure is from. */
export function asOf(at: number | null): string {
  return at === null ? "at a time the gateway didn't give" : `as of ${clock(at)}`;
}

/** When a budget's period starts again, in its own time zone. */
export function resetWords(budget: Budget): string {
  const where = budget.timeZone === deviceTimeZone() ? "your time" : budget.timeZone;
  return budget.period === "daily"
    ? `Resets at 00:00, ${where}.`
    : `Resets Monday at 00:00, ${where}.`;
}

/** The cost as a fact's value: the gateway's estimate, or its absence. */
export function costValue(cost: UsageCost): string {
  switch (cost.status) {
    case "estimate":
      return `About $${cost.usd.toFixed(2)}`;
    case "partial":
      return `About $${cost.usd.toFixed(2)} · Partial`;
    case "unavailable":
      return "Unavailable";
  }
}

/** The cost in a row's value, lower case. */
export function costShort(cost: UsageCost): string {
  switch (cost.status) {
    case "estimate":
      return `about $${cost.usd.toFixed(2)}`;
    case "partial":
      return `about $${cost.usd.toFixed(2)}, partial`;
    case "unavailable":
      return "cost unavailable";
  }
}

const records = (n: number) => (n === 1 ? "1 usage record has" : `${full(n)} usage records have`);

/** What the cost is, said under it. */
export function costHint(cost: UsageCost, at: number | null): string {
  if (cost.status === "unavailable")
    return `Cost unavailable: the gateway has no price configured for what was used, ${asOf(at)}.`;
  const base = `The gateway's estimate from its configured prices, in US dollars, ${asOf(at)}.`;
  return cost.status === "partial"
    ? `${base} Partial: ${records(cost.unpriced)} no price configured.`
    : base;
}

/** A bot's budget, and its count for the period it is in now. */
export function budgetOf(
  usage: UsageState | undefined,
  botId: string,
  now: number,
): { budget: Budget; count: BudgetCount | null; percent: number | null } | null {
  const budget = usage?.budgets.find((each) => each.id === `bot:${botId}`);
  if (!budget) return null;
  const count = currentCount(usage, budget, now);
  return { budget, count, percent: budgetPercent(budget, count?.used ?? null) };
}

/** "1.64M of 2.5M tokens this week", and "partial" when the count may miss some of the use. */
export function budgetLine(budget: Budget, count: BudgetCount | null): string {
  const used = count?.used ?? null;
  return used === null
    ? `${short(budget.tokens)} tokens ${periodWord(budget.period)}, not counted yet`
    : `${short(used)} of ${short(budget.tokens)} tokens ${periodWord(budget.period)}${count?.partial ? ", partial" : ""}`;
}

/** What a partial count is short of. */
export const PARTIAL_COUNT =
  "Partial: the gateway lists only its most recently updated tasks at once, and some of this routine's may not be among them.";

/** The 80 percent line in the bot's task (F-396). */
export function warnedLine(name: string, budget: Budget, used: number, percent: number): string {
  return `${name} has used ${percent}% of its ${kindWord(budget.period)} budget: ${short(used)} of ${short(budget.tokens)} tokens.`;
}

/** The composer's note at 100 percent: a warning, said as one. */
export function reachedLine(name: string, budget: Budget): string {
  return `${name} has reached its ${kindWord(budget.period)} warning budget. This is shown only: other apps, channels and ${name}'s routines aren't stopped.`;
}
