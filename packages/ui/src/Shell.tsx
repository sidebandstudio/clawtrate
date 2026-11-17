import type { ClawtrateState } from "@clawtrate/core";
import { canWrite } from "./access.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useCommand } from "./bridge.tsx";
import { Conversation } from "./Conversation.tsx";
import { DOCK_FROM, ONE_PANE_BELOW, useElementWidth } from "./layout.ts";
import { readPreference, writePreference, type ThemeChoice } from "./preferences.ts";
import { Rail } from "./Rail.tsx";
import { useSelection } from "./selection.ts";
import { refreshFailed, StatusStrip, stripFor, useSyncPhase } from "./StatusStrip.tsx";
import { WorkPanel } from "./WorkPanel.tsx";

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
    if (open) openerRef.current = document.activeElement as HTMLElement | null;
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

  // Keep exactly the selected task's transcript open on the host.
  const taskKey = task?.key ?? null;
  useEffect(() => {
    if (!taskKey) return;
    void send({ type: "openSession", key: taskKey });
    return () => void send({ type: "closeSession", key: taskKey });
  }, [taskKey, send]);

  // The one place that moves focus for Work. As a drawer it takes focus, unless
  // focus is already inside it; when the drawer closes, focus returns to the
  // control that opened it. Docking or undocking an open pane moves nothing
  // except off what has just become inert.
  const drawerWasOpen = useRef(false);
  useEffect(() => {
    if (drawerOpen) {
      if (!panelRef.current?.contains(document.activeElement)) closeRef.current?.focus();
    } else if (drawerWasOpen.current && !panelOpen) {
      const opener = openerRef.current;
      (opener && opener.isConnected && !opener.closest("[inert]")
        ? opener
        : toggleRef.current
      )?.focus();
    }
    drawerWasOpen.current = drawerOpen;
  }, [drawerOpen, panelOpen]);

  // One connection state drives the strip, the footer and the composer.
  const transcript = taskKey ? state.transcripts[taskKey] : undefined;
  const phase = useSyncPhase(state, transcript);
  const strip = stripFor(state, phase, transcript);
  const catchingUp =
    phase === "dropped" &&
    state.connection.status === "connected" &&
    state.discovery.status !== "ready";
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
    >
      <Rail
        bots={state.bots}
        tasksByBot={state.tasksByBot}
        discovery={state.discovery}
        connection={state.connection}
        catchingUp={catchingUp}
        selection={selection}
        onePane={onePane}
        onOpen={() => setView("detail")}
        theme={theme}
        onTheme={onTheme}
        inert={drawerOpen}
      />
      <div className="main-pane" ref={mainRef}>
        <Conversation
          task={task}
          bot={bot}
          taskCount={selection.tasks.length}
          discovery={state.discovery}
          transcript={transcript}
          panelOpen={panelOpen}
          onTogglePanel={togglePanel}
          onOpenPanel={() => setPanel(true)}
          onBack={() => setView("list")}
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
