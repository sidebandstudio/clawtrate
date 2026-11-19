// Routines: the gateway's scheduled jobs (`cron.*`), all read at
// `operator.read` (automation.md sections 3 to 8). The engine keeps one thing,
// the routine list in `ClawtrateState.routines`, from `cron.list` and the
// `cron` event. A routine's runs, a run's conversation and the calendar's past
// runs are read when a screen asks and returned to it, never kept here.
//
// What the gateway returns was read on a development gateway (2026.10.6) and
// is recorded in docs/decisions.md, "Routines: what the gateway returns".

import { cutText } from "./bounds.ts";
import { asRecord, mapHistory, type RawRecord } from "./mapping.ts";
import type { TranscriptItem } from "./types.ts";

/** Routines kept from `cron.list`; past it they are counted in `omitted`. */
export const MAX_ROUTINES = 200;
/** A routine's instruction or reminder text as kept and shown. */
export const MAX_ROUTINE_TEXT_CHARS = 4_096;
/** Runs read for a routine's page, newest first: older runs drop out of the list (F-355). */
export const MAX_ROUTINE_RUNS = 20;
/** Past runs across routines read for the calendar. */
export const MAX_CALENDAR_RUNS = 200;
/** A run's conversation sent to a viewer, in JSON characters; later items are counted, not sent. */
export const MAX_RUN_CONVERSATION_CHARS = 160_000;
/** A run's summary or error as shown. */
export const MAX_ROUTINE_RUN_TEXT_CHARS = 2_048;
/** `cron.list` and `cron.runs` take at most 200 a page (protocol schema). */
const PAGE = 200;
const MAX_PAGES = 4;

export type RoutineSchedule = {
  kind: "cron" | "every" | "at" | "other";
  /** `cron`: the expression as written. */
  expr: string | null;
  /** `cron` and `at`: the IANA zone, or null for the gateway's own (cron) or UTC (at). */
  tz: string | null;
  everyMs: number | null;
  /** `at`: the ISO time as written. */
  at: string | null;
  /** `other`: the gateway's kind (`on-exit`, `stream`, …). */
  name: string | null;
};

export type Routine = {
  id: string;
  botId: string;
  name: string;
  enabled: boolean;
  schedule: RoutineSchedule;
  /** `agentTurn` runs a bot; `systemEvent` posts a reminder in the main conversation. */
  payload: "agentTurn" | "systemEvent" | "other";
  /** The instruction (`payload.message`) or the reminder (`payload.text`), cut to its bound. */
  text: string;
  /** `isolated`: a conversation of its own each run; `main`: the bot's main conversation. */
  target: "isolated" | "main" | "other";
  delivery: "none" | "announce" | "webhook" | "other";
  deliveryChannel: string | null;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: "ok" | "error" | "skipped" | null;
  lastError: string | null;
  /** Set from `started` until `finished` (`state.runningAtMs`). */
  runningAt: number | null;
  deleteAfterRun: boolean;
  /** A condition script or pacing: when it runs is the gateway's to decide. */
  gated: boolean;
  updatedAt: number | null;
};

export type RoutinesState = {
  status: "idle" | "loading" | "loaded" | "error";
  error: string | null;
  /** `cron.status.enabled`: false when the gateway's scheduler is off; null before it is read. */
  schedulerOn: boolean | null;
  routines: Routine[];
  omitted: number;
};

export const initialRoutinesState: RoutinesState = {
  status: "idle",
  error: null,
  schedulerOn: null,
  routines: [],
  omitted: 0,
};

export type RoutineRun = {
  jobId: string;
  runId: string | null;
  runAt: number;
  status: "ok" | "error" | "skipped" | "other";
  completion: "succeeded" | "failed" | "unknown" | null;
  error: string | null;
  summary: string | null;
  durationMs: number | null;
  model: string | null;
  provider: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  /** The run's own session; absent for a run in the main conversation. */
  sessionKey: string | null;
  /** Started with Run now: the gateway gives a forced run the id `manual:<job>:<ms>:<n>`. */
  manual: boolean;
};

/**
 * A run's conversation, as `cron.history` keeps it. `kept` only on positive
 * evidence: the first row is the scheduler's message for this job and this
 * run's session. Anything else is `none`, and the run's summary stands in.
 */
export type RunConversation =
  | {
      status: "kept";
      /** The instruction as recorded with this run, not as the routine reads now. */
      message: string;
      /** What the gateway appended to it for an unattended run. */
      added: string;
      items: TranscriptItem[];
      omitted: number;
    }
  | { status: "none"; reason: "no-session" | "not-kept"; error: string | null };

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const cut = (value: string | null, max: number) => (value === null ? null : cutText(value, max));

function parseSchedule(value: unknown): RoutineSchedule {
  const schedule = asRecord(value) ?? {};
  const kind = str(schedule.kind);
  const base = { expr: null, tz: null, everyMs: null, at: null, name: null };
  if (kind === "cron" && str(schedule.expr))
    return { ...base, kind, expr: str(schedule.expr), tz: str(schedule.tz) };
  if (kind === "every" && num(schedule.everyMs))
    return { ...base, kind, everyMs: num(schedule.everyMs) };
  if (kind === "at" && str(schedule.at))
    return { ...base, kind, at: str(schedule.at), tz: str(schedule.tz) };
  return { ...base, kind: "other", name: kind ?? "unknown" };
}

/** A `cron.list` job as a routine; null for a check-in job, which is a bot's check-ins, not a routine. */
export function parseRoutine(value: unknown): Routine | null {
  const job = asRecord(value);
  const id = str(job?.id);
  if (!job || !id) return null;
  const payload = asRecord(job.payload) ?? {};
  const payloadKind = str(payload.kind);
  if (payloadKind === "heartbeat") return null;
  const state = asRecord(job.state) ?? {};
  const delivery = asRecord(job.delivery);
  const mode = str(delivery?.mode);
  const last = str(state.lastRunStatus) ?? str(state.lastStatus);
  const target = str(job.sessionTarget);
  return {
    id,
    botId: str(job.agentId) ?? str(job.effectiveAgentId) ?? "main",
    name: str(job.name) ?? "Routine",
    enabled: job.enabled !== false,
    schedule: parseSchedule(job.schedule),
    payload: payloadKind === "agentTurn" || payloadKind === "systemEvent" ? payloadKind : "other",
    text: cutText(
      str(payload.message) ?? str(payload.text) ?? str(payload.command) ?? "",
      MAX_ROUTINE_TEXT_CHARS,
    ),
    target: target === "isolated" || target === "main" ? target : "other",
    // A job without delivery announces: the gateway's default (`mode: "announce"`, observed).
    delivery:
      mode === null
        ? "announce"
        : mode === "none" || mode === "announce" || mode === "webhook"
          ? mode
          : "other",
    deliveryChannel: str(delivery?.channel),
    nextRunAt: num(state.nextRunAtMs),
    lastRunAt: num(state.lastRunAtMs),
    lastStatus: last === "ok" || last === "error" || last === "skipped" ? last : null,
    lastError: cut(str(state.lastError), MAX_ROUTINE_RUN_TEXT_CHARS),
    runningAt: num(state.runningAtMs),
    deleteAfterRun: job.deleteAfterRun === true,
    gated: asRecord(job.trigger) !== null || asRecord(job.pacing) !== null,
    updatedAt: num(job.updatedAtMs),
  };
}

export function parseRun(value: unknown): RoutineRun | null {
  const entry = asRecord(value);
  const jobId = str(entry?.jobId);
  const runAt = num(entry?.runAtMs) ?? num(entry?.ts);
  if (!entry || !jobId || runAt === null) return null;
  const status = str(entry.status);
  const completion = str(entry.completionStatus);
  const usage = asRecord(entry.usage) ?? {};
  const runId = str(entry.runId);
  return {
    jobId,
    runId,
    runAt,
    status: status === "ok" || status === "error" || status === "skipped" ? status : "other",
    completion:
      completion === "succeeded" || completion === "failed" || completion === "unknown"
        ? completion
        : null,
    error: cut(str(entry.error), MAX_ROUTINE_RUN_TEXT_CHARS),
    summary: cut(str(entry.summary), MAX_ROUTINE_RUN_TEXT_CHARS),
    durationMs: num(entry.durationMs),
    model: str(entry.model),
    provider: str(entry.provider),
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    totalTokens: num(usage.total_tokens),
    sessionKey: str(entry.sessionKey),
    manual: runId?.startsWith("manual:") === true,
  };
}

/** Finished runs, newest first, at most `max`. */
export function parseRuns(result: unknown, max: number): RoutineRun[] {
  return arr(asRecord(result)?.entries)
    .map(parseRun)
    .filter((run): run is RoutineRun => run !== null)
    .sort((a, b) => b.runAt - a.runAt)
    .slice(0, max);
}

// The gateway appends the time and its instructions for unattended runs after
// the job's own text, starting with this line (observed on 2026.10.6).
const ADDED_FROM = "\nCurrent time: ";

/** `cron.history` for one run, read as a conversation only on positive evidence. */
export function parseRunConversation(
  result: unknown,
  jobId: string,
  sessionKey: string,
): RunConversation {
  const messages = arr(asRecord(result)?.messages);
  const first = asRecord(messages[0]);
  const provenance = asRecord(first?.provenance);
  const content = str(first?.content);
  if (
    !first ||
    content === null ||
    provenance?.sourceTool !== "cron" ||
    provenance.jobId !== jobId ||
    provenance.sourceSessionKey !== sessionKey
  )
    return { status: "none", reason: "not-kept", error: null };
  const at = content.lastIndexOf(ADDED_FROM);
  const items: TranscriptItem[] = [];
  let size = 0;
  let omitted = 0;
  for (const item of mapHistory(messages.slice(1))) {
    const each = JSON.stringify(item).length;
    if (omitted > 0 || size + each > MAX_RUN_CONVERSATION_CHARS) omitted += 1;
    else {
      items.push(item);
      size += each;
    }
  }
  return {
    status: "kept",
    message: cutText(at < 0 ? content : content.slice(0, at), MAX_ROUTINE_TEXT_CHARS),
    added: cutText(at < 0 ? "" : content.slice(at + 1), MAX_ROUTINE_TEXT_CHARS),
    items,
    omitted,
  };
}

/** One `cron` event applied to the list; the same list when it changes nothing. */
export function applyCronEvent(routines: Routine[], payload: RawRecord): Routine[] {
  const jobId = str(payload.jobId);
  const action = str(payload.action);
  if (!jobId) return routines;
  if (action === "removed") return routines.filter((each) => each.id !== jobId);
  const at = routines.findIndex((each) => each.id === jobId);
  const fromJob = parseRoutine(payload.job);
  if (asRecord(payload.job) && !fromJob) return routines;
  let next = fromJob ?? (at >= 0 ? routines[at]! : null);
  if (!next) return routines;
  // The events carry the job as it is; `started` and `finished` also say so outright.
  if (action === "started") next = { ...next, runningAt: num(payload.runAtMs) ?? next.runningAt };
  if (action === "finished") next = { ...next, runningAt: null };
  if (at < 0) return routines.length < MAX_ROUTINES ? [...routines, next] : routines;
  return routines.map((each, index) => (index === at ? next : each));
}

export type RoutinesContext = {
  request(method: string, params: unknown): Promise<unknown>;
  get(): RoutinesState;
  update(change: (routines: RoutinesState) => RoutinesState): void;
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class RoutinesEngine {
  /** Each load's number: an answer to an older one is dropped. */
  private loadSeq = 0;
  /** An event arrived while a list was being read: read it again once that one lands. */
  private stale = false;

  private readonly ctx: RoutinesContext;

  constructor(ctx: RoutinesContext) {
    this.ctx = ctx;
  }

  async load(): Promise<void> {
    const seq = ++this.loadSeq;
    this.stale = false;
    this.ctx.update((state) => ({ ...state, status: "loading" }));
    try {
      const status = asRecord(await this.ctx.request("cron.status", {}));
      const routines: Routine[] = [];
      let omitted = 0;
      let offset = 0;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = asRecord(
          await this.ctx.request("cron.list", { includeDisabled: true, limit: PAGE, offset }),
        );
        for (const job of arr(result?.jobs)) {
          const routine = parseRoutine(job);
          if (!routine) continue;
          if (routines.length < MAX_ROUTINES) routines.push(routine);
          else omitted += 1;
        }
        const nextOffset = num(result?.nextOffset);
        if (result?.hasMore !== true || nextOffset === null) break;
        offset = nextOffset;
      }
      if (seq !== this.loadSeq) return;
      this.ctx.update(() => ({
        status: "loaded",
        error: null,
        schedulerOn: typeof status?.enabled === "boolean" ? status.enabled : null,
        routines,
        omitted,
      }));
      if (this.stale) void this.load();
    } catch (error) {
      if (seq !== this.loadSeq) return;
      this.ctx.update((state) => ({ ...state, status: "error", error: errorText(error) }));
    }
  }

  onEvent(payload: unknown): void {
    const record = asRecord(payload);
    if (!record) return;
    if (this.ctx.get().status === "loading") this.stale = true;
    this.ctx.update((state) => {
      const routines = applyCronEvent(state.routines, record);
      return routines === state.routines ? state : { ...state, routines };
    });
  }

  /** A dropped connection's answers no longer count. */
  onClose(): void {
    this.loadSeq += 1;
  }

  reset(): void {
    this.loadSeq += 1;
    this.ctx.update(() => initialRoutinesState);
  }

  /** A routine's runs, newest first, at most `MAX_ROUTINE_RUNS`. */
  async runs(id: string): Promise<RoutineRun[]> {
    return parseRuns(
      await this.ctx.request("cron.runs", { id, limit: MAX_ROUTINE_RUNS }),
      MAX_ROUTINE_RUNS,
    );
  }

  /** The latest runs across routines, for the calendar's past days. */
  async calendarRuns(): Promise<RoutineRun[]> {
    return parseRuns(
      await this.ctx.request("cron.runs", { scope: "all", limit: MAX_CALENDAR_RUNS }),
      MAX_CALENDAR_RUNS,
    );
  }

  /**
   * One run's conversation. A run with no session of its own (a reminder in
   * the main conversation) has none to read; a run whose conversation the
   * gateway refuses or no longer keeps is `not-kept`.
   */
  async conversation(
    id: string,
    runId: string,
    sessionKey: string | null,
  ): Promise<RunConversation> {
    if (!sessionKey) return { status: "none", reason: "no-session", error: null };
    try {
      return parseRunConversation(
        await this.ctx.request("cron.history", { id, runId }),
        id,
        sessionKey,
      );
    } catch (error) {
      return {
        status: "none",
        reason: "not-kept",
        error: cutText(errorText(error), MAX_ROUTINE_RUN_TEXT_CHARS),
      };
    }
  }
}
