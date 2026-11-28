// The gateway's card: what a device needs to reach the connector and trust it. The connector
// signs it with its list key; the join's words cover its hash.

import { checkLength, concat, copy, equalBytes, Reader, taggedHash, Writer } from "./bytes.ts";
import { fail } from "./errors.ts";
import { ListPublicKey, signList, verifyEd25519, type ListSecretKey } from "./keys.ts";
import { LABEL, TAG } from "./labels.ts";
import { MAX_ADDRESSES, MAX_HOST_BYTES, MAX_NAME_BYTES } from "./limits.ts";

/** An IPv4 address as a dotted quad of decimal numbers 0 to 255, with no leading zero. */
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
/** A DNS label that starts with a letter: lowercase letters, digits and inner hyphens, 1 to 63. */
const DNS_LABEL = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** The shortest lowercase form of an IPv6 address (RFC 5952), or null if `text` isn't one. */
function canonicalIpv6(text: string): string | null {
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":"));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  const values = groups.map((group) => parseInt(group, 16).toString(16));
  // The longest run of two or more zero groups, the first if two are as long, becomes "::".
  let best = -1;
  let bestLength = 1;
  for (let i = 0; i < 8;) {
    let j = i;
    while (j < 8 && values[j] === "0") j++;
    if (j - i > bestLength) [best, bestLength] = [i, j - i];
    i = j === i ? i + 1 : j;
  }
  if (best < 0) return values.join(":");
  return `${values.slice(0, best).join(":")}::${values.slice(best + bestLength).join(":")}`;
}

/**
 * One form for each host: an IPv4 dotted quad, a lowercase DNS name whose every label starts
 * with a letter (so no URL parser reads it as a number, like `2130706433` or `0x7f000001`), or
 * an IPv6 address in brackets in its shortest lowercase form (`[2001:db8::1]`). No port: the
 * port is its own field. A device builds the address as `wss://<host>:<port>/`.
 */
function isHost(host: string): boolean {
  if (IPV4.test(host)) return true;
  if (host.startsWith("[") && host.endsWith("]")) {
    const inner = host.slice(1, -1);
    return canonicalIpv6(inner) === inner;
  }
  return host.split(".").every((label) => DNS_LABEL.test(label));
}

export interface CardAddress {
  readonly host: string;
  readonly port: number;
}

export interface Card {
  readonly gatewayId: Uint8Array;
  /** Raised by the connector for each new card, so a device can keep the newest. */
  readonly serial: number;
  readonly connectorKey: ListPublicKey;
  /** SHA-256 of the DER SubjectPublicKeyInfo of the connector's TLS key: its listener's pin. */
  readonly tlsPin: Uint8Array;
  readonly addresses: readonly CardAddress[];
  /** The gateway's name, as the person sees it. */
  readonly name: string;
}

function checkAddress(address: CardAddress): void {
  if (!isHost(address.host)) fail("malformed", "a host is not in its one form");
  if (!Number.isInteger(address.port) || address.port < 1 || address.port > 65535) {
    fail("malformed", "a port is out of range");
  }
}

function encodeSigned(card: Card): Uint8Array {
  if (!Number.isInteger(card.serial) || card.serial < 0 || card.serial > 0xffffffff) {
    fail("malformed", "the serial is out of range");
  }
  if (card.addresses.length < 1) fail("malformed", "a card has an address");
  if (card.addresses.length > MAX_ADDRESSES) fail("too_large", "too many addresses");
  const writer = new Writer()
    .label(LABEL.card)
    .fixed(checkLength(card.gatewayId, 16, "a gateway id"), 16, "gateway id")
    .u32(card.serial)
    .fixed(card.connectorKey.bytes, 32, "connector key")
    .fixed(checkLength(card.tlsPin, 32, "a TLS pin"), 32, "TLS pin")
    .u8(card.addresses.length);
  for (const address of card.addresses) {
    checkAddress(address);
    writer.text(address.host, 1, MAX_HOST_BYTES, "host").u16(address.port);
  }
  return writer.text(card.name, 1, MAX_NAME_BYTES, "gateway name").finish();
}

/** The connector signs its card. Only the connector's key can make a card a device accepts. */
export function signCard(connector: ListSecretKey, card: Omit<Card, "connectorKey">): Uint8Array {
  const signed = encodeSigned({ ...card, connectorKey: connector.publicKey });
  return concat(signed, signList(connector, signed));
}

/**
 * Reads a card and checks it against the connector key the caller already trusts (the list's,
 * from its first entry) and the gateway it is for. A card is never trusted for the key it names.
 */
export function verifyCard(
  bytes: Uint8Array,
  connectorKey: ListPublicKey,
  gatewayId: Uint8Array,
): Card {
  const reader = new Reader(copy(bytes));
  reader.label(LABEL.card);
  const found = reader.fixed(16, "gateway id");
  const serial = reader.u32();
  const named = ListPublicKey.fromBytes(reader.fixed(32, "connector key"));
  const tlsPin = reader.fixed(32, "TLS pin");
  const count = reader.u8();
  if (count < 1) fail("malformed", "a card has an address");
  if (count > MAX_ADDRESSES) fail("too_large", "too many addresses");
  const addresses: CardAddress[] = [];
  for (let i = 0; i < count; i++) {
    const address = { host: reader.text(1, MAX_HOST_BYTES, "host"), port: reader.u16() };
    checkAddress(address);
    addresses.push(address);
  }
  const name = reader.text(1, MAX_NAME_BYTES, "gateway name");
  const signed = reader.before();
  const signature = reader.fixed(64, "signature");
  reader.end();
  if (!named.equals(connectorKey)) fail("card_mismatch", "the card names another connector");
  if (!verifyEd25519(connectorKey.bytes, signed, signature))
    fail("bad_signature", "the card's signature does not verify");
  if (!equalBytes(found, checkLength(gatewayId, 16, "a gateway id")))
    fail("wrong_gateway", "the card is another gateway's");
  return Object.freeze({
    gatewayId: found,
    serial,
    connectorKey,
    tlsPin,
    addresses: Object.freeze(addresses.map((address) => Object.freeze(address))),
    name,
  });
}

/** The hash a join's words cover, over the whole signed card. */
export function cardHash(bytes: Uint8Array): Uint8Array {
  return taggedHash(TAG.cardHash, bytes);
}
