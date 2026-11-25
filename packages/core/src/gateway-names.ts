// Names the person gives gateways on this device (docs/design/titlebar.md,
// section 4). They live in the host's storage beside the saved connection,
// keyed by the gateway's address, and are never sent to a gateway.

/** The host storage key. */
export const GATEWAY_NAMES_KEY = "gateway-names";
export const MAX_GATEWAY_NAME_CHARS = 40;
/** Names kept; past this the oldest is dropped. */
export const MAX_GATEWAY_NAMES = 32;
/** The longest address a name can be given to. Real gateway addresses are far shorter. */
export const MAX_NAMED_ADDRESS_CHARS = 2048;

/** Oldest first. */
export type GatewayNames = ReadonlyArray<{ address: string; name: string }>;

/**
 * The address a name belongs to: scheme, host and port, and path without a
 * trailing slash. `URL` lowercases the host and drops a scheme's default port.
 */
export function gatewayAddress(url: string): string | null {
  try {
    const parsed = new URL(url);
    const address = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
    return address.length <= MAX_NAMED_ADDRESS_CHARS ? address : null;
  } catch {
    return null;
  }
}

/**
 * Text from elsewhere, a gateway or a bot, as one plain line of at most `max` characters: control
 * and format characters (bidirectional overrides and isolates, zero-width characters) and lone
 * surrogates become a space, runs of space one space, trimmed. Empty means none. A lone surrogate
 * goes with the control characters: it would escape to six JSON characters, past the two per
 * character the host's worst case allows (`owners.ts`).
 */
export function cleanLine(raw: string, max: number): string {
  const line = raw
    .replace(/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [...line].slice(0, max).join("").trim();
}

/** A gateway's name: one line, trimmed, at most `MAX_GATEWAY_NAME_CHARS` characters. Empty means no name. */
export function cleanGatewayName(raw: string): string {
  return cleanLine(raw, MAX_GATEWAY_NAME_CHARS);
}

/** What storage holds, read leniently: anything unreadable is no names. */
export function readGatewayNames(raw: string | null): GatewayNames {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const names: { address: string; name: string }[] = [];
  for (const entry of parsed) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "string")
      continue;
    const address = gatewayAddress(entry[0]);
    const name = cleanGatewayName(entry[1]);
    if (!address || !name) continue;
    const at = names.findIndex((each) => each.address === address);
    if (at >= 0) names.splice(at, 1);
    names.push({ address, name });
  }
  return names.slice(-MAX_GATEWAY_NAMES);
}

export function writeGatewayNames(names: GatewayNames): string {
  return JSON.stringify(names.map(({ address, name }) => [address, name]));
}

/** `names` with `url`'s name set, newest last, or removed when `name` cleans to nothing. */
export function withGatewayName(names: GatewayNames, url: string, name: string): GatewayNames {
  const address = gatewayAddress(url);
  if (!address) throw new Error("This gateway's address can't be named.");
  const clean = cleanGatewayName(name);
  const rest = names.filter((each) => each.address !== address);
  return (clean ? [...rest, { address, name: clean }] : rest).slice(-MAX_GATEWAY_NAMES);
}

export function gatewayNameFor(names: GatewayNames, url: string | null): string | null {
  const address = url === null ? null : gatewayAddress(url);
  return (address && names.find((each) => each.address === address)?.name) || null;
}
