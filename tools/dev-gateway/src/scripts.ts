// Deterministic reply plans for the scripted model.

import {
  resolveRound,
  scenarioRounds,
  selectScenarios,
  SKILL_REVIEW_PROMPT,
  skillReviewReply,
  type PlanContext,
} from "./scenarios.ts";
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
  | {
      kind: "tool";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      /** Characters per streamed piece of the arguments: 32 unless a large call sets more. */
      argumentPiece?: number;
    }
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

/**
 * 2026.11.10's note of what changed in the system prompt since the last turn, which it sends as a
 * user message of its own after the prompt (SYSTEM_PROMPT_UPDATE_HEADER); not the user's words.
 */
const isPromptUpdate = (message: ChatMessage) =>
  message.role === "user" &&
  messageText(message)
    .trimStart()
    .startsWith("System prompt update. The sections below replace their earlier versions;");

const PROMPT_UPDATE_HEADER =
  "System prompt update. The sections below replace their earlier versions; everything else in the system prompt is unchanged.";

/** A workspace file's heading, as the gateway injects files: a path ending in `.md`. */
const FILE_HEADING = /^## [^\n]*\/[^\n]*\.md\s*$/;
/** The gateway's own marker around the parts of an attempt's prompt. */
const ATTEMPT_MARKER = /^<!-- \/?openclaw:attempt:[A-Z]+ -->\s*$/;

/**
 * Where the section whose heading line starts at `at` ends: at the gateway's attempt marker, or
 * at the next heading. A workspace file's section holds the file's own `##` headings, so it ends
 * only at the next file's heading, as the memory read below takes it.
 */
function sectionEnd(text: string, at: number): number {
  const headingEnd = text.indexOf("\n", at);
  if (headingEnd === -1) return text.length;
  const file = FILE_HEADING.test(text.slice(at, headingEnd));
  let offset = headingEnd + 1;
  for (const line of text.slice(headingEnd + 1).split("\n")) {
    if (ATTEMPT_MARKER.test(line) || (line.startsWith("## ") && (!file || FILE_HEADING.test(line))))
      return offset;
    offset += line.length + 1;
  }
  return text.length;
}

/** Where each section's heading starts in `text`: every heading but a workspace file's own. */
function sectionStarts(text: string): number[] {
  const starts: number[] = [];
  for (let at = text.search(/^## /m); at !== -1;) {
    starts.push(at);
    const end = sectionEnd(text, at);
    const next = text.slice(end).search(/^## /m);
    at = next === -1 ? -1 : end + next;
  }
  return starts;
}

/** The heading line that starts at `at`. */
const headingAt = (text: string, at: number) => {
  const newline = text.indexOf("\n", at);
  return text.slice(at, newline === -1 ? undefined : newline);
};

/** A part of a prompt: a section with its heading, or the text between and around sections. */
type PromptPart = { heading: string | null; text: string };

/** A prompt's parts, in order, whose texts join to the whole prompt. */
function promptParts(text: string): PromptPart[] {
  const parts: PromptPart[] = [];
  let from = 0;
  for (const at of sectionStarts(text)) {
    if (at > from) parts.push({ heading: null, text: text.slice(from, at) });
    from = sectionEnd(text, at);
    parts.push({ heading: headingAt(text, at).trimEnd(), text: text.slice(at, from) });
  }
  if (from < text.length) parts.push({ heading: null, text: text.slice(from) });
  return parts;
}

/**
 * The system prompt a request gives the model, with 2026.11.10's updates to it applied in order:
 * each section of an update replaces the section of that heading, is added when there is none,
 * and is taken out when its body is `(removed)`. With no update, the system prompt as sent.
 * The updates apply to the prompt's parts, so a section one update adds stays a section of its
 * own for the next, whatever follows it (#659).
 */
export function effectivePrompt(messages: ChatMessage[]): string {
  const parts = promptParts(
    messages
      .filter((m) => m.role === "system" || m.role === "developer")
      .map(messageText)
      .join("\n\n"),
  );
  for (const update of messages.filter(isPromptUpdate)) {
    const body = messageText(update).trimStart().slice(PROMPT_UPDATE_HEADER.length);
    for (const section of promptParts(body)) {
      if (section.heading === null) continue;
      const heading = headingAt(section.text, 0);
      // The body as sent, from the line after the heading.
      const content = section.text.slice(heading.length).trimEnd();
      const removed = content.trim() === "(removed)";
      const replacement = { heading: section.heading, text: `${heading}${content}\n\n` };
      // The gateway's own section of that heading, never one inside a workspace file.
      const found = parts.findIndex((part) => part.heading === section.heading);
      if (found !== -1 && removed) parts.splice(found, 1);
      else if (found !== -1) parts[found] = replacement;
      else if (!removed) parts.push({ heading: null, text: "\n\n" }, replacement);
    }
  }
  return parts.map((part) => part.text).join("");
}

/** A user message the gateway wrote itself beside the prompt. */
const isGatewayAside = (message: ChatMessage) =>
  isRuntimeContext(message) || isPromptUpdate(message);

/** The gateway's own follow-up after a reply that had reasoning but no visible text. */
export const VISIBLE_ANSWER_REPROMPTS = [
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer",
  // 2026.11.10's wording.
  "Your turn ended without a final reply. Continue from the current conversation and answer",
] as const;

const isReprompt = (message: ChatMessage) =>
  message.role === "user" &&
  VISIBLE_ANSWER_REPROMPTS.some((start) => normalizePrompt(messageText(message)).startsWith(start));

/** The reply the gateway treats as "nothing to say" (OpenClaw's SILENT_REPLY_TOKEN). */
export const SILENT_REPLY = "NO_REPLY";

/**
 * Prompts the gateway writes itself, not a person, for a turn it starts on
 * its own: the heartbeat prompt (HEARTBEAT_CONTEXT_PROMPT, which a wake also
 * uses), the prompt of a turn that is only runtime context
 * (RUNTIME_EVENT_USER_PROMPT), a runtime context block that reaches the model
 * as the prompt itself, the two prompts of a command that completed after its
 * turn ended (buildExecEventPrompt), and the prompt of a scheduled event with
 * no content (buildCronEventPrompt). Each says to reply NO_REPLY when there is
 * nothing to report. A person's text cannot start with the runtime context
 * header: the gateway escapes it in user text.
 */
export const GATEWAY_TURN_PROMPTS = [
  "Follow the heartbeat monitor scratch context when provided.",
  "Continue the OpenClaw runtime event.",
  "OpenClaw runtime context:",
  "An async command you ran earlier has completed.",
  "An async command completion event was triggered",
  "A scheduled cron event was triggered, but no event content was found.",
] as const;

/** buildCronEventPrompt's reminder, which the gateway asks the bot to relay. */
const REMINDER_PROMPT = "A scheduled reminder has been triggered. The reminder content is:\n\n";
const REMINDER_RELAY = "Please relay this reminder to the user in a helpful and friendly way.";

/**
 * How the gateway opens its report that a background image_generate task ended
 * (OpenClaw 2026.10.6, formatTaskCompletionEvent): as the prompt of a turn of
 * its own behind the header of an inter-session message from the tool, or as a
 * runtime context block, whose header the gateway escapes in a person's text.
 */
const IMAGE_COMPLETION =
  /^(?:\[Inter-session message\] sourceSession=image_generate:tool:\S+ sourceChannel=internal sourceTool=image_generate isUser=false\n|OpenClaw runtime context:\n)[\s\S]*?\nsource: image_generation\n/;

/**
 * The gateway's report that a background image_generate task ended: whether it
 * succeeded, and the `MEDIA:` lines of what it made. Null for any other text.
 */
export function imageCompletion(text: string): { ok: boolean; media: string[] } | null {
  if (!IMAGE_COMPLETION.test(text) || !text.includes("\ntype: image generation task\n"))
    return null;
  const lines = text.split("\n");
  const label = lines.lastIndexOf("Generated media:");
  const media = [];
  for (const line of label < 0 ? [] : lines.slice(label + 1)) {
    if (!/^MEDIA:\S/.test(line)) break;
    media.push(line);
  }
  return { ok: text.includes("\nstatus: completed successfully\n"), media };
}

/**
 * The gateway's report that a task the bot started with sessions_spawn ended, or answered a
 * follow-up (OpenClaw 2026.10.6, formatTaskCompletionEvent, in a runtime context block as data):
 * the task's label as the bot wrote it, and whether the person can open it (a hidden helper's
 * key is `agent:<bot>:subagent:<id>`). Null for any other text.
 */
export function startedTaskCompletion(
  text: string,
): { key: string; label: string; visible: boolean } | null {
  if (!text.trimStart().startsWith("OpenClaw runtime context:")) return null;
  const at = text.indexOf("[Internal task completion event]");
  if (at < 0) return null;
  const event = text.slice(at);
  const field = (name: string) =>
    new RegExp(`(?:\\\\n|\\n)${name}: (.*?)(?:\\\\n|\\n)`).exec(event)?.[1]?.trim() ?? "";
  if (field("source") === "image_generation") return null;
  const key = field("session_key");
  return {
    key,
    label: field("task") || "The task",
    visible: !/^agent:[^:]+:subagent:/.test(key),
  };
}

/**
 * The label a sessions_spawn call of this conversation gave the task with this key. A follow-up's
 * report names the follow-up's text as its task instead, so the label is taken from the start.
 */
function spawnedLabel(messages: ChatMessage[], key: string): string | null {
  for (const result of toolResults(messages)) {
    if (result.name !== "sessions_spawn") continue;
    try {
      const details = JSON.parse(result.text) as { childSessionKey?: unknown; label?: unknown };
      if (details.childSessionKey === key && typeof details.label === "string")
        return details.label;
    } catch {
      // not the gateway's JSON result
    }
  }
  return null;
}

/** What the bot says when a task it started reports back. */
export const startedTaskReply = ({ label, visible }: { label: string; visible: boolean }) =>
  visible ? `${label} finished. Its answer is in that task.` : `${label} finished.`;

/** The reply to a finished image task: a caption and its pictures, as the gateway asks. */
export const IMAGE_READY_REPLY = "Here is the picture you asked for.";
export const IMAGE_FAILED_REPLY = "The picture could not be made.";

export const isGatewayTurn = (prompt: string) =>
  GATEWAY_TURN_PROMPTS.some((start) => prompt.startsWith(start));

/** Which of GATEWAY_TURN_PROMPTS a request's prompt is, or null for any other prompt. */
export function gatewayTurnPrompt(messages: ChatMessage[]): string | null {
  const last = messages.findLast((m) => m.role === "user" && !isGatewayAside(m));
  const prompt = last ? normalizePrompt(messageText(last)) : "";
  return GATEWAY_TURN_PROMPTS.find((start) => prompt.startsWith(start)) ?? null;
}

/** The tool results among these messages, each named by the call it answers. */
function toolResults(messages: ChatMessage[]): { name: string; text: string }[] {
  const names = new Map<string, string>();
  for (const m of messages) {
    for (const call of m.tool_calls ?? []) {
      if (call.id && call.function?.name) names.set(call.id, call.function.name);
    }
  }
  return messages
    .filter((m) => m.role === "tool")
    .map((m) => ({ name: names.get(m.tool_call_id ?? "") ?? "", text: messageText(m) }));
}

export function planReply(
  messages: ChatMessage[],
  tools: Set<string>,
  options: {
    pagesOrigin?: string | null;
    /** Answer the gateway's background skill review (`--with-skill-review`). */
    skillReview?: boolean;
  } = {},
): ReplyStep[] {
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]!.role === "user" && !isGatewayAside(messages[i]!)) {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex < 0) return [{ kind: "text", text: "Ready when you are." }];
  if (isReprompt(messages[lastUserIndex]!)) {
    // Asked again for a visible answer: a reasoning-only scenario stays reasoning-only.
    const earlier = messages
      .slice(0, lastUserIndex)
      .findLast((m) => m.role === "user" && !isGatewayAside(m) && !isReprompt(m));
    const selected = earlier ? selectScenarios(messageText(earlier)) : [];
    if (selected.at(-1)?.scenario.name === "think-only") {
      return [
        { kind: "reasoning", text: "Still only thinking; there is no visible answer to give." },
      ];
    }
  }

  const raw = messageText(messages[lastUserIndex]!);
  const prompt = normalizePrompt(raw);
  if (prompt === "What do you remember about me?") {
    // The system prompt, then each of 2026.11.10's updates to it in order: the last one that
    // has the memory section is the memory the bot has now.
    const memory = messages
      .filter((message) => message.role === "system" || isPromptUpdate(message))
      .map(messageText)
      .map((prompt) => prompt.split("\n<!-- /openclaw:attempt:STABLE -->", 1)[0]!)
      .findLast((prompt) => /^## .*\/MEMORY\.md\s*$/m.test(prompt))
      // A heading stops the extract only when it names another workspace file, as the
      // gateway's injected-file headings do; a `##` inside the memory itself does not. The
      // gateway's attempt marker stops it too.
      ?.match(
        /^## .*\/MEMORY\.md\s*\n([\s\S]*?)(?=^## [^\n]*\/[^\n]*\.md\s*$|^<!-- \/?openclaw:attempt:[A-Z]+ -->|(?![\s\S]))/m,
      )?.[1]
      ?.trim();
    // An update that takes the section out leaves the bot no memory.
    const kept = memory === "(removed)" ? "" : memory;
    return [{ kind: "text", text: kept || "I have no root memory for this task." }];
  }
  const after = messages.slice(lastUserIndex + 1);
  // Each assistant message after the user's turn is one completed round.
  const roundIndex = after.filter((m) => m.role === "assistant").length;
  // A reply another bot sent later, through sessions_send, in a runtime
  // context block or as the prompt itself.
  const forwarded = [
    prompt,
    ...messages.slice(lastUserIndex).filter(isRuntimeContext).map(messageText),
  ]
    .filter((text) => text.trimStart().startsWith("OpenClaw runtime context:"))
    .find((text) => text.includes("[Inter-session message]") && text.includes("isUser=false"));

  // A turn the gateway started itself (a heartbeat, a wake, a queued system
  // event, a command that completed later) gets the gateway's own "nothing to
  // say", whatever its event text holds, and never plays a scenario. Two
  // continuations are meant to be seen and are answered: a reminder the
  // gateway asks to relay, and another bot's reply arriving in the task.
  if (prompt.startsWith(REMINDER_PROMPT)) {
    const [content, instruction] = prompt.slice(REMINDER_PROMPT.length).split(/\n\n(?=[^\n]*$)/);
    if (instruction === REMINDER_RELAY) return [{ kind: "text", text: `Reminder: ${content}` }];
    return [{ kind: "text", text: SILENT_REPLY }];
  }
  // A finished image task, reported in the prompt or a runtime context block of this turn.
  const completion = [
    raw,
    ...messages
      .slice(lastUserIndex + 1)
      .filter(isRuntimeContext)
      .map(messageText),
  ]
    .map(imageCompletion)
    .find((found) => found !== null);
  if (completion) {
    if (!completion.ok) return [{ kind: "text", text: IMAGE_FAILED_REPLY }];
    return [{ kind: "text", text: [IMAGE_READY_REPLY, "", ...completion.media].join("\n") }];
  }
  // A task the bot started ended, or answered a follow-up: a short report, in this turn's
  // prompt or a runtime context block after it.
  const finished = [
    prompt,
    ...messages
      .slice(lastUserIndex + 1)
      .filter(isRuntimeContext)
      .map(messageText),
  ]
    .map(startedTaskCompletion)
    .find((found) => found !== null);
  if (finished) {
    const label = spawnedLabel(messages, finished.key) ?? finished.label;
    return [{ kind: "text", text: startedTaskReply({ ...finished, label }) }];
  }
  if (isGatewayTurn(prompt) && !forwarded) return [{ kind: "text", text: SILENT_REPLY }];

  // The gateway's background skill review, after the conversation it reviews, on an instance
  // that reviews; elsewhere the prompt is like any other.
  if (options.skillReview && prompt.startsWith(SKILL_REVIEW_PROMPT)) {
    const facts = runtimeFacts(messages);
    const reply = skillReviewReply(
      messages
        .slice(0, lastUserIndex)
        .filter((m) => m.role === "user" && !isGatewayAside(m))
        .map((m) => ({ role: m.role, text: normalizePrompt(messageText(m)) })),
      toolResults(after),
      tools,
    );
    return resolveRound(
      reply,
      { ...facts, results: [] },
      `${facts.sessionKey ?? ""}:review:${roundIndex}`,
    );
  }

  const scripted = scriptedTurns.get(prompt);
  if (scripted) {
    const rounds = usableRounds(scripted, tools);
    const round = rounds[roundIndex];
    if (round) return round;
    return [{ kind: "text", text: "That covers it." }];
  }

  const selection = selectScenarios(raw);
  if (selection.length > 0) {
    const facts = runtimeFacts(messages);
    const ctx: PlanContext = {
      ...facts,
      pagesOrigin: options.pagesOrigin ?? null,
      prompt,
      results: toolResults(after),
      history: toolResults(messages),
    };
    const round = scenarioRounds(selection)[roundIndex];
    if (!round) return [{ kind: "text", text: "That covers it." }];
    return resolveRound(round, ctx, `${facts.sessionKey ?? ""}:${lastUserIndex}:${roundIndex}`);
  }

  // A reply another bot sent later gets a short acknowledgement.
  if (forwarded) {
    const from = /sourceSession=agent:([A-Za-z0-9_-]+):/.exec(forwarded)?.[1] ?? "another bot";
    const name = SEED_BOTS.find((bot) => bot.id === from)?.name ?? from;
    return [{ kind: "text", text: `${name}'s reply arrived. It is shown above.` }];
  }

  // Unscripted prompts get a short, stable answer so manual testing still works.
  return [
    { kind: "reasoning", text: "This request is not in the script, so I will acknowledge it." },
    {
      kind: "text",
      text: `This is the scripted development model. It has no reply written for:\n\n> ${prompt.slice(0, 200)}\n\nSend \`#help\` for the scenarios it can play.`,
    },
  ];
}
