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
  | "error";

export type PairingRequest = {
  requestId: string;
  deviceId: string;
  message: string;
  /** Command an operator runs on the gateway host to approve this request. */
  approveCommand: string;
  requestedScopes: string[];
};

export type ConnectionError = { code: string; message: string; hint: string | null };

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

export type Transcript = {
  sessionKey: string;
  status: "loading" | "ready" | "error";
  items: TranscriptItem[];
  error: string | null;
  hasMore: boolean;
  /** Text of a run that is streaming right now, before it lands in history. */
  live: { runId: string; text: string } | null;
};

export type ClawtrateState = {
  connection: ConnectionState;
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
  paired: false,
};

export const initialState: ClawtrateState = {
  connection: initialConnectionState,
  bots: [],
  tasksByBot: {},
  transcripts: {},
};
