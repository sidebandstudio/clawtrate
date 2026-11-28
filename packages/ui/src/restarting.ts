// What Clawtrate says while OpenClaw restarts (#913): one phrase, wherever the connection's state
// is said, for as long as core keeps `connection.restart` (the gateway announced a restart, or a
// write of this app's restarts it; at most `RESTART_WAIT_MS`). After that the connection reads as
// lost, with what to do, as any other. An update this app follows says its own words instead
// (`bots/update-words.ts`): a restart is one of its steps.

import type { ConnectionState } from "@clawtrate/core";

/** The phrase, where a state stands on its own: the strip, the footer, Settings. */
export const RESTARTING_WORDS = "Restarting OpenClaw…";
/** The same at the start of a sentence: the run line, the composer, what is announced. */
export const RESTARTING_LEAD = "Restarting OpenClaw";

/** The gateway is restarting while the connection is up or coming back by itself. */
export function restartingNow(connection: Pick<ConnectionState, "status" | "restart">): boolean {
  return (
    connection.restart != null &&
    (connection.status === "connected" ||
      connection.status === "connecting" ||
      connection.status === "reconnecting")
  );
}

/**
 * What the conversation's one live region says of the connection, spoken when it changes: an
 * update's words while one is followed (`updatingWords`), the restart, or the plain state.
 */
export function connectionHeard(
  connection: Pick<ConnectionState, "status" | "restart">,
  updatingWords: string | null,
): string | null {
  if (connection.status === "connected") return "Connected";
  if (connection.status !== "reconnecting") return null;
  return updatingWords ?? (restartingNow(connection) ? RESTARTING_LEAD : "Reconnecting");
}
