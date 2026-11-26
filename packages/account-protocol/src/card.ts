// The gateway's card: what a device needs to reach the connector and trust it. The connector
// signs it with its list key; the join's words cover its hash.

import { checkLength, concat, equalBytes, Reader, taggedHash, Writer } from "./bytes.ts";
import { fail } from "./errors.ts";
import { ListPublicKey, signList, verifyEd25519, type ListSecretKey } from "./keys.ts";
import { LABEL, TAG } from "./labels.ts";
import { MAX_ADDRESSES, MAX_HOST_BYTES, MAX_NAME_BYTES } from "./limits.ts";
import type { ListState } from "./list.ts";

/** A host is lowercase letters, digits, dots, hyphens and colons (an IPv6 literal), one way to write each. */
const HOST = /^[0-9a-z.:-]+$/;

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
  if (!HOST.test(address.host)) fail("malformed", "a host has a character it can't have");
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

/** Reads a card and checks that the connector key it names signed it. */
export function verifyCard(bytes: Uint8Array): Card {
  const reader = new Reader(bytes);
  reader.label(LABEL.card);
  const gatewayId = reader.fixed(16, "gateway id");
  const serial = reader.u32();
  const connectorKey = ListPublicKey.fromBytes(reader.fixed(32, "connector key"));
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
  if (!verifyEd25519(connectorKey.bytes, signed, signature)) fail("bad_signature", "the card's signature does not verify");
  return { gatewayId, serial, connectorKey, tlsPin, addresses, name };
}

/** The hash a join's words cover, over the whole signed card. */
export function cardHash(bytes: Uint8Array): Uint8Array {
  return taggedHash(TAG.cardHash, bytes);
}

/** Checks that a verified card is this list's: its gateway and its connector. */
export function checkCardForList(card: Card, state: ListState): void {
  if (!equalBytes(card.gatewayId, state.context.gatewayId)) fail("wrong_gateway", "the card is another gateway's");
  if (!card.connectorKey.equals(state.connectorKey)) fail("card_mismatch", "the card is not the list's connector's");
}
