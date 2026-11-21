// Forgetting the gateway the person sees: the address goes with the command, so
// a view that is out of date never forgets the gateway another view chose since.
import { GATEWAY_CHANGED_MESSAGE } from "@clawtrate/core";
import { useCallback, useState } from "react";
import { useCommand } from "./bridge.tsx";

/** What a forget that was refused says. */
export function forgetFailure(failure: unknown): string {
  // The host's own wording can wrap the core's message, so it is looked for, not compared.
  const message = failure instanceof Error ? failure.message : String(failure);
  return message.includes(GATEWAY_CHANGED_MESSAGE)
    ? GATEWAY_CHANGED_MESSAGE
    : "Could not forget this gateway.";
}

/** Forget a gateway by the address shown; `failure` says why the last try did not. */
export function useForget() {
  const send = useCommand();
  const [failure, setFailure] = useState<string | null>(null);
  /** Resolves true once the gateway is forgotten, false when it was not. */
  const forget = useCallback(
    (gatewayUrl: string) => {
      setFailure(null);
      return send({ type: "disconnect", gatewayUrl }).then(
        () => true,
        (error: unknown) => {
          setFailure(forgetFailure(error));
          return false;
        },
      );
    },
    [send],
  );
  return { forget, failure };
}
