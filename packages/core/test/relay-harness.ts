// An in-process relay and connector for RelaySocket tests. The connector is R1's `Responder`
// with an allowlist and enrollment offers as a real connector keeps them; the relay splices the
// phone's transport to it and passes binary messages unchanged, as `ArrayBuffer`s the way a
// WebSocket with `binaryType = "arraybuffer"` delivers them.

import {
  encodeFrame,
  encodeRecord,
  EnrollmentOffer,
  generateKeyPair,
  relayIdFromKey,
  Responder,
  toBase64Url,
  type ChannelEvent,
  type ChannelRecord,
  type TransportKeys,
  type GateCheck,
  type KeyPair,
  type PhoneGate,
  type ReceiveBudget,
} from "@clawtrate/relay-protocol";
import type { RelayRoute } from "../src/relay/route.ts";
import type { RelayTimers, RelayTransport } from "../src/relay/socket.ts";

/**
 * Seals one record on a channel's own keys, as R1's limit tests do, so a test can send a lone
 * text-part or a keep-alive in the middle of a message.
 */
export function sealAs(channel: Responder, record: ChannelRecord): Uint8Array {
  const keys = (channel as unknown as { keys: TransportKeys }).keys;
  return encodeFrame({
    type: "transport",
    body: keys.send.encrypt(new Uint8Array(0), encodeRecord(record)),
  });
}

function equalBytesForTest(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

export const RELAY_ORIGIN = "wss://relay.example.test";
export const RELAY_ID = relayIdFromKey(new Uint8Array(32).fill(7));

export function routeFor(connectorKey: Uint8Array, relayOrigin = RELAY_ORIGIN): RelayRoute {
  return { kind: "relay", relayOrigin, relayId: RELAY_ID, connectorKey: toBase64Url(connectorKey) };
}

/** Timers and a monotonic clock the test moves by hand. */
export class ManualTime implements RelayTimers {
  now = 0;
  #next = 1;
  readonly #due = new Map<number, { at: number; callback: () => void }>();

  readonly clock = () => this.now;

  set(callback: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#due.set(id, { at: this.now + ms, callback });
    return id;
  }

  clear(handle: unknown): void {
    this.#due.delete(handle as number);
  }

  get pending(): number {
    return this.#due.size;
  }

  /** Moves the clock on, running each timer that falls due, in order. */
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const next = [...this.#due.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.#due.delete(next[0]);
      this.now = Math.max(this.now, next[1].at);
      next[1].callback();
    }
    this.now = end;
  }
}

/** Waits for queued deliveries and host callbacks to run. */
export async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++)
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 0));
}

/** The phone's socket to the relay. */
export class FakeTransport implements RelayTransport {
  readyState = 0;
  binaryType = "blob";
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: (string | Uint8Array)[] = [];
  closedWith: { code: number | undefined; reason: string | undefined } | null = null;
  /** Set to make the next send throw, as a socket that failed would. */
  failSends = false;
  readonly url: string;
  readonly #toRelay: (data: string | Uint8Array) => void;

  constructor(url: string, toRelay: (data: string | Uint8Array) => void) {
    this.url = url;
    this.#toRelay = toRelay;
  }

  send(data: string | Uint8Array): void {
    if (this.failSends) throw new Error("socket write failed");
    if (this.readyState !== 1) throw new Error("not open");
    this.sent.push(data);
    this.#toRelay(data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.readyState = 3;
  }

  /** The relay delivers a message to the phone. Binary as an ArrayBuffer. */
  deliver(data: string | Uint8Array): void {
    if (this.readyState === 3) return;
    const payload =
      typeof data === "string"
        ? data
        : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    this.onmessage?.({ data: payload });
  }

  /** The relay's socket ends without a word. */
  drop(code = 1006): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
}

/**
 * A connector: an allowlist of enrolled phone keys and its pairing offers, a read-only gate at
 * message 1, and an atomic commit at the confirm record, as R1's README describes.
 */
export class TestConnector implements PhoneGate {
  readonly staticKey: KeyPair;
  readonly enrolled: Uint8Array[] = [];
  readonly offers: { secret: Uint8Array; offer: EnrollmentOffer }[] = [];
  nowMs = 1_000;
  /** Holds the admission until `admitNow` is called, to test that the phone waits for it. */
  holdAdmission = false;
  /** What the connector does with the phone's text: by default, echoes it back. */
  onText: (text: string, reply: (text: string) => void) => void = (text, reply) => reply(text);
  readonly received: ChannelEvent[] = [];
  /** Runs once a phone is admitted: a bridge opens its gateway socket here. */
  onAdmitted: (() => void) | null = null;
  channel: Responder | null = null;
  errors: unknown[] = [];
  #pending: (() => void) | null = null;
  #transport: FakeTransport | null = null;
  readonly #budget: ReceiveBudget | undefined;

  constructor(options: { staticKey?: KeyPair; budget?: ReceiveBudget } = {}) {
    this.staticKey = options.staticKey ?? generateKeyPair();
    this.#budget = options.budget;
  }

  addOffer(secret: Uint8Array, expiresAtMs = this.nowMs + 600_000): void {
    this.offers.push({ secret, offer: new EnrollmentOffer(secret, expiresAtMs) });
  }

  check(phoneKey: Uint8Array, enroll: Uint8Array | undefined): GateCheck {
    if (this.enrolled.some((key) => equalBytesForTest(key, phoneKey))) return "enrolled";
    if (enroll === undefined) return "not_enrolled";
    const match = this.offers.find(({ offer }) => offer.matches(enroll, this.nowMs));
    return match ? { eligible: match } : "enrollment_refused";
  }

  /** A session from the relay: a fresh responder for the phone's transport. */
  attach(transport: FakeTransport): void {
    this.#transport = transport;
    this.channel = new Responder({
      relayId: RELAY_ID,
      staticKey: this.staticKey,
      gate: this,
      ...(this.#budget ? { budget: this.#budget } : {}),
    });
  }

  /** A frame from the phone. */
  receive(bytes: Uint8Array): void {
    const channel = this.channel!;
    let events: ChannelEvent[];
    try {
      events = channel.receive(bytes);
    } catch (error) {
      this.errors.push(error);
      // A connector closes the session on any failure; the relay drops the phone's side.
      this.#transport?.drop();
      return;
    }
    for (const event of events) this.#handle(channel, event);
  }

  #handle(channel: Responder, event: ChannelEvent): void {
    this.received.push(event);
    switch (event.type) {
      case "send":
        this.deliver(event.frame);
        return;
      case "admit": {
        const admit = () => {
          const attempt = channel.beginAdmission(event.admission);
          let result: "enrolled" | "enrollment_refused" = "enrolled";
          if (attempt.live && attempt.candidate !== null) {
            const { offer } = attempt.candidate as { offer: EnrollmentOffer };
            if (offer.spend(this.nowMs)) this.enrolled.push(attempt.phoneKey);
            else result = "enrollment_refused";
          }
          const settled = channel.settle(attempt, result);
          if (settled.frame) this.deliver(settled.frame);
          if (settled.admitted) this.onAdmitted?.();
        };
        if (this.holdAdmission) this.#pending = admit;
        else admit();
        return;
      }
      case "text":
        this.onText(event.text, (text) => this.sendText(text));
        return;
      default:
        return;
    }
  }

  admitNow(): void {
    const pending = this.#pending;
    this.#pending = null;
    pending?.();
  }

  sendText(text: string): void {
    for (const frame of this.channel!.sendText(text)) this.deliver(frame);
  }

  close(code = 1000, reason = ""): void {
    this.deliver(this.channel!.close(code, reason));
  }

  deliver(frame: Uint8Array | string): void {
    const transport = this.#transport;
    if (transport) setTimeout(() => transport.deliver(frame), 0);
  }
}

/**
 * The relay: a dial opens the phone's transport and, once `splice` runs (automatically unless
 * told otherwise), sends `open` and passes frames to and from the connector.
 */
export class TestRelay {
  readonly transports: FakeTransport[] = [];
  connector: TestConnector;
  autoSplice = true;
  readonly pongs: string[] = [];

  constructor(connector: TestConnector) {
    this.connector = connector;
  }

  readonly createTransport = (url: string): FakeTransport => {
    const transport: FakeTransport = new FakeTransport(url, (data) => {
      if (typeof data === "string") {
        this.pongs.push(data);
        return;
      }
      const copy = Uint8Array.from(data);
      setTimeout(() => this.connector.receive(copy), 0);
    });
    this.transports.push(transport);
    setTimeout(() => {
      transport.readyState = 1;
      transport.onopen?.({});
      if (this.autoSplice) this.splice(transport);
    }, 0);
    return transport;
  };

  splice(transport: FakeTransport): void {
    this.connector.attach(transport);
    transport.deliver('{"t":"open"}');
  }

  get last(): FakeTransport {
    return this.transports.at(-1)!;
  }
}
