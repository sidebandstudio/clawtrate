// The gateway connection and the state it projects. Built on the official
// browser-safe protocol client, with transport, storage and signing injected.

import {
  DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS,
  GatewayBrowserDeviceAuthLifecycle,
  GatewayChatStreamProjection,
  GatewayProtocolClient,
  GatewayProtocolRequestError,
  PROTOCOL_VERSION,
  shouldPauseGatewayReconnect,
  type EventFrame,
  type GatewayBrowserDeviceAuthPlan,
  type GatewayBrowserDeviceTokenStore,
  type HelloOk,
} from "@openclaw/gateway-client/browser";
import type { ApprovalInstructions, ClawtrateHost } from "./host.ts";
import {
  asRecord,
  groupTasks,
  isExcludedSessionKey,
  isSessionRemoval,
  isTaskSession,
  liveTextFromChatMessage,
  mapAgents,
  mapHistory,
  mergeSessionRow,
  sessionChangeRow,
  sessionRowKey,
  sessionRowsFromList,
  type RawRecord,
} from "./mapping.ts";
import {
  PAIRING_ENDED,
  pairingEnded,
  protocolMessage,
  protocolMismatch,
} from "./connect-errors.ts";
import { createStore, type Store } from "./store.ts";
import {
  initialConnectionState,
  initialState,
  type ClawtrateState,
  type ConnectionState,
  type DiscoveryState,
  type Transcript,
} from "./types.ts";

/** This slice reads only. Every connect requests exactly these scopes, nothing more. */
export const REQUESTED_SCOPES = ["operator.read"] as const;
/**
 * Client capabilities advertised in `connect`. Empty on purpose: this slice does
 * not render live tool events or approvals, so it claims none of those contracts.
 */
export const CLIENT_CAPS: readonly string[] = [];
/** A registered client id for third-party operator UIs; we do not claim an OpenClaw product id. */
export const CLIENT_ID = "gateway-client";
export const CLIENT_MODE = "ui";

/** One page of the task list. Pages are read until the gateway reports no more. */
export const SESSION_PAGE_SIZE = 200;
/** A ceiling so a huge gateway cannot make one reconnect read forever. */
export const MAX_SESSION_PAGES = 50;
const SESSION_LIST_PARAMS = {
  limit: SESSION_PAGE_SIZE,
  includeDerivedTitles: true,
  includeLastMessage: true,
  excludeCron: true,
  excludeSubagents: true,
};
const HISTORY_LIMIT = 200;
const PAIRING_RETRY_MS = 3000;

const SETTINGS_KEY = "connection";

export type ConnectionSettings = {
  url: string;
  token: string | null;
  /** The user chose Disconnect: stay disconnected, across restarts, until Reconnect. */
  suspended?: boolean;
};

export type ConnectOptions = { url: string; token?: string | null };

export type ClientOptions = {
  /**
   * Gateways this client may open. Checked before every connection, including
   * a saved one resumed at start and every retry.
   */
  allowGatewayUrl?: (url: string) => boolean;
  /** Reconnect backoff. Tests shorten it. */
  reconnect?: { initialMs: number; maxMs: number };
};

type Plan = GatewayBrowserDeviceAuthPlan;

/** A device token record. The grant is kept for reference; it never sets the requested scopes. */
type StoredDeviceToken = { token: string; grantedScopes: string[] };

function isRetryableNetworkFailure(error: Error): boolean {
  return !(error instanceof GatewayProtocolRequestError);
}

export function validateGatewayUrl(raw: string): string {
  const url = new URL(raw.trim());
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("The gateway URL must start with ws:// or wss://");
  }
  return url.toString().replace(/\/$/, "");
}

export function defaultApprovalInstructions(_url: string, requestId: string): ApprovalInstructions {
  return {
    command: `openclaw devices approve ${requestId}`,
    note: "The gateway's owner runs this on the machine where the gateway runs.",
  };
}

export class GatewayNotAllowedError extends Error {
  constructor(url: string) {
    super(`This host is not allowed to connect to ${url}.`);
    this.name = "GatewayNotAllowedError";
  }
}

export class ClawtrateClient {
  readonly store: Store<ClawtrateState> = createStore(initialState);

  private readonly host: ClawtrateHost;
  private readonly options: ClientOptions;
  private readonly lifecycle: GatewayBrowserDeviceAuthLifecycle;
  private readonly tokenStore: GatewayBrowserDeviceTokenStore;
  private protocol: GatewayProtocolClient<Plan> | null = null;
  private settings: ConnectionSettings | null = null;
  private identity: { deviceId: string; publicKey: string } | null = null;
  /** Bumped for every new connection so late responses from an old one are dropped. */
  private generation = 0;
  /** True once the current connection has reached hello at least once. */
  private everConnected = false;
  private rows = new Map<string, RawRecord>();
  /** Open transcripts, counted, so several viewers can share one. */
  private readonly openSessions = new Map<string, number>();
  private readonly streams = new GatewayChatStreamProjection();
  private readonly historyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private bootstrapping = false;
  private changedDuringBootstrap = false;
  /** The pairing request this client last saw pending, and when. */
  private pairingSeen: string | null = null;
  /** The current attempt reached hello. */
  private attemptGreeted = false;

  constructor(host: ClawtrateHost, options: ClientOptions = {}) {
    this.host = host;
    this.options = options;
    this.tokenStore = {
      // The lifecycle uses the record's scopes for reconnects. Report the
      // scopes this client requests, so a broader grant is never asked for.
      load: async ({ deviceId, role }) => {
        const record = await this.loadToken(deviceId, role);
        return record ? { token: record.token, scopes: [...REQUESTED_SCOPES] } : null;
      },
      store: async ({ deviceId, role, token, scopes }) => {
        const record: StoredDeviceToken = { token, grantedScopes: scopes };
        await host.storage.set(this.tokenKey(deviceId, role), JSON.stringify(record));
      },
      clear: async ({ deviceId, role }) => {
        await host.storage.delete(this.tokenKey(deviceId, role));
      },
    };
    this.lifecycle = new GatewayBrowserDeviceAuthLifecycle({
      loadIdentity: async () => {
        const identity = await this.loadIdentity();
        return { ...identity, sign: (payload) => host.signer.sign(payload) };
      },
      tokenStore: this.tokenStore,
      nowMs: () => this.now(),
    });
  }

  get state(): ClawtrateState {
    return this.store.get();
  }

  /** The gateway saved from an earlier run, if any. */
  async savedSettings(): Promise<ConnectionSettings | null> {
    const raw = await this.host.storage.get(SETTINGS_KEY);
    return raw ? (JSON.parse(raw) as ConnectionSettings) : null;
  }

  private async saveSettings(settings: ConnectionSettings): Promise<void> {
    this.settings = settings;
    await this.host.storage.set(SETTINGS_KEY, JSON.stringify(settings));
  }

  /** Resume the saved gateway, if any and if allowed, unless the user disconnected from it. */
  async start(): Promise<void> {
    const identity = await this.loadIdentity();
    this.setConnection({ deviceId: identity.deviceId });
    this.settings = await this.savedSettings();
    if (this.settings?.suspended) {
      this.setConnection({ status: "disconnected", gatewayUrl: this.settings.url });
      return;
    }
    if (this.settings) await this.open();
  }

  /** Connect to a gateway. A token is only needed until this device is paired. */
  async connect(options: ConnectOptions): Promise<void> {
    const url = validateGatewayUrl(options.url);
    if (!this.isAllowed(url)) throw new GatewayNotAllowedError(url);
    const token = options.token?.trim() || null;
    this.settings = { url, token };
    this.pairingSeen = null;
    await this.host.storage.set(SETTINGS_KEY, JSON.stringify(this.settings));
    await this.open();
  }

  /** Close the connection and forget the gateway. The device key and any device token remain. */
  async disconnect(): Promise<void> {
    this.close();
    this.settings = null;
    this.pairingSeen = null;
    this.rows = new Map();
    await this.host.storage.delete(SETTINGS_KEY);
    this.store.set({
      ...initialState,
      connection: { ...initialConnectionState, deviceId: this.identity?.deviceId ?? null },
    });
  }

  /**
   * The user's retry. While connected it reloads bots and tasks; otherwise it
   * reconnects at once, keeping what is already on screen.
   */
  async retryNow(): Promise<void> {
    if (!this.settings) return;
    if (this.protocol?.connected && this.state.connection.status === "connected") {
      await this.bootstrap(this.generation);
      return;
    }
    if (this.settings.suspended) await this.saveSettings({ ...this.settings, suspended: false });
    await this.open();
  }

  /**
   * Close the connection and keep everything else: the gateway, the device's
   * pairing and what is on screen. `retryNow` reconnects.
   */
  async suspend(): Promise<void> {
    if (!this.settings) return;
    // Saved, so a restart does not reconnect by itself.
    await this.saveSettings({ ...this.settings, suspended: true });
    this.close();
    this.clearLiveText();
    this.setConnection({ status: "disconnected", retryAt: null, error: null, pairing: null });
  }

  /** Stop without forgetting anything. Used when the host process exits. */
  stop(): void {
    this.close();
  }

  /** Open a transcript. Calls are counted; the last matching close releases it. */
  openSession(key: string): void {
    const count = this.openSessions.get(key) ?? 0;
    this.openSessions.set(key, count + 1);
    if (count > 0) return;
    this.setTranscript(key, (current) => current ?? this.emptyTranscript(key));
    if (this.state.connection.status === "connected") void this.loadTranscript(key, true);
  }

  closeSession(key: string): void {
    const count = this.openSessions.get(key);
    if (!count) return;
    if (count > 1) {
      this.openSessions.set(key, count - 1);
      return;
    }
    this.openSessions.delete(key);
    const timer = this.historyTimers.get(key);
    if (timer) clearTimeout(timer);
    this.historyTimers.delete(key);
    if (this.state.connection.status === "connected") {
      this.request("sessions.messages.unsubscribe", { key }).catch(() => {});
    }
    this.store.update((state) => {
      const transcripts = { ...state.transcripts };
      delete transcripts[key];
      return { ...state, transcripts };
    });
  }

  /** How many viewers hold a transcript open. */
  sessionInterest(key: string): number {
    return this.openSessions.get(key) ?? 0;
  }

  // Connection lifecycle -------------------------------------------------------

  private isAllowed(url: string): boolean {
    return this.options.allowGatewayUrl ? this.options.allowGatewayUrl(url) : true;
  }

  private async open(): Promise<void> {
    this.close();
    const settings = this.settings;
    if (!settings) return;
    const generation = ++this.generation;
    const identity = await this.loadIdentity();
    if (generation !== this.generation) return;

    if (!this.isAllowed(settings.url)) {
      this.rows = new Map();
      this.store.set({
        ...initialState,
        connection: {
          ...initialConnectionState,
          status: "error",
          gatewayUrl: settings.url,
          deviceId: identity.deviceId,
          error: {
            code: "GATEWAY_NOT_ALLOWED",
            message: new GatewayNotAllowedError(settings.url).message,
            hint: null,
          },
        },
      });
      return;
    }

    const paired = (await this.loadToken(identity.deviceId, "operator")) !== null;
    if (generation !== this.generation) return;
    // Reopening the same gateway keeps what is on screen until fresh data arrives.
    const sameGateway = this.state.connection.gatewayUrl === settings.url;
    const hasData = sameGateway && this.state.bots.length > 0;
    if (!sameGateway) this.rows = new Map();
    this.everConnected = hasData;
    this.store.update((state) => ({
      ...(sameGateway ? state : initialState),
      connection: {
        ...initialConnectionState,
        status: hasData ? "reconnecting" : "connecting",
        gatewayUrl: settings.url,
        deviceId: identity.deviceId,
        paired,
        serverVersion: sameGateway ? state.connection.serverVersion : null,
        gatewayId: sameGateway ? state.connection.gatewayId : null,
      },
      transcripts: sameGateway
        ? state.transcripts
        : Object.fromEntries(
            [...this.openSessions.keys()].map((key) => [key, this.emptyTranscript(key)]),
          ),
    }));

    const client = {
      id: CLIENT_ID,
      displayName: this.host.client.displayName,
      version: this.host.client.version,
      platform: this.host.client.platform,
      mode: CLIENT_MODE,
    } as const;
    const reconnect = this.options.reconnect ?? { initialMs: 1000, maxMs: 30_000 };

    this.protocol = new GatewayProtocolClient<Plan>({
      createSocket: (handlers) => {
        // Asked again before every attempt, including the protocol's own
        // retries: a gateway that stops being allowed is never reopened, and
        // throwing here ends the retries.
        if (!this.isAllowed(settings.url)) {
          if (generation === this.generation) {
            this.setConnection({
              status: "error",
              retryAt: null,
              error: {
                code: "GATEWAY_NOT_ALLOWED",
                message: new GatewayNotAllowedError(settings.url).message,
                hint: null,
              },
            });
          }
          throw new GatewayNotAllowedError(settings.url);
        }
        this.attemptGreeted = false;
        // An attempt is under way: no retry is waiting any more.
        if (this.state.connection.retryAt !== null) this.setConnection({ retryAt: null });
        const socket = this.host.createWebSocket(settings.url);
        socket.onopen = () => handlers.open();
        socket.onmessage = (event) => handlers.message(String(event.data));
        socket.onclose = (event) => handlers.close(event.code, event.reason);
        socket.onerror = () => handlers.error(new Error("WebSocket error"));
        return {
          isOpen: () => socket.readyState === 1,
          send: (data) => socket.send(data),
          close: (code, reason) => socket.close(code, reason),
        };
      },
      createRequestId: () => this.randomId(),
      buildConnectPlan: async ({ nonce, challengeTs }) => {
        const stored = await this.loadToken(identity.deviceId, "operator");
        // Once paired, the device token is the credential; the bootstrap token is no longer sent.
        const bootstrap = stored ? null : settings.token;
        const plan = await this.lifecycle.buildPlan({
          client,
          role: "operator",
          defaultScopes: REQUESTED_SCOPES,
          ...(bootstrap ? { token: bootstrap } : {}),
          nonce,
          challengeTs: challengeTs ?? null,
        });
        // The signed payload covers these scopes, so check them before sending.
        if (plan.scopes.join(",") !== REQUESTED_SCOPES.join(",")) {
          throw new Error(`refusing to request scopes ${plan.scopes.join(", ")}`);
        }
        return plan;
      },
      buildConnectParams: (plan) => ({
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client,
        role: plan.role,
        scopes: plan.scopes,
        caps: [...CLIENT_CAPS],
        ...(plan.auth ? { auth: plan.auth } : {}),
        ...(plan.device ? { device: plan.device } : {}),
        locale: "en-US",
        userAgent: `clawtrate/${this.host.client.version}`,
      }),
      onConnectHello: async (hello, context) => {
        await this.lifecycle.acceptHello(hello, context.plan);
        if (hello.auth.deviceToken && this.settings?.token) {
          // Paired: drop the bootstrap secret, the device token replaces it.
          this.settings = { ...this.settings, token: null };
          await this.host.storage.set(SETTINGS_KEY, JSON.stringify(this.settings));
        }
      },
      onHello: (hello) => {
        if (generation !== this.generation) return;
        this.attemptGreeted = true;
        if (hello.protocol !== PROTOCOL_VERSION) {
          // Outside this client's range: nothing else is asked of this gateway.
          const protocol = { gateway: hello.protocol, client: PROTOCOL_VERSION };
          this.close();
          this.setConnection({
            status: "error",
            retryAt: null,
            protocol: hello.protocol,
            serverVersion: hello.server.version,
            error: {
              code: "PROTOCOL_MISMATCH",
              message: protocolMessage(protocol),
              hint: null,
              protocol,
            },
          });
          return;
        }
        this.handleHello(hello, generation);
      },
      onConnectFailure: async (error) =>
        this.handleConnectFailure(error, identity.deviceId, settings.url),
      resolveClose: (context) => ({
        retry: true,
        notify: true,
        ...(context.connectFailure?.reconnectDelayMs !== undefined
          ? { reconnectDelayMs: context.connectFailure.reconnectDelayMs }
          : {}),
      }),
      onClose: () => {
        if (generation !== this.generation) return;
        this.streams.clear();
        const status = this.state.connection.status;
        if (status !== "pairing" && status !== "error") {
          // Once this gateway has answered, every later drop is a reconnect, not a first connect.
          // An attempt that never got an answer says so, unless the gateway gave a reason.
          const unanswered =
            !this.attemptGreeted && !this.state.connection.error
              ? {
                  error: {
                    code: "UNREACHABLE",
                    message: `Nothing answered at ${hostOf(settings.url)}.`,
                    hint: "Check that the gateway is running and that the address is right.",
                  },
                }
              : {};
          this.setConnection({
            status: this.everConnected ? "reconnecting" : "connecting",
            ...unanswered,
          });
        }
        this.clearLiveText();
      },
      onReconnectScheduled: (delayMs) => {
        if (generation !== this.generation) return;
        this.setConnection({ retryAt: this.now() + delayMs });
      },
      onReconnectStopped: (error) => {
        if (generation !== this.generation) return;
        if (this.state.connection.status !== "error") {
          this.setConnection({
            status: "error",
            retryAt: null,
            error: { code: "STOPPED", message: error.message, hint: null },
          });
        }
      },
      onConnectError: (error) => {
        if (generation !== this.generation || !isRetryableNetworkFailure(error)) return;
        this.log("warn", `connection attempt failed: ${error.message}`);
      },
      onEvent: (event) => {
        if (generation === this.generation) this.handleEvent(event, generation);
      },
      onCallbackError: (label, error) => this.log("error", `${label}: ${String(error)}`),
      handshake: { mode: "require-challenge", timeoutMs: DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS },
      reconnect: { initialMs: reconnect.initialMs, multiplier: 2, maxMs: reconnect.maxMs },
    });
    this.protocol.start();
  }

  private close(): void {
    this.generation += 1;
    this.protocol?.stop();
    this.protocol = null;
    this.streams.clear();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    for (const timer of this.historyTimers.values()) clearTimeout(timer);
    this.historyTimers.clear();
  }

  private handleConnectFailure(error: GatewayProtocolRequestError, deviceId: string, url: string) {
    const details = asRecord(error.details) ?? {};
    const code = typeof details.code === "string" ? details.code : error.gatewayCode;
    const hint = typeof details.remediationHint === "string" ? details.remediationHint : null;

    const mismatch = protocolMismatch(details);
    if (mismatch) {
      this.setConnection({
        status: "error",
        pairing: null,
        retryAt: null,
        error: {
          code: "PROTOCOL_MISMATCH",
          message: protocolMessage(mismatch),
          hint,
          protocol: mismatch,
        },
      });
      return { closeCode: 1000, closeReason: "protocol mismatch", stop: true };
    }

    if (code === "PAIRING_REQUIRED") {
      const requestId = typeof details.requestId === "string" ? details.requestId : "";
      // The request this client was waiting on is gone: the gateway's owner
      // rejected it, or it expired. Stop, and let the user ask again.
      if (pairingEnded(this.pairingSeen, requestId)) {
        this.pairingSeen = null;
        this.setConnection({
          status: "error",
          pairing: null,
          retryAt: null,
          error: { ...PAIRING_ENDED, hint: null },
        });
        return { closeCode: 1000, closeReason: "pairing request ended", stop: true };
      }
      if (requestId) this.pairingSeen = requestId;
      const scopes = Array.isArray(details.requestedScopes)
        ? details.requestedScopes.filter((s): s is string => typeof s === "string")
        : [...REQUESTED_SCOPES];
      const instructions = (this.host.approvalInstructions ?? defaultApprovalInstructions)(
        url,
        requestId,
      );
      this.setConnection({
        status: "pairing",
        error: null,
        pairing: {
          requestId,
          deviceId: typeof details.deviceId === "string" ? details.deviceId : deviceId,
          message: hint ?? "Approve this device from the gateway's pending pairing requests.",
          approveCommand: instructions.command,
          approveNote: instructions.note,
          requestedScopes: scopes,
        },
      });
      // The request id stays the same while we retry, so keep trying quietly
      // and connect as soon as an operator approves it.
      const nextStep = details.recommendedNextStep;
      const terminal = nextStep !== undefined && nextStep !== "wait_then_retry";
      return {
        closeCode: 1000,
        closeReason: "awaiting pairing approval",
        reconnectDelayMs: PAIRING_RETRY_MS,
        ...(terminal ? { stop: true } : {}),
      };
    }

    if (code === "AUTH_TOKEN_MISMATCH" || code === "AUTH_DEVICE_TOKEN_MISMATCH") {
      // A stored device token was revoked or rotated elsewhere. Forget it so the
      // next attempt can pair again with a bootstrap token.
      void this.tokenStore.clear(this.tokenParams(deviceId));
    }

    const pause = shouldPauseGatewayReconnect({ details: error.details });
    this.setConnection({
      status: pause ? "error" : this.everConnected ? "reconnecting" : "connecting",
      pairing: null,
      error: { code, message: error.message, hint },
    });
    return {
      closeCode: 1000,
      closeReason: "connect rejected",
      ...(pause ? { stop: true } : {}),
    };
  }

  private handleHello(hello: HelloOk, generation: number): void {
    this.everConnected = true;
    this.pairingSeen = null;
    this.setConnection({
      status: "connected",
      serverVersion: hello.server.version,
      protocol: hello.protocol,
      scopes: [...(hello.auth.scopes ?? [])],
      pairing: null,
      error: null,
      retryAt: null,
      connectedAt: Date.now(),
      paired: true,
    });
    void this.bootstrap(generation);
  }

  private setDiscovery(patch: Partial<DiscoveryState>): void {
    this.store.update((state) => ({ ...state, discovery: { ...state.discovery, ...patch } }));
  }

  /**
   * Every successful connect is a fresh projection: re-list, re-subscribe, reload
   * open transcripts. Bots and tasks load independently, so one failing read
   * keeps the other's result and any data shown before it.
   */
  private async bootstrap(generation: number): Promise<void> {
    this.bootstrapping = true;
    this.changedDuringBootstrap = false;
    this.setDiscovery({ status: "loading", error: null });
    // The gateway's identity comes with its bots, so what this device keeps
    // per gateway (pins, hidden bots, order) is known when the bots appear.
    const gatewayId = this.request("gateway.identity.get", {}).then(
      (result) => {
        const id = asRecord(result)?.deviceId;
        return typeof id === "string" && id ? id : null;
      },
      () => null,
    );
    // Bots are published as soon as they arrive, so the app can open on them
    // while tasks are still loading.
    const [agents, sessions] = await Promise.allSettled([
      this.request("agents.list", {}).then(async (result) => {
        const id = await gatewayId;
        if (generation === this.generation) {
          this.store.update((state) => ({
            ...state,
            connection: { ...state.connection, gatewayId: id },
            bots: mapAgents(result),
          }));
        }
        return result;
      }),
      this.loadAllSessions(generation, "sessions.subscribe"),
    ]);
    this.bootstrapping = false;
    if (generation !== this.generation) return;

    const failures: string[] = [];
    if (agents.status !== "fulfilled") {
      failures.push(`bots: ${errorMessage(agents.reason)}`);
    }
    if (sessions.status === "fulfilled") {
      this.replaceRows(sessions.value.rows);
      if (this.changedDuringBootstrap) await this.refreshSessions(generation);
    } else {
      failures.push(`tasks: ${errorMessage(sessions.reason)}`);
    }
    if (generation !== this.generation) return;
    for (const key of this.openSessions.keys()) void this.loadTranscript(key, true);

    if (failures.length > 0) {
      this.log("error", `discovery failed: ${failures.join("; ")}`);
      this.setDiscovery({ status: "error", error: `Could not load ${failures.join("; ")}` });
    } else {
      this.setDiscovery({
        status: "ready",
        error: null,
        partial: sessions.status === "fulfilled" && sessions.value.partial,
      });
    }
  }

  // Sessions -------------------------------------------------------------------

  /**
   * Read the whole filtered task list, one page at a time. The first page comes
   * from `sessions.subscribe` at bootstrap and from `sessions.list` on refresh.
   */
  private async loadAllSessions(
    generation: number,
    firstMethod: "sessions.subscribe" | "sessions.list",
  ): Promise<{ rows: RawRecord[]; partial: boolean }> {
    const first = asRecord(await this.request(firstMethod, SESSION_LIST_PARAMS));
    let page = firstMethod === "sessions.subscribe" ? asRecord(first?.list) : first;
    const rows = new Map<string, RawRecord>();
    for (let pages = 1; ; pages += 1) {
      for (const row of sessionRowsFromList(page)) rows.set(sessionRowKey(row)!, row);
      const nextOffset = page?.nextOffset;
      const more = page?.hasMore === true && typeof nextOffset === "number";
      if (!more) return { rows: [...rows.values()], partial: false };
      if (pages >= MAX_SESSION_PAGES || generation !== this.generation) {
        return { rows: [...rows.values()], partial: true };
      }
      page = asRecord(
        await this.request("sessions.list", { ...SESSION_LIST_PARAMS, offset: nextOffset }),
      );
    }
  }

  private replaceRows(rows: RawRecord[]): void {
    this.rows = new Map(
      rows.filter((row) => isTaskSession(row)).map((row) => [sessionRowKey(row)!, row]),
    );
    this.publishTasks();
  }

  private publishTasks(): void {
    const tasksByBot = groupTasks(this.rows.values());
    this.store.update((state) => ({ ...state, tasksByBot }));
  }

  private async refreshSessions(generation: number): Promise<void> {
    try {
      const { rows, partial } = await this.loadAllSessions(generation, "sessions.list");
      if (generation !== this.generation) return;
      this.replaceRows(rows);
      this.setDiscovery({ partial });
    } catch (error) {
      this.log("warn", `sessions.list failed: ${String(error)}`);
    }
  }

  private scheduleRefresh(generation: number): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshSessions(generation);
    }, 250);
  }

  /**
   * Apply a `sessions.changed` event with the same membership rules as the list.
   * A known row is merged and re-checked. An unknown row whose key is not ruled
   * out cannot prove membership from the payload, so the filtered list is
   * re-read instead of inserting it.
   */
  private handleSessionsChanged(payload: unknown, generation: number): void {
    if (this.bootstrapping) this.changedDuringBootstrap = true;
    const row = sessionChangeRow(payload);
    const key = row ? sessionRowKey(row) : null;
    if (!row || !key) {
      this.scheduleRefresh(generation);
      return;
    }
    if (isSessionRemoval(payload)) {
      if (this.rows.delete(key)) this.publishTasks();
      return;
    }
    const cached = this.rows.get(key);
    if (!cached) {
      if (!isExcludedSessionKey(key)) this.scheduleRefresh(generation);
      return;
    }
    const merged = mergeSessionRow(cached, row);
    if (isTaskSession(merged)) this.rows.set(key, merged);
    else this.rows.delete(key);
    this.publishTasks();
  }

  // Transcripts ----------------------------------------------------------------

  private emptyTranscript(key: string): Transcript {
    return {
      sessionKey: key,
      status: "loading",
      items: [],
      error: null,
      hasMore: false,
      live: null,
      loadedAt: null,
    };
  }

  private setTranscript(key: string, fn: (current: Transcript | undefined) => Transcript): void {
    this.store.update((state) => ({
      ...state,
      transcripts: { ...state.transcripts, [key]: fn(state.transcripts[key]) },
    }));
  }

  private async loadTranscript(key: string, subscribe: boolean): Promise<void> {
    const generation = this.generation;
    try {
      if (subscribe) {
        await this.request("sessions.messages.subscribe", { key }).catch((error: unknown) => {
          this.log("warn", `sessions.messages.subscribe failed: ${String(error)}`);
        });
      }
      const history = asRecord(
        await this.request("chat.history", { sessionKey: key, limit: HISTORY_LIMIT }),
      );
      if (generation !== this.generation || !this.openSessions.has(key)) return;
      const inFlight = asRecord(history?.inFlightRun);
      this.setTranscript(key, () => ({
        sessionKey: key,
        status: "ready",
        items: mapHistory(history?.messages),
        error: null,
        hasMore: history?.hasMore === true,
        live:
          inFlight && typeof inFlight.runId === "string"
            ? {
                runId: inFlight.runId,
                text: typeof inFlight.text === "string" ? inFlight.text : "",
              }
            : null,
        loadedAt: Date.now(),
      }));
    } catch (error) {
      if (generation !== this.generation || !this.openSessions.has(key)) return;
      this.setTranscript(key, (current) => ({
        ...(current ?? this.emptyTranscript(key)),
        status: "error",
        error: errorMessage(error),
      }));
    }
  }

  private scheduleHistory(key: string): void {
    if (this.historyTimers.has(key)) return;
    this.historyTimers.set(
      key,
      setTimeout(() => {
        this.historyTimers.delete(key);
        void this.loadTranscript(key, false);
      }, 150),
    );
  }

  private clearLiveText(): void {
    this.store.update((state) => {
      let changed = false;
      const transcripts = { ...state.transcripts };
      for (const [key, transcript] of Object.entries(transcripts)) {
        if (transcript.live) {
          transcripts[key] = { ...transcript, live: null };
          changed = true;
        }
      }
      return changed ? { ...state, transcripts } : state;
    });
  }

  private handleChat(event: EventFrame): void {
    const payload = asRecord(event.payload);
    const key = typeof payload?.sessionKey === "string" ? payload.sessionKey : null;
    const runId = typeof payload?.runId === "string" ? payload.runId : null;
    if (!payload || !key || !runId) return;
    const { event: projected } = this.streams.project(event);
    if (!this.openSessions.has(key)) return;
    if (payload.state === "delta") {
      const text = liveTextFromChatMessage(asRecord(projected.payload)?.message);
      this.setTranscript(key, (current) => ({
        ...(current ?? this.emptyTranscript(key)),
        live: { runId, text },
      }));
      return;
    }
    // final, aborted or error: the durable transcript now owns the text.
    this.setTranscript(key, (current) => ({
      ...(current ?? this.emptyTranscript(key)),
      live: null,
    }));
    this.scheduleHistory(key);
  }

  private handleEvent(event: EventFrame, generation: number): void {
    switch (event.event) {
      case "sessions.changed":
        this.handleSessionsChanged(event.payload, generation);
        return;
      case "session.message": {
        const key = asRecord(event.payload)?.sessionKey;
        if (typeof key === "string" && this.openSessions.has(key)) this.scheduleHistory(key);
        return;
      }
      case "chat":
        this.handleChat(event);
        return;
      default:
        return;
    }
  }

  // Helpers --------------------------------------------------------------------

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.protocol) return Promise.reject(new Error("not connected"));
    return this.protocol.request(method, params);
  }

  private setConnection(patch: Partial<ConnectionState>): void {
    this.store.update((state) => ({ ...state, connection: { ...state.connection, ...patch } }));
  }

  private async loadIdentity() {
    this.identity ??= await this.host.signer.loadIdentity();
    return this.identity;
  }

  private async loadToken(deviceId: string, role: string): Promise<StoredDeviceToken | null> {
    const raw = await this.host.storage.get(this.tokenKey(deviceId, role));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredDeviceToken> & { scopes?: string[] };
    if (typeof parsed.token !== "string") return null;
    // Earlier builds stored the grant as `scopes`.
    return { token: parsed.token, grantedScopes: parsed.grantedScopes ?? parsed.scopes ?? [] };
  }

  private tokenParams(deviceId: string) {
    return { clientId: CLIENT_ID, deviceId, role: "operator" };
  }

  /** Device tokens are scoped to one gateway, so a token is never offered to another. */
  private tokenKey(deviceId: string, role: string): string {
    const url = this.settings?.url ?? "";
    return `deviceToken:${encodeURIComponent(url)}:${deviceId}:${role}`;
  }

  private now(): number {
    return this.host.now?.() ?? Date.now();
  }

  private randomId(): string {
    if (this.host.randomId) return this.host.randomId();
    const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  private log(level: "debug" | "info" | "warn" | "error", message: string): void {
    this.host.log?.(level, message);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
