// The end-to-end channel between a phone (the Noise initiator) and a connector (the responder),
// carried by the relay as opaque frames. Neither class does I/O: `receive` takes one frame from
// the peer and returns what happened, including frames the caller must send back.

import { concatBytes, equalBytes, utf8Decode, utf8Encode, type RandomBytes } from "./bytes.ts";
import { fail } from "./errors.ts";
import {
  decodeAnswer,
  decodeFrame,
  decodeHello,
  decodeRecord,
  encodeAnswer,
  encodeFrame,
  encodeHello,
  encodeRecord,
  ENROLL_SECRET_BYTES,
  type Answer,
  type ChannelRecord,
  type FrameType,
} from "./frames.ts";
import { MAX_MESSAGE_BYTES, MAX_PING_BYTES, MAX_RECORD_DATA_BYTES } from "./limits.ts";
import { IKHandshake, type KeyPair, type TransportKeys } from "./noise.ts";
import { isRelayId } from "./relay-id.ts";

/** Why a connector turned a phone away. The phone reads it from handshake message 2. */
export type Refusal = Exclude<Answer, "accepted">;

export type ChannelEvent =
  /** A frame to send to the peer now, in order. */
  | { readonly type: "send"; readonly frame: Uint8Array }
  /** The channel is confirmed on both sides; text may flow. */
  | { readonly type: "open" }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "pong"; readonly data: Uint8Array }
  /** The peer closed the channel. */
  | { readonly type: "close"; readonly code: number; readonly reason: string }
  /** The connector turned the phone away; the channel is closed. */
  | { readonly type: "refused"; readonly reason: Refusal };

export type ChannelState =
  /** The initiator before `start`. */
  | "idle"
  | "handshaking"
  /** The responder has answered and waits for the initiator's confirm record. */
  | "confirming"
  | "open"
  | "closed"
  | "failed";

/**
 * The prologue both sides hash before the handshake: the protocol's name and version and the
 * relay id, so a session spliced to another relay id fails.
 */
export function channelPrologue(relayId: string): Uint8Array {
  if (!isRelayId(relayId)) fail("bad_relay_id", "The relay id is not canonical.");
  return utf8Encode(`clawtrate-relay/1\n${relayId}`);
}

/**
 * Decides whether a phone, identified by its Noise static key, may use the connector. The
 * connector implements it over its own allowlist.
 */
export interface PhoneGate {
  isEnrolled(phoneKey: Uint8Array): boolean;
  /**
   * Called only for a phone that is not enrolled and sent a secret. Returns true, and enrolls
   * `phoneKey`, if the secret matches a pending enrollment that has not expired or been used.
   */
  redeem(secret: Uint8Array, phoneKey: Uint8Array): boolean;
}

/**
 * One pairing code's enrollment secret. It is good once, until it expires; the first phone to
 * redeem it is the one it enrolls.
 */
export class EnrollmentOffer {
  readonly #secret: Uint8Array;
  readonly expiresAtMs: number;
  #used = false;

  constructor(secret: Uint8Array, expiresAtMs: number) {
    if (secret.length !== ENROLL_SECRET_BYTES)
      fail("malformed", "An enrollment secret is 32 bytes.");
    this.#secret = Uint8Array.from(secret);
    this.expiresAtMs = expiresAtMs;
  }

  get used(): boolean {
    return this.#used;
  }

  /** True once: for the matching secret before `expiresAtMs`. Compares in constant time. */
  redeem(secret: Uint8Array, nowMs: number): boolean {
    const matches = equalBytes(secret, this.#secret);
    if (!matches || this.#used || nowMs >= this.expiresAtMs) return false;
    this.#used = true;
    this.#secret.fill(0);
    return true;
  }
}

abstract class Channel {
  protected state: ChannelState;
  protected keys: TransportKeys | null = null;
  #parts: Uint8Array[] = [];
  #partBytes = 0;

  protected constructor(state: ChannelState) {
    this.state = state;
  }

  get currentState(): ChannelState {
    return this.state;
  }

  /** The Noise handshake hash: the same on both ends of one session, and different for every session. */
  get handshakeHash(): Uint8Array | null {
    return this.keys?.handshakeHash ?? null;
  }

  /**
   * Takes one binary frame from the peer. Anything wrong with it (tampering, a replayed,
   * reordered or dropped frame, a frame the state does not allow, a size over a cap) throws
   * `RelayProtocolError` and fails the channel for good: the caller closes the socket.
   */
  receive(bytes: Uint8Array): ChannelEvent[] {
    this.#checkUsable();
    try {
      const frame = decodeFrame(bytes);
      return this.receiveFrame(frame.type, frame.body);
    } catch (error) {
      this.state = "failed";
      this.#parts = [];
      throw error;
    }
  }

  protected abstract receiveFrame(type: FrameType, body: Uint8Array): ChannelEvent[];

  /** Encrypts a text message, split into as many frames as it needs. */
  sendText(text: string): Uint8Array[] {
    this.#checkOpen();
    const bytes = utf8Encode(text);
    if (bytes.length > MAX_MESSAGE_BYTES) {
      fail("message_too_large", `A message is at most ${MAX_MESSAGE_BYTES} bytes.`);
    }
    const frames: Uint8Array[] = [];
    let offset = 0;
    do {
      const end = Math.min(offset + MAX_RECORD_DATA_BYTES, bytes.length);
      const data = bytes.subarray(offset, end);
      frames.push(
        this.seal(end === bytes.length ? { kind: "text-end", data } : { kind: "text-part", data }),
      );
      offset = end;
    } while (offset < bytes.length);
    return frames;
  }

  /** A ping the peer answers with a pong carrying the same bytes. */
  ping(data: Uint8Array = new Uint8Array(0)): Uint8Array {
    this.#checkOpen();
    if (data.length > MAX_PING_BYTES)
      fail("malformed", `A ping carries at most ${MAX_PING_BYTES} bytes.`);
    return this.seal({ kind: "ping", data });
  }

  /** Ends the channel and returns the last frame to send. */
  close(code = 1000, reason = ""): Uint8Array {
    this.#checkOpen();
    const frame = this.seal({ kind: "close", code, reason });
    this.state = "closed";
    return frame;
  }

  protected seal(record: ChannelRecord): Uint8Array {
    const body = this.keys!.send.encrypt(new Uint8Array(0), encodeRecord(record));
    return encodeFrame({ type: "transport", body });
  }

  protected open(body: Uint8Array): ChannelRecord {
    return decodeRecord(this.keys!.receive.decrypt(new Uint8Array(0), body));
  }

  /** Handles a record on an open channel. */
  protected receiveRecord(record: ChannelRecord): ChannelEvent[] {
    switch (record.kind) {
      case "text-part":
      case "text-end": {
        this.#partBytes += record.data.length;
        if (this.#partBytes > MAX_MESSAGE_BYTES) {
          fail("message_too_large", `A message is at most ${MAX_MESSAGE_BYTES} bytes.`);
        }
        this.#parts.push(Uint8Array.from(record.data));
        if (record.kind === "text-part") return [];
        const text = utf8Decode(concatBytes(...this.#parts));
        this.#parts = [];
        this.#partBytes = 0;
        return [{ type: "text", text }];
      }
      case "ping":
        return [{ type: "send", frame: this.seal({ kind: "pong", data: record.data }) }];
      case "pong":
        return [{ type: "pong", data: Uint8Array.from(record.data) }];
      case "close":
        this.state = "closed";
        this.#parts = [];
        return [{ type: "close", code: record.code, reason: record.reason }];
      case "confirm":
        return fail("unexpected", "A confirm record comes once, first.");
    }
  }

  #checkUsable(): void {
    if (this.state === "failed") fail("failed", "The channel has failed.");
    if (this.state === "closed") fail("closed", "The channel is closed.");
  }

  #checkOpen(): void {
    this.#checkUsable();
    if (this.state !== "open") fail("unexpected", "The channel is not open yet.");
  }
}

export interface InitiatorOptions {
  readonly relayId: string;
  /** The connector's Noise static public key, pinned by the pairing code. */
  readonly connectorKey: Uint8Array;
  /** The phone's own Noise static key pair. */
  readonly staticKey: KeyPair;
  /** The pairing code's enrollment secret, until the phone is enrolled. */
  readonly enroll?: Uint8Array;
  readonly random?: RandomBytes;
}

/** The phone's end. Call `start`, send its frame, then feed every frame from the relay to `receive`. */
export class Initiator extends Channel {
  readonly #handshake: IKHandshake;
  readonly #hello: Uint8Array;

  constructor(options: InitiatorOptions) {
    super("idle");
    this.#hello = encodeHello(options.enroll === undefined ? {} : { enroll: options.enroll });
    this.#handshake = new IKHandshake({
      initiator: true,
      prologue: channelPrologue(options.relayId),
      staticKey: options.staticKey,
      remoteStaticKey: options.connectorKey,
      ...(options.random ? { random: options.random } : {}),
    });
  }

  /** Handshake message 1, to send first. */
  start(): Uint8Array {
    if (this.state !== "idle") fail("unexpected", "The channel has already started.");
    const body = this.#handshake.writeMessage1(this.#hello);
    this.#hello.fill(0);
    this.state = "handshaking";
    return encodeFrame({ type: "handshake1", body });
  }

  protected receiveFrame(type: FrameType, body: Uint8Array): ChannelEvent[] {
    if (this.state === "handshaking" && type === "handshake2") {
      const answer = decodeAnswer(this.#handshake.readMessage2(body));
      this.keys = this.#handshake.transportKeys;
      if (answer !== "accepted") {
        this.state = "closed";
        return [{ type: "refused", reason: answer }];
      }
      const confirm = this.seal({ kind: "confirm" });
      this.state = "open";
      return [{ type: "send", frame: confirm }, { type: "open" }];
    }
    if (this.state === "open" && type === "transport") return this.receiveRecord(this.open(body));
    return fail("unexpected", `A ${type} frame is not expected now.`);
  }
}

export interface ResponderOptions {
  readonly relayId: string;
  /** The connector's Noise static key pair. */
  readonly staticKey: KeyPair;
  readonly gate: PhoneGate;
  readonly random?: RandomBytes;
}

/**
 * The connector's end, one per relayed session. Feed it every frame from the relay. It answers
 * handshake message 1 itself, enrolling or refusing the phone through the gate, and reports
 * `open` only when the phone's confirm record arrives. Open no gateway socket before that:
 * handshake message 1 can be replayed by whoever recorded it, and only the confirm record
 * proves the phone completed this handshake.
 */
export class Responder extends Channel {
  readonly #handshake: IKHandshake;
  readonly #gate: PhoneGate;

  constructor(options: ResponderOptions) {
    super("handshaking");
    this.#gate = options.gate;
    this.#handshake = new IKHandshake({
      initiator: false,
      prologue: channelPrologue(options.relayId),
      staticKey: options.staticKey,
      ...(options.random ? { random: options.random } : {}),
    });
  }

  /** The phone's Noise static key, once handshake message 1 is read. */
  get phoneKey(): Uint8Array | null {
    return this.#handshake.remoteStaticKey;
  }

  protected receiveFrame(type: FrameType, body: Uint8Array): ChannelEvent[] {
    if (this.state === "handshaking" && type === "handshake1") {
      const hello = decodeHello(this.#handshake.readMessage1(body));
      const phoneKey = this.#handshake.remoteStaticKey!;
      const answer = this.#decide(phoneKey, hello.enroll);
      hello.enroll?.fill(0);
      const frame = encodeFrame({
        type: "handshake2",
        body: this.#handshake.writeMessage2(encodeAnswer(answer)),
      });
      this.keys = this.#handshake.transportKeys;
      if (answer !== "accepted") {
        this.state = "closed";
        return [
          { type: "send", frame },
          { type: "refused", reason: answer },
        ];
      }
      this.state = "confirming";
      return [{ type: "send", frame }];
    }
    if (this.state === "confirming" && type === "transport") {
      const record = this.open(body);
      if (record.kind !== "confirm")
        fail("unexpected", "The phone's first record must be confirm.");
      this.state = "open";
      return [{ type: "open" }];
    }
    if (this.state === "open" && type === "transport") return this.receiveRecord(this.open(body));
    return fail("unexpected", `A ${type} frame is not expected now.`);
  }

  #decide(phoneKey: Uint8Array, enroll: Uint8Array | undefined): Answer {
    if (this.#gate.isEnrolled(phoneKey)) return "accepted";
    if (enroll === undefined) return "not_enrolled";
    return this.#gate.redeem(enroll, phoneKey) ? "accepted" : "enrollment_refused";
  }
}
