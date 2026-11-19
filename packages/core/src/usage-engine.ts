// Reading usage and keeping warning budgets, on the client's connection
// (docs/design/controls.md, sections 16 and 17). Everything is `operator.read`
// except writing a budget, which is a user preference and needs
// `operator.write` (`users.prefs.set`), as the rail's arrangement does.
//
// What it keeps (`state.usage`): the budgets as the gateway holds them, each
// budget's count for its current period, and the limits providers report.
// Reports for a page are answers, read when asked and never kept.

import { asRecord, type RawRecord } from "./mapping.ts";
import {
  applyBudgetChange,
  ATTRIBUTION_HISTORY_ROWS,
  BudgetError,
  budgetsBytes,
  BUDGETS_PREF_KEY,
  figureOf,
  MAX_BUDGETS_BYTES,
  MAX_REPORT_TASKS,
  MAX_SCANNED_TASKS,
  MAX_SENDER_TASKS,
  parseBudgets,
  parseLimits,
  rangeFor,
  rangeParams,
  runsOfHistory,
  sentRunIds,
  shiftDate,
  stillCounting,
  tasksOf,
  type Budget,
  type BudgetChange,
  type BudgetCount,
  type BudgetPrefs,
  type DateRange,
  type TaskUsage,
  type UsageFigure,
  type UsagePeriod,
  type UsageSources,
  type UsageState,
} from "./usage.ts";

/** What the engine needs from the client. */
export type UsageContext = {
  request(method: string, params: unknown): Promise<unknown>;
  get(): UsageState;
  update(change: (usage: UsageState) => UsageState): void;
  connected(): boolean;
  now(): number;
  log(message: string): void;
};

/** Reports read at once; one more is refused with a reason to show. */
export const MAX_USAGE_REPORTS = 2;
/** Requests one report or count sends at once. */
export const USAGE_REQUESTS_AT_ONCE = 4;
/** How often budgets are counted again while there are any. */
export const COUNT_EVERY_MS = 60_000;
/** After a budgeted bot's run ends: the gateway serves a total up to 30 s old, so a little later. */
export const COUNT_AFTER_RUN_MS = 31_000;
/** How often the providers' limits are read again. */
export const LIMITS_EVERY_MS = 5 * 60_000;
/** Times a budget change is applied again after a conflict. */
export const BUDGET_WRITE_ATTEMPTS = 4;
/** Sessions one `sessions.usage` read asks for. */
const SESSIONS_LIMIT = 200;

/** A page's report: read now, not kept. */
export type UsageReport = {
  botId: string | null;
  period: UsagePeriod;
  range: DateRange;
  /** The bot's, or every bot's, figure: `usage.cost`. */
  figure: UsageFigure;
  /** For every bot: each bot's own figure, read the same way. */
  bots: Array<{ botId: string; figure: UsageFigure | null; error: string | null }> | null;
  /** The largest tasks' shares (`sessions.usage`), and how many more there are. */
  tasks: TaskUsage[] | null;
  tasksOmitted: number;
  sources: UsageSources | null;
  /** Why the tasks or sources could not be read, or null. */
  detailError: string | null;
};

export type UsageReportRequest = {
  botId: string | null;
  period: UsagePeriod;
  timeZone: string;
  /** Tasks and sources as well as the totals. */
  detail: boolean;
  /** The bots there are, for every bot's figure. */
  bots: readonly string[];
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Run each job with at most `limit` running at once, in order. */
async function inTurn<T, R>(
  items: readonly T[],
  limit: number,
  job: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const at = next++;
      out[at] = await job(items[at]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The wall-clock reading of `ms` in `timeZone`, as if it were UTC. */
function wallClock(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const n = (type: string) => Number(parts.find((each) => each.type === type)?.value ?? 0);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
}

/** The moment a calendar date begins in `timeZone`. */
export function startOfDate(date: string, timeZone: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const target = Date.UTC(y, m - 1, d);
  let guess = target;
  for (let i = 0; i < 3; i += 1) guess += target - wallClock(guess, timeZone);
  return guess;
}

/** The moments a range covers. */
export function rangeSpan(range: DateRange): { startMs: number; endMs: number } {
  return {
    startMs: startOfDate(range.startDate, range.timeZone),
    endMs: startOfDate(shiftDate(range.endDate, 1), range.timeZone) - 1,
  };
}

const sameRange = (a: DateRange, b: DateRange) =>
  a.startDate === b.startDate && a.endDate === b.endDate && a.timeZone === b.timeZone;

export class UsageEngine {
  private readonly ctx: UsageContext;
  /** Raised at every hello and close; an answer from an earlier one is dropped. */
  private generation = 0;
  private countTimer: ReturnType<typeof setTimeout> | null = null;
  private countAt = 0;
  private limitsTimer: ReturnType<typeof setTimeout> | null = null;
  private counting: Promise<void> | null = null;
  private countAgain = false;
  private reports = 0;
  /** Budget reads and writes issued, and the newest one shown, to order their answers. */
  private issued = 0;
  private shown = 0;

  constructor(ctx: UsageContext) {
    this.ctx = ctx;
  }

  onHello(): void {
    this.onClose();
    void this.loadBudgets(this.generation);
    void this.readLimits(this.generation);
  }

  onClose(): void {
    this.generation += 1;
    if (this.countTimer) clearTimeout(this.countTimer);
    if (this.limitsTimer) clearTimeout(this.limitsTimer);
    this.countTimer = null;
    this.limitsTimer = null;
    this.countAt = 0;
  }

  /** Another device changed a preference. */
  onPrefsChanged(keys: unknown): void {
    if (Array.isArray(keys) && keys.includes(BUDGETS_PREF_KEY))
      void this.loadBudgets(this.generation);
  }

  /** A run of a bot ended: its budgets are counted again once the gateway's total can include it. */
  onRunEnded(botId: string): void {
    if (this.ctx.get().budgets.some((budget) => budget.botId === botId))
      this.scheduleCount(COUNT_AFTER_RUN_MS);
  }

  // Budgets ------------------------------------------------------------------------------------

  private async readRaw(): Promise<{ status: "ok"; raw: unknown } | { status: "unavailable" }> {
    const result = asRecord(
      await this.ctx.request("users.prefs.get", { keys: [BUDGETS_PREF_KEY] }),
    );
    if (result?.status !== "ok") return { status: "unavailable" };
    const entries = asRecord(result.entries) ?? {};
    return {
      status: "ok",
      raw: Object.hasOwn(entries, BUDGETS_PREF_KEY) ? entries[BUDGETS_PREF_KEY] : null,
    };
  }

  /** Show budgets the gateway holds, unless budgets of a later revision are shown already. */
  private setBudgets(
    status: UsageState["budgetsStatus"],
    prefs: BudgetPrefs | null,
    issued: number,
  ): void {
    const shown = this.ctx.get();
    if (status === "ok" && shown.budgetsStatus === "ok" && prefs) {
      const next = prefs.rev ?? 0;
      if (next < shown.rev || (next === shown.rev && issued < this.shown)) return;
    }
    this.shown = Math.max(this.shown, issued);
    const budgets = prefs?.budgets ?? [];
    this.ctx.update((usage) => ({
      ...usage,
      budgetsStatus: status,
      budgets,
      rev: prefs?.rev ?? 0,
      counts: usage.counts.filter((count) =>
        budgets.some((budget) => budget.id === count.budgetId),
      ),
    }));
    this.scheduleCount(0);
  }

  private async loadBudgets(generation: number): Promise<void> {
    const issued = ++this.issued;
    try {
      const read = await this.readRaw();
      if (generation !== this.generation) return;
      if (read.status !== "ok") return this.setBudgets("unavailable", null, issued);
      this.setBudgets(
        "ok",
        read.raw === null || read.raw === undefined ? { budgets: [] } : parseBudgets(read.raw),
        issued,
      );
    } catch (error) {
      if (generation !== this.generation) return;
      this.ctx.log(`budgets: ${errorText(error)}`);
      if (this.ctx.get().budgetsStatus !== "ok") this.setBudgets("unavailable", null, issued);
    }
  }

  /**
   * Set or remove a budget on the gateway: a compare-and-set on the preference,
   * applied again to a newer value on a conflict, up to `BUDGET_WRITE_ATTEMPTS`.
   * The caller has made sure the connection may write.
   */
  async changeBudget(change: BudgetChange): Promise<void> {
    const generation = this.generation;
    for (let attempt = 0; attempt < BUDGET_WRITE_ATTEMPTS; attempt += 1) {
      const read = await this.readRaw();
      if (read.status !== "ok")
        throw new BudgetError(
          "This gateway keeps no preferences for this connection, so a budget can't be kept.",
        );
      const from =
        read.raw === null || read.raw === undefined ? { budgets: [] } : parseBudgets(read.raw);
      const next = { ...applyBudgetChange(from, change, this.ctx.now()), rev: (from.rev ?? 0) + 1 };
      if (budgetsBytes(next) > MAX_BUDGETS_BYTES)
        throw new BudgetError(
          "The gateway keeps at most 4,096 bytes of budgets, and this one would pass that. Remove a budget first.",
        );
      const issued = ++this.issued;
      const result = asRecord(
        await this.ctx.request("users.prefs.set", {
          entries: { [BUDGETS_PREF_KEY]: next },
          expectedEntries: { [BUDGETS_PREF_KEY]: read.raw ?? null },
        }),
      );
      if (result?.status === "ok") {
        if (generation === this.generation) this.setBudgets("ok", next, issued);
        return;
      }
      if (result?.status !== "conflict")
        throw new BudgetError(
          "This gateway keeps no preferences for this connection, so a budget can't be kept.",
        );
    }
    throw new BudgetError("The budgets kept changing on another device. Try again.");
  }

  // Counting ------------------------------------------------------------------------------------

  private scheduleCount(ms: number): void {
    if (!this.ctx.connected()) return;
    const at = this.ctx.now() + ms;
    if (this.countTimer && this.countAt <= at) return;
    if (this.countTimer) clearTimeout(this.countTimer);
    const generation = this.generation;
    this.countAt = at;
    this.countTimer = setTimeout(() => {
      this.countTimer = null;
      this.countAt = 0;
      if (generation === this.generation) void this.countBudgets(generation);
    }, ms);
  }

  /** Count every budget for its current period, then again in `COUNT_EVERY_MS` while any is kept. */
  async countBudgets(generation = this.generation): Promise<void> {
    if (this.counting) {
      this.countAgain = true;
      return this.counting;
    }
    this.counting = (async () => {
      try {
        do {
          this.countAgain = false;
          const budgets = this.ctx.get().budgets;
          const counts = await inTurn(budgets, USAGE_REQUESTS_AT_ONCE, (budget) =>
            this.count(budget),
          );
          if (generation !== this.generation) return;
          this.ctx.update((usage) => ({
            ...usage,
            counts: counts.filter((count) =>
              usage.budgets.some((budget) => budget.id === count.budgetId),
            ),
          }));
        } while (this.countAgain && generation === this.generation);
      } finally {
        this.counting = null;
      }
      if (generation === this.generation && this.ctx.get().budgets.length > 0)
        this.scheduleCount(COUNT_EVERY_MS);
    })();
    return this.counting;
  }

  /** One budget's count: the figure the Usage page shows for the same bot (or routine) and days. */
  private async count(budget: Budget): Promise<BudgetCount> {
    const range = rangeFor(budget.period, this.ctx.now(), budget.timeZone);
    try {
      if (budget.routineId) {
        const result = await this.ctx.request("sessions.usage", {
          agentId: budget.botId,
          ...rangeParams(range),
          limit: SESSIONS_LIMIT,
        });
        const record = asRecord(result) ?? {};
        const used = tasksOf(result)
          .filter((task) => task.routineId === budget.routineId)
          .reduce((sum, task) => sum + task.total, 0);
        return {
          budgetId: budget.id,
          range,
          used,
          asOf: typeof record.updatedAt === "number" ? record.updatedAt : null,
          counting:
            stillCounting(record.cacheStatus) || tasksOf(result).some((task) => task.computing),
          error: null,
        };
      }
      const figure = figureOf(
        await this.ctx.request("usage.cost", { agentId: budget.botId, ...rangeParams(range) }),
      );
      return {
        budgetId: budget.id,
        range,
        used: figure.tokens.total,
        asOf: figure.asOf,
        counting: figure.counting,
        error: null,
      };
    } catch (error) {
      const kept = this.ctx
        .get()
        .counts.find((each) => each.budgetId === budget.id && sameRange(each.range, range));
      return {
        budgetId: budget.id,
        range,
        used: kept?.used ?? null,
        asOf: kept?.asOf ?? null,
        counting: false,
        error: errorText(error),
      };
    }
  }

  // Provider limits ------------------------------------------------------------------------------

  private async readLimits(generation: number): Promise<void> {
    try {
      const limits = parseLimits(await this.ctx.request("usage.status", {}));
      if (generation !== this.generation) return;
      this.ctx.update((usage) => ({ ...usage, limits }));
    } catch (error) {
      if (generation !== this.generation) return;
      this.ctx.log(`usage.status: ${errorText(error)}`);
      this.ctx.update((usage) => ({ ...usage, limits: { ...usage.limits, status: "error" } }));
    }
    if (generation !== this.generation) return;
    this.limitsTimer = setTimeout(() => void this.readLimits(generation), LIMITS_EVERY_MS);
  }

  /** Read the providers' limits again now. */
  refreshLimits(): Promise<void> {
    if (this.limitsTimer) clearTimeout(this.limitsTimer);
    this.limitsTimer = null;
    return this.readLimits(this.generation);
  }

  // Reports --------------------------------------------------------------------------------------

  /** A page's figures: read now, not kept. At most `MAX_USAGE_REPORTS` at once. */
  async readReport(request: UsageReportRequest): Promise<UsageReport> {
    if (this.reports >= MAX_USAGE_REPORTS)
      throw new Error("Usage is already being read. Try again in a moment.");
    this.reports += 1;
    try {
      return await this.report(request);
    } finally {
      this.reports -= 1;
    }
  }

  private async report(request: UsageReportRequest): Promise<UsageReport> {
    const range = rangeFor(request.period, this.ctx.now(), request.timeZone);
    const params = rangeParams(range);
    const scope: RawRecord = request.botId ? { agentId: request.botId } : { agentScope: "all" };
    const figure = figureOf(await this.ctx.request("usage.cost", { ...scope, ...params }));
    const bots = request.botId
      ? null
      : await inTurn(request.bots, USAGE_REQUESTS_AT_ONCE, async (botId) => {
          try {
            return {
              botId,
              figure: figureOf(await this.ctx.request("usage.cost", { agentId: botId, ...params })),
              error: null,
            };
          } catch (error) {
            return { botId, figure: null, error: errorText(error) };
          }
        });
    const report: UsageReport = {
      botId: request.botId,
      period: request.period,
      range,
      figure,
      bots,
      tasks: null,
      tasksOmitted: 0,
      sources: null,
      detailError: null,
    };
    if (!request.detail) return report;
    try {
      const tasks = tasksOf(
        await this.ctx.request("sessions.usage", { ...scope, ...params, limit: SESSIONS_LIMIT }),
      );
      report.tasks = tasks.slice(0, MAX_REPORT_TASKS);
      report.tasksOmitted = Math.max(0, tasks.length - MAX_REPORT_TASKS);
      report.sources = await this.sources(tasks, figure.tokens.total, range);
    } catch (error) {
      report.detailError = errorText(error);
    }
    return report;
  }

  /**
   * Where the period's tokens came from. A routine's tasks count as Routines.
   * In the other tasks, largest first and at most `MAX_SCANNED_TASKS`, each
   * run is a person's, another bot's (only when the sending task's
   * `sessions_send` result names that run), or not attributed. The rest of the
   * total, whatever the reads could not establish, is Not attributed.
   */
  private async sources(
    tasks: TaskUsage[],
    total: number,
    range: DateRange,
  ): Promise<UsageSources> {
    const { startMs, endMs } = rangeSpan(range);
    const routines = tasks
      .filter((task) => task.routineId)
      .reduce((sum, task) => sum + task.total, 0);
    const others = tasks.filter((task) => !task.routineId);
    const scanned = others.slice(0, MAX_SCANNED_TASKS);
    let partial = others.length > scanned.length || tasks.some((task) => task.computing);
    const histories = await inTurn(scanned, USAGE_REQUESTS_AT_ONCE, async (task) => {
      try {
        const result = asRecord(
          await this.ctx.request("chat.history", {
            sessionKey: task.key,
            limit: ATTRIBUTION_HISTORY_ROWS,
            maxChars: 200,
          }),
        );
        if (result?.hasMore === true) partial = true;
        return { key: task.key, runs: runsOfHistory(result?.messages, startMs, endMs) };
      } catch {
        partial = true;
        return { key: task.key, runs: [] };
      }
    });
    // The sending tasks, read for the runs their sends name.
    const senders = [
      ...new Set(
        histories.flatMap((each) =>
          each.runs.flatMap((run) =>
            run.trigger === "bot" && run.sourceKey ? [run.sourceKey] : [],
          ),
        ),
      ),
    ];
    if (senders.length > MAX_SENDER_TASKS) partial = true;
    const named = new Map<string, Set<string>>();
    await inTurn(senders.slice(0, MAX_SENDER_TASKS), USAGE_REQUESTS_AT_ONCE, async (key) => {
      try {
        const result = asRecord(
          await this.ctx.request("chat.history", {
            sessionKey: key,
            limit: ATTRIBUTION_HISTORY_ROWS,
            maxChars: 200,
            toolResultMaxChars: 4_000,
          }),
        );
        if (result?.hasMore === true) partial = true;
        for (const [recipient, runs] of sentRunIds(result?.messages)) {
          const set = named.get(recipient) ?? new Set<string>();
          for (const run of runs) set.add(run);
          named.set(recipient, set);
        }
      } catch {
        partial = true;
      }
    });
    let people = 0;
    let bots = 0;
    for (const { key, runs } of histories)
      for (const run of runs) {
        if (run.trigger === "person") people += run.tokens;
        else if (run.trigger === "bot" && named.get(key)?.has(run.runId)) bots += run.tokens;
      }
    return {
      people,
      routines,
      bots,
      unattributed: Math.max(0, total - people - bots - routines),
      partial,
    };
  }
}
