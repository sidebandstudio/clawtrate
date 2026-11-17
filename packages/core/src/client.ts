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
import { GatewayScopeUpgrade } from "@openclaw/gateway-client/scope-upgrade";
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
  activeRun,
  applyAgentEvent,
  applyChatEvent,
  applyQuestionRequested,
  applyQuestionResolved,
  bindRun,
  cancelQueuedRun,
  dropUnboundRun,
  emptyActivity,
  failRun,
  failRunStart,
  findRun,
  isActive,
  isTerminal,
  markQuestion,
  maxHistorySeq,
  mergeHistoryRuns,
  queueLocalRun,
  RawTable,
  reconcileOutbox,
  registerSteerAlias,
  removeMessage,
  requestStop,
  revertStop,
  runsFromHistory,
  settleMissingQuestions,
  startLocalRun,
  startQueuedRun,
  updateMessage,
  type CaughtUp,
  type EngineContext,
  type OutgoingMessage,
  type Run,
  type StepRaw,
  type TaskActivity,
} from "./runs.ts";
import {
  heldFromGrant,
  INTERACTIVE_SCOPES,
  normalizeHeldScopes,
  QUESTIONS_SCOPE,
  READ_SCOPES,
  scopeSatisfied,
  WRITE_SCOPE,
} from "./scopes.ts";
import { createStore, type Store } from "./store.ts";
import {
  initialConnectionState,
  initialScopeUpgrade,
  initialState,
  type ClawtrateState,
  type ConnectionState,
  type DiscoveryState,
  type ScopeUpgradeState,
  type Transcript,
} from "./types.ts";

/** A read-only connection's scopes. Every connect asks for these until write access is approved. */
export const REQUESTED_SCOPES = ["operator.read"] as const;
/**
 * Client capabilities advertised in `connect`. `tool-events` is the only one
 * the live run view needs: without it the gateway sends no tool lifecycle
 * events. Approval caps are not claimed, because this client does not show or
 * resolve approvals.
 */
export const CLIENT_CAPS: readonly string[] = ["tool-events"];
/** A registered client id for third-party operator UIs; we do not claim an OpenClaw product id. */
export const CLIENT_ID = "gateway-client";
export const CLIENT_MODE = "ui";

/** One page of the task list. Pages are read until the gateway reports no more. */
export const SESSION_PAGE_SIZE = 200;
/** A ceiling so a huge gateway cannot make one reconnect read forever. */
export const MAX_SESSION_PAGES = 50;
/** Clawtrate's turn limit (F-100): a run this client started fails after it. */
export const DEFAULT_TURN_LIMIT_MS = 50 * 60_000;
/** Longest message text the client sends. */
export const MAX_MESSAGE_CHARS = 32_000;
/** The gateway's frame ceiling after `connect` when `hello-ok.policy.maxPayload` is absent (25 MiB). */
export const DEFAULT_MAX_PAYLOAD_BYTES = 26_214_400;
/** Decoded image ceiling `chat.send` enforces (6 MiB). */
export const MAX_IMAGE_BYTES = 6_291_456;
/** Decoded per-file ceiling `chat.send` enforces by default (`agents.defaults.mediaMaxMb`, 20 MiB). */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Room left in a frame for the request envelope around the params. */
const FRAME_SLACK_BYTES = 1024;
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

export type ConnectionSettings = { url: string; token: string | null };

export type ConnectOptions = { url: string; token?: string | null };

/**
 * How to deliver a message while the task has an active run. Either way a
 * message to an idle task starts a new run, and a message sent while the run is
 * stopping is queued (§5.6). `auto` is the composer's Enter: a steer while the
 * run is running or waiting. `queue` is "Queue after this turn".
 */
export type SendMode = "auto" | "queue";

export type ClientOptions = {
  /**
   * Gateways this client may open. Checked before every connection, including
   * a saved one resumed at start and every retry.
   */
  allowGatewayUrl?: (url: string) => boolean;
  /** Reconnect backoff. Tests shorten it. */
  reconnect?: { initialMs: number; maxMs: number };
  /** Turn limit for runs this client starts. */
  turnLimitMs?: number;
};

/** A file sent with a message, as `chat.send` takes it: base64 content. */
export type OutgoingAttachment = {
  type: string;
  mimeType: string;
  fileName: string;
  content: string;
};

export type SendOptions = { mode?: SendMode; attachments?: OutgoingAttachment[] };

/**
 * A send that would break a gateway ceiling. Checked before anything reaches
 * the socket: an oversized frame would close the connection with code 1009 and
 * no answer, and an oversized image or file would be refused anyway.
 */
export class SendTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SendTooLargeError";
  }
}

function decodedBytes(base64: string): number {
  const clean = base64.replace(/\s+/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

function isImage(attachment: OutgoingAttachment): boolean {
  return attachment.type === "image" || attachment.mimeType.toLowerCase().startsWith("image/");
}

type Plan = GatewayBrowserDeviceAuthPlan;

/**
 * A device token record. `grantedScopes` is what the gateway granted and is
 * kept for reference only. `heldScopes` is what this client means to hold and
 * is the only thing a connect ever requests.
 */
type StoredDeviceToken = { token: string; grantedScopes: string[]; heldScopes: string[] };

type Waiter = { scope: string; resolve: () => void; reject: (error: Error) => void };

/** The interactive scopes were asked for and not granted. */
export class AccessRequestError extends Error {
  readonly status: "rejected" | "expired" | "error";
  constructor(status: "rejected" | "expired" | "error", detail?: string) {
    super(
      status === "rejected"
        ? "The gateway's owner did not approve sending and answering from this device."
        : status === "expired"
          ? "The request to send and answer from this device expired before it was approved."
          : `Access could not be requested${detail ? `: ${detail}` : "."}`,
    );
    this.name = "AccessRequestError";
    this.status = status;
  }
}

function isRetryableNetworkFailure(error: Error): boolean {
  return !(error instanceof GatewayProtocolRequestError);
}

function isMissingScope(error: unknown): boolean {
  return (
    error instanceof GatewayProtocolRequestError &&
    asRecord(error.details)?.code === "MISSING_SCOPE"
  );
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

function hasPendingQuestion(run: Run): boolean {
  return run.pendingCards.some((card) => card.kind === "question");
}

function withLive(transcript: Transcript): Transcript {
  const active = transcript.runs.find((run) => isActive(run.state));
  const live = active ? { runId: active.id, text: active.text } : null;
  const same =
    live === transcript.live ||
    (live !== null &&
      transcript.live !== null &&
      live.runId === transcript.live.runId &&
      live.text === transcript.live.text);
  return same ? transcript : { ...transcript, live };
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
  /** Why a pending history reload runs, when it is a resync. */
  private readonly resyncReasons = new Map<string, CaughtUp["reason"]>();
  /** Highest transcript seq loaded per task. */
  private readonly historySeq = new Map<string, number>();
  private readonly raw = new RawTable();
  private readonly turnTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private bootstrapping = false;
  private changedDuringBootstrap = false;
  /** Set by the protocol client's gap callback; the reconnect it forces reloads with this reason. */
  private pendingResync: CaughtUp["reason"] | null = null;
  /** The next hello follows a reconnect this client made on purpose, so it is not a resync. */
  private quietReconnect = false;
  /** The user asked for write access and it is not settled yet. */
  private upgradeWanted = false;
  private scopeUpgrade: GatewayScopeUpgrade | null = null;
  private accessWaiters: Waiter[] = [];
  /** `hello-ok.policy`, for the frame and attachment ceilings. */
  private policy: RawRecord | null = null;
  /** Attachment content for outgoing messages, kept off the state snapshots. */
  private readonly attachmentContent = new Map<string, OutgoingAttachment[]>();

  constructor(host: ClawtrateHost, options: ClientOptions = {}) {
    this.host = host;
    this.options = options;
    this.tokenStore = {
      // The lifecycle uses the record's scopes for reconnects. Report the
      // scopes this client means to hold, so a broader grant is never asked for.
      load: async ({ deviceId, role }) => {
        const record = await this.loadToken(deviceId, role);
        return record ? { token: record.token, scopes: [...record.heldScopes] } : null;
      },
      store: async ({ deviceId, role, token, scopes }) => {
        const existing = await this.loadToken(deviceId, role);
        await this.writeToken(deviceId, role, {
          token,
          grantedScopes: scopes,
          heldScopes: existing?.heldScopes ?? [...READ_SCOPES],
        });
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

  /** Resume the saved gateway, if any and if allowed. */
  async start(): Promise<void> {
    const identity = await this.loadIdentity();
    this.setConnection({ deviceId: identity.deviceId });
    this.settings = await this.savedSettings();
    if (this.settings) await this.open();
  }

  /** Connect to a gateway. A token is only needed until this device is paired. */
  async connect(options: ConnectOptions): Promise<void> {
    const url = validateGatewayUrl(options.url);
    if (!this.isAllowed(url)) throw new GatewayNotAllowedError(url);
    const token = options.token?.trim() || null;
    if (this.settings?.url !== url) this.abandonAccessRequest("Switched to another gateway.");
    this.settings = { url, token };
    await this.host.storage.set(SETTINGS_KEY, JSON.stringify(this.settings));
    await this.open();
  }

  /** Close the connection and forget the gateway. The device key and any device token remain. */
  async disconnect(): Promise<void> {
    this.abandonAccessRequest("Disconnected from the gateway.");
    this.close();
    this.settings = null;
    this.rows = new Map();
    this.raw.clear();
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
      await this.bootstrap(this.generation, null);
      return;
    }
    await this.open();
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
    if (this.state.connection.status === "connected") void this.loadTranscript(key, true, null);
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
    this.resyncReasons.delete(key);
    this.historySeq.delete(key);
    this.raw.clearTask(key);
    this.clearTurnTimers(key);
    for (const message of this.state.transcripts[key]?.outbox ?? []) {
      this.attachmentContent.delete(message.id);
    }
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

  // Write access ----------------------------------------------------------------

  /**
   * Ask the gateway's owner, in one request, for the interactive scopes
   * (`operator.write`, `operator.approvals`, `operator.questions`) through
   * `device.scopes.requestUpgrade`. Returns once the request is under way; the
   * pending request id and approve command appear in `connection.upgrade`.
   * When it is approved the client stores the rotated device token and
   * reconnects asking for exactly what was granted of that set.
   */
  async requestAccess(): Promise<void> {
    if (INTERACTIVE_SCOPES.every((scope) => this.holds(scope))) return;
    if (!this.settings) throw new Error("Connect to a gateway first.");
    this.upgradeWanted = true;
    if (this.state.connection.status === "connected") this.startUpgrade();
  }

  private holds(scope: string): boolean {
    const connection = this.state.connection;
    return connection.status === "connected" && scopeSatisfied(connection.scopes, scope);
  }

  private setUpgrade(patch: Partial<ScopeUpgradeState>): void {
    this.store.update((state) => ({
      ...state,
      connection: { ...state.connection, upgrade: { ...state.connection.upgrade, ...patch } },
    }));
  }

  private startUpgrade(): void {
    const protocol = this.protocol;
    const identity = this.identity;
    const url = this.settings?.url;
    if (this.scopeUpgrade || !protocol || !identity || !url) return;
    const target = [...INTERACTIVE_SCOPES];
    const upgrade = new GatewayScopeUpgrade({
      request: (method, params, options) => protocol.request(method, params, options),
      tokenStore: {
        load: this.tokenStore.load,
        clear: this.tokenStore.clear,
        // The rotated token carries the new grant; from now on connect asks for exactly what it covers.
        store: async ({ deviceId, role, token, scopes }) => {
          await this.writeToken(deviceId, role, {
            token,
            grantedScopes: scopes,
            heldScopes: heldFromGrant(scopes),
          });
        },
      },
      reconnect: () => {
        this.quietReconnect = true;
        void this.open();
      },
    });
    this.scopeUpgrade = upgrade;
    this.setUpgrade({
      ...initialScopeUpgrade,
      status: "requesting",
      scopes: target,
    });
    upgrade
      .requestScopeUpgrade({
        binding: { clientId: CLIENT_ID, deviceId: identity.deviceId, role: "operator" },
        scopes: target,
        onPending: (requestId) => {
          const instructions = (this.host.approvalInstructions ?? defaultApprovalInstructions)(
            url,
            requestId,
          );
          this.setUpgrade({
            status: "pending",
            requestId,
            approveCommand: instructions.command,
            approveNote: instructions.note,
          });
        },
      })
      .then(
        (outcome) => {
          if (this.scopeUpgrade === upgrade) this.scopeUpgrade = null;
          if (outcome.status === "approved") {
            if (!scopeSatisfied(outcome.scopes, WRITE_SCOPE)) {
              this.failAccess(
                new AccessRequestError(
                  "error",
                  `the gateway granted only ${outcome.scopes.join(", ")}`,
                ),
              );
              return;
            }
            // Settled. The reconnect is under way; its hello settles the waiters.
            this.upgradeWanted = false;
            this.setUpgrade({ status: "approved", error: null });
            return;
          }
          this.failAccess(new AccessRequestError(outcome.status));
        },
        (error: unknown) => {
          if (this.scopeUpgrade === upgrade) this.scopeUpgrade = null;
          if (!this.upgradeWanted) return;
          if (!(error instanceof GatewayProtocolRequestError) && !this.protocol?.connected) {
            // The connection dropped while waiting. Ask again after the next hello.
            return;
          }
          this.failAccess(new AccessRequestError("error", errorMessage(error)));
        },
      );
  }

  private failAccess(error: AccessRequestError): void {
    this.upgradeWanted = false;
    this.setUpgrade({ status: error.status, error: error.message });
    const waiters = this.accessWaiters;
    this.accessWaiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }

  private abandonAccessRequest(reason: string): void {
    this.scopeUpgrade?.cancelScopeUpgrade();
    this.scopeUpgrade = null;
    this.upgradeWanted = false;
    const waiters = this.accessWaiters;
    this.accessWaiters = [];
    for (const waiter of waiters) waiter.reject(new Error(reason));
  }

  /** After a hello: resolve waiters the grant covers; once nothing is being asked for, refuse the rest. */
  private settleAccessWaiters(): void {
    const waiters = this.accessWaiters;
    this.accessWaiters = [];
    for (const waiter of waiters) {
      if (this.holds(waiter.scope)) waiter.resolve();
      else if (this.upgradeWanted) this.accessWaiters.push(waiter);
      else waiter.reject(new Error(`The gateway did not grant ${waiter.scope}.`));
    }
  }

  /**
   * Resolves once the connection holds `scope`. When the client does not mean
   * to hold it yet, this asks for the interactive scopes; when it already does
   * (the connection is only down), it waits for the next hello.
   */
  private ensureScope(scope: string): Promise<void> {
    if (this.holds(scope)) return Promise.resolve();
    const waiting = new Promise<void>((resolve, reject) => {
      this.accessWaiters.push({ scope, resolve, reject });
    });
    if (!this.state.connection.requestedScopes.includes(scope)) {
      this.requestAccess().catch((error: unknown) => {
        this.failAccess(new AccessRequestError("error", errorMessage(error)));
      });
    } else if (this.state.connection.status === "connected") {
      // Held, yet this connection lacks it: the gateway capped the grant.
      this.settleAccessWaiters();
    }
    return waiting;
  }

  // Sending ---------------------------------------------------------------------

  /**
   * Send a message to an open task. It shows at once in the task's outbox and
   * leaves it when history holds it. The idempotency key is the message id,
   * so a retry is never delivered twice. Returns the message id. Throws
   * `SendTooLargeError` before anything is sent when it would break a ceiling.
   */
  sendMessage(key: string, text: string, options: SendOptions = {}): string {
    const transcript = this.state.transcripts[key];
    if (!transcript) throw new Error("Open the task before sending to it.");
    const body = text.trim();
    const attachments = options.attachments ?? [];
    if (!body && attachments.length === 0) throw new Error("The message is empty.");
    if (body.length > MAX_MESSAGE_CHARS) throw new Error("The message is too long.");
    this.checkSize(this.sendParams(key, body, "x".repeat(36), "followup", attachments));
    const active = activeRun(transcript);
    const resolved = !active
      ? "new"
      : active.state === "stopping" || options.mode === "queue"
        ? "queue"
        : "steer";
    const held = resolved === "steer" && hasPendingQuestion(active!);
    const message: OutgoingMessage = {
      id: this.randomId(),
      text: body,
      mode: resolved,
      status: resolved === "queue" ? "queued" : held ? "held" : "sending",
      runId: resolved === "steer" ? active!.id : null,
      messageSeq: null,
      afterSeq: this.historySeq.get(key) ?? 0,
      createdAt: this.now(),
      error: null,
      attachments: attachments.map((attachment) => ({
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        sizeBytes: decodedBytes(attachment.content),
      })),
    };
    if (attachments.length > 0) this.attachmentContent.set(message.id, attachments);
    this.updateActivity(key, (activity) => {
      const withMessage = { ...activity, outbox: [...activity.outbox, message] };
      if (resolved === "new") return startLocalRun(withMessage, message, this.now());
      if (resolved === "queue") return queueLocalRun(withMessage, message, this.now());
      return withMessage;
    });
    if (message.status === "sending") void this.deliver(key, message.id);
    return message.id;
  }

  private sendParams(
    key: string,
    text: string,
    idempotencyKey: string,
    queueMode: "steer" | "followup",
    attachments: OutgoingAttachment[],
  ) {
    return {
      sessionKey: key,
      message: text,
      idempotencyKey,
      // Always the mode meant: with none the gateway steers.
      queueMode,
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  }

  /** Refuse a send that breaks the image, file or frame ceiling, before it reaches the socket. */
  private checkSize(params: { attachments?: OutgoingAttachment[] }): void {
    const limits = asRecord(this.policy?.attachments);
    const imageLimit =
      typeof limits?.maxImageBytes === "number"
        ? Math.min(limits.maxImageBytes, MAX_IMAGE_BYTES)
        : MAX_IMAGE_BYTES;
    for (const attachment of params.attachments ?? []) {
      const size = decodedBytes(attachment.content);
      const limit = isImage(attachment) ? imageLimit : MAX_FILE_BYTES;
      if (size > limit) {
        throw new SendTooLargeError(
          `${attachment.fileName} is ${size} bytes; the gateway accepts ${isImage(attachment) ? "images" : "files"} up to ${limit} bytes.`,
        );
      }
    }
    const maxPayload =
      typeof this.policy?.maxPayload === "number"
        ? this.policy.maxPayload
        : DEFAULT_MAX_PAYLOAD_BYTES;
    const frame = utf8Bytes(JSON.stringify(params)) + FRAME_SLACK_BYTES;
    if (frame > maxPayload) {
      throw new SendTooLargeError(
        `The message and its files come to ${frame} bytes; one message can carry at most ${maxPayload}.`,
      );
    }
  }

  /** Send a failed message again, with the same idempotency key. */
  retryMessage(key: string, messageId: string): void {
    const message = this.outgoing(key, messageId);
    if (!message || message.status !== "failed") return;
    const transcript = this.state.transcripts[key]!;
    const active = activeRun(transcript);
    const mode = !active ? "new" : active.state === "stopping" ? "queue" : "steer";
    const held = mode === "steer" && hasPendingQuestion(active!);
    this.updateActivity(key, (activity) => {
      // A run the gateway refused never started; the retry is a new attempt.
      const cleared = {
        ...activity,
        runs: activity.runs.filter(
          (run) => !(run.id === messageId && run.origin === "local" && !run.bound),
        ),
      };
      const next = updateMessage(cleared, messageId, {
        mode,
        status: mode === "queue" ? "queued" : held ? "held" : "sending",
        error: null,
        runId: mode === "steer" ? active!.id : null,
      });
      const updated = next.outbox.find((each) => each.id === messageId)!;
      if (mode === "new") return startLocalRun(next, updated, this.now());
      if (mode === "queue") return queueLocalRun(next, updated, this.now());
      return next;
    });
    if (mode !== "queue" && !held) void this.deliver(key, messageId);
  }

  /** Remove a failed or cancelled message, and the run that never started with it. */
  deleteMessage(key: string, messageId: string): void {
    const message = this.outgoing(key, messageId);
    if (!message || (message.status !== "failed" && message.status !== "cancelled")) return;
    this.attachmentContent.delete(messageId);
    this.updateActivity(key, (activity) => ({
      ...removeMessage(activity, messageId),
      runs: activity.runs.filter(
        (run) => !(run.id === messageId && run.origin === "local" && !run.bound),
      ),
    }));
  }

  /** "Cancel" on a queued message's chip: it never runs. */
  cancelQueued(key: string, messageId: string): void {
    const message = this.outgoing(key, messageId);
    if (!message || message.status !== "queued") return;
    this.updateActivity(key, (activity) =>
      updateMessage(cancelQueuedRun(activity, messageId, this.now()), messageId, {
        status: "cancelled",
      }),
    );
  }

  /** "Send now" on a queued message's chip: a steer into the running or waiting run. */
  sendQueuedNow(key: string, messageId: string): void {
    const message = this.outgoing(key, messageId);
    if (!message || message.status !== "queued") return;
    const active = activeRun(this.state.transcripts[key]!);
    if (active?.state === "stopping")
      throw new Error("Send now is unavailable while the run stops.");
    this.updateActivity(key, (activity) => {
      if (!active)
        return startQueuedRun(
          updateMessage(activity, messageId, { status: "sending" }),
          messageId,
          this.now(),
        );
      const withoutQueued = {
        ...activity,
        runs: activity.runs.filter((run) => run.id !== messageId),
      };
      const held = hasPendingQuestion(active);
      return updateMessage(withoutQueued, messageId, {
        mode: "steer",
        status: held ? "held" : "sending",
        runId: active.id,
      });
    });
    if (this.outgoing(key, messageId)?.status === "sending") void this.deliver(key, messageId);
  }

  /**
   * Create a task under a bot with its first message. `sessions.create`
   * carries only `agentId`, `message`, `idempotencyKey` and `label`, which keep
   * it at `operator.write`. The caller holds one interest in the new task, as
   * if it had called `openSession`, and releases it with `closeSession`.
   */
  async createTask(botId: string, text: string, options: { label?: string } = {}): Promise<string> {
    const body = text.trim();
    if (!body) throw new Error("The message is empty.");
    if (body.length > MAX_MESSAGE_CHARS) throw new Error("The message is too long.");
    await this.ensureScope(WRITE_SCOPE);
    const id = this.randomId();
    const label = options.label?.trim();
    const result = asRecord(
      await this.request("sessions.create", {
        agentId: botId,
        message: body,
        idempotencyKey: id,
        ...(label ? { label } : {}),
      }),
    );
    const key = typeof result?.key === "string" ? result.key : null;
    if (!key) throw new Error("The gateway did not return the new task.");
    const runId = typeof result?.runId === "string" ? result.runId : null;
    const runError = asRecord(result?.runError);
    const now = this.now();
    const message: OutgoingMessage = {
      id,
      text: body,
      mode: "new",
      status: runError ? "failed" : "sent",
      runId,
      messageSeq: typeof result?.messageSeq === "number" ? result.messageSeq : null,
      afterSeq: 0,
      createdAt: now,
      error: runError ? String(runError.message ?? "The run did not start.") : null,
      attachments: [],
    };
    this.openSession(key);
    this.updateActivity(key, (activity, ctx) => {
      let next = startLocalRun(
        { ...activity, outbox: [...activity.outbox, message] },
        message,
        now,
      );
      if (runId) next = bindRun(next, id, runId);
      if (runError) {
        next = failRunStart(
          next,
          runId ?? id,
          {
            message: message.error!,
            kind: typeof runError.code === "string" ? runError.code : "not-started",
          },
          ctx,
        );
      } else if (!runId) {
        next = dropUnboundRun(next, id);
      }
      return next;
    });
    return key;
  }

  private outgoing(key: string, messageId: string): OutgoingMessage | undefined {
    return this.state.transcripts[key]?.outbox.find((message) => message.id === messageId);
  }

  /** Deliver one outgoing message with `chat.send`, once write access is held. */
  private async deliver(key: string, messageId: string): Promise<void> {
    if (!this.state.connection.canWrite) {
      this.updateActivity(key, (activity) =>
        updateMessage(activity, messageId, { status: "awaiting-access" }),
      );
    }
    try {
      await this.ensureScope(WRITE_SCOPE);
    } catch (error) {
      this.failDelivery(key, messageId, error, true);
      return;
    }
    let message = this.outgoing(key, messageId);
    if (!message || (message.status !== "sending" && message.status !== "awaiting-access")) return;

    // The active run may have changed while access was pending.
    if (message.mode === "steer") {
      const active = activeRun(this.state.transcripts[key]!);
      if (!active) {
        this.updateActivity(key, (activity) => {
          const next = updateMessage(activity, messageId, { mode: "new", runId: null });
          return startLocalRun(
            next,
            next.outbox.find((each) => each.id === messageId)!,
            this.now(),
          );
        });
      } else if (active.state === "stopping") {
        this.updateActivity(key, (activity) => {
          const next = updateMessage(activity, messageId, {
            mode: "queue",
            status: "queued",
            runId: null,
          });
          return queueLocalRun(
            next,
            next.outbox.find((each) => each.id === messageId)!,
            this.now(),
          );
        });
        return;
      } else if (hasPendingQuestion(active)) {
        // A plain message would answer the question and break the run; hold it.
        this.updateActivity(key, (activity) =>
          updateMessage(activity, messageId, { status: "held", runId: active.id }),
        );
        return;
      } else if (active.id !== message.runId) {
        this.updateActivity(key, (activity) =>
          updateMessage(activity, messageId, { runId: active.id }),
        );
      }
    }
    this.updateActivity(key, (activity) =>
      updateMessage(activity, messageId, { status: "sending" }),
    );
    message = this.outgoing(key, messageId)!;

    let result: RawRecord | null;
    try {
      const params = this.sendParams(
        key,
        message.text,
        message.id,
        message.mode === "steer" ? "steer" : "followup",
        this.attachmentContent.get(messageId) ?? [],
      );
      this.checkSize(params);
      result = asRecord(await this.request("chat.send", params));
    } catch (error) {
      if (isMissingScope(error)) this.setConnection({ canWrite: false });
      this.failDelivery(
        key,
        messageId,
        error,
        error instanceof GatewayProtocolRequestError || error instanceof SendTooLargeError,
      );
      return;
    }
    const runId = typeof result?.runId === "string" ? result.runId : null;
    const messageSeq = typeof result?.messageSeq === "number" ? result.messageSeq : null;
    const steeredInto = message.mode === "steer" ? message.runId : null;
    this.updateActivity(key, (activity) => {
      let next = updateMessage(activity, messageId, {
        status: "sent",
        messageSeq,
        runId: steeredInto ?? runId ?? messageId,
      });
      if (message.mode === "steer") {
        // The steer's own run id settles at once; the reply streams under the run it joined.
        if (steeredInto && runId) next = registerSteerAlias(next, runId, steeredInto);
      } else if (runId) {
        next = bindRun(next, messageId, runId);
      }
      return next;
    });
    this.attachmentContent.delete(messageId);
    this.scheduleHistory(key);
  }

  /**
   * A send failed. A gateway refusal is definitive: the run "Couldn't start".
   * Anything else leaves the outcome unknown, so the optimistic run is dropped;
   * the message can be retried with the same idempotency key either way.
   */
  private failDelivery(key: string, messageId: string, error: unknown, definitive: boolean): void {
    const message = this.outgoing(key, messageId);
    if (!message) return;
    this.updateActivity(key, (activity, ctx) => {
      let next = updateMessage(activity, messageId, {
        status: "failed",
        error: errorMessage(error),
      });
      if (message.mode !== "steer" && findRun(next, messageId)) {
        next = definitive
          ? failRunStart(
              next,
              messageId,
              { message: errorMessage(error), kind: "not-started" },
              ctx,
            )
          : dropUnboundRun(next, messageId);
      }
      return next;
    });
  }

  // Stopping --------------------------------------------------------------------

  /**
   * Stop a running or waiting run with `chat.abort`. The run is `stopping`
   * until the gateway reports how it ended: `stopped` when the abort took,
   * `completed` with `finishedBeforeStop` when the run finished first.
   */
  async stopRun(key: string, runId: string): Promise<void> {
    const run = this.state.transcripts[key] && findRun(this.state.transcripts[key], runId);
    if (!run || (run.state !== "running" && run.state !== "waiting")) return;
    this.updateActivity(key, (activity) => requestStop(activity, runId, this.now()));
    try {
      await this.ensureScope(WRITE_SCOPE);
      const current = findRun(this.state.transcripts[key] ?? emptyActivity, runId);
      if (!current || current.state !== "stopping") return;
      const result = asRecord(
        await this.request("chat.abort", {
          sessionKey: key,
          ...(current.bound ? { runId: current.id } : {}),
        }),
      );
      // Nothing was aborted: the run ended already. Its terminal event or history settles it.
      if (result?.aborted === false) this.scheduleHistory(key);
    } catch (error) {
      if (isMissingScope(error)) this.setConnection({ canWrite: false });
      this.updateActivity(key, (activity) => revertStop(activity, runId, errorMessage(error)));
    }
  }

  // Questions -------------------------------------------------------------------

  /**
   * Answer a pending question card with `question.resolve`. `answers` maps
   * each question id to the chosen labels; typed text is just another string.
   */
  async answerQuestion(
    key: string,
    questionId: string,
    answers: Record<string, string[]>,
  ): Promise<void> {
    const question = this.pendingQuestion(key, questionId);
    const known = new Set(question.questions.map((item) => item.id));
    const entries = Object.entries(answers);
    if (entries.length === 0) throw new Error("Choose or type an answer.");
    for (const [id, values] of entries) {
      if (!known.has(id)) throw new Error(`The card has no question ${id}.`);
      if (
        !Array.isArray(values) ||
        values.length === 0 ||
        values.some((v) => typeof v !== "string")
      ) {
        throw new Error(`The answer to ${id} is empty.`);
      }
    }
    await this.resolveQuestion(key, questionId, { id: questionId, answers: { answers } });
  }

  /** Close a question card with its X: the bot is told there is no answer and carries on. */
  async dismissQuestion(key: string, questionId: string): Promise<void> {
    this.pendingQuestion(key, questionId);
    await this.resolveQuestion(key, questionId, { id: questionId, cancel: true });
  }

  private pendingQuestion(key: string, questionId: string) {
    const question = this.state.transcripts[key]?.questions.find((each) => each.id === questionId);
    if (!question || question.status !== "pending")
      throw new Error("That question is no longer open.");
    return question;
  }

  private async resolveQuestion(key: string, questionId: string, params: RawRecord): Promise<void> {
    this.updateActivity(key, (activity) =>
      markQuestion(activity, questionId, { submitting: true, error: null }),
    );
    try {
      await this.ensureScope(QUESTIONS_SCOPE);
      const result = asRecord(await this.request("question.resolve", params));
      // Apply the answer at once; `question.resolved` repeats it.
      this.updateActivity(key, (activity) =>
        applyQuestionResolved(activity, {
          id: questionId,
          status: result?.status ?? ("cancel" in params ? "cancelled" : "answered"),
          ...(result?.answers ? { answers: result.answers } : {}),
        }),
      );
    } catch (error) {
      this.updateActivity(key, (activity) =>
        markQuestion(activity, questionId, { submitting: false, error: errorMessage(error) }),
      );
      throw error;
    }
  }

  /** Pending questions for one task, from `question.list`, after it reloads. */
  private async backfillQuestions(key: string, generation: number): Promise<void> {
    if (!this.holds(QUESTIONS_SCOPE)) return;
    try {
      const result = asRecord(await this.request("question.list", {}));
      if (generation !== this.generation || !this.openSessions.has(key)) return;
      const records = (Array.isArray(result?.questions) ? result.questions : [])
        .map((entry) => asRecord(entry))
        .filter(
          (record): record is RawRecord =>
            record?.sessionKey === key && record.status === "pending",
        );
      this.updateActivity(key, (activity, ctx) => {
        let next = activity;
        for (const record of records) next = applyQuestionRequested(next, record, ctx);
        return settleMissingQuestions(next, new Set(records.map((record) => String(record.id))));
      });
    } catch (error) {
      this.log("warn", `question.list failed: ${errorMessage(error)}`);
    }
  }

  /** The exact raw call and result of a step, including ones too large to travel inline. */
  stepRaw(key: string, stepId: string): StepRaw | null {
    if (!this.state.transcripts[key]) return null;
    return this.raw.get(key, stepId);
  }

  // Activity ------------------------------------------------------------------------

  private context(key: string): EngineContext {
    return { sessionKey: key, now: this.now(), raw: this.raw };
  }

  private updateActivity(
    key: string,
    fn: (activity: TaskActivity, ctx: EngineContext) => TaskActivity,
  ): void {
    const current = this.state.transcripts[key];
    if (!current) return;
    const next = fn(current, this.context(key));
    if (next === current) return;
    this.setTranscript(key, () => withLive({ ...current, ...next }));
    this.afterActivity(key);
  }

  /** After any change: start the oldest queued run once nothing is active, and keep turn timers. */
  private afterActivity(key: string): void {
    const transcript = this.state.transcripts[key];
    if (!transcript) return;
    for (const run of transcript.runs) {
      const timerKey = `${key}\u0000${run.id}`;
      const timer = this.turnTimers.get(timerKey);
      if (isTerminal(run.state)) {
        if (timer) clearTimeout(timer);
        this.turnTimers.delete(timerKey);
      } else if (!timer && run.origin === "local" && run.bound && isActive(run.state)) {
        const limit = this.options.turnLimitMs ?? DEFAULT_TURN_LIMIT_MS;
        const elapsed = this.now() - (run.startedAt ?? this.now());
        this.turnTimers.set(
          timerKey,
          setTimeout(() => this.turnLimitReached(key, run.id), Math.max(0, limit - elapsed)),
        );
      }
    }
    const active = activeRun(transcript);
    for (const message of transcript.outbox) {
      if (message.status !== "held") continue;
      if (active && !isTerminal(active.state) && hasPendingQuestion(active)) break;
      // The question is settled: deliver as a steer, or as a new run if the run ended.
      this.updateActivity(key, (activity) =>
        updateMessage(activity, message.id, { status: "sending" }),
      );
      void this.deliver(key, message.id);
    }
    if (active) return;
    const next = transcript.runs.find((run) => run.state === "queued");
    if (!next) return;
    this.updateActivity(key, (activity) =>
      updateMessage(startQueuedRun(activity, next.id, this.now()), next.id, {
        status: "sending",
        mode: "new",
      }),
    );
    void this.deliver(key, next.id);
  }

  private turnLimitReached(key: string, runId: string): void {
    this.turnTimers.delete(`${key}\u0000${runId}`);
    const run = this.state.transcripts[key] && findRun(this.state.transcripts[key], runId);
    if (!run || !isActive(run.state)) return;
    const minutes = Math.round((this.options.turnLimitMs ?? DEFAULT_TURN_LIMIT_MS) / 60_000);
    this.updateActivity(key, (activity, ctx) =>
      failRun(
        activity,
        runId,
        { message: `Stopped at the ${minutes}-minute turn limit.`, kind: "turn-limit" },
        ctx,
      ),
    );
    if (this.state.connection.canWrite) {
      this.request("chat.abort", { sessionKey: key, runId }).catch(() => {});
    }
  }

  private clearTurnTimers(key: string): void {
    const prefix = `${key}\u0000`;
    for (const [timerKey, timer] of this.turnTimers) {
      if (!timerKey.startsWith(prefix)) continue;
      clearTimeout(timer);
      this.turnTimers.delete(timerKey);
    }
  }

  /** The task was archived or deleted: its queued messages never run (F-420). */
  private cancelAllQueued(key: string): void {
    this.updateActivity(key, (activity) => {
      let next = activity;
      for (const run of activity.runs) {
        if (run.state !== "queued") continue;
        next = updateMessage(cancelQueuedRun(next, run.id, this.now()), run.id, {
          status: "cancelled",
        });
      }
      return next;
    });
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

    const stored = await this.loadToken(identity.deviceId, "operator");
    if (generation !== this.generation) return;
    const paired = stored !== null;
    // Reopening the same gateway keeps what is on screen until fresh data arrives.
    const sameGateway = this.state.connection.gatewayUrl === settings.url;
    const hasData = sameGateway && this.state.bots.length > 0;
    if (!sameGateway) {
      this.rows = new Map();
      this.raw.clear();
    }
    this.everConnected = hasData;
    this.store.update((state) => ({
      ...(sameGateway ? state : initialState),
      connection: {
        ...initialConnectionState,
        status: hasData ? "reconnecting" : "connecting",
        gatewayUrl: settings.url,
        deviceId: identity.deviceId,
        paired,
        requestedScopes: stored ? [...stored.heldScopes] : [...READ_SCOPES],
        upgrade: sameGateway ? state.connection.upgrade : initialScopeUpgrade,
        serverVersion: sameGateway ? state.connection.serverVersion : null,
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
        const token = await this.loadToken(identity.deviceId, "operator");
        // Once paired, the device token is the credential; the bootstrap token is no longer sent.
        const bootstrap = token ? null : settings.token;
        // Exactly the scopes this client means to hold, never what the token happens to allow.
        const requested = token ? token.heldScopes : [...READ_SCOPES];
        const plan = await this.lifecycle.buildPlan({
          client,
          role: "operator",
          defaultScopes: requested,
          ...(bootstrap ? { token: bootstrap } : {}),
          nonce,
          challengeTs: challengeTs ?? null,
        });
        // The signed payload covers these scopes, so check them before sending.
        if (plan.scopes.join(",") !== requested.join(",")) {
          throw new Error(`refusing to request scopes ${plan.scopes.join(", ")}`);
        }
        if (generation === this.generation) this.setConnection({ requestedScopes: [...requested] });
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
          this.setConnection({
            status: this.everConnected ? "reconnecting" : "connecting",
            canWrite: false,
          });
        }
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
      // The protocol client closes the socket after a gap; the reconnect reloads open tasks.
      onGap: ({ expected, received }) => {
        if (generation !== this.generation) return;
        this.log("warn", `event gap: expected ${expected}, received ${received}`);
        this.pendingResync = "gap";
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
    for (const timer of this.turnTimers.values()) clearTimeout(timer);
    this.turnTimers.clear();
  }

  private handleConnectFailure(error: GatewayProtocolRequestError, deviceId: string, url: string) {
    const details = asRecord(error.details) ?? {};
    const code = typeof details.code === "string" ? details.code : error.gatewayCode;
    const hint = typeof details.remediationHint === "string" ? details.remediationHint : null;

    if (code === "PAIRING_REQUIRED") {
      const requestId = typeof details.requestId === "string" ? details.requestId : "";
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
    const wasConnected = this.everConnected;
    this.everConnected = true;
    const scopes = [...(hello.auth.scopes ?? [])];
    const canWrite = scopeSatisfied(scopes, WRITE_SCOPE);
    this.policy = asRecord(hello.policy);
    this.setConnection({
      status: "connected",
      serverVersion: hello.server.version,
      protocol: hello.protocol,
      scopes,
      canWrite,
      canAnswer: scopeSatisfied(scopes, QUESTIONS_SCOPE),
      pairing: null,
      error: null,
      retryAt: null,
      paired: true,
    });
    if (INTERACTIVE_SCOPES.every((scope) => scopeSatisfied(scopes, scope))) {
      this.upgradeWanted = false;
    } else if (this.upgradeWanted) {
      this.startUpgrade();
    }
    this.settleAccessWaiters();
    const reason =
      this.pendingResync ?? (wasConnected && !this.quietReconnect ? "reconnect" : null);
    this.pendingResync = null;
    this.quietReconnect = false;
    void this.bootstrap(generation, reason);
  }

  private setDiscovery(patch: Partial<DiscoveryState>): void {
    this.store.update((state) => ({ ...state, discovery: { ...state.discovery, ...patch } }));
  }

  /**
   * Every successful connect is a fresh projection: re-list, re-subscribe, reload
   * open transcripts. Bots and tasks load independently, so one failing read
   * keeps the other's result and any data shown before it.
   */
  private async bootstrap(generation: number, resync: CaughtUp["reason"] | null): Promise<void> {
    this.bootstrapping = true;
    this.changedDuringBootstrap = false;
    this.setDiscovery({ status: "loading", error: null });
    const [agents, sessions] = await Promise.allSettled([
      this.request("agents.list", {}),
      this.loadAllSessions(generation, "sessions.subscribe"),
    ]);
    this.bootstrapping = false;
    if (generation !== this.generation) return;

    const failures: string[] = [];
    if (agents.status === "fulfilled") {
      this.store.update((state) => ({ ...state, bots: mapAgents(agents.value) }));
    } else {
      failures.push(`bots: ${errorMessage(agents.reason)}`);
    }
    if (sessions.status === "fulfilled") {
      this.replaceRows(sessions.value.rows);
      if (this.changedDuringBootstrap) await this.refreshSessions(generation);
    } else {
      failures.push(`tasks: ${errorMessage(sessions.reason)}`);
    }
    if (generation !== this.generation) return;
    for (const key of this.openSessions.keys()) void this.loadTranscript(key, true, resync);

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
      this.cancelAllQueued(key);
      if (this.rows.delete(key)) this.publishTasks();
      return;
    }
    if (row.archived === true) this.cancelAllQueued(key);
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
      ...emptyActivity,
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

  /**
   * Read a task's history and rebuild its runs from it. Runs already on screen
   * are merged by id and steps by id, and outgoing messages leave the outbox
   * once history holds them, so a reload never duplicates anything.
   */
  private async loadTranscript(
    key: string,
    subscribe: boolean,
    resync: CaughtUp["reason"] | null,
  ): Promise<void> {
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
      const inFlightId = typeof inFlight?.runId === "string" ? inFlight.runId : null;
      const messages = history?.messages;
      this.historySeq.set(key, maxHistorySeq(messages));
      const ctx = this.context(key);
      const current = this.state.transcripts[key] ?? this.emptyTranscript(key);
      let runs = mergeHistoryRuns(current.runs, runsFromHistory(messages, inFlightId, ctx), ctx);
      if (inFlightId && typeof inFlight?.text === "string") {
        runs = runs.map((run) =>
          run.id === inFlightId && run.textSource === null && !run.text
            ? { ...run, text: inFlight.text as string }
            : run,
        );
      }
      const activity = reconcileOutbox({ ...current, runs }, messages);
      this.setTranscript(key, () =>
        withLive({
          ...current,
          ...activity,
          sessionKey: key,
          status: "ready",
          items: mapHistory(messages),
          error: null,
          hasMore: history?.hasMore === true,
          caughtUp: resync ? { reason: resync, at: this.now() } : current.caughtUp,
        }),
      );
      this.afterActivity(key);
      void this.backfillQuestions(key, generation);
    } catch (error) {
      if (generation !== this.generation || !this.openSessions.has(key)) return;
      this.setTranscript(key, (current) => ({
        ...(current ?? this.emptyTranscript(key)),
        status: "error",
        error: errorMessage(error),
      }));
    }
  }

  private scheduleHistory(key: string, resync: CaughtUp["reason"] | null = null): void {
    if (resync) this.resyncReasons.set(key, resync);
    if (this.historyTimers.has(key)) return;
    this.historyTimers.set(
      key,
      setTimeout(() => {
        this.historyTimers.delete(key);
        const reason = this.resyncReasons.get(key) ?? null;
        this.resyncReasons.delete(key);
        void this.loadTranscript(key, false, reason);
      }, 150),
    );
  }

  private handleChat(event: EventFrame): void {
    const payload = asRecord(event.payload);
    const key = typeof payload?.sessionKey === "string" ? payload.sessionKey : null;
    const runId = typeof payload?.runId === "string" ? payload.runId : null;
    if (!payload || !key || !runId) return;
    const { event: projected } = this.streams.project(event);
    if (!this.openSessions.has(key)) return;
    const text =
      payload.state === "delta"
        ? liveTextFromChatMessage(asRecord(projected.payload)?.message)
        : null;
    this.updateActivity(key, (activity, ctx) => applyChatEvent(activity, payload, text, ctx));
    // final, aborted or error: the durable transcript now owns the text.
    if (payload.state !== "delta" && payload.state !== "status") this.scheduleHistory(key);
  }

  /** Agent events carry the session key on the wire; fall back to the open task that knows the run. */
  private handleAgent(event: EventFrame): void {
    const payload = asRecord(event.payload);
    if (!payload || typeof payload.runId !== "string") return;
    let key = typeof payload.sessionKey === "string" ? payload.sessionKey : null;
    if (!key) {
      const runId = payload.runId;
      key =
        Object.values(this.state.transcripts).find((transcript) => findRun(transcript, runId))
          ?.sessionKey ?? null;
    }
    if (!key || !this.openSessions.has(key)) return;
    let gap = false;
    this.updateActivity(key, (activity, ctx) => {
      const result = applyAgentEvent(activity, payload, ctx);
      gap = result.gap;
      return result.activity;
    });
    if (gap) {
      this.log("warn", `agent event gap in run ${payload.runId}`);
      this.scheduleHistory(key, "gap");
    }
    const phase = asRecord(payload.data)?.phase;
    if (payload.stream === "lifecycle" && (phase === "end" || phase === "error")) {
      this.scheduleHistory(key);
    }
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
      case "agent":
        this.handleAgent(event);
        return;
      case "question.requested": {
        const record = asRecord(event.payload);
        const key = typeof record?.sessionKey === "string" ? record.sessionKey : null;
        if (record && key && this.openSessions.has(key)) {
          this.updateActivity(key, (activity, ctx) =>
            applyQuestionRequested(activity, record, ctx),
          );
        }
        return;
      }
      case "question.resolved": {
        const payload = asRecord(event.payload);
        const id = payload?.id;
        if (!payload || typeof id !== "string") return;
        for (const transcript of Object.values(this.state.transcripts)) {
          if (transcript.questions.some((question) => question.id === id)) {
            this.updateActivity(transcript.sessionKey, (activity) =>
              applyQuestionResolved(activity, payload),
            );
          }
        }
        return;
      }
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
    return {
      token: parsed.token,
      // Earlier builds stored the grant as `scopes`.
      grantedScopes: parsed.grantedScopes ?? parsed.scopes ?? [],
      // Records from before the write step-up mean read only.
      heldScopes: normalizeHeldScopes(parsed.heldScopes),
    };
  }

  private async writeToken(
    deviceId: string,
    role: string,
    record: StoredDeviceToken,
  ): Promise<void> {
    await this.host.storage.set(this.tokenKey(deviceId, role), JSON.stringify(record));
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
