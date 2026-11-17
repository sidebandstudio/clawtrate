// The run engine: turns a task's live `chat` and `agent` events, the user's own
// sends and stops, and its `chat.history` into runs and steps the interface can
// draw. Run states and transitions follow the table in
// docs/research/grok-bot-flows.md §5.6. Every function here is pure apart from
// the raw table, which keeps the exact gateway payloads off the state snapshots.

import type {
  ApprovalAccess,
  ApprovalCard,
  ApprovalKind,
  ApprovalSourceAccess,
} from "./approvals.ts";
import { asRecord, type RawRecord } from "./mapping.ts";

export type RunState =
  "queued" | "running" | "waiting" | "stopping" | "completed" | "stopped" | "failed" | "cancelled";

export const TERMINAL_RUN_STATES: readonly RunState[] = [
  "completed",
  "stopped",
  "failed",
  "cancelled",
];

export function isTerminal(state: RunState): boolean {
  return TERMINAL_RUN_STATES.includes(state);
}

/** A run that is doing or about to do work: running, waiting or stopping. */
export function isActive(state: RunState): boolean {
  return state === "running" || state === "waiting" || state === "stopping";
}

/**
 * A card that blocks the run: an approval the run waits on (`agent` lifecycle
 * `waiting-approval`) or a question from `ask_user` (`question.requested`).
 * Secure Form and Computer cards are not in the capability map.
 */
/**
 * Ids starting `lifecycle:` stand for an approval known only from the run's
 * `waiting-approval` phase; they give way to the approval record once it is seen.
 */
export type PendingCard = { id: string; kind: "approval" | "question"; since: number | null };

export type CardCloseReason =
  /** The gateway reported the approval resolved. */
  | "resolved"
  /** The question was answered. */
  | "answered"
  /** The question was dismissed; the bot carries on without an answer. */
  | "dismissed"
  /** The question timed out; the bot carries on without an answer. */
  | "expired"
  /** Resolved while this client was not watching. */
  | "closed"
  /** "Closed: the run ended". */
  | "run-ended"
  /** "Closed: the run failed". */
  | "run-failed"
  /** "Cancelled": the user pressed Stop. */
  | "cancelled";

export type ClosedCard = PendingCard & { reason: CardCloseReason };

export type StepKind = "tool" | "reasoning";
/** `waiting` is a tool step held by its own pending approval; the approval is not a second step. */
export type StepStatus = "running" | "waiting" | "done" | "failed";

/** A step that has not finished. */
export function isOpenStep(step: Step): boolean {
  return step.status === "running" || step.status === "waiting";
}

/** Display text, capped so long output never bloats every state snapshot. */
export type StepText = { text: string; totalChars: number };

/**
 * Exactly what the gateway sent for a step. Live tool steps keep the `tool`
 * event's `data` at start and at result; steps rebuilt from history keep the
 * transcript's `toolCall` block and `toolResult` row. Reasoning keeps the last
 * `thinking` event, or the transcript's `thinking` block.
 */
export type StepRaw = {
  source: "live" | "history";
  runId: string;
  call: unknown;
  result: unknown;
};

export type Step = {
  /** `tool:<toolCallId>`, or `reasoning:<runId>:<n>`. Unique within a task. */
  id: string;
  kind: StepKind;
  /** Short title derived from the tool name, the same live and from history. */
  title: string;
  /** The tool name exactly as the gateway sent it, for example `sessions_send` or `coder__send_message`. */
  toolName: string | null;
  toolCallId: string | null;
  status: StepStatus;
  startedAt: number | null;
  endedAt: number | null;
  /** Pretty-printed arguments, capped. The exact arguments are in `raw.call`. */
  argsText: StepText | null;
  /** Output while the step runs (tool partial results, command output, reasoning text). */
  output: StepText | null;
  /** The final result text. */
  result: StepText | null;
  error: string | null;
  /** The pending or last approval this tool call waited on. */
  approvalId: string | null;
  /** The tool's own failure kind, for example `overall-timeout` for an exec that ran out of time. */
  failureKind: string | null;
  /** The gateway cut the result (`__openclaw.truncated` on the history row). */
  truncated: boolean;
  /** The gateway marked the result `replaceable`: a later `replace` frame may correct it. */
  replaceable: boolean;
  /**
   * How many times the gateway explicitly corrected this step's finished
   * result (a `replace` frame, or the transcript's canonical copy of a
   * replaceable result). Views that keep state across renders start again
   * from the facts when it changes.
   */
  correction: number;
  /**
   * The raw call and result as known so far, inline when its JSON form is at
   * most `RAW_INLINE_LIMIT` characters (set at the tool's start and again when
   * it finishes). Otherwise null; read it with the client's `stepRaw` (bridge
   * command `readStepRaw`).
   */
  raw: StepRaw | null;
  /** Length of the raw JSON, known once the step has finished. */
  rawSize: number | null;
};

/**
 * How a run failed. `kind` is the gateway's own classification where it sends
 * one (`chat` `errorKind`, for example `timeout`), never parsed from the text.
 */
export type RunError = { message: string; kind: string | null };

/**
 * What the run's terminal lifecycle event said, as sent: `stopReason`, and for
 * a timeout `timeoutPhase` and whether the provider had started.
 */
export type RunEnding = {
  stopReason: string | null;
  timeoutPhase: string | null;
  providerStarted: boolean | null;
  status: string | null;
};

export type Run = {
  /** The gateway's run id, or this client's idempotency key until the gateway answers. */
  id: string;
  /** True once the gateway has named this run. */
  bound: boolean;
  state: RunState;
  /** Who started it: this client, another client or the gateway, or only known from history. */
  origin: "local" | "gateway" | "history";
  /** The outgoing message that started it, while it is in the outbox. */
  messageId: string | null;
  /** The transcript item (the user's message) the run belongs under, once known. */
  anchorItemId: string | null;
  /** Latest preparation phase from `chat` status or `agent` run_status events. */
  phase: string | null;
  model: string | null;
  /** Reply text streaming right now. The durable transcript owns it after the run. */
  text: string;
  /** Which projection the text comes from. The map says a run's text arrives as one or the other. */
  textSource: "chat" | "agent" | null;
  textItemId: string | null;
  /** True once the gateway reported the reply complete. */
  textComplete: boolean;
  steps: Step[];
  pendingCards: PendingCard[];
  /** Cards that were pending when Stop was pressed: closed if the stop takes, restored if it fails. */
  suspendedCards: PendingCard[];
  closedCards: ClosedCard[];
  startedAt: number | null;
  endedAt: number | null;
  error: RunError | null;
  /** When the user pressed Stop. */
  stopRequestedAt: number | null;
  /** "Finished before Stop took effect". */
  finishedBeforeStop: boolean;
  /** Set when the stop request itself failed and the run kept going. */
  stopError: string | null;
  /** Highest per-run `agent` event seq seen, for gap detection. */
  lastSeq: number | null;
  /** The terminal lifecycle or chat event's structured fields, when it carried any. */
  ending: RunEnding | null;
  /**
   * False when the run is known to have ended but nothing established how: a
   * rebuild from history whose rows do not say. The state is then a stand-in.
   */
  outcomeKnown: boolean;
  /** Errors of attempts the gateway retried, newest last, at most `MAX_ATTEMPT_ERRORS`. */
  attemptErrors: string[];
  /**
   * Older finished steps dropped to keep the task within its bounds
   * (`MAX_STEPS_PER_RUN`, the task's activity budget). The transcript still
   * holds them; their raw payloads may no longer be available here.
   */
  omittedSteps: number;
  /** The finished run's reply text was dropped for the same reason; the transcript holds it. */
  textOmitted: boolean;
};

export type OutgoingStatus =
  /** Waiting for the gateway's owner to approve write access. */
  | "awaiting-access"
  /**
   * Held while a question from the run is pending. The gateway would take a
   * plain message as the answer and the asking run would error, so the
   * message goes out as a steer once the question is answered or dismissed.
   */
  | "held"
  /** Held until the active run is terminal. */
  | "queued"
  | "sending"
  /** The gateway accepted it; it leaves the outbox once history has it. */
  | "sent"
  /**
   * The gateway accepted it, but its run has ended and history holds no row
   * tied to it: delivery is not established. It can be retried with the same
   * idempotency key, so the gateway delivers it at most once, or deleted.
   */
  | "unconfirmed"
  | "failed"
  | "cancelled";

export type OutgoingMessage = {
  /** Also the `idempotencyKey`, so a retry can never deliver it twice. */
  id: string;
  text: string;
  /** How it was delivered: a new run, a steer into the active run, or queued after it. */
  mode: "new" | "steer" | "queue";
  status: OutgoingStatus;
  /** The run it started or was steered into. */
  runId: string | null;
  /** `chat.send`'s `messageSeq`, when the gateway returned one. */
  messageSeq: number | null;
  createdAt: number;
  error: string | null;
  /** Files sent with it, without their content. */
  attachments: OutgoingAttachmentInfo[];
};

export type OutgoingAttachmentInfo = { fileName: string; mimeType: string; sizeBytes: number };

export type QuestionOption = { label: string; description: string | null };

export type QuestionItem = {
  /** `questionId`, the key its answer is sent under. */
  id: string;
  header: string;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
  /** Free text is allowed; `ask_user` sets this on every question. */
  allowsOther: boolean;
};

export type QuestionStatus =
  | "pending"
  | "answered"
  /** The user closed it; the bot was told there is no answer. */
  | "dismissed"
  | "expired"
  /** Cancelled because the run was stopped. */
  | "cancelled"
  /** No longer pending on the gateway, and this client did not see how it ended. */
  | "closed";

/** A question card from `ask_user`. */
export type QuestionCard = {
  id: string;
  runId: string | null;
  status: QuestionStatus;
  questions: QuestionItem[];
  createdAt: number | null;
  expiresAt: number | null;
  answers: Record<string, string[]> | null;
  /** An answer or dismissal is on its way. */
  submitting: boolean;
  /** The last answer or dismissal failed. */
  error: string | null;
  /** The `question.requested` record as received. */
  raw: unknown;
};

export type CaughtUp = { reason: "gap" | "reconnect"; at: number };

/** Everything live about one task. */
export type TaskActivity = {
  runs: Run[];
  outbox: OutgoingMessage[];
  questions: QuestionCard[];
  /** Exec, plugin and generic approvals for this task. */
  approvals: ApprovalCard[];
  /** Whether this connection can see approvals. On a read-only connection it cannot, which is not "none". */
  approvalAccess: ApprovalAccess;
  /** Whether each kind's list loaded: one kind failing leaves the others shown, and says so. */
  approvalSources: Record<ApprovalKind, ApprovalSourceAccess>;
  /**
   * Run ids a steer send returned, mapped to the run the steer joined. The
   * gateway settles them at once with an empty final; while the joined run is
   * active their events are ignored.
   */
  steerAliases: Record<string, string>;
  /** Set after the task was reloaded because of an event gap or a reconnect. */
  caughtUp: CaughtUp | null;
};

export const emptyActivity: TaskActivity = {
  runs: [],
  outbox: [],
  questions: [],
  approvals: [],
  approvalAccess: "unavailable",
  approvalSources: { exec: "unavailable", plugin: "unavailable", "system-agent": "unavailable" },
  steerAliases: {},
  caughtUp: null,
};

/** Characters of text a step keeps on the snapshot. The full text stays in the raw table. */
export const MAX_STEP_TEXT = 16_000;
/** Raw payloads up to this JSON length travel inline with the step. */
export const RAW_INLINE_LIMIT = 32_000;
/** JSON characters of raw payloads the host keeps across all tasks; the oldest give way. */
export const MAX_RAW_BYTES = 32 * 1024 * 1024;
/** Finished runs kept per task; active and queued runs are always kept. */
export const MAX_RUNS_PER_TASK = 50;
/** Closed cards kept per run. */
export const MAX_CLOSED_CARDS = 20;
/** Steer aliases kept per task. */
export const MAX_STEER_ALIASES = 50;
/** Settled question cards kept per task; pending ones are always kept. */
export const MAX_SETTLED_QUESTIONS = 20;
/** Settled approvals kept per task; pending ones are always kept. */
export const MAX_SETTLED_APPROVALS = 20;
/** Steps one run keeps; older finished ones give way, counted in `omittedSteps`. Open steps are always kept. */
export const MAX_STEPS_PER_RUN = 256;
/**
 * Characters of activity one task keeps on its snapshot: step text, inline
 * raw payloads, run text, outbox text and approval and question records,
 * counted by `activitySize`. Past it the oldest finished steps give way, then
 * finished runs' reply text. The client lowers it when many tasks are followed,
 * so all of them together stay within `MAX_ACTIVITY_CHARS`.
 */
export const MAX_TASK_ACTIVITY_CHARS = 4_000_000;
/** Characters of activity the client keeps across every task it follows. */
export const MAX_ACTIVITY_CHARS = 64_000_000;

/** Full raw payloads, keyed by task and step id. Owned by the client, never snapshotted. */
export class RawTable {
  private readonly entries = new Map<string, { raw: StepRaw; size: number }>();
  private total = 0;
  private readonly budget: number;

  /** `budget` is the most JSON characters kept; the oldest entries give way first. */
  constructor(budget: number = MAX_RAW_BYTES) {
    this.budget = budget;
  }

  private key(sessionKey: string, stepId: string): string {
    return `${sessionKey}\u0000${stepId}`;
  }

  get(sessionKey: string, stepId: string): StepRaw | null {
    return this.entries.get(this.key(sessionKey, stepId))?.raw ?? null;
  }

  set(sessionKey: string, stepId: string, raw: StepRaw): void {
    const key = this.key(sessionKey, stepId);
    this.drop(key);
    const size = rawSize(raw);
    if (size > this.budget) return;
    this.entries.set(key, { raw, size });
    this.total += size;
    for (const [oldest, entry] of this.entries) {
      if (this.total <= this.budget) break;
      this.entries.delete(oldest);
      this.total -= entry.size;
    }
  }

  private drop(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.total -= entry.size;
  }

  patch(sessionKey: string, stepId: string, patch: Partial<StepRaw>): StepRaw | null {
    const current = this.get(sessionKey, stepId);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.set(sessionKey, stepId, next);
    return next;
  }

  clearTask(sessionKey: string): void {
    const prefix = `${sessionKey}\u0000`;
    for (const key of [...this.entries.keys()]) if (key.startsWith(prefix)) this.drop(key);
  }

  clear(): void {
    this.entries.clear();
    this.total = 0;
  }
}

export type EngineContext = { sessionKey: string; now: number; raw: RawTable };

// Small readers ------------------------------------------------------------------

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const block = asRecord(part);
      return block && block.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .join("");
}

/** Errors are shown in full up to this many characters, like step text. */
export const MAX_ERROR_CHARS = MAX_STEP_TEXT;
/** Attempt errors kept per run. */
export const MAX_ATTEMPT_ERRORS = 5;

export function capError(text: string): string {
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text;
}

function capRunError(error: RunError | null): RunError | null {
  return error && error.message.length > MAX_ERROR_CHARS
    ? { ...error, message: capError(error.message) }
    : error;
}

export function capText(text: string): StepText {
  return {
    text: text.length > MAX_STEP_TEXT ? text.slice(0, MAX_STEP_TEXT) : text,
    totalChars: text.length,
  };
}

/** Append to capped text: past the cap only the count grows, so a long stream stays cheap. */
function appendText(current: StepText | null, delta: string): StepText {
  if (!current) return capText(delta);
  const room = MAX_STEP_TEXT - current.text.length;
  return {
    text: room > 0 ? current.text + delta.slice(0, room) : current.text,
    totalChars: current.totalChars + delta.length,
  };
}

function prettyArgs(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value ?? {}, null, 2) ?? "";
}

/** "coder__send_message" to "Coder Send Message"; "ls" to "Ls". */
export function toolTitle(name: string | null): string {
  if (!name) return "Tool";
  const words = name.split(/[_\s.]+/).filter(Boolean);
  if (words.length === 0) return name;
  return words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ");
}

function rawSize(raw: StepRaw): number {
  try {
    return JSON.stringify(raw).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** When a step finishes, inline its raw payload if it is small enough. */
function settleRaw(step: Step, ctx: EngineContext): Step {
  const raw = ctx.raw.get(ctx.sessionKey, step.id);
  if (!raw) return step;
  const size = rawSize(raw);
  return { ...step, raw: size <= RAW_INLINE_LIMIT ? raw : null, rawSize: size };
}

// Runs -----------------------------------------------------------------------------

export function newRun(
  id: string,
  init: Partial<Run> & Pick<Run, "state" | "origin">,
  now: number | null,
): Run {
  return {
    id,
    bound: false,
    messageId: null,
    anchorItemId: null,
    phase: null,
    model: null,
    text: "",
    textSource: null,
    textItemId: null,
    textComplete: false,
    steps: [],
    pendingCards: [],
    suspendedCards: [],
    closedCards: [],
    startedAt: now,
    endedAt: null,
    error: null,
    stopRequestedAt: null,
    finishedBeforeStop: false,
    stopError: null,
    lastSeq: null,
    ending: null,
    outcomeKnown: true,
    attemptErrors: [],
    omittedSteps: 0,
    textOmitted: false,
    ...init,
  };
}

export function findRun(activity: TaskActivity, runId: string): Run | undefined {
  return activity.runs.find((run) => run.id === runId);
}

/** The task's run that is running, waiting or stopping, if any. */
export function activeRun(activity: TaskActivity): Run | undefined {
  return activity.runs.find((run) => isActive(run.state));
}

function replaceRun(activity: TaskActivity, run: Run): TaskActivity {
  return { ...activity, runs: activity.runs.map((each) => (each.id === run.id ? run : each)) };
}

function updateRun(activity: TaskActivity, runId: string, fn: (run: Run) => Run): TaskActivity {
  const run = findRun(activity, runId);
  if (!run) return activity;
  const next = fn(run);
  return next === run ? activity : replaceRun(activity, next);
}

/**
 * Move a run to a terminal state. A terminal state is final: a run that is
 * already terminal is returned unchanged. Pending cards close with the reason
 * the table gives, and steps still running are closed.
 */
export function finishRun(
  run: Run,
  to: Exclude<RunState, "queued" | "running" | "waiting" | "stopping">,
  ctx: EngineContext,
  error: RunError | null = null,
  endedAt: number | null = ctx.now,
): Run {
  if (isTerminal(run.state)) return run;
  const reason: CardCloseReason =
    to === "failed" ? "run-failed" : to === "completed" ? "run-ended" : "cancelled";
  const steps = run.steps.map((step) => {
    if (!isOpenStep(step)) return step;
    const closed: Step =
      step.kind === "reasoning"
        ? { ...step, status: "done", endedAt }
        : {
            ...step,
            status: "failed",
            endedAt,
            error: step.error ?? "The run ended before this step finished.",
          };
    return settleRaw(closed, ctx);
  });
  return {
    ...run,
    state: to,
    endedAt,
    error: capRunError(error ?? run.error),
    steps,
    pendingCards: [],
    suspendedCards: [],
    closedCards: [
      ...run.closedCards,
      ...[...run.suspendedCards, ...run.pendingCards].map((card) => ({ ...card, reason })),
    ],
    finishedBeforeStop: run.state === "stopping" && to === "completed",
    textComplete: run.textComplete || to === "completed",
  };
}

/** Find or create the run an event belongs to. Runs started elsewhere appear as `running`. */
function ensureRun(activity: TaskActivity, runId: string, ctx: EngineContext): TaskActivity {
  const existing = findRun(activity, runId);
  if (existing)
    return existing.bound ? activity : replaceRun(activity, { ...existing, bound: true });
  const run = newRun(runId, { state: "running", origin: "gateway", bound: true }, ctx.now);
  // Keep queued runs last: they start only after this one.
  const queuedAt = activity.runs.findIndex((each) => each.state === "queued");
  const runs = [...activity.runs];
  runs.splice(queuedAt === -1 ? runs.length : queuedAt, 0, run);
  return { ...activity, runs };
}

/** Close the reasoning segment that is streaming, if any. */
function closeReasoning(run: Run, ctx: EngineContext, at: number | null): Run {
  const last = run.steps.at(-1);
  if (!last || last.kind !== "reasoning" || last.status !== "running") return run;
  return {
    ...run,
    steps: [...run.steps.slice(0, -1), settleRaw({ ...last, status: "done", endedAt: at }, ctx)],
  };
}

function upsertStep(run: Run, step: Step): Run {
  const index = run.steps.findIndex((each) => each.id === step.id);
  if (index === -1) return { ...run, steps: [...run.steps, step] };
  const steps = [...run.steps];
  steps[index] = step;
  return { ...run, steps };
}

// Local actions -------------------------------------------------------------------

/** "User sends with no active run in the task": a new run in `running`, named by the idempotency key. */
export function startLocalRun(
  activity: TaskActivity,
  message: OutgoingMessage,
  now: number,
): TaskActivity {
  const run = newRun(message.id, { state: "running", origin: "local", messageId: message.id }, now);
  const queuedAt = activity.runs.findIndex((each) => each.state === "queued");
  const runs = [...activity.runs];
  runs.splice(queuedAt === -1 ? runs.length : queuedAt, 0, run);
  return { ...activity, runs };
}

/** "Queue after this turn", or a send while the active run is `stopping`. */
export function queueLocalRun(
  activity: TaskActivity,
  message: OutgoingMessage,
  now: number,
): TaskActivity {
  const run = newRun(message.id, { state: "queued", origin: "local", messageId: message.id }, now);
  return { ...activity, runs: [...activity.runs, run] };
}

/** A queued run that is about to be sent goes from `queued` to `running`. */
export function startQueuedRun(activity: TaskActivity, runId: string, now: number): TaskActivity {
  return updateRun(activity, runId, (run) =>
    run.state === "queued" ? { ...run, state: "running", startedAt: now } : run,
  );
}

/** "Cancel" on the chip, or the task was archived or deleted. */
export function cancelQueuedRun(activity: TaskActivity, runId: string, now: number): TaskActivity {
  return updateRun(activity, runId, (run) =>
    run.state === "queued" ? { ...run, state: "cancelled", endedAt: now } : run,
  );
}

/**
 * The gateway named the run a local send started. When events for that id
 * arrived first, they made their own run; fold the local one into it.
 */
export function bindRun(activity: TaskActivity, localId: string, runId: string): TaskActivity {
  const local = findRun(activity, localId);
  if (!local) return activity;
  if (localId === runId)
    return local.bound ? activity : replaceRun(activity, { ...local, bound: true });
  const remote = findRun(activity, runId);
  if (!remote) {
    const renamed = { ...local, id: runId, bound: true };
    return { ...activity, runs: activity.runs.map((run) => (run.id === localId ? renamed : run)) };
  }
  const merged: Run = {
    ...remote,
    origin: "local",
    messageId: local.messageId,
    startedAt: local.startedAt ?? remote.startedAt,
  };
  return {
    ...activity,
    runs: activity.runs
      .filter((run) => run.id !== localId)
      .map((run) => (run.id === runId ? merged : run)),
  };
}

/**
 * A steer the gateway answered with a run id of its own: that run belongs to the
 * message. Its state comes from its own events.
 */
export function adoptRun(
  activity: TaskActivity,
  runId: string,
  messageId: string,
  now: number,
): TaskActivity {
  const existing = findRun(activity, runId);
  if (existing)
    return replaceRun(activity, { ...existing, origin: "local", messageId, bound: true });
  const run = newRun(runId, { state: "running", origin: "local", bound: true, messageId }, now);
  const queuedAt = activity.runs.findIndex((each) => each.state === "queued");
  const runs = [...activity.runs];
  runs.splice(queuedAt === -1 ? runs.length : queuedAt, 0, run);
  return { ...activity, runs };
}

/**
 * Forget a local run whose send never got an answer. Whether the gateway
 * started it is unknown; if it did, its events or history bring it back.
 */
export function dropUnboundRun(activity: TaskActivity, runId: string): TaskActivity {
  const run = findRun(activity, runId);
  if (!run || run.bound || run.origin !== "local") return activity;
  return { ...activity, runs: activity.runs.filter((each) => each !== run) };
}

/** "The gateway refuses to start the run": `running` or `queued` to `failed`, "Couldn't start". */
export function failRunStart(
  activity: TaskActivity,
  runId: string,
  error: RunError,
  ctx: EngineContext,
): TaskActivity {
  return updateRun(activity, runId, (run) => finishRun(run, "failed", ctx, error));
}

/** Clawtrate's turn limit or another client-side failure. */
export function failRun(
  activity: TaskActivity,
  runId: string,
  error: RunError,
  ctx: EngineContext,
): TaskActivity {
  return updateRun(activity, runId, (run) => finishRun(run, "failed", ctx, error));
}

/** "User presses Stop": `running` or `waiting` to `stopping`; pending cards close as cancelled. */
export function requestStop(activity: TaskActivity, runId: string, now: number): TaskActivity {
  return updateRun(activity, runId, (run) => {
    if (run.state !== "running" && run.state !== "waiting") return run;
    return {
      ...run,
      state: "stopping",
      stopRequestedAt: now,
      stopError: null,
      pendingCards: [],
      suspendedCards: [...run.suspendedCards, ...run.pendingCards],
    };
  });
}

/**
 * The stop request itself failed (no write access, or the gateway refused it):
 * the run goes on as it was, `waiting` again with its pending cards restored if
 * it had any. This is the one transition outside the §5.6 table; without it a
 * run would show "Stopping…" forever.
 */
export function revertStop(activity: TaskActivity, runId: string, error: string): TaskActivity {
  return updateRun(activity, runId, (run) =>
    run.state === "stopping"
      ? {
          ...run,
          state: run.suspendedCards.length > 0 ? "waiting" : "running",
          pendingCards: [...run.suspendedCards, ...run.pendingCards],
          suspendedCards: [],
          stopError: error,
        }
      : run,
  );
}

/**
 * A steer joined the active run. The gateway settles the send's own run id at
 * once; remember it so its empty final does not show as a run. A steer leaves
 * pending approvals and questions pending (capability map, run behavior), so
 * the joined run's state does not change here.
 */
export function registerSteerAlias(
  activity: TaskActivity,
  aliasId: string,
  targetId: string,
): TaskActivity {
  if (aliasId === targetId) return activity;
  const runs = activity.runs.filter(
    (run) =>
      !(run.id === aliasId && run.origin === "gateway" && run.steps.length === 0 && !run.text),
  );
  return { ...activity, runs, steerAliases: { ...activity.steerAliases, [aliasId]: targetId } };
}

/** Events for a steer's own run id are dropped while the run it joined is active. */
function isSteerAlias(activity: TaskActivity, runId: string): boolean {
  const target = activity.steerAliases[runId];
  if (!target) return false;
  const run = findRun(activity, target);
  return run !== undefined && !isTerminal(run.state);
}

// Questions -----------------------------------------------------------------------

function mapQuestionItems(value: unknown): QuestionItem[] {
  return (Array.isArray(value) ? value : []).flatMap((entry) => {
    const item = asRecord(entry);
    const id = str(item?.questionId);
    if (!item || !id) return [];
    const options = (Array.isArray(item.options) ? item.options : []).flatMap((option) => {
      const record = asRecord(option);
      const label = str(record?.label);
      return label ? [{ label, description: str(record?.description) }] : [];
    });
    return [
      {
        id,
        header: typeof item.header === "string" ? item.header : "",
        question: typeof item.question === "string" ? item.question : "",
        options,
        multiSelect: item.multiSelect === true,
        allowsOther: item.isOther === true,
      },
    ];
  });
}

function readAnswers(value: unknown): Record<string, string[]> | null {
  const answers = asRecord(asRecord(value)?.answers);
  if (!answers) return null;
  const out: Record<string, string[]> = {};
  for (const [key, list] of Object.entries(answers)) {
    if (Array.isArray(list))
      out[key] = list.filter((each): each is string => typeof each === "string");
  }
  return out;
}

/**
 * `question.requested`, or a pending record from `question.list`: the card
 * shows, and its run goes from `running` to `waiting`.
 */
export function applyQuestionRequested(
  activity: TaskActivity,
  record: RawRecord,
  ctx: EngineContext,
): TaskActivity {
  const id = str(record.id);
  if (!id || (record.status !== undefined && record.status !== "pending")) return activity;
  const runId = str(record.runId);
  const existing = activity.questions.find((question) => question.id === id);
  // A settled question stays settled, and an ended run takes no new question:
  // a late or repeated event must never make either actionable again.
  if (existing && existing.status !== "pending") return activity;
  const known = runId ? findRun(activity, runId) : undefined;
  if (known && isTerminal(known.state)) return activity;
  const card: QuestionCard = {
    id,
    runId,
    status: "pending",
    questions: mapQuestionItems(record.questions),
    createdAt: num(record.createdAtMs),
    expiresAt: num(record.expiresAtMs),
    answers: null,
    submitting: existing?.submitting ?? false,
    error: existing?.error ?? null,
    raw: record,
  };
  let next: TaskActivity = {
    ...activity,
    questions: existing
      ? activity.questions.map((question) => (question.id === id ? card : question))
      : [...activity.questions, card],
  };
  if (!runId) return next;
  const run = findRun(next, runId);
  if (run && (isTerminal(run.state) || run.state === "stopping")) return next;
  next = ensureRun(next, runId, ctx);
  return updateRun(next, runId, (current) => {
    if (current.pendingCards.some((pending) => pending.id === id)) return current;
    return {
      ...current,
      state: "waiting",
      pendingCards: [
        ...current.pendingCards,
        { id, kind: "question", since: card.createdAt ?? ctx.now },
      ],
    };
  });
}

function closeCard(run: Run, cardId: string, reason: CardCloseReason): Run {
  const suspended = run.suspendedCards.find((each) => each.id === cardId);
  if (suspended) {
    return {
      ...run,
      suspendedCards: run.suspendedCards.filter((each) => each !== suspended),
      closedCards: [...run.closedCards, { ...suspended, reason }],
    };
  }
  const card = run.pendingCards.find((pending) => pending.id === cardId);
  if (!card) return run;
  const pendingCards = run.pendingCards.filter((pending) => pending !== card);
  return {
    ...run,
    state: run.state === "waiting" && pendingCards.length === 0 ? "running" : run.state,
    pendingCards,
    closedCards: [...run.closedCards, { ...card, reason }],
  };
}

/**
 * `question.resolved` (or the answer to this client's own `question.resolve`).
 * Answered, dismissed or expired, the bot carries on: the run returns to
 * `running` once no other card is pending. A question cancelled by Stop is
 * already closed as cancelled on its run.
 */
export function applyQuestionResolved(activity: TaskActivity, payload: RawRecord): TaskActivity {
  const id = str(payload.id);
  const question = id ? activity.questions.find((each) => each.id === id) : undefined;
  if (!id || !question) return activity;
  const run = question.runId ? findRun(activity, question.runId) : undefined;
  const stopped = run !== undefined && (run.state === "stopping" || run.state === "stopped");
  const status: QuestionStatus =
    payload.status === "answered"
      ? "answered"
      : payload.status === "expired"
        ? "expired"
        : payload.status === "cancelled"
          ? stopped
            ? "cancelled"
            : "dismissed"
          : "closed";
  let next: TaskActivity = {
    ...activity,
    questions: activity.questions.map((each) =>
      each.id === id
        ? {
            ...each,
            status,
            answers: readAnswers(payload.answers) ?? each.answers,
            submitting: false,
            error: null,
          }
        : each,
    ),
  };
  if (run && status !== "cancelled") {
    const reason: CardCloseReason = status === "closed" ? "closed" : status;
    next = updateRun(next, run.id, (current) => closeCard(current, id, reason));
  }
  return next;
}

/**
 * Questions still pending when their run has ended are no longer actionable:
 * the run cannot take an answer. Idempotent.
 */
export function settleQuestionsOfEndedRuns(activity: TaskActivity): TaskActivity {
  let changed = false;
  const questions = activity.questions.map((question) => {
    if (question.status !== "pending" || !question.runId) return question;
    const run = findRun(activity, question.runId);
    if (!run || !isTerminal(run.state)) return question;
    changed = true;
    return { ...question, status: "closed" as const, submitting: false };
  });
  return changed ? { ...activity, questions } : activity;
}

/** An answer or dismissal is being sent, or failed. */
export function markQuestion(
  activity: TaskActivity,
  id: string,
  patch: Pick<QuestionCard, "submitting" | "error">,
): TaskActivity {
  return {
    ...activity,
    questions: activity.questions.map((question) =>
      question.id === id ? { ...question, ...patch } : question,
    ),
  };
}

/** After a reload: pending questions the gateway no longer lists were settled elsewhere. */
export function settleMissingQuestions(
  activity: TaskActivity,
  pendingIds: Set<string>,
  /** Ids pending when the list was asked for; one that arrived since is never settled by it. */
  pendingBefore?: ReadonlySet<string>,
): TaskActivity {
  let next = activity;
  for (const question of activity.questions) {
    if (
      question.status === "pending" &&
      !pendingIds.has(question.id) &&
      (pendingBefore === undefined || pendingBefore.has(question.id))
    ) {
      next = applyQuestionResolved(next, { id: question.id, status: "closed" });
    }
  }
  return next;
}

// Outbox ---------------------------------------------------------------------------

export function updateMessage(
  activity: TaskActivity,
  id: string,
  patch: Partial<OutgoingMessage>,
): TaskActivity {
  return {
    ...activity,
    outbox: activity.outbox.map((message) =>
      message.id === id ? { ...message, ...patch } : message,
    ),
  };
}

export function removeMessage(activity: TaskActivity, id: string): TaskActivity {
  return { ...activity, outbox: activity.outbox.filter((message) => message.id !== id) };
}

// Live events ---------------------------------------------------------------------

export type ApplyResult = { activity: TaskActivity };

/**
 * A `chat` event for this task. `projectedText` is the visible text of the
 * message snapshot after the client package's stream projection merged deltas.
 */
export function applyChatEvent(
  activity: TaskActivity,
  payload: RawRecord,
  projectedText: string | null,
  ctx: EngineContext,
): TaskActivity {
  const runId = str(payload.runId);
  if (!runId || isSteerAlias(activity, runId)) return activity;
  const existing = findRun(activity, runId);
  if (existing && isTerminal(existing.state)) return activity;
  let next = ensureRun(activity, runId, ctx);
  const state = payload.state;
  next = updateRun(next, runId, (run) => {
    switch (state) {
      case "status":
        return { ...run, phase: str(payload.phase) ?? run.phase };
      case "delta": {
        if (run.textSource === "agent") return run;
        const text = projectedText ?? run.text;
        return closeReasoning({ ...run, textSource: "chat", text }, ctx, ctx.now);
      }
      case "final": {
        const finalText = contentText(asRecord(payload.message)?.content);
        const withText =
          run.textSource === "agent"
            ? run
            : { ...run, textSource: "chat" as const, text: finalText || run.text };
        return finishRun({ ...withText, textComplete: true }, "completed", ctx);
      }
      case "aborted":
        return finishRun({ ...run, ending: endingOf(payload, run.ending) }, "stopped", ctx);
      case "error":
        return finishRun({ ...run, ending: endingOf(payload, run.ending) }, "failed", ctx, {
          message: str(payload.errorMessage) ?? "The run failed.",
          kind: str(payload.errorKind),
        });
      default:
        return run;
    }
  });
  return next;
}

/** An `agent` event for this task. */
export function applyAgentEvent(
  activity: TaskActivity,
  payload: RawRecord,
  ctx: EngineContext,
): ApplyResult {
  const runId = str(payload.runId);
  const stream = str(payload.stream);
  const data = asRecord(payload.data) ?? {};
  if (!runId || !stream || isSteerAlias(activity, runId)) return { activity };
  const existing = findRun(activity, runId);
  const seq = num(payload.seq);
  // A repeated or older frame is dropped. Forward jumps are normal: the gateway
  // coalesces assistant and thinking frames after numbering them, so they are
  // not taken as loss; loss is the connection-level frame gap.
  if (existing && seq !== null && existing.lastSeq !== null && seq <= existing.lastSeq)
    return { activity };
  const replacement = stream === "tool" && data.phase === "result" && data.replace === true;
  if (existing && isTerminal(existing.state) && !replacement) return { activity };

  let next = ensureRun(activity, runId, ctx);
  const ts = num(payload.ts) ?? ctx.now;
  next = updateRun(next, runId, (run) => {
    if (seq !== null && (run.lastSeq === null || seq > run.lastSeq)) run = { ...run, lastSeq: seq };
    switch (stream) {
      case "lifecycle":
        return applyLifecycle(run, data, ts, ctx);
      case "run_status":
        return { ...run, phase: str(data.phase) ?? run.phase };
      case "thinking":
        return applyThinking(run, data, payload, ts, ctx);
      case "assistant":
        return applyAssistant(run, data, ts, ctx);
      case "tool":
        return applyTool(run, data, ts, ctx);
      case "item":
        return applyItem(run, data, ts, ctx);
      case "command_output":
        return applyCommandOutput(run, data);
      default:
        return run;
    }
  });
  return { activity: next };
}

function applyLifecycle(run: Run, data: RawRecord, ts: number, ctx: EngineContext): Run {
  switch (data.phase) {
    case "start":
      return { ...run, startedAt: num(data.startedAt) ?? run.startedAt ?? ts };
    case "model":
      // Each model call starts a new reasoning segment.
      return closeReasoning({ ...run, model: str(data.model) ?? run.model }, ctx, ts);
    case "waiting-approval": {
      if (run.state !== "running" && run.state !== "waiting") return run;
      const id =
        str(data.approvalId) ??
        str(data.id) ??
        `lifecycle:${run.pendingCards.length + run.closedCards.length + 1}`;
      if (run.pendingCards.some((card) => card.id === id)) return { ...run, state: "waiting" };
      return {
        ...run,
        state: "waiting",
        pendingCards: [...run.pendingCards, { id, kind: "approval", since: ts }],
      };
    }
    case "approval-resolved": {
      // Without an id, only a stand-in from `waiting-approval` can be closed here;
      // an approval record is closed by its own resolved event.
      const id = str(data.approvalId) ?? str(data.id);
      const card = id
        ? run.pendingCards.find((each) => each.id === id)
        : run.pendingCards.find((each) => each.id.startsWith("lifecycle:"));
      if (!card) return run;
      const pendingCards = run.pendingCards.filter((each) => each !== card);
      return {
        ...run,
        state: run.state === "waiting" && pendingCards.length === 0 ? "running" : run.state,
        pendingCards,
        closedCards: [...run.closedCards, { ...card, reason: "resolved" }],
      };
    }
    case "end": {
      run = { ...run, ending: endingOf(data, run.ending) };
      return terminalFromLifecycle(run, "end", data, num(data.endedAt) ?? ts, ctx);
    }
    case "error": {
      if (data.aborted !== true && !isDefinitiveLifecycleError(data)) {
        // An attempt failed and the gateway may retry or fall back: the run goes on.
        const message = capError(
          str(data.error) ?? str(asRecord(data.error)?.message) ?? "An attempt failed.",
        );
        return {
          ...run,
          attemptErrors: [...run.attemptErrors, message].slice(-MAX_ATTEMPT_ERRORS),
        };
      }
      run = { ...run, ending: endingOf(data, run.ending) };
      return terminalFromLifecycle(run, "error", data, ts, ctx);
    }
    default:
      return run;
  }
}

const TIMEOUT_PHASES = new Set(["queue", "preflight", "provider", "post_turn", "gateway_draining"]);
const HARD_TIMEOUT_PHASES = new Set(["preflight", "provider", "post_turn"]);

type TerminalReason =
  | "completed"
  | "hard_timeout"
  | "timed_out"
  | "superseded"
  | "cancelled"
  | "aborted"
  | "blocked"
  | "abandoned"
  | "failed";

/**
 * The gateway's own reading of a terminal lifecycle event
 * (`resolveAgentRunLifecycleTerminalFacts` and `resolveAgentRunTerminalFacts`
 * in OpenClaw 2026.10.6), reduced to what the run table needs.
 */
export function classifyLifecycleTerminal(phase: "end" | "error", data: RawRecord): TerminalReason {
  const stopReason = str(data.stopReason);
  const timeoutPhase =
    typeof data.timeoutPhase === "string" && TIMEOUT_PHASES.has(data.timeoutPhase.trim())
      ? data.timeoutPhase.trim()
      : null;
  const status = str(data.status)?.toLowerCase() ?? null;
  const timedOut =
    stopReason === "timeout" ||
    timeoutPhase !== null ||
    status === "timeout" ||
    status === "timed_out";
  const aborted = data.aborted === true || status === "aborted";
  const cancellationStatus =
    status === "cancelled" ||
    status === "canceled" ||
    status === "aborted" ||
    status === "superseded";
  const cancelled = cancellationStatus || aborted;
  const failed =
    phase === "error" || status === "error" || status === "failed" || stopReason === "error";
  const isAbortReason = (value: string | null) => value === "aborted" || value === "restart";
  const isCancelReason = (value: string | null) => value === "rpc" || value === "stop";
  const normalized =
    !timedOut &&
    cancelled &&
    !isAbortReason(stopReason) &&
    !isCancelReason(stopReason) &&
    stopReason !== "superseded" &&
    (stopReason === null || cancellationStatus)
      ? aborted
        ? "aborted"
        : "stop"
      : stopReason;
  const factStatus = timedOut ? "timeout" : cancelled || failed ? "error" : "ok";
  const liveness = str(data.livenessState)?.trim().toLowerCase() ?? null;
  const restart = normalized === "restart";
  const providerStarted = typeof data.providerStarted === "boolean" ? data.providerStarted : null;
  const hardTimeout =
    (timeoutPhase !== null && HARD_TIMEOUT_PHASES.has(timeoutPhase)) ||
    (!restart && factStatus === "timeout" && providerStarted === true);
  const cancelledFact = restart || (factStatus !== "ok" && isCancelReason(normalized));
  if (hardTimeout) return "hard_timeout";
  if (normalized === "superseded") return "superseded";
  if (liveness === "blocked") return "blocked";
  if (isAbortReason(normalized) && !restart) return "aborted";
  if (cancelledFact) return "cancelled";
  if (liveness === "abandoned") return "abandoned";
  if (factStatus === "timeout") return "timed_out";
  if (factStatus === "error") return "failed";
  return "completed";
}

/** A lifecycle error ends the run only when the gateway says it is definitive (`isDefinitiveRunLifecycle`). */
export function isDefinitiveLifecycleError(data: RawRecord): boolean {
  return (
    data.executionSettled === true ||
    data.fallbackExhaustedFailure === true ||
    classifyLifecycleTerminal("error", data) !== "failed"
  );
}

function terminalFromLifecycle(
  run: Run,
  phase: "end" | "error",
  data: RawRecord,
  at: number,
  ctx: EngineContext,
): Run {
  const reason = classifyLifecycleTerminal(phase, data);
  const message =
    str(data.error) ??
    str(asRecord(data.error)?.message) ??
    (phase === "error" ? "The run failed." : null);
  switch (reason) {
    case "completed":
      return finishRun(run, "completed", ctx, null, at);
    case "superseded":
    case "cancelled":
    case "aborted":
      return finishRun(run, "stopped", ctx, null, at);
    case "hard_timeout":
    case "timed_out":
      return finishRun(
        run,
        "failed",
        ctx,
        { message: message ?? "The run timed out.", kind: "timeout" },
        at,
      );
    case "blocked":
    case "abandoned":
    case "failed":
      return finishRun(
        run,
        "failed",
        ctx,
        { message: message ?? "The run failed.", kind: reason },
        at,
      );
  }
}

function endingOf(data: RawRecord, previous: RunEnding | null): RunEnding {
  return {
    stopReason: str(data.stopReason) ?? previous?.stopReason ?? null,
    timeoutPhase: str(data.timeoutPhase) ?? previous?.timeoutPhase ?? null,
    providerStarted:
      typeof data.providerStarted === "boolean"
        ? data.providerStarted
        : (previous?.providerStarted ?? null),
    status: str(data.status) ?? previous?.status ?? null,
  };
}

function applyThinking(
  run: Run,
  data: RawRecord,
  payload: RawRecord,
  ts: number,
  ctx: EngineContext,
): Run {
  const last = run.steps.at(-1);
  const delta = typeof data.delta === "string" ? data.delta : "";
  const cumulative = typeof data.text === "string" ? data.text : null;
  if (last && last.kind === "reasoning" && last.status === "running") {
    const previous = asRecord(asRecord(ctx.raw.get(ctx.sessionKey, last.id)?.call)?.data)?.text;
    const extends_ =
      cumulative === null || typeof previous !== "string" || cumulative.startsWith(previous);
    if (extends_) {
      const output = cumulative !== null ? capText(cumulative) : appendText(last.output, delta);
      ctx.raw.patch(ctx.sessionKey, last.id, { call: payload });
      return upsertStep(run, { ...last, output });
    }
    // The text restarted: a new segment.
    run = closeReasoning(run, ctx, ts);
  }
  const index = run.steps.filter((step) => step.kind === "reasoning").length;
  const id = `reasoning:${run.id}:${index}`;
  ctx.raw.set(ctx.sessionKey, id, { source: "live", runId: run.id, call: payload, result: null });
  return upsertStep(run, {
    id,
    kind: "reasoning",
    title: "Reasoning",
    toolName: null,
    toolCallId: null,
    status: "running",
    startedAt: ts,
    endedAt: null,
    argsText: null,
    output: capText(cumulative ?? delta),
    result: null,
    error: null,
    approvalId: null,
    failureKind: null,
    truncated: false,
    replaceable: false,
    correction: 0,
    raw: null,
    rawSize: null,
  });
}

function applyAssistant(run: Run, data: RawRecord, ts: number, ctx: EngineContext): Run {
  const closed = closeReasoning(run, ctx, ts);
  if (closed.textSource === "chat") return closed;
  const itemId = str(data.itemId);
  const delta = typeof data.delta === "string" ? data.delta : "";
  const cumulative = typeof data.text === "string" ? data.text : null;
  const sameItem = itemId === null || itemId === closed.textItemId;
  const text = cumulative ?? (sameItem ? closed.text + delta : delta);
  return { ...closed, textSource: "agent", textItemId: itemId ?? closed.textItemId, text };
}

function toolStepId(toolCallId: string): string {
  return `tool:${toolCallId}`;
}

function blankToolStep(toolCallId: string, name: string | null, ts: number | null): Step {
  return {
    id: toolStepId(toolCallId),
    kind: "tool",
    title: toolTitle(name),
    toolName: name,
    toolCallId,
    status: "running",
    startedAt: ts,
    endedAt: null,
    argsText: null,
    output: null,
    result: null,
    error: null,
    approvalId: null,
    failureKind: null,
    truncated: false,
    replaceable: false,
    correction: 0,
    raw: null,
    rawSize: null,
  };
}

function applyTool(run: Run, data: RawRecord, ts: number, ctx: EngineContext): Run {
  const toolCallId = str(data.toolCallId);
  if (!toolCallId) return run;
  const id = toolStepId(toolCallId);
  const name = str(data.name);
  const current = closeReasoning(run, ctx, ts);
  const existing = current.steps.find((step) => step.id === id);
  // A finished step takes only an explicit replacement of a result marked replaceable.
  const replacing =
    existing !== undefined &&
    !isOpenStep(existing) &&
    data.phase === "result" &&
    data.replace === true &&
    existing.replaceable;
  if (existing && !isOpenStep(existing) && !replacing) return current;
  const step = existing ?? blankToolStep(toolCallId, name, ts);
  switch (data.phase) {
    case "start": {
      ctx.raw.set(ctx.sessionKey, id, { source: "live", runId: run.id, call: data, result: null });
      // The call is known now; carry it inline while the tool runs when it is small.
      return upsertStep(
        current,
        settleRaw(
          {
            ...step,
            toolName: name ?? step.toolName,
            title: toolTitle(name ?? step.toolName),
            argsText: capText(prettyArgs(data.args)),
          },
          ctx,
        ),
      );
    }
    case "update": {
      const partial = asRecord(data.partialResult);
      const text = contentText(partial?.content);
      return upsertStep(current, { ...step, output: text ? capText(text) : step.output });
    }
    case "result": {
      const { text, details } = toolResultFacts(data);
      const isError = data.isError === true;
      if (!ctx.raw.patch(ctx.sessionKey, id, { result: data })) {
        ctx.raw.set(ctx.sessionKey, id, {
          source: "live",
          runId: run.id,
          call: null,
          result: data,
        });
      }
      const finished: Step = {
        ...step,
        toolName: name ?? step.toolName,
        status: isError ? "failed" : "done",
        endedAt: replacing ? ts : (step.endedAt ?? ts),
        result: capText(text),
        error: isError ? capError(text || "The tool reported an error.") : null,
        failureKind: isError ? str(details?.failureKind) : null,
        truncated: details?.truncated === true,
        replaceable: data.replaceable === true,
        correction: replacing ? step.correction + 1 : step.correction,
      };
      return upsertStep(current, settleRaw(finished, ctx));
    }
    default:
      return current;
  }
}

/**
 * A tool result's text and details in either shipped shape: the ordinary
 * `result: {content, details}`, or the native one with the presentation text
 * in `output` and the details directly in `result`.
 */
function toolResultFacts(data: RawRecord): { text: string; details: RawRecord | null } {
  const result = asRecord(data.result);
  if (Array.isArray(result?.content)) {
    return { text: contentText(result.content), details: asRecord(result.details) };
  }
  const output = data.output;
  const text = typeof output === "string" ? output : contentText(output);
  return { text, details: result };
}

/** `item` frames add the gateway's timing to the tool step they describe. */
function applyItem(run: Run, data: RawRecord, ts: number, ctx: EngineContext): Run {
  if (data.kind !== "tool") return run;
  const toolCallId = str(data.toolCallId);
  if (!toolCallId) return run;
  if (data.phase === "start") run = closeReasoning(run, ctx, ts);
  const existing = run.steps.find((each) => each.id === toolStepId(toolCallId));
  // The item start comes just before the tool start: the step shows from it.
  if (!existing && data.phase !== "start") return run;
  const step = existing ?? blankToolStep(toolCallId, str(data.name), num(data.startedAt));
  return upsertStep(run, {
    ...step,
    startedAt: num(data.startedAt) ?? step.startedAt,
    endedAt: isOpenStep(step) ? step.endedAt : (num(data.endedAt) ?? step.endedAt),
  });
}

/** Exec output, streamed into the step of the call that produced it. */
function applyCommandOutput(run: Run, data: RawRecord): Run {
  if (data.phase !== "delta") return run;
  // The call's own id when the event carries it; otherwise exec's `command:<toolCallId>` item.
  const itemId = str(data.itemId);
  const toolCallId =
    str(data.toolCallId) ??
    (itemId?.startsWith("command:") ? itemId.slice("command:".length) : null);
  if (!toolCallId) return run;
  const step = run.steps.find((each) => each.id === toolStepId(toolCallId));
  if (!step || !isOpenStep(step) || typeof data.output !== "string") return run;
  return upsertStep(run, { ...step, output: appendText(step.output, data.output) });
}

// History ---------------------------------------------------------------------------

function meta(message: RawRecord): RawRecord {
  return asRecord(message["__openclaw"]) ?? {};
}

/** The display id `mapHistory` gives a row, so runs can anchor to transcript items. */
export function historyItemId(message: RawRecord, index: number): string {
  return `${str(meta(message).id) ?? `row-${index}`}:${index}`;
}

function rowTime(message: RawRecord): number | null {
  return num(message.timestamp) ?? num(meta(message).recordTimestampMs);
}

/**
 * Rebuild a task's runs and steps from `chat.history`. Rows are grouped by
 * `__openclaw.runId`. The run in `inFlightRun` is `running`; every other run is
 * terminal, `stopped` or `failed` when its last assistant row says it was
 * aborted or errored, otherwise `completed`.
 */
export function runsFromHistory(
  messages: unknown,
  inFlight: string | RawRecord | null,
  ctx: EngineContext,
): Run[] {
  const snapshot = typeof inFlight === "string" ? { runId: inFlight } : inFlight;
  const inFlightRunId = str(snapshot?.runId);
  const runs = new Map<string, Run>();
  const lastAssistant = new Map<string, RawRecord>();
  /** Runs whose last persisted content is a thinking block: that segment may still be streaming. */
  const trailingThinking = new Map<string, boolean>();
  let anchor: string | null = null;
  const rows = Array.isArray(messages) ? messages : [];

  rows.forEach((entry, index) => {
    const message = asRecord(entry);
    if (!message) return;
    if (message.role === "user") {
      anchor = historyItemId(message, index);
      return;
    }
    // The gateway's injected aborted-partial row names its run in `openclawAbort`.
    const runId = str(meta(message).runId) ?? str(asRecord(message.openclawAbort)?.runId);
    if (!runId) return;
    const at = rowTime(message);
    let run =
      runs.get(runId) ??
      newRun(runId, { state: "running", origin: "history", bound: true, anchorItemId: anchor }, at);
    if (message.role === "assistant") {
      lastAssistant.set(runId, message);
      run = { ...run, model: str(message.model) ?? run.model, endedAt: at ?? run.endedAt };
      const content = Array.isArray(message.content) ? message.content : [];
      if (typeof message.content === "string" && message.content.trim())
        trailingThinking.set(runId, false);
      for (const part of content) {
        const block = asRecord(part);
        if (!block) continue;
        if (block.type === "text" && typeof block.text === "string" && block.text.trim())
          trailingThinking.set(runId, false);
        if (
          block.type === "thinking" &&
          typeof block.thinking === "string" &&
          block.thinking.trim()
        ) {
          trailingThinking.set(runId, true);
          const index = run.steps.filter((step) => step.kind === "reasoning").length;
          const id = `reasoning:${runId}:${index}`;
          ctx.raw.set(ctx.sessionKey, id, { source: "history", runId, call: block, result: null });
          run = upsertStep(
            run,
            settleRaw(
              {
                id,
                kind: "reasoning",
                title: "Reasoning",
                toolName: null,
                toolCallId: null,
                status: "done",
                startedAt: at,
                endedAt: at,
                argsText: null,
                output: capText(block.thinking),
                result: null,
                error: null,
                approvalId: null,
                failureKind: null,
                truncated: false,
                replaceable: false,
                correction: 0,
                raw: null,
                rawSize: null,
              },
              ctx,
            ),
          );
        } else if (block.type === "toolCall" || block.type === "tool_use") {
          const toolCallId = str(block.id);
          if (!toolCallId) continue;
          trailingThinking.set(runId, false);
          const name = str(block.name);
          const id = toolStepId(toolCallId);
          ctx.raw.set(ctx.sessionKey, id, { source: "history", runId, call: block, result: null });
          run = upsertStep(run, {
            ...blankToolStep(toolCallId, name, at),
            argsText: capText(prettyArgs(block.arguments ?? block.input)),
          });
        }
      }
    } else if (message.role === "toolResult" || message.role === "tool") {
      trailingThinking.set(runId, false);
      const toolCallId = str(message.toolCallId) ?? str(message.tool_call_id);
      const step = toolCallId
        ? run.steps.find((each) => each.id === toolStepId(toolCallId))
        : undefined;
      if (step) {
        const text = contentText(message.content);
        const isError = message.isError === true;
        ctx.raw.patch(ctx.sessionKey, step.id, { result: message });
        run = upsertStep(
          run,
          settleRaw(
            {
              ...step,
              status: isError ? "failed" : "done",
              endedAt: at ?? step.startedAt,
              result: capText(text),
              error: isError ? capError(text || "The tool reported an error.") : null,
              failureKind: isError ? str(asRecord(message.details)?.failureKind) : null,
              truncated: meta(message).truncated === true,
            },
            ctx,
          ),
        );
      }
      run = { ...run, endedAt: at ?? run.endedAt };
    }
    runs.set(runId, run);
  });

  // The run in flight: what its rows hold, plus the current progress its
  // snapshot carries (tool and item events, never thinking), replayed by step
  // id so a step the rows already finished is not repeated. A run with no row
  // yet is built from the snapshot alone.
  if (inFlightRunId) {
    let activity: TaskActivity = {
      ...emptyActivity,
      runs: [
        runs.get(inFlightRunId) ??
          newRun(
            inFlightRunId,
            { state: "running", origin: "history", bound: true, anchorItemId: anchor },
            num(snapshot?.startedAt),
          ),
      ],
    };
    for (const entry of Array.isArray(snapshot?.events) ? snapshot.events : []) {
      const event = asRecord(entry);
      if (event)
        activity = applyAgentEvent(activity, { ...event, runId: inFlightRunId }, ctx).activity;
    }
    let run = activity.runs[0]!;
    // A thinking block that is still the run's last activity may be the
    // segment streaming now: it stays open, as the live view has it, so the
    // next cumulative frame continues it rather than starting another.
    const last = run.steps.at(-1);
    if (trailingThinking.get(inFlightRunId) && last?.kind === "reasoning") {
      run = {
        ...run,
        steps: [
          ...run.steps.slice(0, -1),
          { ...last, status: "running", endedAt: null, raw: null, rawSize: null },
        ],
      };
    }
    const text = typeof snapshot?.text === "string" ? snapshot.text : "";
    runs.set(inFlightRunId, text && !run.text ? { ...run, text } : run);
  }

  return [...runs.values()].map((run) => {
    if (run.id === inFlightRunId) return run;
    const last = lastAssistant.get(run.id);
    const stopReason = str(last?.stopReason);
    if (stopReason === "aborted" || asRecord(last?.openclawAbort)?.aborted === true) {
      return finishRun(run, "stopped", ctx, null, run.endedAt);
    }
    if (stopReason === "error") {
      const message = str(last?.errorMessage) ?? "The run failed.";
      return finishRun(run, "failed", ctx, { message, kind: null }, run.endedAt);
    }
    // Only a final reply establishes completion. A last row that stops for a
    // tool, or no reply row at all, says the run ended but not how.
    const finished = finishRun(run, "completed", ctx, null, run.endedAt);
    return stopReason === "stop" || stopReason === "length"
      ? finished
      : { ...finished, outcomeKnown: false };
  });
}

function mergeStep(live: Step, history: Step): { step: Step; source: "live" | "history" } {
  // A finished step beats a running one. Between two finished steps the live
  // one keeps the raw frames the user watched, unless the gateway marked its
  // result replaceable: then the transcript holds the canonical result.
  if ((isOpenStep(live) && !isOpenStep(history)) || (live.replaceable && !isOpenStep(history))) {
    return {
      step: {
        ...history,
        startedAt: live.startedAt ?? history.startedAt,
        // The canonical copy replaced a finished, replaceable result: an explicit correction.
        correction: isOpenStep(live) ? live.correction : live.correction + 1,
      },
      source: "history",
    };
  }
  return {
    step: history.truncated && !live.truncated ? { ...live, truncated: true } : live,
    source: "live",
  };
}

/**
 * Merge one run's steps. Tool steps match by id. Live reasoning segments are
 * split by a heuristic (a model call, a tool, reply text, or text that does
 * not extend the last), so their ids need not match the transcript's
 * `thinking` blocks. Once history holds the finished run and every live tool
 * step, its reasoning replaces the live segments and its order wins. Until
 * then history reasoning is not added. Either way no reasoning text is shown
 * twice, and none is dropped before the transcript has it.
 */
function mergeSteps(live: Step[], history: Run, fromHistory: Set<string>): Step[] {
  const pick = ({ step, source }: { step: Step; source: "live" | "history" }) => {
    if (source === "history") fromHistory.add(step.id);
    return step;
  };
  const historyIds = new Set(history.steps.map((step) => step.id));
  const liveById = new Map(live.map((step) => [step.id, step]));
  const complete =
    isTerminal(history.state) &&
    live.every((step) => step.kind !== "tool" || historyIds.has(step.id)) &&
    (history.steps.some((step) => step.kind === "reasoning") ||
      !live.some((step) => step.kind === "reasoning"));
  if (complete) {
    return history.steps.map((step) => {
      const current = liveById.get(step.id);
      return pick(
        step.kind === "tool" && current ? mergeStep(current, step) : { step, source: "history" },
      );
    });
  }
  const steps = [...live];
  for (const step of history.steps) {
    if (step.kind === "reasoning") continue;
    const index = steps.findIndex((each) => each.id === step.id);
    if (index === -1) steps.push(pick({ step, source: "history" }));
    else steps[index] = pick(mergeStep(steps[index]!, step));
  }
  return steps;
}

export type HistoryMerge = {
  runs: Run[];
  /** Ids of the steps taken from history; their raw payloads replace the live ones. */
  fromHistory: Set<string>;
};

/**
 * Merge a reloaded history into the live runs without duplicating anything.
 * Runs match by id and steps by id. A live terminal state is final. A live
 * run that history shows ended takes history's terminal state, which is how a
 * terminal event lost in a gap is recovered. Pure: the caller commits the raw
 * payloads of the steps reported in `fromHistory`, so a step and its raw
 * lookup always come from the same source.
 */
export function mergeHistoryRuns(live: Run[], history: Run[], ctx: EngineContext): HistoryMerge {
  const liveById = new Map(live.map((run) => [run.id, run]));
  const historyIds = new Set(history.map((run) => run.id));
  const fromHistory = new Set<string>();
  const merged = history.map((fromRun) => {
    const current = liveById.get(fromRun.id);
    if (!current) {
      for (const step of fromRun.steps) fromHistory.add(step.id);
      return fromRun;
    }
    const steps = mergeSteps(current.steps, fromRun, fromHistory);
    let run: Run = {
      ...current,
      steps,
      anchorItemId: fromRun.anchorItemId ?? current.anchorItemId,
      model: current.model ?? fromRun.model,
    };
    if (!isTerminal(current.state) && isTerminal(fromRun.state)) {
      run = {
        ...finishRun(
          run,
          fromRun.state as "completed" | "stopped" | "failed",
          ctx,
          fromRun.error,
          fromRun.endedAt ?? ctx.now,
        ),
        outcomeKnown: fromRun.outcomeKnown,
      };
    }
    return run;
  });
  const runs = [...merged, ...live.filter((run) => !historyIds.has(run.id))].sort(
    (a, b) => Number(a.state === "queued") - Number(b.state === "queued"),
  );
  return { runs, fromHistory };
}

/**
 * Runs that were active before a reload and that the gateway no longer has in
 * flight, with no transcript row, have ended without saying how. They settle
 * (`stopped` if a stop was pending, otherwise `completed`) with
 * `outcomeKnown: false`, so none waits forever.
 */
export function settleVanishedRuns(
  runs: Run[],
  activeBefore: ReadonlySet<string>,
  historyRunIds: ReadonlySet<string>,
  inFlightRunId: string | null,
  ctx: EngineContext,
): Run[] {
  return runs.map((run) => {
    if (!activeBefore.has(run.id) || isTerminal(run.state) || run.state === "queued") return run;
    if (historyRunIds.has(run.id) || run.id === inFlightRunId) return run;
    const settled = finishRun(run, run.state === "stopping" ? "stopped" : "completed", ctx);
    return { ...settled, outcomeKnown: false };
  });
}

const sizes = new WeakMap<object, number>();

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value ?? null)?.length ?? 0;
  } catch {
    return 0;
  }
}

function cached<T extends object>(value: T, measure: (value: T) => number): number {
  let size = sizes.get(value);
  if (size === undefined) {
    size = measure(value);
    sizes.set(value, size);
  }
  return size;
}

function stepSize(step: Step): number {
  return cached(
    step,
    (each) =>
      256 +
      each.title.length +
      (each.argsText?.text.length ?? 0) +
      (each.output?.text.length ?? 0) +
      (each.result?.text.length ?? 0) +
      (each.error?.length ?? 0) +
      (each.raw ? (each.rawSize ?? jsonLength(each.raw)) : 0),
  );
}

function runSize(run: Run): number {
  return cached(run, (each) => {
    let size = 512 + each.text.length + (each.error?.message.length ?? 0);
    for (const message of each.attemptErrors) size += message.length;
    for (const step of each.steps) size += stepSize(step);
    return size;
  });
}

/** The characters a task's activity puts on every snapshot, approximately. */
export function activitySize(activity: TaskActivity): number {
  let size = 0;
  for (const run of activity.runs) size += runSize(run);
  for (const message of activity.outbox) size += 256 + message.text.length;
  for (const approval of activity.approvals)
    size += cached(approval, (a) => 512 + jsonLength(a.raw));
  for (const question of activity.questions)
    size += cached(question, (q) => 256 + jsonLength(q.raw));
  return size;
}

/** Drop the oldest finished steps of a run beyond `keep`, counting them. */
function dropOldSteps(run: Run, excess: number): Run {
  if (excess <= 0) return run;
  let dropped = 0;
  const steps = run.steps.filter((step) => {
    if (dropped >= excess || isOpenStep(step)) return true;
    dropped += 1;
    return false;
  });
  return dropped === 0 ? run : { ...run, steps, omittedSteps: run.omittedSteps + dropped };
}

/** Bring a task under its activity budget: oldest finished steps first, then finished runs' text. */
function fitBudget(runs: Run[], over: number): Run[] {
  let remaining = over;
  const next = [...runs];
  // Finished runs first, oldest first; then the finished steps of active runs.
  const order = [
    ...next.map((run, index) => ({ run, index })).filter(({ run }) => isTerminal(run.state)),
    ...next.map((run, index) => ({ run, index })).filter(({ run }) => !isTerminal(run.state)),
  ];
  for (const { index } of order) {
    if (remaining <= 0) break;
    let run = next[index]!;
    let dropped = 0;
    const steps = run.steps.filter((step) => {
      if (remaining <= 0 || isOpenStep(step)) return true;
      remaining -= stepSize(step);
      dropped += 1;
      return false;
    });
    if (dropped > 0) run = { ...run, steps, omittedSteps: run.omittedSteps + dropped };
    if (remaining > 0 && isTerminal(run.state) && run.text) {
      remaining -= run.text.length;
      run = { ...run, text: "", textOmitted: true };
    }
    next[index] = run;
  }
  return next;
}

/**
 * Bound what a task keeps while it stays open: the newest finished runs, the
 * newest closed cards per run, the newest steer aliases and settled questions,
 * at most `MAX_STEPS_PER_RUN` steps per run, and `budget` characters of
 * activity in all. Anything active, queued or pending is always kept, and
 * every step or text dropped is counted on its run. Idempotent.
 */
export function retainActivity(
  activity: TaskActivity,
  budget: number = MAX_TASK_ACTIVITY_CHARS,
): TaskActivity {
  let changed = false;
  const finished = activity.runs.filter((run) => isTerminal(run.state));
  let runs = activity.runs;
  if (finished.length > MAX_RUNS_PER_TASK) {
    const drop = new Set(finished.slice(0, finished.length - MAX_RUNS_PER_TASK));
    runs = runs.filter((run) => !drop.has(run));
    changed = true;
  }
  if (runs.some((run) => run.closedCards.length > MAX_CLOSED_CARDS)) {
    runs = runs.map((run) =>
      run.closedCards.length > MAX_CLOSED_CARDS
        ? { ...run, closedCards: run.closedCards.slice(-MAX_CLOSED_CARDS) }
        : run,
    );
    changed = true;
  }
  if (runs.some((run) => run.steps.length > MAX_STEPS_PER_RUN)) {
    const capped = runs.map((run) => dropOldSteps(run, run.steps.length - MAX_STEPS_PER_RUN));
    if (capped.some((run, index) => run !== runs[index])) {
      runs = capped;
      changed = true;
    }
  }
  let steerAliases = activity.steerAliases;
  const aliasKeys = Object.keys(steerAliases);
  if (aliasKeys.length > MAX_STEER_ALIASES) {
    steerAliases = Object.fromEntries(
      aliasKeys.slice(-MAX_STEER_ALIASES).map((key) => [key, activity.steerAliases[key]!]),
    );
    changed = true;
  }
  let questions = activity.questions;
  const settled = questions.filter((question) => question.status !== "pending");
  if (settled.length > MAX_SETTLED_QUESTIONS) {
    const drop = new Set(settled.slice(0, settled.length - MAX_SETTLED_QUESTIONS));
    questions = questions.filter((question) => !drop.has(question));
    changed = true;
  }
  let approvals = activity.approvals;
  const settledApprovals = approvals.filter((approval) => approval.status !== "pending");
  if (settledApprovals.length > MAX_SETTLED_APPROVALS) {
    const drop = new Set(
      settledApprovals.slice(0, settledApprovals.length - MAX_SETTLED_APPROVALS),
    );
    approvals = approvals.filter((approval) => !drop.has(approval));
    changed = true;
  }
  const over = activitySize({ ...activity, runs, questions, approvals }) - budget;
  if (over > 0) {
    const fitted = fitBudget(runs, over);
    if (fitted.some((run, index) => run !== runs[index])) {
      runs = fitted;
      changed = true;
    }
  }
  return changed ? { ...activity, runs, steerAliases, questions, approvals } : activity;
}

/** A user row's idempotency key: under `__openclaw`, or on the row itself. */
function rowIdempotencyKey(message: RawRecord): string | null {
  return str(meta(message).idempotencyKey) ?? str(message.idempotencyKey);
}

/**
 * Match outgoing messages to the user rows history now holds, by identifiers
 * only: the row's idempotency key, or the `messageSeq` `chat.send` returned
 * when the row carries no contradicting key. Text is never evidence: a message
 * no identifier ties to a row stays visible, to be retried or deleted, rather
 * than being retired by a look-alike. Matched messages leave the outbox, and
 * their runs anchor to the row.
 */
export function reconcileOutbox(activity: TaskActivity, messages: unknown): TaskActivity {
  const rows = (Array.isArray(messages) ? messages : [])
    .map((entry, index) => ({ message: asRecord(entry), index }))
    .filter((row): row is { message: RawRecord; index: number } => row.message?.role === "user");
  const used = new Set<number>();
  const anchors = new Map<string, string>();
  const outbox = activity.outbox.filter((outgoing) => {
    if (
      outgoing.status !== "sending" &&
      outgoing.status !== "sent" &&
      outgoing.status !== "unconfirmed" &&
      outgoing.status !== "failed"
    ) {
      return true;
    }
    const byKey = rows.find(
      (row) => !used.has(row.index) && rowIdempotencyKey(row.message) === outgoing.id,
    );
    const bySeq =
      byKey ??
      ((outgoing.status === "sent" || outgoing.status === "unconfirmed") &&
      outgoing.messageSeq !== null
        ? rows.find((row) => {
            if (used.has(row.index) || num(meta(row.message).seq) !== outgoing.messageSeq)
              return false;
            const key = rowIdempotencyKey(row.message);
            return key === null || key === outgoing.id;
          })
        : undefined);
    if (!bySeq) return true;
    used.add(bySeq.index);
    anchors.set(outgoing.id, historyItemId(bySeq.message, bySeq.index));
    return false;
  });
  if (outbox.length === activity.outbox.length) return activity;
  const runs = activity.runs.map((run) => {
    const anchor = run.messageId ? anchors.get(run.messageId) : undefined;
    return anchor ? { ...run, messageId: null, anchorItemId: run.anchorItemId ?? anchor } : run;
  });
  return { ...activity, outbox, runs };
}

/** Shown on a message the gateway accepted that history does not hold. */
export const UNCONFIRMED_ERROR =
  "The gateway accepted this message, but its history does not show it. It may not have been delivered.";

/**
 * After a history read: a message the gateway accepted whose run has ended,
 * and that the read did not tie to a row, is `unconfirmed`. Its run ending
 * means history should hold it; without a row nothing establishes delivery.
 */
export function markUnconfirmed(activity: TaskActivity): TaskActivity {
  let changed = false;
  const outbox = activity.outbox.map((message) => {
    if (message.status !== "sent") return message;
    const run = message.runId ? findRun(activity, message.runId) : undefined;
    if (run && !isTerminal(run.state)) return message;
    changed = true;
    return { ...message, status: "unconfirmed" as const, error: UNCONFIRMED_ERROR };
  });
  return changed ? { ...activity, outbox } : activity;
}
