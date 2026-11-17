// View models the interface renders. Gateway payloads are mapped into these in
// mapping.ts; nothing outside core needs to know the wire shapes.

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

export type ConnectionState = {
  status: ConnectionStatus;
  gatewayUrl: string | null;
  serverVersion: string | null;
  protocol: number | null;
  scopes: string[];
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
};

export type Transcript = {
  sessionKey: string;
  status: "loading" | "ready" | "error";
  items: TranscriptItem[];
  error: string | null;
  hasMore: boolean;
  /** Text of a run that is streaming right now, before it lands in history. */
  live: { runId: string; text: string } | null;
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
};

export const initialConnectionState: ConnectionState = {
  status: "idle",
  gatewayUrl: null,
  serverVersion: null,
  protocol: null,
  scopes: [],
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
};
