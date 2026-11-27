// Scenarios for the scripted model: deterministic replies that put a run into
// each situation the live conversation view must show. A user message selects
// one by directive (`#steps`) or by a plain-language phrase ("show your work").
// Several directives in one message run one after the other, so
// `#think #mcp #ask` reasons, calls the coding agent, then asks a question.
// The README lists them all; `SCENARIOS` is the single source.
//
// Shell commands appear only in the shell-bot scenarios, and only from the
// fixed list in `SHELL_COMMANDS`. They run only for that bot, and only once a
// person approves each one; every other bot's exec is denied by the gateway.

import { createHash } from "node:crypto";
import type { ReplyStep } from "./scripts.ts";
import { MESSAGING_PAIR, messagingPartner, SEED_BOTS } from "./seed-data.ts";
import { CODING_AGENT_SERVER } from "./coding-agent-mcp.ts";
import { PICTURE_PATH } from "./seed-files.ts";
import {
  ATTACH_NOTE,
  ATTACH_PDF_PATH,
  ATTACH_TEXT,
  ATTACH_TEXT_PATH,
  reviewsDraftPdf,
} from "./scripted-files.ts";

/** What a scenario may look at: who is answering, and what its tools returned so far. */
export type PlanContext = {
  agentId: string | null;
  sessionKey: string | null;
  /** Tool results since the user's message, in order. */
  results: { name: string; text: string }[];
  /** Tool results of the whole conversation the model was sent, this turn's included, in order. */
  history?: { name: string; text: string }[];
  /** The user's message, as the scripted model matched it. */
  prompt?: string;
  /**
   * The origin of the instance's scripted pages, when its bots have browsers
   * of their own (scripted-pages.ts); null otherwise.
   */
  pagesOrigin?: string | null;
};

/**
 * A step; text built from the context once the tool results are in (a
 * function, never a tool call); or a tool call built from the context.
 */
export type Step =
  | ReplyStep
  | ((ctx: PlanContext) => ReplyStep[])
  | { kind: "tool-from"; build: (ctx: PlanContext) => ReplyStep };

const PAGES = "/scripted/pages/";
/** What the `#image` scenario asks the image tool to draw. */
export const IMAGE_PROMPT = "A sun over a green hill, in flat solid colours";
/** The message `#send-picture` sends with the trail map, and the words after it. */
export const SEND_PICTURE_TEXT = "Here is the trail map.";
export const SEND_PICTURE_AFTER = "That is the route for Saturday.";
/**
 * The message `#send-keyed` sends, and the idempotency key it gives the message tool: the shape of
 * the key the gateway gives its skill note, with a made-up review id. A bot can pass any key.
 */
export const SEND_KEYED_TEXT = "The Saturday hike moved to Sunday at 9.";
export const SEND_KEYED_KEY =
  "skill-workshop-notice:skill-workshop-review:5e1f0c2a-7b3d-4e8f-9a6b-1c2d3e4f5a6b";
/** An address outside loopback, in a documentation range nothing answers. */
export const OUTSIDE_ADDRESS = "http://192.0.2.1/";
/** Another loopback port than the scripted pages' (one Chromium does not refuse itself): not theirs, so refused. */
export const OTHER_LOOPBACK = "http://127.0.0.1:2/scripted/pages/sign-in";

const isToolStep = (step: Step) =>
  typeof step !== "function" && (step.kind === "tool" || step.kind === "tool-from");

export type Scenario = {
  /** The directive, without `#`. */
  name: string;
  /** A plain-language phrase that selects it, matched case-insensitively anywhere in the message. */
  phrase: string;
  /** Takes a number after the directive, such as `#slow 5`, with this default. */
  defaultArg?: number;
  maxArg?: number;
  /** One line for the README. */
  summary: string;
  /** Which bots it is meant for, for the README. */
  bots?: string;
  steps: (arg: number) => Step[];
};

const think = (text: string, delayMs?: number): ReplyStep => ({
  kind: "reasoning",
  text,
  ...(delayMs ? { delayMs } : {}),
});
const say = (text: string, delayMs?: number): ReplyStep => ({
  kind: "text",
  text,
  ...(delayMs ? { delayMs } : {}),
});
/**
 * A browser call built from the scripted pages' origin, or a plain reply on
 * an instance without browsers of their own.
 */
const browserCall = (args: (origin: string) => Record<string, unknown>): Step => ({
  kind: "tool-from",
  build: (ctx) =>
    ctx.pagesOrigin
      ? { kind: "tool", id: "", name: "browser", arguments: args(ctx.pagesOrigin) }
      : { kind: "text", text: "This instance has no scripted pages." },
});

/** The reply after browser calls: what the last one says when the gateway refused it. */
const afterBrowser =
  (text: string): Step =>
  (ctx) => {
    const result = [...ctx.results].reverse().find((r) => r.name === "browser");
    if (!result) return [];
    if (/has control of this bot's browser/i.test(result.text)) {
      return [say("A person has control of my browser, so I left it alone.")];
    }
    return [say(text)];
  };

/** Tool call ids are filled in by the planner, so they are unique in a session. */
const tool = (name: string, args: Record<string, unknown>): ReplyStep => ({
  kind: "tool",
  id: "",
  name,
  arguments: args,
});
const mcp = (name: string, args: Record<string, unknown>) =>
  tool(`${CODING_AGENT_SERVER}__${name}`, args);

/**
 * The latest result of a tool, parsed as JSON. Some tools put a summary
 * before the JSON (ask_user does), so the first JSON object in it counts.
 */
function lastResult(ctx: PlanContext, name: string): Record<string, unknown> | null {
  const found = [...ctx.results].reverse().find((result) => result.name === name);
  if (!found) return null;
  // The JSON may be the whole text, or follow a summary, or be followed by
  // the tool's own text: try each object that starts a line, up to each "}"
  // that ends one. Indented over several lines (2026.10.6) or on one (2026.11.10).
  const starts = [...found.text.matchAll(/^\{/gm)].map((m) => m.index);
  const ends = [...found.text.matchAll(/\}$/gm)].map((m) => m.index + 1).reverse();
  for (const start of starts) {
    for (const end of [found.text.length, ...ends]) {
      if (end <= start) continue;
      try {
        const parsed: unknown = JSON.parse(found.text.slice(start, end));
        if (parsed !== null && typeof parsed === "object") return parsed as Record<string, unknown>;
      } catch {
        // try the next candidate
      }
    }
  }
  return null;
}

const rec = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

/** The name `#take-name` or its phrase takes: the rest of that line, or null when none follows. */
export function takenName(prompt: string | undefined): string | null {
  return /(?:#take-name|take this name)[ \t]+([^\n]+)/i.exec(prompt ?? "")?.[1]?.trim() || null;
}

/** Every bot's workspace starts with these five files, so six reads need one twice. */
const SIX_READS = [
  { path: "AGENTS.md" },
  { path: "SOUL.md" },
  { path: "IDENTITY.md" },
  { path: "USER.md" },
  { path: "BOOTSTRAP.md" },
  { path: "AGENTS.md", offset: 3 },
];

/** Nine reads: with the text after them, the ten model calls that make a task due for a review. */
const LEARN_READS = [
  ...SIX_READS,
  { path: "SOUL.md", offset: 3 },
  { path: "USER.md", offset: 2 },
  { path: "IDENTITY.md", offset: 2 },
];

/** The skill the background review saves after `#learn`, and the reason it gives. */
export const LEARNED_SKILL = "trail-check";
export const LEARNED_REASON = "check the trail before a hike";

/** How the gateway's background skill review prompt begins (buildSkillExperienceReviewPrompt). */
export const SKILL_REVIEW_PROMPT = "Background skill review.";

/**
 * The scripted model's answer to the gateway's background skill review. It
 * saves a skill only when the turn it reviews was a `#learn`: it lists the
 * learned skills, as the review prompt asks, then creates `trail-check` (or
 * `trail-check-2` and so on, when that name is taken), then says the gateway's
 * "nothing to say". Every other review says only that.
 */
export function skillReviewReply(
  conversation: { role: string; text: string }[],
  results: { name: string; text: string }[],
  tools: Set<string>,
): ReplyStep[] {
  const silent: ReplyStep[] = [{ kind: "text", text: "NO_REPLY" }];
  const reviewed = conversation.findLast((message) => message.role === "user");
  const learn =
    reviewed && selectScenarios(reviewed.text).some(({ scenario }) => scenario.name === "learn");
  if (!learn || !tools.has("skill_workshop")) return silent;
  const done = results.filter((result) => result.name === "skill_workshop");
  if (done.length === 0) return [tool("skill_workshop", { action: "list" })];
  if (done.length > 1) return silent;
  const taken = new Set(done[0]!.text.match(new RegExp(`\\b${LEARNED_SKILL}(?:-\\d+)?\\b`, "g")));
  let name = LEARNED_SKILL;
  for (let n = 2; taken.has(name); n += 1) name = `${LEARNED_SKILL}-${n}`;
  return [
    tool("skill_workshop", {
      action: "create",
      name,
      reason: LEARNED_REASON,
      content: `---\nname: ${name}\ndescription: Use before a hike to check the trail's conditions.\n---\n\n# Trail check\n\n1. Read the trail notes in the workspace.\n2. Say which parts are closed.\n`,
    }),
  ];
}

/** The only shell commands any scenario emits. All are harmless and stay in the bot's workspace. */
export const SHELL_COMMANDS = {
  list: "ls",
  print: "echo 'Hello from Otto.'",
  missing: "ls missing-folder",
  sleep: (seconds: number) => `sleep ${seconds}`,
} as const;

/** The large write's file and size: over the 262,144-byte preview limit of the gateway's readers. */
export const LARGE_LOG_PATH = "logs/transcode.log";
export const LARGE_LOG_BYTES = 300_000;
/** The large write's content: numbered transcode lines, exactly `LARGE_LOG_BYTES` long. */
export function largeLog(): string {
  const lines: string[] = [];
  let length = 0;
  for (let i = 1; length < LARGE_LOG_BYTES; i += 1) {
    const line = `${String(i).padStart(6, "0")} transcode job finished: episode ${i % 97}, 1080p, kept in cache\n`;
    lines.push(line);
    length += line.length;
  }
  return lines.join("").slice(0, LARGE_LOG_BYTES);
}

/**
 * The large log in two calls: the lines up to about half of it (ending with a
 * whole line, its last one unique), then the rest, appended after that line.
 */
export function largeLogParts(): { first: string; lastLine: string; rest: string } {
  const log = largeLog();
  const cut = log.indexOf("\n", LARGE_LOG_BYTES / 2) + 1;
  const first = log.slice(0, cut);
  const lastLine = first.slice(first.lastIndexOf("\n", first.length - 2) + 1);
  return { first, lastLine, rest: log.slice(cut) };
}

const exec = (command: string, extra: Record<string, unknown> = {}) =>
  tool("exec", { command, workdir: ".", ...extra });

/** The text after a shell command, unless the gateway refused to run it. */
const afterExec =
  (text: string): Step =>
  (ctx) => {
    const result = [...ctx.results].reverse().find((r) => r.name === "exec");
    if (
      result &&
      /exec denied|approval/i.test(result.text) &&
      !/exited with code/.test(result.text)
    ) {
      return [say("The gateway did not let the command run.")];
    }
    return [say(text)];
  };

/** A slow stream: about four pieces a second for the given number of seconds. */
function slowText(seconds: number): ReplyStep {
  const pieces = Array.from(
    { length: seconds * 4 },
    (_, i) => `Still writing, part ${i + 1} of ${seconds * 4}. `,
  );
  return say(`Here is a long answer, streamed slowly.\n\n${pieces.join("")}\n\nDone.`, 250);
}

function partnerOf(ctx: PlanContext): string {
  // A bot outside the pair writes to the first of it, and the gateway refuses.
  return (ctx.agentId && messagingPartner(ctx.agentId)) ?? MESSAGING_PAIR[0];
}

/**
 * How long `#message` lets the other bot take to answer within the call (#883). The gateway
 * returns as soon as the answer is there, so a fast gateway waits no longer. On a loaded hosted
 * runner the answer came about 45 s after the send, past the 30 s this used to give: one chat
 * send there spent 35 s preparing and SQLite held the bot's store for up to 12.8 s. One seed call
 * has taken 94 s (#710), and the seed already gives a call it can read back about 3 minutes.
 */
export const SAME_CALL_REPLY_SECONDS = 180;
/**
 * How long a run whose `#message` call may wait that whole limit can take: the limit, and the
 * 120 s the seed gave a whole run before (#883) for the run's own work around the call, its
 * preparation and the model calls before and after it.
 */
export const SAME_CALL_RUN_MS = SAME_CALL_REPLY_SECONDS * 1000 + 120_000;

/** A bot-to-bot message whose text tells the recipient which scenario to play. */
function message(recipientDirective: string, request: string, timeoutSeconds: number): Step[] {
  return [
    (ctx) => [
      think(
        `I will ask ${SEED_BOTS.find((bot) => bot.id === partnerOf(ctx))?.name ?? partnerOf(ctx)} for help with this.`,
      ),
    ],
    {
      kind: "tool-from",
      build: (ctx) =>
        tool("sessions_send", {
          // With only an agent id the gateway uses that bot's main session.
          agentId: partnerOf(ctx),
          message: `${recipientDirective} ${request}`,
          timeoutSeconds,
        }),
    },
    (ctx) => {
      const result = lastResult(ctx, "sessions_send");
      const id = partnerOf(ctx);
      const who = SEED_BOTS.find((bot) => bot.id === id)?.name ?? id;
      const status = typeof result?.status === "string" ? result.status : "unknown";
      if (status === "ok") return [say(`${who} replied:\n\n> ${String(result?.reply ?? "")}`)];
      if (status === "accepted") {
        return [say(`${who} is still working on it. Their reply will arrive in this task.`)];
      }
      if (result?.sentBeforeError === true) {
        return [say(`${who} got the message, but their run failed.`)];
      }
      return [say(`The message to ${who} did not get through (${status}).`)];
    },
  ];
}

/** What `#hand-off` and its siblings ask the gateway to start: a label and a brief, as a bot writes them. */
export const HAND_OFF = {
  label: "Compare trail maps",
  task: "Compare the lake loop and the ridge trail on the trail map, and say which suits a relaxed Saturday. Reply in plain text.",
} as const;
export const HAND_OFF_HIDDEN = {
  label: "Check the forecast",
  task: "Check the forecast for Saturday on the ridge. Reply in plain text.",
} as const;
export const HAND_OFF_PARTNER = {
  label: "Review the route",
  task: "Read over the Saturday route and say what you would change. Reply in plain text.",
} as const;
/** What `#follow-up` sends to the task the bot started last. */
export const FOLLOW_UP_MESSAGE = "Also say which route has more shade. Reply in plain text.";

/** A sessions_spawn call: visible when the person can open the task, under a partner when named. */
function spawn(
  brief: { label: string; task: string },
  options: { visible?: boolean; partner?: boolean } = {},
): Step {
  return {
    kind: "tool-from",
    build: (ctx) =>
      tool("sessions_spawn", {
        task: brief.task,
        label: brief.label,
        ...(options.visible ? { visible: true } : {}),
        ...(options.partner ? { agentId: partnerOf(ctx) } : {}),
      }),
  };
}

/** The reply after sessions_spawn: what started, or the gateway's reason it did not. */
const afterSpawn =
  (started: (ctx: PlanContext) => string): Step =>
  (ctx) => {
    const result = lastResult(ctx, "sessions_spawn");
    if (result?.status === "accepted") return [say(started(ctx))];
    const reason = typeof result?.error === "string" ? `: ${result.error}` : "";
    return [say(`The task did not start (${String(result?.status ?? "unknown")})${reason}`)];
  };

/** The task the bot started last in this conversation, from its sessions_spawn results. */
export function lastStartedTask(ctx: PlanContext): string | null {
  for (const found of [...(ctx.history ?? [])].reverse()) {
    if (found.name !== "sessions_spawn") continue;
    const key = lastResult({ ...ctx, results: [found] }, "sessions_spawn")?.childSessionKey;
    if (typeof key === "string") return key;
  }
  return null;
}

const QUESTION_ROUTE = {
  id: "route",
  header: "Route",
  question: "Which route should I plan for Saturday?",
  options: [
    { label: "Lake loop", description: "3 miles, mostly flat" },
    { label: "Ridge trail", description: "6 miles, one steep climb" },
    { label: "Town walk" },
  ],
};

function answerText(ctx: PlanContext): ReplyStep[] {
  const result = lastResult(ctx, "ask_user");
  // The tool reports `{status, answers: {answers: {<questionId>: [...]}}}`.
  const outer = (result?.answers ?? {}) as Record<string, unknown>;
  const answers = ((outer.answers ?? outer) as Record<string, unknown>) ?? {};
  const lines = Object.entries(answers).map(
    ([id, value]) => `- ${id}: ${Array.isArray(value) ? value.join(", ") : String(value)}`,
  );
  if (result?.status !== "answered" || lines.length === 0) {
    return [say("No answer came back, so I will go with my best judgment.")];
  }
  return [say(`Thanks. You answered:\n\n${lines.join("\n")}`)];
}

const ask = (questions: unknown[]): Step[] => [
  think("I need a decision from you before I go on."),
  tool("ask_user", { questions, timeoutSeconds: 600 }),
  answerText,
];

export const SCENARIOS: Scenario[] = [
  {
    name: "help",
    phrase: "what scenarios can you play",
    summary: "Lists every directive and phrase.",
    steps: () => [
      () => [
        say(
          `Send a directive or a phrase. Several directives run in order.\n\n${SCENARIOS.filter(
            (s) => s.name !== "help",
          )
            .map(
              (s) =>
                `- \`#${s.name}${s.defaultArg === undefined ? "" : " [seconds]"}\` or "${s.phrase}": ${s.summary}`,
            )
            .join("\n")}`,
        ),
      ],
    ],
  },
  {
    name: "text",
    phrase: "reply in plain text",
    summary: "Streamed text, no reasoning.",
    steps: () => [say("Here is a plain reply, streamed in small pieces with no reasoning first.")],
  },
  {
    name: "think",
    phrase: "think before you answer",
    summary: "Reasoning, then text.",
    steps: () => [
      think("The user wants to see reasoning first. I will reason briefly, then answer."),
      say("I thought it over first. This is the answer that follows the reasoning."),
    ],
  },
  {
    name: "think-only",
    phrase: "think without answering",
    summary:
      "Reasoning only: no text and no tool. The gateway asks twice more for a visible answer, then ends the run in an error.",
    steps: () => [think("I am only thinking here and will not write a visible answer.")],
  },
  {
    name: "steps",
    phrase: "show your work",
    summary: "Reasoning, a tool call, more reasoning, another tool call, then text.",
    steps: () => [
      think("First I should see what is in my workspace."),
      tool("ls", { path: "." }),
      think("My instructions file is there. I will read it before answering."),
      tool("read", { path: "AGENTS.md" }),
      say("I listed my workspace and read my instructions. Both steps are shown above."),
    ],
  },
  {
    name: "slow",
    phrase: "take your time",
    defaultArg: 20,
    maxArg: 300,
    summary:
      "Reasoning, then text streamed slowly for N seconds (default 20): stop it, or queue a message behind it.",
    steps: (seconds) => [
      think("This will take a while, so I will stream it slowly.", 250),
      slowText(seconds),
    ],
  },
  {
    name: "stream",
    phrase: "stream a long answer",
    defaultArg: 10,
    maxArg: 300,
    summary:
      "Text streamed slowly for N seconds (default 10), with no reasoning first: a run still going when a client quits and opens again.",
    steps: (seconds) => [slowText(seconds)],
  },
  {
    name: "slow-tool",
    phrase: "run a slow tool",
    defaultArg: 20,
    maxArg: 600,
    summary:
      "A tool call that takes N seconds (default 20): steer into it, stop it or queue behind it.",
    steps: (seconds) => [
      think(
        "This tool takes a while. You can stop the run, steer it or queue a message behind it.",
      ),
      mcp("slow_task", { seconds }),
      say("The slow tool finished."),
    ],
  },
  {
    name: "tool-fail",
    phrase: "use a tool that fails",
    summary: "A tool call that fails (reading a file that does not exist), then text.",
    steps: () => [
      think("I will read my old notes. They may not exist."),
      tool("read", { path: "missing/old-notes.md" }),
      say("That file does not exist, so the step failed. I will carry on without it."),
    ],
  },
  {
    name: "long-output",
    phrase: "print a long output",
    summary: "A tool whose output is long enough for the gateway to cut it (20,000 lines).",
    steps: () => [
      think("This tool prints a lot. The gateway will shorten what it keeps."),
      mcp("long_output", { lines: 20_000 }),
      say("The tool printed 20,000 lines. Only part of them was kept."),
    ],
  },
  {
    name: "read",
    phrase: "read your instructions",
    summary: "One file read: the bot's own AGENTS.md.",
    steps: () => [
      think("I will read my instructions."),
      tool("read", { path: "AGENTS.md" }),
      say("I read my instructions file."),
    ],
  },
  {
    name: "reply-to",
    phrase: "answer that message",
    summary:
      "Text beside a folder listing, then an answer tagged as a reply to the message id after the directive. The gateway keeps that id on the answer's row (`openclawDelivery.replyToId`), never on a row with a call.",
    steps: () => [
      say("I will look first, then answer that message."),
      tool("ls", { path: "." }),
      (ctx) => {
        const id = /#reply-to\s+([\w-]+)/.exec(ctx.prompt ?? "")?.[1];
        const text = `This answers ${id ?? "no message: none was named"}.`;
        return [say(id ? `[[reply_to:${id}]] ${text}` : text)];
      },
    ],
  },
  {
    name: "read-six",
    phrase: "read six files",
    summary: "Six file reads in a row, with nothing between them.",
    steps: () => [
      think("I will read through my workspace files one after another."),
      ...SIX_READS.map((args) => tool("read", args)),
      say("I read six files in my workspace."),
    ],
  },
  {
    name: "learn",
    phrase: "learn from this",
    summary: `Ten model calls in one turn (nine file reads, then text), the work after which the gateway reviews a task in the background. On an instance started with \`--with-skill-review\`, that review saves a skill (\`${LEARNED_SKILL}\`) and the gateway adds its note to the task about 30 seconds after the turn.`,
    steps: () => [
      ...LEARN_READS.map((args) => tool("read", args)),
      say("I read through my workspace files one by one."),
    ],
  },
  {
    name: "list",
    phrase: "list your files",
    summary: "One folder listing of the bot's workspace.",
    steps: () => [tool("ls", { path: "." }), say("Those are the files in my workspace.")],
  },
  {
    name: "write",
    phrase: "write a note",
    summary: "One file write in the bot's workspace (notes/scratch.md).",
    steps: () => [
      tool("write", { path: "notes/scratch.md", content: "# Scratch\n\n- Check the trail map.\n" }),
      say("I wrote notes/scratch.md."),
    ],
  },
  {
    name: "edit",
    phrase: "edit a note",
    summary: "A file write, then an edit of the same file (notes/edit-me.md).",
    steps: () => [
      tool("write", { path: "notes/edit-me.md", content: "Leave at 9:00.\n" }),
      tool("edit", {
        path: "notes/edit-me.md",
        edits: [{ oldText: "Leave at 9:00.", newText: "Leave at 8:30." }],
      }),
      say("I changed the departure time in notes/edit-me.md."),
    ],
  },
  {
    name: "take-name",
    phrase: "take this name",
    summary:
      "A read of IDENTITY.md, then an edit of its name line (`- **Name:**`, or `- Name:` as the gateway writes it) to the words after the directive or the phrase (`#take-name Johnny`), as a bot asked to take a name does. Its name in the gateway's config stays as it was.",
    steps: () => [
      tool("read", { path: "IDENTITY.md" }),
      {
        kind: "tool-from",
        build: (ctx) => {
          const read = [...ctx.results].reverse().find((r) => r.name === "read")?.text ?? "";
          const line = /^- (?:\*\*Name:\*\*|Name:).*$/m.exec(read)?.[0];
          const name = takenName(ctx.prompt);
          if (!line || !name) return say("I found no name line to change.");
          return tool("edit", {
            path: "IDENTITY.md",
            edits: [{ oldText: line, newText: `- **Name:** ${name}` }],
          });
        },
      },
      (ctx) => [say(`${takenName(ctx.prompt)} it is. It shows once you confirm it in Clawtrate.`)],
    ],
  },
  {
    name: "write-large",
    phrase: "write a long log",
    summary: `A file write, then an edit that appends to it, leaving it over the gateway's 256 KiB preview limit (logs/transcode.log, ${LARGE_LOG_BYTES.toLocaleString("en-US")} bytes): the Work pane says it is too large to show, with the limit. Two calls, because the gateway takes at most 256,000 bytes of arguments in one.`,
    steps: () => {
      const { first, lastLine, rest } = largeLogParts();
      return [
        // Streamed in 16 KB pieces: at the usual 32 characters it would take minutes.
        { ...tool("write", { path: LARGE_LOG_PATH, content: first }), argumentPiece: 16_384 },
        {
          ...tool("edit", {
            path: LARGE_LOG_PATH,
            edits: [{ oldText: lastLine, newText: lastLine + rest }],
          }),
          argumentPiece: 16_384,
        },
        say("I wrote the transcode log to logs/transcode.log."),
      ];
    },
  },
  {
    name: "picture",
    phrase: "look at the trail map",
    summary: `One file read of the picture seeded in Pip's workspace (${PICTURE_PATH}).`,
    bots: "Pip",
    steps: () => [
      tool("read", { path: PICTURE_PATH }),
      say("That is the trail map in my workspace."),
    ],
  },
  {
    name: "send-picture",
    phrase: "send me the trail map",
    summary: `Sends the trail map from Pip's workspace (${PICTURE_PATH}) with the message tool: the gateway delivers it as a message in the task, with the picture, then the bot says one more line.`,
    bots: "Pip, on an instance started with `--with-message-tool`",
    steps: () => [
      tool("message", { action: "send", message: SEND_PICTURE_TEXT, media: PICTURE_PATH }),
      (ctx) => {
        const result = [...ctx.results].reverse().find((r) => r.name === "message");
        if (!result) return [];
        return [
          say(
            /^Sent visible reply/.test(result.text)
              ? SEND_PICTURE_AFTER
              : `The message tool answered: ${result.text.split("\n")[0]!.slice(0, 200)}`,
          ),
        ];
      },
    ],
  },
  {
    name: "send-keyed",
    phrase: "send it with the note key",
    summary: `Sends one line with the message tool, giving it the idempotency key \`${SEND_KEYED_KEY}\`, the shape of the gateway's skill-note key: the gateway delivers it as a message in the task under that key. The bot then answers \`NO_REPLY\`, so that message is the task's last.`,
    bots: "any bot, on an instance started with `--with-message-tool`",
    steps: () => [
      tool("message", { action: "send", message: SEND_KEYED_TEXT, idempotencyKey: SEND_KEYED_KEY }),
      say("NO_REPLY"),
    ],
  },
  {
    name: "attach",
    phrase: "attach the reviews",
    summary: `Writes a two-page PDF (${ATTACH_PDF_PATH}) and a text note (${ATTACH_TEXT_PATH}) in the bot's workspace, then ends its answer with a \`MEDIA:\` line for each: the gateway hands both over as files on the reply.`,
    steps: () => [
      tool("write", { path: ATTACH_PDF_PATH, content: reviewsDraftPdf() }),
      tool("write", { path: ATTACH_TEXT_PATH, content: ATTACH_NOTE }),
      say(`${ATTACH_TEXT}\nMEDIA:./${ATTACH_PDF_PATH}\nMEDIA:./${ATTACH_TEXT_PATH}`),
    ],
  },
  {
    name: "remember",
    phrase: "save this to memory",
    summary: "A memory note: a write to the bot's daily memory file (memory/2026-11-17.md).",
    steps: () => [
      think("This is worth remembering. I will add it to today's memory notes."),
      tool("write", {
        path: "memory/2026-11-17.md",
        content: "- Prefers the lake loop on relaxed weekends.\n",
      }),
      say("Saved to memory: you prefer the lake loop on relaxed weekends."),
    ],
  },
  {
    name: "search",
    phrase: "search the web",
    summary: "A web search, answered by the scripted server (no network).",
    steps: () => [
      think("I will search the web for this."),
      tool("web_search", { query: "cold climate heat pump performance", count: 3 }),
      say("I found three results; they are shown above."),
    ],
  },
  {
    name: "sessions",
    phrase: "list your tasks",
    summary: "A look at the bot's sessions (sessions_list).",
    steps: () => [tool("sessions_list", { limit: 5 }), say("Those are my recent tasks.")],
  },
  {
    name: "schedule",
    phrase: "schedule a reminder",
    summary:
      'Creates a routine, then removes it (automations). The gateway offers this tool only in runs started as its owner, as the scenario check does through the CLI; a paired client\'s run gets "Tool automations not found".',
    steps: () => [
      think("I will set up a routine, then remove it again."),
      tool("automations", {
        action: "add",
        job: {
          name: "Scripted reminder",
          schedule: { kind: "at", at: "2035-01-01T09:00:00Z" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "Reminder: check the trail conditions." },
        },
      }),
      {
        kind: "tool-from",
        build: (ctx) => {
          const added = lastResult(ctx, "automations");
          const id = added?.id ?? rec(added?.job).id ?? added?.jobId ?? "unknown";
          return tool("automations", { action: "remove", jobId: String(id) });
        },
      },
      (ctx) => [
        say(
          lastResult(ctx, "automations")?.removed === true
            ? "I created the routine and removed it again."
            : "The routine could not be set up here; the gateway offers routines only to its owner.",
        ),
      ],
    ],
  },
  {
    name: "plan",
    phrase: "show a plan",
    summary: "A tool with no kind of its own: a progress card with a finished three-step plan.",
    steps: () => [
      tool("progress_card", {
        plan: [
          { step: "Check the weather", status: "completed" },
          { step: "Book the cabin", status: "completed" },
          { step: "Pack", status: "completed" },
        ],
      }),
      say("The plan is on the card above."),
    ],
  },
  {
    name: "approve",
    phrase: "run a command I can approve",
    bots: "Otto",
    summary: `Asks to run \`${SHELL_COMMANDS.list}\` in Otto's workspace. The approval offers a reusable rule (allow-always).`,
    steps: () => [
      think("I will list my workspace with the shell. That needs your approval."),
      exec(SHELL_COMMANDS.list),
      afterExec("The command ran once you approved it, and its output is shown above."),
    ],
  },
  {
    name: "approve-once",
    phrase: "run a command I approve every time",
    bots: "Otto",
    summary: `Asks to run \`${SHELL_COMMANDS.print}\` with per-call ask "always": the approval offers no reusable rule.`,
    steps: () => [
      think("I will print a line with the shell and ask every time."),
      exec(SHELL_COMMANDS.print, { ask: "always" }),
      afterExec("That command needs a new approval every time it runs."),
    ],
  },
  {
    name: "exit-code",
    phrase: "run a command that fails",
    bots: "Otto",
    summary: `Asks to run \`${SHELL_COMMANDS.missing}\`, which exits non-zero.`,
    steps: () => [
      think("I will list a folder that does not exist."),
      exec(SHELL_COMMANDS.missing),
      afterExec("The command exited with an error code, which the result shows."),
    ],
  },
  {
    name: "exec-timeout",
    phrase: "run a command that times out",
    bots: "Otto",
    summary: `Asks to run \`${SHELL_COMMANDS.sleep(5)}\` with a 1 second limit, so it is stopped.`,
    steps: () => [
      think("I will start a command with a time limit shorter than it needs."),
      exec(SHELL_COMMANDS.sleep(5), { timeoutSeconds: 1 }),
      afterExec("The command ran past its time limit and was stopped."),
    ],
  },
  {
    name: "sleep",
    phrase: "run a slow command",
    bots: "Otto",
    defaultArg: 20,
    maxArg: 120,
    summary: "Asks to run `sleep N` (default 20, at most 120): a slow shell command.",
    steps: (seconds) => [
      think("I will run a slow shell command."),
      exec(SHELL_COMMANDS.sleep(seconds)),
      afterExec("The slow command finished."),
    ],
  },
  {
    name: "ask",
    phrase: "ask me a question",
    summary: "One question with options, through the gateway's question tool.",
    steps: () => ask([QUESTION_ROUTE]),
  },
  {
    name: "ask-many",
    phrase: "ask me several questions",
    summary: "Three questions in one card.",
    steps: () =>
      ask([
        QUESTION_ROUTE,
        {
          id: "start_time",
          header: "Start",
          question: "When should we leave?",
          options: [{ label: "8:00" }, { label: "9:30" }, { label: "11:00" }],
        },
        {
          id: "lunch",
          header: "Lunch",
          question: "Should I book lunch?",
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ]),
  },
  {
    name: "ask-multi",
    phrase: "let me pick several",
    summary: "One multi-select question.",
    steps: () =>
      ask([
        {
          id: "packing",
          header: "Packing",
          question: "What should go on the packing list?",
          options: [
            { label: "Rain shell" },
            { label: "Headlamp" },
            { label: "Snacks" },
            { label: "Map" },
          ],
          multiSelect: true,
        },
      ]),
  },
  {
    name: "ask-text",
    phrase: "ask me to type an answer",
    summary:
      "A question meant to be answered in free text (every question also accepts typed text).",
    steps: () =>
      ask([
        {
          id: "trip_name",
          header: "Name",
          question: "What should I call this trip? Type any name.",
          options: [{ label: "Mountain weekend" }, { label: "Lake getaway" }],
        },
      ]),
  },
  {
    name: "reply",
    phrase: "reply with a note",
    summary: "A short note; what a bot answers when the other bot messages it.",
    steps: () => [say("Happy to help. The plan looks sound; I would leave half an hour earlier.")],
  },
  {
    name: "message",
    phrase: "message your partner",
    bots: "Marlow or Pip",
    summary: "A message to the other bot of the pair, answered in the same call.",
    steps: () => message("#reply", "Could you look over the plan?", SAME_CALL_REPLY_SECONDS),
  },
  {
    name: "message-slow",
    phrase: "message your slow partner",
    bots: "Marlow or Pip",
    summary:
      "A message to the other bot, which takes 15 seconds; the call returns before it answers, and the reply arrives later in the same task.",
    steps: () => message("#slow 15", "Could you write a long note on the plan?", 3),
  },
  {
    name: "message-fail",
    phrase: "message your failing partner",
    bots: "Marlow or Pip",
    summary: "A message to the other bot, whose run ends in a model error.",
    steps: () => message("#model-error", "Could you check the plan?", 30),
  },
  {
    name: "message-ask",
    phrase: "message your partner who asks",
    bots: "Marlow or Pip",
    summary: "A message to the other bot, which asks its own user a question before replying.",
    steps: () => message("#ask", "Which route should we plan for?", 5),
  },
  {
    name: "message-read",
    phrase: "message your partner who reads",
    bots: "Marlow or Pip",
    summary:
      "A message to the other bot, which reads its own instructions file before replying: a tool call in a run another bot's message started.",
    steps: () => message("#read", "Could you check your instructions?", 30),
  },
  {
    name: "hand-off",
    phrase: "put this in a task",
    summary: `Starts a task of the bot's own with the gateway's \`sessions_spawn\` (\`visible: true\`), labelled "${HAND_OFF.label}", whose first message is the bot's brief. It runs at once, and the person can open it and write in it. Its end starts a turn in the task it came from.`,
    steps: () => [
      think("This is worth a task of its own. I will start one with a brief."),
      spawn(HAND_OFF, { visible: true }),
      afterSpawn(() => `I started a task for it: ${HAND_OFF.label}.`),
    ],
  },
  {
    name: "hand-off-hidden",
    phrase: "work on this in the background",
    summary: `Starts a hidden helper with \`sessions_spawn\` (no \`visible\`), labelled "${HAND_OFF_HIDDEN.label}": a session the task list leaves out. Its end starts a turn in the task it came from.`,
    steps: () => [
      spawn(HAND_OFF_HIDDEN),
      afterSpawn(() => "I started a helper on it in the background."),
    ],
  },
  {
    name: "follow-up",
    phrase: "add to that task",
    summary: `Sends a follow-up with \`sessions_send\` to the task this conversation started last ("${FOLLOW_UP_MESSAGE}"). Its answer starts a turn in this conversation again.`,
    steps: () => [
      {
        kind: "tool-from",
        build: (ctx) => {
          const key = lastStartedTask(ctx);
          if (!key) return say("I have started no task here to add to.");
          return tool("sessions_send", {
            sessionKey: key,
            message: FOLLOW_UP_MESSAGE,
            timeoutSeconds: 0,
          });
        },
      },
      (ctx) => {
        const result = lastResult(ctx, "sessions_send");
        if (!result) return [];
        if (result.status === "accepted") return [say("I added that to the task.")];
        return [say(`The task did not take it (${String(result.status ?? "unknown")}).`)];
      },
    ],
  },
  {
    name: "hand-off-to-partner",
    phrase: "put this in a task for your partner",
    bots: "Marlow or Pip",
    summary: `Starts a task under the other bot of the pair with \`sessions_spawn\` (\`visible: true\`, \`agentId\`), labelled "${HAND_OFF_PARTNER.label}". It is listed under that bot, and its end starts a turn in the task it came from.`,
    steps: () => [
      spawn(HAND_OFF_PARTNER, { visible: true, partner: true }),
      afterSpawn((ctx) => {
        const id = partnerOf(ctx);
        const who = SEED_BOTS.find((bot) => bot.id === id)?.name ?? id;
        return `I started a task for it under ${who}: ${HAND_OFF_PARTNER.label}.`;
      }),
    ],
  },
  {
    name: "mcp",
    phrase: "ask the coding agent",
    summary: "A call to the stand-in coding agent over MCP; the result carries a link.",
    steps: () => [
      think("This is a coding change. I will hand it to the coding agent."),
      mcp("send_message", { message: "Add a dark mode toggle to the settings page." }),
      (ctx) => {
        const result = lastResult(ctx, `${CODING_AGENT_SERVER}__send_message`);
        return [say(`The coding agent picked it up: ${String(result?.url ?? "no link returned")}`)];
      },
    ],
  },
  {
    name: "mcp-slow",
    phrase: "ask the coding agent something slow",
    defaultArg: 20,
    maxArg: 600,
    summary: "A call to the coding agent that takes N seconds (default 20) to reply.",
    steps: (seconds) => [
      think("This change is larger. The coding agent will take a while."),
      mcp("send_message", {
        message: "Refactor the settings page into sections.",
        delaySeconds: seconds,
      }),
      (ctx) => {
        const result = lastResult(ctx, `${CODING_AGENT_SERVER}__send_message`);
        return [say(`The coding agent finished: ${String(result?.url ?? "no link returned")}`)];
      },
    ],
  },
  {
    name: "mcp-error",
    phrase: "ask the coding agent to run the checks",
    summary: "A call to the coding agent that returns an error.",
    steps: () => [
      think("I will ask the coding agent to run the checks."),
      mcp("run_checks", {}),
      say("The coding agent reported that the checks failed."),
    ],
  },
  {
    name: "mcp-stop",
    phrase: "start a coding task I can stop",
    summary: "A call to the coding agent that does not finish for an hour: stop the run mid-call.",
    steps: () => [
      think("This coding task runs for a long time. Stop the run to cancel it."),
      mcp("slow_task", { seconds: 3600 }),
      say("The long coding task finished."),
    ],
  },
  {
    name: "model-error",
    phrase: "fail with a model error",
    summary: "The model request fails, so the run ends in an error.",
    steps: () => [{ kind: "fail", status: 400, message: "The scripted model was asked to fail." }],
  },
  {
    name: "browse",
    phrase: "open the scripted sign in page",
    summary: "Opens the scripted sign-in page in a new tab of the bot's own browser.",
    bots: "a bot with a browser of its own",
    steps: () => [
      browserCall((origin) => ({ action: "open", url: `${origin}${PAGES}sign-in` })),
      afterBrowser("Opened the scripted sign-in page."),
    ],
  },
  {
    name: "browse-read",
    phrase: "read the open page",
    summary: "Reads the text of the bot's current tab.",
    bots: "a bot with a browser of its own",
    steps: () => [browserCall(() => ({ action: "text" })), afterBrowser("Read the page.")],
  },
  {
    name: "browse-slow",
    phrase: "open the slow scripted page",
    summary: "Navigates the current tab to a scripted page that takes eight seconds to load.",
    bots: "a bot with a browser of its own",
    steps: () => [
      browserCall((origin) => ({ action: "navigate", url: `${origin}${PAGES}slow` })),
      afterBrowser("The slow page loaded."),
    ],
  },
  {
    name: "browse-download",
    phrase: "download the scripted file",
    summary:
      "Navigates the current tab to a scripted file that downloads slowly, over eight seconds.",
    bots: "a bot with a browser of its own",
    steps: () => [
      browserCall((origin) => ({ action: "navigate", url: `${origin}${PAGES}download` })),
      afterBrowser("Started the download."),
    ],
  },
  {
    name: "browse-outside",
    phrase: "open an outside address",
    summary: `Navigates to ${OUTSIDE_ADDRESS}, then to another loopback port (${OTHER_LOOPBACK}), and reads what the tab shows; both are refused.`,
    bots: "a bot with a browser of its own",
    steps: () => [
      browserCall(() => ({ action: "navigate", url: OUTSIDE_ADDRESS })),
      browserCall(() => ({ action: "navigate", url: OTHER_LOOPBACK })),
      browserCall(() => ({ action: "text" })),
      afterBrowser("Tried both addresses."),
    ],
  },
  {
    name: "image",
    phrase: "draw the sun over a green hill",
    summary:
      "Asks the image tool for a picture. The tool starts a background task, and the picture arrives in the gateway's next turn in the same task.",
    bots: "any bot, on an instance started with `--with-images`",
    steps: () => [
      think("I will ask the image tool for a picture."),
      tool("image_generate", { prompt: IMAGE_PROMPT }),
      (ctx) => {
        const result = [...ctx.results].reverse().find((r) => r.name === "image_generate");
        if (!result) return [];
        return [
          say(
            /Background task started/.test(result.text)
              ? "I asked for the picture. It will arrive in this task when it is ready."
              : `The image tool answered: ${result.text.split("\n")[0]!.slice(0, 200)}`,
          ),
        ];
      },
    ],
  },
];

const BY_NAME = new Map(SCENARIOS.map((scenario) => [scenario.name, scenario]));
const BY_PHRASE = [...SCENARIOS].sort((a, b) => b.phrase.length - a.phrase.length);

export type Selection = { scenario: Scenario; arg: number };

/**
 * The scenarios a message selects: every known `#directive` in order, or else
 * the longest phrase it contains. Unknown directives are ignored.
 */
export function selectScenarios(prompt: string): Selection[] {
  const selected: Selection[] = [];
  for (const match of prompt.matchAll(/(?:^|\s)#([a-z][a-z-]*)(?:\s+(\d+))?/g)) {
    const scenario = BY_NAME.get(match[1]!);
    if (!scenario) continue;
    const raw = match[2] === undefined ? (scenario.defaultArg ?? 0) : Number(match[2]);
    const arg = Math.min(
      scenario.maxArg ?? raw,
      Math.max(scenario.defaultArg === undefined ? 0 : 1, raw),
    );
    selected.push({ scenario, arg });
  }
  if (selected.length > 0) return selected;
  const text = prompt
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ");
  const phrase = BY_PHRASE.find((scenario) =>
    ` ${text} `.includes(` ${scenario.phrase.toLowerCase()} `),
  );
  return phrase ? [{ scenario: phrase, arg: phrase.defaultArg ?? 0 }] : [];
}

/**
 * The rounds of the selected scenarios, run one after the other. A round is
 * one model call; it ends after a tool call, and steps before the next tool
 * call join the round that leads to it.
 */
export function scenarioRounds(selection: Selection[]): Step[][] {
  const rounds: Step[][] = [[]];
  for (const { scenario, arg } of selection) {
    for (const step of scenario.steps(arg)) {
      rounds.at(-1)!.push(step);
      if (isToolStep(step)) rounds.push([]);
    }
  }
  if (rounds.at(-1)!.length === 0) rounds.pop();
  return rounds;
}

/** Resolve a round's steps and give each tool call an id unique in its session. */
export function resolveRound(round: Step[], ctx: PlanContext, callSeed: string): ReplyStep[] {
  let index = 0;
  const resolved = round.flatMap((step): ReplyStep[] =>
    typeof step === "function" ? step(ctx) : step.kind === "tool-from" ? [step.build(ctx)] : [step],
  );
  return resolved.map((step) => {
    if (step.kind !== "tool" || step.id) return step;
    index += 1;
    const id = createHash("sha256").update(`${callSeed}:${index}`).digest("hex").slice(0, 16);
    return { ...step, id: `call_${id}` };
  });
}

/** The scenarios that emit a shell command. They are meant for the shell bot only. */
export const SHELL_SCENARIOS = SCENARIOS.filter((scenario) =>
  scenario
    .steps(scenario.defaultArg ?? 1)
    .some((step) => typeof step !== "function" && step.kind === "tool" && step.name === "exec"),
).map((scenario) => scenario.name);
