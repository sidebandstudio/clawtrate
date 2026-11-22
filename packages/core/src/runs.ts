// The run engine: turns a task's live `chat` and `agent` events, the user's own
// sends and stops, and its `chat.history` into runs and steps the interface can
// draw. Run states and transitions follow the table in
// docs/research/grok-bot-flows.md §5.6. Every function here is pure apart from
// the raw table, which keeps the exact gateway payloads off the state snapshots.

import {
  withRecords,
  type ApprovalAccess,
  type ApprovalCard,
  type ApprovalKind,
  type ApprovalSourceAccess,
  type SentRequest,
  type SettlingRecord,
} from "./approvals.ts";
import { projectArgs, projectDetails } from "./actions.ts";
import { asRecord, liveTextFromChatMessage, type RawRecord } from "./mapping.ts";
import { filePathsOf } from "./file-paths.ts";
import { capId, digestOf, extendDigest, jsonLength, sameDigest, type Digest } from "./bounds.ts";
import {
  MAX_CLOSED_CARDS_PER_RUN,
  MAX_ID_CHARS,
  MAX_INLINE_RAW_CHARS,
  MAX_PENDING_QUESTIONS_PER_TASK,
  MAX_PREAMBLES_PER_RUN,
  MAX_TEXT_TAIL,
  MAX_QUESTION_OPTIONS,
  MAX_RUN_LIST,
  MAX_SETTLED_APPROVAL_COUNT,
  MAX_SETTLED_QUESTION_COUNT,
  MAX_QUEUE_ALIAS_COUNT,
  MAX_STEER_ALIAS_COUNT,
  MAX_STEPS_PER_TASK,
  MAX_STOPPED_NAMED,
} from "./state-bounds.ts";

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
/**
 * `waiting` is a tool step held by its own pending approval; the approval is not a second step.
 * `unknown` is a tool step whose run ended before its result arrived here: nothing established
 * how it ended (it may have succeeded, failed or never returned), and history's finished copy
 * replaces it.
 */
export type StepStatus = "running" | "waiting" | "done" | "failed" | "unknown";

/** A step that has not finished. */
export function isOpenStep(step: Step): boolean {
  return step.status === "running" || step.status === "waiting";
}

/** Display text, capped so long output never bloats every state snapshot. */
export type StepText = {
  text: string;
  totalChars: number;
  /**
   * When the text is longer than this app keeps: its last characters, where a
   * tool writes its notices ("[Read output capped …]"), and its line count,
   * read from the whole text as it arrived.
   */
  tail?: string;
  lines?: number;
};

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
  /**
   * A tool step is `tool:<toolCallId>`, the gateway's own id. A reasoning
   * step's id is derived from its place in its run, never from its text
   * (`reasoningStepId`): the run, the nearest tool call before it in the run
   * (or the run's start), and how many reasoning blocks came since that
   * anchor. Live and history compute the same function.
   *
   * Promised: unique within a task. On a resync of the same history window a
   * reasoning card keeps its id whenever the reasoning blocks before it since
   * its anchor are the same in number; a card the live stream showed as one,
   * that history holds as several blocks, keeps its id for the first of them.
   * Not promised: when history shows a reasoning block, since the same anchor,
   * that the live stream never showed on its own, the cards after it there
   * shift by one; nothing across a reopening or a different history window.
   */
  id: string;
  kind: StepKind;
  /** Short title derived from the tool name, the same live and from history. */
  title: string;
  /** The gateway's own English title for the call (`item` events' `title`), as sent; live only. */
  gatewayTitle?: string;
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
  /**
   * The gateway cut this step's text: a history row it came from says so
   * (`__openclaw.truncated`, for tool calls, results and reasoning alike), or
   * its live result did (`details.truncated`). Its whole text is then not
   * known here; `readStepRaw` asks for more and says if it is still cut.
   */
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
   * For a reasoning segment: the length and digest of its whole text, live or
   * persisted, however much of it is displayed. Whether a later cumulative
   * frame continues the segment is decided against this, never against the
   * displayed text. Null for tool steps.
   */
  continuation: Digest | null;
  /** Paths of fields cut to their bound (`bounds.ts`); the transcript or `readStepRaw` holds them whole. */
  cut?: string[];
  /**
   * The raw call and result as known so far, inline when its JSON form is at
   * most `RAW_INLINE_LIMIT` characters (set at the tool's start and again when
   * it finishes). Otherwise null; read it with the client's `stepRaw` (bridge
   * command `readStepRaw`).
   */
  raw: StepRaw | null;
  /** Length of the raw JSON, known once the step has finished. */
  rawSize: number | null;
  /**
   * What the reading of an action (`actions.ts`) needs of the call's
   * arguments: `projectArgs`, at most `MAX_ACTION_FACTS_CHARS`. Absent for
   * reasoning, or when the arguments were not an object.
   */
  args?: Record<string, unknown> | null;
  /**
   * What the reading needs of the result's `details` (`projectDetails`), at
   * most `MAX_ACTION_FACTS_CHARS`. Absent until a result carries details;
   * history keeps them for some tools only.
   */
  details?: Record<string, unknown> | null;
  /** The gateway marked the call as a shell command (`commandBearing` on its item or result). */
  commandBearing?: boolean;
  /**
   * The step's times are its history rows' timestamps (when the message and
   * the result were written), not the call's own start and end, which only
   * the live events report: no duration is read from them.
   */
  rowTimes?: boolean;
  /** Tool steps dropped to keep the run within its bounds directly before this one. */
  omittedBefore?: number;
  /** The gateway cut this step's result text when it stored it (history's `__openclaw.truncated`). */
  resultCut?: boolean;
  /**
   * For a file tool's call (`read`, `write`, `edit`, `apply_patch`): the paths
   * its arguments name, as the gateway's file list reads them, and what its
   * result's details said. Absent for every other step.
   */
  files?: StepFiles;
};

/**
 * The files one file-tool call names. `changed` and `created` are the result's
 * `details.changed` and `details.created` as sent; null until a result says.
 */
export type StepFiles = { paths: string[]; changed: boolean | null; created: boolean | null };

function stepFiles(name: string | null, args: unknown): StepFiles | undefined {
  const paths = filePathsOf(name, args);
  return paths.length > 0 ? { paths, changed: null, created: null } : undefined;
}

/** A finished file step with what its result's details said. */
function settleFiles(step: Step, details: RawRecord | null, isError: boolean): Step {
  if (!step.files) return step;
  const flag = (value: unknown) => (typeof value === "boolean" ? value : null);
  return {
    ...step,
    files: {
      ...step.files,
      changed: isError ? false : flag(details?.changed),
      created: isError ? false : flag(details?.created),
    },
  };
}

/**
 * How a run failed. `kind` is the gateway's own classification where it sends
 * one (`chat` `errorKind`, for example `timeout`), never parsed from the text.
 */
/** Tool calls in a row that time out before this client stops the run (F-101). */
export const TIMEOUTS_IN_A_ROW = 3;

/** Whether a finished tool step ran out of time, as its own result says. */
export function timedOut(step: Step): boolean {
  if (step.kind !== "tool" || step.status === "running") return false;
  const details = step.details as Record<string, unknown> | null | undefined;
  return (
    details?.timedOut === true ||
    (typeof step.failureKind === "string" && /timeout/i.test(step.failureKind))
  );
}

/**
 * How many of a run's latest finished tool calls in a row timed out: counted back from the
 * last one to finish, up to a call that finished in time (F-101). A call still running or
 * waiting for its approval has not finished, so it neither counts nor breaks the count.
 */
export function timeoutsInARow(run: Run): number {
  const finished = run.steps
    .filter((step) => step.kind === "tool" && !isOpenStep(step))
    .sort((a, b) => (a.endedAt ?? a.startedAt ?? 0) - (b.endedAt ?? b.startedAt ?? 0));
  let count = 0;
  for (let i = finished.length - 1; i >= 0 && timedOut(finished[i]!); i -= 1) count += 1;
  return count;
}

/** The run is being stopped because its tool calls kept timing out. */
export function markStoppedForTimeouts(
  activity: TaskActivity,
  runId: string,
  count: number,
): TaskActivity {
  return updateRun(activity, runId, (run) => ({ ...run, stoppedForTimeouts: count }));
}

/** The run passed the "Turn time limit" of that many minutes, and is being stopped (F-100). */
export function markTurnLimit(
  activity: TaskActivity,
  runId: string,
  minutes: number,
): TaskActivity {
  return updateRun(activity, runId, (run) => ({ ...run, turnLimit: minutes }));
}

/**
 * What this client's Stop of a run did to what the run started, each as the gateway said. The
 * recipients come from the run's own record (its `sessions_send` results), however the stop's
 * end reached this client. Processes are not here: the gateway's process list does not say which
 * run started a process, so none is stopped with a run.
 */
export type StoppedWith = {
  /** Helper runs the gateway aborted with it (`chat.abort` `runIds` other than the run's own). */
  helpers: number;
  /** The session keys of other bots' runs this run's messages started, aborted with it. */
  bots: string[];
  /** Session keys of messages to other bots whose run could not be stopped or named. */
  uncertain: string[];
  /** Session keys of recipients' runs whose stop the gateway refused. */
  refused: string[];
  /** Session keys of recipients' runs whose stop got no answer: they may still be going. */
  unanswered: string[];
  /** Names not kept past `MAX_STOPPED_NAMED` of a kind; every one of them was still asked. */
  omitted: number;
  /** The recipients have been asked to stop (once per run). */
  recipientsAsked: boolean;
};

/** A stop's record before anything is known of what it ended: a new one each time. */
const noCompanions = (): StoppedWith => ({
  helpers: 0,
  bots: [],
  uncertain: [],
  refused: [],
  unanswered: [],
  omitted: 0,
  recipientsAsked: false,
});

/** Record what a Stop also ended, or could not end. */
export function noteStoppedWith(
  activity: TaskActivity,
  runId: string,
  change: (current: StoppedWith) => StoppedWith,
): TaskActivity {
  return updateRun(activity, runId, (run) => {
    const next = change(run.stoppedWith ?? noCompanions());
    let omitted = next.omitted;
    const keep = (list: string[]) => {
      omitted += Math.max(0, list.length - MAX_STOPPED_NAMED);
      return list.slice(0, MAX_STOPPED_NAMED);
    };
    return {
      ...run,
      stoppedWith: {
        helpers: next.helpers,
        bots: keep(next.bots),
        uncertain: keep(next.uncertain),
        refused: keep(next.refused),
        unanswered: keep(next.unanswered),
        omitted,
        recipientsAsked: next.recipientsAsked,
      },
    };
  });
}

/**
 * A `/stop` typed in this task stopped these runs: each counts as stopped by this client, so what
 * it started is stopped too, as after Stop.
 */
export function markStopAsked(activity: TaskActivity, runIds: string[], now: number): TaskActivity {
  let next = activity;
  for (const runId of runIds) {
    next = updateRun(requestStop(next, runId, now), runId, (run) =>
      run.state === "stopped" && run.stopRequestedAt === null
        ? { ...run, stopRequestedAt: now }
        : run,
    );
  }
  return next;
}

export type RunError = {
  message: string;
  kind: string | null;
  /**
   * What the gateway sent that said the run failed, named, and its JSON length: the content
   * itself is never in the state. It is kept beside the step payloads (`RawTable`, under
   * `runErrorRawId`) and read with `readRunRaw` when Raw is opened (F-301). Absent when nothing
   * the gateway sent established the failure here (one of this client's own, or one read from
   * history).
   */
  raw?: RunErrorRaw;
};

/** What a failed run's Raw holds (F-301). */
export type RunErrorRaw = {
  /** Exactly what it is: `chat-event`, `lifecycle-data` or `send-answer`. */
  holds: "chat-event" | "lifecycle-data" | "send-answer";
  /** Its JSON length. Past `MAX_RAW_ENTRY_CHARS` it was not kept. */
  chars: number;
};

/** Where a failed run's Raw is kept in the raw table: not a step id, so no step's drop takes it. */
export const runErrorRawId = (runId: string) => `run-error\u0000${runId}`;

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
  /**
   * When the gateway says the run started: its lifecycle start's `startedAt`,
   * else that event's own time, or the history snapshot's. Null until the
   * gateway has reported it; `startedAt` may be this client's own time.
   */
  reportedStartAt: number | null;
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
   * Steps dropped to keep the task within `MAX_STEPS_PER_TASK`, older
   * finished ones first, then the oldest open ones. The gateway's transcript
   * still holds them; their raw payloads are no longer kept here.
   */
  omittedSteps: number;
  /** Of `omittedSteps`, the tool steps: actions the run reported that are not kept. */
  omittedTools?: number;
  /** Tool steps dropped after the last tool step kept: the gap at the run's end. */
  omittedToolsAtEnd?: number;
  /**
   * The run's end time is its last history row's timestamp, not a time the
   * gateway's lifecycle reported: no duration is read from it.
   */
  endFromRows?: boolean;
  /**
   * The anchor the run's next reasoning block is numbered from: `t.<toolCallId>`
   * of the latest tool call, `c` when a history window began inside the run
   * so its start is not visible, or null for the run's start.
   */
  reasoningAnchor: string | null;
  /** Reasoning blocks since `reasoningAnchor`: the next one's number. */
  nextReasoning: number;
  /**
   * Increases each time a reconciliation with history removes, adds or
   * re-anchors any reasoning step id in this run. View state keyed by a
   * reasoning step id of this run (an open card, a selected raw view) is
   * valid only while this is unchanged; when it changes, clear it.
   */
  reasoningRevision: number;
  /**
   * Text the model wrote beside a tool call (`item` of kind `preamble`), in
   * order, newest last, at most `MAX_PREAMBLES_PER_RUN`. Absent until one arrives.
   */
  preambles?: Preamble[];
  /**
   * The id of the request frame of the `chat.send` that started this run, as this client
   * set it: what "Copy request ID" copies and Raw shows (F-301). Absent for a run this
   * client did not start, or whose send's frame has not left.
   */
  requestId?: string;
  /**
   * What stopped with this run when this client stopped it, as the gateway reported each
   * (F-296, F-297, F-298). Absent until a Stop of this client's is confirmed.
   */
  stoppedWith?: StoppedWith;
  /**
   * This client stopped the run because that many of its tool calls in a row timed out
   * (`TIMEOUTS_IN_A_ROW`; F-101). 0 once that stop failed (the gateway refused it): the run goes
   * on, it is not stopped for its timeouts again, and a later Stop is not put down to them.
   * Absent otherwise.
   */
  stoppedForTimeouts?: number;
  /**
   * The run passed the "Turn time limit" (F-100), in minutes, and this client asked the gateway
   * to stop it, as any Stop: it is `stopping` until the gateway confirms. 0 when the limit was
   * reached but did not stop it (no one current run, no write access, or the gateway refused):
   * the limit is not asked again and no later stop is put down to it. Absent otherwise.
   */
  turnLimit?: number;
  /**
   * The gateway is retrying the model request by itself (`run_status` `retrying`): which attempt
   * of how many, and why (`rate_limit`, …). Absent once the model answers again (F-082).
   */
  retry?: { attempt: number; of: number; reason: string | null };
  /** Paths of fields cut to their bound; a cut `text` is not extended by later deltas. */
  cut?: string[];
};

/**
 * Text the model wrote in the same message as a tool call (conversation.md
 * 7.6). It is shown as the bot's bubble directly before the call it came
 * with: the first tool step to start after it, named by its call id, so
 * dropping older steps never moves it.
 */
export type Preamble = {
  /** The gateway's item id. */
  id: string;
  text: string;
  /** The item's `end` arrived: no caret. */
  ended: boolean;
  /**
   * The tool call id of the first tool step to start after it; null until
   * one starts. When that step is dropped to keep the run within its bound,
   * the next kept tool step after it, or null when none follows.
   */
  beforeCall: string | null;
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
  /**
   * Held or queued when a Stop was confirmed: nothing starts by itself after
   * a stop, so it stays here, never sent, until the person sends it (retry)
   * or removes it (delete).
   */
  | "not-sent"
  | "sending"
  /** The gateway accepted it; it leaves the outbox once history has it. */
  | "sent"
  /**
   * The send got no answer: whether the gateway took it is unknown. History is
   * read for its key; it leaves the outbox if history holds it, and becomes
   * `unconfirmed`, with retry and delete, if not.
   */
  | "checking"
  /**
   * The gateway accepted it, but its run has ended and history holds no row
   * tied to it: delivery is not established. It can be retried with the same
   * idempotency key, so the gateway delivers it at most once, or deleted.
   */
  | "unconfirmed"
  /**
   * No answer came, and the history read since does not hold it: whether the
   * gateway took it is not known. Nothing establishes acceptance, so it is
   * never shown as accepted. It can be retried with the same idempotency key,
   * so the gateway delivers it at most once, or deleted; a later history
   * read that holds its key still settles it.
   */
  | "unknown"
  /**
   * The gateway handled it as a command without starting a run (a `/stop`
   * answered `{ok, aborted, runIds}`): nothing more comes of it, and no
   * history row is expected. It can be dismissed.
   */
  | "handled"
  | "failed"
  | "cancelled";

export type OutgoingMessage = {
  /** Also the `idempotencyKey`, so a retry can never deliver it twice. */
  id: string;
  text: string;
  /**
   * How it was delivered: a new run, a steer into the active run, or queued
   * after it. A queued message keeps `queue` once it starts and through every
   * retry, until it starts or is removed, so a start the gateway refuses is
   * told apart from a send that failed however often it is tried again.
   */
  mode: "new" | "steer" | "queue";
  status: OutgoingStatus;
  /** The run it started or was steered into. */
  runId: string | null;
  /** `chat.send`'s `messageSeq`, when the gateway returned one. */
  messageSeq: number | null;
  /**
   * When its `chat.send` frame was handed to the connection, for the attempt
   * under way; null while it waits in this client, in the task's delivery
   * chain or for access. The one record of whether it has left: a confirmed
   * Stop parks every message that has not, whatever its status says.
   */
  leftAt: number | null;
  createdAt: number;
  error: string | null;
  /** Files sent with it, without their content. */
  attachments: OutgoingAttachmentInfo[];
  /** The gateway's id of the message this one replies to (`chat.send` `replyToId`, F-067). */
  replyToId?: string;
  /**
   * Where the gateway put a steer, by its own record; its acknowledgement says neither
   * (docs/research/steer-stop.md). `joined`: the bare `chat` final under the steer's own id
   * came while the run it was sent into went on. `withdrawn`: a Stop's `chat.abort` with that
   * id answered that it cancelled it, so it never runs, and that id cannot be sent again.
   */
  steer?: "joined" | "withdrawn";
};

export type OutgoingAttachmentInfo = { fileName: string; mimeType: string; sizeBytes: number };

/**
 * One option of a question. `index` is its place in the gateway's list and
 * `value` the gateway's own value for it, when it gives one; they identify
 * the option however its label or the list was cut, and an answer names the
 * option by `index`, never by its shown label.
 */
export type QuestionOption = {
  index: number;
  label: string;
  description: string | null;
  value: string | null;
};

/** One answer to a question: text as typed, or a shown option named by its original place. */
export type QuestionAnswer = string | { option: number };

export type QuestionItem = {
  /** `questionId`, the key its answer is sent under. */
  id: string;
  header: string;
  question: string;
  /** The first `MAX_QUESTION_OPTIONS` options, each with its original place. */
  options: QuestionOption[];
  /** Options the gateway sent past `MAX_QUESTION_OPTIONS`, not shown. */
  optionsOmitted: number;
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
  /**
   * Every question in the record is an ordinary ask-user question
   * (`isOrdinaryQuestionRecord`), decided on the whole record when the card
   * was admitted, before anything was cut. Only such a card is answerable as
   * options and text; any other is shown readable.
   */
  ordinary: boolean;
  /** The answer or dismissal this client sent (`question.resolve`), as sent. */
  sent: SentRequest | null;
  /** The records the gateway sent that settled it, by source: `question.resolved`, the reply. */
  settledBy: SettlingRecord[];
  /** Paths of fields cut to their bound. A cut option label is answered with its full text, read again. */
  cut?: string[];
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
   * Run ids a steer send returned, mapped to the run the steer was sent into.
   * Tentative: a steer the gateway joins to that run is acknowledged by one bare
   * `chat final` under its own id, which is dropped; any event showing a run of
   * its own (lifecycle, reasoning, text, a tool, or a final with a message)
   * removes the alias, and the steer is a run of its own. History is never read
   * through these.
   */
  steerAliases: Record<string, string>;
  /**
   * The gateway's own run id for a turn it ran from its queue, mapped to the
   * send's run id that the turn's lifecycle and end carry: the two are one run.
   * Learned from `sessions.changed` (`runId` beside `clientRunId`) or from
   * history (a user row keyed `<send id>:user` followed by rows under the
   * gateway's id). Applied for as long as it is kept: a late frame under the
   * gateway's id updates the one run, and history rows under it are that run's.
   */
  queueAliases: Record<string, string>;
  /** Set after the task was reloaded because of an event gap or a reconnect. */
  caughtUp: CaughtUp | null;
  /**
   * Pending questions not kept because the task already holds
   * `MAX_PENDING_QUESTIONS_PER_TASK`; the next `question.list` read brings
   * them back once one settles.
   */
  questionsOmitted: number;
  /** Runs started elsewhere not kept because the task held `MAX_RUN_LIST` runs. */
  runsOmitted: number;
};

export const emptyActivity: TaskActivity = {
  runs: [],
  outbox: [],
  questions: [],
  approvals: [],
  approvalAccess: "unavailable",
  approvalSources: { exec: "unavailable", plugin: "unavailable", "system-agent": "unavailable" },
  steerAliases: {},
  queueAliases: {},
  caughtUp: null,
  questionsOmitted: 0,
  runsOmitted: 0,
};

/**
 * Characters of text a step keeps on the snapshot; the full text stays in the
 * raw table. Within `MAX_STEP_BODY_CHARS` JSON characters unless the text is
 * heavily escaped, when the schema cuts it further.
 */
export const MAX_STEP_TEXT = 2_000;
/** Raw payloads up to this JSON length travel inline with the step. */
export const RAW_INLINE_LIMIT = MAX_INLINE_RAW_CHARS;
/** JSON characters of raw payloads the host keeps across all tasks; the oldest give way. */
export const MAX_RAW_BYTES = 32 * 1024 * 1024;
/** One raw payload the host keeps; a larger one is not kept, and `readStepRaw` reads it from history once history holds it. */
export const MAX_RAW_ENTRY_CHARS = 262_144;
/** Finished runs kept per task. */
export const MAX_RUNS_PER_TASK = 16;
/** Closed cards kept per run. */
export const MAX_CLOSED_CARDS = MAX_CLOSED_CARDS_PER_RUN;
/** Steer aliases kept per task. */
export const MAX_STEER_ALIASES = MAX_STEER_ALIAS_COUNT;
/** Queue aliases kept per task, the newest. */
export const MAX_QUEUE_ALIASES = MAX_QUEUE_ALIAS_COUNT;
/** Settled question cards kept per task. */
export const MAX_SETTLED_QUESTIONS = MAX_SETTLED_QUESTION_COUNT;
/** Settled approvals kept per task. */
export const MAX_SETTLED_APPROVALS = MAX_SETTLED_APPROVAL_COUNT;
/**
 * Steps one run keeps, and one task keeps across its runs
 * (`MAX_STEPS_PER_TASK`): older finished ones give way first, then the
 * oldest open ones, every one counted in `omittedSteps`.
 */
export const MAX_STEPS_PER_RUN = MAX_STEPS_PER_TASK;
export { MAX_STEPS_PER_TASK };

/**
 * A step's whole raw call and result, read on demand (`readStepRaw`), or why
 * it cannot be read yet. A step whose payload was too large for the raw table
 * is readable once the gateway's history holds it; until then it is
 * `not-available-yet`, never presented as recoverable.
 */
/**
 * A failed run's Raw, read when it is opened (`readRunRaw`, F-301): what the gateway sent that
 * failed it, as received and named by what it is; or that it was too large to keep; or that it
 * is not kept here, which never says whether the gateway sent anything.
 */
export type RunRawRead =
  | { status: "available"; holds: RunErrorRaw["holds"]; payload: unknown }
  | { status: "too-large"; holds: RunErrorRaw["holds"]; chars: number; limit: number }
  | { status: "not-kept"; holds: RunErrorRaw["holds"] | null };

export type StepRead =
  | { status: "available"; raw: StepRaw }
  | { status: "not-available-yet"; reason: string }
  /**
   * History holds the step, but the gateway cut its row to a display length
   * even at the length asked for (`__openclaw.truncated`): `raw` is what it
   * sent, the beginning of what it stored with the gateway's own marker after
   * it, and `receivedChars` the length of the longest text the rebuilt step
   * exposes (its arguments, output or result), not of the raw payload.
   */
  | { status: "cut-by-gateway"; raw: StepRaw; receivedChars: number; reason: string }
  /**
   * History returned something at this step's place, but nothing shows it is
   * this step (a reasoning text that does not begin with the step's own, a
   * different call id): it is not offered as the step's text.
   */
  | { status: "not-established"; reason: string }
  /**
   * The gateway replaced the message that holds this step with its
   * oversized placeholder (a message above its 131,072-byte limit): it will
   * not return this text in full, so asking again does not help.
   */
  | { status: "too-large-for-gateway"; reason: string };

/** Full raw payloads, keyed by task and step id. Owned by the client, never snapshotted. */
export class RawTable {
  private readonly entries = new Map<string, { task: string; raw: StepRaw; size: number }>();
  private readonly perTask = new Map<string, number>();
  private sum = 0;
  private readonly budget: number;
  private readonly entryMax: number;

  /**
   * `budget` is the most JSON characters kept, the oldest entries giving way
   * first; one entry larger than `entryMax` is not kept. A table built aside
   * for one read, and dropped after it, may take both as unbounded.
   */
  constructor(budget: number = MAX_RAW_BYTES, entryMax: number = MAX_RAW_ENTRY_CHARS) {
    this.budget = budget;
    this.entryMax = entryMax;
  }

  /** Keys pass the id cap, so a long id is kept and looked up as the same short value as in the state. */
  private key(sessionKey: string, stepId: string): string {
    return `${capId(sessionKey, MAX_ID_CHARS)}\u0000${capId(stepId, MAX_ID_CHARS)}`;
  }

  get(sessionKey: string, stepId: string): StepRaw | null {
    return this.entries.get(this.key(sessionKey, stepId))?.raw ?? null;
  }

  set(sessionKey: string, stepId: string, raw: StepRaw): void {
    const key = this.key(sessionKey, stepId);
    this.drop(key);
    const size = rawSize(raw);
    if (size > this.budget || size > this.entryMax) return;
    const task = capId(sessionKey, MAX_ID_CHARS);
    this.entries.set(key, { task, raw, size });
    this.charge(task, size);
    for (const [oldest] of this.entries) {
      if (this.sum <= this.budget) break;
      this.drop(oldest);
    }
  }

  private charge(task: string, size: number): void {
    this.sum += size;
    const next = (this.perTask.get(task) ?? 0) + size;
    if (next === 0) this.perTask.delete(task);
    else this.perTask.set(task, next);
  }

  private drop(key: string): number {
    const entry = this.entries.get(key);
    if (!entry) return 0;
    this.entries.delete(key);
    this.charge(entry.task, -entry.size);
    return entry.size;
  }

  patch(sessionKey: string, stepId: string, patch: Partial<StepRaw>): StepRaw | null {
    const current = this.get(sessionKey, stepId);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.set(sessionKey, stepId, next);
    return next;
  }

  /** JSON characters held, in all and for one task. */
  get total(): number {
    return this.sum;
  }

  usage(sessionKey: string): number {
    return this.perTask.get(capId(sessionKey, MAX_ID_CHARS)) ?? 0;
  }

  /** Keep of a task's payloads only those under these ids: its retained steps and failed runs. */
  retainTask(sessionKey: string, ids: Iterable<string>): void {
    const task = capId(sessionKey, MAX_ID_CHARS);
    const kept = new Set(Array.from(ids, (id) => this.key(sessionKey, id)));
    for (const [key, entry] of this.entries) {
      if (entry.task === task && !kept.has(key)) this.drop(key);
    }
  }

  clearTask(sessionKey: string): void {
    const task = capId(sessionKey, MAX_ID_CHARS);
    for (const [key, entry] of [...this.entries]) if (entry.task === task) this.drop(key);
  }

  clear(): void {
    this.entries.clear();
    this.perTask.clear();
    this.sum = 0;
  }
}

export type EngineContext = {
  sessionKey: string;
  now: number;
  raw: RawTable;
};

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
  if (!error) return error;
  const capped =
    error.message.length > MAX_ERROR_CHARS ? { ...error, message: capError(error.message) } : error;
  return capped;
}

/**
 * Keep what the gateway sent that failed the run, whole, beside the step payloads, and name it
 * for the state (F-301). One larger than a raw entry is not kept, and its Raw says so.
 */
function rawEvent(
  ctx: EngineContext,
  runId: string,
  holds: RunErrorRaw["holds"],
  payload: RawRecord,
): RunErrorRaw {
  ctx.raw.set(ctx.sessionKey, runErrorRawId(runId), {
    source: "live",
    runId,
    call: payload,
    result: null,
  });
  return { holds, chars: jsonLength(payload) };
}

export function capText(text: string): StepText {
  if (text.length <= MAX_STEP_TEXT) return { text, totalChars: text.length };
  return {
    text: text.slice(0, MAX_STEP_TEXT),
    totalChars: text.length,
    tail: text.slice(-MAX_TEXT_TAIL),
    lines: text.replace(/\n$/, "").split("\n").length,
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
    reportedStartAt: null,
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
    reasoningAnchor: null,
    nextReasoning: 0,
    reasoningRevision: 0,
    ...init,
  };
}

export function findRun(activity: TaskActivity, runId: string): Run | undefined {
  return activity.runs.find((run) => run.id === runId);
}

/**
 * Whether the run has a question pending, by the question records as well as
 * the run's cards, so a plain message is never sent while the gateway would
 * take it as the answer. A pending question holds every outgoing message, and
 * this is the one definition of it: the engine and the interface both use it.
 */
export function questionPending(activity: TaskActivity, run?: Run): boolean {
  return (
    activity.questions.some((question) => question.status === "pending") ||
    (run !== undefined &&
      [...run.pendingCards, ...run.suspendedCards].some((card) => card.kind === "question"))
  );
}

/**
 * The run Stop aborts, or null when no one current run is established. A steer's or a queued
 * turn's own run id stands for the run it belongs to; every active run is counted the same way,
 * so a steer the gateway acknowledged under an id of its own is not a second candidate. With two
 * runs active and nothing tying them (an older run whose end a reconnect missed, beside the one
 * the gateway runs now), Stop is withheld until the gateway establishes which one is current.
 */
export function runningRunId(activity: TaskActivity, asked: string): string | null {
  const canonical = (id: string) => activity.steerAliases[id] ?? activity.queueAliases[id] ?? id;
  const direct = canonical(asked);
  const active = new Set(
    activity.runs.filter((run) => isActive(run.state)).map((run) => canonical(run.id)),
  );
  return active.size === 1 && active.has(direct) ? direct : null;
}

/** The task's run that is running, waiting or stopping, if any. */
export function activeRun(activity: TaskActivity): Run | undefined {
  return activity.runs.find((run) => isActive(run.state));
}

function replaceRun(activity: TaskActivity, run: Run): TaskActivity {
  return { ...activity, runs: activity.runs.map((each) => (each.id === run.id ? run : each)) };
}

/** The request frame that started a run left with this id (F-301). */
export function noteRunRequest(
  activity: TaskActivity,
  runId: string,
  requestId: string,
): TaskActivity {
  return updateRun(activity, runId, (run) => ({
    ...run,
    requestId: capId(requestId, MAX_ID_CHARS),
  }));
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
        : { ...step, status: "unknown", endedAt };
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

/**
 * A run whose end this client inferred (`outcomeKnown: false`: nothing showed how it ended),
 * taken back to where it stood before that inference, so that the end the gateway sends or
 * stores settles it as it really ended: `stopping` if a Stop was asked, otherwise
 * `running`. A run whose end is known is returned as it is.
 */
export function reopenInferred(run: Run): Run {
  if (!isTerminal(run.state) || run.outcomeKnown) return run;
  return {
    ...run,
    state: run.stopRequestedAt !== null ? "stopping" : "running",
    endedAt: null,
    outcomeKnown: true,
    finishedBeforeStop: false,
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

/**
 * A step text cut to its bound is named in the step's `cut` at the first cut,
 * however it was cut (the engine's character cap or the schema's), so the
 * interface can always tell that the whole text is elsewhere.
 */
function flagCutTexts(step: Step): Step {
  const known = step.cut ?? [];
  const missing = (["argsText", "output", "result"] as const)
    .filter((field) => {
      const value = step[field];
      return value !== null && value.text.length < value.totalChars;
    })
    .map((field) => `${field}.text`)
    .filter((path) => !known.includes(path));
  return missing.length === 0 ? step : { ...step, cut: [...known, ...missing] };
}

function upsertStep(run: Run, written: Step): Run {
  const step = flagCutTexts(written);
  const index = run.steps.findIndex((each) => each.id === step.id);
  if (index === -1) {
    // A new tool call is the anchor the reasoning after it is numbered from.
    const anchor = step.kind === "tool" && step.toolCallId ? toolAnchor(step.toolCallId) : null;
    const anchored =
      anchor !== null && anchor !== run.reasoningAnchor
        ? { reasoningAnchor: anchor, nextReasoning: 0 }
        : {};
    // Text written before this call, still waiting for its call, is this call's.
    const preambles =
      step.kind === "tool" && step.toolCallId && run.preambles?.some((p) => p.beforeCall === null)
        ? run.preambles.map((p) =>
            p.beforeCall === null ? { ...p, beforeCall: step.toolCallId } : p,
          )
        : run.preambles;
    return {
      ...run,
      ...anchored,
      ...(preambles ? { preambles } : {}),
      steps: [...run.steps, step],
    };
  }
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

/**
 * A send whose outcome is not known (no answer, the connection dropped, or an
 * acceptance that named no run): its optimistic run goes, unless the person has
 * asked to stop it. That run stays `stopping`, unnamed, so the Stop is not
 * forgotten: a history read names it (then it is stopped) or settles it
 * (`settleUnboundStops`).
 */
export function dropUnboundRunUnlessStopping(activity: TaskActivity, runId: string): TaskActivity {
  return findRun(activity, runId)?.state === "stopping"
    ? activity
    : dropUnboundRun(activity, runId);
}

/**
 * After a history read, the runs the person asked to stop before the gateway
 * named them, whose send is no longer awaiting its answer: one the gateway has
 * in flight under the send's id is now named (and is to be stopped); one
 * history holds is settled by the merge; one nothing shows is settled as
 * stopped with no known outcome, keeping `stopRequestedAt`, so a later read
 * that finds it in flight still stops it.
 */
export function settleUnboundStops(
  runs: Run[],
  inFlightRunId: string | null,
  historyRunIds: ReadonlySet<string>,
  awaitingAnswer: ReadonlySet<string>,
  ctx: EngineContext,
): Run[] {
  return runs.map((run) => {
    if (run.bound || run.state !== "stopping" || run.origin !== "local") return run;
    if (run.id === inFlightRunId) return { ...run, bound: true };
    if (historyRunIds.has(run.id) || awaitingAnswer.has(run.id)) return run;
    return { ...finishRun(run, "stopped", ctx), outcomeKnown: false };
  });
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
          stopRequestedAt: null,
          ...(run.turnLimit === undefined ? {} : { turnLimit: 0 }),
          stopError: error,
        }
      : run,
  );
}

/**
 * A steer was sent into the active run, and the gateway answered with a run id
 * of the steer's own. Whether it joined that run is known only from what comes
 * under that id (`steerOwnRun`); until then its bare acknowledgement is not
 * shown as a run. A steer leaves pending approvals and questions pending
 * (capability map, run behavior), so the joined run's state does not change here.
 */
export function registerSteerAlias(
  activity: TaskActivity,
  aliasId: string,
  targetId: string,
): TaskActivity {
  if (aliasId === targetId) return activity;
  // Its events or a history read may have come first: a run showing something of its own is its
  // own run, and no alias is recorded; an empty one (the bare acknowledgement, or history's
  // in-flight id with nothing under it) is only the steer, and goes.
  const shown = findRun(activity, aliasId);
  if (
    shown &&
    (shown.steps.length > 0 ||
      shown.text ||
      shown.origin === "local" ||
      // The gateway's events reported its start: a run of its own, if nothing of it shows yet.
      (shown.origin === "gateway" && shown.reportedStartAt !== null))
  )
    return activity;
  return {
    ...activity,
    runs: shown ? activity.runs.filter((run) => run !== shown) : activity.runs,
    steerAliases: { ...activity.steerAliases, [aliasId]: targetId },
  };
}

/**
 * The gateway ran a send's turn under an id of its own (a turn it took from its
 * queue): it reports `run_status` under that id, and the turn's lifecycle and
 * end under the send's id, `clientRunId`. The two are one run: the gateway's id
 * becomes a queue alias of the send's run. A run already shown under the
 * gateway's id is folded in: dropped when it holds nothing, or renamed when the
 * send's run is not shown yet.
 */
export function registerRunAlias(
  activity: TaskActivity,
  gatewayRunId: string,
  clientRunId: string,
): TaskActivity {
  if (gatewayRunId === clientRunId || activity.queueAliases[gatewayRunId] === clientRunId)
    return activity;
  const shown = findRun(activity, gatewayRunId);
  let runs = activity.runs;
  if (shown && shown.origin === "gateway") {
    if (shown.steps.length === 0 && !shown.text) runs = runs.filter((run) => run !== shown);
    else if (!findRun(activity, clientRunId))
      runs = runs.map((run) => (run === shown ? { ...run, id: clientRunId } : run));
  }
  return {
    ...activity,
    runs,
    queueAliases: { ...activity.queueAliases, [gatewayRunId]: clientRunId },
  };
}

/**
 * The pairs a history page shows of a queued turn's two ids, read from the page alone,
 * whatever this client holds (a reconnect that missed the pairing frame, or a transcript
 * built from history only): a user row keyed `<send id>:user` (OpenClaw 2026.10.6) followed
 * by rows under a run id the page has not shown before. A steer's user row is followed by
 * the rows of the run it was sent into, which came before it, and an ordinary turn's by
 * rows under the send's own id: neither pairs.
 */
export function historyQueuePairs(
  messages: unknown,
): Array<[gatewayRunId: string, clientRunId: string]> {
  const pairs: Array<[string, string]> = [];
  // Run ids the page has shown so far, sends and their rows alike.
  const seen = new Set<string>();
  let sendId: string | null = null;
  for (const entry of Array.isArray(messages) ? messages : []) {
    const message = asRecord(entry);
    if (!message) continue;
    if (message.role === "user") {
      const key = rowIdempotencyKey(message);
      sendId = key?.endsWith(":user") ? key.slice(0, -":user".length) : null;
      if (sendId) seen.add(sendId);
      continue;
    }
    const runId = str(meta(message).runId);
    if (!runId) continue;
    if (sendId && runId !== sendId && !seen.has(runId)) pairs.push([runId, sendId]);
    seen.add(runId);
    sendId = null;
  }
  return pairs;
}

/**
 * The gateway's answer to a send names a run that is already over: a send it
 * aborted before the turn ran (`status: "timeout"`, `summary: "aborted"`,
 * from its abort of a send not yet registered), or a send it had already
 * finished (`ok`) or failed (`error`). No event of that run will follow, so the
 * answer settles it. Any other status (`started`, `in_flight`, `accepted`)
 * leaves it to the run's events.
 */
export function settleRunFromSendAnswer(
  activity: TaskActivity,
  runId: string,
  answer: RawRecord,
  ctx: EngineContext,
): TaskActivity {
  const status = str(answer.status);
  const endedAt = num(answer.endedAt) ?? ctx.now;
  return updateRun(activity, runId, (run) => {
    if (isTerminal(run.state) || run.state === "queued") return run;
    if (status === "timeout" && answer.summary === "aborted")
      return finishRun(run, "stopped", ctx, null, endedAt);
    if (status === "ok") return finishRun(run, "completed", ctx, null, endedAt);
    if (status === "error") {
      const message = str(answer.summary) ?? "The gateway reported an error.";
      const raw = rawEvent(ctx, run.id, "send-answer", answer);
      return finishRun(run, "failed", ctx, { message, kind: "gateway", raw }, endedAt);
    }
    return run;
  });
}

/** The run an event's id stands for: through the task's queue aliases, or itself. */
function canonicalRunId(activity: TaskActivity, runId: string): string {
  return activity.queueAliases[runId] ?? runId;
}

/**
 * An event under a steer's own run id. A bare acknowledgement (a `chat` final
 * with no message, all a joined steer gets) is dropped. Anything showing a run
 * of its own, an error that ends it included, removes the alias: the steer is a run of its own, kept under its
 * own id. Null when the event is to be dropped.
 */
function steerOwnRun(
  activity: TaskActivity,
  runId: string,
  event: "chat" | "agent",
  payload: RawRecord,
): TaskActivity | null {
  if (!Object.hasOwn(activity.steerAliases, runId)) return activity;
  const message = asRecord(payload.message);
  const own =
    event === "agent"
      ? ["lifecycle", "assistant", "thinking", "tool", "item", "command_output"].includes(
          str(payload.stream) ?? "",
        ) &&
        // A steer withdrawn before it ran ends aborted with no start of its own: not a run.
        !(payload.stream === "lifecycle" && asRecord(payload.data)?.aborted === true)
      : payload.state === "delta"
        ? contentText(message?.content) !== "" || typeof payload.deltaText === "string"
        : // An error ends a run of its own: a joined steer is acknowledged by a bare final only.
          payload.state === "error" || (message !== null && contentText(message.content) !== "");
  if (!own) return null;
  const steerAliases = { ...activity.steerAliases };
  delete steerAliases[runId];
  return { ...activity, steerAliases };
}

// Questions -----------------------------------------------------------------------

function mapQuestionItems(value: unknown): QuestionItem[] {
  return (Array.isArray(value) ? value : []).flatMap((entry) => {
    const item = asRecord(entry);
    const id = str(item?.questionId);
    if (!item || !id) return [];
    const options = (Array.isArray(item.options) ? item.options : []).flatMap((option, index) => {
      const record = asRecord(option);
      const label = str(record?.label);
      return label
        ? [{ index, label, description: str(record?.description), value: str(record?.value) }]
        : [];
    });
    return [
      {
        id,
        header: typeof item.header === "string" ? item.header : "",
        question: typeof item.question === "string" ? item.question : "",
        // The first options, by their place; the rest are counted, never renumbered.
        options: options.slice(0, MAX_QUESTION_OPTIONS),
        optionsOmitted: Math.max(0, options.length - MAX_QUESTION_OPTIONS),
        multiSelect: item.multiSelect === true,
        allowsOther: item.isOther === true,
      },
    ];
  });
}

/** Question fields the ordinary ask-user card has no way to show or answer (`QuestionSchema`). */
const UNORDINARY_QUESTION_FIELDS = [
  "url",
  "presentation",
  "resource",
  "answerFormat",
  "defaultAnswers",
  "isSecret",
  "secretStore",
  "secretStoreExisting",
] as const;

/**
 * Whether a question record holds only ordinary ask-user questions: one to
 * three questions, each with two to four options that are a label and
 * optionally a description and nothing else, and none of a link, a form
 * presentation, a resource, a lines format, an empty-answer allowance,
 * default answers or a secret. Such a record is answerable on the ordinary
 * card; any other is shown readable and is not answerable there.
 */
export function isOrdinaryQuestionRecord(record: RawRecord): boolean {
  const questions = record.questions;
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 3) return false;
  return questions.every((entry) => {
    const question = asRecord(entry);
    if (!question || !str(question.questionId)) return false;
    // `false` for a flag, or an empty default list, asks for nothing.
    const plain = UNORDINARY_QUESTION_FIELDS.every(
      (field) =>
        question[field] === undefined ||
        question[field] === false ||
        (field === "defaultAnswers" &&
          Array.isArray(question[field]) &&
          (question[field] as unknown[]).length === 0),
    );
    if (!plain || question.allowEmpty === true) return false;
    const options = question.options;
    if (!Array.isArray(options) || options.length < 2 || options.length > 4) return false;
    return options.every((each) => {
      const option = asRecord(each);
      if (!option || !str(option.label)) return false;
      return Object.keys(option).every(
        (key) =>
          key === "label" ||
          (key === "description" &&
            (option.description === undefined || typeof option.description === "string")),
      );
    });
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
  // a late or repeated event must never make either actionable again. A run
  // remembers the questions it settled among its closed cards, also where the
  // question itself is not kept (a recipient's run in a task nobody has open).
  if (existing && existing.status !== "pending") return activity;
  if (!existing && questionSettled(activity, id)) return activity;
  const known = runId ? findRun(activity, runId) : undefined;
  if (known && isTerminal(known.state)) return activity;
  if (
    !existing &&
    activity.questions.filter((question) => question.status === "pending").length >=
      MAX_PENDING_QUESTIONS_PER_TASK
  ) {
    // Not kept, and said so; the next `question.list` read brings it back once one settles.
    return { ...activity, questionsOmitted: activity.questionsOmitted + 1 };
  }
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
    ordinary: isOrdinaryQuestionRecord(record),
    sent: existing?.sent ?? null,
    settledBy: [],
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

/**
 * A question in a session nobody here has open, whose run this client follows
 * as a recipient's: the run waits on it, holding only the card's id; the
 * question itself is not kept.
 */
export function foreignQuestionRequested(
  activity: TaskActivity,
  record: RawRecord,
  ctx: EngineContext,
): TaskActivity {
  const next = applyQuestionRequested(activity, record, ctx);
  return next.questions.length > 0 ? { ...next, questions: [] } : next;
}

/** The runs that hold a question known only by its id (`questionMarkers`). */
export function runsWithQuestionMarkers(activity: TaskActivity): Run[] {
  const ids = new Set(questionMarkers(activity));
  return activity.runs.filter((run) =>
    [...run.pendingCards, ...run.suspendedCards].some(
      (card) => card.kind === "question" && ids.has(card.id),
    ),
  );
}

/**
 * Questions a task's runs wait on that the task holds no record of: a run that
 * waited on a question while nobody here had its task open keeps only the
 * card's id, and keeps it when the task is opened. Each settles through the
 * same rules as a question with its record: `question.resolved`, or a
 * `question.list` read that no longer lists it.
 */
export function questionMarkers(activity: TaskActivity): string[] {
  return activity.runs.flatMap((run) =>
    [...run.pendingCards, ...run.suspendedCards]
      .filter(
        (card) =>
          card.kind === "question" &&
          !activity.questions.some((question) => question.id === card.id),
      )
      .map((card) => card.id),
  );
}

/** That question settled: its run goes on. */
export function foreignQuestionResolved(activity: TaskActivity, payload: RawRecord): TaskActivity {
  const id = str(payload.id);
  if (!id || !activity.runs.some((run) => run.pendingCards.some((card) => card.id === id))) {
    return activity;
  }
  const reason: CardCloseReason =
    payload.status === "answered"
      ? "answered"
      : payload.status === "expired"
        ? "expired"
        : payload.status === "cancelled"
          ? "dismissed"
          : "closed";
  return { ...activity, runs: activity.runs.map((run) => closeCard(run, id, reason)) };
}

/** Whether a run of the task settled this question: it is among the run's closed cards. */
export function questionSettled(activity: TaskActivity, id: string): boolean {
  return activity.runs.some((run) =>
    run.closedCards.some((card) => card.kind === "question" && card.id === id),
  );
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
/**
 * A question settled. `record` is what the gateway sent that says so, kept
 * as the evidence; an outcome this client applied from its own answer has none.
 */
export function applyQuestionResolved(
  activity: TaskActivity,
  payload: RawRecord,
  record?: SettlingRecord,
): TaskActivity {
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
            settledBy: record ? withRecords(each.settledBy, [record]) : each.settledBy,
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
    // Only an end the gateway established closes it; an inferred one leaves it to the gateway.
    if (!run || !isTerminal(run.state) || !run.outcomeKnown) return question;
    changed = true;
    return { ...question, status: "closed" as const, submitting: false };
  });
  return changed ? { ...activity, questions } : activity;
}

/** An answer or dismissal is being sent, or failed. */
export function markQuestion(
  activity: TaskActivity,
  id: string,
  patch: Pick<QuestionCard, "submitting" | "error"> & Partial<Pick<QuestionCard, "sent">>,
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
  for (const id of questionMarkers(activity)) {
    if (!pendingIds.has(id) && (pendingBefore === undefined || pendingBefore.has(id))) {
      next = foreignQuestionResolved(next, { id, status: "closed" });
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
  const raw = str(payload.runId);
  if (!raw) return activity;
  const runId = canonicalRunId(activity, raw);
  const own = steerOwnRun(activity, runId, "chat", payload);
  // The bare final is the gateway's word that the steer joined the run (its id is the message's).
  if (!own)
    return payload.state === "final"
      ? updateMessage(activity, runId, { steer: "joined" })
      : activity;
  activity = own;
  const existing = findRun(activity, runId);
  const state = payload.state;
  if (existing && isTerminal(existing.state)) {
    // An end this client only inferred gives way to the end the gateway sends.
    const ends = state === "final" || state === "aborted" || state === "error";
    if (existing.outcomeKnown || !ends) return activity;
    activity = replaceRun(activity, reopenInferred(existing));
  }
  let next = ensureRun(activity, runId, ctx);
  next = updateRun(next, runId, (run) => {
    switch (state) {
      case "status":
        return { ...run, phase: str(payload.phase) ?? run.phase };
      case "delta": {
        if (run.textSource === "agent") return run;
        // Text already cut to its bound is not followed further; the transcript holds it whole.
        if (run.cut?.includes("text")) return run;
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
          raw: rawEvent(ctx, run.id, "chat-event", payload),
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
  const raw = str(payload.runId);
  const stream = str(payload.stream);
  const data = asRecord(payload.data) ?? {};
  if (!raw || !stream) return { activity };
  const runId = canonicalRunId(activity, raw);
  const own = steerOwnRun(activity, runId, "agent", payload);
  if (!own) return { activity };
  activity = own;
  const existing = findRun(activity, runId);
  const seq = num(payload.seq);
  // A repeated or older frame is dropped. Forward jumps are normal: the gateway
  // coalesces assistant and thinking frames after numbering them, so they are
  // not taken as loss; loss is the connection-level frame gap.
  if (existing && seq !== null && existing.lastSeq !== null && seq <= existing.lastSeq)
    return { activity };
  const replacement = stream === "tool" && data.phase === "result" && data.replace === true;
  if (existing && isTerminal(existing.state) && !replacement) {
    // An end this client only inferred gives way to the end the gateway sends.
    const ends = stream === "lifecycle" && (data.phase === "end" || data.phase === "error");
    if (existing.outcomeKnown || !ends) return { activity };
    activity = replaceRun(activity, reopenInferred(existing));
  }

  let next = ensureRun(activity, runId, ctx);
  const ts = num(payload.ts) ?? ctx.now;
  next = updateRun(next, runId, (run) => {
    if (seq !== null && (run.lastSeq === null || seq > run.lastSeq)) run = { ...run, lastSeq: seq };
    // The model answered again: a retry it was waiting on is over.
    if (run.retry && (stream === "assistant" || stream === "thinking" || stream === "tool")) {
      const { retry: _over, ...rest } = run;
      run = rest;
    }
    switch (stream) {
      case "lifecycle":
        return applyLifecycle(run, data, ts, ctx);
      case "run_status": {
        const phase = str(data.phase) ?? run.phase;
        // The gateway retries a failed model request by itself and says which attempt (F-082).
        const attempt = num(data.attempt);
        const of = num(data.maxAttempts);
        const retry =
          phase === "retrying" && attempt !== null && of !== null
            ? { attempt, of, reason: str(data.reason) }
            : undefined;
        const { retry: _was, ...rest } = run;
        return retry ? { ...rest, phase, retry } : { ...rest, phase };
      }
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
      return {
        ...run,
        startedAt: num(data.startedAt) ?? run.startedAt ?? ts,
        reportedStartAt: num(data.startedAt) ?? ts,
      };
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
        {
          message: message ?? "The run timed out.",
          kind: "timeout",
          raw: rawEvent(ctx, run.id, "lifecycle-data", data),
        },
        at,
      );
    case "blocked":
    case "abandoned":
    case "failed":
      return finishRun(
        run,
        "failed",
        ctx,
        {
          message: message ?? "The run failed.",
          kind: reason,
          raw: rawEvent(ctx, run.id, "lifecycle-data", data),
        },
        at,
      );
  }
}

/**
 * The gateway's `agent.wait` record of a run, asked with no wait. A record of a run that ended
 * (`ok`, `error`, or a `timeout` with an end, as OpenClaw 2026.10.6's `isTerminalAgentWaitTimeout`
 * reads it) settles the run as its terminal lifecycle event would. A bare `timeout` (the run is
 * still going, or the gateway does not know it) and `pending` (still queued) leave it as it is.
 */
export function settleRunFromWait(
  activity: TaskActivity,
  runId: string,
  answer: RawRecord,
  ctx: EngineContext,
): TaskActivity {
  const status = str(answer.status);
  const ended =
    status === "ok" ||
    status === "error" ||
    (status === "timeout" &&
      answer.pendingError !== true &&
      (num(answer.endedAt) !== null ||
        str(answer.stopReason) !== null ||
        str(answer.livenessState) !== null ||
        classifyLifecycleTerminal("end", answer) === "hard_timeout"));
  if (!ended) return activity;
  // OpenClaw reads a run its revoked access cut short as aborted (`resolveAgentRunWaitTerminalFacts`).
  const facts =
    status !== "ok" && str(answer.stopReason) === "auth-revoked"
      ? { ...answer, stopReason: "aborted" }
      : answer;
  return updateRun(activity, runId, (run) => {
    // An end established already is final; an inferred one gives way to the gateway's.
    if (run.state === "queued" || (isTerminal(run.state) && run.outcomeKnown)) return run;
    return terminalFromLifecycle(
      reopenInferred(run),
      status === "error" ? "error" : "end",
      facts,
      num(answer.endedAt) ?? ctx.now,
      ctx,
    );
  });
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
    // Continuation is decided against the whole earlier text, by its length
    // and digest, never against the displayed prefix: a restart that shares
    // the first 16 000 characters is still a restart.
    const evidence = last.continuation;
    let next: Digest | null = null;
    if (cumulative === null) {
      next = evidence ? extendDigest(evidence, delta) : null;
    } else if (
      evidence &&
      cumulative.length >= evidence.length &&
      sameDigest(digestOf(cumulative.slice(0, evidence.length)), evidence)
    ) {
      next = extendDigest(evidence, cumulative.slice(evidence.length));
    }
    if (next) {
      const output = cumulative !== null ? capText(cumulative) : appendText(last.output, delta);
      ctx.raw.patch(ctx.sessionKey, last.id, { call: payload });
      return upsertStep(run, { ...last, output, continuation: next });
    }
    // Nothing establishes that it continues: a new segment, the earlier one kept as it was.
    run = closeReasoning(run, ctx, ts);
  }
  const id = reasoningStepId(run.id, run.reasoningAnchor, run.nextReasoning);
  run = { ...run, nextReasoning: run.nextReasoning + 1 };
  const text = cumulative ?? delta;
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
    output: capText(text),
    result: null,
    error: null,
    approvalId: null,
    failureKind: null,
    truncated: false,
    replaceable: false,
    correction: 0,
    continuation: digestOf(text),
    raw: null,
    rawSize: null,
  });
}

/** The reasoning anchor a tool call sets. */
function toolAnchor(toolCallId: string): string {
  return `t.${toolCallId}`;
}

/**
 * A reasoning step's id: a pure function of its place in its run. `anchor`
 * is the nearest tool call before it (`t.<toolCallId>`), `c` for a run whose
 * start a history window does not show, or null for the run's start; `n`
 * counts the reasoning blocks since that anchor. The live stream and history
 * compute it alike, so nothing has to be matched. The run id and the anchor
 * have `%` and `:` escaped (`idPart`), so neither can hold the `:` that separates the parts
 * and no two places share an id, whatever characters the gateway's ids use;
 * ordinary ids (letters, digits, `-`, `_`, `.`) are unchanged by it.
 */
export function reasoningStepId(runId: string, anchor: string | null, n: number): string {
  return `reasoning:${idPart(runId)}:${anchor === null ? "s" : idPart(anchor)}:${n}`;
}

/**
 * One part of a reasoning id: `%` and `:` escaped, every other code unit kept as
 * it is, a lone surrogate included. The parts can then hold no separator, so
 * two places never share an id, and no string the gateway sends can make it throw.
 */
function idPart(value: string): string {
  return value.replace(/%/g, "%25").replace(/:/g, "%3A");
}

function applyAssistant(run: Run, data: RawRecord, ts: number, ctx: EngineContext): Run {
  const closed = closeReasoning(run, ctx, ts);
  if (closed.textSource === "chat") return closed;
  const itemId = str(data.itemId);
  const delta = typeof data.delta === "string" ? data.delta : "";
  const cumulative = typeof data.text === "string" ? data.text : null;
  const sameItem = itemId === null || itemId === closed.textItemId;
  // Text cut to its bound is not extended by deltas: they would join non-adjacent text.
  if (cumulative === null && sameItem && closed.cut?.includes("text")) return closed;
  const text = cumulative ?? (sameItem ? closed.text + delta : delta);
  return { ...closed, textSource: "agent", textItemId: itemId ?? closed.textItemId, text };
}

function toolStepId(toolCallId: string): string {
  return `tool:${toolCallId}`;
}

/** Spread into a step: its file facts when it names files, nothing otherwise. */
function withFiles(files: StepFiles | undefined): { files?: StepFiles } {
  return files ? { files } : {};
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
    continuation: null,
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
            args: projectArgs(data.args),
            ...(data.commandBearing === true ? { commandBearing: true } : {}),
            ...withFiles(stepFiles(name ?? step.toolName, data.args)),
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
        details: projectDetails(details),
        ...(data.commandBearing === true ? { commandBearing: true } : {}),
        correction: replacing ? step.correction + 1 : step.correction,
      };
      return upsertStep(current, settleRaw(settleFiles(finished, details, isError), ctx));
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
  if (data.kind === "preamble") return applyPreamble(run, data);
  if (data.kind !== "tool") return run;
  const toolCallId = str(data.toolCallId);
  if (!toolCallId) return run;
  if (data.phase === "start") run = closeReasoning(run, ctx, ts);
  const existing = run.steps.find((each) => each.id === toolStepId(toolCallId));
  // The item start comes just before the tool start: the step shows from it.
  if (!existing && data.phase !== "start") return run;
  const step = existing ?? blankToolStep(toolCallId, str(data.name), num(data.startedAt));
  const title = str(data.title);
  return upsertStep(run, {
    ...step,
    ...(data.commandBearing === true ? { commandBearing: true } : {}),
    ...(title ? { gatewayTitle: title } : {}),
    startedAt: num(data.startedAt) ?? step.startedAt,
    endedAt: isOpenStep(step) ? step.endedAt : (num(data.endedAt) ?? step.endedAt),
  });
}

/** Text beside a tool call: its updates replace its text in place; `end` ends it. */
function applyPreamble(run: Run, data: RawRecord): Run {
  const id = str(data.itemId);
  const text = typeof data.progressText === "string" ? data.progressText : null;
  if (!id || (text === null && data.phase !== "end")) return run;
  const list = run.preambles ?? [];
  const existing = list.find((each) => each.id === id);
  const ended = data.phase === "end";
  const next: Preamble = existing
    ? { ...existing, text: text ?? existing.text, ended: existing.ended || ended }
    : { id, text: text ?? "", ended, beforeCall: null };
  const preambles = existing
    ? list.map((each) => (each.id === id ? next : each))
    : [...list, next].slice(-MAX_PREAMBLES_PER_RUN);
  return { ...run, preambles };
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

/**
 * History rows read through the task's queue aliases: a turn the gateway ran
 * from its queue is stored under the gateway's own run id, while its live
 * events carry the send's id. Steer aliases are never applied here: a steer
 * the gateway admitted as a run of its own keeps its own rows and anchor.
 * Rows (and the in-flight run) naming a queue alias name the run it stands
 * for, so history and the live run are one run, not two. Rows without an
 * alias are returned as they are.
 */
export function throughRunAliases(
  messages: unknown,
  inFlight: RawRecord | null,
  aliases: Readonly<Record<string, string>>,
): { messages: unknown; inFlight: RawRecord | null } {
  const target = (id: unknown) =>
    typeof id === "string" && Object.hasOwn(aliases, id) ? aliases[id]! : null;
  const rows = Array.isArray(messages)
    ? messages.map((entry) => {
        const message = asRecord(entry);
        const to = message ? target(meta(message).runId) : null;
        return to ? { ...message, __openclaw: { ...meta(message!), runId: to } } : entry;
      })
    : messages;
  const flight = inFlight && target(inFlight.runId);
  return { messages: rows, inFlight: flight ? { ...inFlight, runId: flight } : inFlight };
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
 * aborted or errored, otherwise `completed`. `windowCut` says the page does
 * not reach the transcript's start (`hasMore`): then the run of the page's
 * first row, unless that row is a user's, may have begun before it, and its
 * reasoning before its first visible tool call is numbered from the anchor
 * `c`, so it never takes the ids a window that sees the run's start gives.
 */
export function runsFromHistory(
  messages: unknown,
  inFlight: string | RawRecord | null,
  ctx: EngineContext,
  options: { windowCut?: boolean; busy?: boolean } = {},
): Run[] {
  const snapshot = typeof inFlight === "string" ? { runId: inFlight } : inFlight;
  const inFlightRunId = str(snapshot?.runId);
  const runs = new Map<string, Run>();
  const lastAssistant = new Map<string, RawRecord>();
  /** Runs whose last persisted content is a thinking block: that segment may still be streaming. */
  const trailingThinking = new Map<string, boolean>();
  let anchor: string | null = null;
  /**
   * Runs that a message from another session started, by run id: `chat.history`
   * shows such a message as an assistant row with `provenance.kind:
   * "inter_session"` and, like a user row, the key `${runId}:user` of the run
   * it started (OpenClaw 2026.10.6), not as a user row.
   */
  const startedBy = new Map<string, string>();
  const rows = Array.isArray(messages) ? messages : [];
  const first = asRecord(rows[0]);
  const cutRunId =
    options.windowCut && first && first.role !== "user"
      ? (str(meta(first).runId) ?? str(asRecord(first.openclawAbort)?.runId))
      : null;

  rows.forEach((entry, index) => {
    const message = asRecord(entry);
    if (!message) return;
    if (message.role === "user") {
      anchor = historyItemId(message, index);
      return;
    }
    const provenance = asRecord(message.provenance) ?? asRecord(meta(message).provenance);
    if (provenance?.kind === "inter_session" && !str(meta(message).runId)) {
      const key = rowIdempotencyKey(message);
      if (key?.endsWith(":user"))
        startedBy.set(key.slice(0, -":user".length), historyItemId(message, index));
      return;
    }
    // The gateway's injected aborted-partial row names its run in `openclawAbort`.
    const runId = str(meta(message).runId) ?? str(asRecord(message.openclawAbort)?.runId);
    if (!runId) return;
    const at = rowTime(message);
    let run =
      runs.get(runId) ??
      newRun(
        runId,
        {
          state: "running",
          origin: "history",
          bound: true,
          anchorItemId: startedBy.get(runId) ?? anchor,
          reasoningAnchor: runId === cutRunId ? "c" : null,
        },
        at,
      );
    if (message.role === "assistant") {
      lastAssistant.set(runId, message);
      run = { ...run, model: str(message.model) ?? run.model, endedAt: at ?? run.endedAt };
      const content = Array.isArray(message.content) ? message.content : [];
      if (typeof message.content === "string" && message.content.trim())
        trailingThinking.set(runId, false);
      content.forEach((part) => {
        const block = asRecord(part);
        if (!block) return;
        if (block.type === "text" && typeof block.text === "string" && block.text.trim())
          trailingThinking.set(runId, false);
        if (
          block.type === "thinking" &&
          typeof block.thinking === "string" &&
          block.thinking.trim()
        ) {
          trailingThinking.set(runId, true);
          // The same function of its place as the live stream's.
          const id = reasoningStepId(runId, run.reasoningAnchor, run.nextReasoning);
          run = { ...run, nextReasoning: run.nextReasoning + 1 };
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
                rowTimes: true,
                argsText: null,
                output: capText(block.thinking),
                result: null,
                error: null,
                approvalId: null,
                failureKind: null,
                // A reasoning row carries the gateway's cut like a tool row does.
                truncated: meta(message).truncated === true,
                replaceable: false,
                correction: 0,
                continuation: digestOf(block.thinking),
                raw: null,
                rawSize: null,
              },
              ctx,
            ),
          );
        } else if (block.type === "toolCall" || block.type === "tool_use") {
          const toolCallId = str(block.id);
          if (!toolCallId) return;
          trailingThinking.set(runId, false);
          const name = str(block.name);
          const id = toolStepId(toolCallId);
          ctx.raw.set(ctx.sessionKey, id, { source: "history", runId, call: block, result: null });
          run = upsertStep(run, {
            ...blankToolStep(toolCallId, name, at),
            // The row's time is when the message was written, not when the call started.
            rowTimes: true,
            argsText: capText(prettyArgs(block.arguments ?? block.input)),
            args: projectArgs(block.arguments ?? block.input),
            ...withFiles(stepFiles(name, block.arguments ?? block.input)),
            truncated: meta(message).truncated === true,
          });
        }
      });
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
            settleFiles(
              {
                ...step,
                status: isError ? "failed" : "done",
                endedAt: at ?? step.startedAt,
                result: capText(text),
                error: isError ? capError(text || "The tool reported an error.") : null,
                failureKind: isError ? str(asRecord(message.details)?.failureKind) : null,
                truncated: step.truncated || meta(message).truncated === true,
                // The gateway cut this result's stored text.
                ...(meta(message).truncated === true ? { resultCut: true } : {}),
                details: projectDetails(message.details),
              },
              asRecord(message.details),
              isError,
            ),
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
            {
              state: "running",
              origin: "history",
              bound: true,
              anchorItemId: anchor,
              reportedStartAt: num(snapshot?.startedAt),
            },
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

  // The newest run of the rows; the queued turn the gateway reports in flight is not one of them.
  const newest = [...runs.keys()].filter((id) => id !== inFlightRunId).at(-1);
  return [...runs.values()].map((built) => {
    if (built.id === inFlightRunId) return built;
    const lastRow = lastAssistant.get(built.id);
    const lastStop = str(lastRow?.stopReason);
    const endShown =
      lastStop === "stop" ||
      lastStop === "length" ||
      lastStop === "aborted" ||
      lastStop === "error" ||
      asRecord(lastRow?.openclawAbort)?.aborted === true;
    // The newest run, its rows stopping short of an end, while the gateway has a turn of the
    // task in flight or queued: the gateway has not said it ended (it may wait on an approval
    // or a question, with a steer queued behind it). It stays open until its end is said.
    if (options.busy && built.id === newest && !endShown) return built;
    // Its end is its last row's time, not one its lifecycle reported.
    const run: Run = { ...built, endFromRows: true };
    const last = lastAssistant.get(run.id);
    const stopReason = str(last?.stopReason);
    if (stopReason === "aborted" || asRecord(last?.openclawAbort)?.aborted === true) {
      return finishRun(run, "stopped", ctx, null, run.endedAt);
    }
    if (stopReason === "error") {
      // The gateway writes the failure as the run's last row; its text is the error itself.
      const message =
        str(last?.errorMessage) || liveTextFromChatMessage(last).trim() || "The run failed.";
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

/** A step closed only because its run ended, with no result of its own: how it ended is not known. */
function closedByRunEnd(step: Step): boolean {
  return step.status === "unknown";
}

function mergeStep(live: Step, history: Step): { step: Step; source: "live" | "history" } {
  // A finished step beats a running one. Between two finished steps the live
  // one keeps the raw frames the user watched, unless the gateway marked its
  // result replaceable: then the transcript holds the canonical result.
  // So does a step closed here only because its run ended, when history knows how it ended.
  const inferred = closedByRunEnd(live) && !closedByRunEnd(history);
  if (
    ((isOpenStep(live) || inferred) && !isOpenStep(history)) ||
    (live.replaceable && !isOpenStep(history))
  ) {
    return {
      step: {
        ...history,
        startedAt: live.startedAt ?? history.startedAt,
        // A finished live step keeps the end the events reported; else the end is history's row
        // time. A step its run's end closed here had no end of its own reported.
        ...(isOpenStep(live) || inferred
          ? live.rowTimes || history.rowTimes
            ? { rowTimes: true }
            : {}
          : { endedAt: live.endedAt, rowTimes: live.rowTimes === true }),
        ...(live.omittedBefore ? { omittedBefore: live.omittedBefore } : {}),
        // What the live stream established about the call stays: history keeps no `commandBearing`.
        args: history.args ?? live.args ?? null,
        ...(live.gatewayTitle ? { gatewayTitle: live.gatewayTitle } : {}),
        ...(live.commandBearing || history.commandBearing ? { commandBearing: true } : {}),
        // The canonical copy replaced a finished, replaceable result: an explicit correction.
        correction: isOpenStep(live) || inferred ? live.correction : live.correction + 1,
      },
      source: "history",
    };
  }
  // A live step whose start the stream missed has no call: no arguments, no file, and a raw
  // payload without its call. History's copy has the call, and its payload has both halves.
  const truncated = history.truncated && !live.truncated;
  const files = !live.files && history.files ? history.files : undefined;
  const missedCall = live.kind === "tool" && live.argsText === null && history.argsText !== null;
  return {
    step:
      truncated || files || missedCall
        ? {
            ...live,
            ...(truncated ? { truncated: true } : {}),
            ...withFiles(files),
            ...(missedCall ? { argsText: history.argsText, args: history.args ?? null } : {}),
          }
        : live,
    source: missedCall ? "history" : "live",
  };
}

/**
 * Merge one run's steps by id. Reasoning ids are derived from their place
 * (`reasoningStepId`), live and from history alike, so nothing is matched.
 * Once history holds the finished run and every live tool step, its steps,
 * reasoning included, replace the live ones and its order wins. Until then
 * history reasoning is not added. Either way no reasoning text is shown
 * twice, and none is dropped before the transcript has it.
 */
function mergeSteps(
  live: Run,
  history: Run,
  fromHistory: Set<string>,
): { steps: Step[]; omittedSteps: number; omittedTools: number; omittedToolsAtEnd: number } {
  const pick = ({ step, source }: { step: Step; source: "live" | "history" }) => {
    if (source === "history") fromHistory.add(step.id);
    return step;
  };
  const historyIds = new Set(history.steps.map((step) => step.id));
  const liveById = new Map(live.steps.map((step) => [step.id, step]));
  const complete =
    isTerminal(history.state) &&
    live.steps.every((step) => step.kind !== "tool" || historyIds.has(step.id)) &&
    (history.steps.some((step) => step.kind === "reasoning") ||
      !live.steps.some((step) => step.kind === "reasoning"));
  if (complete) {
    // The transcript holds the whole run: its steps, all of them, replace the
    // live ones, and retention counts again from there. A reasoning block
    // has the id its place gives it, which a live card at that place had too.
    return {
      steps: history.steps.map((step) => {
        if (step.kind === "reasoning") return pick({ step, source: "history" });
        const current = liveById.get(step.id);
        const merged = pick(current ? mergeStep(current, step) : { step, source: "history" });
        // Retention counts again from history's whole record: its own gaps, not the live run's.
        const { omittedBefore: _, ...rest } = merged;
        return step.omittedBefore ? { ...rest, omittedBefore: step.omittedBefore } : rest;
      }),
      omittedSteps: history.omittedSteps,
      omittedTools: history.omittedTools ?? 0,
      omittedToolsAtEnd: history.omittedToolsAtEnd ?? 0,
    };
  }
  // History tool steps the live run lacks go in at their place in history's
  // order, after the history step before them (a reasoning card at the same
  // place included), so a step retention dropped comes back where it was and
  // gives way again in the same order.
  const steps = [...live.steps];
  let cursor = 0;
  let restored = 0;
  let atEnd = live.omittedToolsAtEnd ?? 0;
  for (const step of history.steps) {
    const index = steps.findIndex((each) => each.id === step.id);
    if (step.kind === "reasoning") {
      // Not added before the run ends, but a live card at the same place keeps the order.
      if (index !== -1) cursor = index + 1;
      continue;
    }
    if (index === -1) {
      steps.splice(cursor, 0, pick({ step, source: "history" }));
      cursor += 1;
      restored += 1;
      // The gap it came back from is one action smaller.
      const next = steps.findIndex((each, i) => i >= cursor && each.kind === "tool");
      const after = next === -1 ? null : steps[next]!;
      if (after?.omittedBefore) {
        const { omittedBefore, ...rest } = after;
        steps[next] = omittedBefore > 1 ? { ...rest, omittedBefore: omittedBefore - 1 } : rest;
      } else if (next === -1 && atEnd > 0) atEnd -= 1;
    } else {
      steps[index] = pick(mergeStep(steps[index]!, step));
      cursor = index + 1;
    }
  }
  return {
    steps,
    omittedSteps: Math.max(0, live.omittedSteps - restored),
    omittedTools: Math.max(0, (live.omittedTools ?? 0) - restored),
    omittedToolsAtEnd: atEnd,
  };
}

export type HistoryMerge = {
  runs: Run[];
  /** Steps taken from history, by id: their payload in the rebuild, under the same id, replaces the live one. */
  fromHistory: Set<string>;
};

/**
 * Whether a merge removed, added or re-anchored a reasoning id of the run.
 * Steps retention had dropped and history brings back, older than every step
 * still shown, are not a change.
 */
function reasoningIdsChanged(live: Run, merged: Step[]): boolean {
  const reasoning = (steps: Step[]) => steps.filter((step) => step.kind === "reasoning");
  const liveIds = new Set(live.steps.map((step) => step.id));
  const mergedIds = new Set(merged.map((step) => step.id));
  if (reasoning(live.steps).some((step) => !mergedIds.has(step.id))) return true;
  const firstKept = merged.findIndex((step) => liveIds.has(step.id));
  return merged.some(
    (step, index) =>
      step.kind === "reasoning" &&
      !liveIds.has(step.id) &&
      !(live.omittedSteps > 0 && firstKept !== -1 && index < firstKept),
  );
}

/**
 * Where a run's next reasoning block is numbered from after a merge: the
 * side whose anchor comes later in the merged steps (the run's start, or a
 * window's cut, before every step), and on the same anchor the larger count.
 */
function mergedAnchor(
  live: Run,
  history: Run,
  steps: Step[],
): { reasoningAnchor: string | null; nextReasoning: number } {
  if (live.reasoningAnchor === history.reasoningAnchor)
    return {
      reasoningAnchor: live.reasoningAnchor,
      nextReasoning: Math.max(live.nextReasoning, history.nextReasoning),
    };
  const place = (anchor: string | null) =>
    anchor?.startsWith("t.")
      ? steps.findIndex((step) => step.id === toolStepId(anchor.slice(2)))
      : -1;
  return place(history.reasoningAnchor) > place(live.reasoningAnchor)
    ? { reasoningAnchor: history.reasoningAnchor, nextReasoning: history.nextReasoning }
    : { reasoningAnchor: live.reasoningAnchor, nextReasoning: live.nextReasoning };
}

/**
 * Merge a reloaded history into the live runs without duplicating anything.
 * Runs match by id and steps by id. A live terminal state is final. A live
 * run that history shows ended takes history's terminal state, which is how a
 * terminal event lost in a gap is recovered. Pure: the caller commits the raw
 * payloads of the steps reported in `fromHistory`, so a step and its raw
 * lookup always come from the same source.
 *
 * A history that only infers a run's end (`outcomeKnown: false`: rows that stop at a tool call,
 * with the run not in flight) does not end a live run while the gateway has another turn of the
 * task in flight or queued (`busy`): then the gateway has not said this one ended. A steer into a
 * run waiting on an approval or a question is such a case: OpenClaw 2026.10.6 keeps that run
 * waiting and holds the steer as a queued turn of its own, which `chat.history` reports as the
 * run in flight. The run ends when its own end arrives, or history's rows establish it.
 */
export function mergeHistoryRuns(
  live: Run[],
  history: Run[],
  ctx: EngineContext,
  busy = false,
): HistoryMerge {
  const liveById = new Map(live.map((run) => [run.id, run]));
  const historyIds = new Set(history.map((run) => run.id));
  const fromHistory = new Set<string>();
  const merged = history.map((fromRun) => {
    const current = liveById.get(fromRun.id);
    if (!current) {
      for (const step of fromRun.steps) fromHistory.add(step.id);
      return fromRun;
    }
    const inferredOnly = !fromRun.outcomeKnown && busy;
    const { steps, omittedSteps, omittedTools, omittedToolsAtEnd } = mergeSteps(
      current,
      inferredOnly && !isTerminal(current.state) ? keepOpenSteps(current, fromRun) : fromRun,
      fromHistory,
    );
    let run: Run = {
      ...current,
      steps,
      omittedSteps,
      ...(omittedTools || current.omittedTools !== undefined ? { omittedTools } : {}),
      ...(omittedToolsAtEnd || current.omittedToolsAtEnd !== undefined
        ? { omittedToolsAtEnd }
        : {}),
      anchorItemId: fromRun.anchorItemId ?? current.anchorItemId,
      model: current.model ?? fromRun.model,
      ...mergedAnchor(current, fromRun, steps),
      reasoningRevision: current.reasoningRevision + (reasoningIdsChanged(current, steps) ? 1 : 0),
    };
    // An end this client only inferred gives way to the end history establishes.
    if (isTerminal(fromRun.state) && fromRun.outcomeKnown) run = reopenInferred(run);
    if (!isTerminal(run.state) && isTerminal(fromRun.state) && !inferredOnly) {
      run = {
        ...finishRun(
          run,
          fromRun.state as "completed" | "stopped" | "failed",
          ctx,
          fromRun.error,
          fromRun.endedAt ?? ctx.now,
        ),
        outcomeKnown: fromRun.outcomeKnown,
        // Its end is history's row time, not one its lifecycle reported.
        endFromRows: true,
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
 * History's copy of a run whose end it only infers, while the gateway still runs the task. It
 * does not hold the finished run, so its steps merge into the live ones as a running run's do,
 * and a live open reasoning step it lacks stays. A call it closed only because of that inferred
 * end is open as the live one is, so the live step stays open, takes from history only what it
 * lacks (the call, when the stream missed its start), and its own result closes it. A call
 * history holds a result for is history's.
 */
function keepOpenSteps(live: Run, history: Run): Run {
  const open = new Map(live.steps.filter(isOpenStep).map((step) => [step.id, step.status]));
  return {
    ...history,
    state: live.state,
    steps: history.steps.map((step) => {
      const status = closedByRunEnd(step) ? open.get(step.id) : undefined;
      return status ? { ...step, status } : step;
    }),
  };
}

/**
 * Runs that were active before a reload and that the gateway no longer has in
 * flight, with no transcript row, have ended without saying how. They settle
 * (`stopped` if a stop was pending, otherwise `completed`) with
 * `outcomeKnown: false`, so none waits forever; but not while the gateway has a turn of the
 * task in flight or queued (`busy`), since then it has not said that nothing runs.
 */
export function settleVanishedRuns(
  runs: Run[],
  activeBefore: ReadonlySet<string>,
  historyRunIds: ReadonlySet<string>,
  inFlightRunId: string | null,
  ctx: EngineContext,
  busy = false,
  /** Runs a terminal `sessions.changed` row named, by id, to the phase it reported. */
  namedEnded?: ReadonlyMap<string, "end" | "error">,
  /** Runs whose end history holds only in its rows' shape, never as a reply. */
  historyInferred?: ReadonlySet<string>,
): Run[] {
  return runs.map((run) => {
    const named = namedEnded?.get(run.id);
    if (run.state === "queued") return run;
    // A terminal state history only inferred (its rows' shape, or the vanished
    // rule) gives way to the phase a terminal row named; an established one is final.
    if (isTerminal(run.state) && (!named || run.outcomeKnown)) return run;
    if (!named && !activeBefore.has(run.id)) return run;
    if (
      run.id === inFlightRunId ||
      (historyRunIds.has(run.id) && (!named || !historyInferred?.has(run.id)))
    )
      return run;
    if (!named) {
      if (busy && run.id !== inFlightRunId && !historyRunIds.has(run.id)) return run;
      const settled = finishRun(run, run.state === "stopping" ? "stopped" : "completed", ctx);
      return { ...settled, outcomeKnown: false };
    }
    // The row said this run ended and history could not say how: settle it as
    // the row said, with the reply unknown rather than invented.
    const to: "failed" | "completed" = named === "error" ? "failed" : "completed";
    const settled = isTerminal(run.state) ? { ...run, state: to } : finishRun(run, to, ctx);
    // The row said how it ended; whether it ended with a reply, only history could say.
    return named === "error"
      ? { ...settled, outcomeKnown: true }
      : { ...settled, outcomeKnown: false };
  });
}

const sizes = new WeakMap<object, number>();

/** A size measured once per immutable object. */
export function cachedSize<T extends object>(value: T, measure: (value: T) => number): number {
  let size = sizes.get(value);
  if (size === undefined) {
    size = measure(value);
    sizes.set(value, size);
  }
  return size;
}

/**
 * Roughly the JSON characters a task's activity takes, for the retention
 * alarm only. The bound itself is the schema's arithmetic (`state-bounds.ts`).
 */
export function activitySize(activity: TaskActivity): number {
  let size = 0;
  for (const run of activity.runs) size += cachedSize(run, jsonLength);
  for (const message of activity.outbox) size += cachedSize(message, jsonLength);
  for (const approval of activity.approvals) size += cachedSize(approval, jsonLength);
  for (const question of activity.questions) size += cachedSize(question, jsonLength);
  return size;
}

/**
 * At most `MAX_STEPS_PER_RUN` steps in each run and `MAX_STEPS_PER_TASK` in
 * the task: the oldest finished steps give way first (oldest runs first),
 * then the oldest open ones. Every drop is counted on its run.
 */
function capSteps(runs: Run[]): Run[] {
  let next = runs.map((run) => dropSteps(run, run.steps.length - MAX_STEPS_PER_RUN));
  let excess = next.reduce((sum, run) => sum + run.steps.length, 0) - MAX_STEPS_PER_TASK;
  for (const open of [false, true]) {
    if (excess <= 0) break;
    next = next.map((run) => {
      if (excess <= 0) return run;
      const drop = new Set<Step>();
      for (const step of run.steps) {
        if (excess <= 0) break;
        if (!open && isOpenStep(step)) continue;
        drop.add(step);
        excess -= 1;
      }
      return withoutSteps(run, drop);
    });
  }
  return next.every((run, index) => run === runs[index]) ? runs : next;
}

/** Drop a run's `excess` oldest steps, finished ones first. */
function dropSteps(run: Run, excess: number): Run {
  if (excess <= 0) return run;
  const drop = new Set<Step>();
  for (const step of run.steps) {
    if (drop.size >= excess) break;
    if (!isOpenStep(step)) drop.add(step);
  }
  for (const step of run.steps) {
    if (drop.size >= excess) break;
    drop.add(step);
  }
  return withoutSteps(run, drop);
}

/**
 * A run without some of its steps, every drop counted: on the run, and for
 * tool steps on the next tool step kept (`omittedBefore`), or at the run's
 * end, so the interface says in line where actions are not kept. Text
 * written before a dropped call is placed before the next call kept.
 */
function withoutSteps(run: Run, drop: Set<Step>): Run {
  if (drop.size === 0) return run;
  const steps: Step[] = [];
  const moved = new Map<string, string | null>();
  let waiting: string[] = [];
  let pending = 0;
  let tools = 0;
  for (const step of run.steps) {
    if (drop.has(step)) {
      if (step.kind === "tool") {
        pending += 1 + (step.omittedBefore ?? 0);
        tools += 1;
        if (step.toolCallId) waiting.push(step.toolCallId);
      }
      continue;
    }
    if (step.kind === "tool") {
      for (const id of waiting) moved.set(id, step.toolCallId);
      waiting = [];
      steps.push(pending ? { ...step, omittedBefore: (step.omittedBefore ?? 0) + pending } : step);
      pending = 0;
    } else steps.push(step);
  }
  for (const id of waiting) moved.set(id, null);
  const preambles = run.preambles?.map((p) =>
    p.beforeCall !== null && moved.has(p.beforeCall)
      ? { ...p, beforeCall: moved.get(p.beforeCall)! }
      : p,
  );
  return {
    ...run,
    steps,
    omittedSteps: run.omittedSteps + drop.size,
    omittedTools: (run.omittedTools ?? 0) + tools,
    ...(pending ? { omittedToolsAtEnd: (run.omittedToolsAtEnd ?? 0) + pending } : {}),
    ...(preambles ? { preambles } : {}),
  };
}

/**
 * Bound what a task keeps, by count: the newest finished runs, the newest
 * closed cards per run, the newest steer aliases, settled questions and
 * approvals, and steps per run and per task. Field lengths are bounded by the
 * schema where state is written. Idempotent.
 */
export function retainActivity(activity: TaskActivity): TaskActivity {
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
  let runsOmitted = activity.runsOmitted;
  if (runs.length > MAX_RUN_LIST) {
    // Runs this client started are its user's: runs started elsewhere give way first, oldest first.
    let excess = runs.length - MAX_RUN_LIST;
    for (const mine of [false, true]) {
      runs = runs.filter((run) => {
        if (excess <= 0 || (run.origin === "local") !== mine) return true;
        excess -= 1;
        runsOmitted += 1;
        return false;
      });
    }
    changed = true;
  }
  const capped = capSteps(runs);
  if (capped !== runs) {
    runs = capped;
    changed = true;
  }
  let steerAliases = activity.steerAliases;
  const aliasKeys = Object.keys(steerAliases);
  if (aliasKeys.length > MAX_STEER_ALIASES) {
    steerAliases = Object.fromEntries(
      aliasKeys.slice(-MAX_STEER_ALIASES).map((key) => [key, activity.steerAliases[key]!]),
    );
    changed = true;
  }
  let queueAliases = activity.queueAliases;
  const queueKeys = Object.keys(queueAliases);
  if (queueKeys.length > MAX_QUEUE_ALIASES) {
    queueAliases = Object.fromEntries(
      queueKeys.slice(-MAX_QUEUE_ALIASES).map((key) => [key, activity.queueAliases[key]!]),
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
  return changed
    ? { ...activity, runs, runsOmitted, steerAliases, queueAliases, questions, approvals }
    : activity;
}

/** A user row's idempotency key: under `__openclaw`, or on the row itself. */
function rowIdempotencyKey(message: RawRecord): string | null {
  return str(meta(message).idempotencyKey) ?? str(message.idempotencyKey);
}

/**
 * Whether a user row's key names this outgoing message. The gateway records
 * a user row under the run it started for the message, with `:user` after it
 * (`${clientRunId}:user` in OpenClaw 2026.10.6's chat-send-handler). For
 * `chat.send` that run id is the send's idempotency key (`clientRunId =
 * p.idempotencyKey`); for `sessions.create` it is the run the answer named,
 * kept as the message's `runId`. A steer's `runId` is the run it joined, which
 * names another message's row, so a steer is matched by its own key only.
 * The bare key is accepted too.
 */
export function namesOutgoing(
  rowKey: string | null,
  outgoing: Pick<OutgoingMessage, "id" | "mode" | "runId">,
): boolean {
  if (rowKey === null) return false;
  if (rowKey === outgoing.id || rowKey === `${outgoing.id}:user`) return true;
  return (
    outgoing.mode !== "steer" && outgoing.runId !== null && rowKey === `${outgoing.runId}:user`
  );
}

/** A user row the gateway wrote itself (`provenance.kind: "internal_system"`), never a person's message. */
function gatewayAuthored(message: RawRecord): boolean {
  const provenance = asRecord(message.provenance) ?? asRecord(meta(message).provenance);
  return provenance?.kind === "internal_system";
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
    .filter(
      (row): row is { message: RawRecord; index: number } =>
        row.message?.role === "user" && !gatewayAuthored(row.message),
    );
  const used = new Set<number>();
  const anchors = new Map<string, string>();
  const outbox = activity.outbox.filter((outgoing) => {
    if (
      outgoing.status !== "sending" &&
      outgoing.status !== "sent" &&
      outgoing.status !== "checking" &&
      outgoing.status !== "unconfirmed" &&
      outgoing.status !== "unknown" &&
      outgoing.status !== "failed"
    ) {
      return true;
    }
    const byKey = rows.find(
      (row) => !used.has(row.index) && namesOutgoing(rowIdempotencyKey(row.message), outgoing),
    );
    const bySeq =
      byKey ??
      ((outgoing.status === "sent" || outgoing.status === "unconfirmed") &&
      outgoing.messageSeq !== null
        ? rows.find((row) => {
            if (used.has(row.index) || num(meta(row.message).seq) !== outgoing.messageSeq)
              return false;
            const key = rowIdempotencyKey(row.message);
            return key === null || namesOutgoing(key, outgoing);
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

/** Whether a message is unsent work this client still holds: its frame has not left. */
function notLeft(message: OutgoingMessage): boolean {
  if (message.status === "queued" || message.status === "held") return true;
  return (
    (message.status === "sending" || message.status === "awaiting-access") &&
    message.leftAt === null
  );
}

/**
 * After a confirmed Stop nothing starts by itself (conversation.md §15–16).
 * It is decided per stopped run, at the change that stops it: when a run that
 * was active becomes `stopped`, every message whose frame has not left
 * (`leftAt`) becomes `not-sent`, whatever its status said (queued, held, or
 * released and still waiting in the delivery chain), and their queued runs are
 * cancelled. Another run being active, or ending later, changes nothing. A
 * message whose frame left is not touched; it settles as the gateway answers
 * it. A message sent after the stop, or sent again by the person, was not
 * waiting when it stopped, so it is never parked by it.
 */
export function parkAfterStop(
  before: TaskActivity,
  after: TaskActivity,
  now: number,
): TaskActivity {
  const stopped = after.runs.some((run) => {
    const was = findRun(before, run.id)?.state;
    return run.state === "stopped" && was !== undefined && isActive(was);
  });
  if (!stopped) return after;
  const parked = after.outbox.filter(notLeft);
  if (parked.length === 0) return after;
  let next = after;
  for (const message of parked) {
    next = updateMessage(cancelQueuedRun(next, message.id, now), message.id, {
      status: "not-sent",
      runId: null,
    });
  }
  return next;
}

/**
 * Steers the gateway answered it withdrew (`chat.abort` naming their own ids, the messages'
 * ids): never run, so on the shelf, Not sent, as a message a Stop parked is. Only a steer still
 * known by its alias alone qualifies. One whose own run the gateway's events showed (the alias
 * went with them) was delivered, and the answer stopped that run: it is not withdrawn.
 */
export function markWithdrawn(activity: TaskActivity, ids: readonly unknown[]): TaskActivity {
  let next = activity;
  for (const message of activity.outbox)
    if (
      message.mode === "steer" &&
      // Left and not settled by history: the gateway's word wins over what this client concluded
      // meanwhile (a history read can mark it unconfirmed while the answer is on its way).
      ["sending", "sent", "checking", "unconfirmed", "unknown"].includes(message.status) &&
      ids.includes(message.id) &&
      Object.hasOwn(activity.steerAliases, message.id)
    )
      next = updateMessage(next, message.id, {
        status: "not-sent",
        steer: "withdrawn",
        runId: null,
      });
  return next;
}

/** Shown on a message no answer came for and history does not hold. */
export const UNKNOWN_ERROR =
  "No answer came from the gateway, and its history does not show this message. Whether it was received is not known.";

/**
 * After a history read: a message the gateway accepted whose run has ended,
 * and that the read did not tie to a row, is `unconfirmed`. Its run ending
 * means history should hold it; without a row nothing establishes delivery.
 * A message no answer came for (`checking`) was never shown to be accepted:
 * the read not finding it makes it `unknown`, never `unconfirmed`.
 */
export function markUnconfirmed(activity: TaskActivity): TaskActivity {
  let changed = false;
  const outbox = activity.outbox.map((message) => {
    if (message.status === "checking") {
      changed = true;
      return { ...message, status: "unknown" as const, error: UNKNOWN_ERROR };
    }
    if (message.status !== "sent") return message;
    const run = message.runId ? findRun(activity, message.runId) : undefined;
    if (run && !isTerminal(run.state)) return message;
    changed = true;
    return { ...message, status: "unconfirmed" as const, error: UNCONFIRMED_ERROR };
  });
  return changed ? { ...activity, outbox } : activity;
}
