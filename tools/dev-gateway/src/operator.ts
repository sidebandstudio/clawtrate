// A paired operator connection to a development gateway, through the official
// `@openclaw/gateway-client`. The seed uses it to play the user (answer a
// question, resolve an approval) and the scenario check uses it to drive and
// watch every scenario.
//
// Each connection has its own new device key, kept in memory. The gateway
// requires pairing even on loopback (`autoApproveLocal: false`), so the first
// connect is refused with PAIRING_REQUIRED; `approvePairing` approves exactly
// that request id, through the tool's guarded runner, and the client's own
// retry then connects with the scopes asked for.

import {
  randomUUID,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { GatewayClient, type DeviceIdentity } from "@openclaw/gateway-client";
import { useOpenclawVersion, type OpenclawVersion } from "./versions.ts";

export type GatewayEvent = { at: number; seq: number; event: string; payload: unknown };

export type OperatorOptions = {
  url: string;
  token: string;
  scopes: string[];
  caps: string[];
  /** Shown in the gateway's device list. Starts with "Clawtrate" like every client of ours. */
  displayName: string;
  /** Approve one pairing request id on this instance. */
  approvePairing: (requestId: string) => Promise<void>;
  timeoutMs?: number;
};

type JsonRecord = Record<string, unknown>;
const asRecord = (value: unknown): JsonRecord =>
  value !== null && typeof value === "object" ? (value as JsonRecord) : {};

function newDeviceIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return {
    deviceId: createHash("sha256").update(raw).digest("hex"),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** The terminal `chat` states of a run. */
export const TERMINAL_CHAT_STATES = ["final", "aborted", "error"];

export class OperatorSession {
  readonly events: GatewayEvent[] = [];
  private readonly waiters = new Set<(event: GatewayEvent) => void>();
  private seq = 0;
  private client: GatewayClient | null = null;
  /** Between a close and the client's own reconnect, requests wait for the next hello. */
  private ready = false;
  private readonly helloWaiters = new Set<() => void>();
  private lastClose = "";
  /** This connection's device, as the gateway lists it. */
  deviceId = "";
  /** The OpenClaw version the gateway reported in its hello. */
  serverVersion: OpenclawVersion | null = null;

  private constructor() {}

  /**
   * Connect, approving this device's own pairing request, and resolve once
   * hello is received. The client stops retrying after PAIRING_REQUIRED, so
   * once the request is approved a new client connects with the same key.
   */
  static async open(options: OperatorOptions): Promise<OperatorSession> {
    const identity = newDeviceIdentity();
    const tokens = new Map<string, { token: string; scopes: string[] }>();
    const session = new OperatorSession();
    session.deviceId = identity.deviceId;
    const deadline = Date.now() + (options.timeoutMs ?? 60_000);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const outcome = await new Promise<
        { ok: true } | { ok: false; pairing?: string; error: Error }
      >((resolve) => {
        let settled = false;
        const settle = (value: { ok: true } | { ok: false; pairing?: string; error: Error }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        const timer = setTimeout(
          () => settle({ ok: false, error: new Error("no hello before the time limit") }),
          Math.max(1_000, deadline - Date.now()),
        );
        let pairing: string | undefined;
        const client: GatewayClient = new GatewayClient({
          url: options.url,
          token: options.token,
          clientName: "gateway-client",
          mode: "ui",
          clientDisplayName: options.displayName,
          clientVersion: "0.0.0",
          platform: process.platform,
          role: "operator",
          scopes: options.scopes,
          caps: options.caps,
          minProtocol: 4,
          maxProtocol: 4,
          deviceIdentity: identity,
          hostDeps: {
            signDevicePayload: (pem, payload) =>
              sign(null, Buffer.from(payload), createPrivateKey(pem)).toString("base64url"),
            publicKeyRawBase64UrlFromPem: (pem) =>
              createPublicKey(pem)
                .export({ type: "spki", format: "der" })
                .subarray(-32)
                .toString("base64url"),
            loadDeviceAuthToken: ({ deviceId, role }) => tokens.get(`${deviceId}:${role}`) ?? null,
            storeDeviceAuthToken: ({ deviceId, role, token, scopes }) => {
              tokens.set(`${deviceId}:${role}`, { token, scopes });
            },
            clearDeviceAuthToken: ({ deviceId, role }) => {
              tokens.delete(`${deviceId}:${role}`);
            },
          },
          onEvent: (frame) => session.record(frame.event, frame.payload),
          onConnectError: (error) => {
            const details = asRecord((error as { details?: unknown }).details);
            if (details.code === "PAIRING_REQUIRED" && typeof details.requestId === "string") {
              pairing = details.requestId;
            }
          },
          onReconnectPaused: () => {
            void client.stopAndWait().catch(() => {});
            settle({
              ok: false,
              ...(pairing ? { pairing } : {}),
              error: new Error("the gateway refused the connection"),
            });
          },
          onClose: (code, reason) => {
            // The close that dropped a live connection, not a failed reconnect after it.
            if (session.ready) session.lastClose = `${code} ${reason}`.trim();
            session.ready = false;
          },
          onHelloOk: (hello) => {
            // The checks take the running version's form from the gateway's own report.
            try {
              session.serverVersion = useOpenclawVersion(
                String(asRecord(asRecord(hello).server).version),
              );
            } catch (error) {
              void client.stopAndWait().catch(() => {});
              settle({ ok: false, error: error as Error });
              return;
            }
            session.client = client;
            session.ready = true;
            for (const wake of session.helloWaiters) wake();
            session.helloWaiters.clear();
            settle({ ok: true });
          },
        });
        client.start();
      });
      if (outcome.ok) return session;
      if (!outcome.pairing) throw new Error(`${options.displayName}: ${outcome.error.message}`);
      await options.approvePairing(outcome.pairing);
    }
    throw new Error(`${options.displayName}: still not paired after approving its request`);
  }

  private record(event: string, payload: unknown): void {
    this.seq += 1;
    const entry = { at: Date.now(), seq: this.seq, event, payload };
    this.events.push(entry);
    for (const waiter of this.waiters) waiter(entry);
  }

  /**
   * A request on this connection. The gateway's tick watch or a slow-consumer
   * close can drop it under load, and the client reconnects by itself: a
   * request made in that gap waits for the next hello instead of failing. Only
   * a request the client never sent ("gateway not connected") is retried, and
   * once. A refusal, or a close while the request was in flight, is the caller's.
   */
  async request<T = JsonRecord>(
    method: string,
    params: unknown = {},
    timeoutMs = 60_000,
  ): Promise<T> {
    const client = this.client;
    if (!client) throw new Error("not connected");
    // One limit for the whole call: the waits and the sends share it.
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(deadline - Date.now(), 1);
    // A hello can end a wait just as the time runs out: nothing is sent once it has.
    const send = () =>
      Date.now() >= deadline
        ? Promise.reject(this.notReconnected(timeoutMs))
        : client.request<T>(method, params, { timeoutMs: left() });
    await this.connected(timeoutMs, left());
    try {
      return await send();
    } catch (error) {
      // The client's own "not sent" is a plain Error; the gateway's refusal is a subclass,
      // whatever its words, and is never sent again.
      const unsent =
        error instanceof Error &&
        Object.getPrototypeOf(error) === Error.prototype &&
        error.message === "gateway not connected";
      if (!unsent) throw error;
      // The socket is closing and its close has not reached the client yet.
      await this.connected(timeoutMs, left(), true);
      return send();
    }
  }

  private notReconnected(timeoutMs: number): Error {
    return new Error(
      `not reconnected within ${timeoutMs} ms after the gateway closed (${this.lastClose || "no close seen"})`,
    );
  }

  /** Resolves with the client connected: now, or at the next hello when `next`. Waits `waitMs` at most, the time the request's `timeoutMs` has left. */
  private connected(timeoutMs: number, waitMs: number, next = false): Promise<void> {
    if (this.ready && !next) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.helloWaiters.delete(wake);
        reject(this.notReconnected(timeoutMs));
      }, waitMs);
      this.helloWaiters.add(wake);
    });
  }

  /** The first event, already received or still to come, that matches. */
  waitFor(
    label: string,
    match: (event: GatewayEvent) => boolean,
    timeoutMs = 60_000,
    after = 0,
  ): Promise<GatewayEvent> {
    const seen = this.events.find((event) => event.seq > after && match(event));
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const waiter = (event: GatewayEvent) => {
        if (event.seq <= after || !match(event)) return;
        clearTimeout(timer);
        this.waiters.delete(waiter);
        resolve(event);
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`timed out after ${timeoutMs} ms waiting for ${label}`));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  /** The terminal `chat` event of a run. */
  terminal(runId: string, timeoutMs = 90_000): Promise<JsonRecord> {
    return this.waitFor(
      `the end of run ${runId}`,
      (event) =>
        event.event === "chat" &&
        asRecord(event.payload).runId === runId &&
        TERMINAL_CHAT_STATES.includes(String(asRecord(event.payload).state)),
      timeoutMs,
    ).then((event) => asRecord(event.payload));
  }

  /** `chat.send` a message and return its run id. */
  async send(sessionKey: string, message: string, extra: JsonRecord = {}): Promise<JsonRecord> {
    return this.request("chat.send", {
      sessionKey,
      message,
      idempotencyKey: randomUUID(),
      ...extra,
    });
  }

  /** Events of one run, in order. */
  runEvents(runId: string): GatewayEvent[] {
    return this.events.filter((event) => asRecord(event.payload).runId === runId);
  }

  get lastSeq(): number {
    return this.seq;
  }

  close(): Promise<void> {
    return this.client?.stopAndWait({ timeoutMs: 5_000 }).catch(() => {}) ?? Promise.resolve();
  }
}
