// What a host process provides to the core. Core itself uses no DOM and no
// Node APIs, so the same code runs in Electron's main process, plain Node and Expo.

/** Async key/value persistence. Values are strings; core stores JSON. */
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

/**
 * The subset of a WHATWG `fetch` response core reads: browsers, Node 18+,
 * Electron and React Native all provide it.
 */
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
 * An HTTP GET with no cookies and no redirects. Core asks it only for an
 * address on the gateway's own origin that the gateway itself named
 * (`artifacts.ts`), never for an address a bot wrote.
 */
export type HttpFetch = (
  url: string,
  init: { method: "GET"; redirect: "error"; credentials: "omit"; signal: AbortSignal },
) => Promise<HttpResponseLike>;

/** What a link's page says about itself, fetched by the device on the person's gesture. */
export type LinkPreview =
  | {
      status: "ok";
      url: string;
      title: string | null;
      description: string | null;
      /** The page's preview picture, fetched with it: base64 and its type. */
      image: { mimeType: string; data: string } | null;
    }
  | { status: "none"; url: string };

/** Fetches a link's preview: `http:` and `https:` only, no cookies, bounded; the host decides how. */
export type LinkPreviewer = (url: string) => Promise<LinkPreview>;

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
   * How to approve a pairing request on this gateway. The host knows whether the
   * gateway is the local development one; core falls back to the generic command.
   */
  approvalInstructions?: (gatewayUrl: string, requestId: string) => ApprovalInstructions;
  /** Fetches the gateway's own media addresses (`artifacts.ts`); without it, none is fetched. */
  fetch?: HttpFetch;
  /** Fetches a link's preview on the person's gesture; without it, links show no preview. */
  linkPreview?: LinkPreviewer;
};
