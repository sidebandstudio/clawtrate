import type { HostInfo } from "@clawtrate/core";
import { useClawtrateState } from "./bridge.tsx";
import { ConnectScreen } from "./ConnectScreen.tsx";
import { screenFor } from "./screen.ts";
import { Shell } from "./Shell.tsx";

/**
 * The connection screen is for connecting and pairing. Once a gateway has
 * delivered anything, the shell stays mounted through reconnects, keeping
 * scroll position and open details, with a status strip on top.
 */
export function App({ info }: { info: HostInfo }) {
  const state = useClawtrateState();
  return screenFor(state) === "shell" ? (
    <Shell state={state} />
  ) : (
    <ConnectScreen connection={state.connection} info={info} />
  );
}
