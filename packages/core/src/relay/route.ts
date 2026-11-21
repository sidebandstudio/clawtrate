// A relay route: the way to one gateway through Clawtrate's relay. The phone dials the relay,
// and the connector next to the gateway ends an end-to-end channel whose static key the phone
// pinned from a pairing code. The route's identity is that key, never the relay's address:
// whoever runs the relay can point an address anywhere, but cannot answer for the key.

import {
  canonicalRelayOrigin,
  fromBase64Url,
  isRelayId,
  KEY_BYTES,
  toBase64Url,
} from "@clawtrate/relay-protocol";

export type RelayRoute = {
  readonly kind: "relay";
  /** The relay's canonical origin, `wss://host[:port]`. */
  readonly relayOrigin: string;
  /** The connector's relay id: where the relay finds it. */
  readonly relayId: string;
  /** The connector's Noise static public key, base64url: who the phone talks to. */
  readonly connectorKey: string;
};

export type RelayRouteOptions = {
  /** Tests only: a `ws:` relay on this machine. */
  readonly allowLoopbackWs?: boolean;
};

/**
 * What the route's device token and its other per-route state are stored under. It names the
 * connector's key alone: a relay that moves keeps the route, and a relay address on its own
 * never reaches another connector's token.
 */
export function relayRouteKey(route: RelayRoute): string {
  return `relay:${route.connectorKey}`;
}

/** The relay address the phone dials for this route. */
export function relayDialUrl(route: RelayRoute): string {
  return `${route.relayOrigin}/v1/dial/${route.relayId}`;
}

/** The connector key's 32 bytes, or null if the text is not one canonical key. */
export function connectorKeyBytes(text: unknown): Uint8Array | null {
  if (typeof text !== "string" || text.length !== Math.ceil((KEY_BYTES * 4) / 3)) return null;
  const bytes = fromBase64Url(text);
  if (bytes === null || bytes.length !== KEY_BYTES || bytes.every((byte) => byte === 0)) {
    return null;
  }
  return bytes;
}

/**
 * Checks a route read back from storage or built by a caller: the exact fields, a canonical
 * origin, a canonical relay id and a canonical 32-byte key. Anything else throws.
 */
export function checkRelayRoute(value: unknown, options: RelayRouteOptions = {}): RelayRoute {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("A relay route is an object.");
  }
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "connectorKey,kind,relayId,relayOrigin") {
    throw new Error("A relay route has exactly kind, relayOrigin, relayId and connectorKey.");
  }
  const route = value as Record<string, unknown>;
  if (route.kind !== "relay") throw new Error("A relay route's kind is relay.");
  if (typeof route.relayOrigin !== "string" || !isCanonicalOrigin(route.relayOrigin, options)) {
    throw new Error("A relay route's origin is not canonical.");
  }
  if (!isRelayId(route.relayId)) throw new Error("A relay route's relay id is not canonical.");
  const key = connectorKeyBytes(route.connectorKey);
  if (key === null) throw new Error("A relay route's connector key is not a key.");
  return {
    kind: "relay",
    relayOrigin: route.relayOrigin,
    relayId: route.relayId,
    connectorKey: toBase64Url(key),
  };
}

export function isCanonicalOrigin(origin: string, options: RelayRouteOptions): boolean {
  try {
    return canonicalRelayOrigin(origin, options) === origin;
  } catch {
    return false;
  }
}

/**
 * The route's address, where core keeps a gateway's URL: the dial address with the connector
 * key as its fragment. Two relay routes through one relay to different connectors never share
 * an address, so whatever core compares by address it also compares by key.
 */
export function relayRouteAddress(route: RelayRoute): string {
  return `${relayDialUrl(route)}#${route.connectorKey}`;
}
