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

/**
 * OpenClaw 2026.10.6 names the session a task's history came from, and names none only when the
 * key holds no task. A history handler that says nothing of it is answered with one per key; one
 * that sets `sessionId`, to undefined too, is answered as it says.
 */
function namingSession(payload: unknown, params: unknown): unknown {
  if (!payload || typeof payload !== "object" || "sessionId" in payload) return payload;
  const key = (params as { sessionKey?: unknown } | undefined)?.sessionKey;
  return typeof key === "string" ? { ...payload, sessionId: `session:${key}` } : payload;
}

/**
 * OpenClaw 2026.10.6 names the run it has in flight under the key (`inFlightRun`) in the history of
 * a task it holds. A history handler that says nothing of it is answered with the run a `start`
 * this gateway emitted began, until its end; one that sets `inFlightRun` is answered as it says.
 */
function namingRun(payload: unknown, params: unknown, running: Map<string, string>): unknown {
  if (!payload || typeof payload !== "object" || "inFlightRun" in payload) return payload;
  const key = (params as { sessionKey?: unknown } | undefined)?.sessionKey;
  const runId = typeof key === "string" ? running.get(key) : undefined;
  if (!runId || !(payload as { sessionId?: unknown }).sessionId) return payload;
  return { ...payload, inFlightRun: { runId } };
}

/** When this fake gateway "process" started; its hellos report their uptime from it. */
const fakeStartedAt = Date.now();
/** This fake gateway start's `server.bootId`, as a real gateway reports a random one per start. */
export const FAKE_BOOT_ID = "fake-boot-1";

export function helloOk(scopes: string[] = ["operator.read"], deviceToken?: string) {
  return {
    type: "hello-ok",
    protocol: 4,
    server: { version: "test", connId: "conn-1", bootId: FAKE_BOOT_ID },
    features: { methods: [], events: [] },
    snapshot: { uptimeMs: Date.now() - fakeStartedAt },
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
      const reply = this.gateway.connectReply(frame.params, this.url);
      setTimeout(() => this.reply(id, reply), 0);
      return;
    }
    this.gateway.requests.push({ method, params: frame.params, id });
    const handler = this.gateway.handlers[method];
    void Promise.resolve()
      .then(() => {
        if (!handler) throw new GatewayError({ code: "UNKNOWN_METHOD", message: method });
        return handler(frame.params);
      })
      .then((payload) => {
        if (method !== "chat.history") return payload;
        const named = namingRun(
          namingSession(payload, frame.params),
          frame.params,
          this.gateway.running,
        );
        const key = (frame.params as { sessionKey?: unknown } | undefined)?.sessionKey;
        if (typeof key === "string" && named && typeof named === "object")
          this.gateway.named.set(key, (named as { sessionId?: string }).sessionId);
        return named;
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
  readonly requests: Array<{ method: string; params: unknown; id?: string }> = [];
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
    // OpenClaw 2026.10.6's row of what a key holds now: the session its latest history named, one
    // per key before any read, and the run a `start` this gateway emitted began, until its end.
    "sessions.describe": (params) => {
      const key = String((params as { key?: unknown } | undefined)?.key);
      const sessionId = this.named.has(key) ? this.named.get(key) : `session:${key}`;
      if (!sessionId) return { session: null };
      const run = this.running.get(key);
      return {
        session: {
          key,
          sessionId,
          hasActiveRun: run !== undefined,
          activeRunIds: run ? [run] : [],
        },
      };
    },
  };
  connectReply: (params: unknown, url: string) => Reply = () => ({ ok: true, payload: helloOk() });

  readonly createWebSocket = (url: string): WebSocketLike => {
    const socket = new FakeSocket(this, url);
    this.sockets.push(socket);
    return socket;
  };

  /** The run each task has in flight, by the lifecycle events emitted, for its history. */
  readonly running = new Map<string, string>();
  /** The session each task's latest history answer named, none included. */
  readonly named = new Map<string, string | undefined>();

  /** Deliver an event to every open socket. */
  emit(event: string, payload: unknown, frameSeq?: number): void {
    const frame = payload as {
      runId?: unknown;
      sessionKey?: unknown;
      stream?: unknown;
      state?: unknown;
      phase?: unknown;
      data?: { phase?: unknown };
    } | null;
    if (typeof frame?.sessionKey === "string" && typeof frame.runId === "string") {
      const phase = event === "agent" && frame.stream === "lifecycle" ? frame.data?.phase : null;
      if (phase === "start") this.running.set(frame.sessionKey, frame.runId);
      else if (
        this.running.get(frame.sessionKey) === frame.runId &&
        (phase === "end" ||
          phase === "error" ||
          (event === "chat" &&
            (frame.state === "final" || frame.state === "error" || frame.state === "aborted")) ||
          (event === "sessions.changed" && (frame.phase === "end" || frame.phase === "error")))
      )
        this.running.delete(frame.sessionKey);
    }
    for (const socket of this.sockets) {
      socket.push({
        type: "event",
        event,
        payload,
        ...(frameSeq !== undefined ? { seq: frameSeq } : {}),
      });
    }
  }

  /** Drop every open connection, as a gateway restart would: no run is in flight after it. */
  dropAll(): void {
    this.running.clear();
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

/** A promise a test settles by hand, for gateway calls that wait. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Memory storage whose reads of chosen keys can be held, to interleave a
 * credential write with a gateway switch.
 */
export function gatedStorage(initial: Record<string, string> = {}) {
  const base = memoryStorage(initial);
  const gates = new Map<string, Array<() => void>>();
  const held = new Set<string>();
  return {
    ...base,
    hold(key: string) {
      held.add(key);
    },
    /** Let every held read of the key go, and stop holding new ones. */
    release(key: string) {
      held.delete(key);
      for (const resume of gates.get(key) ?? []) resume();
      gates.delete(key);
    },
    waiting(key: string) {
      return gates.get(key)?.length ?? 0;
    },
    get: async (key: string) => {
      if (held.has(key)) {
        await new Promise<void>((resume) => gates.set(key, [...(gates.get(key) ?? []), resume]));
      }
      return base.data.get(key) ?? null;
    },
  };
}
