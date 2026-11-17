import type {
  BridgeClientMessage,
  BridgeServerMessage,
  ClawtrateBridge,
  ClawtrateState,
  HostInfo,
} from "@clawtrate/core";

type Pending = { resolve: () => void; reject: (error: Error) => void };

/**
 * Bridge over a WebSocket to the web preview host. The host keeps the gateway
 * connection and the device key; the browser only sees state and sends commands.
 */
export function createWebBridge(): Promise<ClawtrateBridge> {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${scheme}//${location.host}/bridge`;
  const listeners = new Set<(state: ClawtrateState) => void>();
  const pending = new Map<string, Pending>();
  let state: ClawtrateState | null = null;
  let socket: WebSocket | null = null;
  let counter = 0;
  let retryMs = 500;

  const emit = (next: ClawtrateState) => {
    state = next;
    for (const listener of listeners) listener(next);
  };

  return new Promise((resolveBridge, rejectBridge) => {
    let info: HostInfo | null = null;

    const open = () => {
      socket = new WebSocket(url);
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as BridgeServerMessage;
        if (message.type === "hello") {
          retryMs = 500;
          const first = info === null;
          info = message.info;
          emit(message.state);
          if (first) resolveBridge(bridge(message.info));
        } else if (message.type === "state") {
          emit(message.state);
        } else {
          const waiter = pending.get(message.id);
          pending.delete(message.id);
          if (message.ok) waiter?.resolve();
          else waiter?.reject(new Error(message.error));
        }
      };
      socket.onclose = (event) => {
        for (const waiter of pending.values()) waiter.reject(new Error("Lost the preview host"));
        pending.clear();
        if (event.code === 4401) {
          rejectBridge(new Error("This preview needs the access link printed by the host."));
          return;
        }
        if (state) {
          // Keep the last state on screen and say the host link is down.
          emit({
            ...state,
            connection: {
              ...state.connection,
              status: "reconnecting",
              retryAt: Date.now() + retryMs,
              error: { code: "HOST_UNREACHABLE", message: "Lost the preview host", hint: null },
            },
          });
        }
        setTimeout(open, retryMs);
        retryMs = Math.min(retryMs * 2, 10_000);
      };
    };

    const bridge = (hostInfo: HostInfo): ClawtrateBridge => ({
      info: hostInfo,
      getState: () => state!,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      send(command) {
        return new Promise<void>((resolve, reject) => {
          if (!socket || socket.readyState !== WebSocket.OPEN) {
            reject(new Error("Not connected to the preview host"));
            return;
          }
          const id = String((counter += 1));
          pending.set(id, { resolve, reject });
          const message: BridgeClientMessage = { type: "command", id, command };
          socket.send(JSON.stringify(message));
        });
      },
    });

    open();
  });
}
