import { useEffect } from "react";

/** Only a Simulator launch can supply this prop, through the scene delegate. */
export function useSwitcherProbe(port: number | undefined) {
  useEffect(() => (port === undefined ? undefined : openSwitcherProbe(port)), [port]);
}

/**
 * Keep a socket open to the Simulator check's probe server. A socket that
 * closes is opened again, so the check still finds the app after the app was
 * away from the front. Returns what closes it for good.
 */
export function openSwitcherProbe(port: number): () => void {
  let socket: WebSocket;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const open = () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    socket = ws;
    ws.onclose = () => {
      if (!stopped) retry = setTimeout(open, 1_000);
    };
    ws.onmessage = ({ data }) => {
      if (data !== "block") return;
      const startedAt = Date.now();
      // Leave time for the Simulator to switch apps on a loaded CI runner.
      const unblockAt = startedAt + 90_000;
      ws.send(JSON.stringify({ startedAt, unblockAt }));
      // Keep a single JS callback on the stack so it cannot handle AppState
      // events or update the React tree while UIKit takes the snapshot.
      while (Date.now() < unblockAt) {
        // The loop is bounded even if the test driver exits.
      }
      ws.send("resumed");
    };
  };
  open();
  return () => {
    stopped = true;
    clearTimeout(retry);
    socket.close();
  };
}
