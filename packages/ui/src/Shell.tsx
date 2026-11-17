import type { ClawtrateState } from "@clawtrate/core";
import { canWrite } from "./access.ts";
import { OpenTaskContext } from "./cards/index.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useCommand } from "./bridge.tsx";
import { Conversation } from "./Conversation.tsx";
import { DOCK_FROM, ONE_PANE_BELOW, useElementWidth } from "./layout.ts";
import {
  readPreference,
  writePreference,
  type BubbleChoice,
  type ThemeChoice,
} from "./preferences.ts";
import { Rail } from "./Rail.tsx";
import { useSelection } from "./selection.ts";
import { unreadCount } from "./unread.ts";
import { refreshFailed, StatusStrip, stripFor, useSyncPhase } from "./StatusStrip.tsx";
import { WorkPanel } from "./WorkPanel.tsx";

/** A control that can take focus now: in the page, shown, and not behind the drawer. */
function canFocus(element: HTMLElement | null): element is HTMLElement {
  return (
    element !== null &&
    element !== document.body &&
    element.isConnected &&
    !element.closest("[inert]") &&
    element.getClientRects().length > 0
  );
}

export function Shell({
  state,
  theme,
  onTheme,
  bubbles,
  onBubbles,
  onUnreadCount,
  onOpenSettings,
  inert = false,
}: {
  state: ClawtrateState;
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
  bubbles: BubbleChoice;
  onBubbles: (choice: BubbleChoice) => void;
  onUnreadCount?: ((count: number) => void) | undefined;
  onOpenSettings: () => void;
  /** Set while Settings covers the shell. */
  inert?: boolean;
}) {
  const send = useCommand();
  const selection = useSelection(state);
  const { bot, task } = selection;
  const [panelOpen, setPanelOpen] = useState(() => readPreference("panel") === "open");
  // In the one-pane layout the rail and the conversation take turns.
  const [view, setView] = useState<"list" | "detail">("detail");
  const shellRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const shellWidth = useElementWidth(shellRef);
  const mainWidth = useElementWidth(mainRef);
  const onePane = shellWidth !== null && shellWidth < ONE_PANE_BELOW;

  // Whether Work is a drawer is decided here, from the width of .main-pane, and
  // in the stylesheet by the same width (DOCK_FROM); nowhere else.
  const overlay = mainWidth !== null && mainWidth < DOCK_FROM;
  const drawerOpen = panelOpen && overlay;

  const setPanel = useCallback((open: boolean) => {
    if (open) {
      const active = document.activeElement as HTMLElement | null;
      openerRef.current = canFocus(active) ? active : null;
    }
    setPanelOpen(open);
    writePreference("panel", open ? "open" : "closed");
  }, []);
  const togglePanel = useCallback(() => setPanel(!panelOpen), [panelOpen, setPanel]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "\\") {
        event.preventDefault();
        togglePanel();
      } else if (event.key === "Escape" && drawerOpen) {
        setPanel(false);
      } else if (event.key === "Tab" && drawerOpen && panelRef.current) {
        // The drawer keeps focus inside itself.
        const items = [
          ...panelRef.current.querySelectorAll<HTMLElement>("button, [tabindex]"),
        ].filter((element) => element.tabIndex >= 0 && !element.closest("[hidden]"));
        const first = items[0];
        const last = items.at(-1);
        const active = document.activeElement;
        if (!panelRef.current.contains(active)) {
          event.preventDefault();
          first?.focus();
        } else if (event.shiftKey && active === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePanel, drawerOpen, setPanel]);

  // The dock or taskbar badge counts unread tasks, other than the one on screen.
  const unread = unreadCount(state.tasksByBot, selection.seen, task?.key ?? null);
  useEffect(() => {
    onUnreadCount?.(unread);
  }, [unread, onUnreadCount]);
  useEffect(() => () => onUnreadCount?.(0), [onUnreadCount]);

  // Keep exactly the selected task's transcript open on the host.
  const taskKey = task?.key ?? null;
  useEffect(() => {
    if (!taskKey) return;
    void send({ type: "openSession", key: taskKey });
    return () => void send({ type: "closeSession", key: taskKey });
  }, [taskKey, send]);

  // The one place that moves focus for Work. As a drawer it takes focus, unless
  // focus is already inside it. When the pane closes, focus that was inside it
  // (a drawer's, or a docked pane's that went with it) returns to the control
  // that opened it, or else to the Work toggle. Docking or undocking an open
  // pane moves nothing except off what has just become inert.
  const drawerWasOpen = useRef(false);
  const panelWasOpen = useRef(panelOpen);
  useEffect(() => {
    // Right after a resize the last measurement can lag a frame behind, so
    // focus is decided from the pane's width as it is now.
    const main = mainRef.current;
    const drawerNow = panelOpen && (main ? main.clientWidth < DOCK_FROM : drawerOpen);
    if (drawerNow) {
      if (!panelRef.current?.contains(document.activeElement)) closeRef.current?.focus();
    } else if (!panelOpen && panelWasOpen.current) {
      const active = document.activeElement;
      if (drawerWasOpen.current || !active || active === document.body) {
        const opener = openerRef.current;
        (canFocus(opener) ? opener : toggleRef.current)?.focus();
      }
    }
    drawerWasOpen.current = drawerNow;
    panelWasOpen.current = panelOpen;
  }, [drawerOpen, panelOpen, mainWidth]);

  // One pane at a time: moving between the list and a conversation hides the
  // control that was used, so focus goes to the destination. Into a
  // conversation, its heading; back to the list, the row that opened it.
  const navigatedTo = useRef<"list" | "detail" | null>(null);
  const openDetail = useCallback(() => {
    if (onePane) navigatedTo.current = "detail";
    setView("detail");
  }, [onePane]);
  const showList = useCallback(() => setView("list"), []);
  const backToList = useCallback(() => {
    navigatedTo.current = "list";
    setView("list");
  }, []);
  useEffect(() => {
    const target = navigatedTo.current;
    if (!target) return;
    navigatedTo.current = null;
    if (target === "detail") {
      const conversation = mainRef.current?.querySelector(".conversation");
      const heading = conversation?.querySelector<HTMLElement>("h1");
      (heading ?? conversation?.querySelector<HTMLElement>(".back-button"))?.focus();
    } else {
      const rail = shellRef.current?.querySelector(".rail");
      (
        rail?.querySelector<HTMLElement>('.task[aria-current="true"]') ??
        rail?.querySelector<HTMLElement>(':is(.bot, .pin)[aria-current="true"]') ??
        rail?.querySelector<HTMLElement>(".bot")
      )?.focus();
    }
  }, [view, taskKey]);

  // One connection state drives the strip, the footer and the composer.
  const transcript = taskKey ? state.transcripts[taskKey] : undefined;
  const phase = useSyncPhase(state, taskKey);
  const strip = stripFor(state, phase, taskKey);
  const catchingUp =
    phase === "dropped" && state.connection.status === "connected" && strip?.tone === "warn";
  const reload = useCallback(() => {
    if (!taskKey) return;
    void send({ type: "closeSession", key: taskKey }).then(() =>
      send({ type: "openSession", key: taskKey }),
    );
  }, [taskKey, send]);

  return (
    <div
      className="shell"
      ref={shellRef}
      data-panel={panelOpen ? "open" : "closed"}
      data-view={view}
      inert={inert}
    >
      <Rail
        bots={state.bots}
        tasksByBot={state.tasksByBot}
        discovery={state.discovery}
        connection={state.connection}
        catchingUp={catchingUp}
        selection={selection}
        onePane={onePane}
        onOpen={openDetail}
        onShowList={showList}
        theme={theme}
        onTheme={onTheme}
        bubbles={bubbles}
        onBubbles={onBubbles}
        onOpenSettings={onOpenSettings}
        inert={drawerOpen || inert}
      />
      <div className="main-pane" ref={mainRef}>
        <OpenTaskContext.Provider value={selection.selectTask}>
          <Conversation
            task={task}
            bot={bot}
            taskCount={selection.tasks.length}
            discovery={state.discovery}
            transcript={transcript}
            panelOpen={panelOpen}
            onTogglePanel={togglePanel}
            onOpenPanel={() => setPanel(true)}
            onBack={backToList}
            onReload={reload}
            strip={
              strip && (
                <StatusStrip
                  strip={strip}
                  retryAt={state.connection.retryAt}
                  onRetry={() => void send({ type: "retry" })}
                  onReload={reload}
                />
              )
            }
            refreshNote={phase !== "dropped" && refreshFailed(transcript)}
            readOnly={!canWrite(state.connection)}
            online={state.connection.status === "connected"}
            toggleRef={toggleRef}
            inert={drawerOpen || inert}
          />
        </OpenTaskContext.Provider>
        <button
          type="button"
          className="drawer-scrim"
          aria-label="Close work panel"
          tabIndex={-1}
          onClick={() => setPanel(false)}
        />
        {panelOpen && (
          <WorkPanel
            bot={bot}
            task={task}
            drawer={drawerOpen}
            onClose={() => setPanel(false)}
            closeRef={closeRef}
            panelRef={panelRef}
          />
        )}
      </div>
    </div>
  );
}
