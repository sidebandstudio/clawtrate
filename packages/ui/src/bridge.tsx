import type { BridgeCommand, ClawtrateBridge, ClawtrateState } from "@clawtrate/core";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { InvitationReplies, canCountReply } from "./support/invitation.ts";
import { rosterScope } from "./roster.ts";

const RepliesContext = createContext<InvitationReplies | null>(null);

export function useInvitationReplies() {
  const replies = useContext(RepliesContext);
  if (!replies) throw new Error("useInvitationReplies needs a BridgeProvider");
  return replies;
}

const BridgeContext = createContext<ClawtrateBridge | null>(null);

export function BridgeProvider({
  bridge,
  children,
}: {
  bridge: ClawtrateBridge;
  children: ReactNode;
}) {
  const scope = useSyncExternalStore(
    useCallback((listener) => bridge.subscribe(listener), [bridge]),
    () => {
      const { connection } = bridge.getState();
      return connection.status === "connected" ? rosterScope(connection) : null;
    },
  );
  // A late send acknowledgement closes over the tracker of the gateway it went to.
  const replies = useMemo(
    () => new InvitationReplies(scope ? canCountReply : () => false),
    [scope, bridge],
  );
  return (
    <BridgeContext.Provider value={bridge}>
      <RepliesContext.Provider value={replies}>{children}</RepliesContext.Provider>
    </BridgeContext.Provider>
  );
}

export function useBridge(): ClawtrateBridge {
  const bridge = useContext(BridgeContext);
  if (!bridge) throw new Error("useBridge needs a BridgeProvider");
  return bridge;
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
