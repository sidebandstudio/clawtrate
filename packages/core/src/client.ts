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
import {
  applyApprovalRequested,
  applyApprovalResolved,
  APPROVAL_KINDS,
  expireApprovals,
  markApproval,
  mergeResolution,
  normalizeApprovals,
  parseApprovalResolved,
  parseExecApproval,
  parsePluginApproval,
  parseSystemAgentApproval,
  resolutionFromSnapshot,
  resolveRequest,
  settleUnlistedApprovals,
  type ApprovalAccess,
  type ApprovalCard,
  type ApprovalDecision,
  type ApprovalKind,
  type ApprovalResolution,
  type ApprovalSourceAccess,
} from "./approvals.ts";
import {
  interSessionMessages,
  linkedRunOf,
  recipientLinks,
  recipientRunIds,
  type LinkedRun,
} from "./cards.ts";
import { MAX_FILE_BYTES, MAX_IMAGE_BYTES } from "./attachments.ts";
import { utf8Length } from "./encoding.ts";
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
  activitySize,
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
  cachedSize,
  fitClosed,
  fitLive,
  isOpenStep,
  isTerminal,
  jsonLength,
  markUnconfirmed,
  markQuestion,
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
  settleQuestionsOfEndedRuns,
  settleVanishedRuns,
  retainActivity,
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
  APPROVALS_SCOPE,
  heldFromGrant,
  INTERACTIVE_SCOPES,
  normalizeHeldScopes,
  QUESTIONS_SCOPE,
  READ_SCOPES,
  scopeSatisfied,
  WRITE_SCOPE,
} from "./scopes.ts";
import { emptyRetention, HostLedger, MAX_TASK_RETAINED, type TaskRetention } from "./retention.ts";
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
/**
 * Added when the connect asks for `operator.approvals`: without `approvals` and
 * `exec-approvals` the gateway auto-denies exec approvals as `no-route`, and
 * `plugin-approvals` routes plugin approvals. A read-only connect does not claim
 * them, so the gateway never waits on a connection that cannot see approvals.
 */
export const APPROVAL_CAPS: readonly string[] = ["approvals", "exec-approvals", "plugin-approvals"];

/** The caps a connect requesting these scopes advertises. */
export function capsFor(scopes: readonly string[]): string[] {
  return scopes.includes(APPROVALS_SCOPE) ? [...CLIENT_CAPS, ...APPROVAL_CAPS] : [...CLIENT_CAPS];
}

/** Longest standing allow the gateway accepts (`grantExpiresInDays`). */
export const MAX_GRANT_DAYS = 3650;
/** A registered client id for third-party operator UIs; we do not claim an OpenClaw product id. */
export const CLIENT_ID = "gateway-client";
export const CLIENT_MODE = "ui";

/** One page of the task list. Pages are read until the gateway reports no more. */
export const SESSION_PAGE_SIZE = 200;
/** A ceiling so a huge gateway cannot make one reconnect read forever. */
export const MAX_SESSION_PAGES = 50;
/** Clawtrate's turn limit (F-100): a run this client started fails after it. */
export const DEFAULT_TURN_LIMIT_MS = 50 * 60_000;
/** Tasks the client follows at once: open in some viewer, kept for their unsent work, or being created. */
export const MAX_TRACKED_TASKS = 128;
/**
 * Messages one task's outbox may hold, whatever their state: waiting, being
 * sent, accepted but not yet in history, unconfirmed, failed or cancelled. A
 * new message past it is refused before anything is kept; nothing accepted is
 * dropped to make room.
 */
export const MAX_OUTBOX_PER_TASK = 50;
/** Tasks whose outbox may hold messages at once. */
export const MAX_TASKS_WITH_OUTBOX = 16;
/**
 * Decoded bytes of files the client keeps for messages in outboxes, across
 * every task, until history confirms them or the user deletes them. With the
 * waiting uploads (`MAX_PENDING_ATTACHMENT_BYTES`) this is all the file
 * content the host keeps.
 */
export const MAX_RETAINED_ATTACHMENT_BYTES = 128 * 1024 * 1024;
/** Operations waiting for access at once; past it a new one is refused. */
export const MAX_ACCESS_WAITERS = 512;
/**
 * Approval outcomes the gateway reported, kept by id apart from the visible
 * cards so a request or list entry that arrives after its resolution can never
 * make it actionable again. The oldest give way; switching gateways clears them.
 */
export const MAX_APPROVAL_OUTCOMES = 4096;
/**
 * Pending approvals kept while no followed task can show them, or while the
 * task they belong to already shows `MAX_PENDING_APPROVALS_PER_TASK`
 * (`unroutedApprovals`). Past it a new one is not kept and is counted in
 * `unroutedApprovalsOmitted`; the next list read brings it back.
 */
export const MAX_UNROUTED_APPROVALS = 64;
/** `approval.get` lookups of ambiguous legacy outcomes in flight at once; past it the outcome stays unknown. */
export const MAX_OUTCOME_LOOKUPS = 16;
/** Pending approvals one task shows; more wait in `unroutedApprovals` until one settles. */
export const MAX_PENDING_APPROVALS_PER_TASK = 64;

/**
 * How long a request may go unanswered on a live connection before it fails
 * locally. Nothing the client sent waits for ever: a send that times out is
 * failed with its outcome unknown, to retry with the same idempotency key.
 * Waits the gateway answers late by design (`device.scopes.waitUpgrade`) opt out.
 */
export const REQUEST_TIMEOUT_MS = 60_000;

/** Longest message text the client sends. */
export const MAX_MESSAGE_CHARS = 32_000;
/** The gateway's frame ceiling after `connect` when `hello-ok.policy.maxPayload` is absent (25 MiB). */
export const DEFAULT_MAX_PAYLOAD_BYTES = 26_214_400;
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
/** How many sessions nobody has open, and how many runs of each, are followed for bot-to-bot cards. */
const FOREIGN_SESSIONS = 20;
const FOREIGN_RUNS_PER_SESSION = 10;
const MAX_TIMER_MS = 2_147_483_647;
const MAX_SPAWN_LINKS = 200;
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
  /** `REQUEST_TIMEOUT_MS` unless a test shortens it. */
  requestTimeoutMs?: number;
  /**
   * The host's retention budget, shared with the upload store and the web
   * host's viewers. A client made without one keeps its own, with the
   * default limit.
   */
  ledger?: HostLedger;
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

type Waiter = {
  scope: string;
  resolve: () => void;
  reject: (error: Error) => void;
  /** Who asked: a viewer's operations are withdrawn with `withdraw` when it goes away. */
  owner: object | null;
};

/** The approval kinds' list methods and readers. */
const APPROVAL_SOURCES: ReadonlyArray<{
  kind: ApprovalKind;
  method: string;
  parse: (value: unknown) => ApprovalCard | null;
}> = [
  { kind: "exec", method: "exec.approval.list", parse: parseExecApproval },
  { kind: "plugin", method: "plugin.approval.list", parse: parsePluginApproval },
  { kind: "system-agent", method: "openclaw.approval.list", parse: parseSystemAgentApproval },
];

function approvalAccessOf(sources: Record<ApprovalKind, ApprovalSourceAccess>): ApprovalAccess {
  const values = APPROVAL_KINDS.map((kind) => sources[kind]);
  if (values.every((each) => each === "ready")) return "ready";
  if (values.every((each) => each === "unavailable")) return "unavailable";
  if (values.some((each) => each === "loading")) return "loading";
  if (values.some((each) => each === "ready")) return "partial";
  return "error";
}

/** A withdrawn operation: its viewer went away before the gateway was asked. */
export class WithdrawnError extends Error {
  constructor() {
    super("The request was withdrawn.");
    this.name = "WithdrawnError";
  }
}

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

/**
 * Whether the run has a question pending, by the question records as well as
 * the run's cards, so a plain message is never sent while the gateway would
 * take it as the answer.
 */
function questionPending(activity: TaskActivity, run: Run): boolean {
  return (
    activity.questions.some(
      (question) => question.status === "pending" && question.runId === run.id,
    ) || [...run.pendingCards, ...run.suspendedCards].some((card) => card.kind === "question")
  );
}

/**
 * A task holds work that must outlive its viewers: unsent or failed words,
 * words the gateway accepted that history has not confirmed, or a run this
 * client started. Cancelled messages are not work.
 */
function hasUnsettledWork(activity: TaskActivity): boolean {
  return (
    activity.outbox.some(
      (message) => message.status !== "cancelled" && message.status !== "handled",
    ) || activity.runs.some((run) => run.origin === "local" && !isTerminal(run.state))
  );
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
  /**
   * The credential store and device-auth lifecycle of the current connection,
   * bound to its gateway URL and generation. A new connection gets new ones,
   * so nothing an older connection finishes can write another gateway's token.
   */
  private auth: {
    url: string;
    generation: number;
    tokenStore: GatewayBrowserDeviceTokenStore;
    lifecycle: GatewayBrowserDeviceAuthLifecycle;
  } | null = null;
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
  private readonly raw = new RawTable();
  private readonly turnTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Tasks no viewer has open that still hold unsent words or a run this client started. */
  private readonly retained = new Set<string>();
  private readonly deliveries = new Map<string, Promise<void>>();
  /** History reads per task, one at a time with at most one more waiting. */
  private readonly loads = new Map<
    string,
    { done: Promise<void>; again: { subscribe: boolean; resync: CaughtUp["reason"] | null } | null }
  >();
  /** Bumped each time a task is opened afresh, so a read from an earlier opening is dropped. */
  private readonly incarnations = new Map<string, number>();
  private nextIncarnation = 0;
  private readonly afterRunning = new Set<string>();
  private readonly afterAgain = new Set<string>();
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Runs of sessions no viewer has open, kept small, so a bot-to-bot card can
   * follow the recipient's run when this connection receives its events.
   */
  private readonly foreign = new Map<string, TaskActivity>();
  private readonly foreignRaw = new RawTable();
  /** Which session spawned which (`spawnedBy` on events), newest kept, at most `MAX_SPAWN_LINKS`. */
  private readonly spawnedBy = new Map<string, string>();
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
  /** Attachment content for outgoing messages, kept off the state snapshots, with its decoded size and the characters it holds. */
  private readonly attachmentContent = new Map<
    string,
    { task: string; files: OutgoingAttachment[]; bytes: number; chars: number }
  >();
  private attachmentBytes = 0;
  /** Characters of file content held per task, charged to its budget. */
  private readonly attachmentChars = new Map<string, number>();
  /** Tasks in the order they last changed, oldest first: closed material of the oldest goes first. */
  private readonly touched = new Map<string, true>();
  /** The host's budget. Everything this client keeps for its tasks is counted in it. */
  readonly ledger: HostLedger;
  /** Viewers that went away: anything they asked for is checked against this just before the gateway is asked. */
  private readonly withdrawnOwners = new WeakSet<object>();
  /** Task slots held for tasks being created, so a creation never exceeds `MAX_TRACKED_TASKS`. */
  private reservedTasks = 0;
  /** What the gateway reported about approvals, by id, newest last (`MAX_APPROVAL_OUTCOMES`). */
  private readonly approvalOutcomes = new Map<string, ApprovalResolution>();
  /** Pending approvals no followed task can show yet, oldest first (`MAX_UNROUTED_APPROVALS`). */
  private readonly unrouted = new Map<string, ApprovalCard>();
  private unroutedOmitted = 0;
  /** Approvals whose outcome is being looked up (`approval.get`). */
  private readonly lookingUp = new Set<string>();
  /** Recipient runs and sessions each task's `sessions_send` results name. */
  private readonly recipients = new Map<string, { runs: Set<string>; sessions: Set<string> }>();
  /** Per task and list (`<key>\0<kind>`): the last list requested, and the newest applied. */
  private readonly listRequested = new Map<string, number>();
  private readonly listApplied = new Map<string, number>();

  constructor(host: ClawtrateHost, options: ClientOptions = {}) {
    this.host = host;
    this.options = options;
    this.ledger = options.ledger ?? new HostLedger();
    this.ledger.track("tasks", () => this.retainedTotal());
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
    this.retained.clear();
    this.forgetGatewayState();
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
  openSession(key: string, reservation = false): void {
    const taken = this.openSessions.size + this.retained.size + this.reservedTasks;
    if (!this.tracked(key) && !reservation && taken >= MAX_TRACKED_TASKS) {
      throw new Error(`At most ${MAX_TRACKED_TASKS} tasks can be open at once.`);
    }
    const count = this.openSessions.get(key) ?? 0;
    this.openSessions.set(key, count + 1);
    if (count > 0) return;
    // A task closed with unsent work was kept: reopening shows the same queue.
    const kept = this.retained.delete(key);
    if (!kept || !this.incarnations.has(key))
      this.incarnations.set(key, (this.nextIncarnation += 1));
    this.setTranscript(key, (current) => current ?? this.emptyTranscript(key));
    // An approval waiting for a task that can show it may belong here now.
    this.routeUnrouted();
    if (this.state.connection.status === "connected") void this.loadTranscript(key, !kept, null);
  }

  // Retention ------------------------------------------------------------------

  /** What a transcript itself puts on the snapshot: activity, history page and inter-session messages. */
  private transcriptSize(transcript: Transcript): number {
    return cachedSize(
      transcript,
      (each) =>
        activitySize(each) +
        cachedSize(each.items, jsonLength) +
        cachedSize(each.interSession, jsonLength),
    );
  }

  /** Everything charged to one task: its transcript, its raw payloads and its outgoing files. */
  private taskRetained(key: string, transcript = this.state.transcripts[key]): number {
    return (
      (transcript ? this.transcriptSize(transcript) : 0) +
      this.raw.usage(key) +
      (this.attachmentChars.get(key) ?? 0)
    );
  }

  /** Everything this client keeps for its tasks, as the host's ledger counts it. */
  private retainedTotal(): number {
    let total = this.raw.total + this.foreignRaw.total;
    for (const transcript of Object.values(this.state.transcripts))
      total += this.transcriptSize(transcript);
    for (const chars of this.attachmentChars.values()) total += chars;
    return total;
  }

  /**
   * Free at least `over` of what a task keeps. Closed material goes first,
   * oldest first: raw payloads of finished steps, finished steps, finished
   * runs' text, settled cards, then the oldest items of the history page.
   * With `live`, open work is then reduced, each item saying so (`fitLive`).
   * Outgoing messages and their files are never dropped.
   */
  private fitTask(
    key: string,
    transcript: Transcript,
    over: number,
    live: boolean,
  ): { transcript: Transcript; freed: number; reducedLive: boolean } {
    let freed = 0;
    let next = transcript;
    let retention = next.retention;
    const open = new Set(
      next.runs.flatMap((run) => run.steps.filter(isOpenStep).map((step) => step.id)),
    );
    const raw = this.raw.evict(key, over, open);
    freed += raw.freed;
    if (raw.count > 0) retention = { ...retention, rawOmitted: retention.rawOmitted + raw.count };
    if (freed < over) {
      const closed = fitClosed(next, over - freed);
      if (closed.freed > 0) next = { ...next, ...closed.activity };
      freed += closed.freed;
    }
    if (freed < over && next.items.length > 0) {
      let drop = 0;
      while (drop < next.items.length && freed < over) {
        freed += jsonLength(next.items[drop]);
        drop += 1;
      }
      next = { ...next, items: next.items.slice(drop), hasMore: true };
      retention = { ...retention, itemsOmitted: retention.itemsOmitted + drop };
    }
    let reducedLive = false;
    if (live && freed < over) {
      // An open step's raw payload goes with its body: what is not shown is not kept either.
      const before = this.raw.usage(key);
      this.raw.dropSteps(key, open);
      freed += before - this.raw.usage(key);
      if (freed < over) {
        const reduced = fitLive(next, over - freed);
        next = { ...next, ...reduced.activity };
        freed += reduced.freed;
      }
      next = {
        ...next,
        runs: next.runs.map((run) =>
          run.steps.some((step) => open.has(step.id) && !step.bodyOmitted)
            ? {
                ...run,
                steps: run.steps.map((step) =>
                  open.has(step.id) && !step.bodyOmitted
                    ? {
                        ...step,
                        raw: null,
                        rawSize: null,
                        bodyOmitted: true,
                        argsText: null,
                        output: null,
                      }
                    : step,
                ),
              }
            : run,
        ),
      };
      reducedLive = true;
    }
    if (retention !== next.retention) next = { ...next, retention };
    return { transcript: next, freed, reducedLive };
  }

  /**
   * Admit a task's next state within its budget and the host's. Over the
   * task's budget, its own closed material goes, then its live work is
   * reduced. Over the host's, closed material of the tasks that changed
   * longest ago goes first, then this task's live work is reduced. The task's
   * `retention` says what it keeps and whether anything had to be reduced.
   */
  private admit(key: string, before: Transcript | undefined, next: Transcript): Transcript {
    let candidate = next;
    let full = false;
    const taskOver = this.taskRetained(key, candidate) - MAX_TASK_RETAINED;
    if (taskOver > 0) {
      const fitted = this.fitTask(key, candidate, taskOver, true);
      candidate = fitted.transcript;
      full = fitted.reducedLive || fitted.freed < taskOver;
    }
    const others = this.ledger.used() - (before ? this.taskRetained(key, before) : 0);
    let hostOver = others + this.taskRetained(key, candidate) - this.ledger.limit;
    if (hostOver > 0) {
      for (const other of this.touched.keys()) {
        if (hostOver <= 0) break;
        const transcript = other === key ? undefined : this.state.transcripts[other];
        if (!transcript) continue;
        const fitted = this.fitTask(other, transcript, hostOver, false);
        if (fitted.freed > 0) {
          this.replaceQuietly(other, fitted.transcript);
          this.dropRawOfRemovedSteps(other, transcript, fitted.transcript);
          hostOver -= fitted.freed;
        }
      }
      if (hostOver > 0) {
        const fitted = this.fitTask(key, candidate, hostOver, true);
        candidate = fitted.transcript;
        full = true;
      }
      this.setHostFull(hostOver > 0);
    } else if (this.state.retention.full) {
      this.setHostFull(false);
    }
    const used = this.taskRetained(key, candidate);
    const retention: TaskRetention = { ...candidate.retention, used, full };
    return { ...candidate, retention };
  }

  private setHostFull(full: boolean): void {
    this.store.update((state) => ({
      ...state,
      retention: { used: this.ledger.used(), limit: this.ledger.limit, full },
    }));
  }

  /**
   * Make room for `amount` more in a task before keeping it: closed material
   * of the task, then of the tasks that changed longest ago. Throws when the
   * room is not there; nothing is kept then.
   */
  private reserveRoom(key: string, amount: number, what: string): void {
    const transcript = this.state.transcripts[key];
    if (!transcript) return;
    const taskOver = this.taskRetained(key) + amount - MAX_TASK_RETAINED;
    if (taskOver > 0) {
      const fitted = this.fitTask(key, transcript, taskOver, false);
      this.replaceQuietly(key, fitted.transcript);
      this.dropRawOfRemovedSteps(key, transcript, fitted.transcript);
      if (fitted.freed < taskOver) {
        throw new Error(`This task is holding as much as it can; ${what}`);
      }
    }
    let hostOver = this.ledger.used() + amount - this.ledger.limit;
    for (const other of this.touched.keys()) {
      if (hostOver <= 0) break;
      const current = this.state.transcripts[other];
      if (!current) continue;
      const fitted = this.fitTask(other, current, hostOver, false);
      if (fitted.freed === 0) continue;
      this.replaceQuietly(other, fitted.transcript);
      this.dropRawOfRemovedSteps(other, current, fitted.transcript);
      hostOver -= fitted.freed;
    }
    if (hostOver > 0) {
      this.setHostFull(true);
      throw new Error(`The host is holding as much as it can; ${what}`);
    }
  }

  /** Replace a transcript for retention's sake, without counting it as the task's latest change. */
  private replaceQuietly(key: string, transcript: Transcript): void {
    this.store.update((state) => ({
      ...state,
      transcripts: { ...state.transcripts, [key]: transcript },
    }));
  }

  /** Raw payloads of steps a reduction took out of view go too. */
  private dropRawOfRemovedSteps(key: string, before: TaskActivity, after: TaskActivity): void {
    if (before.runs === after.runs) return;
    const kept = new Set(after.runs.flatMap((run) => run.steps.map((step) => step.id)));
    const gone = before.runs.flatMap((run) =>
      run.steps.filter((step) => !kept.has(step.id)).map((step) => step.id),
    );
    if (gone.length > 0) this.raw.dropSteps(key, gone);
  }

  /**
   * Release a viewer's interest. When the last one goes, a task that still holds
   * unsent, unconfirmed or failed words, or a run this client started, is kept
   * and followed until that work is done or the user cancels it; otherwise it
   * is released.
   */
  closeSession(key: string): void {
    const count = this.openSessions.get(key);
    if (!count) return;
    if (count > 1) {
      this.openSessions.set(key, count - 1);
      return;
    }
    this.openSessions.delete(key);
    const transcript = this.state.transcripts[key];
    if (transcript && hasUnsettledWork(transcript)) {
      this.retained.add(key);
      return;
    }
    this.releaseTask(key);
  }

  /** Whether events and reloads for this task are followed: a viewer has it open, or it is kept for its work. */
  private tracked(key: string): boolean {
    return this.openSessions.has(key) || this.retained.has(key);
  }

  private releaseTask(key: string): void {
    this.retained.delete(key);
    this.incarnations.delete(key);
    this.loads.delete(key);
    // Drop the chat stream baselines this task held.
    this.streams.retire((scope) => scope.sessionKey === key);
    const timer = this.historyTimers.get(key);
    if (timer) clearTimeout(timer);
    this.historyTimers.delete(key);
    this.resyncReasons.delete(key);
    this.raw.clearTask(key);
    this.clearTurnTimers(key);
    const expiry = this.expiryTimers.get(key);
    if (expiry) clearTimeout(expiry);
    this.expiryTimers.delete(key);
    for (const message of this.state.transcripts[key]?.outbox ?? []) {
      this.dropAttachments(message.id);
    }
    this.recipients.delete(key);
    this.touched.delete(key);
    for (const map of [this.listRequested, this.listApplied]) {
      for (const listKey of [...map.keys()])
        if (listKey.startsWith(`${key}\u0000`)) map.delete(listKey);
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
    const auth = this.auth;
    if (this.scopeUpgrade || !protocol || !identity || !url || !auth || auth.url !== url) return;
    const generation = this.generation;
    const target = [...INTERACTIVE_SCOPES];
    const upgrade = new GatewayScopeUpgrade({
      request: (method, params, options) => protocol.request(method, params, options),
      tokenStore: {
        load: auth.tokenStore.load,
        clear: auth.tokenStore.clear,
        // The rotated token carries the new grant; from now on connect asks for exactly what it covers.
        // It belongs to this gateway and this connection only.
        store: async ({ deviceId, role, token, scopes }) => {
          if (generation !== this.generation || this.settings?.url !== url) {
            throw new Error("The gateway changed while access was being approved.");
          }
          await this.writeToken(url, deviceId, role, {
            token,
            grantedScopes: scopes,
            heldScopes: heldFromGrant(scopes),
          });
        },
      },
      reconnect: () => {
        if (generation !== this.generation || this.settings?.url !== url) return;
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
   * (the connection is only down), it waits for the next hello. A connection
   * that has stopped (the gateway refused the device, or reconnecting gave up)
   * will not bring one, so the operation fails at once and stays retryable.
   * `owner` names the viewer that asked, so its operations can be withdrawn.
   */
  private ensureScope(scope: string, owner: object | null = null): Promise<void> {
    if (this.holds(scope)) return Promise.resolve();
    const connection = this.state.connection;
    if (connection.status === "error" || connection.status === "idle" || !this.protocol) {
      return Promise.reject(
        new Error(
          `Not connected to the gateway${connection.error ? `: ${connection.error.message}` : "."}`,
        ),
      );
    }
    if (this.accessWaiters.length >= MAX_ACCESS_WAITERS) {
      return Promise.reject(
        new Error("Too many operations are waiting for access; try again when they finish."),
      );
    }
    const waiting = new Promise<void>((resolve, reject) => {
      this.accessWaiters.push({ scope, resolve, reject, owner });
    });
    // Not meant to be held yet, or held and then lost (capped or revoked) on a
    // live connection: ask the gateway's owner. Otherwise the connection is
    // only down, and the next hello settles it.
    if (
      !this.state.connection.requestedScopes.includes(scope) ||
      this.state.connection.status === "connected"
    ) {
      this.requestAccess().catch((error: unknown) => {
        this.failAccess(new AccessRequestError("error", errorMessage(error)));
      });
    }
    return waiting;
  }

  /**
   * A viewer went away: everything it asked for that is still waiting for
   * access is withdrawn now, before the gateway is asked, and nothing of it is
   * kept. Work the client owns (outgoing messages) is not a viewer's.
   */
  withdraw(owner: object): void {
    this.withdrawnOwners.add(owner);
    const withdrawn = this.accessWaiters.filter((waiter) => waiter.owner === owner);
    if (withdrawn.length === 0) return;
    this.accessWaiters = this.accessWaiters.filter((waiter) => waiter.owner !== owner);
    for (const waiter of withdrawn) waiter.reject(new WithdrawnError());
  }

  /**
   * The last check before an operation asks the gateway: its viewer has not
   * gone away. Waiter withdrawal covers an operation still waiting for access;
   * this covers one whose access was already held or just settled.
   */
  private checkNotWithdrawn(owner: object | null | undefined): void {
    if (owner && this.withdrawnOwners.has(owner)) throw new WithdrawnError();
  }

  /** Operations waiting for access, for tests and diagnostics. */
  get pendingAccessWaiters(): number {
    return this.accessWaiters.length;
  }

  /** Reject every operation waiting for access, without changing what is being asked for. */
  private rejectAccessWaiters(error: Error): void {
    this.upgradeWanted = false;
    const waiters = this.accessWaiters;
    this.accessWaiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }

  /**
   * The gateway refused a call for a missing scope: this connection does not
   * hold it, whatever the last hello said. Drop it from the effective scopes,
   * so the next use asks for it again instead of repeating the refused call.
   */
  private noteMissingScope(error: unknown): void {
    if (!isMissingScope(error)) return;
    const details = asRecord((error as GatewayProtocolRequestError).details);
    const missing = typeof details?.missingScope === "string" ? details.missingScope : null;
    if (!missing) return;
    this.setEffectiveScopes(
      this.state.connection.scopes.filter(
        (scope) => scope !== missing && scope !== "operator.admin",
      ),
    );
    // Without the scope no list can be read: say so, rather than show what was read before as current.
    if (!this.holds(APPROVALS_SCOPE)) {
      for (const key of Object.keys(this.state.transcripts)) {
        for (const kind of APPROVAL_KINDS) this.setApprovalSource(key, kind, "unavailable");
      }
    }
  }

  /** The scopes this connection holds, and every flag derived from them, set together. */
  private setEffectiveScopes(scopes: string[]): void {
    this.setConnection({
      scopes,
      canWrite: scopeSatisfied(scopes, WRITE_SCOPE),
      canAnswer: scopeSatisfied(scopes, QUESTIONS_SCOPE),
      canApprove: scopeSatisfied(scopes, APPROVALS_SCOPE),
    });
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
    this.checkOutboxRoom(key);
    if (!body && attachments.length === 0) throw new Error("The message is empty.");
    if (body.length > MAX_MESSAGE_CHARS) throw new Error("The message is too long.");
    this.checkSize(this.sendParams(key, body, "x".repeat(36), "followup", attachments));
    const bytes = attachments.reduce((sum, each) => sum + decodedBytes(each.content), 0);
    if (this.attachmentBytes + bytes > MAX_RETAINED_ATTACHMENT_BYTES) {
      throw new Error(
        "Files of earlier messages are still waiting to go out; send or delete some of them first.",
      );
    }
    // The message and its files are charged to the task and the host before anything is kept.
    const chars = attachments.reduce((sum, each) => sum + each.content.length, 0);
    this.reserveRoom(
      key,
      chars + 256 + body.length,
      "send or delete some messages, or close other tasks, first.",
    );
    const active = activeRun(transcript);
    const resolved = !active
      ? "new"
      : active.state === "stopping" || options.mode === "queue"
        ? "queue"
        : "steer";
    const held = resolved === "steer" && questionPending(transcript, active!);
    const message: OutgoingMessage = {
      id: this.randomId(),
      text: body,
      mode: resolved,
      status: resolved === "queue" ? "queued" : held ? "held" : "sending",
      runId: resolved === "steer" ? active!.id : null,
      messageSeq: null,
      createdAt: this.now(),
      error: null,
      attachments: attachments.map((attachment) => ({
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        sizeBytes: decodedBytes(attachment.content),
      })),
    };
    if (attachments.length > 0) {
      this.attachmentContent.set(message.id, { task: key, files: attachments, bytes, chars });
      this.attachmentBytes += bytes;
      this.attachmentChars.set(key, (this.attachmentChars.get(key) ?? 0) + chars);
    }
    this.updateActivity(key, (activity) => {
      const withMessage = { ...activity, outbox: [...activity.outbox, message] };
      if (resolved === "new") return startLocalRun(withMessage, message, this.now());
      if (resolved === "queue") return queueLocalRun(withMessage, message, this.now());
      return withMessage;
    });
    if (message.status === "sending") this.enqueueDelivery(key, message.id);
    return message.id;
  }

  /**
   * Refuse a new outgoing message beyond the per-task and per-client bounds,
   * before keeping anything. Every message the outbox holds counts, failed and
   * unconfirmed ones included, so retrying and deleting are always possible
   * and nothing accepted is dropped to make room.
   */
  private checkOutboxRoom(key: string): void {
    const here = (this.state.transcripts[key] ?? emptyActivity).outbox.length;
    if (here >= MAX_OUTBOX_PER_TASK) {
      throw new Error(
        `This task already holds ${MAX_OUTBOX_PER_TASK} messages waiting to be sent, confirmed, retried or deleted.`,
      );
    }
    if (here === 0) this.checkOutboxTaskRoom();
  }

  /** Refuse a message in one more task once `MAX_TASKS_WITH_OUTBOX` tasks hold messages, counting tasks being created. */
  private checkOutboxTaskRoom(): void {
    const busy =
      Object.values(this.state.transcripts).filter((transcript) => transcript.outbox.length > 0)
        .length + this.reservedTasks;
    if (busy >= MAX_TASKS_WITH_OUTBOX) {
      throw new Error(
        `Messages are waiting in ${MAX_TASKS_WITH_OUTBOX} tasks; let some of them go out first.`,
      );
    }
  }

  /** Forget a message's file content and give its bytes back. */
  private dropAttachments(messageId: string): void {
    const kept = this.attachmentContent.get(messageId);
    if (!kept) return;
    this.attachmentContent.delete(messageId);
    this.attachmentBytes -= kept.bytes;
    const left = (this.attachmentChars.get(kept.task) ?? 0) - kept.chars;
    if (left > 0) this.attachmentChars.set(kept.task, left);
    else this.attachmentChars.delete(kept.task);
  }

  /** Decoded bytes of files held for outgoing messages, for tests and diagnostics. */
  get retainedAttachmentBytes(): number {
    return this.attachmentBytes;
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
    const frame = utf8Length(JSON.stringify(params)) + FRAME_SLACK_BYTES;
    if (frame > maxPayload) {
      throw new SendTooLargeError(
        `The message and its files come to ${frame} bytes; one message can carry at most ${maxPayload}.`,
      );
    }
  }

  /**
   * Send a failed or unconfirmed message again, with the same idempotency key,
   * so the gateway delivers it at most once. It already counts against the
   * outbox bounds, so a retry is never refused for room.
   */
  retryMessage(key: string, messageId: string): void {
    const message = this.outgoing(key, messageId);
    if (!message || (message.status !== "failed" && message.status !== "unconfirmed")) return;
    const transcript = this.state.transcripts[key]!;
    const active = activeRun(transcript);
    const mode = !active ? "new" : active.state === "stopping" ? "queue" : "steer";
    const held = mode === "steer" && questionPending(transcript, active!);
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
    if (mode !== "queue" && !held) this.enqueueDelivery(key, messageId);
  }

  /** Remove a failed, cancelled or unconfirmed message, and the run that never started with it. */
  deleteMessage(key: string, messageId: string): void {
    const message = this.outgoing(key, messageId);
    if (
      !message ||
      (message.status !== "failed" &&
        message.status !== "cancelled" &&
        message.status !== "unconfirmed" &&
        message.status !== "handled")
    )
      return;
    this.dropAttachments(messageId);
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
    // A cancelled message is never sent: its files are not kept.
    this.dropAttachments(messageId);
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
      const held = questionPending(activity, active);
      return updateMessage(withoutQueued, messageId, {
        mode: "steer",
        status: held ? "held" : "sending",
        runId: active.id,
      });
    });
    if (this.outgoing(key, messageId)?.status === "sending") this.enqueueDelivery(key, messageId);
  }

  /**
   * Create a task under a bot with its first message. `sessions.create`
   * carries only `agentId`, `message`, `idempotencyKey` and `label`, which keep
   * it at `operator.write`. The caller holds one interest in the new task, as
   * if it had called `openSession`, and releases it with `closeSession`.
   */
  async createTask(
    botId: string,
    text: string,
    options: { label?: string; owner?: object } = {},
  ): Promise<string> {
    const body = text.trim();
    if (!body) throw new Error("The message is empty.");
    if (body.length > MAX_MESSAGE_CHARS) throw new Error("The message is too long.");
    // The new task's slot is held before anything is asked of the gateway, and given back on failure.
    if (this.openSessions.size + this.retained.size + this.reservedTasks >= MAX_TRACKED_TASKS) {
      throw new Error(`At most ${MAX_TRACKED_TASKS} tasks can be open at once.`);
    }
    this.checkOutboxTaskRoom();
    this.reservedTasks += 1;
    let reserved = true;
    const release = () => {
      if (reserved) this.reservedTasks -= 1;
      reserved = false;
    };
    try {
      // A viewer that goes away while access is approved takes its request with it (`withdraw`).
      await this.ensureScope(WRITE_SCOPE, options.owner ?? null);
      // The viewer went away while access settled: nothing is asked of the gateway.
      this.checkNotWithdrawn(options.owner);
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
        createdAt: now,
        error: runError ? String(runError.message ?? "The run did not start.") : null,
        attachments: [],
      };
      release();
      this.openSession(key, true);
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
    } finally {
      release();
    }
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
      } else if (questionPending(this.state.transcripts[key]!, active)) {
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
        this.attachmentContent.get(messageId)?.files ?? [],
      );
      this.checkSize(params);
      result = asRecord(await this.request("chat.send", params));
    } catch (error) {
      this.noteMissingScope(error);
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
    // A stop command (`/stop`) is answered `{ok, aborted, runIds}` before any
    // run or turn is recorded: the gateway handled it, and no run or history
    // row will follow.
    const command = runId === null && typeof result?.aborted === "boolean";
    this.updateActivity(key, (activity) => {
      if (command) {
        return dropUnboundRun(
          updateMessage(activity, messageId, {
            status: "handled",
            messageSeq: null,
            runId: null,
            error: null,
          }),
          messageId,
        );
      }
      if (runId === null && message.mode !== "steer") {
        // Accepted, but no run named: none is assumed. History confirms the
        // message, or the next read finds it unconfirmed, to retry or delete.
        return dropUnboundRun(
          updateMessage(activity, messageId, { status: "sent", messageSeq, runId: null }),
          messageId,
        );
      }
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
    // Accepted is not confirmed: the files stay until history holds the message or the user deletes it.
    if (command) this.dropAttachments(messageId);
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
  async stopRun(key: string, runId: string, options: { owner?: object } = {}): Promise<void> {
    const run = this.state.transcripts[key] && findRun(this.state.transcripts[key], runId);
    if (!run || (run.state !== "running" && run.state !== "waiting")) return;
    this.updateActivity(key, (activity) => requestStop(activity, runId, this.now()));
    try {
      await this.ensureScope(WRITE_SCOPE, options.owner ?? null);
      this.checkNotWithdrawn(options.owner);
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
      this.noteMissingScope(error);
      this.updateActivity(key, (activity) => revertStop(activity, runId, errorMessage(error)));
    }
  }

  // Approvals -------------------------------------------------------------------

  /**
   * Resolve an approval with the method for its kind: allow once, deny, or a
   * standing allow (`allow-always`), optionally limited to `expiresInDays`
   * days where the gateway takes a duration (exec and the generic kind). Deny
   * is always possible. The gateway offers no field for which bots a standing
   * allow covers. The generic method answers with the approval's actual
   * outcome, which is what the card then shows, even when another reviewer
   * settled it first.
   */
  async resolveApproval(
    key: string,
    approvalId: string,
    decision: ApprovalDecision,
    options: { expiresInDays?: number | null; owner?: object } = {},
  ): Promise<void> {
    const approval = this.state.transcripts[key]?.approvals.find((each) => each.id === approvalId);
    if (!approval || approval.status !== "pending")
      throw new Error("That approval is no longer open.");
    if (approval.submitting) throw new Error("An answer to that approval is already on its way.");
    if (approval.detailOmitted && decision !== "deny") {
      throw new Error(
        "This approval's details were not kept; deny it, or reopen the task to read them before allowing it.",
      );
    }
    if (decision !== "deny" && !approval.allowedDecisions.includes(decision)) {
      throw new Error(`The gateway does not offer ${decision} for this approval.`);
    }
    const days = options.expiresInDays ?? null;
    if (days !== null) {
      if (decision !== "allow-always") throw new Error("Only a standing allow takes a duration.");
      if (approval.kind === "plugin") throw new Error("Plugin approvals take no duration.");
      if (!Number.isInteger(days) || days < 1 || days > MAX_GRANT_DAYS) {
        throw new Error(`A standing allow lasts 1 to ${MAX_GRANT_DAYS} days.`);
      }
    }
    const { method, params } = resolveRequest(approval, decision, days);
    this.updateActivity(key, (activity) =>
      markApproval(activity, approvalId, { submitting: true, error: null }),
    );
    try {
      await this.ensureScope(APPROVALS_SCOPE, options.owner ?? null);
      this.checkNotWithdrawn(options.owner);
      const result = asRecord(await this.request(method, params));
      let resolution: ApprovalResolution | null;
      let applied = true;
      if (method === "approval.resolve") {
        // `{applied, approval}`: the approval as it actually ended.
        resolution = resolutionFromSnapshot(result?.approval);
        applied = result?.applied === true;
        if (!resolution) throw new Error("The gateway did not say how the approval ended.");
      } else {
        // The legacy methods answer `{ok: true}` once the decision is applied.
        resolution = {
          id: approvalId,
          status: decision === "deny" ? "denied" : "allowed",
          decision,
          reason: "user",
          resolvedAt: this.now(),
          resolvedBy: this.host.client.displayName,
          resolver: null,
          applicationStatus: null,
          authoritative: true,
          lossy: false,
          sessionKey: approval.sessionKey,
          runId: approval.runId,
        };
      }
      this.noteApprovalOutcome(resolution);
      if (!applied) {
        this.updateActivity(key, (activity) =>
          markApproval(activity, approvalId, {
            submitting: false,
            error: "It had already been settled; this is how it ended.",
          }),
        );
      }
    } catch (error) {
      this.updateActivity(key, (activity) =>
        markApproval(activity, approvalId, { submitting: false, error: errorMessage(error) }),
      );
      this.noteMissingScope(error);
      throw error;
    }
  }

  /**
   * Remember what the gateway reported about an approval and apply it to every
   * task showing it. Kept apart from the cards, so a request or list entry that
   * arrives later can never make it actionable again.
   */
  private noteApprovalOutcome(resolution: ApprovalResolution): void {
    const known = mergeResolution(this.approvalOutcomes.get(resolution.id), resolution);
    if (known.lossy) void this.lookUpOutcome(resolution.id);
    this.approvalOutcomes.delete(resolution.id);
    this.approvalOutcomes.set(resolution.id, known);
    while (this.approvalOutcomes.size > MAX_APPROVAL_OUTCOMES) {
      this.approvalOutcomes.delete(this.approvalOutcomes.keys().next().value as string);
    }
    if (this.unrouted.delete(resolution.id)) this.publishUnrouted();
    for (const transcript of Object.values(this.state.transcripts)) {
      if (transcript.approvals.some((approval) => approval.id === resolution.id)) {
        this.updateActivity(transcript.sessionKey, (activity) =>
          applyApprovalResolved(activity, known),
        );
      }
    }
    // A settled approval makes room for one that was waiting.
    this.routeUnrouted();
  }

  /**
   * A legacy exec or plugin resolution said `deny`, which the gateway also
   * sends when it cancelled the approval or it expired: read the approval's
   * own snapshot (`approval.get`, under the `operator.approvals` the client
   * already holds) for how it ended. Until it answers, or if it cannot, the
   * approval shows closed with its cause unknown, never as a denial.
   */
  private async lookUpOutcome(id: string): Promise<void> {
    if (this.lookingUp.has(id) || this.lookingUp.size >= MAX_OUTCOME_LOOKUPS) return;
    if (!this.holds(APPROVALS_SCOPE)) return;
    const generation = this.generation;
    this.lookingUp.add(id);
    try {
      const result = asRecord(await this.request("approval.get", { id }));
      if (generation !== this.generation) return;
      const resolution = resolutionFromSnapshot(result?.approval);
      if (resolution && resolution.id === id) this.noteApprovalOutcome(resolution);
    } catch (error) {
      if (generation === this.generation) this.noteMissingScope(error);
      this.log("warn", `approval.get failed: ${errorMessage(error)}`);
    } finally {
      this.lookingUp.delete(id);
    }
  }

  /**
   * The followed task an approval belongs in, and how it got there: where it
   * already is; its own session; the task holding its run; the task that
   * spawned its session (a helper); or the task whose `sessions_send` result
   * named its run, or, for an approval naming no run, its session (a messaged
   * bot). Null when no followed task is known to be its origin.
   */
  private approvalTarget(
    card: ApprovalCard,
  ): { key: string; parent: string | null; relation: ApprovalCard["relation"] } | null {
    const transcripts = Object.values(this.state.transcripts).filter((each) =>
      this.tracked(each.sessionKey),
    );
    for (const transcript of transcripts) {
      const existing = transcript.approvals.find((approval) => approval.id === card.id);
      if (existing) {
        return {
          key: transcript.sessionKey,
          parent: existing.parentSessionKey,
          relation: existing.relation,
        };
      }
    }
    if (card.sessionKey && this.tracked(card.sessionKey)) {
      return { key: card.sessionKey, parent: null, relation: null };
    }
    if (card.runId) {
      const holder = transcripts.find((each) => findRun(each, card.runId!) !== undefined);
      if (holder) return { key: holder.sessionKey, parent: null, relation: null };
    }
    const spawner = card.sessionKey ? this.spawnedBy.get(card.sessionKey) : undefined;
    if (spawner && this.tracked(spawner)) {
      return { key: spawner, parent: spawner, relation: "helper" };
    }
    for (const [key, links] of this.recipients) {
      if (!this.tracked(key)) continue;
      if (
        (card.runId !== null && links.runs.has(card.runId)) ||
        (card.runId === null && card.sessionKey !== null && links.sessions.has(card.sessionKey))
      ) {
        return { key, parent: key, relation: "messaged" };
      }
    }
    return null;
  }

  /**
   * Put a pending approval in the one task it belongs to, with where it came
   * from. One no followed task can show yet is kept in `unroutedApprovals`
   * until its origin is known. What the gateway already reported about it is
   * applied at once, so it never shows as actionable after its resolution.
   */
  private routeApproval(card: ApprovalCard): void {
    const outcome = this.approvalOutcomes.get(card.id);
    const target = this.approvalTarget(card);
    if (!target) {
      if (!outcome && card.status === "pending") this.keepUnrouted(card);
      return;
    }
    const shown = this.state.transcripts[target.key]?.approvals.some((each) => each.id === card.id);
    if (!shown && !outcome && !this.hasPendingRoom(target.key)) {
      // The task shows as many pending approvals as it may: this one waits, kept and visible.
      this.keepUnrouted({ ...card, parentSessionKey: target.parent, relation: target.relation });
      return;
    }
    if (this.unrouted.delete(card.id)) this.publishUnrouted();
    this.updateActivity(target.key, (activity) => {
      let next = applyApprovalRequested(activity, {
        ...card,
        parentSessionKey: target.parent,
        relation: target.relation,
      });
      if (outcome) next = applyApprovalResolved(next, outcome);
      return next;
    });
  }

  /** Keep an approval no task shows yet; past the bound it is not kept and is counted instead. */
  private keepUnrouted(card: ApprovalCard): void {
    if (!this.unrouted.has(card.id) && this.unrouted.size >= MAX_UNROUTED_APPROVALS) {
      this.unroutedOmitted += 1;
      this.publishUnrouted();
      return;
    }
    this.unrouted.set(card.id, card);
    this.publishUnrouted();
  }

  private publishUnrouted(): void {
    this.store.update((state) => ({
      ...state,
      unroutedApprovals: [...this.unrouted.values()],
      unroutedApprovalsOmitted: this.unroutedOmitted,
    }));
  }

  /** Whether a task can show one more pending approval. */
  private hasPendingRoom(key: string, extra = 0): boolean {
    const pending = (this.state.transcripts[key]?.approvals ?? []).filter(
      (approval) => approval.status === "pending",
    ).length;
    return pending + extra < MAX_PENDING_APPROVALS_PER_TASK;
  }

  /** Approvals kept without a task: route the ones whose origin is now known. */
  private routeUnrouted(): void {
    if (this.unrouted.size === 0) return;
    for (const card of [...this.unrouted.values()]) {
      if (this.approvalTarget(card)) this.routeApproval(card);
    }
  }

  /**
   * Pending approvals for one task, from `exec.approval.list`,
   * `plugin.approval.list` and `openclaw.approval.list`, when it opens and
   * after every reconnect. Each list is read against a revision and the
   * task's opening: a response older than one already applied, or from an
   * earlier opening or connection, changes nothing. Each kind's access is kept
   * apart, and a list refused for a missing scope drops that scope. On a
   * connection without `operator.approvals` the task says approvals are
   * unavailable.
   */
  private async backfillApprovals(key: string, generation: number): Promise<void> {
    if (!this.holds(APPROVALS_SCOPE)) {
      for (const kind of APPROVAL_KINDS) this.setApprovalSource(key, kind, "unavailable");
      return;
    }
    await Promise.all(
      APPROVAL_SOURCES.map((source) => this.backfillApprovalKind(key, source, generation)),
    );
  }

  private async backfillApprovalKind(
    key: string,
    source: (typeof APPROVAL_SOURCES)[number],
    generation: number,
  ): Promise<void> {
    const incarnation = this.incarnations.get(key);
    const listKey = `${key}\u0000${source.kind}`;
    const revision = (this.listRequested.get(listKey) ?? 0) + 1;
    this.listRequested.set(listKey, revision);
    const stale = () =>
      generation !== this.generation ||
      !this.tracked(key) ||
      this.incarnations.get(key) !== incarnation ||
      (this.listApplied.get(listKey) ?? 0) > revision;
    if (this.state.transcripts[key]?.approvalSources[source.kind] !== "ready")
      this.setApprovalSource(key, source.kind, "loading");
    // Only approvals pending now can be found settled by this list; later arrivals are newer than it.
    const pendingBefore = new Set(
      (this.state.transcripts[key]?.approvals ?? [])
        .filter((approval) => approval.status === "pending" && approval.kind === source.kind)
        .map((approval) => approval.id),
    );
    let value: unknown;
    try {
      value = await this.request(source.method, {});
    } catch (error) {
      if (stale()) return;
      // A failure is this revision's answer too: an older list arriving later changes nothing.
      this.listApplied.set(listKey, revision);
      this.noteMissingScope(error);
      this.setApprovalSource(key, source.kind, isMissingScope(error) ? "unavailable" : "error");
      this.log("warn", `${source.method} failed: ${errorMessage(error)}`);
      return;
    }
    if (stale()) return;
    this.listApplied.set(listKey, revision);
    const record = asRecord(value);
    const items = Array.isArray(value)
      ? value
      : Array.isArray(record?.approvals)
        ? record.approvals
        : Array.isArray(record?.items)
          ? record.items
          : [];
    const mine: ApprovalCard[] = [];
    const shownIds = new Set((this.state.transcripts[key]?.approvals ?? []).map((each) => each.id));
    let added = 0;
    for (const card of items
      .map((item) => source.parse(item))
      .filter((each): each is ApprovalCard => each !== null && each.status === "pending")) {
      const target = this.approvalTarget(card);
      if (target?.key !== key) {
        if (!target && !this.approvalOutcomes.has(card.id)) this.keepUnrouted(card);
        continue;
      }
      const placed = { ...card, parentSessionKey: target.parent, relation: target.relation };
      const settled = this.approvalOutcomes.has(card.id);
      if (shownIds.has(card.id) || settled || this.hasPendingRoom(key, added)) {
        if (!shownIds.has(card.id) && !settled) added += 1;
        mine.push(placed);
        if (this.unrouted.delete(card.id)) this.publishUnrouted();
      } else {
        // The task shows as many pending approvals as it may: this one waits, kept and visible.
        this.keepUnrouted(placed);
      }
    }
    this.updateActivity(key, (activity) => {
      let next = activity;
      for (const card of mine) {
        next = applyApprovalRequested(next, card);
        const outcome = this.approvalOutcomes.get(card.id);
        if (outcome) next = applyApprovalResolved(next, outcome);
      }
      return settleUnlistedApprovals(
        next,
        [source.kind],
        new Set(mine.map((card) => card.id)),
        pendingBefore,
      );
    });
    // Another list may have been refused for the scope meanwhile: this one cannot be kept current then.
    this.setApprovalSource(key, source.kind, this.holds(APPROVALS_SCOPE) ? "ready" : "unavailable");
  }

  private setApprovalSource(key: string, kind: ApprovalKind, access: ApprovalSourceAccess): void {
    const transcript = this.state.transcripts[key];
    if (!transcript || transcript.approvalSources[kind] === access) return;
    const approvalSources = { ...transcript.approvalSources, [kind]: access };
    this.setTranscript(key, () => ({
      ...transcript,
      approvalSources,
      approvalAccess: approvalAccessOf(approvalSources),
    }));
  }

  /** Expire pending approvals at their `expiresAt`, then re-read the lists to confirm. */
  private scheduleApprovalExpiry(key: string): void {
    const transcript = this.state.transcripts[key];
    const existing = this.expiryTimers.get(key);
    if (existing) clearTimeout(existing);
    this.expiryTimers.delete(key);
    const next = Math.min(
      ...(transcript?.approvals ?? [])
        .filter((approval) => approval.status === "pending" && approval.expiresAt !== null)
        .map((approval) => approval.expiresAt!),
    );
    if (!Number.isFinite(next)) return;
    this.expiryTimers.set(
      key,
      setTimeout(
        () => {
          this.expiryTimers.delete(key);
          this.updateActivity(key, (activity) => expireApprovals(activity, this.now()));
          void this.backfillApprovals(key, this.generation);
        },
        // setTimeout fires at once past 2^31-1 ms; re-check at that horizon instead.
        Math.min(MAX_TIMER_MS, Math.max(0, next - this.now())),
      ),
    );
  }

  // Linked runs -------------------------------------------------------------------

  /** Apply an event to a session nobody has open, keeping a few recent runs of a few sessions. */
  private updateForeign(
    sessionKey: string,
    fn: (activity: TaskActivity, ctx: EngineContext) => TaskActivity,
  ): void {
    const before = this.foreign.get(sessionKey) ?? emptyActivity;
    let next = fn(before, { sessionKey, now: this.now(), raw: this.foreignRaw });
    if (next === before) return;
    if (next.runs.length > FOREIGN_RUNS_PER_SESSION) {
      next = { ...next, runs: next.runs.slice(-FOREIGN_RUNS_PER_SESSION) };
    }
    // Steps of foreign runs are not shown; keep only the run states.
    next = {
      ...next,
      runs: next.runs.map((run) => (run.steps.length ? { ...run, steps: [] } : run)),
    };
    this.foreignRaw.clearTask(sessionKey);
    this.foreign.delete(sessionKey);
    this.foreign.set(sessionKey, next);
    while (this.foreign.size > FOREIGN_SESSIONS) {
      const oldest = this.foreign.keys().next().value as string;
      this.foreign.delete(oldest);
    }
    const changed = next.runs.some((run) => findRun(before, run.id)?.state !== run.state);
    if (!changed) return;
    for (const key of Object.keys(this.state.transcripts)) {
      this.refreshLinkedRuns(key);
      // An approval from a helper or a messaged bot follows that run's end.
      if (this.state.transcripts[key]?.approvals.some((approval) => approval.relation !== null))
        this.updateActivity(key, (activity) => activity);
    }
  }

  /** A run this task does not hold: a followed foreign session's, or another task's. */
  private otherRun(runId: string): Run | undefined {
    for (const activity of this.foreign.values()) {
      const run = findRun(activity, runId);
      if (run) return run;
    }
    for (const transcript of Object.values(this.state.transcripts)) {
      const run = findRun(transcript, runId);
      if (run) return run;
    }
    return undefined;
  }

  /** Copy the state of every recipient run a task's `sessions_send` results name, where it is known. */
  private refreshLinkedRuns(key: string): void {
    const transcript = this.state.transcripts[key];
    if (!transcript) return;
    const rawOf = (step: Run["steps"][number]) => step.raw ?? this.raw.get(key, step.id);
    const links = recipientLinks(transcript.runs, rawOf);
    const known = this.recipients.get(key);
    const runs = new Set(links.flatMap((link) => (link.runId ? [link.runId] : [])));
    const sessions = new Set(links.flatMap((link) => (link.sessionKey ? [link.sessionKey] : [])));
    const grew =
      [...runs].some((id) => !known?.runs.has(id)) ||
      [...sessions].some((id) => !known?.sessions.has(id));
    this.recipients.set(key, { runs, sessions });
    // A send result naming a recipient can place an approval that arrived before it.
    if (grew) this.routeUnrouted();
    const ids = recipientRunIds(transcript.runs, rawOf);
    const linked: Record<string, LinkedRun> = {};
    for (const id of ids) {
      for (const [sessionKey, activity] of [
        ...this.foreign.entries(),
        ...Object.entries(this.state.transcripts),
      ] as Array<[string, TaskActivity]>) {
        const run = findRun(activity, id);
        if (run) linked[id] = linkedRunOf(run, sessionKey);
      }
    }
    const current = transcript.linkedRuns;
    const same =
      Object.keys(current).length === Object.keys(linked).length &&
      Object.entries(linked).every(
        ([id, run]) =>
          current[id]?.state === run.state &&
          current[id]?.endedAt === run.endedAt &&
          current[id]?.outcomeKnown === run.outcomeKnown,
      );
    if (!same)
      this.setTranscript(key, () => ({ ...this.state.transcripts[key]!, linkedRuns: linked }));
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
    options: { owner?: object } = {},
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
    await this.resolveQuestion(
      key,
      questionId,
      { id: questionId, answers: { answers } },
      options.owner ?? null,
    );
  }

  /** Close a question card with its X: the bot is told there is no answer and carries on. */
  async dismissQuestion(
    key: string,
    questionId: string,
    options: { owner?: object } = {},
  ): Promise<void> {
    this.pendingQuestion(key, questionId);
    await this.resolveQuestion(
      key,
      questionId,
      { id: questionId, cancel: true },
      options.owner ?? null,
    );
  }

  private pendingQuestion(key: string, questionId: string) {
    const question = this.state.transcripts[key]?.questions.find((each) => each.id === questionId);
    if (!question || question.status !== "pending")
      throw new Error("That question is no longer open.");
    if (question.submitting) throw new Error("An answer to that question is already on its way.");
    return question;
  }

  private async resolveQuestion(
    key: string,
    questionId: string,
    params: RawRecord,
    owner: object | null,
  ): Promise<void> {
    this.updateActivity(key, (activity) =>
      markQuestion(activity, questionId, { submitting: true, error: null }),
    );
    try {
      await this.ensureScope(QUESTIONS_SCOPE, owner);
      this.checkNotWithdrawn(owner);
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
      this.noteMissingScope(error);
      throw error;
    }
  }

  /**
   * Pending questions for one task, from `question.list`, after it reloads.
   * Fenced like the approval lists: a response older than one applied, or
   * from an earlier opening or connection, changes nothing.
   */
  private async backfillQuestions(key: string, generation: number): Promise<void> {
    if (!this.holds(QUESTIONS_SCOPE)) return;
    const incarnation = this.incarnations.get(key);
    const listKey = `${key}\u0000question`;
    const revision = (this.listRequested.get(listKey) ?? 0) + 1;
    this.listRequested.set(listKey, revision);
    const stale = () =>
      generation !== this.generation ||
      !this.tracked(key) ||
      this.incarnations.get(key) !== incarnation ||
      (this.listApplied.get(listKey) ?? 0) > revision;
    const pendingBefore = new Set(
      (this.state.transcripts[key]?.questions ?? [])
        .filter((question) => question.status === "pending")
        .map((question) => question.id),
    );
    try {
      const result = asRecord(await this.request("question.list", {}));
      if (stale()) return;
      this.listApplied.set(listKey, revision);
      const records = (Array.isArray(result?.questions) ? result.questions : [])
        .map((entry) => asRecord(entry))
        .filter(
          (record): record is RawRecord =>
            record?.sessionKey === key && record.status === "pending",
        );
      this.updateActivity(key, (activity, ctx) => {
        let next = activity;
        for (const record of records) next = applyQuestionRequested(next, record, ctx);
        return settleMissingQuestions(
          next,
          new Set(records.map((record) => String(record.id))),
          pendingBefore,
        );
      });
    } catch (error) {
      if (!stale()) {
        this.listApplied.set(listKey, revision);
        this.noteMissingScope(error);
      }
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
    const next = retainActivity(
      settleQuestionsOfEndedRuns(
        normalizeApprovals(fn(current, this.context(key)), (runId) => this.otherRun(runId)),
      ),
      Number.POSITIVE_INFINITY,
    );
    if (next === current) return;
    const admitted = this.admit(key, current, { ...current, ...next });
    this.dropRawOfRemovedSteps(key, current, admitted);
    this.setTranscript(key, () => withLive(admitted));
    this.afterActivity(key);
  }

  /**
   * After any change: keep turn timers, release held messages once their
   * question is settled, start the oldest queued run once nothing is active,
   * and let go of a closed task whose work is done. Not re-entrant: a change
   * made while it runs makes it run once more instead of nesting, so no
   * message is claimed twice.
   */
  private afterActivity(key: string): void {
    if (this.afterRunning.has(key)) {
      this.afterAgain.add(key);
      return;
    }
    this.afterRunning.add(key);
    try {
      do {
        this.afterAgain.delete(key);
        this.afterActivityOnce(key);
      } while (this.afterAgain.has(key));
    } finally {
      this.afterRunning.delete(key);
    }
  }

  private afterActivityOnce(key: string): void {
    const transcript = this.state.transcripts[key];
    if (!transcript) return;
    this.refreshLinkedRuns(key);
    this.scheduleApprovalExpiry(key);
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
          setTimeout(
            () => this.turnLimitReached(key, run.id),
            Math.min(MAX_TIMER_MS, Math.max(0, limit - elapsed)),
          ),
        );
      }
    }
    const active = activeRun(transcript);
    const held = transcript.outbox
      .filter((message) => message.status === "held")
      .map((message) => message.id);
    if (held.length > 0 && !(active && questionPending(transcript, active))) {
      // The question is settled: claim every held message at once, then deliver them in order.
      this.updateActivity(key, (activity) =>
        held.reduce((next, id) => updateMessage(next, id, { status: "sending" }), activity),
      );
      for (const id of held) this.enqueueDelivery(key, id);
    }
    const current = this.state.transcripts[key];
    if (!current) return;
    const next = activeRun(current)
      ? undefined
      : current.runs.find((run) => run.state === "queued");
    if (next) {
      this.updateActivity(key, (activity) =>
        updateMessage(startQueuedRun(activity, next.id, this.now()), next.id, {
          status: "sending",
          mode: "new",
        }),
      );
      this.enqueueDelivery(key, next.id);
    }
    if (this.retained.has(key) && !hasUnsettledWork(this.state.transcripts[key] ?? emptyActivity)) {
      this.releaseTask(key);
    }
  }

  /**
   * Deliveries for one task run one at a time, in the order they were made,
   * so messages reach the gateway in the order the user sent them.
   */
  private enqueueDelivery(key: string, messageId: string): void {
    if (!this.state.connection.canWrite && this.outgoing(key, messageId)?.status === "sending") {
      this.updateActivity(key, (activity) =>
        updateMessage(activity, messageId, { status: "awaiting-access" }),
      );
    }
    const previous = this.deliveries.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => this.deliver(key, messageId))
      .catch((error: unknown) => this.log("error", `delivery failed: ${errorMessage(error)}`));
    this.deliveries.set(key, next);
    void next.then(() => {
      if (this.deliveries.get(key) === next) this.deliveries.delete(key);
    });
  }

  private turnLimitReached(key: string, runId: string): void {
    this.turnTimers.delete(`${key}\u0000${runId}`);
    const run = this.state.transcripts[key] && findRun(this.state.transcripts[key], runId);
    if (!run || !isActive(run.state)) return;
    const limit = this.options.turnLimitMs ?? DEFAULT_TURN_LIMIT_MS;
    if (this.now() - (run.startedAt ?? this.now()) < limit) {
      // Woken early by the timer ceiling: arm again.
      this.afterActivity(key);
      return;
    }
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
        this.dropAttachments(run.id);
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

    const stored = await this.loadToken(settings.url, identity.deviceId, "operator");
    if (generation !== this.generation) return;
    const paired = stored !== null;
    // Reopening the same gateway keeps what is on screen until fresh data arrives.
    const sameGateway = this.state.connection.gatewayUrl === settings.url;
    const hasData = sameGateway && this.state.bots.length > 0;
    if (!sameGateway) {
      this.rows = new Map();
      this.raw.clear();
      // Work kept for another gateway's tasks is never carried to this one.
      this.retained.clear();
      this.forgetGatewayState();
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

    const tokenStore = this.connectionTokenStore(settings.url, generation);
    const lifecycle = new GatewayBrowserDeviceAuthLifecycle({
      loadIdentity: async () => {
        const loaded = await this.loadIdentity();
        return { ...loaded, sign: (payload) => this.host.signer.sign(payload) };
      },
      tokenStore,
      nowMs: () => this.now(),
    });
    this.auth = { url: settings.url, generation, tokenStore, lifecycle };

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
        const token = await this.loadToken(settings.url, identity.deviceId, "operator");
        // Once paired, the device token is the credential; the bootstrap token is no longer sent.
        const bootstrap = token ? null : settings.token;
        // Exactly the scopes this client means to hold, never what the token happens to allow.
        const requested = token ? token.heldScopes : [...READ_SCOPES];
        const plan = await lifecycle.buildPlan({
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
        caps: capsFor(plan.scopes),
        ...(plan.auth ? { auth: plan.auth } : {}),
        ...(plan.device ? { device: plan.device } : {}),
        locale: "en-US",
        userAgent: `clawtrate/${this.host.client.version}`,
      }),
      onConnectHello: async (hello, context) => {
        await lifecycle.acceptHello(hello, context.plan);
        // Only this connection may drop this gateway's bootstrap secret.
        if (generation !== this.generation || this.settings?.url !== settings.url) return;
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
        this.handleConnectFailure(error, identity.deviceId, settings.url, tokenStore),
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
            // No connection, no effective access; the next hello says what is granted.
            canWrite: false,
            canAnswer: false,
            canApprove: false,
          });
        }
      },
      onReconnectScheduled: (delayMs) => {
        if (generation !== this.generation) return;
        this.setConnection({ retryAt: this.now() + delayMs });
      },
      onReconnectStopped: (error) => {
        if (generation !== this.generation) return;
        this.rejectAccessWaiters(new Error(`The connection stopped: ${error.message}`));
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
      requestTimeoutMs: this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      reconnect: { initialMs: reconnect.initialMs, multiplier: 2, maxMs: reconnect.maxMs },
    });
    this.protocol.start();
  }

  /** What one gateway reported that must never be read against another. */
  private forgetGatewayState(): void {
    this.approvalOutcomes.clear();
    this.unrouted.clear();
    this.recipients.clear();
    this.spawnedBy.clear();
    this.foreign.clear();
    this.foreignRaw.clear();
    this.listRequested.clear();
    this.listApplied.clear();
    for (const { bytes } of this.attachmentContent.values()) this.attachmentBytes -= bytes;
    this.attachmentContent.clear();
    this.attachmentChars.clear();
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
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
  }

  private handleConnectFailure(
    error: GatewayProtocolRequestError,
    deviceId: string,
    url: string,
    tokenStore: GatewayBrowserDeviceTokenStore,
  ) {
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
      void tokenStore.clear(this.tokenParams(deviceId));
    }

    const pause = shouldPauseGatewayReconnect({ details: error.details });
    this.setConnection({
      status: pause ? "error" : this.everConnected ? "reconnecting" : "connecting",
      pairing: null,
      error: { code, message: error.message, hint },
    });
    // The gateway stopped accepting this device: work waiting for access will not get it on this connection.
    if (pause)
      this.rejectAccessWaiters(new Error(`The gateway refused this device: ${error.message}`));
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
      canApprove: scopeSatisfied(scopes, APPROVALS_SCOPE),
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
    for (const key of Object.keys(this.state.transcripts)) {
      if (this.tracked(key)) void this.loadTranscript(key, true, resync);
    }

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
      linkedRuns: {},
      interSession: [],
      retention: emptyRetention,
    };
  }

  private setTranscript(key: string, fn: (current: Transcript | undefined) => Transcript): void {
    this.touched.delete(key);
    this.touched.set(key, true);
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
  /**
   * Reads of one task run one at a time: a read asked for while one is in
   * flight runs once after it, with the strongest resync reason asked for.
   * A response is applied only to the same connection and the same opening of
   * the task, so a slow read never overwrites newer state.
   */
  private loadTranscript(
    key: string,
    subscribe: boolean,
    resync: CaughtUp["reason"] | null,
  ): Promise<void> {
    const load = this.loads.get(key);
    if (load) {
      load.again = {
        subscribe: (load.again?.subscribe ?? false) || subscribe,
        resync: strongerResync(load.again?.resync ?? null, resync),
      };
      return load.done;
    }
    const entry: {
      done: Promise<void>;
      again: { subscribe: boolean; resync: CaughtUp["reason"] | null } | null;
    } = {
      done: Promise.resolve(),
      again: null,
    };
    this.loads.set(key, entry);
    entry.done = (async () => {
      let next: { subscribe: boolean; resync: CaughtUp["reason"] | null } | null = {
        subscribe,
        resync,
      };
      while (next) {
        await this.readTranscript(key, next.subscribe, next.resync);
        next = entry.again;
        entry.again = null;
      }
      if (this.loads.get(key) === entry) this.loads.delete(key);
    })();
    return entry.done;
  }

  /**
   * Read a task's history and rebuild its runs from it. Runs already on screen
   * are merged by id and steps by id, and outgoing messages leave the outbox
   * once history holds them, so a reload never duplicates anything.
   */
  private async readTranscript(
    key: string,
    subscribe: boolean,
    resync: CaughtUp["reason"] | null,
  ): Promise<void> {
    const generation = this.generation;
    const incarnation = this.incarnations.get(key);
    const stale = () =>
      generation !== this.generation ||
      !this.tracked(key) ||
      this.incarnations.get(key) !== incarnation;
    // Runs active when the read starts; one the gateway then no longer has has ended.
    const activeBefore = new Set(
      (this.state.transcripts[key]?.runs ?? [])
        .filter((run) => run.bound && !isTerminal(run.state) && run.state !== "queued")
        .map((run) => run.id),
    );
    try {
      if (subscribe) {
        await this.request("sessions.messages.subscribe", { key }).catch((error: unknown) => {
          this.log("warn", `sessions.messages.subscribe failed: ${String(error)}`);
        });
      }
      const history = asRecord(
        await this.request("chat.history", { sessionKey: key, limit: HISTORY_LIMIT }),
      );
      if (stale()) return;
      const inFlight = asRecord(history?.inFlightRun);
      const inFlightId = typeof inFlight?.runId === "string" ? inFlight.runId : null;
      const messages = history?.messages;
      const ctx = this.context(key);
      // History is built aside; only the steps the merge takes from it bring their raw payloads.
      const scratch = new RawTable();
      const fromHistory = runsFromHistory(
        messages,
        inFlight,
        { ...ctx, raw: scratch },
        { startCut: history?.hasMore === true },
      );
      const current = this.state.transcripts[key] ?? this.emptyTranscript(key);
      const merge = mergeHistoryRuns(current.runs, fromHistory, ctx);
      for (const stepId of merge.fromHistory) {
        const payload = scratch.get(key, stepId);
        if (payload) this.raw.set(key, stepId, payload);
      }
      const runs = settleVanishedRuns(
        merge.runs,
        activeBefore,
        new Set(fromHistory.map((run) => run.id)),
        inFlightId,
        ctx,
      );
      const reconciled = reconcileOutbox({ ...current, runs }, messages);
      // History holds these now: their files are no longer needed.
      for (const message of current.outbox) {
        if (!reconciled.outbox.some((each) => each.id === message.id))
          this.dropAttachments(message.id);
      }
      const activity = markUnconfirmed(reconciled);
      const rebuilt: Transcript = {
        ...current,
        ...retainActivity(
          settleQuestionsOfEndedRuns(normalizeApprovals(activity, (runId) => this.otherRun(runId))),
          Number.POSITIVE_INFINITY,
        ),
        sessionKey: key,
        status: "ready",
        items: mapHistory(messages),
        interSession: interSessionMessages(messages),
        error: null,
        hasMore: history?.hasMore === true,
        caughtUp: resync ? { reason: resync, at: this.now() } : current.caughtUp,
        // A new page: nothing of it was dropped yet.
        retention: { ...current.retention, itemsOmitted: 0 },
      };
      const admitted = this.admit(key, current, rebuilt);
      this.dropRawOfRemovedSteps(key, current, admitted);
      this.setTranscript(key, () => withLive(admitted));
      this.afterActivity(key);
      void this.backfillQuestions(key, generation);
      void this.backfillApprovals(key, generation);
    } catch (error) {
      if (stale()) return;
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
    this.noteSpawnedBy(payload);
    if (!this.tracked(key)) {
      this.updateForeign(key, (activity, ctx) => applyChatEvent(activity, payload, null, ctx));
      return;
    }
    // Only tasks this client follows keep a stream baseline.
    const { event: projected } = this.streams.project(event);
    const text =
      payload.state === "delta"
        ? liveTextFromChatMessage(asRecord(projected.payload)?.message)
        : null;
    this.updateActivity(key, (activity, ctx) => applyChatEvent(activity, payload, text, ctx));
    // final, aborted or error: the durable transcript now owns the text.
    if (payload.state !== "delta" && payload.state !== "status") this.scheduleHistory(key);
  }

  /** Agent events carry the session key on the wire; fall back to the open task that knows the run. */
  /** Remember which session spawned which, so a helper's approval reaches its parent task. */
  private noteSpawnedBy(payload: RawRecord): void {
    const child = payload.sessionKey;
    const parent = payload.spawnedBy;
    if (typeof child !== "string" || typeof parent !== "string" || child === parent) return;
    const known = this.spawnedBy.get(child) === parent;
    this.spawnedBy.delete(child);
    this.spawnedBy.set(child, parent);
    while (this.spawnedBy.size > MAX_SPAWN_LINKS)
      this.spawnedBy.delete(this.spawnedBy.keys().next().value as string);
    // A helper's approval that arrived before its spawn was known can be placed now.
    if (!known) this.routeUnrouted();
  }

  private handleAgent(event: EventFrame): void {
    const payload = asRecord(event.payload);
    if (!payload || typeof payload.runId !== "string") return;
    this.noteSpawnedBy(payload);
    let key = typeof payload.sessionKey === "string" ? payload.sessionKey : null;
    if (!key) {
      const runId = payload.runId;
      key =
        Object.values(this.state.transcripts).find((transcript) => findRun(transcript, runId))
          ?.sessionKey ?? null;
    }
    if (!key) return;
    if (!this.tracked(key)) {
      this.updateForeign(key, (activity, ctx) => applyAgentEvent(activity, payload, ctx).activity);
      return;
    }
    this.updateActivity(key, (activity, ctx) => applyAgentEvent(activity, payload, ctx).activity);
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
        if (typeof key === "string" && this.tracked(key)) this.scheduleHistory(key);
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
        if (record && key && this.tracked(key)) {
          this.updateActivity(key, (activity, ctx) =>
            applyQuestionRequested(activity, record, ctx),
          );
        }
        return;
      }
      case "exec.approval.requested":
      case "plugin.approval.requested":
      case "openclaw.approval.requested": {
        const card =
          event.event === "exec.approval.requested"
            ? parseExecApproval(event.payload)
            : event.event === "plugin.approval.requested"
              ? parsePluginApproval(event.payload)
              : parseSystemAgentApproval(event.payload);
        if (card) this.routeApproval(card);
        return;
      }
      case "exec.approval.resolved":
      case "plugin.approval.resolved":
      case "openclaw.approval.resolved": {
        const kind: ApprovalKind =
          event.event === "exec.approval.resolved"
            ? "exec"
            : event.event === "plugin.approval.resolved"
              ? "plugin"
              : "system-agent";
        const resolution = parseApprovalResolved(event.payload, kind);
        // Kept even when no card has arrived yet: its request or list entry may come later.
        if (resolution) this.noteApprovalOutcome(resolution);
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

  private async loadToken(
    url: string,
    deviceId: string,
    role: string,
  ): Promise<StoredDeviceToken | null> {
    const raw = await this.host.storage.get(this.tokenKey(url, deviceId, role));
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
    url: string,
    deviceId: string,
    role: string,
    record: StoredDeviceToken,
  ): Promise<void> {
    await this.host.storage.set(this.tokenKey(url, deviceId, role), JSON.stringify(record));
  }

  private tokenParams(deviceId: string) {
    return { clientId: CLIENT_ID, deviceId, role: "operator" };
  }

  /** Device tokens are scoped to one gateway, so a token is never offered to another. */
  private tokenKey(url: string, deviceId: string, role: string): string {
    return `deviceToken:${encodeURIComponent(url)}:${deviceId}:${role}`;
  }

  /**
   * A token store for one connection. Every operation names its gateway URL,
   * and a write is dropped once that connection is no longer current, checked
   * after every wait, so a late write can never land after a switch.
   */
  private connectionTokenStore(url: string, generation: number): GatewayBrowserDeviceTokenStore {
    const current = () => generation === this.generation && this.settings?.url === url;
    return {
      // The lifecycle uses the record's scopes for reconnects. Report the
      // scopes this client means to hold, so a broader grant is never asked for.
      load: async ({ deviceId, role }) => {
        const record = await this.loadToken(url, deviceId, role);
        return record ? { token: record.token, scopes: [...record.heldScopes] } : null;
      },
      store: async ({ deviceId, role, token, scopes }) => {
        if (!current()) return;
        const existing = await this.loadToken(url, deviceId, role);
        if (!current()) return;
        await this.writeToken(url, deviceId, role, {
          token,
          grantedScopes: scopes,
          heldScopes: existing?.heldScopes ?? [...READ_SCOPES],
        });
      },
      clear: async ({ deviceId, role }) => {
        if (!current()) return;
        await this.host.storage.delete(this.tokenKey(url, deviceId, role));
      },
    };
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

const RESYNC_STRENGTH: Record<CaughtUp["reason"], number> = { reconnect: 1, gap: 2 };

function strongerResync(
  a: CaughtUp["reason"] | null,
  b: CaughtUp["reason"] | null,
): CaughtUp["reason"] | null {
  if (!a) return b;
  if (!b) return a;
  return RESYNC_STRENGTH[b] > RESYNC_STRENGTH[a] ? b : a;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
