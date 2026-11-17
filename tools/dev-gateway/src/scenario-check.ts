// The scenario check: drives every scenario of the scripted model through a
// development gateway instance with the official gateway client, and asserts
// what the gateway emitted. Payloads are checked against the schemas in
// `@openclaw/gateway-protocol` where the protocol defines one (chat, agent,
// question and session approval events); the exec approval event, which has
// no published schema, is checked field by field against the gateway source.
//
// Each check uses a client with only the scopes its scenario needs:
//   plain       operator.read, operator.write                      caps tool-events
//   approvals   + operator.approvals                                caps tool-events, approvals, exec-approvals
//   questions   + operator.questions                                caps tool-events
//
// What the check found that the capability map does not say is recorded in
// docs/decisions.md, "What the scenario check observed".

import {
  AgentEventSchema,
  ChatEventSchema,
  QuestionRequestedEventSchema,
  QuestionResolvedEventSchema,
  SessionApprovalEventSchema,
} from "@openclaw/gateway-protocol/schema";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { CODING_AGENT_SERVER, THREAD_URL_BASE } from "./coding-agent-mcp.ts";
import { TERMINAL_CHAT_STATES, type GatewayEvent, type OperatorSession } from "./operator.ts";
import { SHELL_COMMANDS } from "./scenarios.ts";
import { MESSAGING_PAIR, SHELL_BOT } from "./seed-data.ts";
import { DENIED_TOOLS } from "./cli.ts";

type JsonRecord = Record<string, unknown>;
const rec = (value: unknown): JsonRecord =>
  value !== null && typeof value === "object" ? (value as JsonRecord) : {};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type ClientName = "plain" | "approvals" | "questions";

export const CLIENTS: Record<ClientName, { scopes: string[]; caps: string[] }> = {
  plain: { scopes: ["operator.read", "operator.write"], caps: ["tool-events"] },
  approvals: {
    scopes: ["operator.read", "operator.write", "operator.approvals"],
    caps: ["tool-events", "approvals", "exec-approvals"],
  },
  questions: {
    scopes: ["operator.read", "operator.write", "operator.questions"],
    caps: ["tool-events"],
  },
};

export class CheckFailure extends Error {}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CheckFailure(message);
}

function same(actual: unknown, expected: unknown, what: string): void {
  expect(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

/** Everything one run emitted on one connection, with helpers to read it. */
export class RunView {
  readonly op: OperatorSession;
  readonly runId: string;
  readonly sessionKey: string;
  readonly from: number;

  constructor(op: OperatorSession, runId: string, sessionKey: string, from: number) {
    this.op = op;
    this.runId = runId;
    this.sessionKey = sessionKey;
    this.from = from;
  }

  get events(): GatewayEvent[] {
    return this.op.events.filter(
      (e) =>
        e.seq > this.from &&
        rec(e.payload).runId === this.runId &&
        (e.event === "agent" || e.event === "chat"),
    );
  }

  agent(stream?: string): GatewayEvent[] {
    return this.events.filter(
      (e) => e.event === "agent" && (!stream || rec(e.payload).stream === stream),
    );
  }

  data(e: GatewayEvent): JsonRecord {
    return rec(rec(e.payload).data);
  }

  lifecycle(phase: string): GatewayEvent[] {
    return this.agent("lifecycle").filter((e) => this.data(e).phase === phase);
  }

  tool(phase: string, name?: string): GatewayEvent[] {
    return this.agent("tool").filter(
      (e) => this.data(e).phase === phase && (!name || this.data(e).name === name),
    );
  }

  get terminal(): JsonRecord {
    const end = this.events.find(
      (e) => e.event === "chat" && TERMINAL_CHAT_STATES.includes(String(rec(e.payload).state)),
    );
    return rec(end?.payload);
  }

  /** The tool result's `result` object, for the first result of the tool. */
  result(name: string): {
    isError: unknown;
    content: JsonRecord[];
    details: JsonRecord;
    text: string;
  } {
    const found = this.tool("result", name)[0];
    expect(found, `no tool result for ${name} in run ${this.runId}`);
    const data = this.data(found);
    const result = rec(data.result);
    const content = Array.isArray(result.content) ? (result.content as JsonRecord[]) : [];
    return {
      isError: data.isError,
      content,
      details: rec(result.details),
      text: content.map((part) => String(part.text ?? "")).join(""),
    };
  }

  finalText(): string {
    const message = rec(this.terminal.message);
    const content = Array.isArray(message.content) ? (message.content as JsonRecord[]) : [];
    return content.map((part) => String(part.text ?? "")).join("");
  }

  /** The order of first appearance of each labelled event; fails if any is missing or out of order. */
  inOrder(steps: [string, (e: GatewayEvent) => boolean][]): void {
    let after = -1;
    for (const [label, match] of steps) {
      const found = this.events.find((e) => e.seq > after && match(e));
      expect(found, `expected ${label} after seq ${after} in run ${this.runId}`);
      after = found.seq;
    }
  }

  /** Every chat and agent event of the run matches the protocol schema. */
  validate(): void {
    for (const e of this.events) {
      const kind =
        e.event === "chat"
          ? `chat ${String(rec(e.payload).state)}`
          : `agent ${String(rec(e.payload).stream)}`;
      checkShape(e.event === "chat" ? ChatEventSchema : AgentEventSchema, e.payload, kind);
    }
  }
}

type Schema = TSchema;

/**
 * Top-level fields the gateway sent that the published schema does not
 * declare, by event kind. The published event schemas are closed, so these
 * are reported rather than failed: see "What the scenario check observed".
 */
export const UNDECLARED_FIELDS = new Map<string, Set<string>>();

/**
 * Check a payload against a published schema. Fields the schema does not
 * declare at the top level are noted and set aside; everything it declares
 * must match.
 */
export function checkShape(schema: Schema, payload: unknown, kind: string): void {
  const value = rec(payload);
  const variants = ((schema as { anyOf?: Schema[] }).anyOf ?? [schema]) as {
    properties?: Record<string, unknown>;
  }[];
  const matching =
    variants.find((variant) => {
      const state =
        rec(rec(variant.properties).state).const ?? rec(rec(variant.properties).status).const;
      return state === undefined || state === value.state || state === value.status;
    }) ?? variants[0]!;
  const declared = new Set(Object.keys(matching.properties ?? {}));
  const extra = Object.keys(value).filter((key) => !declared.has(key));
  if (extra.length > 0) {
    const seen = UNDECLARED_FIELDS.get(kind) ?? new Set<string>();
    for (const key of extra) seen.add(key);
    UNDECLARED_FIELDS.set(kind, seen);
  }
  const declaredOnly = Object.fromEntries(
    Object.entries(value).filter(([key]) => declared.has(key)),
  );
  expect(
    Value.Check(schema, declaredOnly),
    `${kind} does not match the protocol schema: ${firstError(schema, declaredOnly)}`,
  );
}

function firstError(schema: Schema, value: unknown): string {
  for (const error of Value.Errors(schema, value)) {
    const e = error as { instancePath?: string; path?: string; message?: string };
    return `${e.instancePath ?? e.path ?? ""} ${e.message ?? ""}`.trim();
  }
  return "unknown";
}

const isAgent = (stream: string, phase?: string) => (e: GatewayEvent) =>
  e.event === "agent" &&
  rec(e.payload).stream === stream &&
  (phase === undefined || rec(rec(e.payload).data).phase === phase);
const isTool = (phase: string, name: string) => (e: GatewayEvent) =>
  isAgent("tool", phase)(e) && rec(rec(e.payload).data).name === name;
const isChat = (state: string) => (e: GatewayEvent) =>
  e.event === "chat" && rec(e.payload).state === state;

export type Harness = {
  op(client: ClientName): OperatorSession;
  /** A new session key for a bot, subscribed on every client. */
  session(botId: string, tag: string): Promise<string>;
  /** Send and return the run, without waiting for it. */
  start(client: ClientName, key: string, message: string, extra?: JsonRecord): Promise<RunView>;
  /** Send, wait for the run to end, and validate its events. */
  run(client: ClientName, key: string, message: string, extra?: JsonRecord): Promise<RunView>;
  wait(view: RunView, timeoutMs?: number): Promise<RunView>;
  /** Note an observation for the report. */
  observe(line: string): void;
  /**
   * Run a message as the gateway's owner, through `openclaw agent`, and
   * return the run as the plain client saw it. Owner-only tools such as
   * `automations` are offered only in such runs.
   */
  ownerRun(botId: string, key: string, message: string): Promise<RunView>;
};

/** What one kind of tool call looks like on the wire, for "What the scenario check observed". */
export type FamilyRow = {
  family: string;
  directive: string;
  tool: string;
  args: string;
  result: string;
  historyDetails: boolean;
  kindHints: string;
};

export const FAMILY_ROWS: FamilyRow[] = [];

/** A compact type shape of a JSON value, two levels deep. */
export function shapeOf(value: unknown, depth = 2): string {
  if (Array.isArray(value)) return value.length === 0 ? "[]" : `[${shapeOf(value[0], depth - 1)}…]`;
  if (value !== null && typeof value === "object") {
    if (depth <= 0) return "{…}";
    const entries = Object.entries(value as JsonRecord).map(
      ([k, v]) => `${k}: ${shapeOf(v, depth - 1)}`,
    );
    return `{${entries.join(", ")}}`;
  }
  return value === null ? "null" : typeof value;
}

/** Record the first call of a tool in a run, with what names its kind besides its name. */
async function recordFamily(
  h: Harness,
  family: string,
  directive: string,
  view: RunView,
  tool: string,
): Promise<void> {
  const history = await h
    .op("plain")
    .request<{ messages: JsonRecord[] }>("chat.history", { sessionKey: view.sessionKey });
  const start = view.tool("start", tool)[0];
  const end = view.tool("result", tool)[0];
  // A client that did not start the run gets item events but no tool events,
  // so for such a run the call and its result come from history.
  const item = view
    .agent("item")
    .find((e) => view.data(e).phase === "start" && view.data(e).name === tool);
  expect(item, `no ${tool} item to record for ${family}`);
  const toolCallId = view.data(item).toolCallId;
  const call = history.messages
    .flatMap((m) => (Array.isArray(m.content) ? (m.content as JsonRecord[]) : []))
    .find((part) => part.type === "toolCall" && part.id === toolCallId);
  const row = history.messages.find((m) => m.role === "toolResult" && m.toolCallId === toolCallId);
  const data = end ? view.data(end) : {};
  const result = end ? rec(data.result) : { content: row?.content, details: row?.details };
  const content = Array.isArray(result.content) ? (result.content as JsonRecord[]) : [];
  const details = rec(result.details);
  const hints = [
    `item.kind "${String(view.data(item).kind)}"`,
    `item.title "${String(view.data(item).title)}"`,
    ...(data.commandBearing === true ? ["commandBearing true"] : []),
    ...(typeof details.mcpServer === "string"
      ? [`details.mcpServer "${details.mcpServer}", mcpTool "${String(details.mcpTool)}"`]
      : []),
  ];
  FAMILY_ROWS.push({
    family,
    directive,
    tool,
    args: shapeOf(start ? view.data(start).args : call?.arguments),
    result:
      `content ${content.map((p) => String(p.type)).join("+") || "none"}; details ${shapeOf(details, 1)}` +
      (end ? "" : " (from history: no tool events reached this client)"),
    historyDetails: row !== undefined && row.details !== undefined,
    kindHints: hints.join("; "),
  });
}

export type ScenarioCheck = {
  name: string;
  /** The directives it exercises. */
  covers: string[];
  run: (h: Harness) => Promise<void>;
};

async function approvalFor(h: Harness, view: RunView): Promise<JsonRecord> {
  const event = await h
    .op("approvals")
    .waitFor(
      `an exec approval for run ${view.runId}`,
      (e) =>
        e.event === "exec.approval.requested" && rec(rec(e.payload).request).runId === view.runId,
      30_000,
    );
  return rec(event.payload);
}

/** Check an exec approval request against the gateway source's shape. */
function checkApprovalRequest(
  approval: JsonRecord,
  view: RunView,
  command: string,
  decisions: string[],
): void {
  const request = rec(approval.request);
  same(approval.approvalKind, "exec", "approvalKind");
  expect(typeof approval.id === "string" && approval.id, "the approval has an id");
  expect(
    typeof approval.createdAtMs === "number" && typeof approval.expiresAtMs === "number",
    "approval times",
  );
  same(request.command, command, "the approval's command");
  same(request.agentId, SHELL_BOT, "the approval's agent");
  same(request.sessionKey, view.sessionKey, "the approval's session");
  same(request.host, "gateway", "the approval's host");
  same(request.security, "allowlist", "the approval's security");
  same(request.allowedDecisions, decisions, "the decisions the approval offers");
  const toolStart = view.tool("start", "exec")[0];
  same(
    request.toolCallId,
    toolStart ? view.data(toolStart).toolCallId : undefined,
    "the approval's tool call",
  );
  const analysis = rec(request.commandAnalysis);
  expect(typeof analysis.commandCount === "number", "the approval carries a command analysis");
}

async function sessionApproval(h: Harness, approvalId: string, phase: string): Promise<JsonRecord> {
  const event = await h
    .op("approvals")
    .waitFor(
      `session.approval ${phase} for ${approvalId}`,
      (e) =>
        e.event === "session.approval" &&
        rec(e.payload).phase === phase &&
        rec(rec(e.payload).approval).id === approvalId,
      30_000,
    );
  checkShape(SessionApprovalEventSchema, event.payload, "session.approval");
  return rec(event.payload);
}

async function question(h: Harness, sessionKey: string): Promise<JsonRecord> {
  const event = await h
    .op("questions")
    .waitFor(
      `a question in ${sessionKey}`,
      (e) => e.event === "question.requested" && rec(e.payload).sessionKey === sessionKey,
      30_000,
    );
  checkShape(QuestionRequestedEventSchema, event.payload, "question.requested");
  return rec(event.payload);
}

async function answer(
  h: Harness,
  asked: JsonRecord,
  answers: Record<string, string[]>,
): Promise<void> {
  const id = String(asked.id);
  const out = await h.op("questions").request("question.resolve", { id, answers: { answers } });
  same(out.status, "answered", "question.resolve status");
  const resolved = await h
    .op("questions")
    .waitFor(
      `question.resolved ${id}`,
      (e) => e.event === "question.resolved" && rec(e.payload).id === id,
    );
  checkShape(QuestionResolvedEventSchema, resolved.payload, "question.resolved");
  same(rec(resolved.payload).status, "answered", "question.resolved status");
  same(rec(rec(resolved.payload).answers).answers, answers, "question.resolved answers");
}

/** A question run: the card, its answer, the tool result and the reply. */
async function questionCheck(
  h: Harness,
  directive: string,
  shape: (questions: JsonRecord[]) => void,
  answers: Record<string, string[]>,
): Promise<void> {
  const key = await h.session("pip", directive.slice(1));
  const seenBefore = h.op("plain").lastSeq;
  const view = await h.start("questions", key, directive);
  const asked = await question(h, key);
  same(asked.agentId, "pip", "question.requested agentId");
  same(asked.runId, view.runId, "question.requested runId");
  same(asked.status, "pending", "question.requested status");
  const questions = (asked.questions as JsonRecord[]) ?? [];
  expect(
    questions.every((q) => q.isOther === true),
    "every question accepts typed text (isOther)",
  );
  shape(questions);
  await answer(h, asked, answers);
  await h.wait(view);
  same(view.terminal.state, "final", "the run's end");
  const result = view.result("ask_user");
  same(result.isError, false, "ask_user isError");
  same(result.details.status, "answered", "ask_user result status");
  same(rec(result.details.answers).answers, answers, "ask_user result answers");
  const lines = Object.entries(answers).map(([id, value]) => `- ${id}: ${value.join(", ")}`);
  same(
    view.finalText(),
    `Thanks. You answered:\n\n${lines.join("\n")}`,
    "the reply after the answer",
  );
  if (directive === "#ask") await recordFamily(h, "questions", "#ask", view, "ask_user");
  // A connection without operator.questions is not sent question events.
  expect(
    !h.op("plain").events.some((e) => e.seq > seenBefore && e.event.startsWith("question.")),
    "a client without operator.questions received a question event",
  );
}

/** A message from Pip to Marlow; returns the sender's run and the send's result. */
async function messageCheck(h: Harness, directive: string) {
  const key = await h.session("pip", directive.slice(1));
  const view = await h.start("plain", key, directive);
  return { key, view };
}

const RECIPIENT = MESSAGING_PAIR[0];
const RECIPIENT_SESSION = `agent:${RECIPIENT}:main`;

export const SCENARIO_CHECKS: ScenarioCheck[] = [
  {
    name: "plain streamed text",
    covers: ["#text"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "text"), "#text");
      view.inOrder([
        ["lifecycle start", isAgent("lifecycle", "start")],
        ["lifecycle model", isAgent("lifecycle", "model")],
        ["assistant text", isAgent("assistant")],
        ["lifecycle end", isAgent("lifecycle", "end")],
        ["chat final", isChat("final")],
      ]);
      same(view.agent("thinking").length, 0, "thinking events");
      const text = "Here is a plain reply, streamed in small pieces with no reasoning first.";
      same(view.finalText(), text, "text");
      const pieces = view.agent("assistant").map((e) => view.data(e));
      same(pieces.map((d) => d.delta).join(""), text, "the assistant deltas add up to the text");
      // Observed: only the first assistant event carries the cumulative text.
      same(pieces[0]!.text, pieces[0]!.delta, "the first assistant event's text");
      expect(
        pieces.length > 1 && pieces.slice(1).some((d) => d.text === undefined),
        "later assistant events carry only delta",
      );
    },
  },
  {
    name: "reasoning then text",
    covers: ["#think"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "think"), "#think");
      view.inOrder([
        ["lifecycle start", isAgent("lifecycle", "start")],
        ["thinking", isAgent("thinking")],
        ["assistant", isAgent("assistant")],
        ["chat final", isChat("final")],
      ]);
      const last = view.agent("thinking").at(-1)!;
      same(
        view.data(last).text,
        "The user wants to see reasoning first. I will reason briefly, then answer.",
        "cumulative reasoning",
      );
      const history = await h
        .op("plain")
        .request<{ messages: JsonRecord[] }>("chat.history", { sessionKey: view.sessionKey });
      const row = history.messages.find((m) => m.role === "assistant");
      same(
        (row?.content as JsonRecord[]).map((part) => part.type),
        ["thinking", "text"],
        "the history row's blocks",
      );
    },
  },
  {
    name: "reasoning only, no text and no tool",
    covers: ["#think-only"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "think-only"), "#think-only");
      // Observed: the gateway asks the model twice more for a visible answer,
      // within the same run, then ends the run in an error.
      same(view.lifecycle("start").length, 3, "model attempts in the run");
      same(view.agent("assistant").length, 0, "assistant events");
      expect(view.agent("thinking").length > 0, "reasoning was streamed");
      same(view.terminal.state, "error", "the run's end");
      const error = view.lifecycle("error")[0];
      expect(error, "lifecycle error");
      same(rec(view.data(error).terminalReply).disposition, "empty", "terminalReply disposition");
    },
  },
  {
    name: "reasoning, tool, reasoning, tool, text",
    covers: ["#steps"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "steps"), "#steps");
      view.inOrder([
        ["lifecycle start", isAgent("lifecycle", "start")],
        ["thinking 1", isAgent("thinking")],
        [
          "item start ls",
          (e) => isAgent("item", "start")(e) && rec(rec(e.payload).data).name === "ls",
        ],
        ["tool start ls", isTool("start", "ls")],
        ["tool result ls", isTool("result", "ls")],
        ["item end ls", (e) => isAgent("item", "end")(e) && rec(rec(e.payload).data).name === "ls"],
        ["lifecycle model", isAgent("lifecycle", "model")],
        ["thinking 2", isAgent("thinking")],
        ["tool start read", isTool("start", "read")],
        ["tool result read", isTool("result", "read")],
        ["assistant", isAgent("assistant")],
        ["lifecycle end", isAgent("lifecycle", "end")],
        ["chat final", isChat("final")],
      ]);
      const start = view.tool("start", "ls")[0]!;
      same(view.data(start).args, { path: "." }, "ls args");
      const item = view.agent("item")[0]!;
      same(view.data(item).itemId, `tool:${String(view.data(start).toolCallId)}`, "item id");
      same(view.result("read").isError, false, "read isError");
    },
  },
  {
    name: "a slow stream, stopped mid-run",
    covers: ["#slow"],
    run: async (h) => {
      const key = await h.session("main", "slow-abort");
      const view = await h.start("plain", key, "#slow 20");
      await h
        .op("plain")
        .waitFor(
          "streamed text",
          (e) => isAgent("assistant")(e) && rec(e.payload).runId === view.runId,
        );
      const out = await h.op("plain").request("chat.abort", { sessionKey: key });
      same(out, { ok: true, aborted: true, runIds: [view.runId] }, "chat.abort result");
      await h.wait(view, 10_000);
      same(view.terminal.state, "aborted", "the run's end");
      same(view.terminal.stopReason, "rpc", "aborted stopReason");
      const end = view.lifecycle("end")[0];
      expect(end, "lifecycle end");
      same(
        [view.data(end).status, view.data(end).aborted],
        ["cancelled", true],
        "lifecycle end status",
      );
      expect(
        view.finalText().startsWith("Here is a long answer"),
        "the aborted event carries the partial text",
      );
    },
  },
  {
    name: "a message queued behind a slow stream",
    covers: ["#slow"],
    run: async (h) => {
      const key = await h.session("main", "slow-queue");
      const first = await h.start("plain", key, "#slow 3");
      await h
        .op("plain")
        .waitFor(
          "streamed text",
          (e) => isAgent("assistant")(e) && rec(e.payload).runId === first.runId,
        );
      const second = await h.start("plain", key, "#text", { queueMode: "followup" });
      expect(second.runId !== first.runId, "the queued message has its own run");
      await h.wait(first);
      await h.wait(second);
      same([first.terminal.state, second.terminal.state], ["final", "final"], "both runs' ends");
      const firstEnd = first.events.find(isChat("final"))!;
      const secondStart = second.lifecycle("start")[0]!;
      expect(secondStart.seq > firstEnd.seq, "the queued run starts after the first one ends");
    },
  },
  {
    name: "a steer into a slow tool",
    covers: ["#slow-tool"],
    run: async (h) => {
      const key = await h.session("main", "slow-tool-steer");
      const first = await h.start("plain", key, "#slow-tool 3");
      await h
        .op("plain")
        .waitFor(
          "the slow tool",
          (e) =>
            isTool("start", `${CODING_AGENT_SERVER}__slow_task`)(e) &&
            rec(e.payload).runId === first.runId,
        );
      const steer = await h.start("plain", key, "#think", { queueMode: "steer" });
      await h.wait(steer, 30_000);
      await h.wait(first, 30_000);
      // Observed: the steer's own run settles at once with an empty final; the
      // tool finishes and the steered message is answered inside the first run.
      same(steer.terminal.state, "final", "the steer run's end");
      same(steer.terminal.message, undefined, "the steer run's final message");
      same(
        first.result(`${CODING_AGENT_SERVER}__slow_task`).isError,
        false,
        "the slow tool still finished",
      );
      same(
        first.finalText(),
        "I thought it over first. This is the answer that follows the reasoning.",
        "the active run answered the steer",
      );
    },
  },
  {
    name: "a tool that fails",
    covers: ["#tool-fail"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "tool-fail"), "#tool-fail");
      same(view.terminal.state, "final", "the run's end");
      const result = view.result("read");
      same(result.isError, true, "read isError");
      same(result.details.status, "error", "result details status");
      const end = view.agent("item").find((e) => view.data(e).phase === "end")!;
      same(view.data(end).status, "failed", "item end status");
    },
  },
  {
    name: "tool output cut by the gateway",
    covers: ["#long-output"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "long-output"), "#long-output");
      const result = view.result(`${CODING_AGENT_SERVER}__long_output`);
      expect(
        result.text.length < 9_000,
        `event text is cut (got ${result.text.length} characters)`,
      );
      expect(result.text.endsWith("…(truncated)…"), "event text ends with the truncation marker");
      const history = await h
        .op("plain")
        .request<{ messages: JsonRecord[] }>("chat.history", { sessionKey: view.sessionKey });
      const row = history.messages.find((m) => m.role === "toolResult")!;
      same(
        [rec(row.__openclaw).truncated, rec(row.__openclaw).reason],
        [true, "display-cap"],
        "history truncation marker",
      );
      const more = await h.op("plain").request<{ messages: JsonRecord[] }>("chat.history", {
        sessionKey: view.sessionKey,
        maxChars: 500_000,
      });
      const longer = more.messages.find((m) => m.role === "toolResult")!;
      const text = (longer.content as JsonRecord[]).map((p) => String(p.text ?? "")).join("");
      expect(text.length > 8_000, "chat.history maxChars returns more of the output");
    },
  },
  {
    name: "a shell command that needs approval, with a reusable rule",
    covers: ["#approve"],
    run: async (h) => {
      const key = await h.session(SHELL_BOT, "approve");
      const view = await h.start("approvals", key, "#approve");
      const approval = await approvalFor(h, view);
      checkApprovalRequest(approval, view, SHELL_COMMANDS.list, [
        "allow-once",
        "allow-always",
        "deny",
      ]);
      same(rec(approval.request).ask, "on-miss", "the approval's ask");
      const id = String(approval.id);
      const pending = await sessionApproval(h, id, "pending");
      same(
        rec(rec(pending.approval).presentation).allowedDecisions,
        ["allow-once", "allow-always", "deny"],
        "session.approval decisions",
      );
      await h
        .op("approvals")
        .waitFor(
          "waiting-approval",
          (e) => isAgent("lifecycle", "waiting-approval")(e) && rec(e.payload).runId === view.runId,
        );
      same(
        await h.op("approvals").request("exec.approval.resolve", { id, decision: "allow-always" }),
        { ok: true },
        "exec.approval.resolve",
      );
      const resolved = await h
        .op("approvals")
        .waitFor(
          "exec.approval.resolved",
          (e) => e.event === "exec.approval.resolved" && rec(e.payload).id === id,
        );
      same(rec(resolved.payload).decision, "allow-always", "resolved decision");
      const terminal = await sessionApproval(h, id, "terminal");
      same(
        [rec(terminal.approval).status, rec(terminal.approval).decision],
        ["allowed", "allow-always"],
        "session.approval terminal",
      );
      await h.wait(view);
      view.inOrder([
        ["tool start exec", isTool("start", "exec")],
        ["waiting-approval", isAgent("lifecycle", "waiting-approval")],
        ["approval-resolved", isAgent("lifecycle", "approval-resolved")],
        ["tool result exec", isTool("result", "exec")],
        ["chat final", isChat("final")],
      ]);
      const result = view.result("exec");
      same(
        [result.isError, result.details.status, result.details.exitCode],
        [false, "completed", 0],
        "exec result",
      );
      await recordFamily(h, "shell", "#approve", view, "exec");
      // The rule is reused: the same command in the same folder runs without asking.
      const again = await h.run("approvals", key, "#approve");
      same(again.result("exec").details.exitCode, 0, "the second run's exec");
      expect(
        !h
          .op("approvals")
          .events.some(
            (e) =>
              e.event === "exec.approval.requested" &&
              rec(rec(e.payload).request).runId === again.runId,
          ),
        "the reusable rule was not applied: the same command asked again",
      );
    },
  },
  {
    name: "a shell command that needs approval, with no reusable rule",
    covers: ["#approve-once"],
    run: async (h) => {
      const key = await h.session(SHELL_BOT, "approve-once");
      const view = await h.start("approvals", key, "#approve-once");
      const approval = await approvalFor(h, view);
      checkApprovalRequest(approval, view, SHELL_COMMANDS.print, ["allow-once", "deny"]);
      same(rec(approval.request).ask, "always", "the approval's ask");
      same(rec(approval.request).unavailableDecisions, ["allow-always"], "unavailableDecisions");
      const id = String(approval.id);
      const refused = await h
        .op("approvals")
        .request("exec.approval.resolve", { id, decision: "allow-always" })
        .then(
          () => null,
          (error: unknown) => error as { message?: string; details?: unknown },
        );
      expect(refused, "allow-always was accepted for a command that offers no reusable rule");
      same(
        rec(refused.details).reason,
        "APPROVAL_ALLOW_ALWAYS_UNAVAILABLE",
        "the refusal's reason",
      );
      same(
        await h.op("approvals").request("exec.approval.resolve", { id, decision: "deny" }),
        { ok: true },
        "deny",
      );
      await h.wait(view);
      same(view.terminal.state, "final", "the run's end");
      same(view.result("exec").isError, true, "a denied exec's isError");
      same(
        view.finalText(),
        "The gateway did not let the command run.",
        "the reply after a denial",
      );
    },
  },
  {
    name: "a command that exits non-zero",
    covers: ["#exit-code"],
    run: async (h) => {
      const key = await h.session(SHELL_BOT, "exit-code");
      const view = await h.start("approvals", key, "#exit-code");
      const approval = await approvalFor(h, view);
      checkApprovalRequest(approval, view, SHELL_COMMANDS.missing, [
        "allow-once",
        "allow-always",
        "deny",
      ]);
      await h
        .op("approvals")
        .request("exec.approval.resolve", { id: approval.id, decision: "allow-once" });
      await h.wait(view);
      const result = view.result("exec");
      same(
        [result.isError, result.details.status, result.details.exitCode],
        [false, "completed", 1],
        "exec result",
      );
      expect(
        result.text.endsWith("(Command exited with code 1)"),
        "the result text names the exit code",
      );
      const end = view.agent("command_output").find((e) => view.data(e).phase === "end");
      expect(end, "command_output end");
      same(view.data(end).exitCode, 1, "command_output exitCode");
    },
  },
  {
    name: "a command that runs past its time limit",
    covers: ["#exec-timeout"],
    run: async (h) => {
      const key = await h.session(SHELL_BOT, "exec-timeout");
      const view = await h.start("approvals", key, "#exec-timeout");
      const approval = await approvalFor(h, view);
      await h
        .op("approvals")
        .request("exec.approval.resolve", { id: approval.id, decision: "allow-once" });
      await h.wait(view);
      const result = view.result("exec");
      same(result.isError, true, "exec isError");
      same(
        [result.details.status, result.details.timedOut, result.details.failureKind],
        ["failed", true, "overall-timeout"],
        "exec timeout details",
      );
      same(view.terminal.state, "final", "the run's end");
    },
  },
  {
    name: "exec stays denied for a bot without the shell",
    covers: ["#approve"],
    run: async (h) => {
      const view = await h.run("approvals", await h.session("pip", "exec-denied"), "#approve");
      const result = view.result("exec");
      same(result.isError, true, "exec isError");
      expect(
        result.text.includes("exec denied: host=gateway security=deny"),
        "the denial names the policy",
      );
      expect(
        !h
          .op("approvals")
          .events.some(
            (e) =>
              e.event === "exec.approval.requested" &&
              rec(rec(e.payload).request).runId === view.runId,
          ),
        "a denied bot raised an approval",
      );
    },
  },
  {
    name: "one question with options",
    covers: ["#ask"],
    run: (h) =>
      questionCheck(
        h,
        "#ask",
        (questions) => {
          same(questions.length, 1, "questions");
          same(questions[0]!.questionId, "route", "questionId");
          same(
            (questions[0]!.options as JsonRecord[]).map((o) => o.label),
            ["Lake loop", "Ridge trail", "Town walk"],
            "options",
          );
        },
        { route: ["Ridge trail"] },
      ),
  },
  {
    name: "several questions in one card",
    covers: ["#ask-many"],
    run: (h) =>
      questionCheck(
        h,
        "#ask-many",
        (questions) =>
          same(
            questions.map((q) => q.questionId),
            ["route", "start_time", "lunch"],
            "question ids",
          ),
        { route: ["Lake loop"], start_time: ["9:30"], lunch: ["No"] },
      ),
  },
  {
    name: "a multi-select question",
    covers: ["#ask-multi"],
    run: (h) =>
      questionCheck(
        h,
        "#ask-multi",
        (questions) => same(questions[0]!.multiSelect, true, "multiSelect"),
        { packing: ["Headlamp", "Snacks"] },
      ),
  },
  {
    name: "a question answered in free text",
    covers: ["#ask-text"],
    run: (h) =>
      questionCheck(
        h,
        "#ask-text",
        (questions) => same(questions[0]!.questionId, "trip_name", "questionId"),
        { trip_name: ["Autumn ramble"] },
      ),
  },
  {
    name: "a message to another bot, answered in the same call",
    covers: ["#message"],
    run: async (h) => {
      const { view } = await messageCheck(h, "#message");
      await h.wait(view, 60_000);
      const start = view.tool("start", "sessions_send")[0]!;
      same(
        view.data(start).args,
        { agentId: RECIPIENT, message: "#reply Could you look over the plan?", timeoutSeconds: 30 },
        "sessions_send args",
      );
      const result = view.result("sessions_send");
      same(
        [result.isError, result.details.status, result.details.sessionKey],
        [false, "ok", RECIPIENT_SESSION],
        "sessions_send result",
      );
      same(rec(result.details.delivery).status, "skipped", "delivery status");
      const recipientRun = String(result.details.runId);
      const recipient = new RunView(h.op("plain"), recipientRun, RECIPIENT_SESSION, view.from);
      same(
        [recipient.terminal.state, recipient.terminal.sessionKey],
        ["final", RECIPIENT_SESSION],
        "the recipient's run",
      );
      recipient.validate();
      same(result.details.reply, recipient.finalText(), "the reply is the recipient's final text");
      same(view.finalText(), `Marlow replied:\n\n> ${recipient.finalText()}`, "the sender's reply");
      await recordFamily(h, "messaging between bots", "#message", view, "sessions_send");
      // The recipient's run ends before the sender's tool result arrives.
      expect(
        recipient.events.find(isChat("final"))!.seq < view.tool("result", "sessions_send")[0]!.seq,
        "order of recipient end and tool result",
      );
    },
  },
  {
    name: "a bot outside the pair cannot message",
    covers: ["#message"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "message-outside"), "#message");
      const result = view.result("sessions_send");
      same([result.isError, result.details.status], [true, "forbidden"], "sessions_send result");
      h.observe(`a send from outside the pair: ${String(result.details.error)}`);
      same(
        view.finalText(),
        "The message to Marlow did not get through (forbidden).",
        "the sender's reply",
      );
    },
  },
  {
    name: "a message to a slow bot",
    covers: ["#message-slow"],
    run: async (h) => {
      const { key, view } = await messageCheck(h, "#message-slow");
      await h.wait(view, 30_000);
      const result = view.result("sessions_send");
      same(
        [result.isError, result.details.status, result.details.targetDisposition],
        [false, "accepted", "queued"],
        "sessions_send result",
      );
      same(rec(result.details.delivery).status, "pending", "delivery status");
      same(
        view.finalText(),
        "Marlow is still working on it. Their reply will arrive in this task.",
        "the sender's reply",
      );
      const recipient = new RunView(
        h.op("plain"),
        String(result.details.runId),
        RECIPIENT_SESSION,
        view.from,
      );
      expect(
        recipient.terminal.state === undefined,
        "the recipient was still running when the sender finished",
      );
      await h.wait(recipient, 60_000);
      same(recipient.terminal.state, "final", "the recipient's run");
      // The late reply starts a new run in the sender's task.
      const late = await h
        .op("plain")
        .waitFor(
          "the late reply's run in the sender's task",
          (e) =>
            isChat("final")(e) &&
            rec(e.payload).sessionKey === key &&
            rec(e.payload).runId !== view.runId,
          30_000,
          recipient.events.find(isChat("final"))!.seq,
        );
      const lateRun = new RunView(h.op("plain"), String(rec(late.payload).runId), key, view.from);
      same(
        lateRun.finalText(),
        "Marlow's reply arrived. It is shown above.",
        "the sender's answer to the late reply",
      );
      const history = await h
        .op("plain")
        .request<{ messages: JsonRecord[] }>("chat.history", { sessionKey: key });
      const forwarded = history.messages.find((m) => rec(m.provenance).kind === "inter_session");
      expect(forwarded, "the late reply is in the sender's history with inter-session provenance");
      h.observe(
        `late reply row: role ${String(forwarded.role)}, sourceTool ${String(rec(forwarded.provenance).sourceTool)}, sourceSessionKey ${String(rec(forwarded.provenance).sourceSessionKey)}`,
      );
    },
  },
  {
    name: "a message to a bot whose run fails",
    covers: ["#message-fail"],
    run: async (h) => {
      const { view } = await messageCheck(h, "#message-fail");
      await h.wait(view, 60_000);
      const result = view.result("sessions_send");
      same(
        [result.isError, result.details.status, result.details.sentBeforeError],
        [true, "error", true],
        "sessions_send result",
      );
      const recipient = new RunView(
        h.op("plain"),
        String(result.details.runId),
        RECIPIENT_SESSION,
        view.from,
      );
      same(recipient.terminal.state, "error", "the recipient's run");
      same(view.finalText(), "Marlow got the message, but their run failed.", "the sender's reply");
    },
  },
  {
    name: "a message to a bot that asks its own user",
    covers: ["#message-ask"],
    run: async (h) => {
      const { key, view } = await messageCheck(h, "#message-ask");
      const asked = await question(h, RECIPIENT_SESSION);
      same(asked.agentId, RECIPIENT, "the question's agent");
      // The sender's call returns while the question is pending.
      await h.wait(view, 30_000);
      const result = view.result("sessions_send");
      same(result.details.status, "accepted", "sessions_send status while the recipient asks");
      same(asked.runId, result.details.runId, "the question belongs to the recipient's run");
      await answer(h, asked, { route: ["Town walk"] });
      const recipient = new RunView(
        h.op("plain"),
        String(result.details.runId),
        RECIPIENT_SESSION,
        view.from,
      );
      await h.wait(recipient, 30_000);
      same(
        recipient.finalText(),
        "Thanks. You answered:\n\n- route: Town walk",
        "the recipient's reply",
      );
      await h
        .op("plain")
        .waitFor(
          "the late reply's run in the sender's task",
          (e) =>
            isChat("final")(e) &&
            rec(e.payload).sessionKey === key &&
            rec(e.payload).runId !== view.runId,
          30_000,
          recipient.events.find(isChat("final"))!.seq,
        );
    },
  },
  {
    name: "an MCP call to the coding agent, with a link",
    covers: ["#mcp"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "mcp"), "#mcp");
      const name = `${CODING_AGENT_SERVER}__send_message`;
      const result = view.result(name);
      same(
        [result.isError, result.details.mcpServer, result.details.mcpTool],
        [false, CODING_AGENT_SERVER, "send_message"],
        "MCP result",
      );
      const structured = rec(result.details.structuredContent);
      expect(
        String(structured.url).startsWith(THREAD_URL_BASE),
        "the result carries the thread link",
      );
      same(
        view.finalText(),
        `The coding agent picked it up: ${String(structured.url)}`,
        "the reply",
      );
      await recordFamily(h, "tool servers (MCP)", "#mcp", view, name);
    },
  },
  {
    name: "a slow MCP call",
    covers: ["#mcp-slow"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "mcp-slow"), "#mcp-slow 3");
      const name = `${CODING_AGENT_SERVER}__send_message`;
      const start = view.tool("start", name)[0]!;
      const end = view.tool("result", name)[0]!;
      expect(end.at - start.at >= 2_500, "the call took its delay");
      // No progress is forwarded between the start and the result.
      same(view.tool("update", name).length, 0, "tool update events");
      same(view.result(name).isError, false, "MCP isError");
    },
  },
  {
    name: "an MCP call that returns an error",
    covers: ["#mcp-error"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "mcp-error"), "#mcp-error");
      const result = view.result(`${CODING_AGENT_SERVER}__run_checks`);
      same([result.isError, result.details.status], [true, "error"], "MCP error result");
      same(view.terminal.state, "final", "the run's end");
    },
  },
  {
    name: "an MCP call stopped mid-call",
    covers: ["#mcp-stop"],
    run: async (h) => {
      const key = await h.session("main", "mcp-stop");
      const view = await h.start("plain", key, "#mcp-stop");
      const name = `${CODING_AGENT_SERVER}__slow_task`;
      await h
        .op("plain")
        .waitFor(
          "the long call",
          (e) => isTool("start", name)(e) && rec(e.payload).runId === view.runId,
        );
      await sleep(500);
      same(
        await h.op("plain").request("chat.abort", { sessionKey: key }),
        { ok: true, aborted: true, runIds: [view.runId] },
        "chat.abort",
      );
      await h.wait(view, 10_000);
      same([view.terminal.state, view.terminal.stopReason], ["aborted", "rpc"], "the run's end");
      // Observed: the call's result arrives after the run's terminal events.
      const result = await h
        .op("plain")
        .waitFor(
          "the stopped call's result",
          (e) => isTool("result", name)(e) && rec(e.payload).runId === view.runId,
          10_000,
        );
      same(
        [rec(rec(result.payload).data).isError, view.result(name).text],
        [true, "Aborted"],
        "the stopped call's result",
      );
      expect(
        result.seq > view.events.find(isChat("aborted"))!.seq,
        "order of the aborted event and the tool result",
      );
    },
  },
  {
    name: "a run that ends in a model error",
    covers: ["#model-error"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "model-error"), "#model-error");
      same(view.terminal.state, "error", "the run's end");
      expect(
        String(view.terminal.errorMessage).includes("The scripted model was asked to fail"),
        "errorMessage",
      );
      same(rec(view.terminal.errorDetail).failoverReason, "format", "errorDetail.failoverReason");
      expect(view.lifecycle("error").length === 1, "lifecycle error");
      same(view.agent("assistant").length, 0, "assistant events");
    },
  },
  {
    name: "one file read",
    covers: ["#read"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "read"), "#read");
      same(view.result("read").isError, false, "read isError");
      await recordFamily(h, "files: read", "#read", view, "read");
    },
  },
  {
    name: "six file reads in a row",
    covers: ["#read-six"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "read-six"), "#read-six");
      const starts = view.agent("tool").filter((e) => view.data(e).phase === "start");
      same(
        starts.map((e) => view.data(e).name),
        Array(6).fill("read"),
        "the tool calls",
      );
      const first = starts[0]!.seq;
      const last = view.tool("result", "read").at(-1)!.seq;
      same(
        view.agent("assistant").filter((e) => e.seq > first && e.seq < last).length,
        0,
        "text between the reads",
      );
      same(
        view.tool("result", "read").map((e) => view.data(e).isError),
        Array(6).fill(false),
        "the reads' isError",
      );
      same(view.finalText(), "I read six files in my workspace.", "the reply");
    },
  },
  {
    name: "a folder listing",
    covers: ["#list"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "list"), "#list");
      expect(view.result("ls").text.includes("AGENTS.md"), "the listing names AGENTS.md");
      await recordFamily(h, "files: list", "#list", view, "ls");
    },
  },
  {
    name: "a file write",
    covers: ["#write"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "write"), "#write");
      const result = view.result("write");
      same([result.isError, result.details.created], [false, true], "write result");
      await recordFamily(h, "files: write", "#write", view, "write");
    },
  },
  {
    name: "a file edit",
    covers: ["#edit"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "edit"), "#edit");
      const result = view.result("edit");
      same(
        [result.isError, result.details.diff],
        [false, "-1 Leave at 9:00.\n+1 Leave at 8:30."],
        "edit result",
      );
      await recordFamily(h, "files: edit", "#edit", view, "edit");
    },
  },
  {
    name: "a note saved to memory",
    covers: ["#remember"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "remember"), "#remember");
      same(view.result("write").isError, false, "write isError");
      same(
        view.data(view.tool("start", "write")[0]!).args,
        { path: "memory/2026-11-17.md", content: "- Prefers the lake loop on relaxed weekends.\n" },
        "the memory write",
      );
      await recordFamily(h, "memory", "#remember", view, "write");
    },
  },
  {
    name: "a web search answered on loopback",
    covers: ["#search"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "search"), "#search");
      const result = view.result("web_search");
      same(result.isError, false, "web_search isError");
      const parsed = rec(JSON.parse(result.text) as unknown);
      same([parsed.provider, parsed.count], ["ollama", 3], "the search provider and count");
      const urls = (parsed.results as JsonRecord[]).map((r) => String(r.url));
      same(
        urls,
        [1, 2, 3].map((n) => `https://search.example/results/${n}`),
        "results come from the scripted server",
      );
      await recordFamily(h, "web search", "#search", view, "web_search");
    },
  },
  {
    name: "a look at the bot's sessions",
    covers: ["#sessions"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "sessions"), "#sessions");
      same(view.result("sessions_list").isError, false, "sessions_list isError");
      await recordFamily(h, "sessions", "#sessions", view, "sessions_list");
    },
  },
  {
    name: "a routine created and removed by the owner",
    covers: ["#schedule"],
    run: async (h) => {
      const key = `agent:main:check-schedule-${Date.now().toString(36)}`;
      const view = await h.ownerRun("main", key, "#schedule");
      // The run was started by the CLI: this client gets its items, not its tool events.
      same(
        view.tool("start", "automations").length,
        0,
        "tool events from a run another client started",
      );
      const ends = view
        .agent("item")
        .filter((e) => view.data(e).phase === "end" && view.data(e).name === "automations");
      same(
        ends.map((e) => view.data(e).status),
        ["completed", "completed"],
        "the two automations items",
      );
      same(view.finalText(), "I created the routine and removed it again.", "the reply");
      await recordFamily(h, "scheduling", "#schedule", view, "automations");
      // The same message from a paired client: the gateway does not offer the tool.
      const asUser = await h.run("plain", await h.session("main", "schedule-user"), "#schedule");
      const calls = asUser.tool("result", "automations");
      expect(
        calls.length > 0 && calls.every((e) => asUser.data(e).isError === true),
        "automations ran for a non-owner",
      );
      h.observe(
        `automations from a paired client: ${asUser.result("automations").text.slice(0, 160)}`,
      );
    },
  },
  {
    name: "a tool with no kind of its own",
    covers: ["#plan"],
    run: async (h) => {
      const view = await h.run("plain", await h.session("main", "plan"), "#plan");
      same(view.result("progress_card").isError, false, "progress_card isError");
      same(view.finalText(), "The plan is on the card above.", "the reply");
      await recordFamily(h, "other (progress card)", "#plan", view, "progress_card");
    },
  },
  {
    name: "network, browser and device tools are not offered",
    covers: [],
    run: async (h) => {
      const effective = await h
        .op("plain")
        .request<{ toolAccess?: { tools?: JsonRecord[] } }>("tools.effective", {
          sessionKey: RECIPIENT_SESSION,
        });
      const tools = effective.toolAccess?.tools ?? [];
      const offered = tools.filter((t) => t.status === "available").map((t) => String(t.id));
      same(
        DENIED_TOOLS.filter((tool) => offered.includes(tool)),
        [],
        "denied tools offered to a bot",
      );
      h.observe(`tools offered to Marlow: ${offered.sort().join(", ")}`);
    },
  },
  {
    name: "a client that did not start the run gets items but no tool events",
    covers: ["#read"],
    run: async (h) => {
      const key = await h.session("main", "watcher");
      const view = await h.run("plain", key, "#read");
      const watched = new RunView(h.op("questions"), view.runId, key, 0);
      same(view.agent("tool").length, 2, "tool events for the client that sent the message");
      same(
        watched.agent("tool").length,
        0,
        "tool events for another subscribed client with tool-events",
      );
      same(watched.agent("item").length, view.agent("item").length, "item events reach both");
    },
  },
  {
    name: "directives compose",
    covers: ["#think", "#mcp", "#ask"],
    run: async (h) => {
      const key = await h.session("pip", "compose");
      const view = await h.start("questions", key, "#think #mcp #ask");
      const asked = await question(h, key);
      await answer(h, asked, { route: ["Lake loop"] });
      await h.wait(view);
      // Observed: text in the same model message as a tool call is not on the
      // assistant stream; it arrives as an item of kind "preamble".
      const preamble = (e: GatewayEvent) =>
        isAgent("item", "end")(e) && rec(rec(e.payload).data).kind === "preamble";
      view.inOrder([
        ["thinking", isAgent("thinking")],
        ["preamble item", preamble],
        ["MCP call", isTool("result", `${CODING_AGENT_SERVER}__send_message`)],
        ["ask_user", isTool("result", "ask_user")],
        ["chat final", isChat("final")],
      ]);
      const first = view.agent("item").find(preamble)!;
      same(
        view.data(first).progressText,
        "I thought it over first. This is the answer that follows the reasoning.",
        "preamble text",
      );
      const reasoning = view
        .agent("thinking")
        .filter((e) => view.events.indexOf(e) < view.events.indexOf(first))
        .at(-1)!;
      same(
        view.data(reasoning).text,
        "The user wants to see reasoning first. I will reason briefly, then answer.\nThis is a coding change. I will hand it to the coding agent.",
        "two reasoning steps in one message join with a newline",
      );
      same(view.finalText(), "Thanks. You answered:\n\n- route: Lake loop", "the reply");
    },
  },
];

/** Run the checks on open clients. Returns one line per check, and whether all passed. */
export async function runScenarioChecks(
  clients: Record<ClientName, OperatorSession>,
  options: {
    log?: (line: string) => void;
    only?: (check: ScenarioCheck) => boolean;
    ownerAgent?: (botId: string, key: string, message: string) => Promise<void>;
  } = {},
): Promise<{ passed: number; failed: number; notes: string[] }> {
  const log = options.log ?? console.log;
  const harness = createHarness(clients, options.ownerAgent);
  await prepareRecipient(harness);
  let passed = 0;
  let failed = 0;
  for (const check of SCENARIO_CHECKS.filter(options.only ?? (() => true))) {
    try {
      await check.run(harness);
      passed += 1;
      log(`ok    ${check.name}`);
    } catch (error) {
      failed += 1;
      log(`FAIL  ${check.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { passed, failed, notes: harness.notes };
}

/**
 * A bot may ask a question only in a session a person owns, so the
 * recipient's main session is opened with a message from a person first.
 */
export async function prepareRecipient(h: Harness): Promise<void> {
  await h.run("plain", RECIPIENT_SESSION, "#reply");
}

export function createHarness(
  clients: Record<ClientName, OperatorSession>,
  ownerAgent?: (botId: string, key: string, message: string) => Promise<void>,
): Harness & { notes: string[] } {
  let counter = 0;
  const notes: string[] = [];
  const stamp = Date.now().toString(36);
  const harness = {
    notes,
    op: (client: ClientName) => clients[client],
    async session(botId: string, tag: string) {
      counter += 1;
      const key = `agent:${botId}:check-${tag}-${stamp}-${counter}`;
      for (const [name, op] of Object.entries(clients)) {
        // Approval rows in the subscription need operator.approvals.
        await op.request("sessions.messages.subscribe", {
          key,
          ...(name === "approvals" ? { includeApprovals: true } : {}),
        });
      }
      return key;
    },
    async start(client: ClientName, key: string, message: string, extra: JsonRecord = {}) {
      const op = clients[client];
      const from = op.lastSeq;
      const sent = await op.send(key, message, extra);
      expect(
        typeof sent.runId === "string" && sent.runId,
        `chat.send returned no run id: ${JSON.stringify(sent)}`,
      );
      return new RunView(op, sent.runId, key, from);
    },
    async wait(view: RunView, timeoutMs = 60_000) {
      await view.op.terminal(view.runId, timeoutMs);
      // Late events of the same run (a stopped tool's result) arrive just after.
      await sleep(300);
      view.validate();
      return view;
    },
    async run(client: ClientName, key: string, message: string, extra: JsonRecord = {}) {
      return harness.wait(await harness.start(client, key, message, extra));
    },
    observe: (line: string) => notes.push(line),
    async ownerRun(botId: string, key: string, message: string) {
      expect(ownerAgent, "this harness cannot start a run as the owner");
      const op = clients.plain;
      const from = op.lastSeq;
      const done = ownerAgent(botId, key, message);
      const first = await op.waitFor(
        `the owner's run in ${key}`,
        (e) => e.event === "chat" && rec(e.payload).sessionKey === key,
        60_000,
        from,
      );
      await done;
      return harness.wait(new RunView(op, String(rec(first.payload).runId), key, from));
    },
  };
  return harness;
}

/** Open the three clients of the check on an instance, each paired with its own device. */
export async function openCheckClients(
  open: (name: string, scopes: string[], caps: string[]) => Promise<OperatorSession>,
): Promise<Record<ClientName, OperatorSession>> {
  const clients: Partial<Record<ClientName, OperatorSession>> = {};
  for (const name of Object.keys(CLIENTS) as ClientName[]) {
    clients[name] = await open(
      `Clawtrate scenario check (${name})`,
      CLIENTS[name].scopes,
      CLIENTS[name].caps,
    );
  }
  return clients as Record<ClientName, OperatorSession>;
}

/** Run one message as the gateway's owner, with `openclaw agent` through the guarded runner. */
export async function ownerAgent(
  inst: { runner: { run(args: string[]): Promise<{ status: number | null; stderr: string }> } },
  botId: string,
  key: string,
  message: string,
): Promise<void> {
  const out = await inst.runner.run([
    "agent",
    "--agent",
    botId,
    "--session-key",
    key,
    "--message",
    message,
    "--thinking",
    "low",
    "--json",
  ]);
  expect(out.status === 0, `openclaw agent failed: ${out.stderr.slice(0, 300)}`);
}
