// Which tasks wait for the person, across every bot, for the rail (F-021,
// F-057): a run waits for an approval from its lifecycle's `waiting-approval`
// until `approval-resolved` or the run's end (`agent`, `operator.read`), and
// for an answer from `question.requested` until `question.resolved`, or the
// connect's `question.list` (`operator.questions`). The lifecycle has no
// question phase, so questions are kept by id. Bounded: at most
// `MAX_WAITING_SESSIONS` tasks, `MAX_WAITING_MARKERS` markers each; the oldest
// task gives way. A task the gateway lists with no active run waits for
// nothing, whatever was kept (`waitingFor`).

import { asRecord, type RawRecord } from "./mapping.ts";
import { classifyLifecycleTerminal } from "./runs.ts";

export const MAX_WAITING_SESSIONS = 64;
export const MAX_WAITING_MARKERS = 8;
/** The longest key or id kept (the state's id cap). */
export const MAX_WAITING_ID_CHARS = 1_024;

export type WaitingKind = "approval" | "question";

/** One marker: what is pending, of which run, since when. */
type Marker = { kind: WaitingKind; runId: string | null; since: number };

/** What a task waits on, as the rail says it: the earliest marker. */
export type Waiting = { kind: WaitingKind; since: number };

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_WAITING_ID_CHARS
    ? value
    : null;

export class WaitingIndex {
  /** Session key to its markers by id, in the order tasks began waiting. */
  private readonly sessions = new Map<string, Map<string, Marker>>();
  /**
   * Tasks whose latest run was stopped, and when (F-057): the gateway's row has
   * no status for a run stopped with `chat.abort`, so the lifecycle's end, read
   * as the gateway reads it (`classifyLifecycleTerminal`), says so. Until the
   * task's next run starts; at most `MAX_WAITING_SESSIONS`, the oldest giving way.
   */
  private readonly stopped = new Map<string, number>();

  /** For tests and the retention registry: how many tasks are kept. */
  get size(): number {
    return this.sessions.size;
  }

  private add(key: string, id: string, marker: Marker): boolean {
    let markers = this.sessions.get(key);
    if (!markers) {
      markers = new Map();
      this.sessions.set(key, markers);
      while (this.sessions.size > MAX_WAITING_SESSIONS)
        this.sessions.delete(this.sessions.keys().next().value as string);
    }
    if (markers.has(id)) return false;
    markers.set(id, marker);
    while (markers.size > MAX_WAITING_MARKERS)
      markers.delete(markers.keys().next().value as string);
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

  /** An `agent` event. Returns whether anything changed. */
  onAgent(payload: RawRecord, at: number): boolean {
    const key = str(payload.sessionKey);
    const runId = str(payload.runId);
    if (!key || !runId || payload.stream !== "lifecycle") return false;
    const data = asRecord(payload.data) ?? {};
    switch (data.phase) {
      case "waiting-approval": {
        const id = str(data.approvalId) ?? str(data.id) ?? `run:${runId}`;
        return this.add(key, `approval:${id}`, { kind: "approval", runId, since: at });
      }
      case "approval-resolved": {
        const id = str(data.approvalId) ?? str(data.id);
        return this.remove(key, (markerId, marker) =>
          id ? markerId === `approval:${id}` : marker.kind === "approval" && marker.runId === runId,
        );
      }
      case "start":
        return this.stopped.delete(key);
      case "end":
      case "error": {
        // The run is over: nothing of it waits any more.
        const changed = this.remove(key, (_, marker) => marker.runId === runId);
        const reason = classifyLifecycleTerminal(data.phase, data);
        if (reason !== "aborted" && reason !== "cancelled") return changed;
        this.stopped.delete(key);
        this.stopped.set(key, at);
        while (this.stopped.size > MAX_WAITING_SESSIONS)
          this.stopped.delete(this.stopped.keys().next().value as string);
        return true;
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
      since: typeof payload.createdAtMs === "number" ? payload.createdAtMs : at,
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

  /** A task the gateway lists as idle waits for nothing. */
  settle(key: string): boolean {
    return this.sessions.delete(key);
  }

  /** A new gateway, or a connection that dropped: what was kept may no longer be true. */
  clear(): void {
    this.sessions.clear();
    this.stopped.clear();
  }

  /** When the task's latest run was stopped, or null when it was not (or a run started since). */
  stoppedAt(key: string): number | null {
    return this.stopped.get(key) ?? null;
  }

  /** What a task waits on: the earliest of its markers, a question over an approval when equal. */
  waitingFor(key: string): Waiting | null {
    const markers = this.sessions.get(key);
    if (!markers || markers.size === 0) return null;
    let first: Marker | null = null;
    for (const marker of markers.values()) {
      if (!first || marker.since < first.since) first = marker;
    }
    return first && { kind: first.kind, since: first.since };
  }
}
