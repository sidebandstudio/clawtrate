// Deterministic reply plans for the scripted model.

import { SEED_BOTS, type Round } from "./seed-data.ts";

export type ChatContentPart = { type?: string; text?: string };

export type ChatMessage = {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | ChatContentPart[] | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
};

export type ReplyStep =
  | { kind: "reasoning"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; arguments: Record<string, unknown> };

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
  return text
    .replace(/^\s*\[[^\]]*\]\s*/, "")
    .split(/\n\s*\nRuntime:/)[0]!
    .trim();
}

const scriptedTurns = new Map<string, Round[]>();
for (const bot of SEED_BOTS) {
  for (const task of bot.tasks) {
    for (const turn of task.turns) scriptedTurns.set(normalizePrompt(turn.prompt), turn.rounds);
  }
}

/** Drop rounds whose tool the gateway did not offer, so replies stay valid. */
function usableRounds(rounds: Round[], tools: Set<string>): Round[] {
  return rounds.filter((round) =>
    round.every((step) => step.kind !== "tool" || tools.has(step.name)),
  );
}

export function planReply(messages: ChatMessage[], tools: Set<string>): ReplyStep[] {
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]!.role === "user") {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex < 0) return [{ kind: "text", text: "Ready when you are." }];

  const prompt = normalizePrompt(messageText(messages[lastUserIndex]!));
  // Each assistant message after the user's turn is one completed round.
  const roundIndex = messages.slice(lastUserIndex + 1).filter((m) => m.role === "assistant").length;

  const scripted = scriptedTurns.get(prompt);
  if (scripted) {
    const rounds = usableRounds(scripted, tools);
    const round = rounds[roundIndex];
    if (round) return round;
    return [{ kind: "text", text: "That covers it." }];
  }

  // Unscripted prompts get a short, stable answer so manual testing still works.
  return [
    { kind: "reasoning", text: "This request is not in the script, so I will acknowledge it." },
    {
      kind: "text",
      text: `This is the scripted development model. It has no reply written for:\n\n> ${prompt.slice(0, 200)}`,
    },
  ];
}
