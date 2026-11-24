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

/**
 * The endpoint an address dials, whatever its spelling: the host in lower case without a
 * trailing dot, the port (a default one written out), the path and the query. The scheme
 * isn't part of it, so `ws://` and `wss://` to one host and port are one gateway. Null for
 * an address a Connect refuses.
 */
export function gatewayEndpoint(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(validateGatewayUrl(raw));
  } catch {
    return null;
  }
  const port = url.port || (url.protocol === "wss:" ? "443" : "80");
  const path = url.pathname.replace(/\/$/, "");
  return `${url.hostname.toLowerCase().replace(/\.$/, "")}:${port}${path}${url.search}`;
}

/**
 * The other spellings of this address's endpoint (`gatewayEndpoint`) a pairing may be saved
 * under: either scheme, with or without a trailing dot, each as a Connect saves it.
 */
export function endpointSpellings(raw: string): string[] {
  const own = validateGatewayUrl(raw);
  // An address normalizing would change again (a query ending in `/`) names no other spelling:
  // the spellings built from it would drop a character the dialled address keeps.
  if (own !== raw.trim()) return [];
  const endpoint = gatewayEndpoint(own);
  const url = new URL(own);
  const host = url.hostname.replace(/\.$/, "");
  const port = url.port || (url.protocol === "wss:" ? "443" : "80");
  const spellings = new Set<string>();
  for (const scheme of ["wss:", "ws:"])
    for (const name of [host, `${host}.`]) {
      try {
        const each = validateGatewayUrl(`${scheme}//${name}:${port}${url.pathname}${url.search}`);
        // The same query as dialled, character for character, and the same endpoint.
        if (each !== own && new URL(each).search === url.search && gatewayEndpoint(each) === endpoint)
          spellings.add(each);
      } catch {
        // A name that can't take a trailing dot (an IP address) has no such spelling.
      }
    }
  return [...spellings];
}
