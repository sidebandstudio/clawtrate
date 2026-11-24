// The stamp a screen's write carries back (`GatewayStamp`): the gateway's identity and the host's
// target when the screen was drawn. Right after a connect the identity is not read yet; a write
// from a screen drawn then waits for it, on the connection the screen was drawn on, rather than
// going without one, which the host refuses.

import type { ConnectionState, GatewayStamp } from "@clawtrate/core";

/** How long a write waits for the gateway to name itself before it is sent without its name. */
export const IDENTITY_WAIT_MS = 15_000;

/** Where a screen was drawn: its stamp, and the connection (its hello) it was drawn on. */
export type ShownStamp = GatewayStamp & { connectedAt: number | null };

/** The stamp of a screen drawn on the connection as it is now. */
export const shownStamp = (
  connection: Pick<ConnectionState, "gatewayId" | "target" | "connectedAt">,
): ShownStamp => ({
  gatewayId: connection.gatewayId,
  target: connection.target,
  connectedAt: connection.connectedAt,
});

type StateSource = {
  getState(): { connection: ConnectionState };
  subscribe(listener: (state: { connection: ConnectionState }) => void): () => void;
};

/**
 * The stamp a write from a screen drawn at `shown` sends. A screen that knew its gateway sends
 * that, as drawn, whatever is connected now: the host compares it with the gateway it has. A
 * screen drawn before the gateway named itself waits for the name on the connection it was
 * drawn on; once the target or the connection has moved on, it sends no name, and the host
 * refuses it.
 */
export function screenStamp(
  bridge: StateSource,
  shown: ShownStamp,
  waitMs = IDENTITY_WAIT_MS,
): Promise<GatewayStamp> {
  const { gatewayId, target } = shown;
  if (gatewayId !== null) return Promise.resolve({ gatewayId, target });
  const settled = (): GatewayStamp | null => {
    const connection = bridge.getState().connection;
    if (connection.target !== target || connection.connectedAt !== shown.connectedAt)
      return { gatewayId: null, target };
    return connection.gatewayId !== null ? { gatewayId: connection.gatewayId, target } : null;
  };
  const now = settled();
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = () => {};
    const finish = (stamp: GatewayStamp) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(stamp);
    };
    unsubscribe = bridge.subscribe(() => {
      const stamp = settled();
      if (stamp) finish(stamp);
    });
    // A bridge that calls a new listener at once may have settled it already.
    if (done) unsubscribe();
    else timer = setTimeout(() => finish({ gatewayId: null, target }), waitMs);
  });
}
