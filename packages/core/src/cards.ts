// Message cards: a typed view over steps, for the "Messaged <bot>" card
// (grok-bot-flows §6.1) and the external MCP / coding-agent card (§6.2).
// Steps are not changed. Every field comes from the step's own call and result
// as the gateway sent them (capability map rows 7 and 19, section 5); where the
// events do not tie two things together, the selector does not either.

import type { ApprovalCard } from "./approvals.ts";
import { asRecord, type RawRecord } from "./mapping.ts";
import type { TranscriptItem } from "./types.ts";
import {
  isOpenStep,
  isTerminal,
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
  /**
   * False when the run is known to have ended but not how (the engine's
   * `outcomeKnown`): its state is then a stand-in and says nothing about the
   * recipient's outcome.
   */
  outcomeKnown: boolean;
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
  /** Paths of fields cut to their bound. */
  cut?: string[];
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
  /**
   * The send was accepted and the recipient's run has ended, but nothing
   * established how: no reply came back in the call, and the run's outcome is
   * unknown.
   */
  | "recipient-outcome-unknown"
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
  /** The error the call returned or its result states, whenever it has one, including after Stop. */
  error: string | null;
  /**
   * Whether the message reached the recipient is not established: the call
   * closed without a result, or its result says it was aborted, or it failed
   * while the sender was stopped without a delivery status.
   */
  deliveryUncertain: boolean;
  state: BotMessageState;
  approvalId: string | null;
  /**
   * When the model asked for the send (the tool's start). A request is not a
   * delivery: approval or execution may follow minutes later.
   */
  requestedAt: number | null;
  /** When the gateway reports the message sent. It reports no such time, so this stays null. */
  sentAt: null;
  /** When this connection saw the call's result, if it has one. */
  resultAt: number | null;
  endedAt: number | null;
  /** Bumped when the gateway explicitly corrected the call's result; previous card states then do not hold. */
  correction: number;
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
  /**
   * The call is T3 Code's: its tool, as identified, is one of T3 Code's
   * published tools (`T3_CODE_TOOLS`), on whatever server. Decided per call;
   * no server is T3 Code as a whole.
   */
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
  /** The error the call returned, whenever it returned one, including after Stop. */
  error: string | null;
  /**
   * Whether the external server received the call is not established: the
   * sender was stopped before a result, or the result says the call was
   * aborted or cancelled. Kept apart from whether the call returned an error.
   */
  deliveryUncertain: boolean;
  /** The sender's run was stopped after the call returned: work it handed over may continue there. */
  workMayContinue: boolean;
  approvalId: string | null;
  /** When the model asked for the call (the tool's start). Not a delivery time. */
  requestedAt: number | null;
  /** The gateway reports no delivery time, so this stays null. */
  sentAt: null;
  /** When this connection saw the call's result, if it has one. */
  resultAt: number | null;
  endedAt: number | null;
  /** Bumped when the gateway explicitly corrected the call's result. */
  correction: number;
};

export type CardInput = {
  runs: Run[];
  approvals?: ApprovalCard[];
  /** Recipient runs seen on this connection, by run id. */
  linkedRuns?: Record<string, LinkedRun>;
  interSession?: InterSessionMessage[];
};

/**
 * T3 Code's published tools. A tool-server call is T3 Code's when its own
 * tool is one of these, on any server: by the result's `details.mcpTool`, or
 * before its result by the gateway's map of effective names, which the result
 * overrules. Nothing makes a server as a whole T3 Code.
 */
export const T3_CODE_TOOLS: readonly string[] = [
  "t3_project_list",
  "t3_thread_launch",
  "t3_thread_send",
  "t3_thread_read",
  "t3_thread_wait",
  "t3_thread_list",
  "t3_thread_interrupt",
];

/** A tool-server tool, by its server and its own name. */
export type McpToolIdentity = { server: string; tool: string };

/**
 * The tool-server tools of a `tools.effective` answer, by effective name:
 * `{groups: [{tools: [{id, source: "mcp", mcpServer, mcpToolName}]}]}`
 * (`ToolsEffectiveEntrySchema` in OpenClaw 2026.10.6). A tool the session is
 * denied is left out; past `max`, the rest are not kept.
 */
export function mcpToolMap(value: unknown, max: number): Record<string, McpToolIdentity> {
  const out: Record<string, McpToolIdentity> = {};
  let count = 0;
  const groups = asRecord(value)?.groups;
  for (const group of Array.isArray(groups) ? groups : []) {
    const tools = asRecord(group)?.tools;
    for (const entry of Array.isArray(tools) ? tools : []) {
      const tool = asRecord(entry);
      if (tool?.source !== "mcp" || tool.deniedBySession === true) continue;
      const name = str(tool.id);
      const server = str(tool.mcpServer);
      const own = str(tool.mcpToolName);
      if (!name || !server || !own || name in out) continue;
      if (count >= max) return out;
      out[name] = { server, tool: own };
      count += 1;
    }
  }
  return out;
}

/**
 * The built-in and plugin tools of a `tools.effective` answer, by effective
 * name (`source` `core` or `plugin`): the tools a general card may fold by
 * name (8.3). A tool the session is denied is left out; past `max`, the rest
 * are not kept.
 */
export function builtinToolNames(value: unknown, max: number): string[] {
  const out = new Set<string>();
  const groups = asRecord(value)?.groups;
  for (const group of Array.isArray(groups) ? groups : []) {
    const tools = asRecord(group)?.tools;
    for (const entry of Array.isArray(tools) ? tools : []) {
      const tool = asRecord(entry);
      if ((tool?.source !== "core" && tool?.source !== "plugin") || tool.deniedBySession === true)
        continue;
      const name = str(tool.id);
      if (!name) continue;
      if (out.size >= max) return [...out];
      out.add(name);
    }
  }
  return [...out];
}

export type CardOptions = {
  /**
   * Exact tool names known to be MCP tools, with their server and tool, for
   * example from the gateway's tool catalog. Tool names are sanitized,
   * shortened and de-duplicated by the gateway, so they are never parsed; a
   * call is recognized before its result only through this map.
   */
  mcpTools?: Readonly<Record<string, McpToolIdentity>>;
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
export function callArgs(raw: StepRaw | null): RawRecord | null {
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
export function resultBody(raw: StepRaw | null): RawRecord | null {
  const result = asRecord(raw?.result);
  if (!result) return null;
  return asRecord(result.result) ?? result;
}

/**
 * What a bot-to-bot send's result says about the delivery: its `details`,
 * live. `chat.history` keeps only `details.sessionKey` for `sessions_send`;
 * the same fields (`status`, `runId`, `reply`, `error`, `sentBeforeError`)
 * are then in the result's own text, the JSON object the tool returned. That
 * object is read only when the text is exactly one, and `details` wins.
 */
export function sendDetails(body: RawRecord | null): RawRecord | null {
  const details = asRecord(body?.details);
  if (str(details?.status)) return details;
  const blocks = Array.isArray(body?.content) ? body.content : [];
  const texts = blocks
    .map((block) => asRecord(block))
    .filter((block) => block?.type === "text" && typeof block.text === "string");
  if (texts.length !== 1) return details;
  let parsed: RawRecord | null;
  try {
    parsed = asRecord(JSON.parse(texts[0]!.text as string));
  } catch {
    return details;
  }
  if (!parsed || Array.isArray(parsed) || !str(parsed.status)) return details;
  return { ...parsed, ...details };
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
  "recipient-outcome-unknown": 4,
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
  // An ending that history could not establish says nothing about the recipient's outcome.
  if (!run.outcomeKnown && (isTerminal(run.state) || run.state === "stopping")) {
    return "recipient-outcome-unknown";
  }
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
  const details = sendDetails(body);
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
    // No delivery status. A closed call with no result, or a result that says
    // it was aborted, does not say whether the message went out. A returned
    // error stays an error: Stop winning the sender's run does not undo it.
    const aborted = details?.aborted === true;
    if (!hasResult || (step.status === "failed" && aborted)) state = "unknown";
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
    error:
      state === "failed" || state === "blocked-by-policy" || (hasResult && step.status === "failed")
        ? error
        : null,
    deliveryUncertain: state === "unknown" || (!status && stopped && step.status === "failed"),
    state,
    approvalId: approval?.id ?? null,
    requestedAt: step.startedAt,
    sentAt: null,
    resultAt: hasResult ? step.endedAt : null,
    endedAt: step.endedAt,
    correction: step.correction,
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
): McpCallCard {
  const args = callArgs(raw);
  const body = resultBody(raw);
  const details = asRecord(body?.details);
  const approval = approvalFor(step, input.approvals ?? []);
  const stopped = run.state === "stopped" || run.state === "stopping";
  const hasResult = raw?.result !== null && raw?.result !== undefined;
  // Only the result's own structured fields identify an abort; error text is never read for it.
  const aborted =
    details?.aborted === true || details?.status === "aborted" || details?.status === "cancelled";
  let state: McpCallState;
  if (isOpenStep(step)) state = "started";
  else if (approval?.status === "denied") state = "not-sent";
  else if (!hasResult || (step.status === "failed" && aborted)) state = "unknown";
  // A returned error stays an error: Stop winning the sender's run does not undo it.
  else if (step.status === "failed") state = "failed";
  else state = "returned";
  const { files, links } = contentAttachments(body);
  return {
    id: step.id,
    stepId: step.id,
    toolCallId: step.toolCallId,
    runId: run.id,
    server: identity.server,
    tool: identity.tool,
    codingAgent: T3_CODE_TOOLS.includes(identity.tool),
    text: str(args?.message),
    args: args ?? null,
    result: step.result,
    structuredContent: details?.structuredContent ?? null,
    files,
    links,
    state,
    error: hasResult && step.status === "failed" ? step.error : null,
    deliveryUncertain: state === "unknown" || (stopped && step.status === "failed"),
    workMayContinue: stopped && state === "returned",
    approvalId: approval?.id ?? null,
    requestedAt: step.startedAt,
    sentAt: null,
    resultAt: hasResult ? step.endedAt : null,
    endedAt: step.endedAt,
    correction: step.correction,
  };
}

/** Turn a task's steps into Messaged cards and MCP call cards. */
export function selectMessageCards(input: CardInput, options: CardOptions): SelectedCards {
  const rawOf = options.rawOf ?? ((step: Step) => step.raw);
  // A previous state holds only for the same result: an explicit correction starts again from the facts.
  const previousBot = new Map(options.previous?.botMessages.map((card) => [card.id, card]));
  const previousMcp = new Map(options.previous?.mcpCalls.map((card) => [card.id, card]));
  const prior = <T extends { state: S; correction: number }, S>(
    previous: Map<string, T>,
    card: { id: string; correction: number },
  ): S | undefined => {
    const before = previous.get(card.id);
    return before && before.correction === card.correction ? before.state : undefined;
  };
  const botMessages: BotMessageCard[] = [];
  const mcpCalls: McpCallCard[] = [];

  for (const run of input.runs) {
    for (const step of run.steps) {
      if (step.kind !== "tool") continue;
      const raw = rawOf(step);
      if (step.toolName === BOT_MESSAGE_TOOL) {
        const card = botMessageCard(step, run, raw, input);
        card.state = advanceBotMessageState(prior(previousBot, card), card.state);
        botMessages.push(card);
        continue;
      }
      const identity = mcpIdentity(step, resultBody(raw), options);
      if (!identity) continue;
      const card = mcpCallCard(step, run, raw, identity, input);
      card.state = advanceMcpCallState(prior(previousMcp, card), card.state);
      mcpCalls.push(card);
    }
  }
  return { botMessages, mcpCalls, incoming: [...(input.interSession ?? [])] };
}

/**
 * Inter-session messages in a history page: rows with `provenance.kind:
 * "inter_session"`. The map names the fields but not whether they sit on the
 * row or under `__openclaw`, so both are read. The brief of a task a bot started
 * (`TranscriptItem.brief` in `items`, the same page as `mapHistory` made it) is
 * none: OpenClaw 2026.11.10 stores it with the provenance of the task it came
 * from (`sourceTool: "sessions_spawn"`), 2026.10.6 with none, and either way it
 * shows as the bot's brief (F-565).
 */
export function interSessionMessages(
  messages: unknown,
  items: readonly TranscriptItem[] = [],
): InterSessionMessage[] {
  const out: InterSessionMessage[] = [];
  const briefs = new Set(items.filter((item) => item.brief).map((item) => item.id));
  (Array.isArray(messages) ? messages : []).forEach((entry, index) => {
    const row = asRecord(entry);
    if (!row) return;
    const meta = asRecord(row["__openclaw"]) ?? {};
    const provenance = asRecord(row.provenance) ?? asRecord(meta.provenance);
    if (provenance?.kind !== "inter_session") return;
    const itemId = `${str(meta.id) ?? `row-${index}`}:${index}`;
    if (briefs.has(itemId)) return;
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
      itemId,
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
    outcomeKnown: run.outcomeKnown,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
  };
}

/**
 * The recipients a task's `sessions_send` results name: the recipient's run and session, as sent,
 * and whether the result left the reply to come later (`delivery.status: "pending"`). For such a
 * send the gateway itself starts a turn in the sending task once the recipient's run ends: the
 * reply when that run ended well, a note that the delivery failed when it did not (2026.10.6 and
 * 2026.11.10, `runSessionsSendA2AFlow`).
 */
export function recipientLinks(
  runs: Run[],
  rawOf: (step: Step) => StepRaw | null,
): Array<{ runId: string | null; sessionKey: string | null; deliveryPending: boolean }> {
  const links: Array<{
    runId: string | null;
    sessionKey: string | null;
    deliveryPending: boolean;
  }> = [];
  for (const run of runs) {
    for (const step of run.steps) {
      if (step.toolName !== BOT_MESSAGE_TOOL) continue;
      const details = sendDetails(resultBody(rawOf(step)));
      const runId = str(details?.runId);
      const sessionKey = str(details?.sessionKey);
      const deliveryPending = str(asRecord(details?.delivery)?.status) === "pending";
      if (runId || sessionKey) links.push({ runId, sessionKey, deliveryPending });
    }
  }
  return links;
}

/** Recipient run ids named by a task's `sessions_send` results. */
export function recipientRunIds(runs: Run[], rawOf: (step: Step) => StepRaw | null): string[] {
  const ids: string[] = [];
  for (const run of runs) {
    for (const step of run.steps) {
      if (step.toolName !== BOT_MESSAGE_TOOL) continue;
      const id = str(sendDetails(resultBody(rawOf(step)))?.runId);
      if (id) ids.push(id);
    }
  }
  return ids;
}
