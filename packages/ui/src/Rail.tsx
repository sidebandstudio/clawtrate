import type { Bot, ConnectionState, DiscoveryState, Task } from "@clawtrate/core";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { Avatar } from "./Avatar.tsx";
import { useCommand } from "./bridge.tsx";
import { copyText } from "./clipboard.ts";
import { gatewayLabel, rowTime } from "./format.ts";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronIcon,
  CloseIcon,
  CopyIcon,
  EyeIcon,
  HideIcon,
  PinIcon,
  SearchIcon,
  SettingsIcon,
  SortIcon,
  StarIcon,
} from "./icons.tsx";
import { Menu, type MenuEntry } from "./Menu.tsx";
import type { BubbleChoice, ThemeChoice } from "./preferences.ts";
import { arrange, moveInOrder, rosterScope, SORT_ORDERS, useRoster } from "./roster.ts";
import {
  botLabel,
  summarize,
  taskState,
  TASK_CAP,
  visibleTasks,
  type BotSummary,
  type RunState,
  type SelectionModel,
} from "./selection.ts";
import { isUnread } from "./unread.ts";

/** The gateway's state in words, for the footer, its menu and its accessible name. */
export function presenceWords(connection: ConnectionState, catchingUp: boolean): string {
  switch (connection.status) {
    case "connected":
      return catchingUp ? "Catching up" : "Connected";
    case "reconnecting":
    case "connecting":
      return "Reconnecting…";
    case "pairing":
      return "Awaiting approval";
    case "error":
      return "Can't reach the gateway";
    case "idle":
      return "Not connected";
    case "disconnected":
      return "Disconnected";
  }
}

/** The footer dot: the gateway's presence, never a single task's trouble. */
function presenceDot(connection: ConnectionState, catchingUp: boolean): string {
  return connection.status === "connected" && catchingUp ? "connecting" : connection.status;
}

/** Re-render once a minute, so relative times stay true. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The 12 px mark for a state. Done with failures shows the failed mark. */
function StateMark({ state }: { state: RunState | null }) {
  if (!state) return null;
  const shape = state === "done-with-failures" ? "failed" : state;
  return <span className="glyph" data-state={shape} aria-hidden="true" />;
}

/**
 * A bot's avatar with its state: the ring while it works, a badge at the top
 * right when it needs you or something failed, and the primary bot's star at
 * the lower right.
 */
function Presence({ bot, state, primary }: { bot: Bot; state: RunState | null; primary: boolean }) {
  return (
    <span
      className="presence"
      data-state={state ?? "idle"}
      data-kind={bot.avatarUrl ? "image" : "character"}
      aria-hidden="true"
    >
      <Avatar bot={bot} />
      {state && state !== "working" && <StateMark state={state} />}
      {primary && (
        <span className="primary-star" data-testid="primary-star">
          <StarIcon />
        </span>
      )}
    </span>
  );
}

type Tip = { text: string; top: number; left: number };

function TaskRows({
  bot,
  tasks,
  selection,
  onOpenTask,
  onTip,
  now,
}: {
  bot: Bot;
  tasks: Task[];
  selection: SelectionModel;
  onOpenTask: (botId: string, key: string) => void;
  onTip: (tip: Tip | null) => void;
  now: number;
}) {
  const currentKey = selection.bot?.id === bot.id ? (selection.task?.key ?? null) : null;
  const all = selection.showAll.has(bot.id);
  const showTip = (element: HTMLElement, text: string) => {
    const title = element.querySelector(".task-title");
    if (!title || title.scrollWidth <= title.clientWidth) return onTip(null);
    const rect = element.getBoundingClientRect();
    const fits = rect.right + 12 + 280 < window.innerWidth;
    onTip({
      text,
      top: fits ? rect.top + rect.height / 2 : rect.bottom + 18,
      left: fits ? rect.right + 8 : Math.max(8, rect.left),
    });
  };
  return (
    <ul className="task-list" aria-label={`${bot.name}'s tasks`} data-testid="task-list">
      {visibleTasks(tasks, currentKey, all).map((task) => {
        const current = task.key === currentKey;
        const unread = !current && isUnread(task, selection.seen);
        const state = taskState(task, selection.seen, selection.task?.key ?? null);
        const spoken =
          task.title +
          (state === "working"
            ? ", working"
            : state === "waiting"
              ? ", needs you"
              : state === "blocked"
                ? ", blocked"
                : state === "failed"
                  ? ", last run failed"
                  : state === "done-with-failures"
                    ? ", done with failures"
                    : unread
                      ? ", unread"
                      : "");
        return (
          <li key={task.key}>
            <button
              type="button"
              className="task"
              data-testid="task"
              data-status={task.status}
              data-state={state ?? undefined}
              data-unread={unread}
              aria-current={current ? "true" : undefined}
              aria-label={spoken}
              aria-description={
                task.updatedAt === null
                  ? undefined
                  : `Last activity ${task.status === "running" ? "now" : rowTime(task.updatedAt, now)}`
              }
              onClick={() => onOpenTask(bot.id, task.key)}
              onMouseEnter={(event) => showTip(event.currentTarget, task.title)}
              onMouseLeave={() => onTip(null)}
              onFocus={(event) => showTip(event.currentTarget, task.title)}
              onBlur={() => onTip(null)}
            >
              <span className="task-title">{task.title}</span>
              {task.updatedAt !== null && (
                <time className="task-time" aria-hidden="true">
                  {task.status === "running" ? "now" : rowTime(task.updatedAt, now)}
                </time>
              )}
              {/* One slot for at most one mark, kept even when empty so times line up. */}
              <span className="task-mark" aria-hidden="true">
                {state ? (
                  <StateMark state={state} />
                ) : unread ? (
                  <span className="unread-dot" />
                ) : null}
              </span>
            </button>
          </li>
        );
      })}
      {tasks.length > TASK_CAP && (
        <li>
          <button
            type="button"
            className="task task-more"
            onClick={() => selection.toggleShowAll(bot.id)}
          >
            <span className="task-title">{all ? "Show fewer" : `Show all ${tasks.length}`}</span>
          </button>
        </li>
      )}
    </ul>
  );
}

type MenuState =
  | { kind: "gateway"; trigger: HTMLElement }
  | { kind: "sort"; trigger: HTMLElement }
  | { kind: "bot"; botId: string; trigger: HTMLElement; x: number; y: number };

/** Drop the separators a menu would start or end with, or show twice in a row. */
function tidy(entries: MenuEntry[]): MenuEntry[] {
  return entries.filter(
    (entry, index) =>
      entry.kind !== "rule" ||
      (index > 0 && index < entries.length - 1 && entries[index + 1]?.kind !== "rule"),
  );
}

export function Rail({
  bots,
  tasksByBot,
  discovery,
  connection,
  catchingUp,
  selection,
  onePane,
  onOpen,
  onShowList,
  theme,
  onTheme,
  bubbles,
  onBubbles,
  onOpenSettings,
  inert,
}: {
  bots: Bot[];
  tasksByBot: Record<string, Task[]>;
  discovery: DiscoveryState;
  connection: ConnectionState;
  /** True while the gateway is back but its bots and tasks are still reloading after a drop. */
  catchingUp: boolean;
  selection: SelectionModel;
  /** One pane at a time: a bot with several tasks unfolds in place instead of opening. */
  onePane: boolean;
  /** A task, or a bot with one task or none, was opened. */
  onOpen: () => void;
  /** One pane: show the list, for a search started from a conversation. */
  onShowList: () => void;
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
  bubbles: BubbleChoice;
  onBubbles: (choice: BubbleChoice) => void;
  onOpenSettings: () => void;
  inert: boolean;
}) {
  const send = useCommand();
  const now = useMinuteClock();
  // The arrangement belongs to the gateway. Its identity arrives with its bots,
  // so the scope is settled only once there are bots.
  const roster = useRoster(
    bots.length > 0 ? rosterScope(connection) : null,
    connection.gatewayUrl
      ? rosterScope({ gatewayId: null, gatewayUrl: connection.gatewayUrl })
      : null,
  );
  const [tip, setTip] = useState<Tip | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [drag, setDrag] = useState<{ id: string; over: string | null; before: boolean } | null>(
    null,
  );
  const listRef = useRef<HTMLUListElement>(null);
  const gateway = gatewayLabel(connection.gatewayUrl);
  const words = presenceWords(connection, catchingUp);
  const dot = presenceDot(connection, catchingUp);
  const onScreenKey = selection.task?.key ?? null;
  const manual = roster.prefs.sort === "manual";
  const sortLabel = SORT_ORDERS.find((order) => order.id === roster.prefs.sort)!.label;

  // Bot search: null while closed, the query while open.
  const [query, setQuery] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  /** Where focus goes once the rail has rendered: a field or the open bot. */
  const focusAfter = useRef<"search" | "search-button" | "selected" | null>(null);
  /** A bot whose row gets focus once the rail has rendered, after a menu action moved it. */
  const [refocus, setRefocus] = useState<{ bot: string } | null>(null);
  const needle = query?.trim().toLowerCase() ?? "";

  const arranged = useMemo(
    () => arrange(bots, tasksByBot, roster.prefs),
    [bots, tasksByBot, roster.prefs],
  );
  const pinnedIds = arranged.pinned.map((bot) => bot.id);
  const matches = useMemo(
    () =>
      needle
        ? [...arranged.pinned, ...arranged.list, ...arranged.hidden].filter((bot) =>
            bot.name.toLowerCase().includes(needle),
          )
        : null,
    [arranged, needle],
  );
  /** The bots in the order the rail shows them, for the shortcuts. Hidden bots are not in it. */
  const ordered = useMemo(
    () => matches ?? [...arranged.pinned, ...arranged.list],
    [matches, arranged],
  );
  const owner = matches
    ? undefined
    : arranged.pinned.find(
        (bot) => selection.isOpen(bot.id) && (tasksByBot[bot.id]?.length ?? 0) > 1,
      );

  useEffect(() => {
    if (!announcement) return;
    const timer = setTimeout(() => setAnnouncement(""), 2000);
    return () => clearTimeout(timer);
  }, [announcement]);

  const closeMenu = useCallback(
    (refocus: boolean) => {
      if (refocus && menu?.trigger.isConnected) menu.trigger.focus();
      setMenu(null);
    },
    [menu],
  );

  const openTask = (botId: string, key: string) => {
    selection.selectTask(botId, key);
    onOpen();
  };

  const clickBot = (bot: Bot, count: number) => {
    if (count < 2) {
      selection.selectBot(bot.id);
      onOpen();
    } else if (onePane || bot.id === selection.bot?.id) {
      // One pane: a bot with several tasks unfolds in place. Two panes: the
      // open bot's row folds and unfolds it.
      selection.toggleFold(bot.id);
    } else {
      selection.selectBot(bot.id);
    }
  };

  // A pinned tile. The grid has one task block, with one owner at a time.
  const clickPin = (bot: Bot, count: number) => {
    if (count < 2) {
      selection.selectBot(bot.id);
      onOpen();
    } else if (bot.id === owner?.id) {
      selection.toggleFold(bot.id);
    } else if (onePane || bot.id === selection.bot?.id) {
      selection.unfoldOnly(bot.id, pinnedIds);
    } else {
      selection.selectBot(bot.id);
      selection.release(pinnedIds.filter((id) => id !== bot.id));
    }
  };

  const openSearch = useCallback(() => {
    focusAfter.current = "search";
    setQuery((current) => current ?? "");
    onShowList();
  }, [onShowList]);

  const closeSearch = (refocus: boolean) => {
    if (refocus) focusAfter.current = "search-button";
    setQuery(null);
  };

  /**
   * Focus a bot's row or tile where it is now. A bot that is not shown, such as
   * a hidden one in the folded section, leaves focus on that section's toggle,
   * then on the first row, then on the search button.
   */
  const focusBot = (id: string) => {
    const list = listRef.current;
    const row =
      list?.querySelector<HTMLElement>(`:is(.bot, .pin)[data-bot="${CSS.escape(id)}"]`) ??
      list?.querySelector<HTMLElement>(".hidden-toggle") ??
      list?.querySelector<HTMLElement>(".pin, .bot") ??
      searchButtonRef.current;
    row?.focus();
  };

  // Focus moves only after the element it goes to has rendered.
  useEffect(() => {
    const target = focusAfter.current;
    if (!target) return;
    focusAfter.current = null;
    if (target === "search") searchRef.current?.focus();
    else if (target === "search-button") searchButtonRef.current?.focus();
    else focusBot(selection.bot?.id ?? "");
  });
  useEffect(() => {
    if (refocus) focusBot(refocus.bot);
  }, [refocus]);

  // Shortcuts that work anywhere in the shell: ⌘⇧F searches bots, ⌘1 to ⌘9
  // open a bot, Alt+Up and Alt+Down or Control+Tab and Control+Shift+Tab
  // move to the previous or next bot. The drawer, while open, keeps them out.
  useEffect(() => {
    const open = (bot: Bot) => {
      if (bot.id === selection.bot?.id) return;
      const inList = listRef.current?.contains(document.activeElement) ?? false;
      selection.selectBot(bot.id);
      onOpen();
      if (inList) focusAfter.current = "selected";
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (inert) return;
      const command = event.metaKey || event.ctrlKey;
      const typing = (event.target as HTMLElement | null)?.closest?.("input, textarea") != null;
      if (command && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        openSearch();
        return;
      }
      let target: Bot | undefined;
      if (command && !event.shiftKey && !event.altKey && /^[1-9]$/.test(event.key)) {
        target = ordered[Number(event.key) - 1];
      } else {
        const arrow = event.altKey && !event.shiftKey && !command && !typing;
        const step =
          arrow && event.key === "ArrowDown"
            ? 1
            : arrow && event.key === "ArrowUp"
              ? -1
              : event.ctrlKey && event.key === "Tab"
                ? event.shiftKey
                  ? -1
                  : 1
                : 0;
        if (step === 0) return;
        const index = ordered.findIndex((bot) => bot.id === selection.bot?.id);
        target = ordered[Math.max(0, Math.min(ordered.length - 1, index + step))];
      }
      if (!target) return;
      event.preventDefault();
      open(target);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inert, openSearch, onOpen, selection, ordered]);

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeSearch(true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      listRef.current?.querySelector<HTMLElement>(".bot")?.focus();
    } else if (event.key === "Enter") {
      const first = matches?.[0];
      if (!first) return;
      event.preventDefault();
      closeSearch(false);
      selection.selectBot(first.id);
      onOpen();
      focusAfter.current = "selected";
    }
  };

  /** Move a bot within the manual order of the list. */
  const moveBot = (id: string, toIndex: number) => {
    const shown = arranged.list.map((bot) => bot.id);
    const next = moveInOrder(shown, id, toIndex);
    roster.setManual([...next, ...roster.prefs.manual.filter((other) => !next.includes(other))]);
  };

  const openBotMenu = (botId: string, trigger: HTMLElement, x: number, y: number) => {
    setTip(null);
    setMenu({ kind: "bot", botId, trigger, x, y });
  };

  const openGatewayMenu = (trigger: HTMLElement) => {
    setTip(null);
    setMenu((current) => (current?.kind === "gateway" ? null : { kind: "gateway", trigger }));
  };

  const onGatewayKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && menu?.kind !== "gateway") {
      event.preventDefault();
      setMenu({ kind: "gateway", trigger: event.currentTarget });
    }
  };

  // The rail's arrow keys: Up and Down move between rows, Home and End go to
  // the ends, Right unfolds a bot, Left folds it or goes from a task to its bot.
  // In the manual order, Alt+Shift+Up and Down move the focused bot.
  const onListKey = (event: KeyboardEvent<HTMLUListElement>) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>(
      ".pin, .bot, .task, .hidden-toggle",
    );
    if (!row || !listRef.current) return;
    const rows = [
      ...listRef.current.querySelectorAll<HTMLElement>(".pin, .bot, .task, .hidden-toggle"),
    ];
    const index = rows.indexOf(row);
    const botId = row.dataset.bot ?? null;
    const isPin = row.classList.contains("pin");
    const isBot = isPin || row.classList.contains("bot");
    if (
      event.altKey &&
      event.shiftKey &&
      manual &&
      !matches &&
      botId &&
      row.classList.contains("bot") &&
      !row.closest(".hidden-list") &&
      (event.key === "ArrowUp" || event.key === "ArrowDown")
    ) {
      event.preventDefault();
      const at = arranged.list.findIndex((bot) => bot.id === botId);
      if (at === -1) return;
      moveBot(botId, at + (event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      rows[
        Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))
      ]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      rows[event.key === "Home" ? 0 : rows.length - 1]?.focus();
    } else if (event.key === "ArrowRight" && isBot && botId && !selection.isOpen(botId)) {
      event.preventDefault();
      if (isPin) selection.unfoldOnly(botId, pinnedIds);
      else selection.toggleFold(botId);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (!isBot) {
        const block = row.closest(".pin-tasks");
        if (block && owner) {
          listRef.current
            .querySelector<HTMLElement>(`.pin[data-bot="${CSS.escape(owner.id)}"]`)
            ?.focus();
        } else {
          row.closest(".bot-group")?.querySelector<HTMLElement>(":scope > .bot")?.focus();
        }
      } else if (botId && selection.isOpen(botId)) selection.toggleFold(botId);
    } else if (
      isBot &&
      botId &&
      (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
    ) {
      event.preventDefault();
      const rect = row.getBoundingClientRect();
      openBotMenu(botId, row, rect.left + 40, rect.bottom - 6);
    }
  };

  const gatewayEntries: MenuEntry[] = [
    {
      kind: "head",
      title: gateway,
      lines: [
        `${words} · ${connection.gatewayUrl ?? "no address"}`,
        ...(connection.serverVersion ? [`OpenClaw ${connection.serverVersion}`] : []),
      ],
    },
    { kind: "rule" },
    { kind: "label", text: "Theme" },
    ...(
      [
        ["system", "Match the system"],
        ["light", "Light"],
        ["dark", "Dark"],
      ] as const
    ).map(([choice, label]): MenuEntry => ({
      kind: "radio",
      label,
      checked: theme === choice,
      onSelect: () => {
        onTheme(choice);
        closeMenu(true);
      },
    })),
    { kind: "rule" },
    { kind: "label", text: "Your messages" },
    ...(
      [
        ["accent", "Accent"],
        ["neutral", "Neutral"],
      ] as const
    ).map(([choice, label]): MenuEntry => ({
      kind: "radio",
      label,
      checked: bubbles === choice,
      onSelect: () => {
        onBubbles(choice);
        closeMenu(true);
      },
    })),
    { kind: "rule" },
    {
      kind: "item",
      label: "Settings",
      icon: <SettingsIcon />,
      // Focus goes back to the gateway button first, so Settings returns it there.
      onSelect: () => {
        closeMenu(true);
        onOpenSettings();
      },
    },
    {
      kind: "item",
      label: "Disconnect",
      tone: "danger",
      onSelect: () => {
        setMenu(null);
        void send({ type: "disconnect" });
      },
    },
  ];

  const sortEntries: MenuEntry[] = [
    { kind: "label", text: "Sort bots" },
    ...SORT_ORDERS.map((order): MenuEntry => ({
      kind: "radio",
      label: order.label,
      checked: roster.prefs.sort === order.id,
      // The gateway cannot keep a read-only device's order for other clients.
      ...(order.id === "manual" ? { note: "This device only" } : {}),
      onSelect: () => {
        roster.setSort(order.id);
        closeMenu(true);
      },
    })),
  ];

  const menuBot = menu?.kind === "bot" ? bots.find((b) => b.id === menu.botId) : undefined;
  const botEntries = (bot: Bot): MenuEntry[] => {
    const tasks = tasksByBot[bot.id] ?? [];
    const hidden = roster.prefs.hidden.includes(bot.id);
    const pinned = pinnedIds.includes(bot.id);
    const listIndex = arranged.list.findIndex((other) => other.id === bot.id);
    const task = selection.taskFor(bot.id);
    // The row may move (pinned, unpinned, reordered or shown again), so focus
    // follows the bot to where it is once the rail has rendered.
    const after = (action: () => void) => () => {
      action();
      setMenu(null);
      setRefocus({ bot: bot.id });
    };
    return tidy([
      ...(tasks.length > 1 && !hidden
        ? [
            {
              kind: "item" as const,
              label: selection.isOpen(bot.id) ? "Hide tasks" : "Show tasks",
              icon: <ChevronIcon />,
              onSelect: after(() =>
                pinned && !selection.isOpen(bot.id)
                  ? selection.unfoldOnly(bot.id, pinnedIds)
                  : selection.toggleFold(bot.id),
              ),
            },
            { kind: "rule" as const },
          ]
        : []),
      ...(!hidden
        ? [
            {
              kind: "item" as const,
              label: pinned ? "Unpin" : "Pin",
              icon: <PinIcon />,
              onSelect: after(() => {
                if (pinned) selection.release([bot.id]);
                roster.togglePin(bot.id);
              }),
            },
          ]
        : []),
      ...(manual && !matches && listIndex > 0
        ? [
            {
              kind: "item" as const,
              label: "Move up",
              icon: <ArrowUpIcon />,
              onSelect: after(() => moveBot(bot.id, listIndex - 1)),
            },
          ]
        : []),
      ...(manual && !matches && listIndex !== -1 && listIndex < arranged.list.length - 1
        ? [
            {
              kind: "item" as const,
              label: "Move down",
              icon: <ArrowDownIcon />,
              onSelect: after(() => moveBot(bot.id, listIndex + 1)),
            },
          ]
        : []),
      { kind: "rule" },
      ...(task
        ? [
            {
              kind: "item" as const,
              label: "Copy conversation ID",
              icon: <CopyIcon />,
              onSelect: after(() => {
                void copyText(task.key).then((result) =>
                  setAnnouncement(
                    result === "copied"
                      ? `Copied the conversation ID of ${task.title}.`
                      : "Couldn't copy the conversation ID.",
                  ),
                );
              }),
            },
          ]
        : []),
      { kind: "rule" },
      hidden
        ? {
            kind: "item",
            label: "Show in sidebar",
            icon: <EyeIcon />,
            onSelect: after(() => roster.setHidden(bot.id, false)),
          }
        : {
            kind: "item",
            label: "Hide from sidebar",
            icon: <HideIcon />,
            // The row goes into the folded section, so focus goes to its toggle.
            onSelect: after(() => {
              selection.release([bot.id]);
              roster.setHidden(bot.id, true);
              setAnnouncement(`${bot.name} is hidden. Hidden bots keep working.`);
            }),
          },
    ]);
  };

  const gatewayName = `${gateway}, ${words.replace("…", "").toLowerCase()}. Open the gateway menu.`;

  // "now" while any of the bot's tasks runs, whichever state the row shows.
  const time = (tasks: Task[], summary: BotSummary) =>
    tasks.some((task) => task.status === "running")
      ? "now"
      : rowTime(summary.latest?.updatedAt ?? null, now);

  const onContextMenu = (bot: Bot) => (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    openBotMenu(bot.id, event.currentTarget, event.clientX, event.clientY);
  };

  const draggable = manual && !matches;
  const dragProps = (bot: Bot, inList: boolean) =>
    draggable && inList
      ? {
          onDragOver: (event: DragEvent<HTMLLIElement>) => {
            if (!drag) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            const rect = event.currentTarget.getBoundingClientRect();
            const before = event.clientY < rect.top + rect.height / 2;
            if (drag.over !== bot.id || drag.before !== before) {
              setDrag({ ...drag, over: bot.id, before });
            }
          },
          onDrop: (event: DragEvent<HTMLLIElement>) => {
            event.preventDefault();
            if (!drag || drag.id === bot.id) return setDrag(null);
            const rest = arranged.list.filter((other) => other.id !== drag.id);
            const at = rest.findIndex((other) => other.id === bot.id);
            moveBot(drag.id, drag.before ? at : at + 1);
            setDrag(null);
          },
        }
      : {};

  const renderRow = (bot: Bot, place: "list" | "hidden" | "search") => {
    const tasks = tasksByBot[bot.id] ?? [];
    const summary = summarize(tasks, selection.seen, onScreenKey);
    const open = place !== "search" && selection.isOpen(bot.id);
    const several = tasks.length > 1;
    const selected = bot.id === selection.bot?.id;
    const latest = summary.latest;
    return (
      <li
        key={bot.id}
        className="bot-group"
        data-open={open || undefined}
        data-drop={
          drag && drag.over === bot.id && drag.id !== bot.id
            ? drag.before
              ? "before"
              : "after"
            : undefined
        }
        {...dragProps(bot, place === "list")}
      >
        <button
          type="button"
          className="bot"
          data-testid="bot"
          data-bot={bot.id}
          data-state={summary.state ?? undefined}
          draggable={draggable && place === "list" ? true : undefined}
          onDragStart={(event) => {
            event.dataTransfer.setData("text/plain", bot.id);
            event.dataTransfer.effectAllowed = "move";
            setTip(null);
            setDrag({ id: bot.id, over: null, before: true });
          }}
          onDragEnd={() => setDrag(null)}
          aria-current={selected && !open ? "true" : undefined}
          aria-expanded={several && place !== "search" ? open : undefined}
          aria-label={botLabel(bot, tasks.length, summary, {
            primary: bot.isDefault,
            label: bot.theme,
          })}
          onClick={() =>
            clickBot(bot, place === "search" ? Math.min(tasks.length, 1) : tasks.length)
          }
          onContextMenu={onContextMenu(bot)}
        >
          <Presence bot={bot} state={summary.state} primary={bot.isDefault} />
          <span className="bot-text">
            <span className="bot-line">
              <span className="bot-name">{bot.name}</span>
              {bot.theme && <span className="bot-label">{bot.theme}</span>}
              <time className="bot-time">{time(tasks, summary)}</time>
            </span>
            <span className="bot-line">
              <span className="bot-preview">
                {latest
                  ? (latest.preview ?? latest.title)
                  : discovery.status === "loading"
                    ? "Loading tasks"
                    : "No tasks yet"}
              </span>
              {summary.unread && <span className="unread-dot" />}
            </span>
          </span>
        </button>
        {several && place !== "search" && (
          <button
            type="button"
            className="icon-button bot-toggle"
            tabIndex={-1}
            aria-label={`${open ? "Hide" : "Show"} ${bot.name}'s tasks`}
            onClick={() => selection.toggleFold(bot.id)}
          >
            <ChevronIcon />
          </button>
        )}
        {open && (
          <TaskRows
            bot={bot}
            tasks={tasks}
            selection={selection}
            onOpenTask={openTask}
            onTip={setTip}
            now={now}
          />
        )}
      </li>
    );
  };

  const renderPin = (bot: Bot) => {
    const tasks = tasksByBot[bot.id] ?? [];
    const summary = summarize(tasks, selection.seen, onScreenKey);
    const several = tasks.length > 1;
    return (
      <li key={bot.id}>
        <button
          type="button"
          className="pin"
          data-testid="bot"
          data-bot={bot.id}
          data-state={summary.state ?? undefined}
          aria-current={bot.id === selection.bot?.id ? "true" : undefined}
          aria-expanded={several ? owner?.id === bot.id : undefined}
          aria-label={botLabel(bot, tasks.length, summary, {
            primary: bot.isDefault,
            label: bot.theme,
          })}
          title={bot.name}
          onClick={() => clickPin(bot, tasks.length)}
          onContextMenu={onContextMenu(bot)}
        >
          <Presence bot={bot} state={summary.state} primary={bot.isDefault} />
          <span className="pin-name">
            <span>{bot.name}</span>
            {summary.unread && <span className="unread-dot" />}
          </span>
        </button>
      </li>
    );
  };

  return (
    <nav className="rail" aria-label="Bots" inert={inert}>
      <div className="rail-top">
        <button
          type="button"
          className="icon-button rail-status"
          aria-haspopup="menu"
          aria-expanded={menu?.kind === "gateway"}
          aria-label={gatewayName}
          onClick={(event) => openGatewayMenu(event.currentTarget)}
          onKeyDown={onGatewayKey}
        >
          <SettingsIcon />
          <span className="status-dot" data-status={dot} />
        </button>
        {query === null ? (
          <>
            <button
              type="button"
              className="icon-button"
              aria-haspopup="menu"
              aria-expanded={menu?.kind === "sort"}
              aria-label={`Sort bots: ${sortLabel}${manual ? ", this device only" : ""}`}
              title={`Sort bots: ${sortLabel}${manual ? " (this device only)" : ""}`}
              onClick={(event) => {
                const trigger = event.currentTarget;
                setMenu((current) => (current?.kind === "sort" ? null : { kind: "sort", trigger }));
              }}
            >
              <SortIcon />
            </button>
            <button
              type="button"
              ref={searchButtonRef}
              className="icon-button"
              aria-label="Search bots"
              title="Search bots (⌘⇧F)"
              onClick={openSearch}
            >
              <SearchIcon />
            </button>
          </>
        ) : (
          <div className="rail-search" role="search">
            <SearchIcon />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKey}
              placeholder="Search bots"
              aria-label="Search bots"
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="icon-button"
              data-variant="quiet"
              aria-label="Close search"
              title="Close search (Esc)"
              onClick={() => closeSearch(true)}
            >
              <CloseIcon />
            </button>
          </div>
        )}
      </div>
      <ul
        className="bot-list"
        data-testid="bot-list"
        data-dragging={drag ? "true" : undefined}
        ref={listRef}
        onKeyDown={onListKey}
        onScroll={() => setTip(null)}
        aria-busy={discovery.status === "loading" && bots.length === 0 ? true : undefined}
      >
        {bots.length === 0 &&
          (discovery.status === "loading" ? (
            <li className="rail-empty">
              <strong>Loading bots</strong>Loading this gateway's bots.
            </li>
          ) : (
            <li className="rail-empty">
              <strong>No bots</strong>Bots appear here once the gateway has one.
            </li>
          ))}
        {matches ? (
          <>
            {bots.length > 0 && matches.length === 0 && (
              <li className="rail-empty" role="status">
                <strong>No bots match</strong>No bot's name contains "{query?.trim()}".
              </li>
            )}
            {matches.map((bot) => renderRow(bot, "search"))}
          </>
        ) : (
          <>
            {arranged.pinned.length > 0 && (
              <li>
                <ul className="pin-grid" aria-label="Pinned bots">
                  {arranged.pinned.map(renderPin)}
                </ul>
              </li>
            )}
            {owner && (
              <li className="pin-tasks">
                <p className="pin-tasks-label" aria-hidden="true">
                  <Avatar bot={owner} />
                  {owner.name}
                </p>
                <TaskRows
                  bot={owner}
                  tasks={tasksByBot[owner.id] ?? []}
                  selection={selection}
                  onOpenTask={openTask}
                  onTip={setTip}
                  now={now}
                />
              </li>
            )}
            {arranged.list.map((bot) => renderRow(bot, "list"))}
            {arranged.hidden.length > 0 && (
              <li className="rail-hidden">
                <button
                  type="button"
                  className="hidden-toggle"
                  aria-expanded={showHidden}
                  onClick={() => setShowHidden((open) => !open)}
                >
                  <ChevronIcon />
                  Hidden bots
                  <span className="hidden-count">{arranged.hidden.length}</span>
                </button>
                {showHidden && (
                  <ul className="hidden-list" aria-label="Hidden bots">
                    {arranged.hidden.map((bot) => renderRow(bot, "hidden"))}
                  </ul>
                )}
              </li>
            )}
          </>
        )}
        {discovery.partial && <li className="list-note">Showing the most recent tasks only.</li>}
      </ul>
      <p className="visually-hidden" role="status">
        {announcement}
      </p>
      <div className="rail-footer">
        <button
          type="button"
          className="gateway-pill"
          aria-haspopup="menu"
          aria-expanded={menu?.kind === "gateway"}
          aria-label={gatewayName}
          onClick={(event) => openGatewayMenu(event.currentTarget)}
          onKeyDown={onGatewayKey}
        >
          <span className="status-dot" data-status={dot} />
          <span className="gateway-pill-text" aria-hidden="true">
            <strong>{gateway}</strong>
            <span>{words}</span>
          </span>
        </button>
      </div>
      {menu?.kind === "gateway" && (
        <Menu
          label="Gateway"
          className="gateway-menu"
          entries={gatewayEntries}
          onClose={closeMenu}
          trigger={menu.trigger}
        />
      )}
      {menu?.kind === "sort" && (
        <Menu
          label="Sort bots"
          className="rail-menu sort-menu"
          style={{
            left: Math.max(8, menu.trigger.getBoundingClientRect().right - 232),
            top: menu.trigger.getBoundingClientRect().bottom + 6,
          }}
          entries={sortEntries}
          onClose={closeMenu}
          trigger={menu.trigger}
        />
      )}
      {menu?.kind === "bot" && menuBot && (
        <Menu
          label={menuBot.name}
          className="rail-menu"
          style={{
            left: Math.max(8, Math.min(menu.x, window.innerWidth - 244)),
            top: Math.max(8, Math.min(menu.y, window.innerHeight - 280)),
          }}
          entries={botEntries(menuBot)}
          onClose={closeMenu}
          trigger={menu.trigger}
        />
      )}
      {tip && (
        <div
          className="rail-tooltip"
          role="tooltip"
          style={{ top: tip.top, left: tip.left }}
          data-testid="rail-tooltip"
        >
          {tip.text}
        </div>
      )}
    </nav>
  );
}
