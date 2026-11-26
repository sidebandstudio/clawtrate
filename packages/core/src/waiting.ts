// Which tasks wait for the person, and whose latest run was stopped or failed,
// across every bot, for the rail (F-021, F-057). One source of truth per task:
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
//   only word for it. So does a message OpenClaw 2026.11.10 fails before any
//   run of it starts (#663): its `chat` error is the only word for that, until a
//   later run of the task starts or ends (#664).
//
// Times are the gateway's own (`ts` on events, `createdAtMs` on questions), so a
// row the gateway lists as idle clears only the markers older than the row.
// Bounded: `MAX_WAITING_SESSIONS` tasks in each map, `MAX_WAITING_MARKERS`
// markers per task, ids at most `MAX_WAITING_ID_CHARS` JSON characters.

import { jsonTextLength } from "./bounds.ts";
import { asRecord, type RawRecord } from "./mapping.ts";
import { neverRan } from "./not-run.ts";
import { classifyLifecycleTerminal, type TaskActivity } from "./runs.ts";

export const MAX_WAITING_SESSIONS = 64;
export const MAX_WAITING_MARKERS = 8;
/** The longest key or id kept, in JSON characters (the state's id cap). */
export const MAX_WAITING_ID_CHARS = 1_024;
/** The longest marker id: an id with its `approval:run:` prefix. */
const MARKER_PREFIX_CHARS = 13;
/** JSON characters one kept marker can take: its id, and its kind, run id and time. */
export const WAITING_MARKER_CHARS =
  MAX_WAITING_ID_CHARS + MARKER_PREFIX_CHARS + MAX_WAITING_ID_CHARS + 64;
/** JSON characters one entry of the latest-run map can take: its key, run id, time, mark and flags. */
export const WAITING_RUN_CHARS = 2 * MAX_WAITING_ID_CHARS + 128;
/** JSON characters one held task can take: its key, a waiting kind and three times. */
export const WAITING_HELD_CHARS = MAX_WAITING_ID_CHARS + 128;

export type WaitingKind = "approval" | "question";

/** One marker: what is pending, of which run, since when. */
type Marker = { kind: WaitingKind; runId: string | null; since: number };

/** What a task waits on, as the rail says it: the earliest marker. */
export type Waiting = { kind: WaitingKind; since: number };

/** A task as its held runs describe it. */
export type HeldTask = {
  waiting: Waiting | null;
  stoppedAt: number | null;
  failedAt: number | null;
};

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 && jsonTextLength(value) <= MAX_WAITING_ID_CHARS
    ? value
    : null;

const time = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** What a held task's runs say: a run waiting on a card, or a latest run that was stopped or failed. */
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
  // Only a message the gateway couldn't run: any other failure its row says itself, and an end it
  // marked not to show is not a failure to mark (#680).
  const failedAt =
    !active && latest && neverRan(latest) ? (latest.endedAt ?? latest.startedAt ?? 0) : null;
  return { waiting, stoppedAt, failedAt };
}

const sameHeld = (a: HeldTask | undefined, b: HeldTask): boolean =>
  a !== undefined &&
  a.stoppedAt === b.stoppedAt &&
  a.failedAt === b.failedAt &&
  a.waiting?.kind === b.waiting?.kind &&
  a.waiting?.since === b.waiting?.since;

/** Keep a map within `max` entries, the oldest giving way. */
function cap<V>(map: Map<string, V>, max: number): void {
  while (map.size > max) map.delete(map.keys().next().value as string);
}

export class WaitingIndex {
  /** Session key to its markers by id, in the order tasks began waiting. */
  private readonly sessions = new Map<string, Map<string, Marker>>();
  /** Each task's latest run as the events report it: its id, when, and whether it was stopped or failed. */
  private readonly runs = new Map<
    string,
    {
      runId: string;
      at: number;
      stopped: boolean;
      stopSeq: number;
      failed: boolean;
      /** Its lifecycle started and hasn't ended: an older run's late end says nothing now. */
      active: boolean;
    }
  >();
  /** Counts the run ends seen as stopped, in the order they arrived: each task keeps its latest. */
  private stops = 0;
  /** Tasks whose runs the engine holds, as those runs describe them; they win over the events. */
  private readonly held = new Map<string, HeldTask>();

  /** The tasks that have a marker: each one waits for the person. */
  keys(): string[] {
    return [...this.sessions.keys()];
  }

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
    if (!key || !runId || payload.stream !== "lifecycle") return false;
    const data = asRecord(payload.data) ?? {};
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
          failed: false,
          active: true,
        });
        cap(this.runs, MAX_WAITING_SESSIONS);
        return latest?.stopped === true || latest?.failed === true;
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
        // The run is over: nothing of it waits any more.
        const changed = this.remove(key, (_, marker) => marker.runId === runId);
        const latest = this.runs.get(key);
        // An older run's end, arriving after a newer run started, says nothing of the task.
        if (latest && latest.runId !== runId) return changed;
        const reason = classifyLifecycleTerminal(data.phase, data);
        const stopped = reason === "aborted" || reason === "cancelled";
        this.runs.delete(key);
        this.runs.set(key, {
          runId,
          at: ts,
          stopped,
          stopSeq: stopped ? (this.stops += 1) : (latest?.stopSeq ?? 0),
          // Its `chat` error may have come first: the same run's lifecycle end keeps it.
          failed: latest?.runId === runId && latest.failed,
          active: false,
        });
        cap(this.runs, MAX_WAITING_SESSIONS);
        return changed || stopped || latest?.stopped === true;
      }
      default:
        return false;
    }
  }

  /**
   * A `chat` event. Its error is the word that the run failed, the only one when the gateway
   * failed the message before any run of it started (OpenClaw 2026.11.10 leaves the row no
   * status then); its final is the word that the run succeeded. Returns whether the rail's word
   * may have changed.
   */
  onChat(payload: RawRecord, at: number): boolean {
    const key = str(payload.sessionKey);
    const runId = str(payload.runId);
    const state = payload.state;
    if (!key || !runId || (state !== "error" && state !== "final")) return false;
    const latest = this.runs.get(key);
    // Another run of the task is going: this is an older run's late end, and the newer one's own
    // end will say how the task stands.
    if (latest && latest.runId !== runId && latest.active) return false;
    // An end the gateway marked not to show is a quiet one, not a failure (#680, 2026.11.10).
    const failed = state === "error" && payload.suppressErrorNotice !== true;
    if (latest?.runId === runId && latest.failed === failed) return false;
    this.runs.delete(key);
    this.runs.set(key, {
      runId,
      at: latest?.runId === runId ? latest.at : at,
      stopped: false,
      stopSeq: latest?.stopSeq ?? 0,
      failed,
      active: false,
    });
    cap(this.runs, MAX_WAITING_SESSIONS);
    return true;
  }

  /**
   * The gateway's row says the task's latest run started at `startedAt`: a failure it reported
   * before then is no longer the task's latest outcome.
   */
  settleFailure(key: string, startedAt: number | null): boolean {
    const latest = this.runs.get(key);
    if (!latest?.failed || startedAt === null || startedAt <= latest.at) return false;
    this.runs.set(key, { ...latest, failed: false });
    return true;
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

  /** When the task's latest run was stopped, or null when it was not (or a newer run started). */
  stoppedAt(key: string): number | null {
    const held = this.held.get(key);
    if (held) return held.stoppedAt;
    const latest = this.runs.get(key);
    return latest?.stopped ? latest.at : null;
  }

  /** When the task's latest run failed, or null when it did not (or a newer run started). */
  failedAt(key: string): number | null {
    const held = this.held.get(key);
    if (held) return held.failedAt;
    const latest = this.runs.get(key);
    return latest?.failed ? latest.at : null;
  }
}
