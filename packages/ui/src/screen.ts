import type { ClawtrateState } from "@clawtrate/core";

/**
 * Which screen to show. Once there is anything to read, the shell stays up
 * through every reconnect, failure and retry; only a new pairing request or a
 * first connection with nothing loaded shows the connection screen.
 */
export function screenFor(state: ClawtrateState): "connect" | "shell" {
  const { status, error } = state.connection;
  if (status === "pairing") return "connect";
  // A gateway on another protocol gets a full-window notice, whatever is cached.
  if (error?.code === "PROTOCOL_MISMATCH") return "connect";
  if (state.bots.length > 0) return "shell";
  // The setup steps stay until the bots have loaded; then the app opens.
  if (status === "connected" && state.discovery.status === "loading") return "connect";
  return status === "connected" ? "shell" : "connect";
}
