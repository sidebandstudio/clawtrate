// What every object is bound to (a gateway and an account) and what the list holds about a
// device. Both are encoded the same way wherever they appear.

import { checkLength, equalBytes, type Reader, type Writer } from "./bytes.ts";
import { fail } from "./errors.ts";
import { GatewayDeviceKey, ListPublicKey, SealPublicKey } from "./keys.ts";
import { MAX_NAME_BYTES } from "./limits.ts";

/** The gateway's random id and the account's id, 16 bytes each. Every object carries both. */
export interface ListContext {
  readonly gatewayId: Uint8Array;
  readonly accountId: Uint8Array;
}

export function checkContext(context: ListContext): ListContext {
  return {
    gatewayId: checkLength(context.gatewayId, 16, "a gateway id").slice(),
    accountId: checkLength(context.accountId, 16, "an account id").slice(),
  };
}

export function writeContext(writer: Writer, context: ListContext): void {
  writer.fixed(context.gatewayId, 16, "gateway id").fixed(context.accountId, 16, "account id");
}

export function readContext(reader: Reader): ListContext {
  return { gatewayId: reader.fixed(16, "gateway id"), accountId: reader.fixed(16, "account id") };
}

/** Refuses an object read from the wire that is for another gateway or account. */
export function expectContext(found: ListContext, expected: ListContext): void {
  if (!equalBytes(found.gatewayId, expected.gatewayId))
    fail("wrong_gateway", "for another gateway");
  if (!equalBytes(found.accountId, expected.accountId))
    fail("wrong_account", "for another account");
}

export const PLATFORMS = ["macos", "windows", "linux", "ios"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** A device on the list: its keys, its TLS pin, and the name and platform it says it has. */
export interface DeviceRecord {
  readonly listKey: ListPublicKey;
  readonly sealKey: SealPublicKey;
  /** SHA-256 of the DER SubjectPublicKeyInfo of the device's TLS client key. */
  readonly tlsPin: Uint8Array;
  readonly gatewayDeviceKey: GatewayDeviceKey;
  readonly platform: Platform;
  /** The name the device gives itself. Never proof of anything; shown as "says it is". */
  readonly name: string;
}

export function writeRecord(writer: Writer, record: DeviceRecord): void {
  const platform = PLATFORMS.indexOf(record.platform);
  if (platform < 0) fail("malformed", "unknown platform");
  if (!(record.listKey instanceof ListPublicKey)) fail("bad_argument", "listKey is not a list key");
  if (!(record.sealKey instanceof SealPublicKey)) fail("bad_argument", "sealKey is not a seal key");
  if (!(record.gatewayDeviceKey instanceof GatewayDeviceKey)) {
    fail("bad_argument", "gatewayDeviceKey is not a gateway device key");
  }
  writer
    .fixed(record.listKey.bytes, 32, "list key")
    .fixed(record.sealKey.bytes, 32, "seal key")
    .fixed(checkLength(record.tlsPin, 32, "a TLS pin"), 32, "TLS pin")
    .fixed(record.gatewayDeviceKey.bytes, 32, "gateway device key")
    .u8(platform + 1)
    .text(record.name, 1, MAX_NAME_BYTES, "name");
}

export function readRecord(reader: Reader): DeviceRecord {
  const listKey = ListPublicKey.fromBytes(reader.fixed(32, "list key"));
  const sealKey = SealPublicKey.fromBytes(reader.fixed(32, "seal key"));
  const tlsPin = reader.fixed(32, "TLS pin");
  const gatewayDeviceKey = GatewayDeviceKey.fromBytes(reader.fixed(32, "gateway device key"));
  const platform = PLATFORMS[reader.u8() - 1];
  if (platform === undefined) fail("malformed", "unknown platform");
  const name = reader.text(1, MAX_NAME_BYTES, "name");
  return { listKey, sealKey, tlsPin, gatewayDeviceKey, platform, name };
}
