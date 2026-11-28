// A paired operator connection to a development gateway, through the official
// `@openclaw/gateway-client`. The seed uses it to play the user (answer a
// question, resolve an approval) and the scenario check uses it to drive and
// watch every scenario.
//
// Each connection has its own new device key, kept in memory. The gateway
// requires pairing even on loopback (`autoApproveLocal: false`), so the first
// connect is refused with PAIRING_REQUIRED; `approvePairing` approves exactly
// that request id, through the tool's guarded runner, and the client's own
// retry then connects with the scopes asked for. An approve call that gave up
// waiting on the gateway doesn't say whether it approved: the next connect does.
// Only ids the gateway gives this client's own connects are approved.

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
  /**
   * Approve one pairing request id on this instance, the CLI given `timeoutMs` for each of its
   * gateway calls. `retry` says an earlier call for this request gave up. A refusal throws.
   */
  approvePairing: (
    requestId: string,
    call: { timeoutMs: number; retry: boolean },
  ) => Promise<Approval>;
  timeoutMs?: number;
  /** Each request's limit when it names none (60 s by default). */
  requestTimeoutMs?: number;
  /** The time the connect's limit and its pauses are measured in; the real one by default. */
  clock?: Clock;
};

/** A clock, a sleep and a timer that can be cancelled, handed in so the tests drive time. */
export type Clock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Runs `fire` after `ms`; the function it returns cancels it. */
  after: (ms: number, fire: () => void) => () => void;
};
export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  after: (ms, fire) => {
    const timer = setTimeout(fire, ms);
    return () => clearTimeout(timer);
  },
};

/** OpenClaw's CLI's own limit on a gateway call. */
export const CLI_DEFAULT_MS = 10_000;
/** The longest one approve call's gateway calls each wait. */
export const APPROVE_CALL_MAX_MS = 60_000;
/** An approve call given less than this is not made again: there is no time left for it. */
export const APPROVE_RETRY_MIN_MS = 3_000;
/** The time allowed for the CLI's own start-up, which its `--timeout` doesn't count. */
export const CLI_START_MS = 3_000;

/**
 * What an approve call did. Not approved, with what it printed, when OpenClaw's CLI gave up waiting
 * on the gateway, which doesn't say whether the gateway approved (#907).
 */
export type Approval = { approved: true } | { approved: false; output: string };

/** The pause after an approve call that gave up, so a CLI that fails at once doesn't spin. */
export const GIVE_UP_PAUSE_MS = 1_000;

/** An approval that never settled: how long it waited, how many calls it made, and the last one's words. */
export function unsettledApproval(
  what: string,
  waitedMs: number,
  calls: number,
  output: string,
): string {
  return `${what}: not settled after ${Math.round(waitedMs / 1000)} s and ${calls} approve call${calls === 1 ? "" : "s"}; the last printed:\n${output.trim()}`;
}

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
  /** A hello is in effect and no close has come since. */
  get isUp(): boolean {
    return this.ready;
  }
  /** Moves on with each hello: what was read on one connection is never written on the next. */
  generation = 0;
  private readonly helloWaiters = new Set<() => void>();
  private lastClose = "";
  /** This connection's device, as the gateway lists it. */
  deviceId = "";
  /** The OpenClaw version the gateway reported in its hello. */
  serverVersion: OpenclawVersion | null = null;
  /** The scopes the gateway granted in its latest hello (`auth.scopes`): what this connection holds. */
  grantedScopes: string[] = [];
  /** Each request's limit when it names none. */
  private requestTimeoutMs = 60_000;

  private constructor() {}

  /**
   * Connect, approving this device's own pairing request, and resolve once
   * hello is received. The client stops retrying after PAIRING_REQUIRED, so
   * once the request is approved a new client connects with the same key.
   * After an approve call that gave up, and a short pause, that connect says
   * whether the gateway approved. A connect refused again names the request to
   * approve: the same id while it is pending (the gateway refreshes a device's
   * request while its key, role and scopes are the same), or a new one once that
   * one is gone, raised by this client's own key all the same. All within the
   * connect's limit.
   */
  static async open(options: OperatorOptions): Promise<OperatorSession> {
    const identity = newDeviceIdentity();
    const tokens = new Map<string, { token: string; scopes: string[] }>();
    const session = new OperatorSession();
    session.deviceId = identity.deviceId;
    if (options.requestTimeoutMs !== undefined) session.requestTimeoutMs = options.requestTimeoutMs;
    const clock = options.clock ?? realClock;
    const started = clock.now();
    const deadline = started + (options.timeoutMs ?? 60_000);
    let approvals = 0;
    /** The request whose last approve call gave up, and what it printed. */
    let unsettled: { requestId: string; output: string } | null = null;
    /** The approve calls that gave up since the last one that approved. */
    let gaveUp = 0;
    const notSettled = () =>
      unsettled
        ? unsettledApproval(
            `${options.displayName}'s pairing request ${unsettled.requestId}`,
            clock.now() - started,
            gaveUp,
            unsettled.output,
          )
        : "";
    for (;;) {
      const outcome = await new Promise<
        { ok: true } | { ok: false; pairing?: string; error: Error }
      >((resolve) => {
        let settled = false;
        const settle = (value: { ok: true } | { ok: false; pairing?: string; error: Error }) => {
          if (settled) return;
          settled = true;
          cancelTimer();
          resolve(value);
        };
        const cancelTimer = clock.after(Math.max(1_000, deadline - clock.now()), () =>
          settle({ ok: false, error: new Error("no hello before the time limit") }),
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
            const scopes = asRecord(asRecord(hello).auth).scopes;
            session.grantedScopes = Array.isArray(scopes)
              ? scopes.filter((scope): scope is string => typeof scope === "string")
              : [];
            session.client = client;
            session.generation += 1;
            session.ready = true;
            for (const wake of session.helloWaiters) wake();
            session.helloWaiters.clear();
            settle({ ok: true });
          },
        });
        client.start();
      });
      if (outcome.ok) return session;
      if (!outcome.pairing) {
        throw new Error(
          [`${options.displayName}: ${outcome.error.message}`, notSettled()]
            .filter(Boolean)
            .join("\n"),
        );
      }
      // A new id is a new request of this client's own, so its first call is not a retry.
      const retry = unsettled !== null && outcome.pairing === unsettled.requestId;
      // The CLI makes two gateway calls for one approve, a list and the approve, each given the
      // whole limit: a call gets half of what is left after the CLI's start-up, so it ends inside
      // the connect's limit. After a give-up, too little left ends the connect; a first call has
      // the CLI's own 10 s at least.
      const callMs = Math.min(
        APPROVE_CALL_MAX_MS,
        Math.floor((deadline - clock.now() - CLI_START_MS) / 2),
      );
      if (unsettled && callMs < APPROVE_RETRY_MIN_MS) throw new Error(notSettled());
      const result = await options.approvePairing(outcome.pairing, {
        timeoutMs: unsettled ? callMs : Math.max(CLI_DEFAULT_MS, callMs),
        retry,
      });
      if (result.approved) {
        unsettled = null;
        gaveUp = 0;
        approvals += 1;
        if (approvals === 3) {
          throw new Error(`${options.displayName}: still not paired after approving its request`);
        }
      } else {
        unsettled = { requestId: outcome.pairing, output: result.output };
        gaveUp += 1;
        await clock.sleep(GIVE_UP_PAUSE_MS);
      }
    }
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
    timeoutMs = this.requestTimeoutMs,
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

  /**
   * One request on the connection that is up now, or none: no wait for a hello and no resend on
   * the next connection. For a write decided from reads on this connection (the plugin install
   * engine's), which must never go out on another one.
   */
  requestOnce<T = JsonRecord>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    const client = this.client;
    if (!client || !this.ready) return Promise.reject(new Error("not connected"));
    return client.request<T>(method, params, { timeoutMs });
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
