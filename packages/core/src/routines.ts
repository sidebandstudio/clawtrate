// Routines: the gateway's scheduled jobs (`cron.*`), all read at
// `operator.read` (automation.md sections 3 to 8). The routine list in
// `ClawtrateState.routines` comes from `cron.list` and the
// `cron` event. A routine's runs, a run's conversation and the calendar's past
// runs are read when a screen asks and returned to it, never kept here.
//
// Changing them (sections 9 and 10) needs `operator.admin`: every write checks
// it here, just before it is sent, whatever asked for it. An update checks the
// acknowledged revision and writes only what the person changed from the original.
//
// What the gateway returns was read on a development gateway (2026.10.6) and
// is recorded in docs/decisions.md, "Routines: what the gateway returns" and
// "Routines: changing them".

import {
  GatewayProtocolRequestError,
  GatewayProtocolRequestTimeoutError,
} from "@openclaw/gateway-client/browser";
import { cutText } from "./bounds.ts";
import { asRecord, mapHistory, type RawRecord } from "./mapping.ts";
import type { TranscriptItem } from "./types.ts";

/** Routines kept from `cron.list`; past it they are counted in `omitted`. */
export const MAX_ROUTINES = 200;
export const MAX_ROUTINE_UPDATES = 128;
/** A routine's instruction or reminder text as kept and shown. */
export const MAX_ROUTINE_TEXT_CHARS = 4_096;
/** Runs read for a routine's page, newest first: older runs drop out of the list (F-355). */
export const MAX_ROUTINE_RUNS = 20;
/** Past runs across routines read for the calendar's dates; past it the read says it is partial. */
export const MAX_CALENDAR_RUNS = 1_000;
/**
 * The scheduler's message recorded with a run, as sent to a viewer: the
 * instruction (up to `MAX_ROUTINE_TEXT_CHARS`) plus the gateway's own footer,
 * with room to spare. Past it the message is cut and the run says so.
 */
export const MAX_RUN_MESSAGE_CHARS = 16_384;
/** A run's conversation sent to a viewer, in JSON characters; later items are counted, not sent. */
export const MAX_RUN_CONVERSATION_CHARS = 160_000;
/** A run's summary or error as shown. */
export const MAX_ROUTINE_RUN_TEXT_CHARS = 2_048;
/** `cron.list` and `cron.runs` take at most 200 a page (protocol schema). */
const PAGE = 200;
/** Pages of a run's conversation read back to its first message (`cron.history`, newest page first). */
const MAX_HISTORY_PAGES = 5;
/** While a routine is marked running, the list is read again this often: a `finished` can be dropped. */
export const RUNNING_RECHECK_MS = 60_000;
/** After a failed read, the next one. */
export const RETRY_MS = 30_000;
/** Reads in a row an event may invalidate before the newest is published anyway. */
const MAX_REREADS = 3;

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
  /** `text` was cut: the editor must not write it back. */
  textCut: boolean;
  /** The creation form can reproduce the job's payload, conditions and delivery. */
  canRecreate?: boolean;
  /** `isolated`: a conversation of its own each run; `main`: the bot's main conversation. */
  target: "isolated" | "main" | "other";
  /** The bound conversation of a current or named target, as the gateway recorded it. */
  sharedSessionKey?: string;
  delivery: "none" | "announce" | "webhook" | "other";
  deliveryChannel: string | null;
  nextRunAt: number | null;
  lastRunAt: number | null;
  /** When the last run ended: its start plus its duration, when the gateway gives both. */
  lastEndedAt?: number | null;
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
  /** Routines past `MAX_ROUTINES` the gateway listed (heartbeat jobs among those not read); the list says so. */
  omitted: number;
  /**
   * The last routine the `removed` event took away: `ranOnce` only when the
   * gateway's `finished` came just before with a snapshot of the one-shot
   * consumed (succeeded, no next run left), as the gateway sends them when a
   * one-shot removes itself.
   */
  removed: { id: string; ranOnce: boolean; runAt: number | null } | null;
};

export const initialRoutinesState: RoutinesState = {
  status: "idle",
  error: null,
  schedulerOn: null,
  routines: [],
  omitted: 0,
  removed: null,
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
  /** The session the gateway used for this run, when it reports one. */
  sessionKey: string | null;
  /** Started with Run now: the gateway gives a forced run the id `manual:<job>:<ms>:<n>`. */
  manual: boolean;
};

/**
 * A run's conversation, as `cron.history` keeps it. `kept` only on positive
 * evidence: the first row is the scheduler's message for this job and this
 * run's session. `none` when the gateway returned none (or refused, as it
 * does for a run it has no transcript of); `too-long` when its first message
 * is further back than Clawtrate reads. A failed read is thrown, not `none`.
 */
export type RunConversation =
  | {
      status: "kept";
      /** The scheduler's message as recorded with this run, never the routine's current instruction. */
      message: string;
      /** The message was longer than `MAX_RUN_MESSAGE_CHARS` and is cut. */
      messageCut: boolean;
      items: TranscriptItem[];
      omitted: number;
    }
  | { status: "none"; reason: "no-session" | "not-kept" | "too-long"; error: string | null };

/** Which run: its id, else its start (`cron.history` takes either), and its session if it had one. */
export type RunSelector = { runId: string | null; runAt: number; sessionKey: string | null };

/** One bot's routines as `cron.list` filtered to it gives them. */
export type BotRoutines = { routines: Routine[]; omitted: number };

/** The calendar's recorded runs for its dates, and whether older ones in them were left unread. */
export type CalendarRuns = { runs: RoutineRun[]; partial: boolean };

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
  const fullText =
    str(payload.message) ?? str(payload.text) ?? str(payload.script) ?? str(payload.command) ?? "";
  const schedule = parseSchedule(job.schedule);
  const gated = asRecord(job.trigger) !== null || asRecord(job.pacing) !== null;
  const toolsAllow = arr(payload.toolsAllow);
  const text = cutText(fullText, MAX_ROUTINE_TEXT_CHARS);
  const sharedSessionKey =
    target === "current"
      ? str(job.sessionKey)
      : target?.startsWith("session:")
        ? str(target.slice(8))
        : null;
  return {
    id,
    botId: str(job.agentId) ?? str(job.effectiveAgentId) ?? "main",
    name: str(job.name) ?? "Routine",
    enabled: job.enabled !== false,
    schedule,
    payload: payloadKind === "agentTurn" || payloadKind === "systemEvent" ? payloadKind : "other",
    text,
    textCut: text.length < fullText.length,
    canRecreate:
      payloadKind === "agentTurn" &&
      text.length === fullText.length &&
      target === "isolated" &&
      !gated &&
      wireSchedule(schedule) !== null &&
      Object.keys(payload).every(
        (key) => key === "kind" || key === "message" || key === "toolsAllow",
      ) &&
      // The gateway supplies this default when the form leaves toolsAllow out.
      (payload.toolsAllow === undefined || (toolsAllow.length === 1 && toolsAllow[0] === "*")) &&
      (mode === null || mode === "none" || mode === "announce") &&
      Object.keys(delivery ?? {}).every((key) => key === "mode") &&
      job.sessionKey == null &&
      job.failureAlert == null,
    target: target === "isolated" || target === "main" ? target : "other",
    ...(sharedSessionKey ? { sharedSessionKey } : {}),
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
    lastEndedAt:
      num(state.lastRunAtMs) !== null && num(state.lastDurationMs) !== null
        ? num(state.lastRunAtMs)! + num(state.lastDurationMs)!
        : null,
    lastStatus: last === "ok" || last === "error" || last === "skipped" ? last : null,
    lastError: cut(str(state.lastError), MAX_ROUTINE_RUN_TEXT_CHARS),
    runningAt: num(state.runningAtMs),
    deleteAfterRun: job.deleteAfterRun === true,
    gated,
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

/**
 * Runs in the gateway's order, at most `max`. The gateway orders them by when
 * they finished, newest first, and pages in that order; that order is the
 * contract (docs/decisions.md), so a run that started earlier but finished
 * later stays above one that started after it.
 */
export function parseRuns(result: unknown, max: number): RoutineRun[] {
  return arr(asRecord(result)?.entries)
    .map(parseRun)
    .filter((run): run is RoutineRun => run !== null)
    .slice(0, max);
}

/** `cron.history`'s messages for one run, oldest first, read as a conversation only on positive evidence. */
export function parseRunConversation(
  messages: unknown[],
  jobId: string,
  sessionKey: string,
): RunConversation {
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
    message: cutText(content, MAX_RUN_MESSAGE_CHARS),
    messageCut: content.length > MAX_RUN_MESSAGE_CHARS,
    items,
    omitted,
  };
}

/**
 * One `cron` event applied to the list; the same list when it changes nothing.
 * `started` and `finished` carry their run's `runAtMs`, so one that arrives
 * after a newer run's is told apart: an older finish never clears a newer
 * start or replaces a newer finish, and an older start never replaces the
 * last finished run or a newer start. A `finished` only updates a routine
 * already listed: the gateway also finishes a run whose job was removed while
 * it ran, with the removed job's snapshot.
 */
export function applyCronEvent(routines: Routine[], payload: RawRecord): Routine[] {
  const jobId = str(payload.jobId);
  const action = str(payload.action);
  if (!jobId) return routines;
  if (action === "removed") return routines.filter((each) => each.id !== jobId);
  const at = routines.findIndex((each) => each.id === jobId);
  const current = at >= 0 ? routines[at]! : null;
  const fromJob = parseRoutine(payload.job);
  if (asRecord(payload.job) && !fromJob) return routines;
  let next = fromJob ?? current;
  if (!next) return routines;
  const runAt = num(payload.runAtMs);
  if (action === "started") {
    if (runAt !== null && current?.lastRunAt != null && runAt <= current.lastRunAt) return routines;
    if (runAt !== null && current?.runningAt != null && runAt < current.runningAt) return routines;
    next = { ...next, runningAt: runAt ?? next.runningAt };
  }
  if (action === "finished") {
    if (!current) return routines;
    if (runAt !== null && current.runningAt !== null && runAt < current.runningAt) return routines;
    if (runAt !== null && current.lastRunAt !== null && runAt < current.lastRunAt) return routines;
    next = { ...next, runningAt: null };
  }
  if (at < 0) return routines.length < MAX_ROUTINES ? [...routines, next] : routines;
  return routines.map((each, index) => (index === at ? next : each));
}

export type RoutinesContext = {
  request(method: string, params: unknown): Promise<unknown>;
  get(): RoutinesState;
  update(change: (routines: RoutinesState) => RoutinesState): void;
  connected(): boolean;
  /** The connection holds `operator.admin`. */
  admin(): boolean;
};

/** What the editor writes, and what it compares with a fresh read before writing. */
export type RoutineFields = {
  name: string;
  /** The instruction (`agentTurn`) or the reminder (`systemEvent`); never written for another payload. */
  text: string;
  /** Written as `cron`, `every` or `at` (an ISO time with its offset); `other` is never written. */
  schedule: RoutineSchedule;
  target: Routine["target"];
  delivery: Routine["delivery"];
};

export type NewRoutine = RoutineFields & { botId: string };
export type RoutineRevision = RoutineFields & { updatedAt: number | null };

/** How a write ended. Only `saved` says the gateway shows the change. */
export type RoutineWrite =
  | { status: "saved"; routine: Routine }
  /** Nothing was sent: this connection has no admin access, or no connection. */
  | { status: "not-sent"; reason: "admin" | "offline" }
  | { status: "refused"; error: string }
  /** Sent, with no answer that settles it: it may or may not have landed. */
  | { status: "unknown"; error: string }
  /** It was changed elsewhere since the editor opened; nothing was written. */
  | { status: "conflict"; current: Routine }
  | { status: "deleted" };

export type RoutineRunNow =
  | { status: "started"; runId: string | null }
  | { status: "already-running" }
  | { status: "not-sent"; reason: "admin" | "offline" }
  | { status: "refused"; error: string }
  | { status: "unknown"; error: string };

export type RoutineRemove =
  | { status: "removed" }
  | { status: "not-sent"; reason: "admin" | "offline" }
  | { status: "refused"; error: string }
  | { status: "unknown"; error: string };

/** The gateway's inbound hooks (`hooks.*`, admin config): global, not a routine's. */
export type GatewayHooks = { enabled: boolean; path: string };

/** Every routine Clawtrate creates names its draft, so a create in doubt is found exactly, never guessed. */
export const DECLARATION_PREFIX = "clawtrate:";
/** A draft's key: what the editor makes once per new routine and reuses for every try of it. */
export const MAX_DRAFT_KEY_CHARS = 64;

const instant = (at: string | null) => (at === null ? null : Date.parse(at));

export function sameSchedule(a: RoutineSchedule, b: RoutineSchedule): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "at") return instant(a.at) === instant(b.at);
  return a.expr === b.expr && a.tz === b.tz && a.everyMs === b.everyMs && a.name === b.name;
}

export function fieldsOf(routine: Routine): RoutineFields {
  return {
    name: routine.name,
    text: routine.text,
    schedule: routine.schedule,
    target: routine.target,
    delivery: routine.delivery,
  };
}

/** The fields of `b` that differ from `a`. */
export function changedFields(a: RoutineFields, b: RoutineFields): Array<keyof RoutineFields> {
  return (["name", "text", "schedule", "target", "delivery"] as const).filter((key) =>
    key === "schedule" ? !sameSchedule(a.schedule, b.schedule) : a[key] !== b[key],
  );
}

// An `at` time names its offset: the gateway drops a `tz` beside it and reads the
// wall time as UTC (observed on 2026.10.6).
const OFFSET = /(Z|[+-]\d\d:\d\d)$/u;

function wireSchedule(schedule: RoutineSchedule): RawRecord | null {
  if (schedule.kind === "cron" && schedule.expr)
    return { kind: "cron", expr: schedule.expr, ...(schedule.tz ? { tz: schedule.tz } : {}) };
  if (schedule.kind === "every" && schedule.everyMs)
    return { kind: "every", everyMs: schedule.everyMs };
  if (
    schedule.kind === "at" &&
    schedule.at &&
    OFFSET.test(schedule.at) &&
    !Number.isNaN(instant(schedule.at))
  )
    return { kind: "at", at: schedule.at };
  return null;
}

/** `cron.update`'s patch: only what changed, and only what Clawtrate writes. */
export function patchOf(
  original: RoutineFields,
  edit: RoutineFields,
  payload: Routine["payload"],
): RawRecord {
  const patch: RawRecord = {};
  for (const key of changedFields(original, edit)) {
    if (key === "name") patch.name = edit.name;
    if (key === "text" && payload === "agentTurn")
      patch.payload = { kind: "agentTurn", message: edit.text };
    if (key === "text" && payload === "systemEvent")
      patch.payload = { kind: "systemEvent", text: edit.text };
    const schedule = key === "schedule" ? wireSchedule(edit.schedule) : null;
    if (schedule) patch.schedule = schedule;
    if (key === "delivery" && (edit.delivery === "none" || edit.delivery === "announce"))
      patch.delivery = { mode: edit.delivery };
  }
  return patch;
}

/** The gateway answered and refused: nothing was applied. */
function refusal(error: unknown): string | null {
  return error instanceof GatewayProtocolRequestError ? error.message : null;
}

const notFound = (error: string) => /\bnot found\b/iu.test(error);

/** A request that never left this client. */
function unsent(error: unknown): boolean {
  return (
    (error instanceof GatewayProtocolRequestTimeoutError && !error.requestSent) ||
    (error instanceof Error && error.name === "NotSentError")
  );
}

/** The job in an answer: `cron.add` with a declaration key wraps it (`{created, job}`). */
const answeredJob = (result: unknown) => {
  const record = asRecord(result);
  return parseRoutine(asRecord(record?.job) ?? record);
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A refusal another try would get again: a scope this connection lacks, a
 * method this gateway lacks, or no connection to ask on (the next connect reads).
 */
const permanent = (error: unknown) =>
  asRecord(asRecord(error)?.details)?.code === "MISSING_SCOPE" ||
  errorText(error).startsWith("unknown method") ||
  (error instanceof Error && error.name === "NotSentError");

/**
 * A `finished` whose snapshot is a one-shot the gateway deletes: run to a
 * success with `deleteAfterRun` and no next run left (OpenClaw 2026.10.6,
 * `applyJobResult`). A forced run before its time keeps its next run.
 */
function consumedOneShot(record: RawRecord): boolean {
  const job = asRecord(record.job);
  const state = asRecord(job?.state);
  return (
    job?.deleteAfterRun === true &&
    str(record.completionStatus) === "succeeded" &&
    num(state?.nextRunAtMs) === null &&
    num(record.nextRunAtMs) === null
  );
}

export class RoutinesEngine {
  /** Each load's number: an answer to an older one is dropped. */
  private loadSeq = 0;
  /** An event arrived while the list was being read: that read may be older than it. */
  private invalidated = false;
  private recheck: ReturnType<typeof setTimeout> | null = null;
  /**
   * The last `finished` of a listed routine; `consumed` when its snapshot shows
   * a one-shot the gateway is about to delete. A `removed` of the same job
   * right after it is then the gateway's own. The id is the listed routine's,
   * already bounded.
   */
  private lastFinished: { jobId: string; consumed: boolean; runAt: number | null } | null = null;
  /** The list read in flight: a load asked for meanwhile joins it and has it read again. */
  private loading: Promise<void> | null = null;
  /** The connection a write was sent on: its answer is applied only while this holds. */
  private epoch = 0;
  private readonly updates = new Set<{ id: string; removed: boolean }>();

  private readonly ctx: RoutinesContext;

  constructor(ctx: RoutinesContext) {
    this.ctx = ctx;
  }

  /**
   * Read the list again. A read an event overtook is not published, since it
   * may be older than the event: it is read again. While a routine is marked
   * running, and after a failed read, the list is read again on a timer, so a
   * dropped `finished` or a failed refresh does not leave a mark behind.
   */
  load(): Promise<void> {
    if (this.loading) {
      this.invalidated = true;
      return this.loading;
    }
    const loading = this.loadOnce().finally(() => {
      if (this.loading === loading) this.loading = null;
    });
    this.loading = loading;
    return loading;
  }

  private async loadOnce(): Promise<void> {
    const seq = ++this.loadSeq;
    this.clearRecheck();
    if (this.ctx.get().status !== "loaded")
      this.ctx.update((state) => ({ ...state, status: "loading" }));
    for (let attempt = 1; ; attempt += 1) {
      this.invalidated = false;
      let read: Awaited<ReturnType<RoutinesEngine["read"]>>;
      try {
        read = await this.read();
      } catch (error) {
        if (seq !== this.loadSeq) return;
        this.ctx.update((state) => ({ ...state, status: "error", error: errorText(error) }));
        if (!permanent(error)) this.schedule(RETRY_MS);
        return;
      }
      if (seq !== this.loadSeq) return;
      if (this.invalidated && attempt < MAX_REREADS) continue;
      if (this.invalidated && this.ctx.get().status === "loaded") {
        // Overtaken every time: keep what the events made and look again soon.
        this.schedule(RETRY_MS);
        return;
      }
      this.ctx.update((state) => ({ ...state, status: "loaded", error: null, ...read }));
      this.scheduleIfRunning();
      return;
    }
  }

  private async read(): Promise<Pick<RoutinesState, "schedulerOn" | "routines" | "omitted">> {
    const status = asRecord(await this.ctx.request("cron.status", {}));
    return {
      schedulerOn: typeof status?.enabled === "boolean" ? status.enabled : null,
      ...(await this.list({})),
    };
  }

  /** `cron.list` up to `MAX_ROUTINES` routines, the rest counted. */
  private async list(filter: { agentId?: string }): Promise<BotRoutines> {
    const routines: Routine[] = [];
    let omitted = 0;
    let offset = 0;
    for (;;) {
      const result = asRecord(
        await this.ctx.request("cron.list", {
          includeDisabled: true,
          limit: PAGE,
          offset,
          ...filter,
        }),
      );
      const jobs = arr(result?.jobs);
      for (const job of jobs) {
        const routine = parseRoutine(job);
        if (!routine) continue;
        if (routines.length < MAX_ROUTINES) routines.push(routine);
        else omitted += 1;
      }
      const nextOffset = num(result?.nextOffset);
      if (result?.hasMore !== true || nextOffset === null || nextOffset <= offset) break;
      // Past the cap, the rest is counted from the gateway's total, not read.
      const total = num(result?.total);
      if (routines.length >= MAX_ROUTINES && total !== null) {
        omitted += Math.max(0, total - nextOffset);
        break;
      }
      offset = nextOffset;
    }
    return { routines, omitted };
  }

  /**
   * One bot's routines, read when the kept list is missing some of the
   * gateway's (`omitted`) and that bot is chosen; returned, not kept.
   */
  botRoutines(botId: string): Promise<BotRoutines> {
    return this.list({ agentId: botId });
  }

  private schedule(ms: number): void {
    this.clearRecheck();
    this.recheck = setTimeout(() => {
      this.recheck = null;
      void this.load();
    }, ms);
  }

  private scheduleIfRunning(): void {
    if (this.recheck === null && this.ctx.get().routines.some((each) => each.runningAt !== null))
      this.schedule(RUNNING_RECHECK_MS);
  }

  private clearRecheck(): void {
    if (this.recheck !== null) clearTimeout(this.recheck);
    this.recheck = null;
  }

  onEvent(payload: unknown): void {
    const record = asRecord(payload);
    if (!record) return;
    this.invalidated = true;
    const jobId = str(record.jobId);
    const action = str(record.action);
    if (action === "removed")
      for (const update of this.updates) if (update.id === jobId) update.removed = true;
    const before = this.ctx.get();
    const kept = before.routines.find((each) => each.id === jobId);
    const routines = applyCronEvent(before.routines, record);
    const finished = this.lastFinished;
    this.lastFinished =
      action === "finished" && kept
        ? { jobId: kept.id, consumed: consumedOneShot(record), runAt: num(record.runAtMs) }
        : null;
    const removed =
      action === "removed" && jobId
        ? {
            id: jobId,
            ranOnce: finished?.jobId === jobId && finished.consumed,
            runAt: finished?.jobId === jobId ? finished.runAt : null,
          }
        : before.removed;
    // A retained routine gone while others were left out: read again to fill its place.
    // A finish for a routine not listed (added while away, or never seen): the gateway says.
    const refill =
      (action === "removed" && kept !== undefined && before.omitted > 0) ||
      (action === "finished" &&
        kept === undefined &&
        before.omitted === 0 &&
        parseRoutine(record.job) !== null);
    if (routines !== before.routines || removed !== before.removed)
      this.ctx.update((state) => ({ ...state, routines, removed }));
    if (refill) void this.load();
    else this.scheduleIfRunning();
  }

  /** A dropped connection's answers no longer count. */
  onClose(): void {
    this.loadSeq += 1;
    this.loading = null;
    this.clearRecheck();
    this.lastFinished = null;
    this.epoch += 1;
  }

  reset(): void {
    this.onClose();
    this.ctx.update(() => initialRoutinesState);
  }

  /** Why a write cannot be sent now, or null: checked just before each request. */
  private blocked(): "admin" | "offline" | null {
    if (!this.ctx.connected()) return "offline";
    return this.ctx.admin() ? null : "admin";
  }

  /** The gateway's own view of a routine, put in the list while the connection that read it holds. */
  private keep(routine: Routine, epoch: number): void {
    if (epoch !== this.epoch) return;
    this.ctx.update((state) => {
      const at = state.routines.findIndex((each) => each.id === routine.id);
      if (at < 0 && state.routines.length >= MAX_ROUTINES) return state;
      const routines =
        at < 0
          ? [...state.routines, routine]
          : state.routines.map((each, index) => (index === at ? routine : each));
      return { ...state, routines };
    });
  }

  /** What became of a write the gateway answered, or did not. */
  private failed(error: unknown): RoutineWrite {
    if (unsent(error)) return { status: "not-sent", reason: "offline" };
    const refused = refusal(error);
    if (refused !== null)
      return notFound(refused) ? { status: "deleted" } : { status: "refused", error: refused };
    return { status: "unknown", error: errorText(error) };
  }

  /**
   * A new routine for a bot (`cron.add`). `key` is the draft's: the gateway
   * treats a second add with the same declaration key as the same routine, so
   * trying again after an answer that never came cannot make two.
   */
  async create(input: NewRoutine, key: string): Promise<RoutineWrite> {
    const blocked = this.blocked();
    if (blocked) return { status: "not-sent", reason: blocked };
    if (input.target !== "isolated")
      return { status: "refused", error: "New routines run in an isolated conversation." };
    const schedule = wireSchedule(input.schedule);
    if (!schedule) return { status: "refused", error: "Clawtrate can't write this schedule." };
    const epoch = this.epoch;
    try {
      const routine = answeredJob(
        await this.ctx.request("cron.add", {
          name: input.name,
          agentId: input.botId,
          schedule,
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: input.text },
          delivery: { mode: input.delivery === "announce" ? "announce" : "none" },
          declarationKey: `${DECLARATION_PREFIX}${key}`,
        }),
      );
      if (!routine || changedFields(input, fieldsOf(routine)).length > 0)
        return {
          status: "unknown",
          error: "The gateway answered, but doesn't show this routine as written.",
        };
      this.keep(routine, epoch);
      return { status: "saved", routine };
    } catch (error) {
      const failed = this.failed(error);
      return failed.status === "deleted" ? { status: "refused", error: errorText(error) } : failed;
    }
  }

  /** One routine as the gateway has it now, or null when it has none by that id. Reads only. */
  async readOne(id: string): Promise<Routine | null> {
    try {
      return parseRoutine(await this.ctx.request("cron.get", { id }));
    } catch (error) {
      const refused = refusal(error);
      if (refused !== null && notFound(refused)) return null;
      throw error;
    }
  }

  /** The routine a draft made, if the gateway lists it: found by the draft's own key, nothing else. */
  async findCreated(key: string): Promise<Routine | null> {
    let offset = 0;
    for (;;) {
      const result = asRecord(
        await this.ctx.request("cron.list", { includeDisabled: true, limit: PAGE, offset }),
      );
      const job = arr(result?.jobs).find(
        (each) => asRecord(each)?.declarationKey === `${DECLARATION_PREFIX}${key}`,
      );
      if (job) return parseRoutine(job);
      const nextOffset = num(result?.nextOffset);
      if (result?.hasMore !== true || nextOffset === null || nextOffset <= offset) return null;
      offset = nextOffset;
    }
  }

  /** Check the acknowledged revision, then patch the fields changed from the original. */
  async update(
    id: string,
    original: RoutineFields,
    edit: RoutineFields,
    expected: RoutineRevision,
  ): Promise<RoutineWrite> {
    let blocked = this.blocked();
    if (blocked) return { status: "not-sent", reason: blocked };
    if (this.updates.size >= MAX_ROUTINE_UPDATES)
      return { status: "refused", error: "Too many routine changes are in flight." };
    const epoch = this.epoch;
    const pending = { id, removed: false };
    this.updates.add(pending);
    try {
      let current: Routine | null;
      try {
        current = await this.readOne(id);
      } catch (error) {
        if (pending.removed) return { status: "deleted" };
        const failed = this.failed(error);
        // Only a read failed: nothing was written.
        return failed.status === "unknown" ? { status: "not-sent", reason: "offline" } : failed;
      }
      if (!current || pending.removed) return { status: "deleted" };
      if (
        current.updatedAt !== expected.updatedAt ||
        changedFields(expected, fieldsOf(current)).length > 0
      )
        return { status: "conflict", current };
      const fields = {
        ...edit,
        target: original.target,
        text: current.textCut ? original.text : edit.text,
      };
      const patch = patchOf(original, fields, current.payload);
      if (Object.keys(patch).length === 0) return { status: "saved", routine: current };
      blocked = this.blocked();
      if (blocked) return { status: "not-sent", reason: blocked };
      if (epoch !== this.epoch) return { status: "not-sent", reason: "offline" };
      try {
        const routine = answeredJob(await this.ctx.request("cron.update", { id, patch }));
        if (pending.removed) return { status: "deleted" };
        const wanted = changedFields(original, fields);
        if (
          !routine ||
          changedFields(fields, fieldsOf(routine)).some((key) => wanted.includes(key))
        )
          return { status: "unknown", error: "The gateway answered, but doesn't show the change." };
        this.keep(routine, epoch);
        return { status: "saved", routine };
      } catch (error) {
        return pending.removed ? { status: "deleted" } : this.failed(error);
      }
    } finally {
      this.updates.delete(pending);
    }
  }

  /** Pause or resume (`cron.update {enabled}`). */
  async setEnabled(id: string, enabled: boolean): Promise<RoutineWrite> {
    const blocked = this.blocked();
    if (blocked) return { status: "not-sent", reason: blocked };
    const epoch = this.epoch;
    try {
      const routine = answeredJob(
        await this.ctx.request("cron.update", { id, patch: { enabled } }),
      );
      if (!routine || routine.enabled !== enabled)
        return { status: "unknown", error: "The gateway answered, but doesn't show the change." };
      this.keep(routine, epoch);
      return { status: "saved", routine };
    } catch (error) {
      return this.failed(error);
    }
  }

  /** Run it once now (`cron.run {mode: "force"}`), paused or not; it stays as it was. */
  async runNow(id: string): Promise<RoutineRunNow> {
    const blocked = this.blocked();
    if (blocked) return { status: "not-sent", reason: blocked };
    try {
      const result = asRecord(await this.ctx.request("cron.run", { id, mode: "force" }));
      if (result?.ok === true && result.enqueued === true)
        return { status: "started", runId: str(result.runId) };
      if (result?.reason === "already-running") return { status: "already-running" };
      return {
        status: "refused",
        error: str(result?.reason) ?? "The gateway didn't start a run.",
      };
    } catch (error) {
      const failed = this.failed(error);
      return failed.status === "deleted"
        ? { status: "refused", error: errorText(error) }
        : (failed as RoutineRunNow);
    }
  }

  /** Delete it (`cron.remove`). One the gateway no longer has counts as removed. */
  async remove(id: string): Promise<RoutineRemove> {
    const blocked = this.blocked();
    if (blocked) return { status: "not-sent", reason: blocked };
    const epoch = this.epoch;
    const drop = () => {
      if (epoch === this.epoch)
        this.ctx.update((state) => ({
          ...state,
          routines: state.routines.filter((each) => each.id !== id),
        }));
      return { status: "removed" } as const;
    };
    try {
      const result = asRecord(await this.ctx.request("cron.remove", { id }));
      if (result?.removed === false)
        return { status: "unknown", error: "The gateway answered, but didn't remove it." };
      return drop();
    } catch (error) {
      const failed = this.failed(error);
      if (failed.status === "deleted") return drop();
      return failed as RoutineRemove;
    }
  }

  /** The gateway's inbound hooks, read from its config (admin); null below admin. */
  async hooks(): Promise<GatewayHooks | null> {
    if (this.blocked()) return null;
    const hooks = asRecord(
      asRecord(asRecord(await this.ctx.request("config.get", {}))?.config)?.hooks,
    );
    return { enabled: hooks?.enabled === true, path: str(hooks?.path) ?? "/hooks" };
  }

  /** A routine's runs in the gateway's order (newest finished first), at most `MAX_ROUTINE_RUNS`. */
  async runs(id: string): Promise<RoutineRun[]> {
    return parseRuns(
      await this.ctx.request("cron.runs", { id, limit: MAX_ROUTINE_RUNS }),
      MAX_ROUTINE_RUNS,
    );
  }

  /**
   * Every routine's runs that started from `from` to `to`, for the calendar.
   * The gateway pages all runs newest finished first and has no date filter,
   * so pages are read until one reaches before `from`, at most
   * `MAX_CALENDAR_RUNS` entries; `partial` when that stopped it first.
   */
  async calendarRuns(from: number, to: number): Promise<CalendarRuns> {
    const runs: RoutineRun[] = [];
    let offset = 0;
    while (offset < MAX_CALENDAR_RUNS) {
      const result = asRecord(
        await this.ctx.request("cron.runs", {
          scope: "all",
          limit: Math.min(PAGE, MAX_CALENDAR_RUNS - offset),
          offset,
        }),
      );
      const entries = arr(result?.entries);
      for (const run of parseRuns(result, PAGE))
        if (run.runAt >= from && run.runAt < to) runs.push(run);
      const last = asRecord(entries.at(-1));
      // Finished before `from`, so every later page's runs started before it too.
      const reachedStart = (num(last?.ts) ?? num(last?.runAtMs) ?? from) < from;
      const nextOffset = num(result?.nextOffset);
      if (reachedStart || result?.hasMore !== true || nextOffset === null || nextOffset <= offset)
        return { runs, partial: false };
      offset = nextOffset;
    }
    return { runs, partial: true };
  }

  /**
   * One run's conversation. A run with no session of its own (a reminder in
   * the main conversation) has none to read. The gateway returns the newest
   * page first, so older pages are read back to the first message, the
   * scheduler's. Its refusal for a run it has no transcript of is `none`;
   * any other failure is thrown.
   */
  async conversation(id: string, run: RunSelector): Promise<RunConversation> {
    if (!run.sessionKey) return { status: "none", reason: "no-session", error: null };
    const selector = run.runId ? { runId: run.runId } : { runAtMs: run.runAt };
    const pages: unknown[][] = [];
    let cursor: string | null = null;
    try {
      for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
        const result = asRecord(
          await this.ctx.request("cron.history", {
            id,
            ...selector,
            limit: PAGE,
            ...(cursor ? { cursor } : {}),
          }),
        );
        pages.unshift(arr(result?.messages));
        cursor = str(result?.nextCursor);
        if (!cursor) break;
      }
    } catch (error) {
      const text = errorText(error);
      if (!text.startsWith(UNAVAILABLE)) throw error;
      return {
        status: "none",
        reason: "not-kept",
        error: cutText(text, MAX_ROUTINE_RUN_TEXT_CHARS),
      };
    }
    if (cursor) return { status: "none", reason: "too-long", error: null };
    return parseRunConversation(pages.flat(), id, run.sessionKey);
  }
}

// What the gateway answers for a run it has no transcript of (observed on 2026.10.6).
const UNAVAILABLE = "The recorded cron transcript is unavailable.";
