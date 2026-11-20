import type { ClawtrateState, Task } from "@clawtrate/core";
import { useCallback, useMemo, useState } from "react";
import { readIdSet, readPreference, writeIdSet, writePreference } from "./preferences.ts";
import { markSeen, type SeenMap } from "./unread.ts";

export {
  botLabel,
  STATE_WORDS,
  summarize,
  TASK_CAP,
  TASK_CAP_ONE_PANE,
  taskState,
  visibleTasks,
  type BotSummary,
  type RunState,
} from "./summary.ts";

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
      // The task shown may be only the bot's newest, nothing chosen: choosing it remembers it,
      // so a newer task of the bot does not take its place.
      if (id === bot?.id && key === remembered) return;
      if (id !== bot?.id || key !== task?.key) {
        markRead();
        // Opening a task kept unread reads it again from now on.
        setKeptUnread((current) => {
          if (!current.has(key)) return current;
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
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
