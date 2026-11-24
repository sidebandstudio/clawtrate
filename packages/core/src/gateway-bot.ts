// The gateway's own bot: the one `agents.list` names as its `defaultId` (`Bot.isDefault`, the
// same test the rename card uses to leave it alone), unless the gateway reports
// `selectionRequired`: then it names no owner, `defaultId` is only its first bot, and no bot is
// the gateway's own (`Bot.ownerless`). Whatever reaches the gateway without naming
// a bot lands on it: channel messages, other tools' calls, scheduled runs. So while another bot
// exists it stays out of the lists a person picks a bot from, unless "Show the gateway's own bot"
// is on (F-562). Only what the app shows changes; on the gateway it keeps running.

import type { Bot, ClawtrateState, Task } from "./types.ts";

/** What decides which bots and tasks the person sees. */
export type ListedFrom = Pick<ClawtrateState, "bots" | "tasksByBot"> & {
  showGatewayBot?: boolean | undefined;
};

/**
 * Whether `bot` is out of view by the rule alone, waiting aside: it is the gateway's own, another
 * bot exists, and "Show the gateway's own bot" is off.
 */
export function gatewayBotHidden(bot: Bot, bots: readonly Bot[], show: boolean): boolean {
  return !show && bot.isDefault && bot.ownerless !== true && bots.length > 1;
}

/**
 * Whether the bot is left out now: by the rule, with nothing of its own waiting on the person, and
 * not the one the person keeps open (`kept`).
 */
function leftOut(bot: Bot, state: ListedFrom, kept: string | null): boolean {
  return (
    bot.id !== kept &&
    gatewayBotHidden(bot, state.bots, state.showGatewayBot === true) &&
    // Own keys only: a bot id such as "constructor" names no inherited value.
    !(Object.hasOwn(state.tasksByBot, bot.id) ? state.tasksByBot[bot.id]! : []).some(
      (task) => task.status === "waiting",
    )
  );
}

/**
 * The bots a person sees and picks from, in the gateway's order: the sidebar, Hidden bots, both
 * searches and every list for choosing a bot read this. The gateway's own bot comes back while
 * one of its tasks waits on the person (an approval or a question), as a hidden channel chat
 * does, so nothing it asks is out of sight. `kept` is the gateway's own bot when the person has it
 * open and keeps it: it stays listed until they open another bot.
 */
export function listedBots(state: ListedFrom, kept: string | null = null): Bot[] {
  return state.bots.filter((bot) => !leftOut(bot, state, kept));
}

/**
 * The tasks of the bots the person sees, from `tasksByBot`: every count (the dock badge) and
 * every search over tasks reads this, so none counts or finds a task of a bot out of view.
 */
export function listedTasks(state: ListedFrom, kept: string | null = null): Record<string, Task[]> {
  const out = state.bots.filter((bot) => leftOut(bot, state, kept)).map((bot) => bot.id);
  if (out.length === 0) return state.tasksByBot;
  const tasks = { ...state.tasksByBot };
  for (const id of out) delete tasks[id];
  return tasks;
}
