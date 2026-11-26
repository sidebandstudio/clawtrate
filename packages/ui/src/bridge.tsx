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

/** The bridge, or null outside a `BridgeProvider` (a part drawn on its own). */
export function useOptionalBridge(): ClawtrateBridge | null {
  return useContext(BridgeContext);
}

/** The latest state snapshot from the host. */
export function useClawtrateState(): ClawtrateState {
  const bridge = useBridge();
  return useSyncExternalStore(
    useCallback((listener) => bridge.subscribe(listener), [bridge]),
    () => bridge.getState(),
  );
}

export function useCommand(): (command: BridgeCommand) => Promise<void> {
  const bridge = useBridge();
  return useCallback((command) => bridge.send(command), [bridge]);
}
