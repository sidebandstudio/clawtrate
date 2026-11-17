import type { Bot, ConnectionState, DiscoveryState, Task } from "@clawtrate/core";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Avatar } from "./Avatar.tsx";
import { useCommand } from "./bridge.tsx";
import { gatewayLabel, rowTime } from "./format.ts";
import { ChevronIcon, CloseIcon, SearchIcon, SettingsIcon } from "./icons.tsx";
import { Menu, type MenuEntry } from "./Menu.tsx";
import type { ThemeChoice } from "./preferences.ts";
import {
  botLabel,
  summarize,
  TASK_CAP,
  visibleTasks,
  type BotSummary,
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

function StateMark({ state }: { state: BotSummary["state"] | Task["status"] }) {
  if (state === "working" || state === "running")
    return <span className="glyph" data-state="working" aria-hidden="true" />;
  if (state === "failed") return <span className="glyph" data-state="failed" aria-hidden="true" />;
  return null;
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
        const spoken =
          task.title +
          (task.status === "running"
            ? ", working"
            : task.status === "failed"
              ? ", last run failed"
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
                {task.status === "running" || task.status === "failed" ? (
                  <StateMark state={task.status} />
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
  | { kind: "bot"; botId: string; trigger: HTMLElement; x: number; y: number };

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
  inert: boolean;
}) {
  const send = useCommand();
  const now = useMinuteClock();
  const [tip, setTip] = useState<Tip | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const gateway = gatewayLabel(connection.gatewayUrl);
  const words = presenceWords(connection, catchingUp);
  const dot = presenceDot(connection, catchingUp);
  const onScreenKey = selection.task?.key ?? null;
  // Bot search: null while closed, the query while open.
  const [query, setQuery] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<"search" | "search-button" | "selected" | null>(null);
  const needle = query?.trim().toLowerCase() ?? "";
  const shown = needle ? bots.filter((bot) => bot.name.toLowerCase().includes(needle)) : bots;

  const closeMenu = useCallback(
    (refocus: boolean) => {
      if (refocus) menu?.trigger.focus();
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

  const openSearch = useCallback(() => {
    focusAfter.current = "search";
    setQuery((current) => current ?? "");
    onShowList();
  }, [onShowList]);

  const closeSearch = (refocus: boolean) => {
    if (refocus) focusAfter.current = "search-button";
    setQuery(null);
  };

  // Focus moves only after the element it goes to has rendered.
  useEffect(() => {
    const target = focusAfter.current;
    if (!target) return;
    focusAfter.current = null;
    if (target === "search") searchRef.current?.focus();
    else if (target === "search-button") searchButtonRef.current?.focus();
    else {
      listRef.current
        ?.querySelector<HTMLElement>(`.bot[data-bot="${CSS.escape(selection.bot?.id ?? "")}"]`)
        ?.focus();
    }
  });

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
        target = shown[Number(event.key) - 1];
      } else {
        const step =
          event.altKey && !command && !typing && event.key === "ArrowDown"
            ? 1
            : event.altKey && !command && !typing && event.key === "ArrowUp"
              ? -1
              : event.ctrlKey && event.key === "Tab"
                ? event.shiftKey
                  ? -1
                  : 1
                : 0;
        if (step === 0) return;
        const index = shown.findIndex((bot) => bot.id === selection.bot?.id);
        target = shown[Math.max(0, Math.min(shown.length - 1, index + step))];
      }
      if (!target) return;
      event.preventDefault();
      open(target);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inert, openSearch, onOpen, selection, shown]);

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeSearch(true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      listRef.current?.querySelector<HTMLElement>(".bot")?.focus();
    } else if (event.key === "Enter") {
      const first = shown[0];
      if (!first) return;
      event.preventDefault();
      closeSearch(false);
      selection.selectBot(first.id);
      onOpen();
      focusAfter.current = "selected";
    }
  };

  const openBotMenu = (botId: string, trigger: HTMLElement, x: number, y: number) => {
    if ((tasksByBot[botId]?.length ?? 0) < 2) return; // nothing to offer yet
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
  const onListKey = (event: KeyboardEvent<HTMLUListElement>) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>(".bot, .task");
    if (!row || !listRef.current) return;
    const rows = [...listRef.current.querySelectorAll<HTMLElement>(".bot, .task")];
    const index = rows.indexOf(row);
    const botId = row.dataset.bot ?? null;
    const isBot = row.classList.contains("bot");
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
      selection.toggleFold(botId);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (!isBot) row.closest(".bot-group")?.querySelector<HTMLElement>(":scope > .bot")?.focus();
      else if (botId && selection.isOpen(botId)) selection.toggleFold(botId);
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

  const menuBot = menu?.kind === "bot" ? bots.find((b) => b.id === menu.botId) : undefined;
  const gatewayName = `${gateway}, ${words.replace("…", "").toLowerCase()}. Open the gateway menu.`;

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
        {bots.length > 0 && shown.length === 0 && (
          <li className="rail-empty" role="status">
            <strong>No bots match</strong>No bot's name contains "{query?.trim()}".
          </li>
        )}
        {shown.map((bot) => {
          const tasks = tasksByBot[bot.id] ?? [];
          const summary = summarize(tasks, selection.seen, onScreenKey);
          const open = selection.isOpen(bot.id);
          const several = tasks.length > 1;
          const selected = bot.id === selection.bot?.id;
          const latest = summary.latest;
          return (
            <li key={bot.id} className="bot-group" data-open={open || undefined}>
              <button
                type="button"
                className="bot"
                data-testid="bot"
                data-bot={bot.id}
                aria-current={selected && !open ? "true" : undefined}
                aria-expanded={several ? open : undefined}
                aria-label={botLabel(bot, tasks.length, summary)}
                onClick={() => clickBot(bot, tasks.length)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  openBotMenu(bot.id, event.currentTarget, event.clientX, event.clientY);
                }}
              >
                <Avatar bot={bot} />
                <span className="bot-text">
                  <span className="bot-line">
                    <span className="bot-name">{bot.name}</span>
                    <time className="bot-time">
                      {summary.state === "working"
                        ? "now"
                        : rowTime(latest?.updatedAt ?? null, now)}
                    </time>
                  </span>
                  <span className="bot-line">
                    <StateMark state={summary.state} />
                    <span className="bot-preview">
                      {latest ? (latest.preview ?? latest.title) : "No tasks yet"}
                    </span>
                    {summary.unread && <span className="unread-dot" />}
                  </span>
                </span>
              </button>
              {several && (
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
        })}
        {discovery.partial && <li className="list-note">Showing the most recent tasks only.</li>}
      </ul>
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
      {menu?.kind === "bot" && menuBot && (
        <Menu
          label={menuBot.name}
          className="rail-menu"
          style={{
            left: Math.max(8, Math.min(menu.x, window.innerWidth - 244)),
            top: Math.min(menu.y, window.innerHeight - 60),
          }}
          entries={[
            {
              kind: "item",
              label: selection.isOpen(menuBot.id) ? "Hide tasks" : "Show tasks",
              onSelect: () => {
                selection.toggleFold(menuBot.id);
                closeMenu(true);
              },
            },
          ]}
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
