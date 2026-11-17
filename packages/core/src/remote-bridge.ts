// The renderer's side of a bridge that runs over a socket to a host process:
// the web preview host. It is transport-agnostic (any WebSocket-like object),
// so the same code runs in a browser and in tests. It keeps the last state on
// screen while the host is unreachable, restores this viewer's open tasks after
// every reconnect, and refuses a command too large for one bridge frame before
// it reaches the socket.

import type { AttachmentInfo } from "./attachments.ts";
import type {
  BridgeClientMessage,
  BridgeCommand,
  BridgeResultFor,
  BridgeServerMessage,
  ClawtrateBridge,
  HostInfo,
} from "./bridge.ts";
import { utf8Length } from "./encoding.ts";
import type { WebSocketLike } from "./host.ts";
import type { ClawtrateState } from "./types.ts";

/** The largest frame a renderer may send over the bridge socket, in UTF-8 bytes. The host enforces the same. */
export const MAX_BRIDGE_FRAME_BYTES = 64 * 1024;

export class BridgeFrameTooLargeError extends Error {
  constructor(bytes: number) {
    super(
      `This is too large to send in one piece (${bytes} bytes; at most ${MAX_BRIDGE_FRAME_BYTES}). Shorten the message.`,
    );
    this.name = "BridgeFrameTooLargeError";
  }
}

/** Encode a bridge message, refusing one the host would reject for its size. */
export function encodeBridgeFrame(message: BridgeClientMessage): string {
  const text = JSON.stringify(message);
  const bytes = utf8Length(text);
  if (bytes > MAX_BRIDGE_FRAME_BYTES) throw new BridgeFrameTooLargeError(bytes);
  return text;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export type RemoteBridgeOptions = {
  /** Open a new socket to the host's bridge endpoint. */
  open: () => WebSocketLike;
  /** Hand a file to the host on its own path. */
  attach: (file: { name: string; type: string; data: ArrayBuffer }) => Promise<AttachmentInfo>;
  now?: () => number;
};

/** Close code the host uses when the access token is missing or wrong. */
export const ACCESS_REFUSED_CLOSE_CODE = 4401;

export function createRemoteBridge(options: RemoteBridgeOptions): Promise<ClawtrateBridge> {
  const listeners = new Set<(state: ClawtrateState) => void>();
  const pending = new Map<string, Pending>();
  // The tasks this viewer has open. The host forgets them with the socket; they are restored after each hello.
  const wanted = new Set<string>();
  const now = options.now ?? (() => Date.now());
  let state: ClawtrateState | null = null;
  let socket: WebSocketLike | null = null;
  let counter = 0;
  let retryMs = 500;

  const emit = (next: ClawtrateState) => {
    state = next;
    for (const listener of listeners) listener(next);
  };

  const write = (command: BridgeCommand, waiter: Pending | null) => {
    const id = String((counter += 1));
    const frame = encodeBridgeFrame({ type: "command", id, command });
    if (waiter) pending.set(id, waiter);
    socket!.send(frame);
  };

  return new Promise((resolveBridge, rejectBridge) => {
    let info: HostInfo | null = null;

    const open = () => {
      const current = options.open();
      socket = current;
      current.onmessage = (event) => {
        let message: BridgeServerMessage;
        try {
          message = JSON.parse(String(event.data)) as BridgeServerMessage;
        } catch {
          return;
        }
        if (message.type === "hello") {
          retryMs = 500;
          const first = info === null;
          info = message.info;
          emit(message.state);
          // A new socket is a new viewer to the host: open this viewer's tasks again.
          // One the host refuses now is not asked for again.
          if (!first)
            for (const key of wanted)
              write(
                { type: "openSession", key },
                { resolve: () => {}, reject: () => wanted.delete(key) },
              );
          if (first) resolveBridge(bridge(message.info));
        } else if (message.type === "state") {
          emit(message.state);
        } else {
          const waiter = pending.get(message.id);
          pending.delete(message.id);
          if (message.ok) waiter?.resolve(message.value);
          else waiter?.reject(new Error(message.error));
        }
      };
      current.onerror = () => {};
      current.onclose = (event) => {
        if (socket !== current) return;
        socket = null;
        for (const waiter of pending.values()) waiter.reject(new Error("Lost the preview host"));
        pending.clear();
        if (event.code === ACCESS_REFUSED_CLOSE_CODE) {
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
              retryAt: now() + retryMs,
              error: { code: "HOST_UNREACHABLE", message: "Lost the preview host", hint: null },
            },
          });
        }
        setTimeout(open, retryMs);
        retryMs = Math.min(retryMs * 2, 10_000);
      };
    };

    const call = (command: BridgeCommand) =>
      new Promise<unknown>((resolve, reject) => {
        // Interest is recorded even while the host is unreachable, so the next hello restores it.
        if (command.type === "openSession") wanted.add(command.key);
        if (command.type === "closeSession") wanted.delete(command.key);
        if (!socket || socket.readyState !== 1) {
          reject(new Error("Not connected to the preview host"));
          return;
        }
        // An open the host refuses (a viewer holds at most `MAX_VIEWER_OPEN_TASKS`) is not restored later.
        const refused = (error: Error) => {
          if (command.type === "openSession") wanted.delete(command.key);
          reject(error);
        };
        try {
          write(command, { resolve, reject: refused });
        } catch (error) {
          refused(error instanceof Error ? error : new Error(String(error)));
        }
      });

    const bridge = (hostInfo: HostInfo): ClawtrateBridge => ({
      info: hostInfo,
      getState: () => state!,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async send(command) {
        await call(command);
      },
      invoke: (command) => call(command) as Promise<BridgeResultFor<typeof command>>,
      attach: (file) => options.attach(file),
    });

    open();
  });
}
