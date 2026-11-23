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

/**
 * Whether a first pairing at this address may ask for full control: a `wss://` address that
 * isn't loopback (docs/design/setup-effortless.md §4). A loopback socket needs the send gate
 * of §3, which isn't built yet, and plain `ws://` would carry the credential unencrypted, so
 * either asks for read access as before. A malformed address is never protected.
 */
export function protectedGatewayUrl(raw: string): boolean {
  // Any `#`, an empty fragment included: normalizing can turn `#/` into an empty fragment, and
  // the form and the client must agree on the address typed and the address saved.
  if (raw.includes("#")) return false;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "wss:") return false;
  // An address with a user name, password or fragment can't be used (§4).
  if (url.username || url.password || url.hash) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "" || host === "localhost" || host.endsWith(".localhost")) return false;
  // The URL parser writes every IPv4 form (decimal, hex, short) as a dotted quad.
  if (/^(127|0)\.\d+\.\d+\.\d+$/.test(host)) return false;
  // IPv6 loopback and unspecified, and IPv4-mapped loopback, as the parser writes them.
  if (/^\[(::1?|::ffff:(7f[0-9a-f]{2}|0{1,4}):[0-9a-f]{1,4})\]$/.test(host)) return false;
  return true;
}
