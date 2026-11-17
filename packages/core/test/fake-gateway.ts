// An in-memory gateway for protocol-level tests. It speaks the real frame
// shapes the pinned client expects: `connect.challenge`, then `connect`, then
// requests. Scenarios override the connect response and method handlers.

import type { ClawtrateHost, KeyValueStore, WebSocketLike } from "../src/host.ts";

export type Frame = { type: string; id?: string; method?: string; params?: unknown };
type ErrorShape = { code: string; message: string; details?: unknown };
export type Reply = { ok: true; payload: unknown } | { ok: false; error: ErrorShape };
type Handler = (params: unknown) => unknown;

export class GatewayError extends Error {
  readonly shape: ErrorShape;
  constructor(shape: ErrorShape) {
    super(shape.message);
    this.shape = shape;
  }
}

export function helloOk(scopes: string[] = ["operator.read"], deviceToken?: string) {
  return {
    type: "hello-ok",
    protocol: 4,
    server: { version: "test", connId: "conn-1" },
    features: { methods: [], events: [] },
    snapshot: {},
    auth: { role: "operator", scopes, ...(deviceToken ? { deviceToken } : {}) },
    policy: { maxPayload: 26_214_400, maxBufferedBytes: 52_428_800, tickIntervalMs: 15_000 },
  };
}

class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  private readonly gateway: FakeGateway;
  readonly url: string;

  constructor(gateway: FakeGateway, url: string) {
    this.gateway = gateway;
    this.url = url;
    setTimeout(() => {
      if (this.gateway.refuseConnections) {
        this.readyState = 3;
        this.onclose?.({ code: 1006, reason: "refused" });
        return;
      }
      this.readyState = 1;
      this.onopen?.({});
      this.push({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "nonce-1", ts: 1_000 },
      });
    }, 0);
  }

  push(frame: unknown): void {
    if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(frame) });
  }

  send(data: string): void {
    const frame = JSON.parse(data) as Frame;
    if (frame.type !== "req" || !frame.id || !frame.method) return;
    const id = frame.id;
    const method = frame.method;
    if (method === "connect") {
      this.gateway.connects.push(frame.params);
      const reply = this.gateway.connectReply(frame.params);
      setTimeout(() => this.reply(id, reply), 0);
      return;
    }
    this.gateway.requests.push({ method, params: frame.params });
    const handler = this.gateway.handlers[method];
    void Promise.resolve()
      .then(() => {
        if (!handler) throw new GatewayError({ code: "UNKNOWN_METHOD", message: method });
        return handler(frame.params);
      })
      .then(
        (payload) => this.reply(id, { ok: true, payload }),
        (error: unknown) =>
          this.reply(id, {
            ok: false,
            error:
              error instanceof GatewayError
                ? error.shape
                : { code: "UNAVAILABLE", message: String(error) },
          }),
      );
  }

  private reply(id: string, reply: Reply): void {
    this.push({ type: "res", id, ...reply });
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    setTimeout(() => this.onclose?.({ code, reason }), 0);
  }
}

export class FakeGateway {
  readonly connects: unknown[] = [];
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly sockets: FakeSocket[] = [];
  refuseConnections = false;
  handlers: Record<string, Handler> = {
    "agents.list": () => ({
      defaultId: "main",
      agents: [{ id: "main", identity: { name: "Juniper" } }],
    }),
    "sessions.subscribe": () => ({ subscribed: true, list: { sessions: [], hasMore: false } }),
    "sessions.list": () => ({ sessions: [], hasMore: false }),
    "sessions.messages.subscribe": () => ({ ok: true }),
    "sessions.messages.unsubscribe": () => ({ ok: true }),
    "chat.history": () => ({ messages: [], hasMore: false }),
  };
  connectReply: (params: unknown) => Reply = () => ({ ok: true, payload: helloOk() });

  readonly createWebSocket = (url: string): WebSocketLike => {
    const socket = new FakeSocket(this, url);
    this.sockets.push(socket);
    return socket;
  };

  /** Deliver an event to every open socket. */
  emit(event: string, payload: unknown): void {
    for (const socket of this.sockets) socket.push({ type: "event", event, payload });
  }

  /** Drop every open connection, as a gateway restart would. */
  dropAll(): void {
    for (const socket of this.sockets) {
      if (socket.readyState !== 1) continue;
      socket.readyState = 3;
      socket.onclose?.({ code: 1012, reason: "restart" });
    }
  }

  calls(method: string): unknown[] {
    return this.requests.filter((request) => request.method === method).map((r) => r.params);
  }
}

export function memoryStorage(initial: Record<string, string> = {}): KeyValueStore & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => void data.set(key, value),
    delete: async (key) => void data.delete(key),
  };
}

export function testHost(gateway: FakeGateway, storage = memoryStorage()): ClawtrateHost {
  return {
    createWebSocket: gateway.createWebSocket,
    storage,
    signer: {
      loadIdentity: async () => ({ deviceId: "device-1", publicKey: "public-key" }),
      sign: async () => "signature",
    },
    client: { displayName: "Clawtrate Test", version: "0.0.0", platform: "test" },
  };
}

/** Poll until `check` passes or a few seconds elapse. */
export async function until(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(10);
  }
}

export const tokenKey = (url: string) => `deviceToken:${encodeURIComponent(url)}:device-1:operator`;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(() => resolve(), ms));
}
