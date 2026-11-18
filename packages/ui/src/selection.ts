import type { Bot, ClawtrateState, Task } from "@clawtrate/core";
import { useCallback, useMemo, useState } from "react";
import { readIdSet, readPreference, writeIdSet, writePreference } from "./preferences.ts";
import { isUnread, markSeen, type SeenMap } from "./unread.ts";

/** Rows shown under an unfolded bot before "Show all". */
export const TASK_CAP = 6;

export type RunState =
  "waiting" | "failed" | "blocked" | "done-with-failures" | "working" | "stopped" | "queued";

export type BotSummary = {
  /** The task with the latest activity, across all of the bot's tasks. */
  latest: Task | null;
  /** Any task is unread, other than the one on screen. */
  unread: boolean;
  /**
   * The most urgent state among the tasks: waiting for you, failed or blocked,
   * done with failures (until that task is opened), working. Done and unread is
   * the unread dot; idle is nothing.
   */
  state: RunState | null;
};

/** Not opened since its latest activity. */
function unseen(task: Task, seen: SeenMap): boolean {
  const lastSeen = seen[task.key];
  return lastSeen === undefined || (task.updatedAt ?? 0) > lastSeen;
}

/** A task's own state, as its row's mark says it. Opening a task clears done with failures. */
export function taskState(task: Task, seen: SeenMap, onScreenKey: string | null): RunState | null {
  switch (task.status) {
    case "running":
      return "working";
    case "waiting":
    case "failed":
    case "blocked":
      return task.status;
    case "done-with-failures":
    case "stopped":
      // Until the next run, or until the task is opened (conversation.md, section 4).
      return task.key !== onScreenKey && unseen(task, seen) ? task.status : null;
    case "queued":
      return "queued";
    default:
      return null;
  }
}

/** The order of section 4 for the avatar: a queued task counts as idle. */
const URGENCY: RunState[] = [
  "waiting",
  "failed",
  "blocked",
  "done-with-failures",
  "working",
  "stopped",
];

/**
 * What a bot's row says about all of its tasks. The three signals are
 * independent, so a folded bot never hides work in an older task.
 */
export function summarize(
  tasks: Task[],
  seen: SeenMap,
  onScreenKey: string | null,
  /** What this viewer read, for unread: the gateway's word alone on a connection that writes. */
  unreadSeen: SeenMap = seen,
): BotSummary {
  let latest: Task | null = null;
  for (const task of tasks) {
    if (!latest || (task.updatedAt ?? 0) > (latest.updatedAt ?? 0)) latest = task;
  }
  const states = new Set(tasks.map((task) => taskState(task, seen, onScreenKey)));
  return {
    latest,
    unread: tasks.some((task) => task.key !== onScreenKey && isUnread(task, unreadSeen)),
    // Failed and blocked share a place; failed is named first.
    state: URGENCY.find((state) => states.has(state)) ?? null,
  };
}

/** How a state is spoken in a row's name. */
export const STATE_WORDS: Record<RunState, string> = {
  waiting: "waiting for you",
  failed: "a run failed",
  blocked: "blocked",
  "done-with-failures": "done with failures",
  working: "working",
  stopped: "stopped",
  queued: "queued",
};

/**
 * A bot's accessible name: its name and state first, as assistive tools read a
 * busy bot ("Otto, working"), then its tasks and what else is true: "Otto,
 * working, 14 tasks, unread".
 */
export function botLabel(
  bot: Bot,
  count: number,
  summary: BotSummary,
  extra: { primary?: boolean; label?: string | null } = {},
): string {
  return (
    bot.name +
    (summary.state ? `, ${STATE_WORDS[summary.state]}` : "") +
    `, ${count} ${count === 1 ? "task" : "tasks"}` +
    (summary.unread ? ", unread" : "") +
    (extra.label ? `, ${extra.label}` : "") +
    (extra.primary ? ", primary bot" : "")
  );
}

/** The rows under an unfolded bot: the first six, always including the current task. */
export function visibleTasks(
  tasks: Task[],
  currentKey: string | null,
  showAll: boolean,
  cap: number = TASK_CAP,
): Task[] {
  if (showAll || tasks.length <= cap) return tasks;
  const top = tasks.slice(0, cap);
  const current = tasks.find((task) => task.key === currentKey);
  if (current && !top.includes(current)) top[cap - 1] = current;
  return top;
}

/** Rows shown under an unfolded bot in one pane, so the rest of the list stays in view. */
export const TASK_CAP_ONE_PANE = 3;

function readJson<T extends object>(key: string): T {
  try {
    const parsed: unknown = JSON.parse(readPreference(key) ?? "{}");
    return (parsed && typeof parsed === "object" ? parsed : {}) as T;
  } catch {
    return {} as T;
  }
}

const SEEN_KEY = "seen";

/**
 * Three things are tracked separately: the selected bot, the selected task (the
 * last one opened for each bot, which wins over the most recent), and which bots
 * are unfolded. A bot with several tasks unfolds while it is open, unless it was
 * folded by hand; a bot unfolded by hand stays unfolded until it is folded.
 */
/** No local reads: unread is the gateway's alone. */
const NOTHING_SEEN: SeenMap = Object.freeze({}) as SeenMap;

/**
 * `gatewayOwnsUnread`: the connection writes, so reading a task is a change the
 * gateway accepts or refuses. Then the dot and the badge are what the gateway
 * reports (`unreadSeen` is empty) and nothing this viewer does locally clears
 * them; a read-only connection, whose reads the gateway never hears, keeps its
 * own memory of what it read.
 */
export function useSelection(state: ClawtrateState, gatewayOwnsUnread = false) {
  const [botId, setBotId] = useState<string | null>(() => readPreference("bot"));
  const [taskByBot, setTaskByBot] = useState<Record<string, string>>(() => readJson("tasks"));
  const [seen, setSeen] = useState<SeenMap>(() => readJson(SEEN_KEY));
  const [held, setHeld] = useState<Set<string>>(() => readIdSet("unfolded"));
  const [openFolded, setOpenFolded] = useState(() => readPreference("folded") === "true");
  const [showAll, setShowAll] = useState<Set<string>>(() => new Set());
  /** Tasks marked unread while open: leaving them does not mark them read again. */
  const [keptUnread, setKeptUnread] = useState<Set<string>>(() => new Set());

  const bot = state.bots.find((b) => b.id === botId) ?? state.bots[0];
  const tasks = useMemo(
    () => (bot ? (state.tasksByBot[bot.id] ?? []) : []),
    [bot, state.tasksByBot],
  );
  const remembered = bot ? taskByBot[bot.id] : undefined;
  const task = tasks.find((t) => t.key === remembered) ?? tasks[0] ?? null;

  // Leaving a task marks it read as of its latest activity, so its dot only
  // returns for activity that happens after this viewer saw it.
  const markRead = useCallback(() => {
    if (!task || keptUnread.has(task.key)) return;
    setSeen((current) => {
      const next = markSeen(current, task);
      if (next !== current) writePreference(SEEN_KEY, JSON.stringify(next));
      return next;
    });
  }, [task, keptUnread]);

  /**
   * A read the gateway refused or that failed: this viewer forgets having read
   * the task, so the rail and the badge show what the gateway reports.
   */
  const forgetReadHere = useCallback((key: string) => {
    setSeen((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      writePreference(SEEN_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  /**
   * "Mark as unread": this viewer forgets having read the task, so the
   * gateway's unread decides, and leaving it open does not read it again.
   */
  const markUnreadHere = useCallback(
    (key: string) => {
      forgetReadHere(key);
      setKeptUnread((current) => new Set(current).add(key));
    },
    [forgetReadHere],
  );

  /** "Mark as read": as if this viewer had just read it. */
  const markReadHere = useCallback((target: Task) => {
    setKeptUnread((current) => {
      if (!current.has(target.key)) return current;
      const next = new Set(current);
      next.delete(target.key);
      return next;
    });
    setSeen((current) => {
      const next = markSeen(current, target);
      if (next !== current) writePreference(SEEN_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const setFolded = useCallback((folded: boolean) => {
    setOpenFolded(folded);
    writePreference("folded", folded ? "true" : null);
  }, []);

  const updateHeld = useCallback((change: (ids: Set<string>) => void) => {
    setHeld((current) => {
      const next = new Set(current);
      change(next);
      writeIdSet("unfolded", next);
      return next;
    });
  }, []);

  /** Open a bot: its remembered task, or else its most recent. */
  const selectBot = useCallback(
    (id: string) => {
      if (id === bot?.id) return;
      markRead();
      setBotId(id);
      writePreference("bot", id);
      setFolded(false);
    },
    [bot, markRead, setFolded],
  );

  /** Open a task under any bot: one operation for the bot, the task and what is read. */
  const selectTask = useCallback(
    (id: string, key: string) => {
      if (id === bot?.id && key === task?.key) return;
      markRead();
      // Opening a task kept unread reads it again from now on.
      setKeptUnread((current) => {
        if (!current.has(key)) return current;
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      if (id !== bot?.id) {
        setBotId(id);
        writePreference("bot", id);
        setFolded(false);
      }
      setTaskByBot((current) => {
        const next = { ...current, [id]: key };
        writePreference("tasks", JSON.stringify(next));
        return next;
      });
    },
    [bot, task, markRead, setFolded],
  );

  const isOpen = useCallback(
    (id: string) =>
      (state.tasksByBot[id]?.length ?? 0) > 1 && (held.has(id) || (id === bot?.id && !openFolded)),
    [state.tasksByBot, held, bot, openFolded],
  );

  /** Fold or unfold by hand, without changing the selection. */
  const toggleFold = useCallback(
    (id: string) => {
      if ((state.tasksByBot[id]?.length ?? 0) < 2) return;
      if (isOpen(id)) {
        updateHeld((ids) => ids.delete(id));
        if (id === bot?.id) setFolded(true);
      } else {
        updateHeld((ids) => ids.add(id));
        if (id === bot?.id) setFolded(false);
      }
    },
    [state.tasksByBot, isOpen, updateHeld, bot, setFolded],
  );

  /** Make one bot the only one unfolded among `group` (the pinned bots: their block has one owner). */
  const unfoldOnly = useCallback(
    (id: string, group: string[]) => {
      updateHeld((ids) => {
        for (const other of group) if (other !== id) ids.delete(other);
        if ((state.tasksByBot[id]?.length ?? 0) > 1) ids.add(id);
      });
      if (bot && bot.id !== id && group.includes(bot.id)) setFolded(true);
      if (bot?.id === id) setFolded(false);
    },
    [updateHeld, state.tasksByBot, bot, setFolded],
  );

  /** Unfold a bot by hand, as Right does: a bot whose new second task was just created. */
  const unfold = useCallback(
    (id: string) => {
      updateHeld((ids) => ids.add(id));
      if (id === bot?.id) setFolded(false);
    },
    [updateHeld, bot, setFolded],
  );

  /** Forget that these bots were unfolded by hand. */
  const release = useCallback(
    (ids: string[]) => updateHeld((held) => ids.forEach((id) => held.delete(id))),
    [updateHeld],
  );

  /** The task a bot opens to: its remembered task, or else its most recent. */
  const taskFor = useCallback(
    (id: string): Task | null => {
      const list = state.tasksByBot[id] ?? [];
      return list.find((t) => t.key === taskByBot[id]) ?? list[0] ?? null;
    },
    [state.tasksByBot, taskByBot],
  );

  const toggleShowAll = useCallback((id: string) => {
    setShowAll((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  return {
    bot,
    tasks,
    task,
    seen,
    unreadSeen: gatewayOwnsUnread ? NOTHING_SEEN : seen,
    showAll,
    isOpen,
    selectBot,
    selectTask,
    toggleFold,
    toggleShowAll,
    unfoldOnly,
    release,
    taskFor,
    unfold,
    keptUnread,
    markUnreadHere,
    markReadHere,
    forgetReadHere,
  };
}

export type SelectionModel = ReturnType<typeof useSelection>;
