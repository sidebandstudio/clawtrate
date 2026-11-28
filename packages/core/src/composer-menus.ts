// What the composer's "/" and "@" menus list (parity F-071, F-070), read from
// the gateway when a menu opens and kept nowhere: the answer goes to the
// viewer that asked, and nothing of it stays in the state.
//
// "/" lists the skills from the gateway's skill library that the task has
// (`skills.library.list {sessionKey}` `session.selections`): the person's own,
// tagged Your skill, and the others, tagged Team skill. Then the bot's skills a
// person may invoke (`skills.status {agentId}`, `userInvocable` and
// `eligible`), tagged Bot skill, and the gateway's slash commands that are not
// those skills (`chat.metadata` `commands`), tagged Command. Choosing one
// inserts its text alias, sent with the message as `chat.send` `message` text:
// the gateway runs a command or skill named that way (`/weather`, `/skill
// <name>`). No app's action is listed: the gateway lists apps' actions
// separately (`mcp.app.discover`), which this does not read.
//
// Neither `skills.status` nor `chat.metadata` lists a library skill, on
// OpenClaw 2026.10.6 or 2026.11.10. A library skill runs only in a task that
// has it, by its generated command name (`/skill s_tide_tabl_…`), never by its
// slug; a task has the library's enabled skills from when it started. A skill
// saved later is in the task's `session.attachable` only: "/" offers the
// person's own of those to a connection that holds `operator.write`, and
// choosing one attaches it to the task first (`skills.library.activate`).
//
// "@" lists the gateway's bots (`agents.list`, already in the state) and its
// routines (`cron.list`). OpenClaw's structured `chat.send` `mentions` are
// human profiles only, so a bot or routine is inserted as text ("@Marlow").

import { asRecord, type RawRecord } from "./mapping.ts";

/** One row of a composer menu. */
export type MenuRow = {
  /** `skill` is the bot's; `your-skill` and `team-skill` are from the gateway's skill library. */
  kind: "your-skill" | "team-skill" | "skill" | "command" | "bot" | "routine";
  /** What the row shows: a library skill's slug, which is not what runs it. */
  name: string;
  description: string | null;
  /** The text the row puts in the message when chosen, a space after it. */
  insert: string;
  /** The person's own library skill the task doesn't have yet: choosing it attaches it first. */
  attach?: { skillId: string; revision: string };
};

/** The most rows one menu answer carries, and the longest description, so it fits one frame. */
export const MAX_MENU_ROWS = 200;
const MAX_DESCRIPTION_CHARS = 160;
const MAX_NAME_CHARS = 120;
/** The longest text a row inserts. */
const MAX_INSERT_CHARS = 256;

const cut = (text: string | null, max: number) =>
  text === null ? null : text.length > max ? `${text.slice(0, max - 1)}…` : text;
const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** A library skill's generated command name (`s_<slug>_<id>`): one word, as `/skill` takes it. */
const COMMAND_NAME = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The task's library skills from a `skills.library.list {sessionKey}` answer, then, when
 * `canAttach`, the person's own enabled skills the task could attach. Whose a skill is comes from
 * the gateway alone: its `ownerProfileId` against the answer's own `profileId`, the profile this
 * connection acts for. A skill with no owner the answer can match is the team's.
 */
function libraryRows(libraryAnswer: unknown, canAttach: boolean): MenuRow[] {
  const answer = asRecord(libraryAnswer);
  const self = str(answer?.profileId);
  const session = asRecord(answer?.session);
  const row = (entry: unknown, attachable: boolean): MenuRow[] => {
    const skill = asRecord(entry);
    const command = str(skill?.name);
    if (!skill || !command || !COMMAND_NAME.test(command)) return [];
    const mine = self !== null && str(skill.ownerProfileId) === self;
    let attach: MenuRow["attach"];
    if (attachable) {
      const skillId = str(skill.skillId);
      const revision = str(skill.revision);
      if (!mine || skill.enabled !== true || skill.removed === true || !skillId || !revision)
        return [];
      attach = { skillId, revision };
    }
    return [
      {
        kind: mine ? "your-skill" : "team-skill",
        name: cut(str(skill.slug) ?? command, MAX_NAME_CHARS)!,
        description: cut(str(skill.description), MAX_DESCRIPTION_CHARS),
        insert: `/skill ${command}`,
        ...(attach ? { attach } : {}),
      },
    ];
  };
  const list = (value: unknown) => (Array.isArray(value) ? value : []);
  return [
    ...list(session?.selections).flatMap((entry) => row(entry, false)),
    ...(canAttach ? list(session?.attachable).flatMap((entry) => row(entry, true)) : []),
  ];
}

/**
 * The command that runs a skill `skills.library.activate` attached, from its answer: the task's
 * selections now, which must hold that skill at that revision. Null when they don't.
 */
export function attachedCommand(answer: unknown, skillId: string, revision: string): string | null {
  const selections = asRecord(answer)?.selections;
  for (const entry of Array.isArray(selections) ? selections : []) {
    const skill = asRecord(entry);
    const command = str(skill?.name);
    if (skill?.skillId === skillId && skill.revision === revision && command)
      return COMMAND_NAME.test(command) ? command : null;
  }
  return null;
}

/** Whether a `skills.library.activate` detach answer's selections leave that skill out. */
export function detached(answer: unknown, skillId: string): boolean {
  const selections = asRecord(answer)?.selections;
  return (
    Array.isArray(selections) && !selections.some((entry) => asRecord(entry)?.skillId === skillId)
  );
}

/**
 * The "/" menu from `skills.library.list`, `skills.status` and `chat.metadata` answers.
 * `canAttach`: the connection may attach a library skill to the task (`operator.write`).
 */
export function slashRows(
  skillsAnswer: unknown,
  metadataAnswer: unknown,
  libraryAnswer: unknown = null,
  canAttach = false,
): MenuRow[] {
  const commands = (
    Array.isArray(asRecord(metadataAnswer)?.commands) ? asRecord(metadataAnswer)!.commands : []
  ) as unknown[];
  const commandOf = new Map<string, RawRecord>();
  for (const entry of commands) {
    const command = asRecord(entry);
    const name = str(command?.name);
    if (command && name) commandOf.set(name, command);
  }
  const alias = (command: RawRecord | undefined) => {
    const aliases = Array.isArray(command?.textAliases) ? command.textAliases : [];
    return aliases.map(str).find((each): each is string => each?.startsWith("/") === true) ?? null;
  };
  const rows = libraryRows(libraryAnswer, canAttach);
  // A library skill's command, should the gateway list it, is that skill's row, not a Command.
  const skillCommands = new Set(rows.map((row) => row.insert.slice("/skill ".length)));
  const skills = (
    Array.isArray(asRecord(skillsAnswer)?.skills) ? asRecord(skillsAnswer)!.skills : []
  ) as unknown[];
  for (const entry of skills) {
    const skill = asRecord(entry);
    const name = str(skill?.name);
    if (!skill || !name || skill.userInvocable !== true || skill.eligible !== true) continue;
    if (skill.disabled === true) continue;
    // The gateway names a skill's command with its dashes as underscores.
    const commandName = name.replace(/-/g, "_");
    skillCommands.add(commandName);
    const insert = alias(commandOf.get(commandName)) ?? `/skill ${name}`;
    // A row is chosen by its text: one too long to keep whole is left out, never cut.
    if (insert.length > MAX_INSERT_CHARS) continue;
    rows.push({
      kind: "skill",
      name: cut(name, MAX_NAME_CHARS)!,
      description: cut(str(skill.description), MAX_DESCRIPTION_CHARS),
      insert,
    });
  }
  for (const [name, command] of commandOf) {
    if (skillCommands.has(name)) continue;
    const insert = alias(command);
    if (!insert || insert.length > MAX_INSERT_CHARS) continue;
    rows.push({
      kind: "command",
      name: cut(insert.slice(1), MAX_NAME_CHARS)!,
      description: cut(str(command.description), MAX_DESCRIPTION_CHARS),
      insert,
    });
  }
  return rows.slice(0, MAX_MENU_ROWS);
}

/** The "@" menu: the bots the state lists, then the routines a `cron.list` answer names. */
export function mentionRows(
  bots: Array<{ id: string; name: string }>,
  cronAnswer: unknown,
): MenuRow[] {
  const rows: MenuRow[] = bots.map((bot) => ({
    kind: "bot",
    name: cut(bot.name, MAX_NAME_CHARS)!,
    description: null,
    insert: `@${bot.name}`,
  }));
  const jobs = (
    Array.isArray(asRecord(cronAnswer)?.jobs) ? asRecord(cronAnswer)!.jobs : []
  ) as unknown[];
  for (const entry of jobs) {
    const job = asRecord(entry);
    // The gateway's own heartbeat is not a routine anyone made.
    if (!job || asRecord(job.payload)?.kind === "heartbeat") continue;
    const name = str(job.displayName) ?? str(job.name);
    if (!name || name.length + 1 > MAX_INSERT_CHARS) continue;
    rows.push({
      kind: "routine",
      name: cut(name, MAX_NAME_CHARS)!,
      description: job.enabled === false ? "Paused" : null,
      insert: `@${name}`,
    });
  }
  return rows.slice(0, MAX_MENU_ROWS);
}
