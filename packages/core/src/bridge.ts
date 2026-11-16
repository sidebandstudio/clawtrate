// The contract between a host process (Electron main, the web preview host) and
// the renderer. The host owns the gateway connection; the renderer receives state
// snapshots and sends commands. Transport is IPC in Electron and a WebSocket on the web.

import type { ClawtrateClient } from "./client.ts";
import type { ClawtrateState } from "./types.ts";

export type BridgeCommand =
  | { type: "connect"; url: string; token?: string | null }
  /** Connect to the local development gateway. The host supplies its token. */
  | { type: "connectDevGateway" }
  | { type: "disconnect" }
  | { type: "retry" }
  | { type: "openSession"; key: string }
  | { type: "closeSession"; key: string };

export type HostInfo = {
  kind: "desktop" | "web";
  version: string;
  /** Set when the host was started against the local development gateway. */
  devGateway: { url: string } | null;
};

/** Renderer-side view of the bridge, implemented over IPC or a WebSocket. */
export type ClawtrateBridge = {
  info: HostInfo;
  getState(): ClawtrateState;
  subscribe(listener: (state: ClawtrateState) => void): () => void;
  send(command: BridgeCommand): Promise<void>;
};

/** Messages a web host sends over its bridge socket. */
export type BridgeServerMessage =
  | { type: "hello"; info: HostInfo; state: ClawtrateState }
  | { type: "state"; state: ClawtrateState }
  | { type: "result"; id: string; ok: true }
  | { type: "result"; id: string; ok: false; error: string };

/** Messages a renderer sends over a web bridge socket. */
export type BridgeClientMessage = { type: "command"; id: string; command: BridgeCommand };

const SESSION_KEY_PATTERN = /^[\w:.@+-]{1,512}$/;

/** Validate an untrusted command from a renderer before it reaches the client. */
export function parseBridgeCommand(value: unknown): BridgeCommand {
  if (value === null || typeof value !== "object") throw new Error("invalid command");
  const command = value as Record<string, unknown>;
  switch (command.type) {
    case "connect": {
      if (typeof command.url !== "string" || command.url.length > 2048)
        throw new Error("invalid url");
      const token = command.token;
      if (
        token !== undefined &&
        token !== null &&
        (typeof token !== "string" || token.length > 4096)
      ) {
        throw new Error("invalid token");
      }
      return { type: "connect", url: command.url, token: token ?? null };
    }
    case "connectDevGateway":
    case "disconnect":
    case "retry":
      return { type: command.type };
    case "openSession":
    case "closeSession":
      if (typeof command.key !== "string" || !SESSION_KEY_PATTERN.test(command.key)) {
        throw new Error("invalid session key");
      }
      return { type: command.type, key: command.key };
    default:
      throw new Error("unknown command");
  }
}

export type BridgePolicy = {
  /** Connection details for the development gateway, when the host has them. */
  devGateway?: { url: string; token: string | null } | null;
  /** Refuse gateway URLs the host does not allow, for example in token-free dev mode. */
  allowGatewayUrl?: (url: string) => boolean;
};

export async function applyBridgeCommand(
  client: ClawtrateClient,
  command: BridgeCommand,
  policy: BridgePolicy = {},
): Promise<void> {
  switch (command.type) {
    case "connect":
      if (policy.allowGatewayUrl && !policy.allowGatewayUrl(command.url)) {
        throw new Error("This host only connects to the development gateway.");
      }
      return client.connect({ url: command.url, token: command.token ?? null });
    case "connectDevGateway":
      if (!policy.devGateway) throw new Error("No development gateway is configured on this host.");
      return client.connect(policy.devGateway);
    case "disconnect":
      return client.disconnect();
    case "retry":
      return client.retryNow();
    case "openSession":
      client.openSession(command.key);
      return;
    case "closeSession":
      client.closeSession(command.key);
      return;
  }
}

/**
 * Coalesce rapid store updates into one snapshot per tick, so a burst of
 * streaming events does not flood IPC or the bridge socket.
 */
export function batchSnapshots(
  subscribe: (listener: (state: ClawtrateState) => void) => () => void,
  emit: (state: ClawtrateState) => void,
  delayMs = 16,
): () => void {
  let pending: ClawtrateState | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = subscribe((state) => {
    pending = state;
    timer ??= setTimeout(() => {
      timer = null;
      if (pending) emit(pending);
      pending = null;
    }, delayMs);
  });
  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
  };
}
