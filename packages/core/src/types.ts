// View models the interface renders. Gateway payloads are mapped into these in
// mapping.ts and runs.ts; nothing outside core needs to know the wire shapes.

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
  | "error";

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

export type ConnectionError = { code: string; message: string; hint: string | null };

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
  upgrade: ScopeUpgradeState;
  deviceId: string | null;
  pairing: PairingRequest | null;
  error: ConnectionError | null;
  /** Epoch ms of the next reconnect attempt, when one is scheduled. */
  retryAt: number | null;
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
};

export type TaskStatus = "running" | "done" | "failed" | "idle";

export type Task = {
  key: string;
  botId: string;
  sessionId: string | null;
  title: string;
  preview: string | null;
  updatedAt: number | null;
  status: TaskStatus;
  unread: boolean;
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
  serverVersion: null,
  protocol: null,
  scopes: [],
  requestedScopes: [],
  canWrite: false,
  canAnswer: false,
  upgrade: initialScopeUpgrade,
  deviceId: null,
  pairing: null,
  error: null,
  retryAt: null,
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
};
