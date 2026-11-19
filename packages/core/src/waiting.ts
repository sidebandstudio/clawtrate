// Which tasks wait for the person, and whose latest run was stopped, across
// every bot, for the rail (F-021, F-057). One source of truth per task:
//
// - A task whose runs the engine holds (it follows the task) is described by
//   those runs, the same state the conversation shows (`hold`, from
//   `fromActivity`): a run waiting on a card waits; a latest run that was
//   stopped is stopped.
// - Any other task is described from the gateway's events, by run identity:
//   a run waits for an approval from its lifecycle's `waiting-approval` until
//   `approval-resolved`, the approval's own `*.approval.resolved`, or the run's
//   end (`agent`, `operator.read`), and for an answer from `question.requested`
//   until `question.resolved` (or the connect's `question.list`,
//   `operator.questions`); the lifecycle has no question phase, so questions are
//   kept by id. The latest run of each task is tracked by its id, so an older
//   run's end never marks a task stopped after a newer run started. A run
//   stopped with `chat.abort` leaves the gateway's row no status, so the end's
//   reason, read as the gateway reads it (`classifyLifecycleTerminal`), is the
//   only word for it.
//
// Times are the gateway's own (`ts` on events, `createdAtMs` on questions), so a
// row the gateway lists as idle clears only the markers older than the row.
// Bounded: `MAX_WAITING_SESSIONS` tasks in each map, `MAX_WAITING_MARKERS`
// markers per task, ids at most `MAX_WAITING_ID_CHARS` JSON characters.

import { jsonTextLength } from "./bounds.ts";
import { asRecord, type RawRecord } from "./mapping.ts";
import {
  classifyLifecycleTerminal,
  isDefinitiveLifecycleError,
  type TaskActivity,
} from "./runs.ts";

export const MAX_WAITING_SESSIONS = 64;
/**
 * The most tool calls of one run whose result is kept by call id, so a result
 * the gateway sends again or replaces for the same call is counted once.
 */
export const MAX_COUNTED_CALLS = 64;
/**
 * How much later than a run's end a task's row may be and still be that run's:
 * a row the gateway wrote well after the end belongs to newer activity, so the
 * end no longer describes the task.
 */
export const ROW_AFTER_END_MS = 5_000;
export const MAX_WAITING_MARKERS = 8;
/** The longest key or id kept, in JSON characters (the state's id cap). */
export const MAX_WAITING_ID_CHARS = 1_024;
/** The longest marker id: an id with its `approval:run:` prefix. */
const MARKER_PREFIX_CHARS = 13;
/** JSON characters one kept marker can take: its id, and its kind, run id and time. */
export const WAITING_MARKER_CHARS =
  MAX_WAITING_ID_CHARS + MARKER_PREFIX_CHARS + MAX_WAITING_ID_CHARS + 64;
/**
 * JSON characters one entry of the latest-run map can take: its key, run id,
 * time and flags, and the outcome of each of its counted calls by call id.
 */
export const WAITING_RUN_CHARS =
  2 * MAX_WAITING_ID_CHARS + 96 + MAX_COUNTED_CALLS * (MAX_WAITING_ID_CHARS + 8);
/** JSON characters one held task can take: its key, a waiting kind and two times. */
export const WAITING_HELD_CHARS = MAX_WAITING_ID_CHARS + 96;

export type WaitingKind = "approval" | "question";

/** One marker: what is pending, of which run, since when. */
type Marker = { kind: WaitingKind; runId: string | null; since: number };

/** What a task waits on, as the rail says it: the earliest marker. */
export type Waiting = { kind: WaitingKind; since: number };

/**
 * A task as its held runs describe it: what it waits on, when its latest run
 * was stopped, and whether a run is active. Failed actions and a blocked end
 * come from the gateway's events alone, so a task reads the same open or not.
 */
export type HeldTask = {
  waiting: Waiting | null;
  stoppedAt: number | null;
  active: boolean;
};

/** How the latest run of a task ended, as far as the rail tells it apart. */
export type LatestEnd = {
  stoppedAt: number | null;
  /** Failed actions of a latest run that completed; 0 otherwise. */
  failedActions: number;
  blocked: boolean;
};

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 && jsonTextLength(value) <= MAX_WAITING_ID_CHARS
    ? value
    : null;

const time = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** What a held task's runs say: a run waiting on a card, or a latest run that was stopped. */
export function fromActivity(activity: Pick<TaskActivity, "runs">): HeldTask {
  const runs = activity.runs;
  const active = runs.find(
    (run) => run.state === "running" || run.state === "waiting" || run.state === "stopping",
  );
  let waiting: Waiting | null = null;
  if (active?.state === "waiting") {
    for (const card of active.pendingCards) {
      const since = card.since ?? active.reportedStartAt ?? active.startedAt ?? 0;
      if (!waiting || since < waiting.since) waiting = { kind: card.kind, since };
    }
  }
  let latest: (typeof runs)[number] | null = null;
  for (const run of runs) {
    if (run.state === "queued") continue;
    const start = run.reportedStartAt ?? run.startedAt ?? 0;
    if (!latest || start >= (latest.reportedStartAt ?? latest.startedAt ?? 0)) latest = run;
  }
  const stoppedAt =
    !active && latest?.state === "stopped" ? (latest.endedAt ?? latest.startedAt ?? 0) : null;
  return { waiting, stoppedAt, active: active !== undefined };
}

const sameHeld = (a: HeldTask | undefined, b: HeldTask): boolean =>
  a !== undefined &&
  a.stoppedAt === b.stoppedAt &&
  a.active === b.active &&
  a.waiting?.kind === b.waiting?.kind &&
  a.waiting?.since === b.waiting?.since;

/** Keep a map within `max` entries, the oldest giving way. */
function cap<V>(map: Map<string, V>, max: number): void {
  while (map.size > max) map.delete(map.keys().next().value as string);
}

export class WaitingIndex {
  /** Session key to its markers by id, in the order tasks began waiting. */
  private readonly sessions = new Map<string, Map<string, Marker>>();
  /**
   * Each task's latest run as the events report it: its id, when, whether it
   * was stopped, the latest result of each of its tool calls by call id (`tool`
   * `result` `isError`; a later result for the same call replaces it), and how it ended: `completed`, `blocked`
   * (the gateway's `livenessState`), or null while it runs or for other ends.
   */
  private readonly runs = new Map<
    string,
    {
      runId: string;
      at: number;
      stopped: boolean;
      stopSeq: number;
      /** Each counted call's latest result: whether the gateway flagged it as an error. */
      calls: Map<string, boolean>;
      end: "completed" | "blocked" | null;
    }
  >();
  /** Counts the run ends seen as stopped, in the order they arrived: each task keeps its latest. */
  private stops = 0;
  /** Tasks whose runs the engine holds, as those runs describe them; they win over the events. */
  private readonly held = new Map<string, HeldTask>();

  /** For tests and the retention registry: how many tasks have markers. */
  get size(): number {
    return this.sessions.size;
  }

  private add(key: string, id: string, marker: Marker): boolean {
    let markers = this.sessions.get(key);
    if (!markers) {
      markers = new Map();
      this.sessions.set(key, markers);
      cap(this.sessions, MAX_WAITING_SESSIONS);
    }
    if (markers.has(id)) return false;
    markers.set(id, marker);
    cap(markers, MAX_WAITING_MARKERS);
    return true;
  }

  private remove(key: string, match: (id: string, marker: Marker) => boolean): boolean {
    const markers = this.sessions.get(key);
    if (!markers) return false;
    let changed = false;
    for (const [id, marker] of [...markers]) {
      if (match(id, marker)) changed = markers.delete(id) || changed;
    }
    if (markers.size === 0) this.sessions.delete(key);
    return changed;
  }

  /** An `agent` event. Returns whether anything the rail shows may have changed. */
  onAgent(payload: RawRecord, at: number): boolean {
    const key = str(payload.sessionKey);
    const runId = str(payload.runId);
    if (!key || !runId) return false;
    const data = asRecord(payload.data) ?? {};
    if (payload.stream === "tool") {
      // A failed action of the task's latest run, while it runs.
      const latest = this.runs.get(key);
      const callId = str(data.toolCallId);
      if (data.phase === "result" && callId && latest?.runId === runId) {
        // One entry per call: a result sent again, or replacing an earlier one, replaces it.
        latest.calls.delete(callId);
        if (latest.calls.size < MAX_COUNTED_CALLS) latest.calls.set(callId, data.isError === true);
      }
      return false;
    }
    if (payload.stream !== "lifecycle") return false;
    const ts = time(payload.ts, at);
    switch (data.phase) {
      case "start": {
        const latest = this.runs.get(key);
        if (latest?.runId === runId) return false;
        this.runs.delete(key);
        this.runs.set(key, {
          runId,
          at: ts,
          stopped: false,
          stopSeq: latest?.stopSeq ?? 0,
          calls: new Map(),
          end: null,
        });
        cap(this.runs, MAX_WAITING_SESSIONS);
        return latest?.stopped === true || latest?.end !== null;
      }
      case "waiting-approval": {
        const id = str(data.approvalId) ?? str(data.id) ?? `run:${runId}`;
        return this.add(key, `approval:${id}`, { kind: "approval", runId, since: ts });
      }
      case "approval-resolved": {
        const id = str(data.approvalId) ?? str(data.id);
        return this.remove(key, (markerId, marker) =>
          id ? markerId === `approval:${id}` : marker.kind === "approval" && marker.runId === runId,
        );
      }
      case "end":
      case "error": {
        // An attempt that failed and is retried ends nothing: the run, and what it waits on, go on.
        if (data.phase === "error" && !isDefinitiveLifecycleError(data)) return false;
        // The run is over: nothing of it waits any more.
        const changed = this.remove(key, (_, marker) => marker.runId === runId);
        const latest = this.runs.get(key);
        // An older run's end, arriving after a newer run started, says nothing of the task.
        if (latest && latest.runId !== runId) return changed;
        const reason = classifyLifecycleTerminal(data.phase, data);
        const stopped = reason === "aborted" || reason === "cancelled";
        const end = reason === "completed" ? "completed" : reason === "blocked" ? "blocked" : null;
        this.runs.delete(key);
        this.runs.set(key, {
          runId,
          at: ts,
          stopped,
          stopSeq: stopped ? (this.stops += 1) : (latest?.stopSeq ?? 0),
          // Calls are counted for the run they came with; a run seen only from its end has none.
          calls: latest?.runId === runId ? latest.calls : new Map(),
          end,
        });
        cap(this.runs, MAX_WAITING_SESSIONS);
        return changed || stopped || latest?.stopped === true || end !== null;
      }
      default:
        return false;
    }
  }

  /** `question.requested`. */
  onQuestionRequested(payload: RawRecord, at: number): boolean {
    const key = str(payload.sessionKey);
    const id = str(payload.id);
    if (!key || !id) return false;
    return this.add(key, `question:${id}`, {
      kind: "question",
      runId: str(payload.runId),
      since: time(payload.createdAtMs, at),
    });
  }

  /** `question.resolved`, by id, wherever it was kept. */
  onQuestionResolved(id: unknown): boolean {
    const question = str(id);
    if (!question) return false;
    let changed = false;
    for (const key of [...this.sessions.keys()])
      changed = this.remove(key, (markerId) => markerId === `question:${question}`) || changed;
    return changed;
  }

  /** A pending approval from the gateway's lists at a connect: its task waits, since it was asked. */
  restoreApproval(
    approval: {
      sessionKey: string | null;
      id: string;
      runId: string | null;
      createdAt: number | null;
    },
    at: number,
  ): boolean {
    const key = str(approval.sessionKey);
    const id = str(approval.id);
    if (!key || !id) return false;
    return this.add(key, `approval:${id}`, {
      kind: "approval",
      runId: str(approval.runId),
      since: approval.createdAt ?? at,
    });
  }

  /** An approval's own `*.approval.resolved`, by id, wherever it was kept. */
  onApprovalResolved(id: unknown): boolean {
    const approval = str(id);
    if (!approval) return false;
    let changed = false;
    for (const key of [...this.sessions.keys()])
      changed = this.remove(key, (markerId) => markerId === `approval:${approval}`) || changed;
    return changed;
  }

  /** `question.list` at a connect: the pending questions replace those kept. */
  replaceQuestions(questions: unknown[], at: number): void {
    for (const key of [...this.sessions.keys()])
      this.remove(key, (_, marker) => marker.kind === "question");
    for (const entry of questions) {
      const record = asRecord(entry);
      if (record && (record.status === undefined || record.status === "pending"))
        this.onQuestionRequested(record, at);
    }
  }

  /**
   * The gateway lists the task with no active run, as of `updatedAt`: what it
   * waited on before then is over. A marker newer than the row stays, since the
   * row has not caught up with it yet.
   */
  settle(key: string, updatedAt: number | null): boolean {
    if (updatedAt === null) return false;
    return this.remove(key, (_, marker) => marker.since <= updatedAt);
  }

  /** The engine holds this task's runs: they describe it. Returns whether that changed anything. */
  hold(key: string, task: HeldTask): boolean {
    const id = str(key);
    if (!id || sameHeld(this.held.get(id), task)) return false;
    this.held.delete(id);
    this.held.set(id, task);
    cap(this.held, MAX_WAITING_SESSIONS);
    return true;
  }

  /** The engine let go of the task's runs: the events describe it again. */
  unhold(key: string): boolean {
    return this.held.delete(key);
  }

  /** A new gateway: nothing kept is true of it. */
  clear(): void {
    this.sessions.clear();
    this.runs.clear();
    this.held.clear();
  }

  /** What a task waits on: its held runs' word, else the earliest marker, a question over an approval when equal. */
  waitingFor(key: string): Waiting | null {
    const held = this.held.get(key);
    if (held) return held.waiting;
    const markers = this.sessions.get(key);
    if (!markers || markers.size === 0) return null;
    let first: Marker | null = null;
    for (const marker of markers.values()) {
      if (!first || marker.since < first.since) first = marker;
    }
    return first && { kind: first.kind, since: first.since };
  }

  /**
   * A mark that moves each time a run of the task is seen to end as stopped, on the
   * evidence of that run's own end event: read before and after an action to learn
   * whether a run was stopped meanwhile.
   */
  stopMark(key: string): number {
    return this.runs.get(key)?.stopSeq ?? 0;
  }

  /** The latest run the events reported for a task, by id; null when none was seen. */
  latestRunId(key: string): string | null {
    return this.runs.get(key)?.runId ?? null;
  }

  /**
   * How the task's latest run ended, as far as the rail tells it apart. Stopped
   * is its held runs' word, else the events'. Failed actions (each call once,
   * by its latest result) and blocked (`livenessState: "blocked"`) come from
   * the gateway's events alone, held or not, and only while the task's row is
   * not newer than that end (`rowUpdatedAt`): an old end never overrides newer
   * activity. A run seen only from its end has no failed actions known.
   */
  latestEnd(key: string, rowUpdatedAt: number | null = null): LatestEnd {
    const held = this.held.get(key);
    const latest = this.runs.get(key);
    // An end describes the task only while the task's row is not newer than that end.
    const current =
      latest !== undefined &&
      latest.end !== null &&
      (rowUpdatedAt === null || rowUpdatedAt <= latest.at + ROW_AFTER_END_MS) &&
      !held?.active;
    const failed = current ? [...latest!.calls.values()].filter((isError) => isError).length : 0;
    return {
      stoppedAt: held ? held.stoppedAt : latest?.stopped ? latest.at : null,
      failedActions: current && latest!.end === "completed" ? failed : 0,
      blocked: current && latest!.end === "blocked",
    };
  }

  /** When the task's latest run was stopped, or null when it was not (or a newer run started). */
  stoppedAt(key: string): number | null {
    const held = this.held.get(key);
    if (held) return held.stoppedAt;
    const latest = this.runs.get(key);
    return latest?.stopped ? latest.at : null;
  }
}
