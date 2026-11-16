import type { HostInfo } from "@clawtrate/core";
import { useClawtrateState } from "./bridge.tsx";
import { ConnectScreen } from "./ConnectScreen.tsx";
import { Shell } from "./Shell.tsx";

/**
 * The connection screen shows until a gateway has delivered bots. After that the
 * shell stays up through reconnects, showing the last known state under a banner.
 */
export function App({ info }: { info: HostInfo }) {
  const state = useClawtrateState();
  const { status } = state.connection;
  const hasData = state.bots.length > 0;
  const showShell =
    hasData && (status === "connected" || status === "reconnecting" || status === "error");
  return showShell ? (
    <Shell state={state} />
  ) : (
    <ConnectScreen connection={state.connection} info={info} />
  );
}
