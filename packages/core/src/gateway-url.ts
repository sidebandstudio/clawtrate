import { jsonTextLength } from "./bounds.ts";

/** A normalized address must fit whole in state, Connect, and Forget, including after restart. */
export const MAX_GATEWAY_URL_CHARS = 65_536;

export function validateGatewayUrl(raw: string): string {
  const url = new URL(raw.trim());
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("The gateway URL must start with ws:// or wss://");
  }
  const address = url.toString().replace(/\/$/, "");
  if (jsonTextLength(address) > MAX_GATEWAY_URL_CHARS)
    throw new Error("The gateway address is too long.");
  return address;
}
