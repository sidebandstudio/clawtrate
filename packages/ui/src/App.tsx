import type { HostInfo } from "@clawtrate/core";
import { useEffect } from "react";
import { useClawtrateState } from "./bridge.tsx";
import { ConnectScreen } from "./ConnectScreen.tsx";
import { readPreference, useTheme } from "./preferences.ts";
import { screenFor } from "./screen.ts";
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
  return (
    <div className="app">
      {screenFor(state) === "shell" ? (
        <Shell state={state} theme={theme} onTheme={setTheme} onUnreadCount={onUnreadCount} />
      ) : (
        <ConnectScreen connection={state.connection} info={info} />
      )}
    </div>
  );
}
