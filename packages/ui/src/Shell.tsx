import type { Bot, ClawtrateState, ConnectionState, DiscoveryState, Task } from "@clawtrate/core";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import logoUrl from "./assets/logo-mark.png";
import { Avatar } from "./Avatar.tsx";
import { useCommand } from "./bridge.tsx";
import { PRODUCT_NAME } from "./ConnectScreen.tsx";
import { Conversation } from "./Conversation.tsx";
import { gatewayLabel, shortTime } from "./format.ts";
import { CloseIcon, MoonIcon, PlugIcon, SunIcon } from "./icons.tsx";
import { readPreference, useTheme, writePreference } from "./preferences.ts";
import { isUnread, markSeen, type SeenMap } from "./unread.ts";

function statusLabel(connection: ConnectionState): string {
  switch (connection.status) {
    case "connected":
      return "Connected";
    case "reconnecting":
      return "Reconnecting";
    case "connecting":
      return "Connecting";
    case "pairing":
      return "Awaiting approval";
    case "error":
      return "Disconnected";
    case "idle":
      return "Not connected";
  }
}

function botLabel(bot: Bot, tasks: Task[]): string {
  const running = tasks.some((task) => task.status === "running");
  return `${bot.name}, ${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}${running ? ", working" : ""}`;
}

function Rail({
  bots,
  tasksByBot,
  selectedBotId,
  onSelect,
  connection,
}: {
  bots: Bot[];
  tasksByBot: ClawtrateState["tasksByBot"];
  selectedBotId: string | null;
  onSelect: (id: string) => void;
  connection: ConnectionState;
}) {
  const send = useCommand();
  const [theme, cycleTheme] = useTheme();
  const isDark =
    theme === "dark" ||
    (theme === "system" &&
      (globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false));
  // Names are hidden when the rail is compact; a tooltip shows them on hover and focus.
  const [tip, setTip] = useState<{ text: string; top: number; left: number } | null>(null);
  const showTip = (event: { currentTarget: HTMLElement }, text: string) => {
    if (!globalThis.matchMedia?.("(max-width: 979px)").matches) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setTip({ text, top: rect.top + rect.height / 2, left: rect.right + 8 });
  };
  const hideTip = () => setTip(null);
  const gatewayDetails = [
    `${statusLabel(connection)}: ${gatewayLabel(connection.gatewayUrl)}`,
    connection.serverVersion ? `OpenClaw ${connection.serverVersion}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <nav className="rail" aria-label="Bots">
      <div className="brand" title={PRODUCT_NAME}>
        <img src={logoUrl} alt={PRODUCT_NAME} />
        <span className="brand-name" aria-hidden="true">
          {PRODUCT_NAME}
        </span>
      </div>
      <div className="rail-section">Bots</div>
      <ul className="bot-list" data-testid="bot-list">
        {bots.map((bot) => {
          const tasks = tasksByBot[bot.id] ?? [];
          const running = tasks.some((task) => task.status === "running");
          return (
            <li key={bot.id}>
              <button
                type="button"
                className="bot"
                aria-current={bot.id === selectedBotId}
                aria-label={botLabel(bot, tasks)}
                onMouseEnter={(event) => showTip(event, bot.name)}
                onMouseLeave={hideTip}
                onFocus={(event) => showTip(event, bot.name)}
                onBlur={hideTip}
                onClick={() => onSelect(bot.id)}
                data-testid="bot"
              >
                <Avatar bot={bot} />
                <span className="bot-text" aria-hidden="true">
                  <span className="bot-name">{bot.name}</span>
                  <span className="bot-theme">{running ? "working" : (bot.theme ?? "")}</span>
                </span>
                <span className="bot-count" aria-hidden="true">
                  {tasks.length}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
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
      <div className="rail-footer">
        <div
          className="gateway-pill"
          title={gatewayDetails}
          aria-label={gatewayDetails}
          role="status"
        >
          <span className="status-dot" data-status={connection.status} />
          <span className="gateway-pill-text" aria-hidden="true">
            <strong>{statusLabel(connection)}</strong>
            <span>{gatewayLabel(connection.gatewayUrl)}</span>
          </span>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={cycleTheme}
          aria-label={isDark ? "Use light theme" : "Use dark theme"}
          title={isDark ? "Light theme" : "Dark theme"}
        >
          {isDark ? <SunIcon /> : <MoonIcon />}
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={() => void send({ type: "disconnect" })}
          aria-label="Disconnect from this gateway"
          title="Disconnect"
        >
          <PlugIcon />
        </button>
      </div>
    </nav>
  );
}

function TaskList({
  bot,
  tasks,
  selectedKey,
  seen,
  discovery,
  onSelect,
}: {
  bot: Bot | undefined;
  tasks: Task[];
  selectedKey: string | null;
  seen: SeenMap;
  discovery: DiscoveryState;
  onSelect: (key: string) => void;
}) {
  // Relative times refresh once a minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <section className="list-pane" aria-label="Tasks">
      <header className="pane-header">
        {bot && <Avatar bot={bot} />}
        <div className="pane-title">
          <h2>{bot?.name ?? "No bots"}</h2>
          <p>
            {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
            {bot?.theme ? ` · ${bot.theme}` : ""}
          </p>
        </div>
      </header>
      {tasks.length === 0 ? (
        <div className="empty">
          <div>
            <h3>{bot ? "No tasks yet" : "No bots to show"}</h3>
            <p>
              {bot
                ? `Conversations with ${bot.name} will be listed here.`
                : discovery.status === "loading"
                  ? "Loading this gateway's bots."
                  : "This gateway has no bots yet."}
            </p>
          </div>
        </div>
      ) : (
        <ul className="task-list" data-testid="task-list">
          {tasks.map((task) => (
            <li key={task.key}>
              <button
                type="button"
                className="task"
                aria-current={task.key === selectedKey}
                data-unread={isUnread(task, seen) && task.key !== selectedKey}
                onClick={() => onSelect(task.key)}
                data-testid="task"
              >
                <span className="task-top">
                  <span className="task-title">{task.title}</span>
                  <time className="task-time">{shortTime(task.updatedAt, now)}</time>
                </span>
                {task.preview && <span className="task-preview">{task.preview}</span>}
                {task.status === "running" && (
                  <span className="task-status">
                    <span className="run-node" aria-hidden="true" />
                    Working
                  </span>
                )}
                {task.status === "failed" && (
                  <span className="task-status" data-status="failed">
                    Last run failed
                  </span>
                )}
              </button>
            </li>
          ))}
          {discovery.partial && <li className="list-note">Showing the most recent tasks only.</li>}
        </ul>
      )}
    </section>
  );
}

function WorkPanel({
  open,
  onClose,
  closeRef,
}: {
  open: boolean;
  onClose: () => void;
  closeRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <aside className="work-panel" aria-label="Work" aria-hidden={!open} data-testid="work-panel">
      <header className="pane-header">
        <div className="pane-title">
          <h2>Work</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          ref={closeRef}
          onClick={onClose}
          aria-label="Close work panel"
          title="Close (Esc)"
          tabIndex={open ? 0 : -1}
        >
          <CloseIcon />
        </button>
      </header>
      <p className="work-empty">Nothing here yet. Files the bot touches will appear here.</p>
    </aside>
  );
}

/**
 * One compact strip for connection and loading problems. It overlays the top of
 * the conversation instead of pushing the layout down, and it mounts only when
 * needed, so its countdown starts from the moment the problem appeared.
 */
function StatusStrip({
  connection,
  discovery,
}: {
  connection: ConnectionState;
  discovery: DiscoveryState;
}) {
  const send = useCommand();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  const seconds =
    connection.retryAt !== null ? Math.max(0, Math.ceil((connection.retryAt - now) / 1000)) : null;
  let tone: "warn" | "danger" = "warn";
  let text: string;
  if (connection.status === "error") {
    tone = "danger";
    text = `Disconnected from ${gatewayLabel(connection.gatewayUrl)}. ${connection.error?.message ?? ""}`;
  } else if (connection.status !== "connected") {
    text = `Connection lost. Reconnecting${seconds ? ` in ${seconds}s` : "…"}`;
  } else {
    tone = "danger";
    text = discovery.error ?? "Could not load this gateway's bots and tasks.";
  }
  return (
    <div className="status-strip" role="status" data-tone={tone} data-testid="status-strip">
      <span className="status-strip-text">{text}</span>
      <button type="button" onClick={() => void send({ type: "retry" })}>
        Retry now
      </button>
    </div>
  );
}

const SEEN_KEY = "seen";

/** Matches the stylesheet: below this width Work is a drawer over the conversation. */
const OVERLAY_QUERY = "(max-width: 1319px)";

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    useCallback(
      (onChange: () => void) => {
        const media = globalThis.matchMedia?.(query);
        media?.addEventListener("change", onChange);
        return () => media?.removeEventListener("change", onChange);
      },
      [query],
    ),
    () => globalThis.matchMedia?.(query).matches ?? false,
    () => false,
  );
}

/** Remembers the last task opened for each bot and what this viewer has read. */
function useSelection(state: ClawtrateState) {
  const [botId, setBotId] = useState<string | null>(() => readPreference("bot"));
  const [taskByBot, setTaskByBot] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(readPreference("tasks") ?? "{}") as Record<string, string>;
    } catch {
      return {};
    }
  });
  const [seen, setSeen] = useState<SeenMap>(() => {
    try {
      return JSON.parse(readPreference(SEEN_KEY) ?? "{}") as SeenMap;
    } catch {
      return {};
    }
  });

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

  const selectBot = useCallback(
    (id: string) => {
      markRead();
      setBotId(id);
      writePreference("bot", id);
    },
    [markRead],
  );

  const selectTask = useCallback(
    (key: string) => {
      if (!bot) return;
      markRead();
      setTaskByBot((current) => {
        const next = { ...current, [bot.id]: key };
        writePreference("tasks", JSON.stringify(next));
        return next;
      });
    },
    [bot, markRead],
  );

  return { bot, tasks, task, seen, selectBot, selectTask };
}

export function Shell({ state }: { state: ClawtrateState }) {
  const send = useCommand();
  const { bot, tasks, task, seen, selectBot, selectTask } = useSelection(state);
  const [panelOpen, setPanelOpen] = useState(() => readPreference("panel") === "open");
  // At the narrowest widths the task list and the conversation take turns.
  const [view, setView] = useState<"list" | "detail">("detail");

  const setPanel = useCallback((open: boolean) => {
    setPanelOpen(open);
    writePreference("panel", open ? "open" : "closed");
  }, []);
  const togglePanel = useCallback(() => setPanel(!panelOpen), [panelOpen, setPanel]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "\\") {
        event.preventDefault();
        togglePanel();
      } else if (event.key === "Escape" && panelOpen) {
        setPanel(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePanel, panelOpen, setPanel]);

  // Keep exactly the selected task's transcript open on the host.
  const taskKey = task?.key ?? null;
  useEffect(() => {
    if (!taskKey) return;
    void send({ type: "openSession", key: taskKey });
    return () => void send({ type: "closeSession", key: taskKey });
  }, [taskKey, send]);

  // As an overlay, Work takes keyboard focus while open and hands it back to the
  // toggle when it closes; the conversation it covers is inert meanwhile. The
  // wide inline pane is ordinary page content and moves no focus.
  const overlay = useMediaQuery(OVERLAY_QUERY);
  const drawerOpen = panelOpen && overlay;
  const toggleRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const drawerWasOpen = useRef(false);
  useEffect(() => {
    if (drawerOpen) closeRef.current?.focus();
    else if (drawerWasOpen.current) toggleRef.current?.focus();
    drawerWasOpen.current = drawerOpen;
  }, [drawerOpen]);

  const showStrip = state.connection.status !== "connected" || state.discovery.status === "error";

  return (
    <div className="shell" data-panel={panelOpen ? "open" : "closed"} data-view={view}>
      <Rail
        bots={state.bots}
        tasksByBot={state.tasksByBot}
        selectedBotId={bot?.id ?? null}
        onSelect={(id) => {
          selectBot(id);
          setView("list");
        }}
        connection={state.connection}
      />
      <TaskList
        bot={bot}
        tasks={tasks}
        selectedKey={taskKey}
        seen={seen}
        discovery={state.discovery}
        onSelect={(key) => {
          selectTask(key);
          setView("detail");
        }}
      />
      <div className="main-pane">
        {showStrip && <StatusStrip connection={state.connection} discovery={state.discovery} />}
        <Conversation
          task={task}
          bot={bot}
          transcript={taskKey ? state.transcripts[taskKey] : undefined}
          panelOpen={panelOpen}
          onTogglePanel={togglePanel}
          onBack={() => setView("list")}
          toggleRef={toggleRef}
          inert={drawerOpen}
        />
        <button
          type="button"
          className="drawer-scrim"
          aria-label="Close work panel"
          tabIndex={-1}
          onClick={() => setPanel(false)}
        />
        <WorkPanel open={panelOpen} onClose={() => setPanel(false)} closeRef={closeRef} />
      </div>
    </div>
  );
}
