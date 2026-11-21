// What a host process provides to the core. Core itself uses no DOM and no
// Node APIs, so the same code runs in Electron's main process, plain Node and Expo.

import type { KeyPair, ReceiveBudget } from "@clawtrate/relay-protocol";
import type { RelayTransportFactory } from "./relay/socket.ts";

/**
 * Async key/value persistence. Values are strings; core stores JSON. `set` and
 * `delete` resolve only once the change is kept; a change that could not be kept
 * rejects, and `get` goes on returning what was kept before.
 */
export type KeyValueStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
};

/**
 * The device's Ed25519 identity. The host keeps the private key; core only asks
 * for signatures. `deviceId` is the hex SHA-256 of the raw 32-byte public key and
 * `publicKey` is that raw key in base64url, as the gateway expects.
 */
export type DeviceSigner = {
  loadIdentity(): Promise<{ deviceId: string; publicKey: string }>;
  /** Ed25519 signature of the UTF-8 payload, base64url encoded. */
  sign(payload: string): Promise<string>;
};

/** The subset of the WHATWG WebSocket that core uses. Browsers, Node 22+ and React Native all provide it. */
export type WebSocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export type WebSocketFactory = (url: string) => WebSocketLike;

export type ClientIdentity = {
  /** Shown to the gateway operator when approving the device, for example "Clawtrate Desktop". */
  displayName: string;
  version: string;
  /** Runtime platform such as `darwin`, `linux`, `win32`, `ios` or `web`. */
  platform: string;
};

export type ApprovalInstructions = { command: string; note: string | null };

/**
 * What a host provides to reach gateways through Clawtrate's relay (`RelaySocket`). Without it
 * the client refuses relay routes.
 */
export type RelayHost = {
  /** A WebSocket to the relay that sends and receives binary messages. */
  createTransport: RelayTransportFactory;
  /**
   * This device's Noise static key pair for relay routes, kept by the host as it keeps the
   * signing key. The same pair on every relay route: connectors enroll its public half.
   */
  loadStaticKey(): Promise<KeyPair>;
  /** Shared by every relay channel of this host; a default one otherwise. */
  budget?: ReceiveBudget;
  /** A monotonic clock in whole milliseconds, for the relay channel's deadlines. */
  clock?: () => number;
  /** Tests only: relay routes to a `ws:` relay on this machine. */
  allowLoopbackWs?: boolean;
};

export type ClawtrateHost = {
  createWebSocket: WebSocketFactory;
  relay?: RelayHost;
  storage: KeyValueStore;
  signer: DeviceSigner;
  client: ClientIdentity;
  now?: () => number;
  randomId?: () => string;
  log?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
  /**
   * How to approve a pairing request on this gateway. The host knows whether the
   * gateway is the local development one; core falls back to the generic command.
   */
  approvalInstructions?: (gatewayUrl: string, requestId: string) => ApprovalInstructions;
};
