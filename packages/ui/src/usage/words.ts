// Every word the usage pages, the budget form and its lines say
// (docs/design/controls.md, sections 16 to 18), from the gateway's figures.

import {
  budgetPercent,
  currentCount,
  rangeFor,
  SESSIONS_LIMIT,
  type Budget,
  type BudgetCount,
  type BudgetInput,
  type BudgetPeriod,
  type DateRange,
  type TaskContext,
  type UsageCost,
  type UsageFigure,
  type UsagePeriod,
  type UsageReport,
  type UsageSources,
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

/** Whether a report is for this bot (or every bot) and exactly these days, in this time zone. */
export function reportFits(report: UsageReport, botId: string | null, range: DateRange): boolean {
  return (
    report.botId === botId &&
    report.range.startDate === range.startDate &&
    report.range.endDate === range.endDate &&
    report.range.timeZone === range.timeZone
  );
}

/** A failed read beside the figures of an earlier one for the same days. */
export function refreshFailed(error: string, report: UsageReport): string {
  const said = /[.!?]$/.test(error) ? error : `${error}.`;
  return `Couldn't read these again: ${said} Shown: the figures ${asOf(report.figure.asOf)}.`;
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

const SOURCE_NAMES: Array<[keyof Omit<UsageSources, "partial">, string]> = [
  ["people", "Messages from people"],
  ["routines", "Routines"],
  ["bots", "Messages from other bots"],
  ["unattributed", "Not attributed"],
];

/** The source bars: each part the reads established, and the rest only once it is a figure. */
export function sourceBars(sources: UsageSources): BarRow[] {
  return SOURCE_NAMES.flatMap(([key, name]) => {
    const tokens = sources[key];
    return tokens === null ? [] : [{ name, tokens }];
  });
}

/** What the source bars are short of, if anything. */
export function sourcesNote(sources: UsageSources, counting: boolean): string {
  if (counting)
    return " Partial: the gateway is still counting, so these may grow, and the rest of its total isn't shown until it has finished.";
  return sources.partial
    ? " Partial: some tasks weren't read in full, so more may belong to a named source."
    : "";
}

/** The tasks the page doesn't list by name, and when the gateway's list was capped, that it was. */
export function moreTasks(omitted: number, capped: boolean): string {
  const tasks = `${full(omitted)} more ${omitted === 1 ? "task" : "tasks"}`;
  return capped ? `${tasks} of the ${full(SESSIONS_LIMIT)} listed` : tasks;
}

/**
 * The open task's context, as the gateway reports it (`sessions.list`
 * `totalTokens` of `contextTokens`): the latest prompt it counted, against the
 * model's window. A reply's output is not part of it.
 */
export function contextValue(context: TaskContext): string {
  return `${context.fresh ? "" : "about "}${full(context.used)} tokens in the latest prompt, of the model's ${full(context.window)}`;
}

/** Said under the context. */
export const CONTEXT_HINT =
  "The latest prompt the gateway reported for this task, against the model's context window; a reply's output isn't part of it. Breakdown unavailable: what fills it, history, memory or tools, isn't reported.";

/** While the host is busy reading other usage: the page waits, it hasn't failed. */
export const USAGE_WAITING =
  "Waiting: Clawtrate is reading other usage from the gateway first, and asks again in a moment.";

/** Said under the tasks when the gateway listed as many as it was asked for. */
export const TASKS_CAPPED = `The gateway lists at most ${full(SESSIONS_LIMIT)} tasks at once, the most recently updated first: these are the largest of those, and there may be others.`;

/** How many bots the state's list left out (the `bots[N<]` mark of a cut list). */
export function botsLeftOut(cut: readonly string[] | undefined): number {
  for (const path of cut ?? []) {
    const match = /^bots\[(\d+)<\]$/.exec(path);
    if (match) return Number(match[1]);
  }
  return 0;
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

/** The note at 100 percent, above the composer and on the Usage page: a warning, said as one. */
export function reachedLine(name: string, budget: Budget): string {
  return `${name} has reached its ${kindWord(budget.period)} warning budget. Runs continue when this warning appears: nothing stops ${name}, here or in other apps, channels or routines.`;
}

/**
 * The provider notes still closed: each a window still near its limit, at the
 * figure it was closed at. A note closed at one figure comes back when the
 * figure changes, even back to that one, and nothing is kept for a window
 * no longer reported.
 */
export function stillClosed(
  closed: ReadonlyMap<string, number>,
  current: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  const kept = new Map([...closed].filter(([key, percent]) => current.get(key) === percent));
  return kept.size === closed.size ? closed : kept;
}

/** What a budget is, said under its meter. */
export function warningWords(name: string): string {
  return `A warning: at 80% a line in ${name}'s task, at 100% a note above the composer. Runs continue when it appears: nothing stops ${name} at the limit, here or in other apps, channels or routines.`;
}

/** A meter's tone: a warning's from 80 percent, at 100 percent and past it too, never a stop's. */
export function meterTone(used: number, limit: number): "warn" | undefined {
  return limit > 0 && Math.floor((used / limit) * 100) >= 80 ? "warn" : undefined;
}
