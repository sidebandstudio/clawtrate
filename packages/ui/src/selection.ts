import type { Bot, ClawtrateState, Task } from "@clawtrate/core";
import { useCallback, useMemo, useState } from "react";
import { readIdSet, readPreference, writeIdSet, writePreference } from "./preferences.ts";
import { isUnread, markSeen, type SeenMap } from "./unread.ts";

/** Rows shown under an unfolded bot before "Show all". */
export const TASK_CAP = 6;

export type RunState = "waiting" | "failed" | "blocked" | "done-with-failures" | "working";

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
      return task.key !== onScreenKey && unseen(task, seen) ? "done-with-failures" : null;
    default:
      return null;
  }
}

const URGENCY: RunState[] = ["waiting", "failed", "blocked", "done-with-failures", "working"];

/**
 * What a bot's row says about all of its tasks. The three signals are
 * independent, so a folded bot never hides work in an older task.
 */
export function summarize(tasks: Task[], seen: SeenMap, onScreenKey: string | null): BotSummary {
  let latest: Task | null = null;
  for (const task of tasks) {
    if (!latest || (task.updatedAt ?? 0) > (latest.updatedAt ?? 0)) latest = task;
  }
  const states = new Set(tasks.map((task) => taskState(task, seen, onScreenKey)));
  return {
    latest,
    unread: tasks.some((task) => task.key !== onScreenKey && isUnread(task, seen)),
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
export function visibleTasks(tasks: Task[], currentKey: string | null, showAll: boolean): Task[] {
  if (showAll || tasks.length <= TASK_CAP) return tasks;
  const top = tasks.slice(0, TASK_CAP);
  const current = tasks.find((task) => task.key === currentKey);
  if (current && !top.includes(current)) top[TASK_CAP - 1] = current;
  return top;
}

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
export function useSelection(state: ClawtrateState) {
  const [botId, setBotId] = useState<string | null>(() => readPreference("bot"));
  const [taskByBot, setTaskByBot] = useState<Record<string, string>>(() => readJson("tasks"));
  const [seen, setSeen] = useState<SeenMap>(() => readJson(SEEN_KEY));
  const [held, setHeld] = useState<Set<string>>(() => readIdSet("unfolded"));
  const [openFolded, setOpenFolded] = useState(() => readPreference("folded") === "true");
  const [showAll, setShowAll] = useState<Set<string>>(() => new Set());

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
    if (!task) return;
    setSeen((current) => {
      const next = markSeen(current, task);
      if (next !== current) writePreference(SEEN_KEY, JSON.stringify(next));
      return next;
    });
  }, [task]);

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
      // The task shown may be only the bot's newest, nothing chosen: choosing it remembers it,
      // so a newer task of the bot does not take its place.
      if (id === bot?.id && key === remembered) return;
      if (id !== bot?.id || key !== task?.key) markRead();
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
    [bot, task, remembered, markRead, setFolded],
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
    showAll,
    isOpen,
    selectBot,
    selectTask,
    toggleFold,
    toggleShowAll,
    unfoldOnly,
    release,
    taskFor,
  };
}

export type SelectionModel = ReturnType<typeof useSelection>;
