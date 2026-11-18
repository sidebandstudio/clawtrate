// What the composer's "/" and "@" menus list (parity F-071, F-070), read from
// the gateway when a menu opens and kept nowhere: the answer goes to the
// viewer that asked, and nothing of it stays in the state.
//
// "/" lists the bot's skills a person may invoke (`skills.status {agentId}`,
// `userInvocable` and `eligible`), tagged Skill, and the gateway's slash
// commands that are not those skills (`chat.metadata` `commands`), tagged
// Action. Choosing one inserts its text alias, sent with the message as
// `chat.send` `message` text: the gateway runs a command or skill named that
// way (`/weather`, `/skill <name>`).
//
// "@" lists the gateway's bots (`agents.list`, already in the state) and its
// routines (`cron.list`). OpenClaw's structured `chat.send` `mentions` are
// human profiles only, so a bot or routine is inserted as text ("@Marlow").

import { asRecord, type RawRecord } from "./mapping.ts";

/** One row of a composer menu. */
export type MenuRow = {
  kind: "skill" | "action" | "bot" | "routine";
  /** What the row shows. */
  name: string;
  description: string | null;
  /** The text the row puts in the message when chosen, a space after it. */
  insert: string;
};

/** The most rows one menu answer carries, and the longest description, so it fits one frame. */
export const MAX_MENU_ROWS = 200;
const MAX_DESCRIPTION_CHARS = 160;
const MAX_NAME_CHARS = 120;

const cut = (text: string | null, max: number) =>
  text === null ? null : text.length > max ? `${text.slice(0, max - 1)}…` : text;
const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** The "/" menu from `skills.status` and `chat.metadata` answers. */
export function slashRows(skillsAnswer: unknown, metadataAnswer: unknown): MenuRow[] {
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
  const rows: MenuRow[] = [];
  const skillCommands = new Set<string>();
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
    if (!insert) continue;
    rows.push({
      kind: "action",
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
    if (!name) continue;
    rows.push({
      kind: "routine",
      name: cut(name, MAX_NAME_CHARS)!,
      description: job.enabled === false ? "Paused" : null,
      insert: `@${name}`,
    });
  }
  return rows.slice(0, MAX_MENU_ROWS);
}
