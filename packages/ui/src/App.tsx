import type { ConnectionError, HostInfo } from "@clawtrate/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useBridge, useClawtrateState } from "./bridge.tsx";
import { ConnectScreen } from "./ConnectScreen.tsx";
import { readPreference, useBubbles, useTheme } from "./preferences.ts";
import { screenFor, setupHolds } from "./screen.ts";
import { restartWaitingMessages } from "./update-restart.ts";
import { Settings, type SettingsSection } from "./Settings.tsx";
import { useDesktopUpdateSnapshot } from "./update-reading.ts";
import { Shell } from "./Shell.tsx";
import { ThisComputerStage } from "./this-computer.ts";
import { OpenOpenClawUpdates } from "./bots/UpdateOpenClaw.tsx";
import { Brand, TitleBar, UpdateAnnouncer, UpdateButton } from "./TitleBar.tsx";

/**
 * Touch sizes when the primary pointer is coarse, and reduced motion when the
 * viewer asked for it in the app (`?motion=reduce` or the stored preference).
 * Both are set on the root, beside `data-theme`.
 */
function useInputAndMotion() {
  useEffect(() => {
    const root = document.documentElement;
    const coarse = globalThis.matchMedia?.("(pointer: coarse)");
    const applyInput = () => {
      if (coarse?.matches) root.dataset.input = "touch";
      else delete root.dataset.input;
    };
    applyInput();
    coarse?.addEventListener("change", applyInput);
    const fromUrl = new URLSearchParams(globalThis.location?.search ?? "").get("motion");
    if ((fromUrl ?? readPreference("motion")) === "reduce") root.dataset.motion = "reduce";
    return () => coarse?.removeEventListener("change", applyInput);
  }, []);
}

/** The first control on the screen, for when focus has nowhere else to go. */
const FIRST_CONTROL = ".app :is(input, button, [tabindex='0']):not([disabled], [tabindex='-1'])";

/** The first of those that is shown and not behind a dialog: the title bar's are hidden on a phone. */
function firstControl(): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>(FIRST_CONTROL)].find(
    (el) => el.getClientRects().length > 0 && !el.closest("[inert]"),
  );
}

/**
 * The connection screen is for connecting and pairing. Once a gateway has
 * delivered anything, the shell stays mounted through reconnects, keeping
 * scroll position and open details, with a status strip on top.
 */
export function App({
  info,
  onUnreadCount,
}: {
  info: HostInfo;
  /** The host's dock or taskbar badge: called with the number of unread tasks. */
  onUnreadCount?: ((count: number) => void) | undefined;
}) {
  const state = useClawtrateState();
  const { desktopUpdates } = useBridge();
  const updated = useDesktopUpdateSnapshot(desktopUpdates);
  const [openSection, setOpenSection] = useState<SettingsSection | null>(null);
  const [atOpenClaw, setAtOpenClaw] = useState(false);
  useInputAndMotion();
  // The theme applies on every screen; the gateway menu in the shell changes it.
  const [theme, setTheme] = useTheme();
  const [bubbles, setBubbles] = useBubbles();
  // Settings opens over either screen, with Cmd/Ctrl+, or from the gateway menu.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsOpener = useRef<HTMLElement | null>(null);
  const openSettings = useCallback((section?: SettingsSection, openClaw = false) => {
    setOpenSection(section ?? null);
    setAtOpenClaw(openClaw);
    const active = document.activeElement as HTMLElement | null;
    settingsOpener.current = active && active !== document.body ? active : null;
    setSettingsOpen(true);
  }, []);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    const opener = settingsOpener.current;
    requestAnimationFrame(() => {
      if (opener?.isConnected && opener.getClientRects().length && !opener.closest("[inert]"))
        opener.focus();
      // The control that opened it is gone (another gateway was chosen): the
      // first control on the screen now showing.
      else {
        const gateway =
          opener?.classList.contains("update-button") &&
          [...document.querySelectorAll<HTMLElement>(".gateway-pill")].find(
            (el) => el.getClientRects().length,
          );
        (gateway || firstControl())?.focus();
      }
    });
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key === ",") {
        event.preventDefault();
        openSettings();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openSettings]);
  // A protocol mismatch stays on screen while Retry repeats the handshake, until
  // a handshake succeeds or the user chooses another gateway.
  const [mismatch, setMismatch] = useState<ConnectionError | null>(null);
  const { status, error } = state.connection;
  if (error?.code === "PROTOCOL_MISMATCH" && mismatch !== error) setMismatch(error);
  else if (
    mismatch &&
    (status === "connected" ||
      status === "idle" ||
      status === "pairing" ||
      status === "disconnected")
  ) {
    setMismatch(null);
  }
  // A look on this computer staged from a refused reconnect (`this-computer.ts`): the connection
  // screen shows it, bots or not, until it is let go or its Connect connected.
  const [staged, setStaged] = useState(false);
  if (staged && state.setup?.phase === "done" && status === "connected") setStaged(false);
  const screen = mismatch || setupHolds(info, state.setup) || staged ? "connect" : screenFor(state);
  // When one screen replaces another and takes focus with it, focus the first
  // control of the new one. Not on launch: nothing had focus to lose.
  const shown = useRef(screen);
  useEffect(() => {
    if (shown.current === screen) return;
    shown.current = screen;
    if (document.activeElement && document.activeElement !== document.body) return;
    firstControl()?.focus();
  }, [screen]);
  // One flag for the whole window: while the connection is anything but
  // connected, nothing that stands for the gateway's work moves; it is last
  // seen. A load still being tried, or one that failed, is not a lost
  // connection (#592).
  const lost = status !== "connected";
  const waitingMessages = restartWaitingMessages(state);
  const openUpdates = () => openSettings("updates");
  // Settings' Check-ins lead to a bot's routines, which the shell shows (#604).
  const routinesLink = useRef<((botId: string) => void) | null>(null);
  const openRoutines = useCallback((botId: string) => {
    setSettingsOpen(false);
    routinesLink.current?.(botId);
  }, []);
  // A newer OpenClaw's line, in a bot's settings or near the Model menu, links here (#590).
  const openOpenClawUpdates = useCallback(() => openSettings("updates", true), [openSettings]);
  return (
    <ThisComputerStage.Provider value={setStaged}>
      <div className="app" data-connection={lost ? "lost" : undefined}>
        {screen === "shell" && (
          <TitleBar
            reading={updated}
            waitingMessages={waitingMessages}
            onOpenUpdates={openUpdates}
            inert={settingsOpen}
          />
        )}
        <UpdateAnnouncer reading={updated} />
        {settingsOpen && (
          <Settings
            connection={state.connection}
            info={info}
            accounts={state.accounts}
            checkIns={state.checkIns}
            bots={state.bots}
            waitingMessages={waitingMessages}
            updateReading={updated}
            initialSection={openSection}
            atOpenClaw={atOpenClaw}
            onClose={closeSettings}
            onOpenRoutines={screen === "shell" ? openRoutines : null}
          />
        )}
        {screen === "shell" ? (
          <OpenOpenClawUpdates.Provider value={openOpenClawUpdates}>
            <Shell
              state={state}
              info={info}
              theme={theme}
              onTheme={setTheme}
              bubbles={bubbles}
              onBubbles={setBubbles}
              onUnreadCount={onUnreadCount}
              railTop={
                <>
                  <Brand reading={updated} />
                  <UpdateButton
                    reading={updated}
                    waitingMessages={waitingMessages}
                    onOpenUpdates={openUpdates}
                    round
                  />
                </>
              }
              onOpenSettings={openSettings}
              inert={settingsOpen}
              routinesLinkRef={routinesLink}
            />
          </OpenOpenClawUpdates.Provider>
        ) : (
          <ConnectScreen
            connection={state.connection}
            discovery={state.discovery}
            info={info}
            setup={state.setup}
            mismatch={mismatch}
            inert={settingsOpen}
            staged={staged}
            onStage={setStaged}
          />
        )}
      </div>
    </ThisComputerStage.Provider>
  );
}
