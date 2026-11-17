// View models the interface renders. Gateway payloads are mapped into these in
// mapping.ts and runs.ts; nothing outside core needs to know the wire shapes.

import type { ApprovalCard } from "./approvals.ts";
import type { InterSessionMessage, LinkedRun, McpToolIdentity } from "./cards.ts";
import type { TaskActivity } from "./runs.ts";

export type ConnectionStatus =
  /** No gateway configured yet. */
  | "idle"
  | "connecting"
  /** The gateway knows this device but an operator has not approved it yet. */
  | "pairing"
  | "connected"
  /** Was connected, lost the socket, and is retrying with backoff. */
  | "reconnecting"
  /** Stopped retrying; needs the user to act. */
  | "error"
  /** The user disconnected; the gateway and the pairing are kept until they reconnect. */
  | "disconnected";

export type PairingRequest = {
  requestId: string;
  deviceId: string;
  message: string;
  /** What the person approving runs. The host chooses it, because it knows which gateway this is. */
  approveCommand: string;
  /** Where and by whom the command is run, when that is not obvious. */
  approveNote: string | null;
  requestedScopes: string[];
};

export type ConnectionError = {
  code: string;
  message: string;
  hint: string | null;
  /** For `PROTOCOL_MISMATCH`: the protocol the gateway speaks, and the one this client speaks. */
  protocol?: { gateway: number | null; client: number };
};

export type ScopeUpgradeStatus =
  | "idle"
  /** `device.scopes.requestUpgrade` is on its way. */
  | "requesting"
  /** The gateway holds a pending request; its owner has to approve it. */
  | "pending"
  /** Approved; the client reconnected with the new grant. */
  | "approved"
  | "rejected"
  | "expired"
  /** The request failed, or was approved without the scope it asked for. */
  | "error";

/** Stepping up from `operator.read` to `operator.write`. */
export type ScopeUpgradeState = {
  status: ScopeUpgradeStatus;
  /** The scopes asked for. */
  scopes: string[];
  requestId: string | null;
  /** What the person approving runs, chosen by the host as for pairing. */
  approveCommand: string | null;
  approveNote: string | null;
  error: string | null;
};

export type ConnectionState = {
  status: ConnectionStatus;
  gatewayUrl: string | null;
  /**
   * The gateway's own identity (`gateway.identity.get` `deviceId`), stable
   * across addresses and restarts. Null until it is read, or when the gateway
   * does not give it.
   */
  gatewayId: string | null;
  serverVersion: string | null;
  protocol: number | null;
  /** Scopes the gateway granted this connection (`hello-ok.auth.scopes`). */
  scopes: string[];
  /** Scopes this client asks for on every connect. Never more than it means to hold. */
  requestedScopes: string[];
  /** True while the connection holds `operator.write`, so sending and stopping work. */
  canWrite: boolean;
  /** True while the connection holds `operator.questions`, so question cards can be answered. */
  canAnswer: boolean;
  /** True while the connection holds `operator.approvals`, so approvals can be seen and resolved. */
  canApprove: boolean;
  upgrade: ScopeUpgradeState;
  deviceId: string | null;
  pairing: PairingRequest | null;
  error: ConnectionError | null;
  /** Epoch ms of the next reconnect attempt, when one is scheduled. */
  retryAt: number | null;
  /** Epoch ms of the latest hello: what was loaded before it is not yet in sync. */
  connectedAt: number | null;
  /** True once this device holds a device token for the current gateway. */
  paired: boolean;
};

export type Bot = {
  id: string;
  name: string;
  emoji: string | null;
  /** A data: or https: URL, safe to render directly. */
  avatarUrl: string | null;
  theme: string | null;
  model: string | null;
  isDefault: boolean;
  /** Paths of fields cut to their bound (an avatar too large to keep is dropped). */
  cut?: string[];
};

export type TaskStatus =
  | "running"
  | "done"
  | "failed"
  | "idle"
  /**
   * The next three come from run events (a pending approval or question, an
   * unreachable machine, a failed step in a finished run) that a read-only
   * connection does not receive yet; the mapping never produces them today.
   */
  | "waiting"
  | "blocked"
  | "done-with-failures";

export type Task = {
  key: string;
  botId: string;
  sessionId: string | null;
  title: string;
  preview: string | null;
  updatedAt: number | null;
  status: TaskStatus;
  unread: boolean;
  /**
   * Context use after the latest run: tokens used out of the model's context
   * window. Absent when the gateway does not report both.
   */
  context?: TaskContext;
  /** Paths of fields cut to their bound. */
  cut?: string[];
};

export type TaskContext = {
  used: number;
  window: number;
  /** False when the gateway says the count is from before the latest run. */
  fresh: boolean;
};

export type ToolResult = { isError: boolean; text: string };

export type TranscriptBlock =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | {
      kind: "tool-call";
      callId: string;
      name: string;
      /** Pretty-printed JSON arguments. */
      argumentsText: string;
      result: ToolResult | null;
    };

export type TranscriptItem = {
  /** Stable display key. */
  id: string;
  role: "user" | "assistant" | "system";
  timestamp: number | null;
  blocks: TranscriptBlock[];
  model: string | null;
  /**
   * The gateway cut a row of this item to its display length
   * (`__openclaw.truncated`): present and true only then. Its text, here or
   * read whole, is a prefix of what the gateway stored.
   */
  truncated?: boolean;
  /** Paths of fields cut to their bound; `readHistoryItem` reads the item whole, keeping nothing. */
  cut?: string[];
};

/** One open task: its durable transcript plus its live runs and outgoing messages. */
export type Transcript = TaskActivity & {
  sessionKey: string;
  status: "loading" | "ready" | "error";
  items: TranscriptItem[];
  error: string | null;
  hasMore: boolean;
  /**
   * Text of the task's active run, before it lands in history. Derived from
   * `runs`; kept for views that only draw one streaming bubble.
   */
  live: { runId: string; text: string } | null;
  /** Recipient runs that this task's bot-to-bot sends name, where this connection saw them. */
  linkedRuns: Record<string, LinkedRun>;
  /** Messages from other sessions in this task's history (inter-session provenance). */
  interSession: InterSessionMessage[];
  /**
   * The gateway's current map from a tool-server tool's effective name to its
   * server and tool, as `tools.effective` reports it for this task. Evidence
   * of a call's tool before its result only: the gateway rebuilds it from the
   * current catalog, which need not be the one a running attempt captured, and
   * a result's own `details` overrule it.
   */
  mcpTools: Record<string, McpToolIdentity>;
  /**
   * The built-in and plugin tools `tools.effective` lists for this task, by
   * effective name: a general card of one of these folds by its name (8.3).
   * Absent until the inventory is read.
   */
  builtinTools?: string[];
  /**
   * The bot's workspace root, as the gateway names it (`agents.files.list`
   * `workspace`): an absolute path is a memory note only inside it (8.2).
   * Absent or null when the gateway has not said; nothing is inferred then.
   */
  workspaceRoot?: string | null;
  /** Paths of fields cut to their bound that no item beneath records itself. */
  cut?: string[];
  /** Epoch ms of the latest successful history load. */
  loadedAt: number | null;
};

/** Loading bots and tasks after each connect, separate from the socket's own state. */
export type DiscoveryState = {
  status: "idle" | "loading" | "ready" | "error";
  /** Set when a read failed; data from earlier successful reads is kept. */
  error: string | null;
  /** True when the gateway reported more tasks than the client loaded. */
  partial: boolean;
};

export type ClawtrateState = {
  connection: ConnectionState;
  discovery: DiscoveryState;
  bots: Bot[];
  tasksByBot: Record<string, Task[]>;
  transcripts: Record<string, Transcript>;
  /**
   * Pending approvals no followed task can show yet: the asking session is not
   * open, and no open task is known to have spawned or messaged it. Kept, with
   * their origin, until a task they belong to is known or the gateway settles
   * them; at most `MAX_UNROUTED_APPROVALS`.
   */
  unroutedApprovals: ApprovalCard[];
  /** Pending approvals not kept because `unroutedApprovals` was full; a list read brings them back. */
  unroutedApprovalsOmitted: number;
  /** Task creations this client has asked for and not yet seen settled (`TaskCreation`). */
  creations: TaskCreation[];
  /**
   * A secondary alarm: roughly what the state takes, against the arithmetic
   * bound of `state-bounds.ts`. The bound holds by construction; `near` only
   * says it is being approached.
   */
  retention: { estimated: number; bound: number; near: boolean };
  /** Paths of fields cut to their bound that nothing beneath records itself. */
  cut?: string[];
};

/**
 * A task creation the user asked for. Kept from before `sessions.create` is
 * sent until the gateway's answer is known, so a request that times out is
 * neither lost nor sent twice: it is checked again with the same idempotency
 * key, which the gateway answers with the original outcome.
 */
export type TaskCreation = {
  /** Also the `idempotencyKey`. */
  id: string;
  botId: string;
  text: string;
  label: string | null;
  /**
   * `creating` while the request is out; `checking` when the answer did not
   * come and the same gateway start is being asked again with the same key;
   * `failed` when the gateway refused it (retry or dismiss); `unknown` when
   * nothing establishes whether it happened (dismiss, or the user's own retry,
   * which may create a second task: `error` says so); `created` once the task
   * exists.
   */
  status: "creating" | "checking" | "failed" | "unknown" | "created";
  /** When it was last asked of the gateway; its key is asked again only within `CREATION_KEY_WINDOW_MS` of it. */
  createdAt: number;
  error: string | null;
  /** The new task, once created. */
  key: string | null;
  /**
   * The `hello-ok.server.bootId` of the gateway start the request went to;
   * null if the hello carried none. The key is asked again automatically only
   * of that same start, which holds its idempotency record.
   */
  gatewayBootId: string | null;
};

export const initialScopeUpgrade: ScopeUpgradeState = {
  status: "idle",
  scopes: [],
  requestId: null,
  approveCommand: null,
  approveNote: null,
  error: null,
};

export const initialConnectionState: ConnectionState = {
  status: "idle",
  gatewayUrl: null,
  gatewayId: null,
  serverVersion: null,
  protocol: null,
  scopes: [],
  requestedScopes: [],
  canWrite: false,
  canAnswer: false,
  canApprove: false,
  upgrade: initialScopeUpgrade,
  deviceId: null,
  pairing: null,
  error: null,
  retryAt: null,
  connectedAt: null,
  paired: false,
};

export const initialDiscoveryState: DiscoveryState = {
  status: "idle",
  error: null,
  partial: false,
};

export const initialState: ClawtrateState = {
  connection: initialConnectionState,
  discovery: initialDiscoveryState,
  bots: [],
  tasksByBot: {},
  transcripts: {},
  unroutedApprovals: [],
  unroutedApprovalsOmitted: 0,
  creations: [],
  retention: { estimated: 0, bound: 0, near: false },
};
