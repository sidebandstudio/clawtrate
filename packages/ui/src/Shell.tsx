import type { ClawtrateState, ConnectionState, DiscoveryState } from "@clawtrate/core";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { useCommand } from "./bridge.tsx";
import { Conversation } from "./Conversation.tsx";
import { gatewayLabel } from "./format.ts";
import { CloseIcon } from "./icons.tsx";
import { ONE_PANE_BELOW, useElementWidth } from "./layout.ts";
import { readPreference, writePreference, type ThemeChoice } from "./preferences.ts";
import { Rail } from "./Rail.tsx";
import { useSelection } from "./selection.ts";

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

export function Shell({
  state,
  theme,
  onTheme,
}: {
  state: ClawtrateState;
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
}) {
  const send = useCommand();
  const selection = useSelection(state);
  const { bot, task } = selection;
  const [panelOpen, setPanelOpen] = useState(() => readPreference("panel") === "open");
  // In the one-pane layout the rail and the conversation take turns.
  const [view, setView] = useState<"list" | "detail">("detail");
  const shellRef = useRef<HTMLDivElement>(null);
  const shellWidth = useElementWidth(shellRef);
  const onePane = shellWidth !== null && shellWidth < ONE_PANE_BELOW;

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
    <div
      className="shell"
      ref={shellRef}
      data-panel={panelOpen ? "open" : "closed"}
      data-view={view}
    >
      <Rail
        bots={state.bots}
        tasksByBot={state.tasksByBot}
        discovery={state.discovery}
        connection={state.connection}
        catchingUp={false}
        selection={selection}
        onePane={onePane}
        onOpen={() => setView("detail")}
        theme={theme}
        onTheme={onTheme}
        inert={false}
      />
      <div className="main-pane">
        {showStrip && <StatusStrip connection={state.connection} discovery={state.discovery} />}
        <Conversation
          task={task}
          bot={bot}
          taskCount={selection.tasks.length}
          discovery={state.discovery}
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
