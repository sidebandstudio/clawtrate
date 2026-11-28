// A bot's main conversation (docs/design/bot-opens-main.md): what a click on the bot opens, and
// not one of the tasks listed under it. The gateway's own main session for the bot: the row it
// marks main (`isMain`, `classification: "main"`), else the key `agent:<bot>:main`.
//
// Run on development gateways of OpenClaw 2026.10.6 and 2026.11.10: a bot that has no main
// session yet reads at that key as an empty history marked main, subscribing to it makes nothing,
// and the person's first `chat.send` there makes it. With `session.scope: "global"` the gateway
// files it under `global` for that bot and lists no row for it, while `agent:<bot>:main` still
// reads and sends there; so the key is right in both scopes.

import { mapSessionRow } from "./mapping.ts";
import { mainTaskKey } from "./task-actions.ts";
import type { Task } from "./types.ts";

/** The key of `botId`'s main conversation: the listed row the gateway marks main, else its own key. */
export function botMainConversationKey(botId: string, tasks: readonly Task[] | undefined): string {
  return (
    tasks?.find((task) => task.isMain === true && task.botId === botId)?.key ?? mainTaskKey(botId)
  );
}

/** The tasks listed under a bot: every one but its main conversation, in the order given. */
export function tasksUnderBot<T extends { isMain?: boolean }>(tasks: readonly T[]): T[] {
  return tasks.filter((task) => task.isMain !== true);
}

/**
 * `botId`'s main conversation: its listed row, or, for a bot the gateway lists none for yet, a
 * stand-in at its key, empty until the person's first message makes it. Nothing is written to
 * open it.
 */
export function botMainConversation(botId: string, tasks: readonly Task[] | undefined): Task {
  const listed = tasks?.find((task) => task.isMain === true && task.botId === botId);
  if (listed) return listed;
  return mapSessionRow({ key: mainTaskKey(botId), agentId: botId, isMain: true })!;
}
