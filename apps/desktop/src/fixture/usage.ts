// Usage and warning budgets in the fixture (docs/design/controls.md, sections
// 16 to 18): every state the design draws, answered as the engine would. All
// figures are invented; none came from a gateway or a provider.
//
//   &usage=loading|error|computing|nocost|partial|nolimits   the figures' states
//   &usage=botfail                                            Otto's own figure couldn't be read
//   &usage=busy                                               the host is reading other reports
//   &usage=periodfail                                         reading Today fails
//   &usage=retargeted                                         the routine now runs in a shared task
//   &usage=ages                                               Pip's figure is an hour older; the routine's budget is in Tokyo
//   &budget=none|warn|reached|daily|invalid                   Otto's budget
//   &plimit=near|reached                                      a provider's reported limit
//   &uview=usage                                              open Otto's Usage page

import {
  initialUsage,
  rangeFor,
  type BridgeCommand,
  type Budget,
  type BudgetCount,
  type ClawtrateState,
  type UsageFigure,
  type UsagePeriod,
  type UsageReport,
  type UsageSources,
  type UsageState,
} from "@clawtrate/core";

export type UsageParams = {
  usage:
    | "loading"
    | "error"
    | "computing"
    | "nocost"
    | "partial"
    | "nolimits"
    | "botfail"
    | "busy"
    | "periodfail"
    | "retargeted"
    | "ages"
    | null;
  budget: "none" | "warn" | "reached" | "daily" | "invalid" | null;
  plimit: "near" | "reached" | null;
};

export const NO_USAGE_PARAMS: UsageParams = { usage: null, budget: null, plimit: null };

export function usageParams(params: URLSearchParams): UsageParams {
  const pick = <T extends string>(name: string, values: readonly T[]): T | null => {
    const value = params.get(name);
    return values.includes(value as T) ? (value as T) : null;
  };
  return {
    usage: pick("usage", [
      "loading",
      "error",
      "computing",
      "nocost",
      "partial",
      "nolimits",
      "botfail",
      "busy",
      "periodfail",
      "retargeted",
      "ages",
    ]),
    budget: pick("budget", ["none", "warn", "reached", "daily", "invalid"]),
    plimit: pick("plimit", ["near", "reached"]),
  };
}

/** The time zone the fixture's budgets count in: the device's, as a person's new budget would. */
const zone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

/** This week's figures for each bot. Otto's total is 1,640,000. */
const WEEK: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
> = {
  otto: { input: 322_000, output: 51_000, cacheRead: 1_244_900, cacheWrite: 22_100, cost: 3.29 },
  main: { input: 498_000, output: 91_000, cacheRead: 1_610_000, cacheWrite: 40_000, cost: 5.92 },
  marlow: { input: 120_000, output: 31_000, cacheRead: 402_000, cacheWrite: 9_000, cost: 1.1 },
  pip: { input: 90_000, output: 22_000, cacheRead: 260_000, cacheWrite: 7_000, cost: 0.74 },
};
const SCALE: Record<UsagePeriod, number> = { today: 0.18, week: 1, month: 3.6 };
const SOURCES: Record<
  string,
  { people: number; routines: number; bots: number; unattributed: number }
> = {
  otto: { people: 1_240_000, routines: 312_000, bots: 41_200, unattributed: 46_800 },
  main: { people: 2_239_000, routines: 0, bots: 0, unattributed: 0 },
  marlow: { people: 520_000, routines: 0, bots: 42_000, unattributed: 0 },
  pip: { people: 379_000, routines: 0, bots: 0, unattributed: 0 },
};

function figure(
  botId: string | null,
  period: UsagePeriod,
  params: UsageParams,
  at: number,
): UsageFigure {
  const ids = botId ? [botId] : Object.keys(WEEK);
  const k = SCALE[period];
  const sum = (field: "input" | "output" | "cacheRead" | "cacheWrite" | "cost") =>
    ids.reduce((total, id) => total + (WEEK[id]?.[field] ?? 0) * k, 0);
  const r = (n: number) => Math.round(n);
  const tokens = {
    input: r(sum("input")),
    output: r(sum("output")),
    cacheRead: r(sum("cacheRead")),
    cacheWrite: r(sum("cacheWrite")),
    total: 0,
  };
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  const usd = Math.round(sum("cost") * 100) / 100;
  return {
    tokens,
    cost:
      params.usage === "nocost"
        ? { status: "unavailable", unpriced: 14 }
        : params.usage === "partial"
          ? { status: "partial", usd, unpriced: 2 }
          : { status: "estimate", usd },
    asOf: at,
    counting: params.usage === "computing",
  };
}

const LIMITS: Record<string, number> = { warn: 2_000_000, reached: 1_600_000, daily: 400_000 };

/** The budgets the fixture's gateway keeps, and their counts. */
export function fixtureUsage(now: number, params: UsageParams): UsageState {
  const at = now - 60_000;
  const timeZone = zone();
  const budgets: Budget[] = [];
  if (params.budget !== "none")
    budgets.push({
      id: "bot:otto",
      botId: "otto",
      routineId: null,
      routineName: null,
      period: params.budget === "daily" ? "daily" : "weekly",
      tokens: LIMITS[params.budget ?? ""] ?? 2_500_000,
      timeZone,
      setAt: now - 86_400_000,
    });
  budgets.push({
    id: "routine:weekly-cleanup",
    botId: "otto",
    routineId: "weekly-cleanup",
    routineName: "Weekly cleanup",
    period: "daily",
    tokens: 200_000,
    timeZone: params.usage === "ages" ? "Asia/Tokyo" : timeZone,
    setAt: now - 86_400_000,
  });
  const counts: BudgetCount[] = budgets.map((budget) =>
    // As the engine counts a routine that moved into a shared task: no number.
    budget.routineId && params.usage === "retargeted"
      ? {
          budgetId: budget.id,
          range: rangeFor(budget.period, now, budget.timeZone),
          used: null,
          asOf: null,
          counting: false,
          partial: false,
          error: "Usage for this routine can't be counted separately.",
        }
      : {
          budgetId: budget.id,
          range: rangeFor(budget.period, now, budget.timeZone),
          used: budget.routineId
            ? 41_000
            : figure("otto", budget.period === "daily" ? "today" : "week", params, at).tokens.total,
          asOf: at,
          counting: params.usage === "computing",
          partial: false,
          error: null,
        },
  );
  const windows = params.plimit
    ? [
        {
          label: "Weekly",
          usedPercent: params.plimit === "reached" ? 100 : 92,
          resetAt: now + 86_400_000,
        },
      ]
    : [{ label: "Weekly", usedPercent: 62, resetAt: now + 86_400_000 }];
  return {
    ...initialUsage,
    budgetsStatus: "ok",
    budgets,
    rev: 3,
    counts,
    limits: {
      status: "ok",
      updatedAt: now - 120_000,
      refreshing: false,
      providers:
        params.usage === "nolimits"
          ? []
          : [
              { provider: "openai", displayName: "OpenAI", windows, error: null },
              { provider: "xai", displayName: "xAI", windows: [], error: null },
            ],
    },
  };
}

function report(
  command: Extract<BridgeCommand, { type: "readUsage" }>,
  params: UsageParams,
  now: number,
  every: readonly string[],
): UsageReport {
  const at = now - 60_000;
  const range = rangeFor(command.period, now, command.timeZone);
  const k = SCALE[command.period];
  const ids = command.botId ? [command.botId] : [...every];
  const total = figure(command.botId, command.period, params, at);
  const summed = ids.reduce(
    (sum, id) => {
      const own = SOURCES[id];
      if (!own) return sum;
      return {
        people: sum.people + Math.round(own.people * k),
        routines: sum.routines + Math.round(own.routines * k),
        bots: sum.bots + Math.round(own.bots * k),
        unattributed: sum.unattributed + Math.round(own.unattributed * k),
      };
    },
    { people: 0, routines: 0, bots: 0, unattributed: 0 },
  );
  // As the engine does: while the gateway is still counting, the rest of its total is no figure.
  const counting = params.usage === "computing";
  const sources: UsageSources = {
    ...summed,
    unattributed: counting ? null : summed.unattributed,
    partial: params.usage === "partial" || counting,
  };
  const tasks =
    command.botId === "otto"
      ? [
          ["agent:otto:disk-space", "Disk almost full on the media box", 0.48],
          ["agent:otto:backup-check", "Weekly backup check", 0.22],
          ["agent:otto:cron:weekly-cleanup", "Weekly cleanup", 0.19],
          ["agent:otto:cert-renewal", "Certificate renewal warning", 0.05],
        ].map(([key, label, share]) => ({
          key: key as string,
          label: label as string,
          total: Math.round(total.tokens.total * (share as number)),
          routineId: (key as string).includes(":cron:") ? "weekly-cleanup" : null,
          computing: params.usage === "computing" && key === "agent:otto:disk-space",
        }))
      : [];
  return {
    botId: command.botId,
    period: command.period,
    range,
    figure: total,
    bots: command.botId
      ? null
      : ids.map((id) =>
          params.usage === "botfail" && id === "otto"
            ? { botId: id, figure: null, error: "usage.cost timed out after 60 seconds." }
            : {
                botId: id,
                figure: figure(
                  id,
                  command.period,
                  params,
                  params.usage === "ages" && id === "pip" ? at - 3_600_000 : at,
                ),
                error: null,
              },
        ),
    tasks: command.detail ? tasks : null,
    tasksOmitted: command.detail && command.botId === "otto" ? 2 : 0,
    tasksCapped: false,
    detailCounting: command.detail && counting,
    sources: command.detail ? sources : null,
    detailError: null,
  };
}

/**
 * The usage commands, answered on the fixture's state. Returns undefined for
 * a command that is not one of them.
 */
export function usageCommand(
  command: BridgeCommand,
  get: () => ClawtrateState,
  set: (state: ClawtrateState) => void,
  params: UsageParams,
): Promise<unknown> | undefined {
  const now = Date.now();
  switch (command.type) {
    case "readUsage":
      if (params.usage === "loading") return new Promise(() => {});
      if (params.usage === "busy") return Promise.resolve({ busy: true });
      if (params.usage === "error" || (params.usage === "periodfail" && command.period === "today"))
        return Promise.reject(new Error("usage.cost timed out after 60 seconds."));
      return new Promise((resolve) =>
        setTimeout(
          () =>
            resolve(
              report(
                command,
                params,
                now,
                get().bots.map((bot) => bot.id),
              ),
            ),
          40,
        ),
      );
    case "refreshUsage":
      return Promise.resolve();
    case "listRoutines":
      return Promise.resolve([{ id: "weekly-cleanup", name: "Weekly cleanup", botId: "otto" }]);
    case "changeBudget": {
      const state = get();
      const usage = state.usage ?? initialUsage;
      if (command.change.op === "remove") {
        const id = command.change.id;
        set({
          ...state,
          usage: {
            ...usage,
            budgets: usage.budgets.filter((each) => each.id !== id),
            counts: usage.counts.filter((each) => each.budgetId !== id),
            rev: usage.rev + 1,
          },
        });
        return Promise.resolve();
      }
      const input = command.change.budget;
      const id = input.routineId ? `routine:${input.routineId}` : `bot:${input.botId}`;
      const budget: Budget = { ...input, id, setAt: now };
      const used = input.routineId
        ? 41_000
        : figure(input.botId, input.period === "daily" ? "today" : "week", params, now - 60_000)
            .tokens.total;
      set({
        ...state,
        usage: {
          ...usage,
          budgets: [...usage.budgets.filter((each) => each.id !== id), budget],
          counts: [
            ...usage.counts.filter((each) => each.budgetId !== id),
            {
              budgetId: id,
              range: rangeFor(input.period, now, input.timeZone),
              used,
              asOf: now - 60_000,
              counting: false,
              partial: false,
              error: null,
            },
          ],
          rev: usage.rev + 1,
        },
      });
      return Promise.resolve();
    }
    default:
      return undefined;
  }
}
