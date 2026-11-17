// The run engine: turns a task's live `chat` and `agent` events, the user's own
// sends and stops, and its `chat.history` into runs and steps the interface can
// draw. Run states and transitions follow the table in
// docs/research/grok-bot-flows.md §5.6. Every function here is pure apart from
// the raw table, which keeps the exact gateway payloads off the state snapshots.

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
export type StepStatus = "running" | "done" | "failed";

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
  /** The tool's own failure kind, for example `overall-timeout` for an exec that ran out of time. */
  failureKind: string | null;
  /** The gateway cut the result (`__openclaw.truncated` on the history row). */
  truncated: boolean;
  /**
   * The raw call and result, inline once the step has finished and its JSON
   * form is at most `RAW_INLINE_LIMIT` characters. Otherwise null; read it with
   * the client's `stepRaw` (bridge command `readStepRaw`).
   */
  raw: StepRaw | null;
  /** Length of the raw JSON, known once the step has finished. */
  rawSize: number | null;
};

export type RunError = { message: string; kind: string | null };

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
  /** Highest transcript seq known when it was written; history rows after it may be this message. */
  afterSeq: number;
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
  steerAliases: {},
  caughtUp: null,
};

/** Characters of text a step keeps on the snapshot. The full text stays in the raw table. */
export const MAX_STEP_TEXT = 16_000;
/** Raw payloads up to this JSON length travel inline with the step. */
export const RAW_INLINE_LIMIT = 32_000;

/** Full raw payloads, keyed by task and step id. Owned by the client, never snapshotted. */
export class RawTable {
  private readonly entries = new Map<string, StepRaw>();

  private key(sessionKey: string, stepId: string): string {
    return `${sessionKey}\u0000${stepId}`;
  }

  get(sessionKey: string, stepId: string): StepRaw | null {
    return this.entries.get(this.key(sessionKey, stepId)) ?? null;
  }

  set(sessionKey: string, stepId: string, raw: StepRaw): void {
    this.entries.set(this.key(sessionKey, stepId), raw);
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
    for (const key of [...this.entries.keys()])
      if (key.startsWith(prefix)) this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
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
    closedCards: [],
    startedAt: now,
    endedAt: null,
    error: null,
    stopRequestedAt: null,
    finishedBeforeStop: false,
    stopError: null,
    lastSeq: null,
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
    if (step.status !== "running") return step;
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
    error: error ?? run.error,
    steps,
    pendingCards: [],
    closedCards: [...run.closedCards, ...run.pendingCards.map((card) => ({ ...card, reason }))],
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
      closedCards: [
        ...run.closedCards,
        ...run.pendingCards.map((card) => ({ ...card, reason: "cancelled" as const })),
      ],
    };
  });
}

/**
 * The stop request itself failed (no write access, or the gateway refused it):
 * the run goes on. This is the one transition outside the §5.6 table; without it
 * a run would show "Stopping…" forever.
 */
export function revertStop(activity: TaskActivity, runId: string, error: string): TaskActivity {
  return updateRun(activity, runId, (run) =>
    run.state === "stopping" ? { ...run, state: "running", stopError: error } : run,
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
): TaskActivity {
  let next = activity;
  for (const question of activity.questions) {
    if (question.status === "pending" && !pendingIds.has(question.id)) {
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

export type ApplyResult = { activity: TaskActivity; gap: boolean };

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
        return finishRun(run, "stopped", ctx);
      case "error":
        return finishRun(run, "failed", ctx, {
          message: str(payload.errorMessage) ?? "The run failed.",
          kind: str(payload.errorKind),
        });
      default:
        return run;
    }
  });
  return next;
}

/** An `agent` event for this task. Reports a forward gap in the run's `seq`. */
export function applyAgentEvent(
  activity: TaskActivity,
  payload: RawRecord,
  ctx: EngineContext,
): ApplyResult {
  const runId = str(payload.runId);
  const stream = str(payload.stream);
  const data = asRecord(payload.data) ?? {};
  if (!runId || !stream || isSteerAlias(activity, runId)) return { activity, gap: false };
  const existing = findRun(activity, runId);
  if (existing && isTerminal(existing.state)) return { activity, gap: false };

  let next = ensureRun(activity, runId, ctx);
  const seq = num(payload.seq);
  const ts = num(payload.ts) ?? ctx.now;
  let gap = false;
  next = updateRun(next, runId, (run) => {
    if (seq !== null) {
      if (run.lastSeq !== null && seq > run.lastSeq + 1) gap = true;
      if (run.lastSeq === null || seq > run.lastSeq) run = { ...run, lastSeq: seq };
    }
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
  return { activity: next, gap };
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
        `approval:${run.pendingCards.length + run.closedCards.length + 1}`;
      if (run.pendingCards.some((card) => card.id === id)) return { ...run, state: "waiting" };
      return {
        ...run,
        state: "waiting",
        pendingCards: [...run.pendingCards, { id, kind: "approval", since: ts }],
      };
    }
    case "approval-resolved": {
      const id = str(data.approvalId) ?? str(data.id);
      const index = id ? run.pendingCards.findIndex((card) => card.id === id) : 0;
      const card = run.pendingCards[index === -1 ? 0 : index];
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
      const endedAt = num(data.endedAt) ?? ts;
      if (data.aborted === true) return finishRun(run, "stopped", ctx, null, endedAt);
      return finishRun(run, "completed", ctx, null, endedAt);
    }
    case "error": {
      if (data.aborted === true) return finishRun(run, "stopped", ctx, null, ts);
      const message = str(data.error) ?? str(asRecord(data.error)?.message) ?? "The run failed.";
      return finishRun(run, "failed", ctx, { message, kind: null }, ts);
    }
    default:
      return run;
  }
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
    failureKind: null,
    truncated: false,
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
    failureKind: null,
    truncated: false,
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
  if (existing && existing.status !== "running") return current;
  const step = existing ?? blankToolStep(toolCallId, name, ts);
  switch (data.phase) {
    case "start": {
      ctx.raw.set(ctx.sessionKey, id, { source: "live", runId: run.id, call: data, result: null });
      return upsertStep(current, {
        ...step,
        toolName: name ?? step.toolName,
        title: toolTitle(name ?? step.toolName),
        argsText: capText(prettyArgs(data.args)),
      });
    }
    case "update": {
      const partial = asRecord(data.partialResult);
      const text = contentText(partial?.content);
      return upsertStep(current, { ...step, output: text ? capText(text) : step.output });
    }
    case "result": {
      const result = asRecord(data.result);
      const text = contentText(result?.content);
      const isError = data.isError === true;
      if (!ctx.raw.patch(ctx.sessionKey, id, { result: data })) {
        ctx.raw.set(ctx.sessionKey, id, {
          source: "live",
          runId: run.id,
          call: null,
          result: data,
        });
      }
      const details = asRecord(result?.details);
      const finished: Step = {
        ...step,
        toolName: name ?? step.toolName,
        status: isError ? "failed" : "done",
        endedAt: step.endedAt ?? ts,
        result: capText(text),
        error: isError ? text || "The tool reported an error." : null,
        failureKind: isError ? str(details?.failureKind) : null,
        truncated: details?.truncated === true,
      };
      return upsertStep(current, settleRaw(finished, ctx));
    }
    default:
      return current;
  }
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
    endedAt: step.status === "running" ? step.endedAt : (num(data.endedAt) ?? step.endedAt),
  });
}

/** Exec output, streamed into the step of the call that produced it. */
function applyCommandOutput(run: Run, data: RawRecord): Run {
  const itemId = str(data.itemId);
  if (!itemId?.startsWith("command:") || data.phase !== "delta") return run;
  const step = run.steps.find((each) => each.id === toolStepId(itemId.slice("command:".length)));
  if (!step || step.status !== "running" || typeof data.output !== "string") return run;
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
  inFlightRunId: string | null,
  ctx: EngineContext,
): Run[] {
  const runs = new Map<string, Run>();
  const lastAssistant = new Map<string, RawRecord>();
  let anchor: string | null = null;
  const rows = Array.isArray(messages) ? messages : [];

  rows.forEach((entry, index) => {
    const message = asRecord(entry);
    if (!message) return;
    if (message.role === "user") {
      anchor = historyItemId(message, index);
      return;
    }
    const runId = str(meta(message).runId);
    if (!runId) return;
    const at = rowTime(message);
    let run =
      runs.get(runId) ??
      newRun(runId, { state: "running", origin: "history", bound: true, anchorItemId: anchor }, at);
    if (message.role === "assistant") {
      lastAssistant.set(runId, message);
      run = { ...run, model: str(message.model) ?? run.model, endedAt: at ?? run.endedAt };
      const content = Array.isArray(message.content) ? message.content : [];
      for (const part of content) {
        const block = asRecord(part);
        if (!block) continue;
        if (
          block.type === "thinking" &&
          typeof block.thinking === "string" &&
          block.thinking.trim()
        ) {
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
                failureKind: null,
                truncated: false,
                raw: null,
                rawSize: null,
              },
              ctx,
            ),
          );
        } else if (block.type === "toolCall" || block.type === "tool_use") {
          const toolCallId = str(block.id);
          if (!toolCallId) continue;
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
              error: isError ? text || "The tool reported an error." : null,
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

  return [...runs.values()].map((run) => {
    if (run.id === inFlightRunId) return run;
    const last = lastAssistant.get(run.id);
    const stopReason = str(last?.stopReason);
    if (stopReason === "aborted") return finishRun(run, "stopped", ctx, null, run.endedAt);
    if (stopReason === "error") {
      const message = str(last?.errorMessage) ?? "The run failed.";
      return finishRun(run, "failed", ctx, { message, kind: null }, run.endedAt);
    }
    return finishRun(run, "completed", ctx, null, run.endedAt);
  });
}

function mergeStep(live: Step, history: Step): Step {
  // A finished step beats a running one; between two finished steps, the live
  // one keeps the raw frames the user watched.
  if (live.status === "running" && history.status !== "running") {
    return { ...history, startedAt: live.startedAt ?? history.startedAt };
  }
  return history.truncated && !live.truncated ? { ...live, truncated: true } : live;
}

/**
 * Merge a reloaded history into the live runs without duplicating anything.
 * Runs match by id and steps by id. A live terminal state is final. A live
 * run that history shows ended takes history's terminal state, which is how a
 * terminal event lost in a gap is recovered.
 */
export function mergeHistoryRuns(live: Run[], history: Run[], ctx: EngineContext): Run[] {
  const liveById = new Map(live.map((run) => [run.id, run]));
  const historyIds = new Set(history.map((run) => run.id));
  const merged = history.map((fromHistory) => {
    const current = liveById.get(fromHistory.id);
    if (!current) return fromHistory;
    const steps = [...current.steps];
    for (const step of fromHistory.steps) {
      const index = steps.findIndex((each) => each.id === step.id);
      if (index === -1) steps.push(step);
      else steps[index] = mergeStep(steps[index]!, step);
    }
    let run: Run = {
      ...current,
      steps,
      anchorItemId: fromHistory.anchorItemId ?? current.anchorItemId,
      model: current.model ?? fromHistory.model,
    };
    if (!isTerminal(current.state) && isTerminal(fromHistory.state)) {
      run = finishRun(
        run,
        fromHistory.state as "completed" | "stopped" | "failed",
        ctx,
        fromHistory.error,
        fromHistory.endedAt ?? ctx.now,
      );
    }
    return run;
  });
  return [...merged, ...live.filter((run) => !historyIds.has(run.id))].sort(
    (a, b) => Number(a.state === "queued") - Number(b.state === "queued"),
  );
}

/** The highest transcript seq in a history page. */
export function maxHistorySeq(messages: unknown): number {
  let max = 0;
  for (const entry of Array.isArray(messages) ? messages : []) {
    const seq = num(meta(asRecord(entry) ?? {}).seq);
    if (seq !== null && seq > max) max = seq;
  }
  return max;
}

/**
 * Match outgoing messages to the user rows history now holds. A row matches by
 * `__openclaw.idempotencyKey`, then by the `messageSeq` `chat.send` returned,
 * then by the same text in a row written after the message was. Matched
 * messages leave the outbox, and their runs anchor to the row.
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
      outgoing.status !== "failed"
    ) {
      return true;
    }
    const pick = (test: (row: { message: RawRecord; index: number }) => boolean) =>
      rows.find((row) => !used.has(row.index) && test(row));
    const match =
      pick((row) => str(meta(row.message).idempotencyKey) === outgoing.id) ??
      (outgoing.messageSeq !== null
        ? pick((row) => num(meta(row.message).seq) === outgoing.messageSeq)
        : undefined) ??
      pick((row) => {
        const seq = num(meta(row.message).seq);
        const text = contentText(row.message.content).trim();
        return (
          seq !== null &&
          seq > outgoing.afterSeq &&
          text !== "" &&
          text.includes(outgoing.text.trim())
        );
      });
    if (!match) return true;
    used.add(match.index);
    anchors.set(outgoing.id, historyItemId(match.message, match.index));
    return false;
  });
  if (outbox.length === activity.outbox.length) return activity;
  const runs = activity.runs.map((run) => {
    const anchor = run.messageId ? anchors.get(run.messageId) : undefined;
    return anchor ? { ...run, messageId: null, anchorItemId: run.anchorItemId ?? anchor } : run;
  });
  return { ...activity, outbox, runs };
}
