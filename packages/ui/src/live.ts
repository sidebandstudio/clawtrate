// What a live conversation shows, derived from the engine's state and nothing
// else. Every function here is pure: the engine owns the runs, the outbox and
// the cards, and the interface only decides how they read
// (docs/design/conversation.md, sections 4, 5, 15, 16 and 17).

import {
  activeRun,
  isActive,
  type OutgoingMessage,
  type Run,
  type Step,
  type Transcript,
} from "@clawtrate/core";

/** The state avatar's states (section 4). */
export type AvatarState =
  "idle" | "thinking" | "working" | "waiting" | "blocked" | "done" | "failed" | "stopped";

/** The task's run that is running, waiting or stopping. */
export function currentRun(transcript: Transcript | undefined): Run | undefined {
  return transcript ? activeRun(transcript) : undefined;
}

/** Whether a question from this run is pending: it holds every outgoing message. */
export function questionPending(transcript: Transcript, run: Run): boolean {
  return (
    transcript.questions.some((card) => card.status === "pending" && card.runId === run.id) ||
    [...run.pendingCards, ...run.suspendedCards].some((card) => card.kind === "question")
  );
}

/** The step that is running now, the latest first. */
export function runningStep(run: Run): Step | undefined {
  return [...run.steps].reverse().find((step) => step.status === "running");
}

/** The first line of a step's arguments, parsed when they are JSON. */
function argumentsOf(step: Step): Record<string, unknown> {
  const text = step.argsText?.text;
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function firstString(args: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** The last part of a path, so a phrase stays short. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

/**
 * A running step's title in plain words (section 8's "Running" column), for
 * the kinds the app writes itself. Any other tool keeps the gateway's title,
 * unchanged.
 */
export function runningTitle(step: Step): string {
  if (step.kind === "reasoning") return "Thinking";
  const name = (step.toolName ?? "").toLowerCase();
  const args = argumentsOf(step);
  const path = firstString(args, ["path", "file_path", "file", "filename"]);
  if (name === "read" || name === "read_file")
    return path ? `Reading ${baseName(path)}` : "Reading";
  if (["write", "edit", "write_file", "edit_file", "apply_patch"].includes(name))
    return path ? `Writing ${baseName(path)}` : "Writing";
  if (name === "ls" || name === "list" || name === "list_dir")
    return path ? `Looking through ${baseName(path)}` : "Looking through a folder";
  if (["grep", "search", "find", "glob"].includes(name)) {
    const query = firstString(args, ["pattern", "query", "q"]);
    return query ? `Searching for "${query}"` : "Searching";
  }
  if (["web_fetch", "fetch", "browse", "open_url"].includes(name)) {
    const url = firstString(args, ["url", "href"]);
    const host = url && URL.canParse(url) ? new URL(url).hostname : null;
    return host ? `Opening ${host}` : "Opening a page";
  }
  if (name === "exec" || name === "bash" || name === "shell") {
    const command = firstString(args, ["command", "cmd"]);
    const program = command?.split(/\s+/)[0];
    return program ? `Running ${baseName(program)}` : "Running a command";
  }
  if (name === "sessions_send") {
    const target = firstString(args, ["agentId", "label", "sessionKey"]);
    return target ? `Messaging ${target}` : "Messaging a bot";
  }
  if (name === "memory_save" || name === "remember") return "Saving to memory";
  return step.title;
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
};

/**
 * The status line of a run that is running, waiting or stopping: one phrase
 * and the avatar's state, by the table in section 5. While the connection is
 * lost it stops and says what was last seen.
 */
export function statusLineFor(
  run: Run,
  transcript: Transcript,
  options: { connected: boolean; interactive: boolean },
): StatusLineView {
  let view: StatusLineView;
  const step = runningStep(run);
  if (run.state === "stopping") {
    view = { state: "idle", badge: null, phrase: "Stopping…", tone: "muted", startedAt: null };
  } else if (run.state === "waiting" && !options.interactive) {
    // The gateway reports the wait, but this tier is not sent the card.
    view = {
      state: "thinking",
      badge: "blocked",
      phrase: "Waiting for an answer",
      tone: "muted",
      startedAt: null,
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
    };
  } else if (step && step.kind === "tool") {
    view = {
      state: "working",
      badge: null,
      phrase: runningTitle(step),
      tone: "live",
      startedAt: null,
    };
  } else {
    view = {
      state: "thinking",
      badge: null,
      phrase: phasePhrase(run.phase) ?? "Thinking",
      tone: "live",
      startedAt: null,
    };
  }
  view.startedAt = run.startedAt;
  if (!options.connected) {
    const last = view.phrase.replace(/…$/, "");
    return {
      state: "blocked",
      badge: "blocked",
      phrase: `Reconnecting. Last seen ${last.charAt(0).toLowerCase()}${last.slice(1)}`,
      tone: "muted",
      startedAt: null,
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
  if (!run || !transcript) {
    return {
      placeholder: offline
        ? "Offline. Messages send when you reconnect."
        : `Message ${options.bot}`,
      mode: "send",
      stoppable: null,
      stopping: false,
      modeWord: null,
      menu: "idle",
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
  const held = questionPending(transcript, run);
  const waiting = run.state === "waiting" || held || run.pendingCards.length > 0;
  const mode: SendMode = held ? "hold" : options.chosen === "queue" ? "queue" : "steer";
  return {
    placeholder: offline
      ? "Offline. Messages send when you reconnect."
      : waiting
        ? `Answer above, or message ${options.bot}`
        : `Steer ${options.bot}`,
    mode,
    // Offline the composer is its offline form: Send alone.
    stoppable: isActive(run.state) && !offline ? run : null,
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
      return "Steer this turn";
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
  | { kind: "stopped"; after: string | null; elsewhere: boolean }
  | { kind: "finished-before-stop" }
  | { kind: "turn-limit"; minutes: number | null; reason: string | null }
  | { kind: "failed"; reason: string };

/**
 * How a finished run ended, when the transcript says more than its text. A
 * stop is from elsewhere only when this device neither pressed Stop nor sent
 * a stop command (`/stop`, which the gateway handles without a run) while
 * the run was going.
 */
export function endingOf(run: Run, transcript?: Transcript): RunEnding | null {
  if (run.state === "completed" && run.finishedBeforeStop) return { kind: "finished-before-stop" };
  if (run.state === "stopped") {
    if (!run.outcomeKnown) return null;
    const commanded = (transcript?.outbox ?? []).some(
      (message) =>
        message.status === "handled" &&
        (run.startedAt === null || message.createdAt >= run.startedAt) &&
        (run.endedAt === null || message.createdAt <= run.endedAt),
    );
    return {
      kind: "stopped",
      after: runDuration(run),
      elsewhere: run.stopRequestedAt === null && !commanded,
    };
  }
  if (run.state === "failed") {
    if (run.error?.kind === "turn-limit" || run.ending?.timeoutPhase) {
      const minutes = /(\d+)-minute/.exec(run.error?.message ?? "")?.[1];
      return {
        kind: "turn-limit",
        minutes: minutes ? Number(minutes) : null,
        reason: run.error?.message ?? null,
      };
    }
    return { kind: "failed", reason: run.error?.message ?? "The gateway gave no reason." };
  }
  return null;
}
