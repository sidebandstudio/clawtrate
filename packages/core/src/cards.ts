// Message cards: a typed view over steps, for the "Messaged <bot>" card
// (grok-bot-flows §6.1) and the external MCP / coding-agent card (§6.2).
// Steps are not changed. Every field comes from the step's own call and result
// as the gateway sent them (capability map rows 7 and 19, section 5); where the
// events do not tie two things together, the selector does not either.

import type { ApprovalCard } from "./approvals.ts";
import { asRecord, type RawRecord } from "./mapping.ts";
import {
  isOpenStep,
  type Run,
  type RunState,
  type Step,
  type StepRaw,
  type StepText,
} from "./runs.ts";

/** The state of another session's run, when this connection received its events. */
export type LinkedRun = {
  id: string;
  sessionKey: string;
  state: RunState;
  startedAt: number | null;
  endedAt: number | null;
};

/** A message that reached this task from another session (`provenance.kind: "inter_session"`). */
export type InterSessionMessage = {
  /** The transcript item it is. */
  itemId: string;
  text: string;
  sourceSessionKey: string | null;
  sourceTool: string | null;
  senderLabel: string | null;
  senderAgentId: string | null;
  timestamp: number | null;
};

export type BotMessageState =
  // Non-terminal
  /**
   * The call started; delivery is not established. A tool start, or a
   * `toolCall` in history, is the model's request: the gateway may not have
   * executed it.
   */
  | "started"
  | "waiting-for-approval"
  | "sent"
  | "working"
  | "recipient-waiting"
  | "no-reply-yet"
  /** The call ended without a result that says what happened, or the sender was stopped. */
  | "unknown"
  // Terminal
  | "replied"
  | "failed"
  | "blocked-by-policy"
  | "not-sent"
  | "recipient-stopped";

export type Recipient = {
  sessionKey: string | null;
  /** From the key's `agent:<id>:` prefix, or the arguments' `agentId`. */
  agentId: string | null;
  label: string | null;
  /** Where the recipient was read from: the result's session key, or the call's arguments. */
  source: "result" | "arguments" | null;
};

export type BotMessageCard = {
  /** The step id, `tool:<toolCallId>`; one card per call. */
  id: string;
  stepId: string;
  toolCallId: string | null;
  /** The sender's run. */
  runId: string;
  recipient: Recipient;
  /** `args.message`. */
  text: string | null;
  /** `result.details.reply`. A late reply is never attached: no identifier ties it to one card. */
  reply: { text: string } | null;
  /** `result.details.runId`: the recipient's run. */
  recipientRunId: string | null;
  recipientRunState: RunState | null;
  /** `result.details.status` exactly as sent. */
  resultStatus: string | null;
  error: string | null;
  state: BotMessageState;
  approvalId: string | null;
  sentAt: number | null;
  endedAt: number | null;
};

export type McpCallState =
  /** The call started; whether the server received it is not established. */
  | "started"
  /** The tool returned a result. That is not a claim that the external work is finished. */
  | "returned"
  /** The call ended without a result that says what happened, or the sender was stopped. */
  | "unknown"
  // Terminal
  | "failed"
  | "not-sent";

export type McpCallCard = {
  id: string;
  stepId: string;
  toolCallId: string | null;
  runId: string;
  server: string;
  tool: string;
  /** The server is one of the configured coding-agent servers. */
  codingAgent: boolean;
  /** `args.message`, when the call has one. */
  text: string | null;
  /** The call's arguments exactly as sent, for target fields such as a project or thread. */
  args: unknown;
  result: StepText | null;
  /** `result.details.structuredContent` as sent. */
  structuredContent: unknown;
  /** Only what the call's own result content carries. */
  files: Array<{ name: string | null; mimeType: string | null; uri: string | null }>;
  links: Array<{ uri: string; title: string | null }>;
  state: McpCallState;
  error: string | null;
  /** The sender's run was stopped after the call returned: work it handed over may continue there. */
  workMayContinue: boolean;
  approvalId: string | null;
  sentAt: number | null;
  endedAt: number | null;
};

export type CardInput = {
  runs: Run[];
  approvals?: ApprovalCard[];
  /** Recipient runs seen on this connection, by run id. */
  linkedRuns?: Record<string, LinkedRun>;
  interSession?: InterSessionMessage[];
};

export type CardOptions = {
  /**
   * MCP server names (`details.mcpServer`) to treat as the coding agent. No
   * product name is built in.
   */
  codingServers: readonly string[];
  /**
   * Exact tool names known to be MCP tools, with their server and tool, for
   * example from the gateway's tool catalog. Tool names are sanitized,
   * shortened and de-duplicated by the gateway, so they are never parsed; a
   * call is recognized before its result only through this map.
   */
  mcpTools?: Readonly<Record<string, { server: string; tool: string }>>;
  /** Cards returned last time, so states only move forward. */
  previous?: SelectedCards;
  /** Full raw payloads for steps too large to carry theirs inline (the client's `stepRaw`). */
  rawOf?: (step: Step) => StepRaw | null;
};

export type SelectedCards = {
  botMessages: BotMessageCard[];
  mcpCalls: McpCallCard[];
  /**
   * Inter-session messages, shown as incoming messages. The gateway's late
   * reply carries only its source session and tool, not the send it answers,
   * so it is never attached to a card.
   */
  incoming: InterSessionMessage[];
};

export const BOT_MESSAGE_TOOL = "sessions_send";

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** The call's arguments, live (`args`) or from history (`arguments`, possibly a JSON string). */
function callArgs(raw: StepRaw | null): RawRecord | null {
  const call = asRecord(raw?.call);
  const value = call?.args ?? call?.arguments ?? call?.input;
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return asRecord(value);
}

/** The result's `{content, details}`, live (`result.result`) or from history (the row). */
function resultBody(raw: StepRaw | null): RawRecord | null {
  const result = asRecord(raw?.result);
  if (!result) return null;
  return asRecord(result.result) ?? result;
}

function agentFromKey(key: string | null): string | null {
  return key ? (/^agent:([^:]+):/.exec(key)?.[1] ?? null) : null;
}

function approvalFor(step: Step, approvals: ApprovalCard[]): ApprovalCard | undefined {
  const linked = approvals.filter(
    (approval) =>
      approval.stepId === step.id || (step.approvalId !== null && approval.id === step.approvalId),
  );
  return linked.at(-1);
}

const BOT_RANK: Record<BotMessageState, number> = {
  started: 0,
  "waiting-for-approval": 1,
  sent: 2,
  working: 3,
  "recipient-waiting": 3,
  "no-reply-yet": 4,
  unknown: -1,
  replied: 5,
  failed: 5,
  "blocked-by-policy": 5,
  "not-sent": 5,
  "recipient-stopped": 5,
};

/**
 * §6.1 precedence (Started stands for Sending): forward only; Working and Recipient waiting alternate;
 * No reply yet rests until a terminal state; Unknown can move anywhere; a
 * terminal state is final.
 */
export function advanceBotMessageState(
  previous: BotMessageState | undefined,
  next: BotMessageState,
): BotMessageState {
  if (previous === undefined || previous === "unknown") return next;
  if (BOT_RANK[previous] === 5) return previous;
  // A call that closed without a delivery result becomes Unknown; a known delivery never does.
  if (next === "unknown") return BOT_RANK[previous] <= 1 ? next : previous;
  return BOT_RANK[next] >= BOT_RANK[previous] ? next : previous;
}

const MCP_RANK: Record<McpCallState, number> = {
  started: 0,
  returned: 1,
  unknown: -1,
  failed: 2,
  "not-sent": 2,
};

/** §6.2: Started, then Returned, then Failed; Unknown can move to any correlated state; terminal is final. */
export function advanceMcpCallState(
  previous: McpCallState | undefined,
  next: McpCallState,
): McpCallState {
  if (previous === undefined || previous === "unknown") return next;
  if (MCP_RANK[previous] === 2) return previous;
  if (next === "unknown") return previous === "started" ? next : previous;
  return MCP_RANK[next] >= MCP_RANK[previous] ? next : previous;
}

function recipientState(run: LinkedRun | undefined): BotMessageState | null {
  if (!run) return null;
  switch (run.state) {
    case "queued":
    case "running":
    case "stopping":
      return "working";
    case "waiting":
      return "recipient-waiting";
    case "completed":
      return "no-reply-yet";
    case "failed":
      return "failed";
    case "stopped":
    case "cancelled":
      return "recipient-stopped";
  }
}

function botMessageCard(
  step: Step,
  run: Run,
  raw: StepRaw | null,
  input: CardInput,
): BotMessageCard {
  const args = callArgs(raw);
  const body = resultBody(raw);
  const details = asRecord(body?.details);
  const resultKey = str(details?.sessionKey);
  const argKey = str(args?.sessionKey);
  const recipient: Recipient = {
    sessionKey: resultKey ?? argKey,
    agentId: agentFromKey(resultKey ?? argKey) ?? str(args?.agentId),
    label: str(args?.label),
    source: resultKey
      ? "result"
      : argKey || str(args?.agentId) || str(args?.label)
        ? "arguments"
        : null,
  };
  const recipientRunId = str(details?.runId);
  const linked = recipientRunId ? input.linkedRuns?.[recipientRunId] : undefined;
  const status = str(details?.status);
  const approval = approvalFor(step, input.approvals ?? []);
  const resultReply = str(details?.reply);
  const reply = resultReply ? { text: resultReply } : null;
  const error = str(details?.error) ?? step.error;
  const hasResult = raw?.result !== null && raw?.result !== undefined;

  const fromRecipient = (): BotMessageState =>
    reply ? "replied" : (recipientState(linked) ?? "sent");

  let state: BotMessageState;
  const stopped = run.state === "stopped" || run.state === "stopping";
  if (isOpenStep(step)) {
    state =
      step.status === "waiting" && approval?.status === "pending"
        ? "waiting-for-approval"
        : "started";
  } else if (approval?.status === "denied") {
    state = "not-sent";
  } else if (!status) {
    // No delivery status: a closed call with no result, or an error while the
    // sender was stopped, does not say whether the message went out.
    if (!hasResult || (step.status === "failed" && stopped)) state = "unknown";
    else state = step.status === "failed" ? "failed" : "unknown";
  } else {
    switch (status) {
      case "ok":
        state = reply ? "replied" : recipientRunId ? fromRecipient() : "sent";
        break;
      case "accepted":
        state = recipientRunId ? fromRecipient() : "sent";
        break;
      case "timeout":
        state =
          details?.sentBeforeError === true
            ? recipientRunId
              ? fromRecipient()
              : "sent"
            : "failed";
        break;
      case "no_reply":
        state = "no-reply-yet";
        break;
      case "queued":
        // No run id: sent, and nothing more is known.
        state = "sent";
        break;
      case "forbidden":
        state = "blocked-by-policy";
        break;
      case "error": {
        const fromRun = recipientState(linked);
        state =
          details?.sentBeforeError === true && fromRun === "recipient-stopped"
            ? "recipient-stopped"
            : "failed";
        break;
      }
      default:
        // A status the map does not list says nothing about delivery.
        state = step.status === "failed" ? "failed" : "unknown";
    }
  }

  return {
    id: step.id,
    stepId: step.id,
    toolCallId: step.toolCallId,
    runId: run.id,
    recipient,
    text: str(args?.message),
    reply,
    recipientRunId,
    recipientRunState: linked?.state ?? null,
    resultStatus: status,
    error: state === "failed" || state === "blocked-by-policy" ? error : null,
    state,
    approvalId: approval?.id ?? null,
    sentAt: step.startedAt,
    endedAt: step.endedAt,
  };
}

function contentAttachments(body: RawRecord | null) {
  const files: McpCallCard["files"] = [];
  const links: McpCallCard["links"] = [];
  for (const part of Array.isArray(body?.content) ? body.content : []) {
    const block = asRecord(part);
    if (!block) continue;
    if (block.type === "resource_link" && str(block.uri)) {
      links.push({ uri: block.uri as string, title: str(block.title) ?? str(block.name) });
    } else if (block.type === "resource") {
      const resource = asRecord(block.resource);
      files.push({
        name: str(resource?.name),
        mimeType: str(resource?.mimeType),
        uri: str(resource?.uri),
      });
    } else if (block.type === "image") {
      files.push({ name: null, mimeType: str(block.mimeType), uri: null });
    }
  }
  return { files, links };
}

/**
 * Recognize an external MCP call from its result's `details.mcpServer` and
 * `details.mcpTool`, or, before a result, from the caller's map of exact tool
 * names. The tool name itself is opaque.
 */
function mcpIdentity(step: Step, body: RawRecord | null, options: CardOptions) {
  const details = asRecord(body?.details);
  const server = str(details?.mcpServer);
  const tool = str(details?.mcpTool);
  if (server && tool) return { server, tool };
  const known = step.toolName ? options.mcpTools?.[step.toolName] : undefined;
  return known && str(known.server) && str(known.tool) ? known : null;
}

function mcpCallCard(
  step: Step,
  run: Run,
  raw: StepRaw | null,
  identity: { server: string; tool: string },
  input: CardInput,
  codingServers: readonly string[],
): McpCallCard {
  const args = callArgs(raw);
  const body = resultBody(raw);
  const details = asRecord(body?.details);
  const approval = approvalFor(step, input.approvals ?? []);
  const stopped = run.state === "stopped" || run.state === "stopping";
  const hasResult = raw?.result !== null && raw?.result !== undefined;
  let state: McpCallState;
  if (isOpenStep(step)) state = "started";
  else if (approval?.status === "denied") state = "not-sent";
  else if (!hasResult) state = "unknown";
  else if (step.status === "failed") state = stopped ? "unknown" : "failed";
  else state = "returned";
  const { files, links } = contentAttachments(body);
  return {
    id: step.id,
    stepId: step.id,
    toolCallId: step.toolCallId,
    runId: run.id,
    server: identity.server,
    tool: identity.tool,
    codingAgent: codingServers.includes(identity.server),
    text: str(args?.message),
    args: args ?? null,
    result: step.result,
    structuredContent: details?.structuredContent ?? null,
    files,
    links,
    state,
    error: state === "failed" ? step.error : null,
    workMayContinue: stopped && state === "returned",
    approvalId: approval?.id ?? null,
    sentAt: step.startedAt,
    endedAt: step.endedAt,
  };
}

/** Turn a task's steps into Messaged cards and MCP call cards. */
export function selectMessageCards(input: CardInput, options: CardOptions): SelectedCards {
  const rawOf = options.rawOf ?? ((step: Step) => step.raw);
  const previousBot = new Map(options.previous?.botMessages.map((card) => [card.id, card.state]));
  const previousMcp = new Map(options.previous?.mcpCalls.map((card) => [card.id, card.state]));
  const botMessages: BotMessageCard[] = [];
  const mcpCalls: McpCallCard[] = [];

  for (const run of input.runs) {
    for (const step of run.steps) {
      if (step.kind !== "tool") continue;
      const raw = rawOf(step);
      if (step.toolName === BOT_MESSAGE_TOOL) {
        const card = botMessageCard(step, run, raw, input);
        card.state = advanceBotMessageState(previousBot.get(card.id), card.state);
        botMessages.push(card);
        continue;
      }
      const identity = mcpIdentity(step, resultBody(raw), options);
      if (!identity) continue;
      const card = mcpCallCard(step, run, raw, identity, input, options.codingServers);
      card.state = advanceMcpCallState(previousMcp.get(card.id), card.state);
      mcpCalls.push(card);
    }
  }
  return { botMessages, mcpCalls, incoming: [...(input.interSession ?? [])] };
}

/**
 * Inter-session messages in a history page: rows with `provenance.kind:
 * "inter_session"`. The map names the fields but not whether they sit on the
 * row or under `__openclaw`, so both are read.
 */
export function interSessionMessages(messages: unknown): InterSessionMessage[] {
  const out: InterSessionMessage[] = [];
  (Array.isArray(messages) ? messages : []).forEach((entry, index) => {
    const row = asRecord(entry);
    if (!row) return;
    const meta = asRecord(row["__openclaw"]) ?? {};
    const provenance = asRecord(row.provenance) ?? asRecord(meta.provenance);
    if (provenance?.kind !== "inter_session") return;
    const senderSession = asRecord(row.senderSession) ?? asRecord(meta.senderSession);
    const content = row.content;
    const text =
      typeof content === "string"
        ? content
        : (Array.isArray(content) ? content : [])
            .map((part) => {
              const block = asRecord(part);
              return block?.type === "text" && typeof block.text === "string" ? block.text : "";
            })
            .join("");
    out.push({
      itemId: `${str(meta.id) ?? `row-${index}`}:${index}`,
      text,
      sourceSessionKey: str(provenance.sourceSessionKey),
      sourceTool: str(provenance.sourceTool),
      senderLabel: str(row.senderLabel) ?? str(meta.senderLabel),
      senderAgentId: str(senderSession?.agentId),
      timestamp: typeof row.timestamp === "number" ? row.timestamp : null,
    });
  });
  return out;
}

/** The linked-run summary of a run. */
export function linkedRunOf(run: Run, sessionKey: string): LinkedRun {
  return {
    id: run.id,
    sessionKey,
    state: run.state,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
  };
}

/** Recipient run ids named by a task's `sessions_send` results. */
export function recipientRunIds(runs: Run[], rawOf: (step: Step) => StepRaw | null): string[] {
  const ids: string[] = [];
  for (const run of runs) {
    for (const step of run.steps) {
      if (step.toolName !== BOT_MESSAGE_TOOL) continue;
      const id = str(asRecord(resultBody(rawOf(step))?.details)?.runId);
      if (id) ids.push(id);
    }
  }
  return ids;
}
