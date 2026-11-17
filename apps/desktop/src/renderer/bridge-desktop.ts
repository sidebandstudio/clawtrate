import type { BridgeResultFor, ClawtrateBridge, ClawtrateState } from "@clawtrate/core";
import type { DesktopHostApi } from "../preload/index.ts";

declare global {
  interface Window {
    clawtrateHost?: DesktopHostApi;
  }
}

/** Bridge over Electron IPC, through the API the preload script exposes. */
export async function createDesktopBridge(api: DesktopHostApi): Promise<ClawtrateBridge> {
  const hello = await api.hello();
  let state: ClawtrateState = hello.state;
  const listeners = new Set<(state: ClawtrateState) => void>();
  api.onState((next) => {
    state = next;
    for (const listener of listeners) listener(state);
  });
  return {
    info: hello.info,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send: async (command) => {
      await api.send(command);
    },
    invoke: (command) => api.send(command) as Promise<BridgeResultFor<typeof command>>,
  };
}
