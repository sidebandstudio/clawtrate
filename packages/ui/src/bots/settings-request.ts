// A request to show part of a bot's settings from outside the Work pane: "Change model" and
// "Change account" under a message the gateway couldn't run (#663) open the pane's Settings tab
// on the bot's model or its account. The shell registers how it opens the pane; the tab shows the
// newest request it has not shown yet, as `usage/navigation.ts` does for the Usage page.

import { useSyncExternalStore } from "react";

export type BotSettingsPart = "model" | "account" | "connect";
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

/** What a control on the settings page is, for a request: there and usable, there and disabled. */
export type ControlState = "usable" | "disabled" | null;

/**
 * Whether the settings page of `botId`, as drawn, settles `request`, and where focus goes: null
 * while it doesn't (another bot's page, or its page not drawn yet). Focus goes to the control when
 * it can take it, else to the Account page's heading; the first page has no heading to take it (a
 * default-model binding has no model menu, and below admin the menu is disabled), so there the
 * request settles with focus left where it is.
 */
export function settlement(
  request: BotSettingsRequest,
  botId: string,
  control: (selector: string) => ControlState,
): { focus: string | null } | null {
  if (request.botId !== botId) return null;
  const usable = (selector: string) => (control(selector) === "usable" ? selector : null);
  if (request.part === "connect") {
    const focus = usable("[data-bs-connect]");
    return focus ? { focus } : null;
  }
  const focus =
    request.part === "account"
      ? (usable("[data-bs='change']") ?? usable("[data-bs-focus]"))
      : usable('[data-testid="model-select"]');
  const drawn =
    request.part === "account" ? focus !== null : control("[data-bs='account']") !== null;
  return drawn ? { focus } : null;
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
