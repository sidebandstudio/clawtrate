// Routines: the gateway's scheduled jobs (`cron.*`), all read at
// `operator.read` (automation.md sections 3 to 8). The engine keeps one thing,
// the routine list in `ClawtrateState.routines`, from `cron.list` and the
// `cron` event. A routine's runs, a run's conversation and the calendar's past
// runs are read when a screen asks and returned to it, never kept here.
//
// Changing them (sections 9 and 10) needs `operator.admin`: every write checks
// it here, just before it is sent, whatever asked for it. An update compares
// the values the editor opened with against a fresh `cron.get` and writes only
// what the person changed; nothing is called saved until the gateway's answer
// shows it.
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
  /** `text` was cut: the editor must not write it back. */
  textCut: boolean;
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
  const fullText = str(payload.message) ?? str(payload.text) ?? str(payload.command) ?? "";
  const text = cutText(fullText, MAX_ROUTINE_TEXT_CHARS);
  return {
    id,
    botId: str(job.agentId) ?? str(job.effectiveAgentId) ?? "main",
    name: str(job.name) ?? "Routine",
    enabled: job.enabled !== false,
    schedule: parseSchedule(job.schedule),
    payload: payloadKind === "agentTurn" || payloadKind === "systemEvent" ? payloadKind : "other",
    text,
    textCut: text.length < fullText.length,
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
    if (key === "target" && (edit.target === "isolated" || edit.target === "main"))
      patch.sessionTarget = edit.target;
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

export class RoutinesEngine {
  /** Each load's number: an answer to an older one is dropped. */
  private loadSeq = 0;
  /** An event arrived while a list was being read: read it again once that one lands. */
  private stale = false;
  /** The connection a write was sent on: its answer is applied only while this holds. */
  private epoch = 0;

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
    this.epoch += 1;
  }

  reset(): void {
    this.loadSeq += 1;
    this.epoch += 1;
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
    const schedule = wireSchedule(input.schedule);
    if (!schedule) return { status: "refused", error: "Clawtrate can't write this schedule." };
    const epoch = this.epoch;
    try {
      const routine = answeredJob(
        await this.ctx.request("cron.add", {
          name: input.name,
          agentId: input.botId,
          schedule,
          sessionTarget: input.target === "main" ? "main" : "isolated",
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

  /** The routine a draft made, if the gateway lists it: found by the draft's own key, nothing else. */
  async findCreated(key: string): Promise<Routine | null> {
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = asRecord(
        await this.ctx.request("cron.list", { includeDisabled: true, limit: PAGE, offset }),
      );
      const job = arr(result?.jobs).find(
        (each) => asRecord(each)?.declarationKey === `${DECLARATION_PREFIX}${key}`,
      );
      if (job) return parseRoutine(job);
      const nextOffset = num(result?.nextOffset);
      if (result?.hasMore !== true || nextOffset === null) return null;
      offset = nextOffset;
    }
    return null;
  }

  /**
   * Change a routine (`cron.update`). `original` is what the editor opened
   * with: when the gateway's routine no longer reads so, nothing is written
   * and the current one comes back. Only the fields that differ from
   * `original` are sent, so a name-only change leaves the schedule as it is.
   */
  async update(id: string, original: RoutineFields, edit: RoutineFields): Promise<RoutineWrite> {
    let blocked = this.blocked();
    if (blocked) return { status: "not-sent", reason: blocked };
    const epoch = this.epoch;
    let current: Routine | null;
    try {
      current = parseRoutine(await this.ctx.request("cron.get", { id }));
    } catch (error) {
      const failed = this.failed(error);
      // Only a read failed: nothing was written.
      return failed.status === "unknown" ? { status: "not-sent", reason: "offline" } : failed;
    }
    if (!current) return { status: "deleted" };
    if (changedFields(original, fieldsOf(current)).length > 0)
      return { status: "conflict", current };
    const patch = patchOf(original, edit, current.payload);
    if (Object.keys(patch).length === 0) return { status: "saved", routine: current };
    blocked = this.blocked();
    if (blocked) return { status: "not-sent", reason: blocked };
    if (epoch !== this.epoch) return { status: "not-sent", reason: "offline" };
    try {
      const routine = answeredJob(await this.ctx.request("cron.update", { id, patch }));
      const wanted = changedFields(original, edit);
      if (!routine || changedFields(edit, fieldsOf(routine)).some((key) => wanted.includes(key)))
        return { status: "unknown", error: "The gateway answered, but doesn't show the change." };
      this.keep(routine, epoch);
      return { status: "saved", routine };
    } catch (error) {
      return this.failed(error);
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
