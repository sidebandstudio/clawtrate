// How a run's actions are laid out (docs/design/conversation.md, sections 7.4
// to 7.8): one pure function over a run's ordered record, live or from
// history, so the live run, a reload and a second device draw the same cards.
// Actions of one key in a row fold; a bubble, a card or a note between them
// breaks the fold; reasoning is not shown, so it breaks nothing, and belongs
// to the next action, else to the reply that follows, else to the run's end.

import { RUN_LINE, durationWords } from "./action-words.ts";
import { sha256Hex, utf8Bytes } from "./bytes.ts";
import {
  isOpenOutcome,
  kindOf,
  lineOf,
  outcomeOf,
  problemOf,
  projectDetails,
  type ActionCall,
  type ActionKind,
  type ActionLine,
  type ReadingContext,
} from "./actions.ts";
import { isTerminal, type Run, type Step } from "./runs.ts";
import type { Transcript, TranscriptBlock } from "./types.ts";

/** One reasoning segment, as the engine keeps it. */
export type ThoughtSegment = {
  id: string;
  text: string;
  startedAt: number | null;
  endedAt: number | null;
};

/** The reasoning that led to one thing: one or more segments, their durations added. */
export type Thought = {
  /** The first segment's id: the "Thought" line's view state is kept under it. */
  id: string;
  segments: ThoughtSegment[];
  /** The summed duration, or null when a segment has no times or the sum is zero. */
  ms: number | null;
};

/**
 * An item of a run's ordered record. `card` is a card in the column (a
 * Messaged or T3 Code card): it never folds and ends a fold, but not a
 * column. `bubble` is the bot's text. `break` is anything else shown between
 * (a request card, a note, your message): it ends the fold and the column.
 */
export type FeedEntry<R> =
  | { type: "action"; call: ActionCall }
  | { type: "reasoning"; segment: ThoughtSegment }
  | { type: "card"; id: string; ref: R }
  | { type: "bubble"; id: string; ref: R }
  | { type: "break"; id: string; ref: R };

export type FeedMember = { call: ActionCall; thought: Thought | null };

export type FeedGroup<R> =
  | { type: "action"; key: string; call: ActionCall; thought: Thought | null }
  | { type: "fold"; key: string; members: FeedMember[] }
  | { type: "card"; key: string; ref: R; thought: Thought | null }
  | { type: "bubble"; key: string; ref: R }
  | { type: "break"; key: string; ref: R }
  /** Reasoning over a reply (`reply`), or at the end of a run with neither an action nor a reply after it. */
  | { type: "thought"; key: string; thought: Thought; place: "reply" | "end" };

function thoughtOf(segments: ThoughtSegment[]): Thought {
  const spans = segments.map((s) =>
    s.startedAt !== null && s.endedAt !== null && s.endedAt >= s.startedAt
      ? s.endedAt - s.startedAt
      : null,
  );
  const total = spans.every((s) => s !== null) ? spans.reduce<number>((t, s) => t + s!, 0) : null;
  // Under half a second reads as no duration: the line says "Thought", never a zero (7.5).
  return { id: segments[0]!.id, segments, ms: total !== null && total >= 500 ? total : null };
}

/**
 * Group a run's ordered record into cards, folds, bubbles and "Thought"
 * lines (7.4, 7.5). Pure: the same record always gives the same groups, keyed
 * by the gateway's tool call ids (a fold by its first member's).
 */
export function groupFeed<R>(entries: FeedEntry<R>[], ctx: ReadingContext = {}): FeedGroup<R>[] {
  // Where each reasoning segment belongs: the next action or card, else the next bubble.
  const owner = new Map<number, number | "end">();
  entries.forEach((entry, i) => {
    if (entry.type !== "reasoning") return;
    let target: number | "end" = "end";
    let bubble: number | null = null;
    for (let j = i + 1; j < entries.length; j++) {
      const next = entries[j]!;
      if (next.type === "action" || next.type === "card") {
        target = j;
        break;
      }
      if (next.type === "bubble" && bubble === null) bubble = j;
    }
    owner.set(i, target === "end" && bubble !== null ? bubble : target);
  });
  const segmentsFor = (j: number | "end") =>
    entries.flatMap((entry, i) =>
      entry.type === "reasoning" && owner.get(i) === j ? [entry.segment] : [],
    );
  const thoughtFor = (j: number | "end") => {
    const segments = segmentsFor(j);
    return segments.length ? thoughtOf(segments) : null;
  };

  const groups: FeedGroup<R>[] = [];
  // The group an action with the same key may join: only while nothing has been shown since.
  let open: { key: string; index: number } | null = null;
  entries.forEach((entry, i) => {
    switch (entry.type) {
      case "reasoning":
        return;
      case "action": {
        const key = kindOf(entry.call, ctx).key;
        const thought = thoughtFor(i);
        const last = open ? groups[open.index] : undefined;
        if (key !== null && open && open.key === key && last) {
          const member = { call: entry.call, thought };
          if (last.type === "action") {
            groups[open.index] = {
              type: "fold",
              key: last.key,
              members: [{ call: last.call, thought: last.thought }, member],
            };
          } else if (last.type === "fold") {
            last.members.push(member);
          }
          return;
        }
        groups.push({ type: "action", key: entry.call.id, call: entry.call, thought });
        open = key !== null ? { key, index: groups.length - 1 } : null;
        return;
      }
      case "card":
        groups.push({ type: "card", key: entry.id, ref: entry.ref, thought: thoughtFor(i) });
        open = null;
        return;
      case "bubble": {
        const thought = thoughtFor(i);
        if (thought) groups.push({ type: "thought", key: thought.id, thought, place: "reply" });
        groups.push({ type: "bubble", key: entry.id, ref: entry.ref });
        open = null;
        return;
      }
      case "break":
        groups.push({ type: "break", key: entry.id, ref: entry.ref });
        open = null;
        return;
    }
  });
  const end = thoughtFor("end");
  if (end) groups.push({ type: "thought", key: end.id, thought: end, place: "end" });
  return groups;
}

/** Every action call in a list of groups, in order. */
export function callsOf<R>(groups: FeedGroup<R>[]): ActionCall[] {
  return groups.flatMap((g) =>
    g.type === "action" ? [g.call] : g.type === "fold" ? g.members.map((m) => m.call) : [],
  );
}

// Questions ----------------------------------------------------------------------------

/**
 * The id the gateway gives the question an `ask_user` call asks: `ask_` and
 * the first 32 hex characters of SHA-256 over its run id (else its session
 * key), a NUL, and the call's id (OpenClaw 2026.10.6 `buildAskUserQuestionId`).
 * It is computed before the call's input is checked, and the question is
 * registered only when the input is valid: a call that failed first has no
 * question, and a question is matched to its call by this id, never by order.
 */
export function askUserQuestionId(runIdOrSessionKey: string, toolCallId: string): string {
  return `ask_${sha256Hex(utf8Bytes(`${runIdOrSessionKey.trim()}\0${toolCallId}`)).slice(0, 32)}`;
}

// From the engine's state ------------------------------------------------------------

/**
 * What a task's transcript tells the reading: the gateway's map of
 * tool-server names, the built-in and plugin tools of its inventory, and the
 * bot's workspace root, each only as the gateway gave it.
 */
export function readingContextOf(transcript: {
  mcpTools: Transcript["mcpTools"];
  builtinTools?: string[] | undefined;
  workspaceRoot?: string | null | undefined;
}): ReadingContext {
  return {
    toolServers: transcript.mcpTools,
    builtinTools: transcript.builtinTools ?? [],
    workspaceRoot: transcript.workspaceRoot ?? null,
  };
}

function parseArgs(text: string | null | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Kinds whose result text is what the tool read, ran or wrote, never its own
 * payload: a file's content, a command's output, a document's analysis, an
 * edit's sentence. Every other tool returns its payload as JSON text
 * (`jsonResult`), alone or after a line of words.
 */
const CONTENT_KINDS: Partial<Record<ActionKind, true>> = {
  read: true,
  list: true,
  command: true,
  terminal: true,
  look: true,
  edit: true,
  memory: true,
};

/** The JSON object a result's text carries: the whole text, or a block after its words. */
function payloadText(text: string): unknown {
  const t = text.trim();
  if (!t.endsWith("}")) return null;
  // The whole text first, then each later "{" that may open the block (a few at most).
  let at = t.startsWith("{") ? 0 : t.indexOf("{");
  for (let tries = 0; at !== -1 && tries < 16; tries += 1) {
    try {
      const value: unknown = JSON.parse(t.slice(at));
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // Not the block: try the next brace.
    }
    at = t.indexOf("{", at + 1);
  }
  return null;
}

/**
 * The one way a call's payload is read, live and from history alike: the
 * result's own JSON, where its text carries it, under whatever `details` were
 * kept. History keeps only a few detail keys (the gateway's chat display
 * projection: exit code, duration, folder, session, `ok`, `changed`,
 * `created`, diff), so without the text's payload a reloaded call would read
 * less, or more, than the live one. Text that carries no payload adds nothing.
 */
export function withPayload(call: ActionCall): ActionCall {
  if (!call.text || CONTENT_KINDS[kindOf(call).kind]) return call;
  const value = payloadText(call.text);
  // The computer's text is its act's result, which its details carry under `result`.
  const parsed = projectDetails(
    value && kindOf(call).kind === "computer" ? { result: value } : value,
  );
  if (!parsed) return call;
  return { ...call, details: { ...parsed, ...(call.details ?? {}) } };
}

/** Whether a run that ended left a call open because it hit its time limit. */
function cutOff(run: Pick<Run, "state" | "error" | "ending">): boolean {
  return (
    run.state === "failed" &&
    (run.error?.kind === "turn-limit" ||
      run.error?.kind === "timeout" ||
      !!run.ending?.timeoutPhase)
  );
}

/** A tool step as the reading takes it. */
export function callFromStep(
  step: Step,
  run: Pick<Run, "state" | "error" | "ending" | "origin">,
): ActionCall {
  const open = step.status === "running" || step.status === "waiting";
  const status: ActionCall["status"] = !open
    ? "returned"
    : isTerminal(run.state)
      ? cutOff(run)
        ? "cut-off"
        : run.state === "stopped" || run.state === "cancelled"
          ? "stopped"
          : "unreturned"
      : step.status === "waiting"
        ? "waiting"
        : "running";
  return withPayload({
    id: step.toolCallId ?? step.id,
    name: step.toolName ?? "",
    args: step.args ?? parseArgs(step.argsText?.text),
    status,
    isError: step.status === "failed",
    text: open ? null : (step.result?.text ?? ""),
    details: step.details ?? null,
    commandBearing: step.commandBearing === true,
    // History rows' times are not the call's own: no duration is read from them.
    startedAt: step.rowTimes ? null : step.startedAt,
    endedAt: open || step.rowTimes ? null : step.endedAt,
    fromHistory: run.origin === "history" && !step.details,
    partial: open ? (step.output?.text ?? null) : null,
    runStopped: run.state === "stopped" || run.state === "cancelled",
    ...(step.gatewayTitle ? { gatewayTitle: step.gatewayTitle } : {}),
  });
}

/** A tool-call block of a history item, as the reading takes it; its step, when the engine has one, says more. */
export function callFromBlock(
  block: Extract<TranscriptBlock, { kind: "tool-call" }>,
  step: Step | undefined,
  run: Pick<Run, "state" | "error" | "ending" | "origin"> | undefined,
): ActionCall {
  if (step && run) {
    const fromStep = callFromStep(step, run);
    // A viewer sent only item events has no arguments for the call: history's block has them.
    const call = Object.keys(fromStep.args).length
      ? fromStep
      : { ...fromStep, args: parseArgs(block.argumentsText) };
    // History holds no result, and the step's error says nothing (it came from an item's end,
    // not a result): nothing establishes how the call ended.
    if (!block.result && call.isError && !call.text)
      return { ...call, status: "unreturned", isError: false, text: null };
    // History holds a result the engine's step does not have yet: history is newer.
    if (block.result && (call.status !== "returned" || !call.text))
      return withPayload({
        ...call,
        status: "returned",
        isError: block.result.isError,
        text: block.result.text,
        partial: null,
      });
    return call;
  }
  return withPayload({
    id: block.callId,
    name: block.name,
    args: parseArgs(block.argumentsText),
    // History holds no result for it, and nothing here says why.
    status: block.result ? "returned" : "unreturned",
    isError: block.result?.isError === true,
    text: block.result?.text ?? null,
    details: block.result?.facts ?? null,
    commandBearing: false,
    startedAt: null,
    endedAt: null,
    fromHistory: true,
  });
}

/** A reasoning step as a segment. */
export function segmentFromStep(step: Step): ThoughtSegment {
  return {
    id: step.id,
    text: step.output?.text ?? "",
    startedAt: step.rowTimes ? null : step.startedAt,
    endedAt: step.status === "running" || step.rowTimes ? null : step.endedAt,
  };
}

// The status line ----------------------------------------------------------------------

/**
 * The call whose running words the status line says (7.8): the latest to
 * start while it runs; when it ends, the earliest still running.
 */
export function phraseCall(calls: ActionCall[], ctx: ReadingContext = {}): ActionCall | null {
  const running = (c: ActionCall) => {
    const o = outcomeOf(c, ctx).outcome;
    return o === "running" || o === "review";
  };
  const latest = calls.at(-1);
  if (latest && running(latest)) return latest;
  return calls.find(running) ?? null;
}

/** The status line's phrase from an action: its running words, or "Reviewing a command". */
export function phraseLine(call: ActionCall, ctx: ReadingContext = {}): ActionLine {
  return lineOf(call, ctx);
}

// What retention left out --------------------------------------------------------------

/** How many of a run's actions are drawn, how many the gateway reported, and where the rest were. */
export type RetentionAccount = {
  /** Actions the gateway reported for the run: every one the engine saw, and any more drawn. */
  reported: number;
  /** Actions drawn, from the engine's record and history's together. */
  shown: number;
  /** Actions missing directly before a drawn call, by its call id; only where some are missing. */
  before: Map<string, number>;
  /** Actions missing after the last drawn call the engine kept. */
  atEnd: number;
};

/**
 * The one account of what a run's transcript draws against what the gateway
 * reported, after the live record and history are combined (7.7). `drawn` is
 * every call id the transcript draws for the run, in order, from the engine's
 * steps and from history's rows alike. A call the engine dropped
 * (`omittedBefore`, `omittedToolsAtEnd`) that history draws is not missing;
 * a gap is said only where calls are missing from what is drawn, and the
 * run line's counts are these.
 */
export function retentionAccount(
  run: Pick<Run, "steps"> & Partial<Pick<Run, "omittedTools" | "omittedToolsAtEnd">>,
  drawn: readonly string[],
): RetentionAccount {
  const kept = new Map<string, number>();
  for (const step of run.steps)
    if (step.kind === "tool" && step.toolCallId) kept.set(step.toolCallId, step.omittedBefore ?? 0);
  const seen = new Set<string>();
  const before = new Map<string, number>();
  // Calls drawn since the last call the engine kept, which the engine did not keep.
  let extras = 0;
  for (const id of drawn) {
    if (seen.has(id)) continue;
    seen.add(id);
    const dropped = kept.get(id);
    if (dropped === undefined) {
      extras += 1;
      continue;
    }
    if (dropped > extras) before.set(id, dropped - extras);
    extras = 0;
  }
  const atEnd = Math.max(0, (run.omittedToolsAtEnd ?? 0) - extras);
  const missing = [...before.values()].reduce((sum, n) => sum + n, 0) + atEnd;
  const engine = kept.size + (run.omittedTools ?? 0);
  return {
    reported: Math.max(engine, seen.size + missing),
    shown: seen.size,
    before,
    atEnd,
  };
}

// The run line ------------------------------------------------------------------------

export type RunLine = {
  /** "Worked for 1m 12s", "Stopped after 40s", "Failed after 12s". */
  label: string;
  /** The actions the run reported: those shown and those not kept. */
  actions: number;
  /** Of them, the actions shown; less than `actions` when some were not kept. */
  shown: number;
  /** Failed and Not run. */
  failed: number;
  /** "1 unavailable", "1 not sent", "1 stopped", "1 unknown", in that order. */
  problems: string[];
  /** The whole line, for its accessible name. */
  text: string;
};

/**
 * The run line (7.7): only for a run that ended with at least one action. It
 * counts actions, not cards, and reports a duration only when the gateway
 * reported both ends.
 */
export function runLineOf(
  run: Pick<Run, "state" | "startedAt" | "endedAt" | "reportedStartAt"> &
    Partial<Pick<Run, "omittedTools" | "endFromRows">>,
  calls: ActionCall[],
  ctx: ReadingContext = {},
  /** What the transcript draws of the run (`retentionAccount`); without it, the engine's count. */
  account?: Pick<RetentionAccount, "reported" | "shown">,
): RunLine | null {
  const reported = account?.reported ?? calls.length + (run.omittedTools ?? 0);
  const drawn = account?.shown ?? calls.length;
  if (!isTerminal(run.state) || run.state === "cancelled" || reported === 0) return null;
  // Only times the gateway reported: its lifecycle start, and an end that is not a history row's.
  const start = run.reportedStartAt;
  const end = run.endFromRows ? null : run.endedAt;
  const after = start !== null && end !== null && end > start ? durationWords(end - start) : null;
  const label =
    run.state === "stopped"
      ? RUN_LINE.stopped(after)
      : run.state === "failed"
        ? RUN_LINE.failed(after)
        : RUN_LINE.worked(after);
  const problems = calls.map((c) => problemOf(outcomeOf(c, ctx).outcome));
  const failed = problems.filter((p) => p === "failed" || p === "notRun").length;
  const n = (p: string) => problems.filter((each) => each === p).length;
  const others = [
    n("unavailable") ? RUN_LINE.problem.unavailable(n("unavailable")) : "",
    n("suppressed") ? RUN_LINE.problem.suppressed(n("suppressed")) : "",
    n("stopped") ? RUN_LINE.problem.stopped(n("stopped")) : "",
    n("unknown") ? RUN_LINE.problem.unknown(n("unknown")) : "",
  ].filter(Boolean);
  const count = RUN_LINE.actions(reported);
  const shown = reported > drawn ? RUN_LINE.shown(drawn) : "";
  const text = [label, count, shown, failed ? RUN_LINE.failedCount(failed) : "", ...others]
    .filter(Boolean)
    .join(" · ");
  return { label, actions: reported, shown: drawn, failed, problems: others, text };
}

/** Whether any call is still open, so the run's actions are live. */
export function anyOpen(calls: ActionCall[], ctx: ReadingContext = {}): boolean {
  return calls.some((c) => isOpenOutcome(outcomeOf(c, ctx).outcome));
}
