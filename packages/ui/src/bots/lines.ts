// The grey lines Clawtrate draws in a task from its own changes to a bot's
// account (docs/design/bots.md, section 11). The gateway records no such line.

import type { AccountsState, Bot, Task } from "@clawtrate/core";
import type { EventLine } from "../Conversation.tsx";
import { changeLine } from "./words.ts";

/** The lines for the open task: each change made while it was open for its bot. */
export function accountLines(
  accounts: AccountsState,
  task: Task | null,
  bots: readonly Bot[],
): EventLine[] {
  if (!task) return [];
  return accounts.changes
    .filter((change) => change.taskKey === task.key)
    .map((change, index) => ({
      key: `account-change-${change.at}-${index}`,
      at: change.at,
      text: changeLine(
        change,
        accounts,
        bots.find((bot) => bot.id === change.botId)?.name ?? change.botId,
      ),
    }));
}
