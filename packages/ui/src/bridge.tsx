import type { BridgeCommand, ClawtrateBridge, ClawtrateState } from "@clawtrate/core";
import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";

const BridgeContext = createContext<ClawtrateBridge | null>(null);

export function BridgeProvider({
  bridge,
  children,
}: {
  bridge: ClawtrateBridge;
  children: ReactNode;
}) {
  return <BridgeContext.Provider value={bridge}>{children}</BridgeContext.Provider>;
}

export function useBridge(): ClawtrateBridge {
  const bridge = useContext(BridgeContext);
  if (!bridge) throw new Error("useBridge needs a BridgeProvider");
  return bridge;
}

/** The latest state snapshot from the host. */
export function useClawtrateState(): ClawtrateState {
  const bridge = useBridge();
  const snapshot = () => bridge.getState();
  // The same snapshot when rendered to markup (the UI tests), as in the window.
  return useSyncExternalStore(
    useCallback((listener) => bridge.subscribe(listener), [bridge]),
    snapshot,
    snapshot,
  );
}

export function useCommand(): (command: BridgeCommand) => Promise<void> {
  const bridge = useBridge();
  return useCallback((command) => bridge.send(command), [bridge]);
}
