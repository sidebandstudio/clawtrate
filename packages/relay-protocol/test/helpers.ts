import {
  EnrollmentOffer,
  generateKeyPair,
  Initiator,
  relayIdFromKey,
  Responder,
  type ChannelEvent,
  type KeyPair,
  type PhoneGate,
} from "../src/index.ts";

export function hex(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A small seeded generator (mulberry32), so every fuzz run is the same and a failure repeats. */
export function seeded(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
  };
  const int = (max: number) => Math.floor(next() * max);
  const bytes = (length: number) => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = int(256);
    return out;
  };
  return { next, int, bytes };
}

export const RELAY_ID = relayIdFromKey(new Uint8Array(32).fill(7));

/** An allowlist of phone keys and at most one pending offer, as the connector keeps them. */
export class TestGate implements PhoneGate {
  readonly enrolled: Uint8Array[] = [];
  offer: EnrollmentOffer | null = null;
  nowMs = 1_000;

  isEnrolled(phoneKey: Uint8Array): boolean {
    return this.enrolled.some((key) => key.every((byte, i) => byte === phoneKey[i]));
  }

  redeem(secret: Uint8Array, phoneKey: Uint8Array): boolean {
    if (this.offer === null || !this.offer.redeem(secret, this.nowMs)) return false;
    this.enrolled.push(Uint8Array.from(phoneKey));
    return true;
  }
}

export interface Pair {
  readonly phone: Initiator;
  readonly connector: Responder;
  readonly gate: TestGate;
  readonly phoneKey: KeyPair;
  readonly connectorKey: KeyPair;
}

/** A phone and a connector with a pending enrollment for the phone's secret. */
export function makePair(options: { enroll?: boolean; relayId?: string } = {}): Pair {
  const phoneKey = generateKeyPair();
  const connectorKey = generateKeyPair();
  const gate = new TestGate();
  const secret = new Uint8Array(32).fill(9);
  gate.offer = new EnrollmentOffer(secret, 60_000);
  const phone = new Initiator({
    relayId: options.relayId ?? RELAY_ID,
    connectorKey: connectorKey.publicKey,
    staticKey: phoneKey,
    ...(options.enroll === false ? {} : { enroll: secret }),
  });
  const connector = new Responder({ relayId: RELAY_ID, staticKey: connectorKey, gate });
  return { phone, connector, gate, phoneKey, connectorKey };
}

export function sends(events: readonly ChannelEvent[]): Uint8Array[] {
  return events.flatMap((event) => (event.type === "send" ? [event.frame] : []));
}

/**
 * Runs the handshake to open. Returns every frame that crossed, in order, for tests that replay
 * or tamper with them.
 */
export function openPair(pair: Pair): { hs1: Uint8Array; hs2: Uint8Array; confirm: Uint8Array } {
  const hs1 = pair.phone.start();
  const [hs2] = sends(pair.connector.receive(hs1));
  const phoneEvents = pair.phone.receive(hs2!);
  const [confirm] = sends(phoneEvents);
  const connectorEvents = pair.connector.receive(confirm!);
  if (
    !phoneEvents.some((e) => e.type === "open") ||
    !connectorEvents.some((e) => e.type === "open")
  ) {
    throw new Error("The pair did not open.");
  }
  return { hs1, hs2: hs2!, confirm: confirm! };
}

/** Delivers frames and returns the receiver's events. */
export function deliver(to: Initiator | Responder, frames: readonly Uint8Array[]): ChannelEvent[] {
  return frames.flatMap((frame) => to.receive(frame));
}
