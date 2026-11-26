// A request to show part of a bot's settings from outside the Work pane: "Change model" and
// "Change account" under a message the gateway couldn't run (#663) open the pane's Settings tab
// on the bot's model or its account. The shell registers how it opens the pane; the tab shows the
// newest request it has not shown yet, as `usage/navigation.ts` does for the Usage page.

import { useSyncExternalStore } from "react";

export type BotSettingsPart = "model" | "account";
export type BotSettingsRequest = { botId: string; part: BotSettingsPart; seq: number };

let request: BotSettingsRequest | null = null;
let seq = 0;
let opener: (() => void) | null = null;
const listeners = new Set<() => void>();

export function requestBotSettings(botId: string, part: BotSettingsPart): void {
  seq += 1;
  request = { botId, part, seq };
  opener?.();
  for (const listener of listeners) listener();
}

/** Forget a request once its part is shown, so a later mount does not show it again. */
export function settleBotSettingsRequest(done: BotSettingsRequest): void {
  if (request?.seq !== done.seq) return;
  request = null;
  for (const listener of listeners) listener();
}

/** How the shell opens the Work pane on its Settings tab; returns the way to forget it. */
export function setBotSettingsOpener(open: () => void): () => void {
  opener = open;
  return () => {
    if (opener === open) opener = null;
  };
}

export function useBotSettingsRequest(): BotSettingsRequest | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => request,
  );
}
