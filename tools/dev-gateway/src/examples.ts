// Seeds the finished scenario examples (seed-data.ts) through a paired operator
// client, and verifies them. The client plays the user: it sends each prompt
// with `chat.send`, answers the question with `question.resolve` and resolves
// the approval with `exec.approval.resolve`, then checks the run's outcome and
// the session's durable history.

import { TERMINAL_CHAT_STATES, type OperatorSession } from "./operator.ts";
import { sessionKeyFor, type ScenarioExample } from "./seed-data.ts";

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
  role?: string;
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

/** Check an example session's history against what it should hold. Returns what is wrong. */
export function checkExampleHistory(rows: HistoryRow[], example: ScenarioExample): string[] {
  const problems: string[] = [];
  const users = rows.filter((row) => row.role === "user").length;
  // Messages from another bot also arrive as user rows; the person's own turn is the first.
  if (users < 1) problems.push("no user turn");
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
  const results = rows.filter((row) => row.role === "toolResult");
  if (results.length !== example.toolCalls.length) {
    problems.push(`expected ${example.toolCalls.length} tool results, found ${results.length}`);
  }
  const errors = results.filter((row) => row.isError).length;
  if (errors !== example.toolErrors) {
    problems.push(`expected ${example.toolErrors} failed tool results, found ${errors}`);
  }
  // History rows keep the result's text but not its `details`, so the text is checked.
  if (example.interaction?.kind === "question") {
    const answered = results.find((row) => row.toolName === "ask_user");
    if (!answered || answered.isError || !/"status": "answered"/.test(textOf(answered))) {
      problems.push("the question was not answered");
    }
  }
  if (example.interaction?.kind === "approval") {
    const ran = results.find((row) => row.toolName === "exec");
    if (!ran || ran.isError || /exec denied/i.test(textOf(ran))) {
      problems.push("the approved command did not run");
    }
  }
  const finals = rows.filter((row) => row.role === "assistant" && row.stopReason === "stop");
  if (!finals.some((row) => textOf(row).trim() === example.finalText)) {
    problems.push("no completed reply with the scripted text");
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

/** Verify an example's session from its history alone; used again by `seed`. */
export async function verifyExample(op: OperatorSession, example: ScenarioExample): Promise<void> {
  const key = sessionKeyFor(example.botId, example.slug);
  const problems = checkExampleHistory(await history(op, key), example);
  if (problems.length > 0) {
    throw new Error(`${example.botId} / ${example.label}: ${problems.join("; ")}`);
  }
}
