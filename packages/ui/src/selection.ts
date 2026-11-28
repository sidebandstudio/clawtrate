import {
  gatewayBotHidden,
  listedBots,
  mapSessionRow,
  seenThroughSkillNote,
  seenThroughUpdateNotice,
  updateNoticeScope,
  type Bot,
  type ClawtrateState,
  type Task,
} from "@clawtrate/core";
import { useCallback, useMemo, useState } from "react";
import { readIdSet, readPreference, writeIdSet, writePreference } from "./preferences.ts";
import { isUnread, markSeen, type SeenMap } from "./unread.ts";

/**
 * The task a link opens beside the bot's list: the one given, or, for a key the list doesn't
 * hold (a session a switch hides, F-519, F-563), one made from the key, so the link opens it
 * rather than the bot's newest task. Null when the list holds it.
 */
export function linkTarget(
  listed: Task[] | undefined,
  botId: string,
  key: string,
  given: Task | null,
): Task | null {
  if (given) return given;
  return listed?.some((task) => task.key === key) ? null : mapSessionRow({ key, agentId: botId });
}

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
 * working, 14 tasks, unread". While its tasks are still being read, "loading
 * tasks" in place of the count (the row has no words of its own for it, #790).
 */
export function botLabel(
  bot: Bot,
  count: number,
  summary: BotSummary,
  extra: { primary?: boolean; label?: string | null; loading?: boolean } = {},
): string {
  return (
    bot.name +
    (summary.state ? `, ${STATE_WORDS[summary.state]}` : "") +
    (extra.loading && count === 0
      ? ", loading tasks"
      : `, ${count} ${count === 1 ? "task" : "tasks"}`) +
    (summary.unread ? ", unread" : "") +
    (extra.label ? `, ${extra.label}` : "") +
    (extra.primary ? ", primary bot" : "")
  );
}

/** The rows under an unfolded bot: the first six, always including the current task. */
export function visibleTasks<T extends { key: string }>(
  tasks: T[],
  currentKey: string | null,
  showAll: boolean,
  cap: number = TASK_CAP,
): T[] {
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
 * A bot of one gateway: its id, and the host's target and the gateway it was seen on. The target
 * holds across reconnects to one gateway, while its name is still unknown; it rises only when the
 * host is pointed somewhere else.
 */
type OnGateway = { id: string; gatewayId: string | null; target: number };

/**
 * What this viewer read, for unread. On a connection that writes, nothing: the gateway's word
 * alone. On a read-only one, its own memory, past the gateway's update line where that is all that
 * came since (F-590): the notice alone doesn't make a task unread.
 */
export function unreadSeenOf(
  seen: SeenMap,
  gatewayOwnsUnread: boolean,
  state: Pick<
    ClawtrateState,
    "bots" | "tasksByBot" | "transcripts" | "connection" | "openclawUpdating"
  >,
): SeenMap {
  if (gatewayOwnsUnread) return NOTHING_SEEN;
  const scope = updateNoticeScope(state);
  const updates = Boolean(scope.updated?.length) && scope.mainKey !== null;
  let next: SeenMap | null = null;
  for (const each of Object.values(state.tasksByBot).flat()) {
    // A skill note by itself doesn't mark a task unread (F-560), nor does an update line (F-590).
    const transcript = state.transcripts[each.key];
    const pastNotes = seenThroughSkillNote(each, seen[each.key], transcript, scope);
    const through = updates
      ? seenThroughUpdateNotice(each, pastNotes, transcript, scope)
      : pastNotes;
    if (through !== undefined && through !== seen[each.key])
      (next ??= { ...seen })[each.key] = through;
  }
  return next ?? seen;
}

/**
 * `gatewayOwnsUnread`: the connection writes, so reading a task is a change the
 * gateway accepts or refuses. Then the dot and the badge are what the gateway
 * reports (`unreadSeen` is empty) and nothing this viewer does locally clears
 * them; a read-only connection, whose reads the gateway never hears, keeps its
 * own memory of what it read.
 */
export function useSelection(
  state: ClawtrateState,
  gatewayOwnsUnread = false,
  conversationVisible = true,
) {
  const [botId, setBotId] = useState<string | null>(() => readPreference("bot"));
  const [taskByBot, setTaskByBot] = useState<Record<string, string>>(() => readJson("tasks"));
  const [seen, setSeen] = useState<SeenMap>(() => readJson(SEEN_KEY));
  const [held, setHeld] = useState<Set<string>>(() => readIdSet("unfolded"));
  const [openFolded, setOpenFolded] = useState(() => readPreference("folded") === "true");
  const [showAll, setShowAll] = useState<Set<string>>(() => new Set());
  /** Tasks marked unread while open: leaving them does not mark them read again. */
  const [keptUnread, setKeptUnread] = useState<Set<string>>(() => new Set());

  const showGatewayBot = state.showGatewayBot === true;
  /** The bots the rule lists: the gateway's own bot only when shown or waiting (F-562). */
  const byRule = useMemo(
    () => listedBots({ bots: state.bots, tasksByBot: state.tasksByBot, showGatewayBot }),
    [state.bots, state.tasksByBot, showGatewayBot],
  );
  // The gateway's own bot, while out of view by the rule, is open only when the person opened it:
  // from a link or a search result, or from the rail while it waited. A bot starting to wait never
  // takes the selection. One the person opened stays open, and in the rail, until they open
  // another bot: after its wait ends, and when the switch is turned off while it waits.
  // Both are a gateway's: a bot of another gateway with the same id (its own is often `main`) was
  // never opened there, so it is neither kept nor on screen.
  const gatewayId = state.connection.gatewayId;
  const target = state.connection.target;
  const [keptOpen, setKeptOpen] = useState<OnGateway | null>(null);
  /** The bot on screen in the last render. */
  const [onScreen, setOnScreen] = useState<OnGateway | null>(null);
  /** The id, when it was seen here: on this target, and on no other gateway known by name. */
  const here = useCallback(
    (each: OnGateway | null) =>
      each !== null &&
      each.target === target &&
      (each.gatewayId === null || gatewayId === null || each.gatewayId === gatewayId)
        ? each.id
        : null,
    [target, gatewayId],
  );
  const keptHere = here(keptOpen);
  const onScreenHere = here(onScreen);
  const shownByRule = (each: Bot) => !gatewayBotHidden(each, state.bots, showGatewayBot);
  const chosen = state.bots.find((b) => b.id === botId);
  // On screen and still listed because it waits, though the rule now leaves it out (the switch
  // was turned off): the person's choice, kept.
  const stays =
    chosen !== undefined &&
    onScreenHere === chosen.id &&
    !shownByRule(chosen) &&
    byRule.includes(chosen);
  const kept = stays ? chosen.id : keptHere;
  if (kept !== keptHere) setKeptOpen(kept === null ? null : { id: kept, gatewayId, target });
  /** The bots the rail lists, with the one the person keeps open. */
  const listed =
    kept === null
      ? byRule
      : listedBots({ bots: state.bots, tasksByBot: state.tasksByBot, showGatewayBot }, kept);
  const bot =
    chosen && (kept === chosen.id || (shownByRule(chosen) && listed.includes(chosen)))
      ? chosen
      : (listed.find(shownByRule) ?? listed[0]);
  // A saved bot out of view gives way, and the bot opened in its place becomes the saved one.
  if (chosen && bot && bot !== chosen) {
    setBotId(bot.id);
    writePreference("bot", bot.id);
  }
  if ((bot?.id ?? null) !== onScreenHere)
    setOnScreen(bot ? { id: bot.id, gatewayId, target } : null);
  const keepIfLeftOut = useCallback(
    (id: string) => {
      const opened = state.bots.find((each) => each.id === id);
      // Another task of the bot kept open keeps it, whatever the switch says now; only opening
      // another bot lets it go.
      setKeptOpen((kept) =>
        here(kept) === id || (opened && gatewayBotHidden(opened, state.bots, showGatewayBot))
          ? { id, gatewayId, target }
          : null,
      );
    },
    [state.bots, showGatewayBot, gatewayId, target, here],
  );
  const { openclawUpdating, tasksByBot, transcripts, bots, connection } = state;
  const unreadSeen = useMemo(
    () =>
      unreadSeenOf(seen, gatewayOwnsUnread, {
        ...(openclawUpdating ? { openclawUpdating } : {}),
        tasksByBot,
        transcripts,
        bots,
        connection,
      }),
    [seen, gatewayOwnsUnread, openclawUpdating, tasksByBot, transcripts, bots, connection],
  );
  const tasks = useMemo(
    () => (bot ? (state.tasksByBot[bot.id] ?? []) : []),
    [bot, state.tasksByBot],
  );
  const [linked, setLinked] = useState<{ task: Task; gatewayId: string | null } | null>(null);
  const remembered = bot ? taskByBot[bot.id] : undefined;
  if (
    linked?.gatewayId === gatewayId &&
    state.tasksByBot[linked.task.botId]?.some((t) => t.key === linked.task.key)
  )
    setLinked(null);
  const task =
    tasks.find((t) => t.key === remembered) ??
    (linked?.gatewayId === gatewayId &&
    linked.task.key === remembered &&
    linked.task.botId === bot?.id
      ? linked.task
      : null) ??
    tasks[0] ??
    null;

  // Leaving a task marks it read as of its latest activity, so its dot only
  // returns for activity that happens after this viewer saw it.
  const markRead = useCallback(() => {
    if (!conversationVisible || !task || keptUnread.has(task.key)) return;
    setSeen((current) => {
      const next = markSeen(current, task);
      if (next !== current) writePreference(SEEN_KEY, JSON.stringify(next));
      return next;
    });
  }, [task, keptUnread, conversationVisible]);

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
      keepIfLeftOut(id);
      setBotId(id);
      writePreference("bot", id);
      setFolded(false);
    },
    [bot, markRead, setFolded, keepIfLeftOut],
  );

  /** Open a task under any bot: one operation for the bot, the task and what is read. */
  const selectTask = useCallback(
    (id: string, key: string, linkedTask: Task | null = null) => {
      const linkedTo = linkTarget(state.tasksByBot[id], id, key, linkedTask);
      setLinked(linkedTo && { task: linkedTo, gatewayId });
      keepIfLeftOut(id);
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
    [bot, task, remembered, gatewayId, markRead, setFolded, state.tasksByBot, keepIfLeftOut],
  );

  const isOpen = useCallback(
    (id: string, hasRoutineRows = false) =>
      (hasRoutineRows || (state.tasksByBot[id]?.length ?? 0) > 1) &&
      (held.has(id) || (id === bot?.id && !openFolded)),
    [state.tasksByBot, held, bot, openFolded],
  );

  /** Fold or unfold by hand, without changing the selection. */
  const toggleFold = useCallback(
    (id: string, hasRoutineRows = false) => {
      if (!hasRoutineRows && (state.tasksByBot[id]?.length ?? 0) < 2) return;
      if (isOpen(id, hasRoutineRows)) {
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
    (id: string, group: string[], hasRoutineRows = false) => {
      updateHeld((ids) => {
        for (const other of group) if (other !== id) ids.delete(other);
        if (hasRoutineRows || (state.tasksByBot[id]?.length ?? 0) > 1) ids.add(id);
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
    listed,
    /** The gateway's own bot the person keeps open, listed until they open another (F-562). */
    kept,
    tasks,
    task,
    seen,
    unreadSeen,
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
