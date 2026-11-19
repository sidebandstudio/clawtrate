// Usage and warning budgets (docs/design/controls.md, sections 16 and 17): the
// gateway's own figures, read as they are, and the budgets a person keeps with
// the gateway. Pure: nothing here talks to the gateway (`usage-engine.ts` does).
//
// Every figure is the gateway's: `usage.cost` for a bot's or every bot's
// totals and the estimated cost, `sessions.usage` for each task's share, the
// task histories (`chat.history`) for which runs another bot's send or a
// person's message started, and `usage.status` for the limits providers
// report. Nothing is computed beyond adding the gateway's own numbers: a cost
// is the gateway's estimate from its configured prices, never Clawtrate's.
//
// A budget is a warning, everywhere. It is a number of tokens a bot or a
// routine may use in a day or a week, counted from the same records and the
// same period as the figures shown beside it. Nothing here stops a run.

import { utf8Length } from "./encoding.ts";
import { asRecord, type RawRecord } from "./mapping.ts";

/** Budgets are kept as one user preference, like the rail's arrangement (`users.prefs`). */
export const BUDGETS_PREF_KEY = "clawtrate.budgets";
/** The most budgets kept: one per bot (`MAX_BOTS`) is 32, and the preference holds 4,096 bytes. */
export const MAX_BUDGETS = 16;
/** The smallest budget, in tokens (Clawtrate's choice; the form says so). */
export const MIN_BUDGET_TOKENS = 1_000;
/** The largest budget accepted, in tokens. */
export const MAX_BUDGET_TOKENS = 1_000_000_000_000;
/** The share of a budget at which Clawtrate warns, in percent (F-396). */
export const BUDGET_WARN_PERCENT = 80;
/** The share of a provider's reported window at which Clawtrate notes it (F-236, Clawtrate's choice). */
export const LIMIT_NOTE_PERCENT = 90;
/** The longest IANA time zone name kept. */
export const MAX_TIME_ZONE_CHARS = 64;
/** The longest id kept for a bot or a routine in a budget. */
export const MAX_BUDGET_ID_CHARS = 128;
/** The longest routine name kept with its budget, for showing it. */
export const MAX_ROUTINE_NAME_CHARS = 80;
/** The most the gateway keeps in one preference (`user-preferences` validation). */
export const MAX_BUDGETS_BYTES = 4_096;
/** Providers and windows kept from `usage.status`. */
export const MAX_LIMIT_PROVIDERS = 16;
export const MAX_LIMIT_WINDOWS = 8;
export const MAX_LIMIT_TEXT_CHARS = 120;
/** Tasks a report lists by name; the rest are counted. */
export const MAX_REPORT_TASKS = 8;
/** Task histories read to attribute one bot's runs; the rest stay Not attributed. */
export const MAX_SCANNED_TASKS = 32;
/** Sending tasks read to confirm which runs a send's result names. */
export const MAX_SENDER_TASKS = 8;
/** Rows of each history read for attribution (`chat.history` limit). */
export const ATTRIBUTION_HISTORY_ROWS = 200;

export type UsagePeriod = "today" | "week" | "month";
export type BudgetPeriod = "daily" | "weekly";

/** A span of whole days in one time zone, as the gateway's `mode: "specific"` takes it. */
export type DateRange = { startDate: string; endDate: string; timeZone: string };

export type UsageTokens = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** The gateway's own total: input, output and cache together. A budget counts this. */
  total: number;
};

/**
 * The cost as the gateway reports it: an estimate in US dollars from its
 * configured prices. `partial` when some usage records have no price,
 * `unavailable` when none of what was used has one: never a zero then.
 */
export type UsageCost =
  | { status: "estimate"; usd: number }
  | { status: "partial"; usd: number; unpriced: number }
  | { status: "unavailable"; unpriced: number };

/** One figure as read: tokens, cost, the gateway's time for it, and whether it is still counting. */
export type UsageFigure = {
  tokens: UsageTokens;
  cost: UsageCost;
  /** The gateway's `updatedAt` for this figure; it may serve a figure up to 30 s old. */
  asOf: number | null;
  /** The gateway said some of its records are still being read (`cacheStatus`). */
  counting: boolean;
};

// Periods -------------------------------------------------------------------------------------

/** A time zone the platform knows, or null. */
export function validTimeZone(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TIME_ZONE_CHARS)
    return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The calendar date `ms` falls on in `timeZone`, as YYYY-MM-DD. */
export function dateIn(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const part = (type: string) => parts.find((each) => each.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** A calendar date moved by whole days. */
export function shiftDate(date: string, days: number): string {
  const match = DATE.exec(date);
  if (!match) throw new Error(`Not a date: ${date}`);
  const at = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return at.toISOString().slice(0, 10);
}

/** The day of the week of a calendar date: 1 for Monday to 7 for Sunday. */
export function isoWeekday(date: string): number {
  const match = DATE.exec(date);
  if (!match) throw new Error(`Not a date: ${date}`);
  const day = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  ).getUTCDay();
  return day === 0 ? 7 : day;
}

/**
 * The days a period covers at `now` in `timeZone`. Today and a Daily budget:
 * today. This week and a Weekly budget: Monday to today. 30 days: the last 30
 * days, today included. A week starts on Monday at 00:00 in that time zone.
 */
export function rangeFor(
  period: UsagePeriod | BudgetPeriod,
  now: number,
  timeZone: string,
): DateRange {
  const today = dateIn(now, timeZone);
  switch (period) {
    case "today":
    case "daily":
      return { startDate: today, endDate: today, timeZone };
    case "week":
    case "weekly":
      return { startDate: shiftDate(today, 1 - isoWeekday(today)), endDate: today, timeZone };
    case "month":
      return { startDate: shiftDate(today, -29), endDate: today, timeZone };
  }
}

/** The parameters the gateway's usage methods take for a range. */
export function rangeParams(range: DateRange): RawRecord {
  return {
    startDate: range.startDate,
    endDate: range.endDate,
    mode: "specific",
    timeZone: range.timeZone,
  };
}

// The gateway's figures -----------------------------------------------------------------------

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/** Tokens from one of the gateway's totals records (`usage.cost`, `sessions.usage`). */
export function tokensOf(value: unknown): UsageTokens {
  const record = asRecord(value) ?? {};
  const input = count(record.input);
  const output = count(record.output);
  const cacheRead = count(record.cacheRead);
  const cacheWrite = count(record.cacheWrite);
  const reported = record.totalTokens;
  const total =
    typeof reported === "number" && Number.isFinite(reported) && reported >= 0
      ? reported
      : input + output + cacheRead + cacheWrite;
  return { input, output, cacheRead, cacheWrite, total };
}

/** The cost a totals record carries, as the gateway gives it. */
export function costOf(value: unknown): UsageCost {
  const record = asRecord(value) ?? {};
  const usd = count(record.totalCost);
  const unpriced = Math.round(count(record.missingCostEntries));
  const priced =
    usd > 0 ||
    count(record.inputCost) +
      count(record.outputCost) +
      count(record.cacheReadCost) +
      count(record.cacheWriteCost) >
      0;
  if (unpriced === 0) return { status: "estimate", usd };
  // Records without a price and nothing priced: there is no estimate, not a zero one.
  if (!priced) return { status: "unavailable", unpriced };
  return { status: "partial", usd, unpriced };
}

/** Whether the gateway said its figure is still being counted. */
export function stillCounting(cacheStatus: unknown): boolean {
  const status = asRecord(cacheStatus);
  if (!status) return false;
  return (
    (typeof status.status === "string" && status.status !== "fresh") ||
    count(status.pendingFiles) > 0 ||
    count(status.staleFiles) > 0
  );
}

/** A `usage.cost` answer as one figure. */
export function figureOf(result: unknown): UsageFigure {
  const record = asRecord(result) ?? {};
  return {
    tokens: tokensOf(record.totals),
    cost: costOf(record.totals),
    asOf: typeof record.updatedAt === "number" ? record.updatedAt : null,
    counting: stillCounting(record.cacheStatus),
  };
}

/** One task's share, from a `sessions.usage` row. */
export type TaskUsage = {
  key: string;
  label: string | null;
  total: number;
  /** A routine's task (`agent:<bot>:cron:<routine id>`): the routine's id. */
  routineId: string | null;
  /** The gateway is still counting this task (`usage: null` with `computing: true`). */
  computing: boolean;
};

const CRON_KEY = /^agent:[^:]+:cron:([^:]+)/;

/** The routine whose task this is, from the key the gateway gives a routine's task. */
export function routineOfKey(key: string): string | null {
  return CRON_KEY.exec(key)?.[1] ?? null;
}

/** Each task's share in a `sessions.usage` answer, largest first, tasks with no use left out. */
export function tasksOf(result: unknown): TaskUsage[] {
  const sessions = asRecord(result)?.sessions;
  if (!Array.isArray(sessions)) return [];
  const out: TaskUsage[] = [];
  for (const each of sessions) {
    const row = asRecord(each);
    if (!row || typeof row.key !== "string") continue;
    const usage = asRecord(row.usage);
    const computing = !usage && row.computing === true;
    const total = usage ? tokensOf(usage).total : 0;
    if (total === 0 && !computing) continue;
    out.push({
      key: row.key,
      label: typeof row.label === "string" ? row.label : null,
      total,
      routineId: routineOfKey(row.key),
      computing,
    });
  }
  return out.sort((a, b) => b.total - a.total);
}

// Where a bot's runs came from ----------------------------------------------------------------

export type RunTrigger = "person" | "bot" | "system" | "unknown";

/** One run's tokens in a period, and what started it, as the task's history records it. */
export type RunUse = {
  runId: string;
  tokens: number;
  trigger: RunTrigger;
  /** For a run another bot's message started: the sending task, as the gateway marks it. */
  sourceKey: string | null;
};

/**
 * The runs in one task's history and their tokens within `[startMs, endMs]`.
 * A run's tokens are the sum of its model answers' `usage` (each assistant row
 * names its run, `__openclaw.runId`). What started it is the row the gateway
 * keyed `<run id>:user`: a person's message, a message another bot's send
 * delivered (`provenance.kind: "inter_session"` from `sessions_send`), or a turn
 * the gateway wrote itself. A run with no such row in the page is `unknown`.
 */
export function runsOfHistory(messages: unknown, startMs: number, endMs: number): RunUse[] {
  if (!Array.isArray(messages)) return [];
  const runs = new Map<string, RunUse>();
  const triggers = new Map<string, { trigger: RunTrigger; sourceKey: string | null }>();
  for (const each of messages) {
    const row = asRecord(each);
    if (!row) continue;
    const meta = asRecord(row.__openclaw) ?? {};
    const key = typeof row.idempotencyKey === "string" ? row.idempotencyKey : meta.idempotencyKey;
    if (typeof key === "string" && key.endsWith(":user")) {
      const provenance = asRecord(row.provenance);
      const runId = key.slice(0, -":user".length);
      if (provenance?.kind === "inter_session" && provenance.sourceTool === "sessions_send")
        triggers.set(runId, {
          trigger: "bot",
          sourceKey:
            typeof provenance.sourceSessionKey === "string" ? provenance.sourceSessionKey : null,
        });
      else if (provenance) triggers.set(runId, { trigger: "system", sourceKey: null });
      else if (row.role === "user") triggers.set(runId, { trigger: "person", sourceKey: null });
    }
    if (row.role !== "assistant" || typeof meta.runId !== "string" || !asRecord(row.usage))
      continue;
    const at = typeof row.timestamp === "number" ? row.timestamp : null;
    if (at === null || at < startMs || at > endMs) continue;
    const use = runs.get(meta.runId) ?? {
      runId: meta.runId,
      tokens: 0,
      trigger: "unknown",
      sourceKey: null,
    };
    use.tokens += tokensOf(row.usage).total;
    runs.set(meta.runId, use);
  }
  for (const use of runs.values()) {
    const found = triggers.get(use.runId);
    if (found) Object.assign(use, found);
  }
  return [...runs.values()];
}

/**
 * The runs a sending task's `sessions_send` results name, by the recipient task.
 * A send whose result names no run (queued, or refused) names nothing.
 */
export function sentRunIds(messages: unknown): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (!Array.isArray(messages)) return out;
  for (const each of messages) {
    const row = asRecord(each);
    if (
      !row ||
      row.role !== "toolResult" ||
      row.toolName !== "sessions_send" ||
      row.isError === true
    )
      continue;
    const details = asRecord(row.details) ?? {};
    let result: RawRecord = details;
    if (typeof details.runId !== "string") {
      const text = Array.isArray(row.content)
        ? row.content
            .map((block) =>
              typeof asRecord(block)?.text === "string" ? (asRecord(block)!.text as string) : "",
            )
            .join("")
        : typeof row.content === "string"
          ? row.content
          : "";
      try {
        result = asRecord(JSON.parse(text)) ?? {};
      } catch {
        continue;
      }
    }
    const runId = result.runId;
    const key = typeof result.sessionKey === "string" ? result.sessionKey : details.sessionKey;
    if (typeof runId !== "string" || typeof key !== "string") continue;
    if (result.status === "forbidden" || result.status === "error") continue;
    const set = out.get(key) ?? new Set<string>();
    set.add(runId);
    out.set(key, set);
  }
  return out;
}

/**
 * A bot's usage by where it came from. Each part is a sum of the gateway's own
 * numbers; what is not established is Not attributed, never charged to one
 * message. `partial` says some tasks were not read, so more of the total may
 * belong to a named part than it shows.
 */
export type UsageSources = {
  /** Runs a person's message started. */
  people: number;
  /** Tasks that are a routine's (`…:cron:…`). */
  routines: number;
  /** Runs a send's result names, in turns the gateway marks `inter_session`. */
  bots: number;
  /** The rest of the total. */
  unattributed: number;
  partial: boolean;
};

// Routines ------------------------------------------------------------------------------------

/** A routine a budget can be set for: one that runs in tasks of its own. */
export type Routine = { id: string; name: string; botId: string };
/** Routines listed for the budget form. */
export const MAX_ROUTINES = 64;

/**
 * The routines in a `cron.list` answer that run in tasks of their own
 * (`agent:<bot>:cron:<id>`), so their usage can be counted apart. A job that
 * runs in a bot's main task, such as the gateway's heartbeat, is left out.
 */
export function routinesOf(result: unknown): Routine[] {
  const jobs = asRecord(result)?.jobs;
  const out: Routine[] = [];
  for (const each of Array.isArray(jobs) ? jobs : []) {
    const job = asRecord(each);
    if (!job || typeof job.id !== "string" || !PLAIN_ID.test(job.id)) continue;
    if (job.sessionTarget === "main" || asRecord(job.payload)?.kind === "heartbeat") continue;
    const botId = [job.agentId, job.effectiveAgentId].find(
      (value): value is string => typeof value === "string" && PLAIN_ID.test(value),
    );
    if (!botId) continue;
    const name =
      short(job.displayName, MAX_ROUTINE_NAME_CHARS) ??
      short(job.name, MAX_ROUTINE_NAME_CHARS) ??
      job.id;
    out.push({ id: job.id, name, botId });
    if (out.length >= MAX_ROUTINES) break;
  }
  return out;
}

// Provider limits -----------------------------------------------------------------------------

export type LimitWindow = {
  label: string;
  usedPercent: number;
  /** When the provider says the window resets, as the gateway reports it. */
  resetAt: number | null;
};

export type ProviderLimit = {
  provider: string;
  displayName: string;
  windows: LimitWindow[];
  /** The provider's own error, as the gateway reports it ("Timeout", "Auth failed"). */
  error: string | null;
};

export type ProviderLimits = {
  status: "unknown" | "ok" | "error";
  /** The gateway's time for these figures. */
  updatedAt: number | null;
  providers: ProviderLimit[];
  /** The gateway is reading the providers again; these may be older. */
  refreshing: boolean;
};

const short = (value: unknown, max = MAX_LIMIT_TEXT_CHARS): string | null =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

function resetTime(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0)
    return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string") {
    const at = Date.parse(value);
    return Number.isFinite(at) ? at : null;
  }
  return null;
}

/** A `usage.status` answer, bounded. A window is kept only with a percentage the provider gave. */
export function parseLimits(result: unknown): ProviderLimits {
  const record = asRecord(result) ?? {};
  const providers: ProviderLimit[] = [];
  for (const each of Array.isArray(record.providers) ? record.providers : []) {
    const entry = asRecord(each);
    const provider = short(entry?.provider, MAX_BUDGET_ID_CHARS);
    if (!entry || !provider) continue;
    const windows: LimitWindow[] = [];
    for (const raw of Array.isArray(entry.windows) ? entry.windows : []) {
      const window = asRecord(raw);
      const used = window?.usedPercent;
      if (!window || typeof used !== "number" || !Number.isFinite(used)) continue;
      windows.push({
        label: short(window.label) ?? "Limit",
        usedPercent: Math.max(0, Math.min(100, used)),
        resetAt: resetTime(window.resetAt),
      });
      if (windows.length >= MAX_LIMIT_WINDOWS) break;
    }
    providers.push({
      provider,
      displayName: short(entry.displayName) ?? provider,
      windows,
      error: short(entry.error),
    });
    if (providers.length >= MAX_LIMIT_PROVIDERS) break;
  }
  return {
    status: "ok",
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : null,
    providers,
    refreshing: record.refreshing === true,
  };
}

// Budgets -------------------------------------------------------------------------------------

/** A warning budget for a bot, or for one of its routines. Kept with the gateway. */
export type Budget = {
  /** `bot:<bot id>` or `routine:<routine id>`: one budget per bot or routine. */
  id: string;
  botId: string;
  routineId: string | null;
  /** The routine's name when the budget was set, to show while routines are linked by id. */
  routineName: string | null;
  period: BudgetPeriod;
  tokens: number;
  /** The time zone its days are counted in: the person's, when they set it. */
  timeZone: string;
  setAt: number;
};

export type BudgetPrefs = {
  budgets: Budget[];
  /** Raised by every write under the compare-and-set, as the rail's arrangement does. */
  rev?: number;
};

/** One budget's count for its current period: the same `usage.cost` figure the Usage page shows. */
export type BudgetCount = {
  budgetId: string;
  range: DateRange;
  used: number | null;
  asOf: number | null;
  counting: boolean;
  /** Why it could not be counted, or null. */
  error: string | null;
};

export type UsageState = {
  /**
   * `unknown` until read; `ok` when the gateway keeps this person's preferences;
   * `unavailable` for a connection with no durable user, or when the read failed.
   */
  budgetsStatus: "unknown" | "ok" | "unavailable";
  budgets: Budget[];
  rev: number;
  counts: BudgetCount[];
  limits: ProviderLimits;
};

export const initialUsage: UsageState = {
  budgetsStatus: "unknown",
  budgets: [],
  rev: 0,
  counts: [],
  limits: { status: "unknown", updatedAt: null, providers: [], refreshing: false },
};

const BUDGET_ID = /^[\w.:-]{1,140}$/;
const PLAIN_ID = /^[\w.-]{1,128}$/;

/** The budget id for a bot or one of its routines. */
export function budgetId(target: { routineId: string | null; botId: string }): string {
  return target.routineId ? `routine:${target.routineId}` : `bot:${target.botId}`;
}

/** A whole number of tokens a budget may be, or the reason it may not, in the form's words. */
export function budgetTokens(value: string | number): number | string {
  const n = typeof value === "number" ? value : Number(String(value).replace(/[,\s]/g, ""));
  if (!Number.isSafeInteger(n) || n < MIN_BUDGET_TOKENS || n > MAX_BUDGET_TOKENS)
    return "Enter a whole number of 1,000 or more.";
  return n;
}

function parseBudget(value: unknown): Budget | null {
  const record = asRecord(value);
  if (!record) return null;
  const botId =
    typeof record.botId === "string" && PLAIN_ID.test(record.botId) ? record.botId : null;
  const routineId =
    typeof record.routineId === "string" && PLAIN_ID.test(record.routineId)
      ? record.routineId
      : null;
  const period = record.period === "daily" || record.period === "weekly" ? record.period : null;
  const tokens = typeof record.tokens === "number" ? budgetTokens(record.tokens) : null;
  const timeZone = validTimeZone(record.timeZone);
  if (!botId || !period || typeof tokens !== "number" || !timeZone) return null;
  const id = budgetId({ botId, routineId });
  if (!BUDGET_ID.test(id)) return null;
  return {
    id,
    botId,
    routineId,
    routineName: routineId ? short(record.routineName, MAX_ROUTINE_NAME_CHARS) : null,
    period,
    tokens,
    timeZone,
    setAt: typeof record.setAt === "number" && Number.isFinite(record.setAt) ? record.setAt : 0,
  };
}

/** What the gateway holds, read as budgets: unknown fields dropped, one per bot or routine, bounded. */
export function parseBudgets(value: unknown): BudgetPrefs {
  const record = asRecord(value) ?? {};
  const budgets: Budget[] = [];
  for (const each of Array.isArray(record.budgets) ? record.budgets : []) {
    const budget = parseBudget(each);
    if (!budget || budgets.some((other) => other.id === budget.id)) continue;
    budgets.push(budget);
    if (budgets.length >= MAX_BUDGETS) break;
  }
  const rev =
    typeof record.rev === "number" && Number.isSafeInteger(record.rev) && record.rev > 0
      ? record.rev
      : 0;
  return { budgets, ...(rev > 0 ? { rev } : {}) };
}

/** A budget as a person sets it: for a bot, or a routine of the bot. */
export type BudgetInput = {
  botId: string;
  routineId: string | null;
  routineName: string | null;
  period: BudgetPeriod;
  tokens: number;
  timeZone: string;
};

export type BudgetChange = { op: "set"; budget: BudgetInput } | { op: "remove"; id: string };

/** A change to the budgets that cannot be kept, said in plain words. */
export class BudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetError";
  }
}

/** Apply one change. Pure; the result is within every bound or the change is refused. */
export function applyBudgetChange(
  prefs: BudgetPrefs,
  change: BudgetChange,
  now: number,
): BudgetPrefs {
  if (change.op === "remove")
    return { ...prefs, budgets: prefs.budgets.filter((each) => each.id !== change.id) };
  const budget = parseBudget({ ...change.budget, setAt: now });
  if (!budget) {
    const tokens = budgetTokens(change.budget.tokens);
    throw new BudgetError(typeof tokens === "string" ? tokens : "This budget can't be kept.");
  }
  const others = prefs.budgets.filter((each) => each.id !== budget.id);
  if (others.length >= MAX_BUDGETS)
    throw new BudgetError(`At most ${MAX_BUDGETS} budgets can be kept. Remove one first.`);
  return { ...prefs, budgets: [...others, budget] };
}

/** The bytes the gateway counts for the budgets. */
export function budgetsBytes(prefs: BudgetPrefs): number {
  return utf8Length(JSON.stringify(prefs));
}

/** A budget's share used, in whole percent, or null while it has no count. */
export function budgetPercent(budget: Budget, used: number | null): number | null {
  if (used === null) return null;
  return Math.floor((used / budget.tokens) * 100);
}

/** The count of a budget for the period it is in now; a count for an earlier period is not it. */
export function currentCount(
  usage: UsageState | undefined,
  budget: Budget,
  now: number,
): BudgetCount | null {
  const found = usage?.counts.find((each) => each.budgetId === budget.id);
  if (!found) return null;
  const range = rangeFor(budget.period, now, budget.timeZone);
  return found.range.startDate === range.startDate &&
    found.range.endDate === range.endDate &&
    found.range.timeZone === range.timeZone
    ? found
    : null;
}
