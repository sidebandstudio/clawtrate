import type { ClawtrateState, HostInfo } from "@clawtrate/core";
import { canWrite } from "./access.ts";
import { OpenTaskContext } from "./cards/index.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { ShortcutList } from "./Shortcuts.tsx";
import { isWorkTab, WorkPanel, type WorkTab } from "./WorkPanel.tsx";
import { revealStep, WorkLinksContext, type FileRequest, type WorkLinks } from "./work/links.tsx";

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

/** How long "Access granted" stays on the strip. */
export const GRANTED_FOR_MS = 4000;

export function Shell({
  state,
  info,
  theme,
  onTheme,
  bubbles,
  onBubbles,
  onUnreadCount,
  onOpenSettings,
  inert = false,
  onCaughtUp,
}: {
  state: ClawtrateState;
  info: HostInfo;
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
  bubbles: BubbleChoice;
  onBubbles: (choice: BubbleChoice) => void;
  onUnreadCount?: ((count: number) => void) | undefined;
  onOpenSettings: () => void;
  /** Set while Settings covers the shell. */
  inert?: boolean;
  /** Whether the open task has caught up since the latest connect: until then work is last seen. */
  onCaughtUp?: (caughtUp: boolean) => void;
}) {
  const send = useCommand();
  const interactive = canWrite(state.connection, info);

  // When access arrives, the strip says so for four seconds; the conversation announces it.
  const connectedNow = state.connection.status === "connected";
  const [tier, setTier] = useState(interactive);
  const [granted, setGranted] = useState(false);
  if (connectedNow && interactive !== tier) {
    setTier(interactive);
    if (interactive && state.connection.upgrade.status === "approved") setGranted(true);
  }
  useEffect(() => {
    if (!granted) return;
    // Focus that was in the access bar moves to the composer's field.
    if (accessHadFocus.current) document.querySelector<HTMLElement>(".composer-input")?.focus();
    const timer = setTimeout(() => setGranted(false), GRANTED_FOR_MS);
    return () => clearTimeout(timer);
  }, [granted]);
  const accessHadFocus = useRef(false);
  useEffect(() => {
    const onFocus = () => {
      accessHadFocus.current = !!document.activeElement?.closest(".access-bar");
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, []);

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

  // The chosen tab belongs to the pane: kept across tasks and bots, and across opening it.
  const [workTab, setWorkTabState] = useState<WorkTab>(() => {
    const stored = readPreference("workTab");
    return isWorkTab(stored) ? stored : "details";
  });
  const setWorkTab = useCallback((next: WorkTab) => {
    setWorkTabState(next);
    writePreference("workTab", next);
  }, []);
  // "Open file" on a step, the file the reader shows, and the way back after "Show in chat".
  const [fileRequest, setFileRequest] = useState<FileRequest | null>(null);
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);
  const [backTo, setBackTo] = useState<{ path: string; stepId: string } | null>(null);
  const [chatNote, setChatNote] = useState("");
  /** Set while "Show in chat" closes the drawer: focus goes to the step, not back to the opener. */
  const keepFocus = useRef(false);
  /** "Back to <file>" while a step offers it, for ⌘[ in the conversation. */
  const backLinkRef = useRef<(() => void) | null>(null);

  const [shortcuts, setShortcuts] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "/") {
        event.preventDefault();
        setShortcuts((open) => !open);
      } else if ((event.metaKey || event.ctrlKey) && event.key === "\\") {
        event.preventDefault();
        togglePanel();
      } else if (
        (event.metaKey || event.ctrlKey) &&
        event.key === "[" &&
        backLinkRef.current &&
        !panelRef.current?.contains(document.activeElement)
      ) {
        // ⌘[ in the conversation goes back to the file while "Back to <file>" is offered.
        event.preventDefault();
        backLinkRef.current();
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

  // Opening a task reads it on the gateway too (F-022), and so do new replies while it
  // is open and leaving it. The engine makes that read only while the connection
  // already writes, never asking for access. A task marked unread here while open is
  // left unread, and so is one another device marked unread while it was open here
  // (the gateway's explicit marker), until it is opened again.
  const keptRef = useRef(selection.keptUnread);
  const taskUnread = task?.unread === true;
  const marker = task?.unreadMarker ?? null;
  // Each listed task's explicit marker, as it was, for the read made on leaving it.
  const markersRef = useRef<Record<string, number | null>>({});
  useEffect(() => {
    keptRef.current = selection.keptUnread;
    markersRef.current = Object.fromEntries(
      Object.values(state.tasksByBot)
        .flat()
        .map((each) => [each.key, each.unreadMarker ?? null]),
    );
  });
  // A read the gateway refused, or that failed, leaves the task unread here too, as the gateway has it.
  const forgetRead = selection.forgetReadHere;
  const readTask = useCallback(
    (key: string, explicitToo: boolean) => {
      if (keptRef.current.has(key) || (!explicitToo && (markersRef.current[key] ?? null) !== null))
        return;
      void send({ type: "markTask", key, unread: false, opened: true }).catch(() =>
        forgetRead(key),
      );
    },
    [send, forgetRead],
  );
  // One effect, so opening a task makes one read however its row changes meanwhile: the
  // opening reads it once; later, a new reply while it is open reads it again; leaving does too.
  const openedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!taskKey || !connectedNow) return;
    if (openedKey.current !== taskKey) {
      openedKey.current = taskKey;
      readTask(taskKey, true);
    } else if (taskUnread && marker === null) readTask(taskKey, false);
  }, [taskKey, taskUnread, marker, connectedNow, readTask]);
  useEffect(() => {
    if (!taskKey) return;
    return () => {
      openedKey.current = null;
      readTask(taskKey, false);
    };
  }, [taskKey, readTask]);

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
    } else if (!panelOpen && panelWasOpen.current && keepFocus.current) {
      keepFocus.current = false;
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
  const navigatedTo = useRef<"list" | "detail" | "composer" | null>(null);
  /** Into a conversation: its heading, or its composer for a task just made (New task). */
  const openDetail = useCallback(
    (options?: { composer?: boolean }) => {
      if (onePane) navigatedTo.current = options?.composer ? "composer" : "detail";
      setView("detail");
    },
    [onePane],
  );
  const showList = useCallback(() => setView("list"), []);
  const backToList = useCallback(() => {
    navigatedTo.current = "list";
    setView("list");
  }, []);
  useEffect(() => {
    const target = navigatedTo.current;
    if (!target) return;
    navigatedTo.current = null;
    const composer = mainRef.current?.querySelector<HTMLElement>(".composer-input");
    if (target === "composer" && composer) {
      composer.focus();
    } else if (target === "detail" || target === "composer") {
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

  // The way between a step and its file (work-pane.md, section 10).
  const runs = transcript?.runs;
  const showInChat = useCallback(
    (stepId: string, from: { path: string }) => {
      const callId = stepId.startsWith("tool:") ? stepId.slice(5) : stepId;
      const reveal = () => {
        const found = revealStep(callId);
        setChatNote("");
        requestAnimationFrame(() =>
          setChatNote(
            found
              ? "Showing the step in the chat"
              : "The chat shows this step on its own once its run has finished.",
          ),
        );
        if (found) setBackTo({ path: from.path, stepId });
      };
      if (drawerOpen) {
        // As a drawer the pane closes so the step can be seen; it keeps its place.
        keepFocus.current = true;
        setPanel(false);
        requestAnimationFrame(() => requestAnimationFrame(reveal));
      } else reveal();
    },
    [drawerOpen, setPanel],
  );
  const goBackToFile = useCallback(() => {
    setPanel(true);
    setWorkTab("files");
  }, [setPanel, setWorkTab]);
  const backShown =
    backTo && !(panelOpen && workTab === "files" && openFilePath === backTo.path) ? backTo : null;
  useEffect(() => {
    backLinkRef.current = backShown ? goBackToFile : null;
  }, [backShown, goBackToFile]);
  const workLinks = useMemo<WorkLinks>(
    () => ({
      pathsOf: (callId) => {
        for (const run of runs ?? []) {
          const step = run.steps.find((each) => each.toolCallId === callId);
          if (step?.files)
            return { paths: step.files.paths, change: step.toolName?.toLowerCase() !== "read" };
        }
        return { paths: [], change: false };
      },
      openFile: (path, from) => {
        setFileRequest((previous) => ({
          path,
          stepId: from.stepId,
          view: from.change ? "changes" : "source",
          nonce: (previous?.nonce ?? 0) + 1,
        }));
        setWorkTab("files");
        setPanel(true);
      },
      back: backShown,
      goBack: goBackToFile,
    }),
    [runs, backShown, goBackToFile, setPanel, setWorkTab],
  );
  const phase = useSyncPhase(state, taskKey);
  // Connected is not caught up: until bots, tasks and the open task have
  // loaded again after a drop, what is on screen is last seen.
  const caughtUp = state.connection.status === "connected" && phase !== "dropped";
  useEffect(() => {
    onCaughtUp?.(caughtUp);
  }, [caughtUp, onCaughtUp]);
  // Access arriving reconnects with the new grant: "Access granted" is the
  // news then, unless something failed.
  const connectionStrip = stripFor(state, phase, taskKey);
  const strip =
    granted && connectionStrip?.tone !== "danger"
      ? {
          tone: "ok" as const,
          text: "Access granted",
          more: "you can send, stop and answer",
          action: null,
          countdown: false,
        }
      : connectionStrip;
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
        interactive={interactive}
        sidebar={state.sidebar}
        newTaskHint={info.kind === "desktop" ? "⌘T" : "⌥T"}
      />
      <div className="main-pane" ref={mainRef}>
        <OpenTaskContext.Provider value={selection.selectTask}>
          <WorkLinksContext.Provider value={workLinks}>
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
              interactive={interactive}
              connection={state.connection}
              info={info}
              granted={granted}
              online={state.connection.status === "connected"}
              caughtUp={caughtUp}
              toggleRef={toggleRef}
              inert={drawerOpen || inert}
            />
          </WorkLinksContext.Provider>
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
            transcript={transcript}
            tab={workTab}
            onTab={setWorkTab}
            online={state.connection.status === "connected"}
            connectedAt={state.connection.connectedAt}
            fileRequest={fileRequest}
            onShowInChat={showInChat}
            onFilePath={setOpenFilePath}
            drawer={drawerOpen}
            onClose={() => setPanel(false)}
            closeRef={closeRef}
            panelRef={panelRef}
          />
        )}
      </div>
      {shortcuts && <ShortcutList onClose={() => setShortcuts(false)} />}
      <p
        className="visually-hidden"
        role="status"
        aria-live="polite"
        data-testid="chat-link-announcer"
      >
        {chatNote}
      </p>
    </div>
  );
}
