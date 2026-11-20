import type { ConnectionError, HostInfo } from "@clawtrate/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useClawtrateState } from "./bridge.tsx";
import { ConnectScreen } from "./ConnectScreen.tsx";
import { readPreference, useBubbles, useTheme } from "./preferences.ts";
import { screenFor } from "./screen.ts";
import { Settings } from "./Settings.tsx";
import { Shell } from "./Shell.tsx";

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
  useInputAndMotion();
  // The theme applies on every screen; the gateway menu in the shell changes it.
  const [theme, setTheme] = useTheme();
  const [bubbles, setBubbles] = useBubbles();
  // Settings opens over either screen, with Cmd/Ctrl+, or from the gateway menu.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Activity's "Show in chat" (controls.md section 9): the task and call to bring into view.
  const [reveal, setReveal] = useState<{
    botId: string;
    key: string;
    callId: string;
    runId: string;
    nonce: number;
  } | null>(null);
  const settingsOpener = useRef<HTMLElement | null>(null);
  const openSettings = useCallback(() => {
    const active = document.activeElement as HTMLElement | null;
    settingsOpener.current = active && active !== document.body ? active : null;
    setSettingsOpen(true);
  }, []);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    const opener = settingsOpener.current;
    requestAnimationFrame(() => {
      if (opener?.isConnected && !opener.closest("[inert]")) opener.focus();
      // The control that opened it is gone (another gateway was chosen): the
      // first control on the screen now showing.
      else document.querySelector<HTMLElement>(FIRST_CONTROL)?.focus();
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
  else if (mismatch && (status === "connected" || status === "idle" || status === "pairing")) {
    setMismatch(null);
  }
  const screen = mismatch ? "connect" : screenFor(state);
  // When one screen replaces another and takes focus with it, focus the first
  // control of the new one. Not on launch: nothing had focus to lose.
  const shown = useRef(screen);
  useEffect(() => {
    if (shown.current === screen) return;
    shown.current = screen;
    if (document.activeElement && document.activeElement !== document.body) return;
    document.querySelector<HTMLElement>(FIRST_CONTROL)?.focus();
  }, [screen]);
  // One flag for the whole window: while the connection is anything but
  // connected, and after a reconnect until the open task has caught up,
  // nothing that stands for the gateway's work moves; it is last seen.
  const [caughtUp, setCaughtUp] = useState(true);
  const lost = status !== "connected" || !caughtUp;
  return (
    <div className="app" data-connection={lost ? "lost" : undefined}>
      {settingsOpen && (
        <Settings
          connection={state.connection}
          info={info}
          accounts={state.accounts}
          bots={state.bots}
          tasksByBot={state.tasksByBot}
          onShowInChat={(target) =>
            setReveal((previous) => ({ ...target, nonce: (previous?.nonce ?? 0) + 1 }))
          }
          onClose={closeSettings}
        />
      )}
      {screen === "shell" ? (
        <Shell
          state={state}
          info={info}
          theme={theme}
          onTheme={setTheme}
          bubbles={bubbles}
          onBubbles={setBubbles}
          onUnreadCount={onUnreadCount}
          onOpenSettings={openSettings}
          inert={settingsOpen}
          onCaughtUp={setCaughtUp}
          reveal={reveal}
        />
      ) : (
        <ConnectScreen
          connection={state.connection}
          discovery={state.discovery}
          info={info}
          mismatch={mismatch}
          inert={settingsOpen}
        />
      )}
    </div>
  );
}
