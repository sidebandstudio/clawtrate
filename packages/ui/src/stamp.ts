// The stamp a screen's write carries back (`GatewayStamp`): the host's target the screen was read
// under, and the gateway's identity on that target. Right after a connect the identity is not
// read yet; a write made then waits for it rather than going without one, which the host refuses.

import type { ClawtrateBridge, GatewayStamp } from "@clawtrate/core";

/** How long a write waits for the gateway to name itself before it is sent without its name. */
export const IDENTITY_WAIT_MS = 15_000;

/**
 * Where a screen read at `target` was read: the gateway's identity once the host has it on that
 * target. When the target moves on first, the stamp keeps the screen's, and the host refuses it.
 */
export function screenStamp(
  bridge: Pick<ClawtrateBridge, "getState" | "subscribe">,
  target: number,
  waitMs = IDENTITY_WAIT_MS,
): Promise<GatewayStamp> {
  const settled = () => {
    const connection = bridge.getState().connection;
    return connection.gatewayId !== null || connection.target !== target
      ? { gatewayId: connection.target === target ? connection.gatewayId : null, target }
      : null;
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
