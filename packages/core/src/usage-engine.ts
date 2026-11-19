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
  BUDGET_UNCONFIRMED,
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
  routinesOf,
  runsOfHistory,
  sentRunIds,
  stillCounting,
  tasksOf,
  type Budget,
  type BudgetChange,
  type BudgetCount,
  type BudgetPrefs,
  type DateRange,
  type Routine,
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

/**
 * Reports read at once. One more is answered `busy`: the host is only busy,
 * not failing, and the page that asked shows that it waits and asks again
 * while it is shown. Nothing waits here for a page that may have gone.
 */
export const MAX_USAGE_REPORTS = 2;
/** Requests one report or count sends at once. */
export const USAGE_REQUESTS_AT_ONCE = 4;
/** How often budgets are counted again while there are any. */
export const COUNT_EVERY_MS = 60_000;
/** While the gateway says a count is still being counted, how soon it is counted again. */
export const COUNT_COUNTING_MS = 5_000;
/** After a budgeted bot's run ends: the gateway serves a total up to 30 s old, so a little later. */
export const COUNT_AFTER_RUN_MS = 31_000;
/** How often the providers' limits are read again. */
export const LIMITS_EVERY_MS = 5 * 60_000;
/** Times a budget change is applied again after a conflict. */
export const BUDGET_WRITE_ATTEMPTS = 4;
/** Tasks one `sessions.usage` read asks for: the gateway lists at most this many. */
export const SESSIONS_LIMIT = 200;

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
  /**
   * The gateway listed as many tasks as asked (`SESSIONS_LIMIT`), the most
   * recently updated first: the tasks and the count of more cover those it
   * listed, and there may be others.
   */
  tasksCapped: boolean;
  /** The gateway said the tasks' figures are still being counted (`sessions.usage` `cacheStatus`). */
  detailCounting: boolean;
  sources: UsageSources | null;
  /** Why the tasks or sources could not be read, or null. */
  detailError: string | null;
};

/** The answer while the host already reads `MAX_USAGE_REPORTS` reports: ask again later. */
export type UsageBusy = { busy: true };

/** Sources read apart from the total, which can't both be right: neither is shown. */
const SOURCES_DISAGREE =
  "The tasks' records and the gateway's total don't agree yet, so where the tokens came from isn't shown.";

/** A `sessions.usage` reply without its list of tasks. */
const NO_TASK_LIST = "The gateway's answer had no task list.";

/** A routine whose runs share a task: its use can't be told apart from the task's. */
const ROUTINE_NOT_SEPARATE = "Usage for this routine can't be counted separately.";

/** A report ends with the connection it started on: no request of it goes to another gateway. */
const CLOSED = "The connection to the gateway closed while its usage was being read.";

type Ask = (method: string, params: unknown) => Promise<unknown>;

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

/**
 * Run each job with at most `limit` running at once, in order. After the first
 * failure no job starts, and the failure is thrown once the started ones have
 * ended, so nothing is still asking when the caller goes on.
 */
async function inTurn<T, R>(
  items: readonly T[],
  limit: number,
  job: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  // Only the first failure is kept: it is what the caller is told.
  let failure = null as { error: unknown } | null;
  const worker = async () => {
    while (failure === null && next < items.length) {
      const at = next++;
      try {
        out[at] = await job(items[at]!);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure !== null) throw failure.error;
  return out;
}

const sameRange = (a: DateRange, b: DateRange) =>
  a.startDate === b.startDate && a.endDate === b.endDate && a.timeZone === b.timeZone;

export class UsageEngine {
  private readonly ctx: UsageContext;
  /** Raised at every hello and close; an answer from an earlier one is dropped. */
  private generation = 0;
  private countTimer: ReturnType<typeof setTimeout> | null = null;
  private countAt = 0;
  /** The one timer that reads the providers' limits again; only a finished read sets it. */
  private limitsTimer: ReturnType<typeof setTimeout> | null = null;
  /** The read of the limits under way, which a refresh meanwhile joins, and its connection. */
  private limitsRead: { generation: number; done: Promise<void> } | null = null;
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
    // A bootstrap that ends after its socket closed starts nothing: the next hello will.
    if (!this.ctx.connected()) return;
    void this.loadBudgets(this.generation);
    void this.readLimits(this.generation);
  }

  onClose(): void {
    this.generation += 1;
    if (this.countTimer) clearTimeout(this.countTimer);
    if (this.limitsTimer) clearTimeout(this.limitsTimer);
    this.countTimer = null;
    this.limitsTimer = null;
    this.limitsRead = null;
    this.countAt = 0;
    this.countAgain = false;
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

  private async readRaw(
    request: Ask = this.ctx.request,
  ): Promise<{ status: "ok"; raw: unknown } | { status: "unavailable" }> {
    const result = asRecord(await request("users.prefs.get", { keys: [BUDGETS_PREF_KEY] }));
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
  async changeBudget(change: BudgetChange, request: Ask = this.ctx.request): Promise<void> {
    const generation = this.generation;
    const assertSameConnection = () => {
      if (generation !== this.generation)
        throw new BudgetError(`${BUDGET_UNCONFIRMED}: the connection to the gateway closed.`);
    };
    if (change.op === "set" && change.budget.routineId) {
      const { botId, routineId } = change.budget;
      const job = await request("cron.get", { id: routineId });
      assertSameConnection();
      if (!routinesOf({ jobs: [job] }).some((routine) => routine.botId === botId))
        throw new BudgetError(ROUTINE_NOT_SEPARATE);
    }
    for (let attempt = 0; attempt < BUDGET_WRITE_ATTEMPTS; attempt += 1) {
      assertSameConnection();
      const read = await this.readRaw(request);
      assertSameConnection();
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
      let answer: unknown;
      try {
        answer = await request("users.prefs.set", {
          entries: { [BUDGETS_PREF_KEY]: next },
          expectedEntries: { [BUDGETS_PREF_KEY]: read.raw ?? null },
        });
      } catch (error) {
        assertSameConnection();
        // The answer was lost: the gateway may have kept the change. What it holds is read,
        // and shown, before anything is said of the change.
        return this.confirmBudgets(next, errorText(error), change, assertSameConnection, request);
      }
      assertSameConnection();
      const result = asRecord(answer);
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

  /**
   * After a write whose answer was lost: read what the gateway holds and show
   * it. The change stands only if the gateway holds it; otherwise it couldn't
   * be confirmed, said with what was read.
   */
  private async confirmBudgets(
    next: BudgetPrefs,
    lost: string,
    change: BudgetChange,
    assertSameConnection: () => void,
    request: Ask,
  ) {
    const issued = ++this.issued;
    let read: Awaited<ReturnType<UsageEngine["readRaw"]>>;
    assertSameConnection();
    try {
      read = await this.readRaw(request);
    } catch (error) {
      throw new BudgetError(
        `${BUDGET_UNCONFIRMED}: ${lost}. Reading the gateway's budgets again failed too: ${errorText(error)}`,
      );
    }
    assertSameConnection();
    if (read.status !== "ok")
      throw new BudgetError(
        `${BUDGET_UNCONFIRMED}: ${lost}. Reading the gateway's budgets again was unavailable.`,
      );
    const held =
      read.raw === null || read.raw === undefined ? { budgets: [] } : parseBudgets(read.raw);
    if (held) this.setBudgets("ok", held, issued);
    const expected = change.op === "set" ? next.budgets.at(-1) : undefined;
    const id = change.op === "remove" ? change.id : expected?.id;
    const actual = held?.budgets.find((budget) => budget.id === id);
    if (
      held &&
      (change.op === "remove"
        ? actual === undefined
        : expected && actual && JSON.stringify(actual) === JSON.stringify(expected))
    )
      return;
    throw new BudgetError(
      `${BUDGET_UNCONFIRMED}: ${lost}. The read-back did not confirm this change.`,
    );
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
            generation === this.generation ? this.count(budget, generation) : Promise.resolve(null),
          );
          if (generation !== this.generation) return;
          this.ctx.update((usage) => ({
            ...usage,
            counts: counts.filter(
              (count): count is BudgetCount =>
                count !== null && usage.budgets.some((budget) => budget.id === count.budgetId),
            ),
          }));
        } while (this.countAgain && generation === this.generation);
      } finally {
        this.counting = null;
        if (generation !== this.generation && this.countAgain) this.scheduleCount(0);
      }
      if (generation === this.generation && this.ctx.get().budgets.length > 0)
        this.scheduleCount(
          this.ctx.get().counts.some((count) => count.counting)
            ? COUNT_COUNTING_MS
            : COUNT_EVERY_MS,
        );
    })();
    return this.counting;
  }

  /** One budget's count: the figure the Usage page shows for the same bot (or routine) and days. */
  private async count(budget: Budget, generation: number): Promise<BudgetCount> {
    const range = rangeFor(budget.period, this.ctx.now(), budget.timeZone);
    try {
      if (budget.routineId) {
        // The routine may have moved into a shared task since its budget was set.
        const unavailable: BudgetCount = {
          budgetId: budget.id,
          range,
          used: null,
          asOf: null,
          counting: false,
          partial: false,
          error: ROUTINE_NOT_SEPARATE,
        };
        let job: unknown;
        try {
          job = await this.ctx.request("cron.get", { id: budget.routineId });
        } catch {
          return unavailable;
        }
        if (generation !== this.generation) throw new Error(CLOSED);
        if (!routinesOf({ jobs: [job] }).some((routine) => routine.botId === budget.botId))
          return unavailable;
        const result = await this.ctx.request("sessions.usage", {
          agentId: budget.botId,
          ...rangeParams(range),
          limit: SESSIONS_LIMIT,
        });
        const record = asRecord(result) ?? {};
        // A reply without a task list is no empty one: the earlier count stays, marked failed.
        if (!Array.isArray(record.sessions)) throw new Error(NO_TASK_LIST);
        const used = tasksOf(result)
          .filter((task) => task.routineId === budget.routineId)
          .reduce((sum, task) => sum + task.total, 0);
        // The gateway lists at most `limit` tasks (its totals cover them all, but not by
        // routine): a full list may have left some of the routine's tasks out.
        const listed = Array.isArray(record.sessions) ? record.sessions.length : 0;
        return {
          budgetId: budget.id,
          range,
          used,
          asOf: typeof record.updatedAt === "number" ? record.updatedAt : null,
          counting:
            stillCounting(record.cacheStatus) || tasksOf(result).some((task) => task.computing),
          partial: listed >= SESSIONS_LIMIT,
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
        partial: false,
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
        counting: kept?.counting ?? false,
        partial: kept?.partial ?? false,
        error: errorText(error),
      };
    }
  }

  // Provider limits ------------------------------------------------------------------------------

  /**
   * Read the providers' limits, then again in `LIMITS_EVERY_MS`. One read at a
   * time: a read asked for while one is under way on the same connection
   * joins it. The read that finishes sets the one timer; nothing of it
   * outlives its connection.
   */
  private readLimits(generation: number): Promise<void> {
    if (this.limitsRead?.generation === generation) return this.limitsRead.done;
    if (this.limitsTimer) clearTimeout(this.limitsTimer);
    this.limitsTimer = null;
    const read = { generation, done: Promise.resolve() };
    read.done = (async () => {
      try {
        const limits = parseLimits(await this.ctx.request("usage.status", {}));
        if (generation !== this.generation) return;
        this.ctx.update((usage) => ({ ...usage, limits }));
      } catch (error) {
        if (generation !== this.generation) return;
        this.ctx.log(`usage.status: ${errorText(error)}`);
        this.ctx.update((usage) => ({ ...usage, limits: { ...usage.limits, status: "error" } }));
      } finally {
        if (this.limitsRead === read) this.limitsRead = null;
      }
      if (generation !== this.generation) return;
      if (this.limitsTimer) clearTimeout(this.limitsTimer);
      this.limitsTimer = setTimeout(() => {
        this.limitsTimer = null;
        void this.readLimits(generation);
      }, LIMITS_EVERY_MS);
    })();
    this.limitsRead = read;
    return read.done;
  }

  /** Read the providers' limits again now, or join the read under way. */
  refreshLimits(): Promise<void> {
    return this.readLimits(this.generation);
  }

  /** The routines a budget can be set for, read now (`cron.list`, `operator.read`). */
  async listRoutines(): Promise<Routine[]> {
    return routinesOf(await this.ctx.request("cron.list", { limit: 100, includeDisabled: true }));
  }

  // Reports --------------------------------------------------------------------------------------

  /**
   * A page's figures: read now, not kept. At most `MAX_USAGE_REPORTS` at once;
   * one more is answered `busy`. A report belongs to the connection it started
   * on: once that closes, it sends nothing more, uses no answer, and fails.
   */
  async readReport(request: UsageReportRequest): Promise<UsageReport | UsageBusy> {
    if (this.reports >= MAX_USAGE_REPORTS) return { busy: true };
    this.reports += 1;
    const generation = this.generation;
    const ask: Ask = async (method, params) => {
      if (generation !== this.generation) throw new Error(CLOSED);
      const result = await this.ctx.request(method, params);
      if (generation !== this.generation) throw new Error(CLOSED);
      return result;
    };
    try {
      const report = await this.report(request, ask);
      if (generation !== this.generation) throw new Error(CLOSED);
      return report;
    } finally {
      this.reports -= 1;
    }
  }

  private async report(request: UsageReportRequest, ask: Ask): Promise<UsageReport> {
    const range = rangeFor(request.period, this.ctx.now(), request.timeZone);
    const params = rangeParams(range);
    const scope: RawRecord = request.botId ? { agentId: request.botId } : { agentScope: "all" };
    const figure = figureOf(await ask("usage.cost", { ...scope, ...params }));
    const bots = request.botId
      ? null
      : await inTurn(request.bots, USAGE_REQUESTS_AT_ONCE, async (botId) => {
          try {
            return {
              botId,
              figure: figureOf(await ask("usage.cost", { agentId: botId, ...params })),
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
      tasksCapped: false,
      detailCounting: false,
      sources: null,
      detailError: null,
    };
    if (!request.detail) return report;
    try {
      const listed = asRecord(
        await ask("sessions.usage", { ...scope, ...params, limit: SESSIONS_LIMIT }),
      );
      if (!Array.isArray(listed?.sessions)) {
        report.detailError = NO_TASK_LIST;
        return report;
      }
      const listedTotal = asRecord(listed?.totals)?.totalTokens;
      const tasks = tasksOf(listed);
      report.tasks = tasks.slice(0, MAX_REPORT_TASKS);
      report.tasksOmitted = Math.max(0, tasks.length - MAX_REPORT_TASKS);
      report.tasksCapped =
        Array.isArray(listed?.sessions) && listed.sessions.length >= SESSIONS_LIMIT;
      report.detailCounting =
        stillCounting(listed?.cacheStatus) || tasks.some((task) => task.computing);
      if (typeof listedTotal !== "number" || listedTotal !== figure.tokens.total) {
        report.tasks = null;
        report.detailError =
          "The tasks' records and the gateway's total don't agree yet, so the task and source figures aren't shown.";
        return report;
      }
      const counting =
        figure.counting ||
        report.detailCounting ||
        (bots ?? []).some((each) => each.figure?.counting === true);
      const sources = await this.sources(tasks, figure.tokens.total, range, ask);
      if (sources.people + sources.routines + sources.bots > figure.tokens.total)
        // Read at different times, the parts and the total can't both be right: neither is shown.
        report.detailError = SOURCES_DISAGREE;
      else
        report.sources = {
          ...sources,
          // The rest of a total the gateway is still counting is no figure of anything.
          unattributed: counting ? null : sources.unattributed,
          partial: sources.partial || counting || report.tasksCapped,
        };
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
    ask: Ask,
  ): Promise<UsageSources> {
    const routines = tasks
      .filter((task) => task.routineId)
      .reduce((sum, task) => sum + task.total, 0);
    const others = tasks.filter((task) => !task.routineId);
    const scanned = others.slice(0, MAX_SCANNED_TASKS);
    let partial = others.length > scanned.length || tasks.some((task) => task.computing);
    const histories = await inTurn(scanned, USAGE_REQUESTS_AT_ONCE, async (task) => {
      try {
        const result = asRecord(
          await ask("chat.history", {
            sessionKey: task.key,
            limit: ATTRIBUTION_HISTORY_ROWS,
            maxChars: 200,
          }),
        );
        if (result?.hasMore === true) partial = true;
        const runs = runsOfHistory(result?.messages, range);
        // A history whose runs come to more than its task's own figure was read at another
        // moment: none of the sources can be set beside the total.
        if (runs.reduce((sum, run) => sum + run.tokens, 0) > task.total)
          throw new Error(SOURCES_DISAGREE);
        return { key: task.key, runs };
      } catch (error) {
        if (error instanceof Error && error.message === SOURCES_DISAGREE) throw error;
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
          await ask("chat.history", {
            sessionKey: key,
            limit: ATTRIBUTION_HISTORY_ROWS,
            // Not cut to a display length: the send's result names its run in its text.
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
