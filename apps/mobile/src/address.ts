import type { BridgeCommand, ConnectionState } from "@clawtrate/core";

export function addressAttemptInProgress(connection: ConnectionState): boolean {
  return (
    (connection.status === "connecting" || connection.status === "reconnecting") &&
    connection.retryAt === null
  );
}

export function addressSubmission(
  saved: string | null,
  editedUrl: string | null,
  token: string,
): Extract<BridgeCommand, { type: "connect" | "retry" }> | null {
  const url = editedUrl?.trim() ?? saved;
  if (!url) return null;
  if (url === saved && !token) return { type: "retry" };
  return { type: "connect", url, token: token || null };
}
