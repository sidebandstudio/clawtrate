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
import type { GatewayStamp, TranscriptItem } from "./types.ts";

/** Routines kept from `cron.list`; past it they are counted in `omitted`. */
export const MAX_ROUTINES = 200;
export const MAX_ROUTINE_UPDATES = 128;
/**
 * Routines read again at once (`cron.get`) because a `cron` event carried only a summary of the
 * job; past it the whole list is read instead.
 */
export const MAX_ROUTINE_READS = 32;
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
const UNCONFIRMED =
  "Another gateway is connected now, so this routine couldn't be checked on the one it was changed on.";
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
  /**
   * `every`: the phase the gateway anchored the job at (it writes one for every
   * new job), and `cron`: a stagger. Kept so a recovery copy runs as the
   * original did; the form writes neither, and a patch of the schedule drops
   * them again.
   */
  anchorMs?: number | null;
  staggerMs?: number | null;
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
  /** Changes with each event, even about a routine outside the retained list, and each read published. */
  revision: number;
  /**
   * The last routine the `removed` event took away: `ranOnce` only when the
   * gateway's `finished` came just before with a snapshot of the one-shot
   * consumed (succeeded, no next run left), as the gateway sends them when a
   * one-shot removes itself.
   */
  removed: { id: string; ranOnce: boolean; runAt: number | null } | null;
  /**
   * The connection the list was read on. A row's Pause, Run now and Delete send
   * it back, and are refused once another connection has begun: the row's id
   * may name another gateway's routine there.
   */
  listedOn: number;
};

export const initialRoutinesState: RoutinesState = {
  status: "idle",
  error: null,
  schedulerOn: null,
  routines: [],
  omitted: 0,
  revision: 0,
  removed: null,
  listedOn: 0,
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
  /** Started with `cron.run` (Run now and the like), told by the id the gateway gave it: `isManualRunId`. */
  manual: boolean;
};

const CRON_REQUEST_RUN_ID =
  /^cron-request\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A run someone started with `cron.run` (Run now, another client, a bot's cron tool) or a plugin
 * asked for, by the id the gateway gave it, which no caller chooses. OpenClaw 2026.10.6 gives such
 * a run `manual:<job>:<ms>:<n>`; 2026.11.10 gives it `cron-request.<uuid>`. A scheduled run has no
 * id on 2026.10.6 and one beginning `cron:` on 2026.11.10, as does a run 2026.11.10 starts when a
 * watched process exits (`cron:<job>:<ms>:cron-request.<uuid>`); an event's run is `event:<hash>`.
 */
function isManualRunId(runId: string | null): boolean {
  return runId !== null && (runId.startsWith("manual:") || CRON_REQUEST_RUN_ID.test(runId));
}

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
    return {
      ...base,
      kind,
      expr: str(schedule.expr),
      tz: str(schedule.tz),
      ...(num(schedule.staggerMs) !== null ? { staggerMs: num(schedule.staggerMs) } : {}),
    };
  if (kind === "every" && num(schedule.everyMs))
    return {
      ...base,
      kind,
      everyMs: num(schedule.everyMs),
      ...(num(schedule.anchorMs) !== null ? { anchorMs: num(schedule.anchorMs) } : {}),
    };
  if (kind === "at" && str(schedule.at))
    return { ...base, kind, at: str(schedule.at), tz: str(schedule.tz) };
  return { ...base, kind: "other", name: kind ?? "unknown" };
}

function instructionOf(payload: RawRecord): string {
  return (
    str(payload.message) ?? str(payload.text) ?? str(payload.script) ?? str(payload.command) ?? ""
  );
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
  const fullText = instructionOf(payload);
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
      // A copy is made with `cron.add` and the form's fields alone, so a job
      // carrying anything the form cannot write again (a pause, a wake mode
      // other than now, a one-shot that does not delete itself) is offered no
      // copy that would run differently (F-189). The schedule's anchor and
      // stagger are carried over in the copy itself.
      job.enabled !== false &&
      (job.wakeMode == null || job.wakeMode === "now") &&
      (schedule.kind !== "at" || job.deleteAfterRun !== false) &&
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
    manual: isManualRunId(runId),
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
 * A `cron` event's job that is a summary, not the job: OpenClaw 2026.11.10 sends only its
 * identity and run state (`id`, `name`, `agentId`, `enabled`, `updatedAtMs`, `state`), with no
 * schedule or instruction; 2026.10.6 sends the whole job. Told by what the job carries.
 */
export function isJobSummary(value: unknown): boolean {
  const job = asRecord(value);
  return job !== null && (asRecord(job.schedule) === null || asRecord(job.payload) === null);
}

/**
 * What a summary carries, put on the routine already held: its name, whether it is on, when it
 * was changed and its run state. Its schedule, instruction, target and delivery stay as held.
 * `changed`: the event says the job was added or changed, so its definition may differ from the
 * one held until the job is read.
 */
function withSummary(held: Routine, value: unknown, changed: boolean): Routine {
  const job = asRecord(value) ?? {};
  const state = asRecord(job.state);
  const enabled = typeof job.enabled === "boolean" ? job.enabled : held.enabled;
  const runs = state ? parseRoutine({ id: held.id, state }) : null;
  return {
    ...held,
    name: str(job.name) ?? held.name,
    enabled,
    // A paused routine is offered no copy; one turned back on, or added or changed (it may now
    // have a condition the summary doesn't carry), waits for its job to be read.
    canRecreate: held.canRecreate === true && enabled && !changed,
    updatedAt: num(job.updatedAtMs) ?? held.updatedAt,
    ...(runs
      ? {
          nextRunAt: runs.nextRunAt,
          lastRunAt: runs.lastRunAt,
          lastEndedAt: runs.lastEndedAt,
          lastStatus: runs.lastStatus,
          runningAt: runs.runningAt,
          // A summary carries no error: one held is of the run it was held with.
          ...(runs.lastRunAt !== held.lastRunAt ? { lastError: null } : {}),
        }
      : {}),
  };
}

/**
 * One `cron` event applied to the list; the same list when it changes nothing.
 * `started` and `finished` carry their run's `runAtMs`, so one that arrives
 * after a newer run's is told apart: an older finish never clears a newer
 * start or replaces a newer finish, and an older start never replaces the
 * last finished run or a newer start. A `finished` only updates a routine
 * already listed: the gateway also finishes a run whose job was removed while
 * it ran, with the removed job's snapshot. A summary of the job (`isJobSummary`) never replaces
 * a routine and never adds one: it is merged into the routine held, if any.
 */
export function applyCronEvent(routines: Routine[], payload: RawRecord): Routine[] {
  const jobId = str(payload.jobId);
  const action = str(payload.action);
  if (!jobId) return routines;
  if (action === "removed") return routines.filter((each) => each.id !== jobId);
  const at = routines.findIndex((each) => each.id === jobId);
  const current = at >= 0 ? routines[at]! : null;
  const summary = isJobSummary(payload.job);
  const fromJob = summary ? null : parseRoutine(payload.job);
  if (asRecord(payload.job) && !summary && !fromJob) return routines;
  let next =
    fromJob ??
    (current && summary
      ? withSummary(current, payload.job, action === "added" || action === "updated")
      : current);
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
    if (!fromJob) {
      const status = str(payload.status);
      const duration = num(payload.durationMs);
      next = {
        ...next,
        lastRunAt: runAt ?? next.lastRunAt,
        lastEndedAt: runAt !== null && duration !== null ? runAt + duration : null,
        lastStatus: status === "ok" || status === "error" || status === "skipped" ? status : null,
        lastError: cut(str(payload.error), MAX_ROUTINE_RUN_TEXT_CHARS),
        nextRunAt: Object.hasOwn(payload, "nextRunAtMs")
          ? num(payload.nextRunAtMs)
          : next.nextRunAt,
      };
    }
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
  /**
   * The connection's confirmed gateway identity, or null until it is read: a
   * write waits for it, so a draft never reaches a gateway it was not made on.
   * `expected` names the gateway a draft was opened on, when the editor knows
   * it: a write also waits for it to match.
   */
  identity(expected?: string | null): string | null;
  /** The viewer that asked has gone away (`client.withdraw`). */
  withdrawn(owner: object): boolean;
  /** The host's target now (`ConnectionState.target`). */
  target(): number;
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
  /**
   * Nothing was sent: this connection has no admin access, no connection, no
   * confirmed gateway identity yet, or the viewer that asked has gone away.
   */
  | { status: "not-sent"; reason: "admin" | "offline" | "gateway" | "changed" }
  | { status: "refused"; error: string }
  /** Sent, with no answer that settles it: it may or may not have landed. */
  | { status: "unknown"; error: string }
  /** It was changed elsewhere since the editor opened; nothing was written. */
  | { status: "conflict"; current: Routine }
  | { status: "deleted" };

/** What a read shows of a save whose answer never came. Reads only. */
export type RoutineSaveCheck =
  /** No routine from this draft, or the edited routine is gone. */
  | { status: "missing" }
  /** It reads as the save would leave it: maybe this save, maybe the same change made elsewhere. */
  | { status: "matches"; routine: Routine }
  /** It reads as it did before the save, which may not have been applied yet. */
  | { status: "unchanged" }
  /** Neither: something else changed it. */
  | { status: "changed"; routine: Routine };

/** A save in doubt as it was sent: a create's fields, or an edit as `update` was given it. */
export type SentRoutine =
  | { input: RoutineFields }
  | { original: RoutineFields; edit: RoutineFields; expected: RoutineFields };

/**
 * The whole job against what the save would leave and, for an edit, what it
 * was held to. `text` is the job's whole instruction: a routine's own is cut
 * for display, so an instruction the save wrote is compared in full, and one
 * it left alone as both sides show it.
 */
export function savedAs(routine: Routine, text: string, sent: SentRoutine): RoutineSaveCheck {
  let wrote = "input" in sent ? sent.input : sent.expected;
  let wholeText = true;
  if (!("input" in sent)) {
    // As `update` writes it: the target is never changed, only fields edited from the original.
    const fields = { ...sent.edit, target: sent.original.target };
    const written = changedFields(sent.original, fields);
    wrote = { ...wrote, ...Object.fromEntries(written.map((key) => [key, fields[key]])) };
    wholeText = written.includes("text");
  }
  const actual = wholeText ? { ...fieldsOf(routine), text } : fieldsOf(routine);
  if (changedFields(wrote, actual).length === 0) return { status: "matches", routine };
  if (!("input" in sent) && changedFields(sent.expected, actual).length === 0)
    return { status: "unchanged" };
  return { status: "changed", routine };
}

export type RoutineRunNow =
  | { status: "started"; runId: string | null }
  | { status: "already-running" }
  | { status: "not-sent"; reason: "admin" | "offline" | "gateway" | "changed" }
  | { status: "refused"; error: string }
  | { status: "unknown"; error: string };

export type RoutineRemove =
  | { status: "removed" }
  | { status: "not-sent"; reason: "admin" | "offline" | "gateway" | "changed" }
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
  // The anchor and stagger are not compared: the form writes neither, a patch
  // of the schedule drops them, and they never differ on their own.
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

/**
 * The gateway's own answer that the job is gone (`details.code`, sent by every
 * cron method on 2026.10.6), not any refusal whose words say "not found".
 */
const notFound = (error: unknown) =>
  error instanceof GatewayProtocolRequestError &&
  asRecord(error.details)?.code === "CRON_JOB_NOT_FOUND";

/** The gateway refused an update held to a definition that has changed since. */
const changedSince = (error: unknown) =>
  error instanceof GatewayProtocolRequestError &&
  asRecord(error.details)?.code === "CRON_JOB_CHANGED";

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
  return asRecord(record?.job) ?? record;
};

/** Confirm the written fields against the whole reply. Only the bounded routine goes to a viewer. */
function confirmedWrite(
  result: unknown,
  sent: RoutineFields,
  changed?: Array<keyof RoutineFields>,
): Routine | null {
  const job = answeredJob(result);
  const routine = parseRoutine(job);
  if (!routine) return null;
  const actual = { ...fieldsOf(routine), text: instructionOf(asRecord(job?.payload) ?? {}) };
  const differs = changedFields(sent, actual).some((field) => !changed || changed.includes(field));
  return differs ? null : routine;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A sent request whose answer never came, in a person's words. The client's own text ("gateway
 * client stopped", "gateway closed (1006): ", its timeout) is never put in a sentence.
 */
const lostWords = (error: unknown) =>
  error instanceof GatewayProtocolRequestTimeoutError
    ? "The gateway didn't answer in time."
    : "The connection changed before the gateway answered.";

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
 * `applyJobResult`). A forced run before its time keeps its next run. A summary of the job
 * (2026.11.10) leaves `deleteAfterRun` out: the routine held says it.
 */
function consumedOneShot(record: RawRecord, held: Routine): boolean {
  const job = asRecord(record.job);
  const state = asRecord(job?.state);
  return (
    (isJobSummary(job) ? held.deleteAfterRun : job?.deleteAfterRun === true) &&
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
  /** When `recheck` fires: a later read again never puts it off. */
  private recheckAt = 0;
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
  /**
   * The connection the shown list was read on. A row's Pause, Run now and
   * Delete name only the routine's id, so after a reconnect, possibly to
   * another gateway at the same address, they wait for this connection's list.
   */
  private listedEpoch = 0;
  /** Writes out for a routine. `evented`: a `cron` event for it arrived since the write was sent. */
  private readonly updates = new Set<{ id: string; removed: boolean; evented?: boolean }>();
  /**
   * Jobs read again (`cron.get`) after an event carried only their summary, one read each:
   * `again` when another event came while it was out, so its answer may be older than that.
   */
  private readonly reads = new Map<string, { again: boolean }>();
  /**
   * Those reads' `cron.get` requests out now, counted until each settles: an entry a removal or a
   * reconnect dropped still has its request out. `MAX_ROUTINE_READS` bounds this.
   */
  private readsOut = 0;

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
      if (this.invalidated) {
        // Overtaken every time: keep what the events made and look again soon.
        this.schedule(RETRY_MS);
        return;
      }
      this.listedEpoch = this.epoch;
      // A job read out now may answer with what this list already replaced.
      for (const entry of this.reads.values()) entry.again = true;
      this.ctx.update((state) => ({
        ...state,
        status: "loaded",
        error: null,
        listedOn: this.epoch,
        ...read,
        revision: (state.revision + 1) % Number.MAX_SAFE_INTEGER,
      }));
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
    const at = Date.now() + ms;
    // An earlier read again already armed stays; a later one (a running recheck) is brought in.
    if (this.recheck !== null && this.recheckAt <= at) return;
    this.clearRecheck();
    this.recheckAt = at;
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
    const summary = isJobSummary(record.job);
    for (const update of this.updates) if (update.id === jobId) update.evented = true;
    if (action === "removed" && jobId) {
      this.markRemoved(jobId);
      this.reads.delete(jobId);
    }
    // Any event about a job whose read is out may be newer than that read's answer, a run's too.
    const pending = jobId ? this.reads.get(jobId) : undefined;
    if (pending) pending.again = true;
    const before = this.ctx.get();
    const kept = before.routines.find((each) => each.id === jobId);
    if (action !== "added" && jobId && before.removed?.id === jobId && !kept) return;
    const routines = applyCronEvent(before.routines, record);
    const finished = this.lastFinished;
    this.lastFinished =
      action === "finished" && kept
        ? { jobId: kept.id, consumed: consumedOneShot(record, kept), runAt: num(record.runAtMs) }
        : null;
    const removed =
      action === "removed" && jobId
        ? {
            id: jobId,
            ranOnce: finished?.jobId === jobId && finished.consumed,
            runAt: finished?.jobId === jobId ? finished.runAt : null,
          }
        : before.removed;
    // At the retention cap only the gateway can confirm membership and the omission count.
    const refill =
      (action === "removed" && before.omitted > 0) ||
      (action === "added" &&
        !kept &&
        before.routines.length >= MAX_ROUTINES &&
        parseRoutine(record.job) !== null) ||
      (action === "finished" &&
        kept &&
        routines !== before.routines &&
        !asRecord(record.job) &&
        (num(record.runAtMs) === null ||
          str(record.status) === null ||
          !Object.hasOwn(record, "nextRunAtMs"))) ||
      (action === "finished" &&
        kept === undefined &&
        before.omitted === 0 &&
        !summary &&
        parseRoutine(record.job) !== null);
    this.ctx.update((state) => ({
      ...state,
      routines,
      removed,
      revision: (state.revision + 1) % Number.MAX_SAFE_INTEGER,
    }));
    if (refill) void this.load();
    else {
      // A summary of an added or changed job says nothing of its schedule or instruction: the job
      // is read, and a new one is shown only once it is. A run's own events change neither.
      if (summary && jobId && (action === "added" || action === "updated")) this.readJob(jobId);
      this.scheduleIfRunning();
    }
  }

  /** Read one job again after a summary; at most one read each, the latest event's answer kept. */
  private readJob(id: string): void {
    const pending = this.reads.get(id);
    if (pending) {
      pending.again = true;
      return;
    }
    if (this.readsOut >= MAX_ROUTINE_READS) {
      void this.load();
      return;
    }
    const entry = { again: false };
    this.reads.set(id, entry);
    void this.readJobOnce(id, entry);
  }

  private async readJobOnce(id: string, entry: { again: boolean }): Promise<void> {
    const target = this.ctx.target();
    // After a reconnect (which clears the reads), a switch or the job's removal, the answer is
    // about nothing shown.
    const current = () => this.reads.get(id) === entry && target === this.ctx.target();
    for (let attempt = 1; ; attempt += 1) {
      entry.again = false;
      let job: unknown;
      this.readsOut += 1;
      try {
        job = await this.ctx.request("cron.get", { id });
      } catch (error) {
        if (!current()) return;
        this.reads.delete(id);
        if (notFound(error)) {
          // The gateway says the job is gone: so is its routine, whatever event was lost.
          this.markRemoved(id);
          if (this.loading) this.invalidated = true;
          const before = this.ctx.get();
          this.ctx.update((state) => ({
            ...state,
            routines: state.routines.filter((each) => each.id !== id),
            revision: (state.revision + 1) % Number.MAX_SAFE_INTEGER,
          }));
          // At the retention cap only the list can fill the row it leaves.
          if (before.omitted > 0 && before.routines.some((each) => each.id === id))
            void this.load();
          return;
        }
        // Otherwise the routine stays as the events left it, and the list is read again later
        // unless the refusal is one another try would get again.
        if (!permanent(error)) this.schedule(RETRY_MS);
        return;
      } finally {
        this.readsOut -= 1;
      }
      if (!current()) return;
      if (entry.again && attempt < MAX_REREADS) continue;
      this.reads.delete(id);
      if (entry.again) {
        this.schedule(RETRY_MS);
        return;
      }
      const routine = isJobSummary(job) ? null : parseRoutine(job);
      if (!routine || routine.id !== id) return;
      const held = this.ctx.get().routines;
      // Others filled the list while it was read: only the list can say what is left out.
      if (held.length >= MAX_ROUTINES && !held.some((each) => each.id === id)) {
        void this.load();
        return;
      }
      if (this.loading) this.invalidated = true;
      this.ctx.update((state) => {
        const at = state.routines.findIndex((each) => each.id === id);
        return {
          ...state,
          routines:
            at < 0
              ? [...state.routines, routine]
              : state.routines.map((each, index) => (index === at ? routine : each)),
          revision: (state.revision + 1) % Number.MAX_SAFE_INTEGER,
        };
      });
      this.scheduleIfRunning();
      return;
    }
  }

  /** A write still in flight for the job must not put its routine back when it answers. */
  private markRemoved(id: string): void {
    for (const update of this.updates) if (update.id === id) update.removed = true;
  }

  /** A dropped connection's answers no longer count. */
  onClose(): void {
    this.loadSeq += 1;
    this.loading = null;
    this.clearRecheck();
    this.lastFinished = null;
    this.reads.clear();
    this.epoch += 1;
  }

  reset(): void {
    this.onClose();
    this.ctx.update(() => initialRoutinesState);
  }

  /**
   * Why a write cannot be sent now, or null: checked just before each request.
   * A withdrawn viewer's write is refused as unsent, too: its reply has no
   * reader, and nothing of it may reach the gateway.
   */
  private blocked(
    owner: object | null = null,
    stamp: GatewayStamp | undefined = undefined,
  ): "admin" | "offline" | "gateway" | "changed" | null {
    if (!this.ctx.connected()) return "offline";
    // A draft is stamped where it was opened: once the host is pointed at a
    // gateway anew, another gateway can be there whatever its identity says.
    if (stamp !== undefined && stamp.target !== this.ctx.target()) return "changed";
    const identity = this.ctx.identity();
    if (identity === null) return "gateway";
    // A draft names the gateway it was opened on; a write without one, or for
    // another, is refused: the routine is at one address, and another gateway
    // can be there in its place by now.
    if (stamp !== undefined && identity !== stamp.gatewayId) return "gateway";
    if (owner !== null && this.ctx.withdrawn(owner)) return "offline";
    return this.ctx.admin() ? null : "admin";
  }

  /**
   * A row read on an earlier connection: its id may name another gateway's
   * routine now. `listedOn` is the list the row came from, as the viewer had it.
   */
  private unlisted(listedOn?: number): "gateway" | null {
    if (this.listedEpoch !== this.epoch) return "gateway";
    return listedOn === undefined || listedOn === this.epoch ? null : "gateway";
  }

  /** The gateway's own view of a routine, put in the list while the connection that read it holds. */
  private keep(routine: Routine, epoch: number): void {
    if (epoch !== this.epoch) return;
    // A list read in flight may predate this answer, as it may an event's, and so may a job's read.
    if (this.loading) this.invalidated = true;
    const pending = this.reads.get(routine.id);
    if (pending) pending.again = true;
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
      return notFound(error) ? { status: "deleted" } : { status: "refused", error: refused };
    return { status: "unknown", error: lostWords(error) };
  }

  /**
   * After a lost answer: the routine read back on the connection the write went out on. `null`:
   * the gateway has none by that id; `undefined`: it couldn't be read there.
   */
  private async readBack(id: string, epoch: number) {
    if (epoch !== this.epoch) return undefined;
    const read = await this.readRevised(id).catch(() => undefined);
    return epoch === this.epoch ? read : undefined;
  }

  /**
   * A new routine for a bot (`cron.add`). `key` is the draft's: the gateway
   * treats a second add with the same declaration key as the same routine, so
   * trying again after an answer that never came cannot make two.
   */
  async create(
    input: NewRoutine,
    key: string,
    owner: object | null = null,
    stamp?: GatewayStamp,
  ): Promise<RoutineWrite> {
    const blocked = this.blocked(owner, stamp);
    if (blocked) return { status: "not-sent", reason: blocked };
    if (input.target !== "isolated")
      return { status: "refused", error: "New routines run in an isolated conversation." };
    const schedule = wireSchedule(input.schedule);
    if (!schedule) return { status: "refused", error: "Clawtrate can't write this schedule." };
    // A recovery copy runs when the original did: the gateway anchors a new
    // every-job at now and takes no stagger unless the request carries one.
    if (schedule.kind === "every" && input.schedule.anchorMs != null)
      schedule.anchorMs = input.schedule.anchorMs;
    if (schedule.kind === "cron" && input.schedule.staggerMs != null)
      schedule.staggerMs = input.schedule.staggerMs;
    const epoch = this.epoch;
    try {
      const routine = confirmedWrite(
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
        input,
      );
      if (!routine)
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
  async readOne(id: string, stamp?: GatewayStamp): Promise<Routine | null> {
    return (await this.onGateway(stamp, () => this.readRevised(id)))?.routine ?? null;
  }

  /**
   * A read-back names the gateway its write went to. Another gateway may be
   * connected by the time it is sent or answered, and its routines say nothing
   * about that write. One that names no confirmed gateway confirms nothing:
   * null is not an identity.
   */
  private async onGateway<T>(stamp: GatewayStamp | undefined, read: () => Promise<T>) {
    const epoch = this.epoch;
    const elsewhere = () =>
      stamp !== undefined &&
      (stamp.gatewayId === null ||
        epoch !== this.epoch ||
        stamp.target !== this.ctx.target() ||
        this.ctx.identity() !== stamp.gatewayId);
    if (elsewhere()) throw new Error(UNCONFIRMED);
    const value = await read();
    if (elsewhere()) throw new Error(UNCONFIRMED);
    return value;
  }

  /** A routine with the gateway's token for its definition, which `cron.update` can be held to. */
  private async readRevised(
    id: string,
  ): Promise<{ routine: Routine; revision: string | null; text: string } | null> {
    try {
      const job = await this.ctx.request("cron.get", { id });
      const routine = parseRoutine(job);
      // Only the gateway's not-found says a routine is gone: an answer Clawtrate
      // can't read, or one for another job, says nothing about this one.
      if (!routine || routine.id !== id)
        throw new Error("The gateway's answer for this routine couldn't be read.");
      const revision = asRecord(job)?.configRevision;
      return {
        routine,
        revision: typeof revision === "string" && revision !== "" ? revision : null,
        text: instructionOf(asRecord(asRecord(job)?.payload) ?? {}),
      };
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  }

  /**
   * A create whose answer never came: the routine its draft made, if the
   * gateway lists it, found by the draft's own key and nothing else.
   */
  async checkCreate(
    key: string,
    input: RoutineFields,
    stamp: GatewayStamp,
  ): Promise<RoutineSaveCheck> {
    const job = await this.onGateway(stamp, () => this.findByKey(key));
    const routine = parseRoutine(job);
    if (!routine) return { status: "missing" };
    return savedAs(routine, instructionOf(asRecord(asRecord(job)?.payload) ?? {}), { input });
  }

  /** An edit whose answer never came, read on the gateway it was written to. */
  async checkUpdate(
    id: string,
    sent: Extract<SentRoutine, { original: RoutineFields }>,
    stamp: GatewayStamp,
  ): Promise<RoutineSaveCheck> {
    const read = await this.onGateway(stamp, () => this.readRevised(id));
    return read ? savedAs(read.routine, read.text, sent) : { status: "missing" };
  }

  private async findByKey(key: string): Promise<unknown> {
    let offset = 0;
    for (;;) {
      const result = asRecord(
        await this.ctx.request("cron.list", { includeDisabled: true, limit: PAGE, offset }),
      );
      const job = arr(result?.jobs).find(
        (each) => asRecord(each)?.declarationKey === `${DECLARATION_PREFIX}${key}`,
      );
      if (job) return job;
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
    owner: object | null = null,
    stamp?: GatewayStamp,
  ): Promise<RoutineWrite> {
    let blocked = this.blocked(owner, stamp);
    if (blocked) return { status: "not-sent", reason: blocked };
    if (this.updates.size >= MAX_ROUTINE_UPDATES)
      return { status: "refused", error: "Too many routine changes are in flight." };
    const epoch = this.epoch;
    const pending = { id, removed: false };
    this.updates.add(pending);
    try {
      let current: Routine | null;
      let revision: string | null;
      try {
        const read = await this.readRevised(id);
        current = read?.routine ?? null;
        revision = read?.revision ?? null;
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
      if (changedFields(original, fields).includes("schedule") && !patch.schedule)
        return { status: "refused", error: "Clawtrate can't write this schedule." };
      if (Object.keys(patch).length === 0) return { status: "saved", routine: current };
      blocked = this.blocked(owner, stamp);
      if (blocked) return { status: "not-sent", reason: blocked };
      if (epoch !== this.epoch) return { status: "not-sent", reason: "offline" };
      try {
        // Held to the definition just checked: another editor's save that lands
        // between the read and this write is refused, not overwritten.
        const routine = confirmedWrite(
          await this.ctx.request("cron.update", {
            id,
            patch,
            ...(revision === null ? {} : { expectedConfigRevision: revision }),
          }),
          fields,
          changedFields(original, fields),
        );
        if (pending.removed) return { status: "deleted" };
        if (!routine)
          return { status: "unknown", error: "The gateway answered, but doesn't show the change." };
        this.keep(routine, epoch);
        return { status: "saved", routine };
      } catch (error) {
        if (pending.removed) return { status: "deleted" };
        if (changedSince(error)) {
          const now = await this.readOne(id).catch(() => undefined);
          // A read meanwhile may have found it gone, which an older answer here doesn't undo.
          if (now === null || pending.removed) return { status: "deleted" };
          if (now) return { status: "conflict", current: now };
        }
        return this.failed(error);
      }
    } finally {
      this.updates.delete(pending);
    }
  }

  /**
   * Pause or resume (`cron.update {enabled}`). `listedOn` and `stamp` are the row's list and
   * where it was read: one from before the host was pointed at a gateway anew is `changed`.
   */
  async setEnabled(
    id: string,
    enabled: boolean,
    owner: object | null = null,
    listedOn?: number,
    stamp?: GatewayStamp,
  ): Promise<RoutineWrite> {
    const blocked = this.blocked(owner, stamp) ?? this.unlisted(listedOn);
    if (blocked) return { status: "not-sent", reason: blocked };
    const epoch = this.epoch;
    if (this.updates.size >= MAX_ROUTINE_UPDATES)
      return { status: "refused", error: "Too many routine changes are in flight." };
    // Registered as an update, so a removal confirmed meanwhile is not undone by this reply.
    const pending: { id: string; removed: boolean; evented?: boolean } = { id, removed: false };
    this.updates.add(pending);
    try {
      const routine = parseRoutine(
        answeredJob(await this.ctx.request("cron.update", { id, patch: { enabled } })),
      );
      if (pending.removed) return { status: "deleted" };
      if (!routine || routine.enabled !== enabled)
        return { status: "unknown", error: "The gateway answered, but doesn't show the change." };
      this.keep(routine, epoch);
      return { status: "saved", routine };
    } catch (error) {
      if (pending.removed) return { status: "deleted" };
      const failed = this.failed(error);
      if (failed.status !== "unknown") return failed;
      // The answer was lost: a read that shows the change is the save an answer would confirm.
      const read = await this.readBack(id, epoch);
      if (pending.removed || read === null) return { status: "deleted" };
      const still = `it is still ${enabled ? "paused" : "not paused"}: the change hasn't taken, or not yet.`;
      if (pending.evented) {
        // A `cron` event for it since the write was sent is newer than this read, which may
        // predate it: the routine as that event left it decides, and the read is never kept.
        const shown = this.ctx.get().routines.find((each) => each.id === id);
        if (shown?.enabled === enabled) return { status: "saved", routine: shown };
        if (shown)
          return {
            status: "unknown",
            error: `${failed.error} As the gateway last reported it, ${still}`,
          };
      }
      if (read === undefined || pending.evented)
        return {
          status: "unknown",
          error: `${failed.error} Clawtrate couldn't read the routine back, so whether it was ${enabled ? "resumed" : "paused"} isn't known.`,
        };
      if (read.routine.enabled !== enabled)
        return { status: "unknown", error: `${failed.error} Read back just now, ${still}` };
      this.keep(read.routine, epoch);
      return { status: "saved", routine: read.routine };
    } finally {
      this.updates.delete(pending);
    }
  }

  /** Run it once now (`cron.run {mode: "force"}`), paused or not; it stays as it was. */
  async runNow(
    id: string,
    owner: object | null = null,
    listedOn?: number,
    stamp?: GatewayStamp,
  ): Promise<RoutineRunNow> {
    const blocked = this.blocked(owner, stamp) ?? this.unlisted(listedOn);
    if (blocked) return { status: "not-sent", reason: blocked };
    const epoch = this.epoch;
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
      if (failed.status === "deleted") return { status: "refused", error: errorText(error) };
      if (failed.status !== "unknown") return failed as RoutineRunNow;
      // The answer was lost: what the routine shows now, said as found. A run under way may be
      // another, so nothing read back makes it "started".
      const read = await this.readBack(id, epoch);
      return {
        status: "unknown",
        error: `${failed.error} ${
          read === undefined
            ? "Clawtrate couldn't read the routine back, so whether a run started isn't known."
            : read === null
              ? "Read back just now, the gateway no longer has this routine."
              : read.routine.runningAt !== null
                ? "Read back just now, a run is under way, which may be this one."
                : // A short run can start and finish before the read: never "hasn't started".
                  "Read back just now, no run is under way: this one may still start, or may already have finished."
        }`,
      };
    }
  }

  /**
   * Delete it (`cron.remove`). The reply's `removed: true`, or the gateway's
   * established not-found refusal, is what takes it off the list: any other
   * answer leaves the row while its outcome is checked.
   */
  async remove(
    id: string,
    owner: object | null = null,
    listedOn?: number,
    stamp?: GatewayStamp,
  ): Promise<RoutineRemove> {
    const blocked = this.blocked(owner, stamp) ?? this.unlisted(listedOn);
    if (blocked) return { status: "not-sent", reason: blocked };
    const epoch = this.epoch;
    const drop = () => {
      this.markRemoved(id);
      // Nor a read out for it, should the gateway's `removed` event be lost.
      if (epoch === this.epoch) this.reads.delete(id);
      if (epoch === this.epoch && this.loading) this.invalidated = true;
      if (epoch === this.epoch)
        this.ctx.update((state) => ({
          ...state,
          routines: state.routines.filter((each) => each.id !== id),
        }));
      return { status: "removed" } as const;
    };
    try {
      const result = asRecord(await this.ctx.request("cron.remove", { id }));
      if (result?.removed !== true)
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
    const seen = new Set<string>();
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
      for (const run of parseRuns(result, PAGE)) {
        if (run.runAt < from || run.runAt >= to) continue;
        const key = JSON.stringify([run.jobId, run.runId ?? run.runAt]);
        if (seen.has(key)) continue;
        seen.add(key);
        runs.push(run);
      }
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
