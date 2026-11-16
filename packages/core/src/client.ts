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
import type { ClawtrateHost } from "./host.ts";
import {
  asRecord,
  groupTasks,
  isSessionRemoval,
  liveTextFromChatMessage,
  mapAgents,
  mapHistory,
  mergeSessionRow,
  sessionChangeRow,
  sessionRowKey,
  sessionRowsFromList,
  type RawRecord,
} from "./mapping.ts";
import { createStore, type Store } from "./store.ts";
import {
  initialConnectionState,
  initialState,
  type ClawtrateState,
  type ConnectionState,
  type Transcript,
} from "./types.ts";

/** This slice reads only. Request nothing beyond what it uses. */
export const REQUESTED_SCOPES = ["operator.read"] as const;
/**
 * Client capabilities advertised in `connect`. Empty on purpose: this slice does
 * not render live tool events or approvals, so it claims none of those contracts.
 */
export const CLIENT_CAPS: readonly string[] = [];
/** A registered client id for third-party operator UIs; we do not claim an OpenClaw product id. */
export const CLIENT_ID = "gateway-client";
export const CLIENT_MODE = "ui";

const SESSION_LIST_PARAMS = {
  limit: 200,
  includeDerivedTitles: true,
  includeLastMessage: true,
  excludeCron: true,
  excludeSubagents: true,
};
const HISTORY_LIMIT = 200;
const PAIRING_RETRY_MS = 3000;

const SETTINGS_KEY = "connection";

export type ConnectionSettings = { url: string; token: string | null };

export type ConnectOptions = { url: string; token?: string | null };

type Plan = GatewayBrowserDeviceAuthPlan;

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

export class ClawtrateClient {
  readonly store: Store<ClawtrateState> = createStore(initialState);

  private readonly host: ClawtrateHost;
  private readonly lifecycle: GatewayBrowserDeviceAuthLifecycle;
  private readonly tokenStore: GatewayBrowserDeviceTokenStore;
  private protocol: GatewayProtocolClient<Plan> | null = null;
  private settings: ConnectionSettings | null = null;
  private identity: { deviceId: string; publicKey: string } | null = null;
  /** Bumped for every new connection so late responses from an old one are dropped. */
  private generation = 0;
  private rows = new Map<string, RawRecord>();
  private readonly openSessions = new Set<string>();
  private readonly streams = new GatewayChatStreamProjection();
  private readonly historyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private bootstrapping = false;
  private changedDuringBootstrap = false;

  constructor(host: ClawtrateHost) {
    this.host = host;
    this.tokenStore = {
      load: async ({ deviceId, role }) => {
        const raw = await host.storage.get(this.tokenKey(deviceId, role));
        return raw ? (JSON.parse(raw) as { token: string; scopes: string[] }) : null;
      },
      store: async ({ deviceId, role, token, scopes }) => {
        await host.storage.set(this.tokenKey(deviceId, role), JSON.stringify({ token, scopes }));
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

  /** Resume the saved gateway, if any. */
  async start(): Promise<void> {
    const identity = await this.loadIdentity();
    this.setConnection({ deviceId: identity.deviceId });
    const raw = await this.host.storage.get(SETTINGS_KEY);
    if (!raw) return;
    this.settings = JSON.parse(raw) as ConnectionSettings;
    await this.open();
  }

  /** Connect to a gateway. A token is only needed until this device is paired. */
  async connect(options: ConnectOptions): Promise<void> {
    const url = validateGatewayUrl(options.url);
    const token = options.token?.trim() || null;
    this.settings = { url, token };
    await this.host.storage.set(SETTINGS_KEY, JSON.stringify(this.settings));
    await this.open();
  }

  /** Close the connection and forget the gateway. The device key and any device token remain. */
  async disconnect(): Promise<void> {
    this.close();
    this.settings = null;
    await this.host.storage.delete(SETTINGS_KEY);
    this.store.set({
      ...initialState,
      connection: { ...initialConnectionState, deviceId: this.identity?.deviceId ?? null },
    });
  }

  /** Reconnect immediately, for example right after a pairing request was approved. */
  async retryNow(): Promise<void> {
    if (!this.settings) return;
    await this.open();
  }

  /** Stop without forgetting anything. Used when the host process exits. */
  stop(): void {
    this.close();
  }

  openSession(key: string): void {
    this.openSessions.add(key);
    this.setTranscript(
      key,
      (current) =>
        current ?? {
          sessionKey: key,
          status: "loading",
          items: [],
          error: null,
          hasMore: false,
          live: null,
        },
    );
    if (this.state.connection.status === "connected") void this.loadTranscript(key, true);
  }

  closeSession(key: string): void {
    if (!this.openSessions.delete(key)) return;
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

  // Connection lifecycle -------------------------------------------------------

  private async open(): Promise<void> {
    this.close();
    const settings = this.settings;
    if (!settings) return;
    const generation = ++this.generation;
    const identity = await this.loadIdentity();
    const paired = (await this.tokenStore.load(this.tokenParams(identity.deviceId))) !== null;
    this.rows = new Map();
    this.store.set({
      ...initialState,
      connection: {
        ...initialConnectionState,
        status: "connecting",
        gatewayUrl: settings.url,
        deviceId: identity.deviceId,
        paired,
      },
      transcripts: Object.fromEntries(
        [...this.openSessions].map((key) => [key, this.emptyTranscript(key)]),
      ),
    });

    const client = {
      id: CLIENT_ID,
      displayName: this.host.client.displayName,
      version: this.host.client.version,
      platform: this.host.client.platform,
      mode: CLIENT_MODE,
    } as const;

    this.protocol = new GatewayProtocolClient<Plan>({
      createSocket: (handlers) => {
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
        const stored = await this.tokenStore.load(this.tokenParams(identity.deviceId));
        // Once paired, the device token is the credential; the bootstrap token is no longer sent.
        const bootstrap = stored ? null : settings.token;
        return this.lifecycle.buildPlan({
          client,
          role: "operator",
          defaultScopes: REQUESTED_SCOPES,
          ...(bootstrap ? { token: bootstrap } : {}),
          nonce,
          challengeTs: challengeTs ?? null,
        });
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
        this.handleHello(hello, generation);
      },
      onConnectFailure: async (error) => this.handleConnectFailure(error, identity.deviceId),
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
        if (status === "connected") this.setConnection({ status: "reconnecting" });
        else if (status !== "pairing" && status !== "error")
          this.setConnection({ status: "connecting" });
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
      reconnect: { initialMs: 1000, multiplier: 2, maxMs: 30_000 },
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

  private handleConnectFailure(error: GatewayProtocolRequestError, deviceId: string) {
    const details = asRecord(error.details) ?? {};
    const code = typeof details.code === "string" ? details.code : error.gatewayCode;
    const hint = typeof details.remediationHint === "string" ? details.remediationHint : null;

    if (code === "PAIRING_REQUIRED") {
      const requestId = typeof details.requestId === "string" ? details.requestId : "";
      const scopes = Array.isArray(details.requestedScopes)
        ? details.requestedScopes.filter((s): s is string => typeof s === "string")
        : [...REQUESTED_SCOPES];
      this.setConnection({
        status: "pairing",
        error: null,
        pairing: {
          requestId,
          deviceId: typeof details.deviceId === "string" ? details.deviceId : deviceId,
          message: hint ?? "Approve this device from the gateway's pending pairing requests.",
          approveCommand: `openclaw devices approve ${requestId}`,
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
      status: pause ? "error" : "connecting",
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
    this.setConnection({
      status: "connected",
      serverVersion: hello.server.version,
      protocol: hello.protocol,
      scopes: [...(hello.auth.scopes ?? [])],
      pairing: null,
      error: null,
      retryAt: null,
      paired: true,
    });
    void this.bootstrap(generation);
  }

  /** Every successful connect is a fresh projection: re-list, re-subscribe, reload open transcripts. */
  private async bootstrap(generation: number): Promise<void> {
    this.bootstrapping = true;
    this.changedDuringBootstrap = false;
    try {
      const [agents, subscribed] = await Promise.all([
        this.request("agents.list", {}),
        this.request("sessions.subscribe", SESSION_LIST_PARAMS),
      ]);
      if (generation !== this.generation) return;
      this.store.update((state) => ({ ...state, bots: mapAgents(agents) }));
      this.replaceRows(asRecord(subscribed)?.list);
      this.bootstrapping = false;
      if (this.changedDuringBootstrap) await this.refreshSessions(generation);
      for (const key of this.openSessions) void this.loadTranscript(key, true);
    } catch (error) {
      this.log("error", `bootstrap failed: ${String(error)}`);
    } finally {
      this.bootstrapping = false;
    }
  }

  // Sessions -------------------------------------------------------------------

  private replaceRows(list: unknown): void {
    this.rows = new Map(sessionRowsFromList(list).map((row) => [sessionRowKey(row)!, row]));
    this.publishTasks();
  }

  private publishTasks(): void {
    const tasksByBot = groupTasks(this.rows.values());
    this.store.update((state) => ({ ...state, tasksByBot }));
  }

  private async refreshSessions(generation: number): Promise<void> {
    try {
      const list = await this.request("sessions.list", SESSION_LIST_PARAMS);
      if (generation === this.generation) this.replaceRows(list);
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

  private handleSessionsChanged(payload: unknown, generation: number): void {
    if (this.bootstrapping) this.changedDuringBootstrap = true;
    const row = sessionChangeRow(payload);
    const key = row ? sessionRowKey(row) : null;
    if (!row || !key) {
      this.scheduleRefresh(generation);
      return;
    }
    if (isSessionRemoval(payload)) {
      this.rows.delete(key);
    } else if (this.rows.has(key) || typeof row.agentId === "string") {
      this.rows.set(key, mergeSessionRow(this.rows.get(key), row));
    } else {
      this.scheduleRefresh(generation);
      return;
    }
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
      }));
    } catch (error) {
      if (generation !== this.generation || !this.openSessions.has(key)) return;
      this.setTranscript(key, (current) => ({
        ...(current ?? this.emptyTranscript(key)),
        status: "error",
        error: error instanceof Error ? error.message : String(error),
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
