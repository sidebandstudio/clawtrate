// What a failed connect means, read from the gateway's error details. Pure, so
// the end-to-end tests can feed it a real gateway's payload.

import { PROTOCOL_VERSION } from "@openclaw/gateway-client/browser";
import { asRecord } from "./mapping.ts";

export type ProtocolMismatch = { gateway: number | null; client: number };

/**
 * A `PROTOCOL_MISMATCH` connect error: the gateway names the protocol it
 * speaks (`expectedProtocol`) and echoes the range the client offered.
 */
export function protocolMismatch(details: unknown): ProtocolMismatch | null {
  const record = asRecord(details);
  if (record?.code !== "PROTOCOL_MISMATCH") return null;
  const gateway = record.expectedProtocol;
  return {
    gateway: typeof gateway === "number" && Number.isFinite(gateway) ? gateway : null,
    client: PROTOCOL_VERSION,
  };
}

export function protocolMessage(mismatch: ProtocolMismatch): string {
  return mismatch.gateway === null
    ? `This gateway does not speak protocol ${mismatch.client}, the one this version of Clawtrate speaks.`
    : `This gateway speaks protocol ${mismatch.gateway}. This version of Clawtrate speaks protocol ${mismatch.client}.`;
}

/**
 * A pairing request this client was waiting on, followed by a pairing error
 * for a different request: the first request is no longer pending. The
 * gateway's owner rejected it, or it expired after no attempt refreshed it.
 * OpenClaw sends a client that is not its Control UI no result for its
 * request, and a new connect gets a new request either way, so the client
 * cannot tell which happened (the capability map, "Rejected or expired
 * pairing"). It says only what it knows.
 */
export function pairingEnded(previous: string | null, requestId: string): boolean {
  return previous !== null && previous !== "" && requestId !== "" && previous !== requestId;
}

/** The error for a pairing request that is no longer pending. A code of the client's own. */
export const PAIRING_ENDED = {
  code: "PAIRING_ENDED",
  message:
    "It was rejected, or it expired before anyone approved it; the gateway does not say which. Try again to send a new request, then approve it on the gateway.",
} as const;
