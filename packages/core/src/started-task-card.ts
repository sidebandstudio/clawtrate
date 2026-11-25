// The "Started a task" card (F-587): each task a bot starts with the gateway's `sessions_spawn`
// (`visible: true`), in the conversation it was started from. A typed view over that call's step
// and the task list; nothing is kept. What the bot wrote, its label and its brief, is content,
// cleaned and bounded like any title. Which task the card opens, and that it was started from
// here, come only from the gateway's own fields: the call's result names the task
// (`childSessionKey`), and the task list of this connection lists that task as started from this
// conversation (`Task.startedBy.fromKey`).

import { callArgs, resultBody, sendDetails } from "./cards.ts";
import { cleanLine } from "./gateway-names.ts";
import { asRecord, botIdFromSessionKey, REPORT_RUN_PREFIX } from "./mapping.ts";
import { isOpenStep, type Run, type Step, type StepRaw } from "./runs.ts";
import { MAX_TITLE_CHARS } from "./state-bounds.ts";
import type { ClawtrateState, Task, TaskStatus, TranscriptItem } from "./types.ts";

/** The gateway's tool a bot starts a task with. */
export const START_TASK_TOOL = "sessions_spawn";

/** The longest first line of a brief a card shows. */
export const MAX_BRIEF_LINE_CHARS = 280;

/** The longest refusal reason a card shows. */
export const MAX_REFUSAL_CHARS = 1_120;

export type StartedTaskState =
  /** The call is open: nothing yet says whether the gateway started the task. */
  | "starting"
  /** The gateway started it, and the task list here does not list it as started from here. */
  | "started"
  /** Listed as started from here, and its row says nothing of a run: the sidebar shows no state. */
  | "idle"
  // The task's own state, as its row in the task list says it (`Task.status`).
  | "queued"
  | "working"
  | "waiting"
  | "blocked"
  | "done"
  | "done-with-failures"
  | "failed"
  | "stopped"
  /** The gateway refused the start or it failed: `reason` says why, in the gateway's words. */
  | "couldnt-start"
  /** The call closed without a result that says what happened. */
  | "unknown";

/** A listed task's state, word for word what its row in the task list says. */
const FROM_STATUS: Record<TaskStatus, StartedTaskState> = {
  running: "working",
  queued: "queued",
  waiting: "waiting",
  blocked: "blocked",
  done: "done",
  idle: "idle",
  "done-with-failures": "done-with-failures",
  failed: "failed",
  stopped: "stopped",
};

export type StartedTaskCard = {
  /** The step id, `tool:<toolCallId>`; one card per call. */
  id: string;
  stepId: string;
  toolCallId: string | null;
  /** The run of this conversation that made the call. */
  runId: string;
  /**
   * The bot doing the work: the one the result's task key names, or before a result, or for a
   * refusal, the call's `agentId`. Null when neither names one: the conversation's own bot.
   */
  agentId: string | null;
  /** The bot's label for the task, cleaned and bounded. */
  label: string | null;
  /** The first line of the bot's brief, cleaned and bounded. */
  brief: string | null;
  /** The task the gateway's result names (`childSessionKey`), only on an accepted start. */
  taskKey: string | null;
  /**
   * That task in this connection's task list, listed as started from this conversation: the only
   * task Open goes to, and the only source of its state. Null when the list does not hold it so.
   */
  task: Task | null;
  /** What the card calls the task: its listed title, or the bot's label. */
  title: string | null;
  state: StartedTaskState;
  /** The gateway's reason, as it gave it, when the start was refused or failed. */
  reason: string | null;
  /** `result.status` exactly as sent. */
  resultStatus: string | null;
  /** The transcript item of the bot's report after the task ended (`REPORT_RUN_PREFIX`). */
  reportedBack: string | null;
  requestedAt: number | null;
  endedAt: number | null;
  correction: number;
};

export type StartedTaskInput = {
  runs: Run[];
  items: TranscriptItem[];
  /** The conversation the cards are drawn in. */
  taskKey: string;
  /** The task list of the connection the conversation is shown from (`tasksShownHere`). */
  tasks: Record<string, Task[]>;
};

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** The first line with text of what a bot wrote, cleaned (`cleanLine`) and cut to `max`; null when none. */
function firstLine(value: unknown, max: number): string | null {
  const text = str(value);
  const line = text?.split(/\r?\n/).find((each) => cleanLine(each, max) !== "");
  return line ? cleanLine(line, max) : null;
}

/**
 * The call's arguments: the whole payload when it is here, else what the step keeps of them
 * (`Step.args`), as an open call's payload is not read before it ends.
 */
function argsOf(step: Step, raw: StepRaw | null): Record<string, unknown> | null {
  return callArgs(raw) ?? step.args ?? null;
}

/**
 * What the call's result says: the whole payload's, else the tool's JSON object as the step keeps
 * its result text, when it keeps all of it. A start's result is a short object, so the step holds
 * it whole; a payload that could not be read, or was let go, then leaves the card what it knew.
 */
function resultOf(step: Step, raw: StepRaw | null): Record<string, unknown> | null {
  const details = sendDetails(resultBody(raw));
  if (details || !step.result || step.result.text.length < step.result.totalChars) return details;
  try {
    const kept = asRecord(JSON.parse(step.result.text));
    return kept && !Array.isArray(kept) && str(kept.status) ? kept : null;
  } catch {
    return null;
  }
}

/** A hidden helper's key (`agent:<bot>:subagent:<id>`): the task list leaves it out. */
const HIDDEN_KEY = /^agent:[^:]+:subagent:/;

/**
 * Whether a call is a task started for the person to see: the gateway's `sessions_spawn`, whose
 * result names a task outside the hidden helpers, or, before a result and for a refusal, whose
 * call asked for one (`visible: true`). A hidden helper stays a step line.
 */
export function isTaskStart(step: Step, raw: StepRaw | null): boolean {
  if (step.kind !== "tool" || step.toolName !== START_TASK_TOOL) return false;
  const details = resultOf(step, raw);
  const key = details?.status === "accepted" ? str(details.childSessionKey) : null;
  if (key) return !HIDDEN_KEY.test(key);
  return argsOf(step, raw)?.visible === true;
}

/**
 * The task list as the conversation on screen may use it: the list in state when it was read on
 * the gateway the host is pointed at now (`discovery.tasksRead`), else none. The host resets the
 * list and every transcript together when it is pointed at another gateway, so a conversation and
 * the list in one state are the same gateway's; this keeps a card from using a list read on
 * another target or another gateway's identity whatever the order of updates.
 */
export function tasksShownHere(
  state: Pick<ClawtrateState, "tasksByBot" | "discovery" | "connection">,
): Record<string, Task[]> {
  const read = state.discovery.tasksRead;
  const { target, gatewayId } = state.connection;
  if (!read) return state.tasksByBot;
  const same =
    read.target === target &&
    (read.gatewayId === null || gatewayId === null || read.gatewayId === gatewayId);
  return same ? state.tasksByBot : NONE;
}

/** No tasks: one object, so a view that compares lists sees no change. */
const NONE: Record<string, Task[]> = Object.freeze({});

/** The listed task with this key that the list says was started from `fromKey`, or null. */
export function startedTaskOf(
  tasks: Record<string, Task[]>,
  key: string | null,
  fromKey: string,
): Task | null {
  if (!key) return null;
  for (const list of Object.values(tasks)) {
    const task = list.find((each) => each.key === key);
    if (task) return task.startedBy?.fromKey === fromKey ? task : null;
  }
  return null;
}

/** The bot's report after this start's own run ended: the item whose run is exactly that report. */
function reportOf(
  items: TranscriptItem[],
  key: string | null,
  runId: string | null,
): string | null {
  if (!key || !runId) return null;
  const run = `${REPORT_RUN_PREFIX}${key}:${runId}`;
  return items.find((item) => item.role === "assistant" && item.reportRunId === run)?.id ?? null;
}

function startedTaskCard(
  step: Step,
  run: Run,
  raw: StepRaw | null,
  input: StartedTaskInput,
): StartedTaskCard {
  const args = argsOf(step, raw);
  const details = resultOf(step, raw);
  const status = str(details?.status);
  const accepted = status === "accepted";
  const taskKey = accepted ? str(details?.childSessionKey) : null;
  const childRun = accepted ? str(details?.runId) : null;
  const task = startedTaskOf(input.tasks, taskKey, input.taskKey);
  const labelText = str(args?.label);
  const label = labelText ? cleanLine(labelText, MAX_TITLE_CHARS) || null : null;
  const hasResult = (raw?.result !== null && raw?.result !== undefined) || step.result !== null;

  let state: StartedTaskState;
  let reason: string | null = null;
  if (isOpenStep(step)) state = "starting";
  else if (accepted) state = task ? FROM_STATUS[task.status] : "started";
  else if (status === "forbidden" || status === "error") {
    state = "couldnt-start";
    reason = str(details?.error) ?? step.error;
  } else if (hasResult && step.status === "failed") {
    // A result that is not the gateway's object (an exception's text): still a refusal, in its words.
    state = "couldnt-start";
    reason = step.error;
  } else state = "unknown";

  return {
    id: step.id,
    stepId: step.id,
    toolCallId: step.toolCallId,
    runId: run.id,
    agentId: (taskKey ? botIdFromSessionKey(taskKey) : null) ?? str(args?.agentId),
    label,
    brief: firstLine(args?.task, MAX_BRIEF_LINE_CHARS),
    taskKey,
    task,
    // The listed title is the gateway's copy of a label a bot or person wrote: cleaned the same way.
    title: (task ? cleanLine(task.title, MAX_TITLE_CHARS) : "") || label,
    state,
    reason: reason === null ? null : cleanLine(reason, MAX_REFUSAL_CHARS) || null,
    resultStatus: status,
    reportedBack: reportOf(input.items, taskKey, childRun),
    requestedAt: step.startedAt,
    endedAt: step.endedAt,
    correction: step.correction,
  };
}

/** The "Started a task" cards of a conversation, in the order of its calls. */
export function selectStartedTasks(
  input: StartedTaskInput,
  rawOf: (step: Step) => StepRaw | null = (step) => step.raw,
): StartedTaskCard[] {
  const cards: StartedTaskCard[] = [];
  for (const run of input.runs) {
    for (const step of run.steps) {
      const raw = rawOf(step);
      if (isTaskStart(step, raw)) cards.push(startedTaskCard(step, run, raw, input));
    }
  }
  return cards;
}
