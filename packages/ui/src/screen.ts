import type { ClawtrateState } from "@clawtrate/core";

/**
 * Which screen to show. Once there is anything to read, the shell stays up
 * through every reconnect, failure and retry; only a new pairing request or a
 * first connection with nothing loaded shows the connection screen.
 */
export function screenFor(state: ClawtrateState): "connect" | "shell" {
  const { status } = state.connection;
  if (status === "pairing") return "connect";
  if (state.bots.length > 0) return "shell";
  return status === "connected" ? "shell" : "connect";
}
