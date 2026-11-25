// What a host process provides to the core. Core itself uses no DOM and no
// Node APIs, so the same code runs in Electron's main process, plain Node and Expo.

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
  /** How binary messages arrive; the computer's stream asks for `arraybuffer`. */
  binaryType?: string;
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

/** The part of a WHATWG `fetch` response core reads: browsers, Node, Electron and React Native have it. */
export type HttpResponseLike = {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(): Promise<void>;
    };
    cancel(): Promise<void>;
  } | null;
};

/**
 * An HTTP GET with no cookies and no redirects. Core asks it only for a path on the
 * gateway's own origin that the gateway itself issued, or for the gateway's media route
 * (`pictures.ts`). `headers` carries this device's token, and only on the media route's
 * ticket request at a protected address (`fetchInboundPicture`); no other request has it.
 */
export type HttpFetch = (
  url: string,
  init: {
    method: "GET";
    redirect: "error";
    credentials: "omit";
    signal: AbortSignal;
    headers?: { authorization: string };
  },
) => Promise<HttpResponseLike>;

export type ApprovalInstructions = { command: string; note: string | null };

export type ClawtrateHost = {
  createWebSocket: WebSocketFactory;
  storage: KeyValueStore;
  signer: DeviceSigner;
  client: ClientIdentity;
  now?: () => number;
  randomId?: () => string;
  log?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
  /**
   * Resolves true only while the host keeps this device's credentials (its device
   * tokens, a saved gateway token and its key) in the system's secure storage.
   * Full access (`ClientOptions.fullAccess`) needs it; without it, a host has none.
   */
  secureCredentials?: () => Promise<boolean>;
  /**
   * Where a host with secure storage keeps those credentials now: sealed, sealed with an
   * earlier clear-text copy still to remove, for this session only, or unreadable.
   */
  credentialStatus?: () => Promise<"secure" | "cleanup-pending" | "session" | "locked">;
  /**
   * How to approve a pairing request on this gateway. The host knows whether the
   * gateway is the local development one; core falls back to the generic command.
   */
  approvalInstructions?: (gatewayUrl: string, requestId: string) => ApprovalInstructions;
  /** Fetches the pictures the gateway serves (`pictures.ts`); without it, none is shown from the gateway. */
  fetch?: HttpFetch;
};
