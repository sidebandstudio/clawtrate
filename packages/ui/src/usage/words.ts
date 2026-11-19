// Every word the usage pages, the budget form and its lines say
// (docs/design/controls.md, sections 16 to 18), from the gateway's figures.

import {
  budgetPercent,
  currentCount,
  rangeFor,
  type Budget,
  type BudgetCount,
  type BudgetInput,
  type BudgetPeriod,
  type DateRange,
  type UsageCost,
  type UsageFigure,
  type UsagePeriod,
  type UsageReport,
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

/** A time zone in words: "your time" when it is the device's, its name otherwise. */
export const zoneWords = (timeZone: string): string =>
  timeZone === deviceTimeZone() ? "your time" : timeZone;

/** When a budget's period starts again, in its own time zone. */
export function resetWords(budget: Budget): string {
  const where = zoneWords(budget.timeZone);
  return budget.period === "daily"
    ? `Resets at 00:00, ${where}.`
    : `Resets Monday at 00:00, ${where}.`;
}

const dayWords = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

/** The days a figure covers and the time zone they are counted in: "Nov 16 to Nov 19, your time". */
export function rangeWords(range: DateRange): string {
  const days =
    range.startDate === range.endDate
      ? dayWords(range.startDate)
      : `${dayWords(range.startDate)} to ${dayWords(range.endDate)}`;
  return `${days}, ${zoneWords(range.timeZone)}`;
}

/** A report's period in words: "this week (Nov 16 to Nov 19, your time)". */
export function reportWindow(period: UsagePeriod, range: DateRange): string {
  const name = period === "today" ? "today" : period === "week" ? "this week" : "the last 30 days";
  return `${name} (${rangeWords(range)})`;
}

/**
 * What a budget counts, over its own days and in its own time zone, which may
 * be another period or zone than the figures shown with it.
 */
export function budgetWindow(budget: Budget, count: BudgetCount | null, now: number): string {
  const range = count?.range ?? rangeFor(budget.period, now, budget.timeZone);
  const at = count && count.used !== null ? `, ${asOf(count.asOf)}` : "";
  return `Counts the total the gateway reports ${periodWord(budget.period)} (${rangeWords(range)}): input, output and cache${at}.`;
}

/**
 * The budget a form saves. A budget keeps the time zone it was set in, so
 * changing it from a device elsewhere never moves its days; a new one counts
 * in this device's.
 */
export function budgetInput(
  target: { botId: string; routineId: string | null; routineName: string | null },
  existing: Budget | null,
  period: BudgetPeriod,
  tokens: number,
): BudgetInput {
  return { ...target, period, tokens, timeZone: existing?.timeZone ?? deviceTimeZone() };
}

/** " so far" after a figure the gateway is still counting. */
const soFar = (counting: boolean) => (counting ? " so far" : "");

/** A figure's total: "1,800 tokens", or "1,800 tokens so far" while the gateway is still counting. */
export function tokensText(figure: UsageFigure): string {
  return `${full(figure.tokens.total)} tokens${soFar(figure.counting)}`;
}

/** When a figure is from: the gateway's time for it, or that it is still counting. */
export function figureAge(figure: UsageFigure): string {
  return figure.counting ? "still being counted" : asOf(figure.asOf);
}

/** The cost as a fact's value: the gateway's estimate, or its absence. */
export function costValue(cost: UsageCost, counting = false): string {
  switch (cost.status) {
    case "estimate":
      return `About $${cost.usd.toFixed(2)}${soFar(counting)}`;
    case "partial":
      return `About $${cost.usd.toFixed(2)}${soFar(counting)} · Partial`;
    case "unavailable":
      return "Unavailable";
  }
}

/** The cost in a row's value, lower case. */
export function costShort(cost: UsageCost, counting = false): string {
  switch (cost.status) {
    case "estimate":
      return `about $${cost.usd.toFixed(2)}${soFar(counting)}`;
    case "partial":
      return `about $${cost.usd.toFixed(2)}${soFar(counting)}, partial`;
    case "unavailable":
      return "cost unavailable";
  }
}

const records = (n: number) => (n === 1 ? "1 usage record has" : `${full(n)} usage records have`);

/** What the cost is, said under it. */
export function costHint(cost: UsageCost, at: number | null, counting = false): string {
  const when = counting ? "while the gateway is still counting" : asOf(at);
  if (cost.status === "unavailable")
    return `Cost unavailable: the gateway has no price configured for what was used, ${when}.`;
  const base = `The gateway's estimate${soFar(counting)} from its configured prices, in US dollars, ${when}.`;
  return cost.status === "partial"
    ? `${base} Partial: ${records(cost.unpriced)} no price configured.`
    : base;
}

/** A bar: its name, its tokens (null when they couldn't be read), and what they are short of. */
export type BarRow = { name: string; tokens: number | null; note?: string };

/** A bar's figure in words: "1,800 tokens", "1,800 tokens so far", or "Unavailable". */
export function barText(row: BarRow): string {
  return row.tokens === null ? "Unavailable" : `${full(row.tokens)} tokens${row.note ?? ""}`;
}

/** Every bot's bar, each its own figure: "Unavailable" when its read failed, never a zero. */
export function botBars(report: UsageReport, nameOf: (botId: string) => string): BarRow[] {
  return (report.bots ?? []).map((each) => ({
    name: nameOf(each.botId),
    tokens: each.figure ? each.figure.tokens.total : null,
    note: each.figure ? soFar(each.figure.counting) : "",
  }));
}

/** A bot's or every bot's figure in a row's value: its total, its cost and when it is from. */
export function figureLine(figure: UsageFigure): string {
  return `${tokensText(figure)} · ${costShort(figure.cost, figure.counting)}, ${figureAge(figure)}`;
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
    : `${short(used)} of ${short(budget.tokens)} tokens ${periodWord(budget.period)}${count?.counting ? " so far" : ""}${count?.partial ? ", partial" : ""}`;
}

/** What a partial count is short of. */
export const PARTIAL_COUNT =
  "Partial: the gateway lists only its most recently updated tasks at once, and some of this routine's may not be among them.";

/** The 80 percent line in the bot's task (F-396). */
export function warnedLine(
  name: string,
  budget: Budget,
  count: BudgetCount & { used: number },
  percent: number,
): string {
  return `${name} has used ${percent}% of its ${kindWord(budget.period)} budget: ${short(count.used)} of ${short(budget.tokens)} tokens${count.counting ? " so far" : ""}.`;
}

/** The composer's note at 100 percent: a warning, said as one. */
export function reachedLine(name: string, budget: Budget): string {
  return `${name} has reached its ${kindWord(budget.period)} warning budget. This is shown only: other apps, channels and ${name}'s routines aren't stopped.`;
}
