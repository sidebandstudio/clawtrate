// Deterministic reply plans for the scripted model.

import { resolveRound, scenarioRounds, selectScenarios, type PlanContext } from "./scenarios.ts";
import { SEED_BOTS, type Round } from "./seed-data.ts";

export type ChatContentPart = { type?: string; text?: string };

export type ChatMessage = {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | ChatContentPart[] | null;
  tool_calls?: { id?: string; function?: { name?: string } }[];
  tool_call_id?: string;
};

/** One streamed piece of a reply. `delayMs` slows the stream of that step. */
export type ReplyStep =
  | { kind: "reasoning"; text: string; delayMs?: number }
  | { kind: "text"; text: string; delayMs?: number }
  | { kind: "tool"; id: string; name: string; arguments: Record<string, unknown> }
  /** The request fails with this HTTP status instead of streaming a reply. */
  | { kind: "fail"; status: number; message: string };

export function messageText(message: ChatMessage): string {
  const { content } = message;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => part.text ?? "").join("");
  return "";
}

/**
 * The gateway decorates user text before it reaches the model: a leading
 * `[timestamp]` and, on some turns, a trailing runtime context block.
 * Strip both so scripted prompts match exactly.
 */
export function normalizePrompt(text: string): string {
  return (
    text
      .replace(/^\s*\[[^\]]*\]\s*/, "")
      // Messages sent from a client carry a "Conversation info" block with a JSON fence first.
      .replace(/^Conversation info:[^\n]*\n```json\n[\s\S]*?\n```\s*/, "")
      .split(/\n\s*\nRuntime:/)[0]!
      .trim()
  );
}

const scriptedTurns = new Map<string, Round[]>();
for (const bot of SEED_BOTS) {
  for (const task of bot.tasks) {
    for (const turn of task.turns) {
      // Turns without rounds are played by a scenario their prompt selects.
      if (turn.rounds.length > 0) scriptedTurns.set(normalizePrompt(turn.prompt), turn.rounds);
    }
  }
}

/** Drop rounds whose tool the gateway did not offer, so replies stay valid. */
function usableRounds(rounds: Round[], tools: Set<string>): Round[] {
  return rounds.filter((round) =>
    round.every((step) => step.kind !== "tool" || tools.has(step.name)),
  );
}

/**
 * The gateway's runtime line, in the system prompt or appended to the user's
 * message, names the agent and the session the request is for.
 */
export function runtimeFacts(messages: ChatMessage[]): {
  agentId: string | null;
  sessionKey: string | null;
} {
  let agentId: string | null = null;
  let sessionKey: string | null = null;
  for (const message of [...messages].reverse()) {
    if (message.role === "assistant" || message.role === "tool") continue;
    for (const line of messageText(message).match(/Runtime:[^\n]*/g) ?? []) {
      agentId ??= /\bagent=([A-Za-z0-9_-]+)/.exec(line)?.[1] ?? null;
      sessionKey ??= /\bsession=([^\s|]+)/.exec(line)?.[1] ?? null;
    }
  }
  return { agentId, sessionKey };
}

/** A context block the gateway appends as its own user message, not the user's words. */
const isRuntimeContext = (message: ChatMessage) =>
  message.role === "user" &&
  messageText(message).trimStart().startsWith("OpenClaw runtime context:");

/** The gateway's own follow-up after a reply that had reasoning but no visible text. */
export const VISIBLE_ANSWER_REPROMPT =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer";
const isReprompt = (message: ChatMessage) =>
  message.role === "user" &&
  normalizePrompt(messageText(message)).startsWith(VISIBLE_ANSWER_REPROMPT);

/** The reply the gateway treats as "nothing to say" (OpenClaw's SILENT_REPLY_TOKEN). */
export const SILENT_REPLY = "NO_REPLY";

/**
 * Prompts the gateway writes itself, not a person: the heartbeat prompt
 * (OpenClaw's HEARTBEAT_CONTEXT_PROMPT, which a wake also uses), the prompt
 * of a turn that is only runtime context (RUNTIME_EVENT_USER_PROMPT), and a
 * runtime context block that reaches the model as the prompt itself. A
 * person's text cannot start with the last: the gateway escapes that header
 * in user text.
 */
export const GATEWAY_TURN_PROMPTS = [
  "Follow the heartbeat monitor scratch context when provided.",
  "Continue the OpenClaw runtime event.",
  "OpenClaw runtime context:",
] as const;

export const isGatewayTurn = (prompt: string) =>
  GATEWAY_TURN_PROMPTS.some((start) => prompt.startsWith(start));

export function planReply(messages: ChatMessage[], tools: Set<string>): ReplyStep[] {
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]!.role === "user" && !isRuntimeContext(messages[i]!)) {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex < 0) return [{ kind: "text", text: "Ready when you are." }];
  if (isReprompt(messages[lastUserIndex]!)) {
    // Asked again for a visible answer: a reasoning-only scenario stays reasoning-only.
    const earlier = messages
      .slice(0, lastUserIndex)
      .findLast((m) => m.role === "user" && !isRuntimeContext(m) && !isReprompt(m));
    const selected = earlier ? selectScenarios(messageText(earlier)) : [];
    if (selected.at(-1)?.scenario.name === "think-only") {
      return [
        { kind: "reasoning", text: "Still only thinking; there is no visible answer to give." },
      ];
    }
  }

  const raw = messageText(messages[lastUserIndex]!);
  const prompt = normalizePrompt(raw);
  const after = messages.slice(lastUserIndex + 1);
  // Each assistant message after the user's turn is one completed round.
  const roundIndex = after.filter((m) => m.role === "assistant").length;

  const scripted = scriptedTurns.get(prompt);
  if (scripted) {
    const rounds = usableRounds(scripted, tools);
    const round = rounds[roundIndex];
    if (round) return round;
    return [{ kind: "text", text: "That covers it." }];
  }

  const selection = selectScenarios(raw);
  if (selection.length > 0) {
    const names = new Map<string, string>();
    for (const m of after) {
      for (const call of m.tool_calls ?? []) {
        if (call.id && call.function?.name) names.set(call.id, call.function.name);
      }
    }
    const facts = runtimeFacts(messages);
    const ctx: PlanContext = {
      ...facts,
      results: after
        .filter((m) => m.role === "tool")
        .map((m) => ({ name: names.get(m.tool_call_id ?? "") ?? "", text: messageText(m) })),
    };
    const round = scenarioRounds(selection)[roundIndex];
    if (!round) return [{ kind: "text", text: "That covers it." }];
    return resolveRound(round, ctx, `${facts.sessionKey ?? ""}:${lastUserIndex}:${roundIndex}`);
  }

  // A reply another bot sent later, through sessions_send, gets a short acknowledgement.
  const forwarded = after
    .concat(messages.slice(lastUserIndex))
    .map((m) => (isRuntimeContext(m) ? messageText(m) : ""))
    .find((text) => text.includes("[Inter-session message]") && text.includes("isUser=false"));
  if (forwarded) {
    const from = /sourceSession=agent:([A-Za-z0-9_-]+):/.exec(forwarded)?.[1] ?? "another bot";
    const name = SEED_BOTS.find((bot) => bot.id === from)?.name ?? from;
    return [{ kind: "text", text: `${name}'s reply arrived. It is shown above.` }];
  }

  // A turn the gateway started itself (a heartbeat, a wake, a queued system
  // event) gets the gateway's own "nothing to say" answer, never the fallback.
  if (isGatewayTurn(prompt)) return [{ kind: "text", text: SILENT_REPLY }];

  // Unscripted prompts get a short, stable answer so manual testing still works.
  return [
    { kind: "reasoning", text: "This request is not in the script, so I will acknowledge it." },
    {
      kind: "text",
      text: `This is the scripted development model. It has no reply written for:\n\n> ${prompt.slice(0, 200)}\n\nSend \`#help\` for the scenarios it can play.`,
    },
  ];
}
