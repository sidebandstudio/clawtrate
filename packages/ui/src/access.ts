import type { ConnectionState } from "@clawtrate/core";

/**
 * May this connection write: send a message, create a task? It decides the
 * composer's form and every "New" control. The client asks for `operator.read`
 * only and the bridge has no command that writes, so the answer is no until a
 * flow adds sending; then it checks the granted scopes and the host's commands.
 */
export function canWrite(_connection: ConnectionState): boolean {
  return false;
}
