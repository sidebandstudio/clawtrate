import type { Bot, ClawtrateState, ConnectionState, Task } from "@clawtrate/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import logoUrl from "./assets/logo-mark.png";
import { Avatar } from "./Avatar.tsx";
import { useCommand } from "./bridge.tsx";
import { PRODUCT_NAME } from "./ConnectScreen.tsx";
import { Conversation } from "./Conversation.tsx";
import { gatewayLabel, shortTime } from "./format.ts";
import { MoonIcon, PlugIcon, SunIcon } from "./icons.tsx";
import { readPreference, useTheme, writePreference } from "./preferences.ts";

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
  return (
    <nav className="rail" aria-label="Bots">
      <div className="brand">
        <img src={logoUrl} alt="" />
        <span className="brand-name">{PRODUCT_NAME}</span>
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
                onClick={() => onSelect(bot.id)}
                data-testid="bot"
              >
                <Avatar bot={bot} badge />
                <span style={{ minWidth: 0 }}>
                  <span className="bot-name">{bot.name}</span>
                  <span className="bot-theme">{running ? "working" : (bot.theme ?? "")}</span>
                </span>
                <span className="bot-count" aria-label={`${tasks.length} tasks`}>
                  {tasks.length}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="rail-footer">
        <div
          className="gateway-pill"
          title={[
            connection.gatewayUrl,
            connection.serverVersion && `OpenClaw ${connection.serverVersion}`,
          ]
            .filter(Boolean)
            .join("\n")}
        >
          <span className="status-dot" data-status={connection.status} />
          <span className="gateway-pill-text">
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
  onSelect,
}: {
  bot: Bot | undefined;
  tasks: Task[];
  selectedKey: string | null;
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
        {bot && <Avatar bot={bot} size={26} />}
        <div className="pane-title">
          <h2>{bot?.name ?? "No bot"}</h2>
          <p>
            {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
            {bot?.theme ? ` · ${bot.theme}` : ""}
          </p>
        </div>
      </header>
      {tasks.length === 0 ? (
        <div className="empty">
          <div>
            <h3>No tasks yet</h3>
            <p>Conversations with {bot?.name ?? "this bot"} will be listed here.</p>
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
                data-unread={task.unread && task.key !== selectedKey}
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
        </ul>
      )}
    </section>
  );
}

function WorkPanel({ task }: { task: Task | null }) {
  return (
    <aside className="work-panel" aria-label="Work panel">
      <div className="work-panel-inner">
        <header className="pane-header">
          <div className="pane-title">
            <h2>Work</h2>
            <p>{task ? task.title : "No task selected"}</p>
          </div>
        </header>
        <div className="work-sections">
          <section className="work-section">
            <h3>Files</h3>
            <div className="work-placeholder">Files this bot reads and writes for the task.</div>
          </section>
          <section className="work-section">
            <h3>Plan</h3>
            <div className="work-placeholder">The bot&apos;s plan and progress.</div>
          </section>
          <section className="work-section">
            <h3>Tool calls</h3>
            <div className="work-placeholder">Every raw tool call behind the conversation.</div>
          </section>
        </div>
      </div>
    </aside>
  );
}

function Banner({ connection }: { connection: ConnectionState }) {
  const send = useCommand();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (connection.status !== "reconnecting") return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [connection.status]);

  if (connection.status === "connected") return null;
  const seconds = connection.retryAt
    ? Math.max(0, Math.ceil((connection.retryAt - now) / 1000))
    : null;
  const danger = connection.status === "error";
  return (
    <div className="banner" role="status" data-tone={danger ? "danger" : "warn"}>
      <span>
        {danger
          ? `Disconnected from ${gatewayLabel(connection.gatewayUrl)}. ${connection.error?.message ?? ""}`
          : `Connection lost. Reconnecting${seconds ? ` in ${seconds}s` : ""}… Showing the last known state.`}
      </span>
      <button type="button" onClick={() => void send({ type: "retry" })}>
        Retry now
      </button>
    </div>
  );
}

/** Remembers the last task opened for each bot, so switching bots returns to it. */
function useSelection(state: ClawtrateState) {
  const [botId, setBotId] = useState<string | null>(() => readPreference("bot"));
  const [taskByBot, setTaskByBot] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(readPreference("tasks") ?? "{}") as Record<string, string>;
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

  const selectBot = useCallback((id: string) => {
    setBotId(id);
    writePreference("bot", id);
  }, []);

  const selectTask = useCallback(
    (key: string) => {
      if (!bot) return;
      setTaskByBot((current) => {
        const next = { ...current, [bot.id]: key };
        writePreference("tasks", JSON.stringify(next));
        return next;
      });
    },
    [bot],
  );

  return { bot, tasks, task, selectBot, selectTask };
}

export function Shell({ state }: { state: ClawtrateState }) {
  const send = useCommand();
  const { bot, tasks, task, selectBot, selectTask } = useSelection(state);
  const [panelOpen, setPanelOpen] = useState(() => readPreference("panel") === "open");

  const togglePanel = useCallback(() => {
    setPanelOpen((open) => {
      writePreference("panel", open ? "closed" : "open");
      return !open;
    });
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "\\") {
        event.preventDefault();
        togglePanel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePanel]);

  // Keep exactly the selected task's transcript open on the host.
  const taskKey = task?.key ?? null;
  useEffect(() => {
    if (!taskKey) return;
    void send({ type: "openSession", key: taskKey });
    return () => void send({ type: "closeSession", key: taskKey });
  }, [taskKey, send]);

  return (
    <div className="shell" data-panel={panelOpen ? "open" : "closed"}>
      <Banner connection={state.connection} />
      <Rail
        bots={state.bots}
        tasksByBot={state.tasksByBot}
        selectedBotId={bot?.id ?? null}
        onSelect={selectBot}
        connection={state.connection}
      />
      <TaskList bot={bot} tasks={tasks} selectedKey={taskKey} onSelect={selectTask} />
      <Conversation
        task={task}
        bot={bot}
        transcript={taskKey ? state.transcripts[taskKey] : undefined}
        panelOpen={panelOpen}
        onTogglePanel={togglePanel}
      />
      <WorkPanel task={task} />
    </div>
  );
}
