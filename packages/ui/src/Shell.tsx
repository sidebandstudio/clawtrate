import {
  isActive,
  listedTasks as listedTasksOf,
  mapSessionRow,
  NOT_OPEN_IN_VIEW,
  tasksWithFilePreviews,
  type BridgeCommand,
  type ClawtrateState,
  type HostInfo,
  type Transcript,
} from "@clawtrate/core";
import { canWrite } from "./access.ts";
import { OpenTaskContext } from "./cards/index.ts";
import { cardDomId } from "./cards/placement.ts";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useBridge, useCommand } from "./bridge.tsx";
import { Conversation } from "./Conversation.tsx";
import { DOCK_FROM, ONE_PANE_BELOW, useElementWidth } from "./layout.ts";
import {
  readPreference,
  writePreference,
  type BubbleChoice,
  type ThemeChoice,
} from "./preferences.ts";
import { Rail } from "./Rail.tsx";
import { summarize, useSelection } from "./selection.ts";
import { useShowCommands } from "./preferences.ts";
import { unreadCount } from "./unread.ts";
import { liveFlags, refreshFailed, StatusStrip, stripFor, useSyncPhase } from "./StatusStrip.tsx";
import { ShortcutList } from "./Shortcuts.tsx";
import { isWorkTab, WorkPanel, type WorkTab } from "./WorkPanel.tsx";
import { setUsageOpener } from "./usage/navigation.ts";
import { NewBot } from "./bots/NewBot.tsx";
import { FullControlOffer } from "./FullControl.tsx";
import { BotGuidesOffer } from "./BotGuides.tsx";
import { DeleteBot } from "./bots/DeleteBot.tsx";
import "./bots/bots.css";
import { RoutinesView, ROUTINES_HOME, type RoutinesNav } from "./routines/RoutinesView.tsx";
import { revealStep, WorkLinksContext, type FileRequest, type WorkLinks } from "./work/links.tsx";
import { SearchPalette, type SearchTarget } from "./search/SearchPalette.tsx";
import { PlacementSavesProvider } from "./machines/RunsOn.tsx";
import type { SettingsSection } from "./Settings.tsx";

/**
 * Command for Try again on an open task: carries the failure text this view is retrying so the
 * host ignores a stale click once the history has recovered or moved to another failure.
 */
export function reloadCommand(
  key: string,
  transcript: Transcript | undefined,
): Extract<BridgeCommand, { type: "reloadSession" }> {
  return transcript?.status === "error" && transcript.error !== null
    ? { type: "reloadSession", key, failed: transcript.error }
    : { type: "reloadSession", key };
}

/** True on a Mac, where ⌘ is the command key; elsewhere Ctrl stands for it. */
const isMac = () => /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? "");

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
  railTop,
  onOpenSettings,
  inert = false,
}: {
  state: ClawtrateState;
  info: HostInfo;
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
  bubbles: BubbleChoice;
  onBubbles: (choice: BubbleChoice) => void;
  onUnreadCount?: ((count: number) => void) | undefined;
  /** The brand and the update button the one-pane layout shows at the top of the rail. */
  railTop?: ReactNode;
  onOpenSettings: (section?: SettingsSection) => void;
  /** Set while Settings covers the shell. */
  inert?: boolean;
}) {
  const send = useCommand();
  const interactive = canWrite(state.connection, info);

  // The one-time offer of full control (setup-effortless.md §6): it opens once per gateway in
  // this window while it is unanswered, stays open while its request runs, and once closed
  // lives on in Settings only.
  const [offerFor, setOfferFor] = useState<string | null>(null);
  const [offerOpen, setOfferOpen] = useState(false);
  const offerUrl = state.connection.gatewayUrl;
  if (
    !inert &&
    !info.readOnly &&
    state.connection.status === "connected" &&
    state.connection.fullOffer === "offer" &&
    // Bound to the gateway's identity, so shown only once it is known (`offerBinding`).
    state.connection.gatewayId !== null &&
    offerUrl !== offerFor
  ) {
    setOfferFor(offerUrl);
    setOfferOpen(true);
  }

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

  const [routines, setRoutines] = useState<RoutinesNav | null>(null);
  const routinesOpen = routines !== null;
  const conversationVisible = routines === null;
  const selection = useSelection(state, interactive, conversationVisible);
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
  // The Routines view takes the main pane, Work included: no drawer, scrim or inert rail behind it.
  const drawerOpen = panelOpen && overlay && !routines;
  // While the offer of full control is open, its dialog keeps the keyboard, not the drawer behind.
  const drawerKeys = drawerOpen && !offerOpen;

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
  // "Raise budget" above the composer opens the bot's Usage page in the Settings tab.
  useEffect(
    () =>
      setUsageOpener(() => {
        setPanel(true);
        setWorkTab("settings");
      }),
    [setPanel, setWorkTab],
  );
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
  // The search palette (search.md): ⌘K or Ctrl+K anywhere, unless another dialog is open.
  const [searchOpen, setSearchOpen] = useState(false);
  const searchOpener = useRef<HTMLElement | null>(null);
  const openPalette = useCallback(() => {
    const active = document.activeElement as HTMLElement | null;
    searchOpener.current = canFocus(active) ? active : null;
    setSearchOpen(true);
  }, []);
  const closePalette = useCallback((refocus: boolean) => {
    setSearchOpen(false);
    const opener = searchOpener.current;
    searchOpener.current = null;
    if (refocus)
      requestAnimationFrame(() => {
        if (canFocus(opener)) opener.focus();
      });
  }, []);
  /** A message opened from search: scrolled into view and ringed once its conversation shows. */
  const [reveal, setReveal] = useState<{ key: string; messageId: string; said: string } | null>(
    null,
  );
  // New bot, from the "+" menu and ⌘N, where the connection may write (bots.md section 3).
  const [newBot, setNewBot] = useState(false);
  // Delete bot…: the bot as it was when chosen, so the result stays after it leaves the rail.
  const [deleting, setDeleting] = useState<{ id: string; name: string; isDefault: boolean } | null>(
    null,
  );
  const deletingOpen = deleting !== null;
  const openNewBot = useCallback(() => setNewBot(true), []);
  const mac = isMac();
  useEffect(() => {
    if (inert || newBot || shortcuts || searchOpen || offerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        (mac ? event.metaKey : event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        openPalette();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inert, newBot, shortcuts, searchOpen, offerOpen, mac, openPalette]);
  useEffect(() => {
    // The full-control offer keeps ⌘N, as it keeps ⌘K: nothing opens over it.
    if (!interactive || inert || offerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "n"
      ) {
        event.preventDefault();
        setNewBot(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [interactive, inert, offerOpen]);
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
      } else if (event.key === "Escape" && drawerKeys && !deletingOpen) {
        setPanel(false);
      } else if (event.key === "Tab" && drawerKeys && !deletingOpen && panelRef.current) {
        // (The delete dialog, opened from the drawer, keeps Tab and Escape to itself.)
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
  }, [togglePanel, drawerKeys, setPanel, deletingOpen]);

  const [commandsShown] = useShowCommands();
  const { tasksByBot, transcripts } = state;
  // The rail's preview of a task whose history ends with a bot's message that is only files reads
  // as their names (F-115).
  const listedTasks = useMemo(
    () => tasksWithFilePreviews(tasksByBot, transcripts),
    [tasksByBot, transcripts],
  );

  // The dock or taskbar badge counts unread tasks, other than the one on screen.
  // Only tasks of the bots the sidebar lists (F-562): a count always has something to open.
  const unread = unreadCount(
    listedTasksOf(state, selection.kept),
    selection.unreadSeen,
    conversationVisible ? (task?.key ?? null) : null,
  );
  useEffect(() => {
    onUnreadCount?.(unread);
  }, [unread, onUnreadCount]);
  useEffect(() => () => onUnreadCount?.(0), [onUnreadCount]);

  // Keep exactly the selected task's transcript open on the host. A refused open
  // (every task slot taken, say) leaves this view without the task, and says why.
  // Only the latest open of a task decides its refusal: a late answer to an earlier
  // one says nothing about now.
  const taskKey = task?.key ?? null;
  const [refusals, setRefusals] = useState<ReadonlyMap<string, string>>(() => new Map());
  const opens = useRef({ count: 0, latest: new Map<string, number>() });
  const setRefusal = useCallback((key: string, error: string | null) => {
    setRefusals((now) => {
      if ((now.get(key) ?? null) === error) return now;
      const next = new Map(now);
      if (error === null) next.delete(key);
      else next.set(key, error);
      return next;
    });
  }, []);
  const open = useCallback(
    (key: string): Promise<void> => {
      const asked = (opens.current.count += 1);
      opens.current.latest.set(key, asked);
      const settle = (error: string | null) => {
        if (opens.current.latest.get(key) !== asked) return;
        // Settled: any answer still to come is to an earlier open, and is ignored without it.
        opens.current.latest.delete(key);
        setRefusal(key, error);
      };
      return send({ type: "openSession", key }).then(
        () => settle(null),
        (error: unknown) => settle(error instanceof Error ? error.message : String(error)),
      );
    },
    [send, setRefusal],
  );
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (!taskKey) return;
    shown.current = taskKey;
    void open(taskKey);
    return () => {
      shown.current = null;
      void send({ type: "closeSession", key: taskKey });
    };
  }, [taskKey, send, open]);
  // The web bridge opens this view's tasks again after it reconnects to the host. One the host
  // refuses then is no longer held here, and the task shown says why, as for a refused open,
  // unless an open of it the Shell asked for since is still to answer.
  const bridge = useBridge();
  useEffect(
    () =>
      bridge.onReopenRefused?.((key, error) => {
        if (shown.current === key && !opens.current.latest.has(key)) setRefusal(key, error);
      }),
    [bridge, setRefusal],
  );

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
    // Covered by Routines, it is not open: coming back opens it again.
    if (!conversationVisible) openedKey.current = null;
    if (!taskKey || !connectedNow || !conversationVisible) return;
    if (openedKey.current !== taskKey) {
      openedKey.current = taskKey;
      readTask(taskKey, true);
    } else if (taskUnread && marker === null) readTask(taskKey, false);
  }, [taskKey, taskUnread, marker, connectedNow, readTask, conversationVisible]);
  const visibleRef = useRef(conversationVisible);
  useEffect(() => {
    visibleRef.current = conversationVisible;
  }, [conversationVisible]);
  useEffect(() => {
    if (!taskKey) return;
    return () => {
      openedKey.current = null;
      if (visibleRef.current) readTask(taskKey, false);
    };
  }, [taskKey, readTask]);

  // The one place that moves focus for Work. As a drawer it takes focus, unless
  // focus is already inside it. When the pane closes, focus that was inside it
  // (a drawer's, or a docked pane's that went with it) returns to the control
  // that opened it, or else to the Work toggle. Docking or undocking an open
  // pane moves nothing except off what has just become inert.
  const drawerWasOpen = useRef(false);
  const panelWasOpen = useRef(panelOpen);
  const focusOpener = () => {
    const opener = openerRef.current;
    (canFocus(opener) ? opener : toggleRef.current)?.focus();
  };
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
        focusOpener();
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
      setRoutines(null);
      setView("detail");
    },
    [onePane],
  );
  const showList = useCallback(() => setView("list"), []);

  // Entering Routines closes Work (automation.md section 1); leaving returns focus to what opened it.
  const routinesOpener = useRef<HTMLElement | null>(null);
  const openRoutines = (nav: RoutinesNav) => {
    if (!routines) {
      const active = document.activeElement as HTMLElement | null;
      routinesOpener.current = canFocus(active) ? active : null;
    }
    if (panelOpen) {
      keepFocus.current = true;
      setPanel(false);
    }
    setRoutines(nav);
    setView("detail");
  };
  const closeRoutines = () => {
    setRoutines(null);
    if (onePane) setView("list");
    const opener = routinesOpener.current;
    routinesOpener.current = null;
    requestAnimationFrame(() => {
      if (canFocus(opener)) opener.focus();
    });
  };
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
    // Re-shown from under Routines, the conversation is the destination even though
    // view and taskKey did not change.
  }, [view, taskKey, routinesOpen]);

  // One connection state drives the strip, the footer and the composer.
  const transcript = taskKey ? state.transcripts[taskKey] : undefined;

  const openFromSearch = useCallback(
    (target: SearchTarget) => {
      if (target.kind === "setting") {
        closePalette(false);
        onOpenSettings(target.section);
        return;
      }
      if (target.kind === "routine") {
        closePalette(false);
        // A routine past those the app keeps is found by reading its bot's routines.
        const kept = state.routines.routines.some((each) => each.id === target.id);
        openRoutines({ ...ROUTINES_HOME, bot: kept ? null : target.botId, routine: target.id });
        return;
      }
      if (target.kind === "bot") selection.selectBot(target.botId);
      else selection.selectTask(target.botId, target.key);
      if (target.kind === "message") {
        setReveal({ key: target.key, messageId: target.messageId, said: target.said });
        // As a drawer Work closes, so the message can be seen and take focus.
        if (drawerOpen) {
          keepFocus.current = true;
          setPanel(false);
        }
      }
      openDetail();
      closePalette(target.kind !== "message" && !onePane);
    },
    // openRoutines is redefined each render and reads only refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      closePalette,
      onOpenSettings,
      selection,
      openDetail,
      onePane,
      drawerOpen,
      setPanel,
      state.routines,
    ],
  );
  const revealReady = reveal !== null && reveal.key === taskKey && transcript?.status === "ready";
  useEffect(() => {
    if (!revealReady || !reveal) return;
    let frames = 0;
    let raf = 0;
    const find = () => {
      const unit = mainRef.current?.querySelector<HTMLElement>(
        `.transcript [data-message="${CSS.escape(reveal.messageId)}"]`,
      );
      if (!unit) {
        if ((frames += 1) < 60) raf = requestAnimationFrame(find);
        else setReveal(null);
        return;
      }
      setReveal(null);
      unit.scrollIntoView({ block: "nearest" });
      const turn = unit.closest<HTMLElement>(".turn") ?? unit;
      if (!turn.hasAttribute("tabindex")) turn.tabIndex = -1;
      // The ring on its bubbles marks it; the turn takes focus for the screen reader.
      turn.dataset.searchFocus = "";
      turn.focus({ preventScroll: true });
      const bubbles = [...unit.querySelectorAll<HTMLElement>(".bubble")];
      for (const bubble of bubbles) {
        bubble.classList.remove("search-hit");
        void bubble.offsetWidth;
        bubble.classList.add("search-hit");
        bubble.addEventListener("animationend", () => bubble.classList.remove("search-hit"), {
          once: true,
        });
      }
      // With reduced motion the ring stays until the next scroll or key.
      const clear = () => {
        for (const bubble of bubbles) bubble.classList.remove("search-hit");
        window.removeEventListener("keydown", clear, true);
        mainRef.current?.querySelector(".transcript")?.removeEventListener("wheel", clear);
      };
      window.addEventListener("keydown", clear, true);
      mainRef.current?.querySelector(".transcript")?.addEventListener("wheel", clear);
      setChatNote("");
      requestAnimationFrame(() => setChatNote(reveal.said));
    };
    raf = requestAnimationFrame(find);
    return () => cancelAnimationFrame(raf);
  }, [revealReady, reveal]);

  // The way between a step and its file (work-pane.md, section 10).
  const runs = transcript?.runs;
  // Without commands shown, a running turn's steps join the chat when it ends (conversation.md, 7.11).
  const notInChat = useCallback(
    (callId: string) =>
      !commandsShown &&
      runs?.some((run) => isActive(run.state) && run.steps.some((s) => s.toolCallId === callId))
        ? "This step shows in the chat when the turn ends."
        : "This step isn't in the chat: it is not loaded here, or not kept.",
    [commandsShown, runs],
  );
  const showInChat = useCallback(
    (stepId: string, from: { path: string }) => {
      const callId = stepId.startsWith("tool:") ? stepId.slice(5) : stepId;
      const reveal = () => {
        const found = taskKey !== null && revealStep(taskKey, callId);
        setChatNote("");
        requestAnimationFrame(() =>
          setChatNote(found ? "Showing the step in the chat" : notInChat(callId)),
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
    [drawerOpen, setPanel, taskKey, notInChat],
  );
  // From the Computer tab: a step shown in the chat, and the question card (work-pane.md, section 18).
  const showStep = useCallback(
    (stepId: string) => {
      const callId = stepId.startsWith("tool:") ? stepId.slice(5) : stepId;
      const fromDrawer = drawerOpen;
      const reveal = () => {
        const found = taskKey !== null && revealStep(taskKey, callId);
        // Nothing in the chat to focus: back to what opened the drawer, or the Work toggle.
        if (!found && fromDrawer) focusOpener();
        setChatNote("");
        requestAnimationFrame(() =>
          setChatNote(found ? "Showing the step in the chat" : notInChat(callId)),
        );
      };
      if (drawerOpen) {
        keepFocus.current = true;
        setPanel(false);
        requestAnimationFrame(() => requestAnimationFrame(reveal));
      } else reveal();
    },
    [drawerOpen, setPanel, taskKey, notInChat],
  );
  /** Bring a question's card into view and focus it: that question's own, when it is named. */
  const showQuestion = useCallback(
    (questionId?: string) => {
      const fromDrawer = drawerOpen;
      const reveal = () => {
        const cards = document.querySelectorAll<HTMLElement>(
          '.transcript [data-testid="question-card"]',
        );
        const card = questionId
          ? document.querySelector<HTMLElement>(
              `.transcript #${cardDomId({ kind: "question", id: questionId })}`,
            )
          : cards[cards.length - 1];
        if (!card) {
          if (fromDrawer) focusOpener();
          return;
        }
        card.scrollIntoView({ block: "center" });
        (card.querySelector<HTMLElement>("button, input") ?? card).focus({ preventScroll: true });
      };
      if (drawerOpen) {
        keepFocus.current = true;
        setPanel(false);
        requestAnimationFrame(() => requestAnimationFrame(reveal));
      } else requestAnimationFrame(reveal);
    },
    [drawerOpen, setPanel],
  );
  const showComputer = useCallback(() => {
    setPanel(true);
    setWorkTab("computer");
    requestAnimationFrame(() => document.getElementById("work-tab-computer")?.focus());
  }, [setPanel, setWorkTab]);
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
  // Connected is not caught up: until the open task has loaded again after a
  // drop, its live work is last seen. That says nothing about the connection.
  const { connected: online, current } = liveFlags(state, phase, taskKey);
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
  // Reading again keeps every hold: closing and opening would not read while another view holds
  // the task. A view the host doesn't count as holding it (its open was refused, or a reopen
  // after a reconnect was) is told so, and opens the task instead, unless it has left the task
  // by then: its close is sent, so an open would hold the task with nothing to let it go.
  const transcriptRef = useRef(transcript);
  const reloading = useRef<{
    key: string;
    snapshot: typeof transcript;
    inFlight: boolean;
  } | null>(null);
  useEffect(() => {
    transcriptRef.current = transcript;
    const active = reloading.current;
    if (!active) return;
    if (active.key !== taskKey || (!active.inFlight && transcript !== active.snapshot))
      reloading.current = null;
  }, [taskKey, transcript]);
  const reload = useCallback(() => {
    if (!taskKey) return;
    const key = taskKey;
    const snapshot = transcriptRef.current;
    // A second Try again while one is in flight, or before the host's updated snapshot arrives,
    // is ignored: a second reloadSession for a held task can queue a second read.
    if (
      reloading.current?.key === key &&
      (reloading.current.inFlight || reloading.current.snapshot === snapshot)
    )
      return;
    const attempt = { key, snapshot, inFlight: true };
    reloading.current = attempt;
    let keepUntilSnapshot = false;
    send(reloadCommand(key, snapshot))
      .then(
        () => {
          if (snapshot !== undefined && transcriptRef.current === snapshot)
            keepUntilSnapshot = true;
        },
        (error: unknown) => {
          // The desktop's IPC puts its own words before the host's.
          if (
            shown.current === key &&
            error instanceof Error &&
            error.message.endsWith(NOT_OPEN_IN_VIEW)
          )
            // The guard stays set until this open has answered, as Try again stays shown till then.
            return open(key);
        },
      )
      .finally(() => {
        attempt.inFlight = false;
        if (
          reloading.current === attempt &&
          (!keepUntilSnapshot || transcriptRef.current !== snapshot)
        )
          reloading.current = null;
      });
  }, [taskKey, open, send]);

  return (
    <PlacementSavesProvider connection={state.connection}>
      <div
        className="shell"
        ref={shellRef}
        data-panel={panelOpen && !routines ? "open" : "closed"}
        data-view={view}
        inert={inert}
      >
        <Rail
          bots={selection.listed}
          tasksByBot={listedTasks}
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
          top={railTop}
          notice={
            interactive && !info.readOnly ? (
              <BotGuidesOffer onReview={() => onOpenSettings("conversation")} />
            ) : null
          }
          onOpenSettings={onOpenSettings}
          settingsKeys={mac ? "⌘," : "Ctrl+,"}
          onNewBot={interactive ? openNewBot : null}
          routines={state.routines.routines}
          showRoutineRuns={state.showOtherToolSessions === true}
          routinesOpen={routinesOpen}
          onOpenRoutines={() => openRoutines(ROUTINES_HOME)}
          onOpenRoutineRun={(id, runAt) =>
            openRoutines({ ...ROUTINES_HOME, routine: id, run: runAt === null ? null : { runAt } })
          }
          onOpenPalette={openPalette}
          paletteKeys={mac ? "⌘K" : "Ctrl+K"}
          inert={drawerOpen || inert || searchOpen}
          interactive={interactive}
          sidebar={state.sidebar}
          newTaskHint={info.kind === "desktop" ? "⌘T" : "⌥T"}
        />
        <div className="main-pane" ref={mainRef}>
          {routines ? (
            <RoutinesView
              state={state}
              info={info}
              nav={routines}
              onNav={setRoutines}
              onClose={closeRoutines}
              onOpenTask={(botId, key) => {
                selection.selectTask(botId, key, mapSessionRow({ key, agentId: botId }));
                openDetail();
              }}
              narrow={onePane || (mainWidth !== null && mainWidth < 520)}
              phone={onePane}
            />
          ) : (
            <OpenTaskContext.Provider value={selection.selectTask}>
              <WorkLinksContext.Provider value={workLinks}>
                <Conversation
                  task={task}
                  bot={bot}
                  taskCount={selection.tasks.length}
                  discovery={state.discovery}
                  transcript={transcript}
                  openError={taskKey ? (refusals.get(taskKey) ?? null) : null}
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
                  online={online}
                  current={current}
                  toggleRef={toggleRef}
                  inert={drawerOpen || inert}
                  onShowComputer={showComputer}
                />
              </WorkLinksContext.Provider>
            </OpenTaskContext.Provider>
          )}
          <button
            type="button"
            className="drawer-scrim"
            aria-label="Close work panel"
            tabIndex={-1}
            onClick={() => setPanel(false)}
          />
          {panelOpen && !routines && (
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
              computer={state.computer}
              connection={state.connection}
              interactive={interactive}
              onShowStep={showStep}
              onShowQuestion={showQuestion}
              onRequestAccess={
                info.readOnly || state.connection.fullPairing
                  ? null
                  : () => void send({ type: "requestAccess" }).catch(() => {})
              }
              onOpenMachines={() => onOpenSettings("machines")}
              onDeleteBot={(each) =>
                setDeleting({ id: each.id, name: each.name, isDefault: each.isDefault })
              }
              drawer={drawerOpen}
              onClose={() => setPanel(false)}
              closeRef={closeRef}
              panelRef={panelRef}
              accounts={state.accounts}
              bots={state.bots}
              tasks={bot ? (state.tasksByBot[bot.id] ?? []) : []}
              transcripts={state.transcripts}
              info={info}
            />
          )}
        </div>
        {offerOpen && (
          <FullControlOffer
            // Each gateway's offer is its own: a switch shows that gateway's choices afresh.
            key={offerFor ?? ""}
            connection={state.connection}
            onClose={() => setOfferOpen(false)}
          />
        )}
        {shortcuts && <ShortcutList onClose={() => setShortcuts(false)} />}
        {searchOpen && (
          <SearchPalette
            state={state}
            kept={selection.kept}
            mac={mac}
            onOpen={openFromSearch}
            onClose={() => closePalette(true)}
          />
        )}
        {newBot && (
          <NewBot
            accounts={state.accounts}
            bots={state.bots}
            connection={state.connection}
            info={info}
            onClose={() => setNewBot(false)}
            onCreated={(id) => {
              setNewBot(false);
              selection.selectBot(id);
              openDetail();
              requestAnimationFrame(() =>
                document.querySelector<HTMLElement>(".composer-input")?.focus(),
              );
            }}
          />
        )}
        {deleting && (
          <DeleteBot
            bot={deleting}
            connection={state.connection}
            info={info}
            onClose={(deleted) => {
              setDeleting(null);
              // The rail already follows the gateway's list; the app lands on the Main Bot's latest
              // task, or the Main Bot alone when it has none. While the gateway's own bot is out of
              // view (F-562), on the first other bot the rail lists, or on it once it is the only one.
              const kept = selection.listed.filter((each) => each.id !== deleting.id);
              const main =
                kept.find((each) => each.isDefault) ??
                kept[0] ??
                state.bots.find((each) => each.isDefault);
              if (deleted && main) {
                // The Work drawer closes first, so the conversation behind it can take focus.
                if (drawerOpen) setPanel(false);
                const latest = summarize(state.tasksByBot[main.id] ?? [], {}, null).latest;
                if (latest) selection.selectTask(main.id, latest.key);
                else selection.selectBot(main.id);
                // The composer, or, for a Main Bot with no task to write in, the page's heading.
                requestAnimationFrame(() =>
                  (
                    document.querySelector<HTMLElement>(".composer-input") ??
                    document.querySelector<HTMLElement>(".conversation h1")
                  )?.focus(),
                );
              }
            }}
          />
        )}
        <p
          className="visually-hidden"
          role="status"
          aria-live="polite"
          data-testid="chat-link-announcer"
        >
          {chatNote}
        </p>
      </div>
    </PlacementSavesProvider>
  );
}
