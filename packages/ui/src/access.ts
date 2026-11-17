import type { ConnectionState, HostInfo } from "@clawtrate/core";

/**
 * May this connection write: send, stop, answer, create? It decides the
 * composer's form, Stop and every "New" control (conversation.md, section 3).
 * The interactive tier is the gateway's grant of `operator.write`; approving
 * and answering have scopes of their own and never stand in for it. While
 * the connection is down, the scopes this device means to hold decide, so the
 * composer keeps its place in its offline form instead of the access bar. A
 * host started read-only never writes.
 */
export function canWrite(connection: ConnectionState, info?: Pick<HostInfo, "readOnly">): boolean {
  if (info?.readOnly) return false;
  if (connection.status === "connected") return connection.canWrite;
  return connection.requestedScopes.includes("operator.write");
}
