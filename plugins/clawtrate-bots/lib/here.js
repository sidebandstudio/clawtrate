// The three read tools (docs/design/bots-in-clawtrate.md, sections 2 A and 7):
// clawtrate_here, clawtrate_tasks and clawtrate_bots. Each answer is built here
// from facts index.js gathers (the run's origin, the gateway's config, the
// session store), is at most 8 KiB, and says only what the person could see in
// Clawtrate about this bot: no device names, addresses, tokens or other
// conversations' text.

import { SOURCES } from "./origins.js";

export const ANSWER_MAX_BYTES = 8 * 1024;
export const TASKS_LIMIT = Object.freeze({ default: 20, max: 50 });

export const DESCRIPTIONS = Object.freeze({
  clawtrate_here:
    "Whether this conversation is in Clawtrate, what your person sees here, and what you can do in Clawtrate. Call it when asked where you are or what you can do.",
  clawtrate_tasks:
    "Your tasks in Clawtrate and the ones you started, each with its state: working, waiting for your person, done or failed.",
  clawtrate_bots:
    "The other bots you can hand work to in Clawtrate. Pass `find` with the name your person used to get just that bot.",
});

/** Cuts an answer to the bound, on a line, saying so. */
export function bounded(text) {
  if (Buffer.byteLength(text) <= ANSWER_MAX_BYTES) return text;
  const note = "\n(Cut to fit; ask for less.)";
  let cut = text.slice(0, ANSWER_MAX_BYTES - note.length);
  while (Buffer.byteLength(cut) > ANSWER_MAX_BYTES - note.length) cut = cut.slice(0, -64);
  return cut.slice(0, Math.max(0, cut.lastIndexOf("\n"))) + note;
}

/** Text a bot or a person outside this conversation wrote, quoted on one line. */
const quoted = (value, max = 80) => {
  const flat = String(value).replace(/\s+/g, " ").trim();
  return `«${flat.length > max ? `${flat.slice(0, max - 1)}…` : flat}»`;
};

/** Where this run came from, in words the bot can repeat: never "yes" from the plugin alone. */
export function whereLine(origin) {
  switch (origin.kind) {
    case "typed":
      return "In Clawtrate: can't tell yet. This message came through the gateway's own chat, which Clawtrate uses, but so do the gateway's own web page and other apps, and Clawtrate hasn't confirmed it sent it. Don't tell your person you're in Clawtrate as a fact.";
    case "chat-app":
      return `In Clawtrate: no. This message came from a chat app (${origin.channel ?? "unknown"}), ${origin.origin === "O" ? "from the gateway's owner" : "from someone the gateway doesn't count as its owner"}.`;
    case "bot-message":
      return "In Clawtrate: no. This run was started by a message from another bot, not by your person.";
    case "task":
      return "In Clawtrate: no. This run is a task's brief, written by the bot that started it, not by your person.";
    case "report":
      return "In Clawtrate: no. This run is a task reporting back.";
    case "routine":
      return "In Clawtrate: no. This run is one of your routines running on its schedule.";
    case "check-in":
      return "In Clawtrate: no. This run is one of your check-ins.";
    case "command-line":
      return "In Clawtrate: no. This message came from the gateway's command line.";
    default:
      return "In Clawtrate: can't tell. Clawtrate couldn't read where this run came from.";
  }
}

/** Whether anything read from outside already shapes this run, and from where. */
export function readLine(origin) {
  if (!origin.read) return "You haven't read anything from outside in this run.";
  return `You've read ${SOURCES[origin.read] ?? SOURCES.tool} in this run, so Clawtrate won't count what you change now as your person's ask.`;
}

/**
 * clawtrate_here: where this is, this conversation, the bot as Clawtrate shows
 * it, and what changes do from here. `holds` is the list of what each kind of
 * change does for this run's origin, in words, once the holds are in.
 * It returns no text a bot wrote (no name, no title): until Clawtrate's record
 * of who set each field exists, the plugin can't tell the person's from a
 * bot's (4.3), so nothing here is outside content.
 */
export function hereAnswer({ origin, session, bot, holds = [] }) {
  const lines = [whereLine(origin), readLine(origin), ""];
  lines.push(
    session.kind === "main"
      ? "This conversation: your main conversation."
      : `This conversation: a task${session.startedBy ? `, started by ${session.startedBy}` : ""}.`,
  );
  lines.push(
    "What your person sees in Clawtrate: your tasks listed under your name, each task's work as it happens, files and pictures you hand over, and a line for each change you make.",
    "",
    `You: model ${bot.model ?? "the gateway's default"}; effort ${bot.effort ?? "the gateway's default"}; you run commands ${bot.commands}; check-ins ${bot.checkIns}.`,
  );
  if (holds.length > 0)
    lines.push("", "What a change does from here:", ...holds.map((h) => `- ${h}`));
  return bounded(lines.join("\n"));
}

/** One task's line: what the person sees in its row. */
function taskLine(task) {
  const state = task.state ?? "state unknown";
  const by = task.startedBy ? `, started by ${task.startedBy}` : "";
  const when = task.lastActivityAt
    ? `, last active ${new Date(task.lastActivityAt).toISOString()}`
    : "";
  return `- ${task.title ? quoted(task.title) : "(untitled)"}: ${state}${by}${when}`;
}

/**
 * clawtrate_tasks: the bot's own tasks and the ones it started. Clawtrate's
 * own "waiting for you" isn't known to the plugin yet, so each state is the
 * gateway's, and the answer says that. A title is outside content unless the
 * person typed it, which the plugin can't tell yet (4.3): `outside` says
 * whether the answer holds any.
 */
export function tasksAnswer({ tasks, limit, state }) {
  const matching = state ? tasks.filter((t) => t.state === state) : tasks;
  const shown = matching.slice(0, limit);
  const outside = shown.some((t) => t.title);
  const lines = [
    shown.length === 0
      ? `You have no tasks${state ? ` that are ${state}` : ""}.`
      : `Your tasks, newest first (${shown.length} of ${matching.length}):`,
    ...shown.map(taskLine),
    "",
    "States are the gateway's: working, done or failed. Whether one is waiting for your person shows in Clawtrate, not here yet.",
  ];
  return { text: bounded(lines.join("\n")), outside };
}

/** A name as `find` compares it: spaces collapsed, without case. */
export const nameKey = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/**
 * clawtrate_bots: the other bots, by id, whether this bot can reach each now,
 * and the account each runs on. With `find`, only the bots whose current name
 * is that name, and no name text, so nothing it returns is outside content.
 * Without it, every bot with its name, which may be one a bot chose (4.3):
 * `outside` says so.
 */
export function botsAnswer({ bots, find }) {
  const wanted = find === undefined ? null : nameKey(find);
  const shown = wanted === null ? bots : bots.filter((b) => nameKey(b.name ?? b.id) === wanted);
  if (shown.length === 0)
    return {
      text:
        wanted === null
          ? "There are no other bots to hand work to."
          : "No bot has that name. Ask your person which bot they mean.",
      outside: false,
    };
  const lines = [wanted === null ? "Other bots:" : "Bots with that name:"];
  for (const b of shown)
    lines.push(
      `- id ${b.id}${wanted === null && b.name ? `, called ${quoted(b.name, 40)}` : ""}; ${b.inReach ? "you can hand work to it" : "you can hand work to it once your person asks you to"}; runs on ${b.account ?? "its own account"}`,
    );
  if (wanted !== null)
    lines.push("", "Whether that name is one your person gave it shows in Clawtrate.");
  return { text: bounded(lines.join("\n")), outside: wanted === null && shown.some((b) => b.name) };
}

/** A read tool's `limit`, checked: 1 to 50, default 20. */
export function readLimit(value) {
  if (value === undefined || value === null) return TASKS_LIMIT.default;
  if (!Number.isInteger(value) || value < 1 || value > TASKS_LIMIT.max)
    throw new Error(`limit must be a whole number from 1 to ${TASKS_LIMIT.max}.`);
  return value;
}
