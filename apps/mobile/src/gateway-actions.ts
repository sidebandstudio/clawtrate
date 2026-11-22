import type { BridgeCommand } from "@clawtrate/core";

type Send = (command: Extract<BridgeCommand, { type: "retry" | "disconnect" }>) => Promise<unknown>;

export async function checkPairing(send: Send): Promise<"checked" | "failed"> {
  try {
    await send({ type: "retry" });
    return "checked";
  } catch {
    return "failed";
  }
}

export async function forgetGateway(
  send: Send,
  gatewayUrl: string | null,
  onForgotten: () => void,
): Promise<boolean> {
  try {
    if (gatewayUrl !== null) await send({ type: "disconnect", gatewayUrl });
  } catch {
    return false;
  }
  onForgotten();
  return true;
}
