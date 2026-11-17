// What a failed connect means, read from the gateway's error details. Pure, so
// the end-to-end tests can feed it a real gateway's payload.

import { PROTOCOL_VERSION } from "@openclaw/gateway-client/browser";
import { asRecord } from "./mapping.ts";

/**
 * How long OpenClaw 2026.10.6 keeps a pending pairing request after its last
 * refresh (`DEVICE_PAIRING_PENDING_TTL_MS`). Every connect attempt refreshes
 * it, so while this client retries a request cannot expire; it disappears
 * only when the gateway's owner rejects it, or when no attempt reached the
 * gateway for this long.
 */
export const PAIRING_PENDING_TTL_MS = 300_000;

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

export type PairingOutcome = "pending" | "rejected" | "expired";

/**
 * A pairing request this client was waiting on, followed by a pairing error
 * for a different request: the gateway gives a non-Control-UI client no
 * result for its request, so the outcome is told apart by time. Gone within
 * the pending lifetime of its last refresh, it was rejected; gone after it,
 * it expired.
 */
export function pairingOutcome(
  previous: { requestId: string; at: number } | null,
  requestId: string,
  now: number,
): PairingOutcome {
  if (!previous || !previous.requestId || !requestId || previous.requestId === requestId) {
    return "pending";
  }
  return now - previous.at > PAIRING_PENDING_TTL_MS ? "expired" : "rejected";
}

export const PAIRING_ENDED = {
  rejected: {
    code: "PAIRING_REJECTED",
    message: "The gateway's owner rejected this device's pairing request.",
  },
  expired: {
    code: "PAIRING_EXPIRED",
    message: "Nobody approved this device's pairing request in time.",
  },
} as const;
