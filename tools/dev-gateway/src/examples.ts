// Seeds the finished scenario examples (seed-data.ts) through a paired operator
// client, and verifies them. The client plays the user: it sends each prompt
// with `chat.send`, answers the question with `question.resolve` and resolves
// the approval with `exec.approval.resolve`, then checks the run's outcome and
// the session's durable history.

import { CODING_AGENT_SERVER, CODING_AGENT_START_MS } from "./coding-agent-mcp.ts";
import { TERMINAL_CHAT_STATES, type GatewayEvent, type OperatorSession } from "./operator.ts";
import {
  resolveRound,
  SAME_CALL_REPLY_SECONDS,
  SAME_CALL_RUN_MS,
  scenarioRounds,
  selectScenarios,
} from "./scenarios.ts";
import {
  SCENARIO_EXAMPLES,
  sessionKeyFor,
  type ExampleResult,
  type ScenarioExample,
} from "./seed-data.ts";

type JsonRecord = Record<string, unknown>;
const rec = (value: unknown): JsonRecord =>
  value !== null && typeof value === "object" ? (value as JsonRecord) : {};

/** The smallest scopes that let the seed send, answer and approve. */
export const SEED_SCOPES = [
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.questions",
];
/** Approval events reach only clients that say they can show approvals. */
export const SEED_CAPS = ["tool-events", "approvals", "exec-approvals"];

/**
 * Ceilings, not waits: each ends as soon as the gateway reports (#883). A question or an approval
 * comes after the run's preparation and first model call; on a loaded hosted runner one chat
 * send's preparation took 35 s, over half the 60 s this used to give. The bot-to-bot answer has
 * the same 180 s (`SAME_CALL_REPLY_SECONDS`), as do the seed's connect and each of its requests.
 */
export const SEED_ANSWER_MS = SAME_CALL_REPLY_SECONDS * 1000;
/** A whole example run: the answer it may wait on, and the run's own work around it. */
export const SEED_RUN_MS = SAME_CALL_RUN_MS;

const seconds = (ms: number) => Math.round(ms / 1000);

/** What the gateway last reported about a run after event `after`, and how long ago. */
export function lastReport(events: GatewayEvent[], runId: string, after: number): string {
  const last = events.findLast((e) => e.seq > after && rec(e.payload).runId === runId);
  if (!last) return `nothing about run ${runId}`;
  const payload = rec(last.payload);
  const data = rec(payload.data);
  const words = [last.event, payload.stream, data.phase ?? payload.state, data.name].filter(
    (word) => typeof word === "string" && word !== "",
  );
  return `${words.join(" ")}, ${seconds(Date.now() - last.at)} s before the seed stopped`;
}

export type HistoryRow = {
  details?: unknown;
  role?: string;
  provenance?: unknown;
  stopReason?: string;
  isError?: boolean;
  content?: unknown;
  toolName?: string;
};

const textOf = (row: HistoryRow): string =>
  Array.isArray(row.content)
    ? row.content
        .map((part) => (rec(part).type === "text" ? String(rec(part).text ?? "") : ""))
        .join("")
    : typeof row.content === "string"
      ? row.content
      : "";

/** The reasoning and tool calls an example's prompt scripts, from its scenario. */
export function scriptedSteps(example: ScenarioExample) {
  const ctx = { agentId: example.botId, sessionKey: null, results: [] };
  const steps = scenarioRounds(selectScenarios(example.prompt)).flatMap((round) =>
    resolveRound(round, ctx, "seed"),
  );
  return {
    reasoning: steps.flatMap((step) => (step.kind === "reasoning" ? [step.text] : [])),
    calls: steps.flatMap((step) =>
      step.kind === "tool" ? [{ name: step.name, arguments: step.arguments }] : [],
    ),
  };
}

/** Thinking blocks and tool calls of a history's assistant rows, in order. */
function assistantBlocks(rows: HistoryRow[]) {
  const blocks = rows.flatMap((row) =>
    row.role === "assistant" && Array.isArray(row.content) ? (row.content as unknown[]) : [],
  );
  return {
    reasoning: blocks.flatMap((part) =>
      rec(part).type === "thinking" ? [String(rec(part).thinking ?? "")] : [],
    ),
    calls: blocks.flatMap((part) =>
      rec(part).type === "toolCall"
        ? [{ name: String(rec(part).name), arguments: rec(part).arguments }]
        : [],
    ),
  };
}

/** A value as an example expects it: exactly, by a pattern, or "count" for a whole number of at least 0. */
function matches(value: unknown, expected: unknown): boolean {
  if (expected instanceof RegExp) return typeof value === "string" && expected.test(value);
  if (expected === "count") return Number.isSafeInteger(value) && (value as number) >= 0;
  return JSON.stringify(value) === JSON.stringify(expected);
}

/** Each tool result row against its expectation: tool, error flag, every text block, details. */
export function resultProblems(rows: HistoryRow[], expected: ExampleResult[]): string[] {
  const problems: string[] = [];
  if (rows.length !== expected.length) {
    problems.push(`expected ${expected.length} tool results, found ${rows.length}`);
  }
  for (const [i, want] of expected.entries()) {
    const row = rows[i];
    const where = `result ${i + 1} (${want.toolName})`;
    if (!row) continue;
    if (row.toolName !== want.toolName) problems.push(`${where} is from ${String(row.toolName)}`);
    // A boolean, as the history's tool result schema requires: missing or any
    // other type is wrong, not read as false or true.
    if (row.isError !== want.isError)
      problems.push(
        `${where} has isError ${JSON.stringify(row.isError)}, expected ${want.isError}`,
      );
    const blocks = Array.isArray(row.content) ? (row.content as JsonRecord[]) : [];
    const texts = blocks.map((b) => (b.type === "text" ? String(b.text) : `<${String(b.type)}>`));
    if (
      texts.length !== want.content.length ||
      !want.content.every((c, k) => matches(texts[k], c))
    ) {
      problems.push(
        `${where} text differs from the script: ${JSON.stringify(texts).slice(0, 160)}`,
      );
    }
    const details = (row as { details?: unknown }).details;
    if (want.details === undefined) {
      if (details !== undefined) problems.push(`${where} has details, expected none`);
    } else {
      const got = rec(details);
      const keys = Object.keys(want.details).sort();
      if (JSON.stringify(Object.keys(got).sort()) !== JSON.stringify(keys)) {
        problems.push(
          `${where} details keys ${JSON.stringify(Object.keys(got))}, expected ${JSON.stringify(keys)}`,
        );
      }
      for (const key of keys) {
        if (!matches(got[key], want.details[key])) problems.push(`${where} details.${key} differs`);
      }
    }
  }
  return problems;
}

/** Check an example session's history against what it should hold. Returns what is wrong. */
export function checkExampleHistory(rows: HistoryRow[], example: ScenarioExample): string[] {
  const problems: string[] = [];
  const scripted = scriptedSteps(example);
  const found = assistantBlocks(rows);
  // Reasoning steps of one model call can arrive as one block, so compare the text in order.
  if (found.reasoning.join("\n") !== scripted.reasoning.join("\n")) {
    problems.push(
      `expected reasoning ${JSON.stringify(scripted.reasoning)}, found ${JSON.stringify(found.reasoning)}`,
    );
  }
  if (JSON.stringify(found.calls) !== JSON.stringify(scripted.calls)) {
    problems.push(
      `expected the scripted calls and arguments ${JSON.stringify(scripted.calls)}, found ${JSON.stringify(found.calls)}`,
    );
  }
  // The person's own turn; a message from another bot is not a user row in chat.history.
  const users = rows.filter((row) => row.role === "user").length;
  if (users !== 1) problems.push(`expected one user turn, found ${users}`);
  const calls = rows.flatMap((row) =>
    row.role === "assistant" && Array.isArray(row.content)
      ? row.content.flatMap((part) =>
          rec(part).type === "toolCall" ? [String(rec(part).name)] : [],
        )
      : [],
  );
  if (JSON.stringify(calls) !== JSON.stringify(example.toolCalls)) {
    problems.push(
      `expected tool calls ${JSON.stringify(example.toolCalls)}, found ${JSON.stringify(calls)}`,
    );
  }
  problems.push(
    ...resultProblems(
      rows.filter((row) => row.role === "toolResult"),
      example.results,
    ),
  );
  // Every completed reply of the bot's own (not a forwarded message) is the scripted one.
  const finals = rows.filter(
    (row) => row.role === "assistant" && row.stopReason === "stop" && !row.provenance,
  );
  if (finals.length === 0 || finals.some((row) => textOf(row).trim() !== example.finalText)) {
    problems.push("a completed reply differs from the scripted text");
  }
  return problems;
}

async function history(op: OperatorSession, sessionKey: string): Promise<HistoryRow[]> {
  const out = await op.request<{ messages?: HistoryRow[] }>("chat.history", {
    sessionKey,
    limit: 200,
  });
  return out.messages ?? [];
}

/** The tools the model's latest request in a task offered, as the scripted model saw them. */
export type OfferedTools = (sessionKey: string) => Promise<string[] | null>;

/**
 * The coding agent's tools an example calls that the model's latest request did not offer
 * (#1036): the gateway offers them only once the task's `coder` server has started. None when the
 * scripted model saw no request in the task.
 */
export function unofferedCoderTools(
  example: ScenarioExample,
  offered: readonly string[] | null,
): string[] {
  if (offered === null) return [];
  const coder = `${CODING_AGENT_SERVER}__`;
  return example.toolCalls.filter((name) => name.startsWith(coder) && !offered.includes(name));
}

/** Play one example as the user and verify it. Throws with what went wrong. */
export async function seedExample(
  op: OperatorSession,
  example: ScenarioExample,
  log: (line: string) => void,
  offeredTools?: OfferedTools,
): Promise<void> {
  const key = sessionKeyFor(example.botId, example.slug);
  const where = `${example.botId} / ${example.label}`;
  await op.request("sessions.messages.subscribe", { key, includeApprovals: true });
  const before = op.lastSeq;
  const sent = await op.send(key, example.prompt);
  const runId = String(sent.runId ?? "");
  if (!runId) throw new Error(`${where}: chat.send returned no run id`);
  const ofThisSession = (payload: unknown) => {
    const p = rec(payload);
    return p.sessionKey === key || rec(p.request).sessionKey === key;
  };
  /** A wait that stops the seed says how long it waited and what the gateway last reported. */
  const within = async <T>(what: string, wait: Promise<T>): Promise<T> => {
    const started = Date.now();
    try {
      return await wait;
    } catch (error) {
      throw new Error(
        `${where}: no ${what} after ${seconds(Date.now() - started)} s; the gateway last reported ${lastReport(op.events, runId, before)}`,
        { cause: error },
      );
    }
  };

  if (example.interaction?.kind === "question") {
    const asked = await within(
      "question",
      op.waitFor(
        `the question in ${key}`,
        (e) => e.event === "question.requested" && ofThisSession(e.payload),
        SEED_ANSWER_MS,
        before,
      ),
    );
    const id = String(rec(asked.payload).id);
    await op.request("question.resolve", { id, answers: { answers: example.interaction.answers } });
    log(`    answered question ${id} with question.resolve`);
  }
  if (example.interaction?.kind === "approval") {
    const asked = await within(
      "approval request",
      op.waitFor(
        `the approval in ${key}`,
        (e) => e.event === "exec.approval.requested" && ofThisSession(e.payload),
        SEED_ANSWER_MS,
        before,
      ),
    );
    const request = rec(rec(asked.payload).request);
    if (request.command !== example.interaction.command) {
      throw new Error(
        `${where}: approval asked for ${JSON.stringify(request.command)}, not the scripted command`,
      );
    }
    const id = String(rec(asked.payload).id);
    await op.request("exec.approval.resolve", { id, decision: example.interaction.decision });
    log(
      `    resolved approval ${id} for \`${example.interaction.command}\` with ${example.interaction.decision}`,
    );
  }

  const end = await within("end of the run", op.terminal(runId, SEED_RUN_MS));
  if (end.state !== "final") {
    throw new Error(`${where}: run ended ${String(end.state)} (${String(end.errorMessage ?? "")})`);
  }
  if (offeredTools) {
    // Named before the history is compared: without the tools, every scripted step differs.
    const missing = unofferedCoderTools(example, await offeredTools(key));
    if (missing.length > 0) {
      throw new Error(
        `${where}: the ${CODING_AGENT_SERVER} tools were not offered within ${seconds(CODING_AGENT_START_MS)} s: ` +
          `the model's request had no ${missing.join(", ")}, so the gateway's "${CODING_AGENT_SERVER}" server ` +
          `did not start in the time it is given (its [bundle-mcp] lines in the gateway's log say why)`,
      );
    }
  }
  if (example.recipientSession) {
    const toolEvent = (phase: string) =>
      op.events.find(
        (e) =>
          e.seq > before &&
          e.event === "agent" &&
          rec(e.payload).runId === runId &&
          rec(e.payload).stream === "tool" &&
          rec(rec(e.payload).data).phase === phase,
      );
    const result = toolEvent("result");
    const details = rec(rec(rec(result?.payload).data).result).details;
    const recipientRun = String(rec(details).runId ?? "");
    if (rec(details).status !== "ok" || !recipientRun) {
      // A later turn may still bring the answer, but the example is the answer within the call.
      const sent = toolEvent("start");
      const waited = result && sent ? `after ${seconds(result.at - sent.at)} s` : "";
      const disposition = rec(details).targetDisposition;
      throw new Error(
        [
          `${where}: the message was not answered within the call's ${SAME_CALL_REPLY_SECONDS} s:`,
          result
            ? `sessions_send reported ${JSON.stringify(rec(details).status ?? null)}`
            : "the gateway reported no sessions_send result",
          ...(typeof disposition === "string" ? [`(${disposition})`] : []),
          ...(waited ? [waited] : []),
        ].join(" "),
      );
    }
    const reply = op.events.find(
      (e) =>
        e.event === "chat" &&
        rec(e.payload).runId === recipientRun &&
        TERMINAL_CHAT_STATES.includes(String(rec(e.payload).state)),
    );
    if (
      rec(reply?.payload).state !== "final" ||
      rec(reply?.payload).sessionKey !== example.recipientSession
    ) {
      throw new Error(
        `${where}: the recipient's run did not finish in ${example.recipientSession}`,
      );
    }
  }
  await verifyExample(op, example);
  await op.request("sessions.patch", { key, label: example.label });
}

/**
 * The recipient's side of a bot-to-bot example: the sender's message, marked
 * as an inter-session message from the sender's task (the gateway records it
 * with role "assistant"), and the reply after it.
 */
export function checkRecipientExchange(
  rows: HistoryRow[],
  senderKey: string,
  message: string,
  reply: string,
): string[] {
  // `chat.history` is a display projection: it shows a message forwarded by
  // sessions_send as an assistant row with inter-session provenance, although
  // the gateway builds the stored input as a user message.
  const incoming = rows.filter((row) => rec(row.provenance).sourceSessionKey === senderKey);
  if (incoming.length !== 1) {
    return [
      `expected one message from ${senderKey} in the recipient's history, found ${incoming.length}`,
    ];
  }
  const row = incoming[0]!;
  const problems: string[] = [];
  const provenance = rec(row.provenance);
  if (row.role !== "assistant") problems.push(`the forwarded message has role ${String(row.role)}`);
  if (provenance.kind !== "inter_session" || provenance.sourceTool !== "sessions_send") {
    problems.push(`the forwarded message's provenance is ${JSON.stringify(provenance)}`);
  }
  if (row.content !== message)
    problems.push(`the forwarded message is ${JSON.stringify(row.content)}`);
  const answered = rows
    .slice(rows.indexOf(row) + 1)
    .some(
      (r) =>
        r.role === "assistant" &&
        r.stopReason === "stop" &&
        !r.provenance &&
        textOf(r).trim() === reply,
    );
  if (!answered) problems.push("the recipient's reply is not after the message");
  return problems;
}

/** Verify an example's session from its history alone; used again by `seed`. */
export async function verifyExample(op: OperatorSession, example: ScenarioExample): Promise<void> {
  const key = sessionKeyFor(example.botId, example.slug);
  const problems = checkExampleHistory(await history(op, key), example);
  if (example.recipientSession) {
    const call = scriptedSteps(example).calls.find((c) => c.name === "sessions_send");
    const message = String(rec(call?.arguments).message ?? "");
    // The recipient's reply is the note its own example scripts.
    const reply =
      SCENARIO_EXAMPLES.find((e) => sessionKeyFor(e.botId, e.slug) === example.recipientSession)
        ?.finalText ?? "";
    problems.push(
      ...checkRecipientExchange(await history(op, example.recipientSession), key, message, reply),
    );
  }
  if (problems.length > 0) {
    throw new Error(`${example.botId} / ${example.label}: ${problems.join("; ")}`);
  }
}
