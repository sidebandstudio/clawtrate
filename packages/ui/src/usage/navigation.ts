// A request to show a bot's Usage page, from outside the Work pane: the
// composer's "Raise budget" opens the pane's Settings tab on that page, with
// the budget form open. The shell registers how it opens the pane; the tab
// shows the newest request it has not shown yet.

import { useSyncExternalStore } from "react";

export type UsageRequest = { botId: string; form: boolean; seq: number };

let request: UsageRequest | null = null;
let seq = 0;
let opener: (() => void) | null = null;
const listeners = new Set<() => void>();

export function requestUsagePage(botId: string, form: boolean): void {
  seq += 1;
  request = { botId, form, seq };
  opener?.();
  for (const listener of listeners) listener();
}

/** Forget a request once its page has opened, so a later mount does not open it again. */
export function settleUsageRequest(done: UsageRequest): void {
  if (request?.seq !== done.seq) return;
  request = null;
  for (const listener of listeners) listener();
}

/** How the shell opens the Work pane on its Settings tab; returns the way to forget it. */
export function setUsageOpener(open: () => void): () => void {
  opener = open;
  return () => {
    if (opener === open) opener = null;
  };
}

export function useUsageRequest(): UsageRequest | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => request,
  );
}
