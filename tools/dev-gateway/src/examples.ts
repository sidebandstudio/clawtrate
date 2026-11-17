// Seeds the finished scenario examples (seed-data.ts) through a paired operator
// client, and verifies them. The client plays the user: it sends each prompt
// with `chat.send`, answers the question with `question.resolve` and resolves
// the approval with `exec.approval.resolve`, then checks the run's outcome and
// the session's durable history.

import { TERMINAL_CHAT_STATES, type OperatorSession } from "./operator.ts";
import { resolveRound, scenarioRounds, selectScenarios } from "./scenarios.ts";
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

/** A value as an example expects it: exactly, by a pattern, or "number" for any number. */
function matches(value: unknown, expected: unknown): boolean {
  if (expected instanceof RegExp) return typeof value === "string" && expected.test(value);
  if (expected === "number") return typeof value === "number";
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
    if (Boolean(row.isError) !== want.isError)
      problems.push(`${where} has isError ${String(row.isError)}`);
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

/** Play one example as the user and verify it. Throws with what went wrong. */
export async function seedExample(
  op: OperatorSession,
  example: ScenarioExample,
  log: (line: string) => void,
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

  if (example.interaction?.kind === "question") {
    const asked = await op.waitFor(
      `the question in ${key}`,
      (e) => e.event === "question.requested" && ofThisSession(e.payload),
      60_000,
      before,
    );
    const id = String(rec(asked.payload).id);
    await op.request("question.resolve", { id, answers: { answers: example.interaction.answers } });
    log(`    answered question ${id} with question.resolve`);
  }
  if (example.interaction?.kind === "approval") {
    const asked = await op.waitFor(
      `the approval in ${key}`,
      (e) => e.event === "exec.approval.requested" && ofThisSession(e.payload),
      60_000,
      before,
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

  const end = await op.terminal(runId, 120_000);
  if (end.state !== "final") {
    throw new Error(`${where}: run ended ${String(end.state)} (${String(end.errorMessage ?? "")})`);
  }
  if (example.recipientSession) {
    const result = op.events.find(
      (e) =>
        e.seq > before &&
        e.event === "agent" &&
        rec(e.payload).runId === runId &&
        rec(e.payload).stream === "tool" &&
        rec(rec(e.payload).data).phase === "result",
    );
    const details = rec(rec(rec(result?.payload).data).result).details;
    const recipientRun = String(rec(details).runId ?? "");
    if (rec(details).status !== "ok" || !recipientRun) {
      throw new Error(`${where}: the message was not answered in the same call`);
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
