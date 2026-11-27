// What a live conversation shows, derived from the engine's state and nothing
// else. Every function here is pure: the engine owns the runs, the outbox and
// the cards, and the interface only decides how they read
// (docs/design/conversation.md, sections 4, 5, 15, 16 and 17).

import {
  neverRan,
  neverStarted,
  notRunCause,
  type NotRunCause,
  actionWords,
  callFromStep,
  kindOf,
  kindPhrase,
  lineOf,
  phraseCall,
  readingContextOf,
  START_TASK_TOOL,
  type ActionCall,
  type ReadingContext,
  activeRun,
  isActive,
  runningRunId,
  questionPending,
  type OutgoingMessage,
  type Run,
  type Transcript,
} from "@clawtrate/core";

/** The state avatar's states (section 4). */
export type AvatarState =
  "idle" | "thinking" | "working" | "waiting" | "blocked" | "done" | "failed" | "stopped";

/** The task's run that is running, waiting or stopping. */
export function currentRun(transcript: Transcript | undefined): Run | undefined {
  return transcript ? activeRun(transcript) : undefined;
}

/** Whether a question from this run is pending: it holds every outgoing message (the engine's rule). */
export { questionPending };

/**
 * The status line while the gateway retries the model request by itself (F-082). Only a rate
 * limit is called one; any other reason the gateway names is not put into words it did not
 * give: the retry is said plainly, with its attempt.
 */
export function retryPhrase(retry: NonNullable<Run["retry"]>): string {
  const attempt = `Retrying, attempt ${retry.attempt} of ${retry.of}`;
  return retry.reason === "rate_limit" ? `Rate limited. ${attempt}` : attempt;
}

/**
 * The call whose running words the status line says: the latest to start
 * while it runs, then the earliest still running (7.8), by the engine's
 * reading of each call.
 */
export function phraseCallOf(run: Run, ctx: ReadingContext = {}): ActionCall | null {
  const calls = run.steps
    .filter((step) => step.kind === "tool" && step.toolCallId)
    .map((step) => callFromStep(step, run));
  return phraseCall(calls, ctx);
}

/** The status line's words for a running call: its card's running words (section 5). */
export function actionPhrase(call: ActionCall, ctx: ReadingContext = {}): string {
  const line = lineOf(call, ctx);
  return line.outcome === "review" ? actionWords.PHRASES.reviewing : line.running;
}

/**
 * A call drawn as a Messaged, T3 Code or "Started a task" card, which stays in view with commands
 * hidden (7.11). A start is a card only when it asked for a task the person sees.
 */
function hasCardInView(call: ActionCall, ctx: ReadingContext): boolean {
  const { kind } = kindOf(call, ctx);
  return (
    kind === "message" ||
    kind === "t3" ||
    (call.name === START_TASK_TOOL && call.args.visible === true)
  );
}

/** Status phases the gateway reports while no step runs (section 5). */
function phasePhrase(phase: string | null): string | null {
  if (!phase) return null;
  const value = phase.toLowerCase();
  if (/workspace|environment|sandbox/.test(value)) return "Setting up the workspace";
  if (/context|memory|compact|flush/.test(value)) return "Gathering context";
  return null;
}

export type StatusLineView = {
  /** The avatar's state. */
  state: AvatarState;
  /** The badge beside the avatar, when the state needs one. */
  badge: "waiting" | "blocked" | null;
  /** The phrase. Never empty. */
  phrase: string;
  /** The phrase's colour family: shimmering, warning or plain. */
  tone: "live" | "warn" | "muted";
  /** The run's reported start, for the elapsed time; null when it is hidden. */
  startedAt: number | null;
  /** The running call the phrase names, which the line brings into view; null when none. */
  callId: string | null;
  /**
   * With "Show thinking" on (7.11), what the bot is thinking right now: the
   * text of the reasoning the run ends on, while nothing has come after it.
   */
  thought?: string | null;
};

/** The last characters of what a bot is thinking, from a word's start: the status line shows its end. */
const THOUGHT_CHARS = 280;

/** The reasoning a running run ends on, with no reply text after it yet; null when none. */
export function liveThought(run: Run): string | null {
  const last = run.steps.at(-1);
  if (!last || last.kind !== "reasoning" || run.text.trim()) return null;
  const text = (last.output?.text ?? "").trim();
  if (!text) return null;
  if (text.length <= THOUGHT_CHARS) return text;
  const tail = text.slice(-THOUGHT_CHARS);
  return `…${tail.slice(tail.search(/\s/) + 1)}`;
}

/**
 * The status line of a run that is running, waiting or stopping: one phrase
 * and the avatar's state, by the table in section 5. While the connection is
 * lost it stops and says what was last seen; back on the connection, until the
 * open task has reloaded, it stays last seen without saying anything about the
 * connection.
 */
export function statusLineFor(
  run: Run,
  transcript: Transcript,
  options: {
    connected: boolean;
    /**
     * What this task shows is this connection's: false from a reconnect until the open task
     * has reloaded (or failed to). Defaults to true.
     */
    current?: boolean;
    interactive: boolean;
    reading?: ReadingContext | undefined;
    /** "Show commands" is off: the phrase says the kind of work (7.11). */
    quiet?: boolean;
    /** "Show thinking" is on: the thinking shows under the phrase (7.11). */
    thinking?: boolean;
  },
): StatusLineView {
  let view: StatusLineView;
  // Read as the cards read it: with what the gateway said of the task's tools and workspace.
  const ctx: ReadingContext = { ...options.reading, ...readingContextOf(transcript) };
  const call = phraseCallOf(run, ctx);
  if (run.state === "stopping") {
    view = {
      state: "idle",
      badge: null,
      phrase: "Stopping…",
      tone: "muted",
      startedAt: null,
      callId: null,
    };
  } else if (run.state === "waiting" && !options.interactive) {
    // The gateway reports the wait, but this tier is not sent the card.
    view = {
      state: "thinking",
      badge: "blocked",
      phrase: "Waiting for an answer",
      tone: "muted",
      startedAt: null,
      callId: null,
    };
  } else if (
    run.pendingCards.length > 0 ||
    transcript.questions.some((card) => card.status === "pending" && card.runId === run.id)
  ) {
    view = {
      state: "waiting",
      badge: "waiting",
      phrase: "Waiting for you",
      tone: "warn",
      startedAt: null,
      callId: null,
    };
  } else if (run.retry) {
    // The gateway retries by itself first; the failed card comes only when the retries are used up.
    view = {
      state: "thinking",
      badge: null,
      phrase: retryPhrase(run.retry),
      tone: "live",
      startedAt: null,
      callId: null,
    };
  } else if (call) {
    view = {
      state: "working",
      badge: null,
      phrase: options.quiet ? kindPhrase(call, ctx) : actionPhrase(call, ctx),
      tone: "live",
      startedAt: null,
      // Without commands shown an action has no card in view, but a Messaged or T3 Code card
      // always has one: the line brings that card into view (7.11).
      callId: !options.quiet || hasCardInView(call, ctx) ? call.id : null,
    };
  } else {
    view = {
      state: "thinking",
      badge: null,
      phrase: phasePhrase(run.phase) ?? actionWords.PHRASES.thinking,
      tone: "live",
      startedAt: null,
      callId: null,
    };
  }
  // A clock only for a start the gateway reported, never this client's own send time.
  view.startedAt = run.reportedStartAt;
  // "Show thinking" decides the thinking under the line, with commands shown or hidden (7.11).
  view.thought =
    options.thinking && view.state === "thinking" && view.tone === "live" ? liveThought(run) : null;
  if (!options.connected || options.current === false) {
    const last = view.phrase.replace(/…$/, "");
    const seen = `Last seen ${last.charAt(0).toLowerCase()}${last.slice(1)}`;
    return {
      state: "blocked",
      badge: "blocked",
      // Connected: still loading again, or its reload or live updates failed (the strip or the
      // conversation says which); never a word about the connection then.
      phrase: !options.connected
        ? `Reconnecting. ${seen}`
        : transcript.status === "error"
          ? seen
          : `Catching up. ${seen}`,
      tone: "muted",
      startedAt: null,
      callId: view.callId,
    };
  }
  return view;
}

/** "0:42", "12:05", "1:04:09". */
export function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** "48s", "1m 12s", "1h 04m", for a duration the gateway reported. */
export function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return total % 60 === 0 ? `${minutes}m` : `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** How long a run took, when both ends are known. */
export function runDuration(run: Run): string | null {
  return run.startedAt !== null && run.endedAt !== null && run.endedAt >= run.startedAt
    ? duration(run.endedAt - run.startedAt)
    : null;
}

/** What plain Enter does while a run is active (section 15). */
export type SendMode = "send" | "steer" | "queue" | "hold";

export type ComposerView = {
  placeholder: string;
  /** What plain Enter and Send do. */
  mode: SendMode;
  /** The run Stop stops, when Stop is offered. */
  stoppable: Run | null;
  /** True while the run is stopping: the composer says "Stopping…". */
  stopping: boolean;
  /** The mode word beside Send while a run is active, when there is text. */
  modeWord: "Steer" | "Queue" | "Hold" | null;
  /** The menu's items. */
  menu: "run" | "idle" | "hold";
  offline: boolean;
};

/**
 * The composer during a run, by the table in section 15. `chosen` is the mode
 * the person picked from the menu for this run, if any.
 */
export function composerFor(
  transcript: Transcript | undefined,
  options: { bot: string; connected: boolean; chosen: "steer" | "queue" | null },
): ComposerView {
  const run = currentRun(transcript);
  const offline = !options.connected;
  // A pending question holds every message, also when no run is shown as active.
  const held = !!transcript && questionPending(transcript, run);
  if (!run || !transcript) {
    return {
      placeholder: offline
        ? "Offline. Messages send when you reconnect."
        : held
          ? `Answer above, or message ${options.bot}`
          : `Message ${options.bot}`,
      mode: held ? "hold" : "send",
      stoppable: null,
      stopping: false,
      modeWord: !offline && held ? "Hold" : null,
      menu: held ? "hold" : "idle",
      offline,
    };
  }
  if (run.state === "stopping") {
    return {
      placeholder: offline
        ? "Offline. Messages send when you reconnect."
        : `Queue a message for ${options.bot}`,
      mode: "queue",
      stoppable: null,
      stopping: true,
      modeWord: null,
      menu: "run",
      offline,
    };
  }
  const waiting = run.state === "waiting" || held || run.pendingCards.length > 0;
  const mode: SendMode = held ? "hold" : options.chosen === "queue" ? "queue" : "steer";
  return {
    placeholder: offline
      ? "Offline. Messages send when you reconnect."
      : waiting
        ? `Answer above, or message ${options.bot}`
        : `Message ${options.bot}`,
    mode,
    // Offline the composer is its offline form: Send alone.
    // Only one current run, as the engine establishes it (`runningRunId`), is offered Stop.
    stoppable:
      isActive(run.state) && !offline && runningRunId(transcript, run.id) === run.id ? run : null,
    stopping: false,
    modeWord: offline ? null : mode === "hold" ? "Hold" : mode === "queue" ? "Queue" : "Steer",
    menu: held ? "hold" : "run",
    offline,
  };
}

/** The Send button's name: what it will do. */
export function sendName(mode: SendMode): string {
  switch (mode) {
    case "send":
      return "Send";
    case "steer":
      return "Request a steer";
    case "queue":
      return "Queue after this turn";
    case "hold":
      return "Hold until you answer";
  }
}

/** A queued message the gateway refused to start: it stays on the shelf, "Couldn't start". */
export function couldNotStart(message: OutgoingMessage): boolean {
  return message.status === "failed" && message.mode === "queue";
}

/** Messages shown as your bubbles at the foot of the transcript, in the order sent. */
export function outgoingBubbles(transcript: Transcript): OutgoingMessage[] {
  return transcript.outbox.filter(
    (message) =>
      message.status !== "queued" &&
      message.status !== "held" &&
      message.status !== "not-sent" &&
      message.status !== "cancelled" &&
      message.status !== "handled" &&
      !couldNotStart(message),
  );
}

/**
 * Rows on the shelf above the pill, oldest first: queued and held messages,
 * those left after a confirmed Stop, and queued ones the gateway refused to
 * start. None of them is in the transcript, because none was sent.
 */
export function shelfMessages(transcript: Transcript | undefined): OutgoingMessage[] {
  return (transcript?.outbox ?? []).filter(
    (message) =>
      message.status === "queued" ||
      message.status === "held" ||
      message.status === "not-sent" ||
      couldNotStart(message),
  );
}

/** A run's ending, said as section 16 and 17 say it. */
export type RunEnding =
  | {
      kind: "stopped";
      after: string | null;
      elsewhere: boolean;
      /** This client stopped it after that many tool calls in a row timed out (F-101). */
      timeouts: number | null;
    }
  | { kind: "finished-before-stop" }
  /** Stop was asked for, and the run has ended, but nothing the gateway sent says how. */
  | { kind: "stop-unknown" }
  /** This client stopped the run at the person's "Turn time limit" (F-100), once confirmed. */
  | { kind: "turn-limit"; minutes: number }
  /** The gateway ended the run at a time limit of its own (its run's `timeoutPhase`). */
  | { kind: "gateway-timeout"; reason: string | null }
  /** The gateway failed the run's message before any run of it started (#663): why, if it said. */
  | { kind: "not-run"; cause: NotRunCause | null }
  /** The gateway accepted the message, then ended it with no run and no word (#663). */
  | { kind: "not-started" }
  | { kind: "failed"; reason: string };

/** The ways forward a not-run line offers before "Try again": the bot's model, its account. */
export type NotRunWay = "model" | "account";

export type NotRunWords = { title: string; reason: string; ways: NotRunWay[] };

/**
 * What the line under a message the gateway couldn't run says (#663, F-480): the gateway's reason
 * in plain words and what to do, or its own words when they are none of the known kinds. Nothing
 * is said that the gateway did not.
 */
export function notRunWords(
  ending: Extract<RunEnding, { kind: "not-run" | "not-started" }>,
  bot: string,
  earlier = false,
): NotRunWords {
  if (ending.kind === "not-started")
    return {
      title: "The gateway didn't start a run for this message",
      reason: "It didn't say why.",
      ways: [],
    };
  const title = earlier
    ? "The gateway couldn't run an earlier message"
    : "The gateway couldn't run this message";
  const cause = ending.cause;
  switch (cause?.kind) {
    case "needs-api-key":
      return {
        title,
        reason: `${bot} is set to a model that needs a provider API key, but the account it uses is a sign-in. Choose a model that works with that sign-in, or add an API key.`,
        ways: ["model", "account"],
      };
    case "needs-sign-in":
      return {
        title,
        reason: `${bot} is set to a model that needs a subscription sign-in, but the account it uses is an API key. Choose a model that works with that key, or sign in.`,
        ways: ["model", "account"],
      };
    case "account-missing":
      return {
        title,
        reason: `The account ${bot} is set to isn't available on the gateway. Choose another account.`,
        ways: ["account"],
      };
    case "account-other-provider":
      return {
        title,
        reason: `The account ${bot} is set to isn't set up for its model's provider. Choose an account for that provider, or another model.`,
        ways: ["account", "model"],
      };
    case "model-unknown":
      return {
        title,
        reason: `The gateway doesn't know ${bot}'s model. Choose another model.${cause.words ? ` The gateway said: ${cause.words}` : ""}`,
        ways: ["model"],
      };
    case "no-account":
      return {
        title,
        reason: `The gateway found no account it can use for the provider of ${bot}'s model. Add an account, or choose another model.`,
        ways: ["account", "model"],
      };
    case "other":
      return { title, reason: `The gateway said: ${cause.words ?? ""}`, ways: [] };
    default:
      return { title, reason: "The gateway didn't say why.", ways: [] };
  }
}

/**
 * A failed run no message is known to have started (#686): it has no keyed anchor
 * (`Run.anchorKeyed`) and this client holds none it sent. Its line is said to be for an earlier
 * message and offers no Try again: the latest message by position may be another one, already
 * answered.
 */
export function forEarlierMessage(run: Run, transcript: Pick<Transcript, "outbox">): boolean {
  // Only a keyed anchor says which message it was; a position drawn for it says nothing (#686).
  return !run.anchorKeyed && !transcript.outbox.some((message) => message.id === run.messageId);
}

/** The failed-turn card's title: for an earlier turn when no message is known to have started it. */
export function failedTurnTitle(bot: string, earlier: boolean): string {
  return earlier ? `${bot} couldn't finish an earlier turn` : `${bot} couldn't finish this turn`;
}

/**
 * How a finished run ended, when the transcript says more than its text. A stop is this
 * client's only when its own Stop of that run stands (`stopRequestedAt`, cleared when the gateway
 * refused it; a typed `/stop` marks the exact runs its answer names).
 */
export function endingOf(run: Run, _transcript?: Transcript): RunEnding | null {
  if (run.state === "completed" && run.finishedBeforeStop) return { kind: "finished-before-stop" };
  if (neverStarted(run)) return { kind: "not-started" };
  if (run.state === "stopped") {
    if (!run.outcomeKnown) return run.stopRequestedAt !== null ? { kind: "stop-unknown" } : null;
    if (run.turnLimit !== undefined && run.turnLimit > 0)
      return { kind: "turn-limit", minutes: run.turnLimit };
    return {
      kind: "stopped",
      after: runDuration(run),
      elsewhere: run.stopRequestedAt === null,
      // 0: the automatic stop failed, so this stop is not the timeouts'.
      timeouts: run.stoppedForTimeouts ? run.stoppedForTimeouts : null,
    };
  }
  if (run.state === "failed") {
    if (run.ending?.timeoutPhase)
      return { kind: "gateway-timeout", reason: run.error?.message ?? null };
    if (neverRan(run)) return { kind: "not-run", cause: notRunCause(run.error?.message) };
    return { kind: "failed", reason: run.error?.message || "The gateway gave no reason." };
  }
  return null;
}
