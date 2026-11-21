// The end-to-end channel between a phone (the Noise initiator) and a connector (the responder),
// carried by the relay as opaque frames. Neither class does I/O: `receive` takes one frame from
// the peer and returns what happened, including frames the caller must send back.
//
// The opening, in frames and records:
//
//   phone                                         connector
//   handshake1  (hello: enroll secret or none) ->
//                                              <- handshake2  (answer, provisional if accepted)
//   confirm record                             ->              "admit" event: the host rechecks
//                                                              and commits, then calls admit()
//                                              <- admission record ("open" on the phone)
//
// Nothing changes on the connector before the confirm record: handshake message 1 can be
// replayed by whoever recorded it, and only the confirm record proves the phone is live.

import { equalBytes, utf8Decode, utf8Encode, type RandomBytes } from "./bytes.ts";
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
  PROTOCOL_VERSION,
  type Answer,
  type ChannelRecord,
  type FrameType,
} from "./frames.ts";
import {
  MAX_MESSAGE_BYTES,
  MAX_PARTIAL_MESSAGE_MS,
  MAX_PING_BYTES,
  MAX_RECORD_DATA_BYTES,
} from "./limits.ts";
import { IKHandshake, type KeyPair, type TransportKeys } from "./noise.ts";
import { isRelayId } from "./relay-id.ts";
import { checkMillis } from "./time.ts";

/** Why a connector turned a phone away. */
export type Refusal = Exclude<Answer, "accepted">;

export type ChannelEvent =
  /** A frame to send to the peer now, in order. */
  | { readonly type: "send"; readonly frame: Uint8Array }
  /** The phone: the connector admitted it; text may flow. */
  | { readonly type: "open" }
  /**
   * The connector: the phone confirmed the handshake. Recheck and commit, then call `admit` or
   * `refuse`. `enroll` is the secret the phone sent, or null. Both are copies.
   */
  | { readonly type: "admit"; readonly phoneKey: Uint8Array; readonly enroll: Uint8Array | null }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "pong"; readonly data: Uint8Array }
  /** The peer closed the channel. A message it had not finished is discarded. */
  | { readonly type: "close"; readonly code: number; readonly reason: string }
  /** The phone was turned away; the channel is closed. */
  | { readonly type: "refused"; readonly reason: Refusal };

export type ChannelState =
  /** The initiator before `start`. */
  | "idle"
  | "handshaking"
  /** Message 2 is done: the connector waits for the confirm record, the phone for admission. */
  | "confirming"
  /** The connector has the confirm record and waits for the host's `admit` or `refuse`. */
  | "admitting"
  | "open"
  /** Ended by an authenticated close or refusal. */
  | "closed"
  /** Ended by an error or by `abort`. */
  | "failed";

/**
 * The prologue both sides hash before the handshake: the protocol's name and version and the
 * relay id, so a session spliced to another relay id fails.
 */
export function channelPrologue(relayId: string): Uint8Array {
  if (!isRelayId(relayId)) fail("bad_relay_id", "The relay id is not canonical.");
  return utf8Encode(`clawtrate-relay/${PROTOCOL_VERSION}\n${relayId}`);
}

/**
 * What the connector's allowlist says at message 1: the key is enrolled, or it is not but its
 * secret matches a live offer, or a refusal.
 */
export type GateCheck = "enrolled" | "eligible" | Refusal;

/**
 * The connector's read-only look at its allowlist when message 1 arrives. It must change
 * nothing: the commit comes with the `admit` event, after the phone proves it is live. It is
 * given copies.
 */
export interface PhoneGate {
  check(phoneKey: Uint8Array, enroll: Uint8Array | undefined): GateCheck;
}

/**
 * One pairing code's enrollment secret. It is good once, until it expires. `matches` only
 * looks; `redeem` spends it, and belongs in the same transaction that adds the phone's key.
 */
export class EnrollmentOffer {
  readonly #secret: Uint8Array;
  readonly expiresAtMs: number;
  #used = false;

  constructor(secret: Uint8Array, expiresAtMs: number) {
    if (secret.length !== ENROLL_SECRET_BYTES)
      fail("malformed", "An enrollment secret is 32 bytes.");
    this.expiresAtMs = checkMillis(expiresAtMs, "The offer's expiry");
    this.#secret = Uint8Array.from(secret);
  }

  get used(): boolean {
    return this.#used;
  }

  /** True for the matching secret, unused, before `expiresAtMs`. Compares in constant time. */
  matches(secret: Uint8Array, nowMs: number): boolean {
    checkMillis(nowMs, "The time");
    const same = equalBytes(secret, this.#secret);
    return same && !this.#used && nowMs < this.expiresAtMs;
  }

  /** Spends the offer if `matches` holds; true once. */
  redeem(secret: Uint8Array, nowMs: number): boolean {
    if (!this.matches(secret, nowMs)) return false;
    this.#used = true;
    this.#secret.fill(0);
    return true;
  }
}

/**
 * Buffered text across every channel of one host. A channel takes room for each record of an
 * unfinished message and gives it back when the message completes or the channel ends; one
 * that finds no room fails with `over_budget`.
 */
export class ReceiveBudget {
  readonly limitBytes: number;
  #used = 0;

  constructor(limitBytes: number) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) {
      fail("malformed", "A budget is a whole number of bytes.");
    }
    this.limitBytes = limitBytes;
  }

  get usedBytes(): number {
    return this.#used;
  }

  take(bytes: number): boolean {
    if (this.#used + bytes > this.limitBytes) return false;
    this.#used += bytes;
    return true;
  }

  give(bytes: number): void {
    this.#used = Math.max(0, this.#used - bytes);
  }
}

export interface ChannelOptions {
  /** A budget shared by the host's channels for buffered text. */
  readonly budget?: ReceiveBudget;
  /**
   * The host's monotonic clock, in milliseconds. With it, a record that arrives more than
   * `MAX_PARTIAL_MESSAGE_MS` after its message began fails the channel. The host still needs
   * its own timer for a peer that goes quiet: abort when `partialMessageSince` is that old.
   */
  readonly clock?: () => number;
}

abstract class Channel {
  protected state: ChannelState;
  protected keys: TransportKeys | null = null;
  readonly #budget: ReceiveBudget | null;
  readonly #clock: (() => number) | null;
  #handshakeHash: Uint8Array | null = null;
  #parts: Uint8Array[] = [];
  #partBytes = 0;
  #partialSince: number | null = null;

  protected constructor(state: ChannelState, options: ChannelOptions) {
    this.state = state;
    this.#budget = options.budget ?? null;
    this.#clock = options.clock ?? null;
  }

  get currentState(): ChannelState {
    return this.state;
  }

  /** The Noise handshake hash: the same on both ends of one session, and different for every session. */
  get handshakeHash(): Uint8Array | null {
    return this.#handshakeHash === null ? null : Uint8Array.from(this.#handshakeHash);
  }

  /** Bytes held for a message that has not finished arriving. */
  get bufferedBytes(): number {
    return this.#partBytes;
  }

  /** The clock reading when the unfinished message began, or null. Needs `clock`. */
  get partialMessageSince(): number | null {
    return this.#partialSince;
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
      this.terminate("failed");
      throw error;
    }
  }

  protected abstract receiveFrame(type: FrameType, body: Uint8Array): ChannelEvent[];

  /**
   * Encrypts a text message, split into as many frames as it needs. A message over
   * `MAX_MESSAGE_BYTES` is refused and the channel stays open; a channel without enough
   * messages left on its key fails before sending any.
   */
  sendText(text: string): Uint8Array[] {
    this.#checkOpen();
    // A UTF-16 unit takes at least one UTF-8 byte, so this needs no encoding.
    if (text.length > MAX_MESSAGE_BYTES) {
      fail("message_too_large", `A message is at most ${MAX_MESSAGE_BYTES} bytes.`);
    }
    const bytes = utf8Encode(text);
    if (bytes.length > MAX_MESSAGE_BYTES) {
      fail("message_too_large", `A message is at most ${MAX_MESSAGE_BYTES} bytes.`);
    }
    const records = Math.max(1, Math.ceil(bytes.length / MAX_RECORD_DATA_BYTES));
    if (this.keys!.send.remaining < records) {
      this.terminate("failed");
      fail("nonce_exhausted", "This channel's key cannot send this message.");
    }
    const frames: Uint8Array[] = [];
    for (let offset = 0; offset < bytes.length || frames.length === 0;) {
      const end = Math.min(offset + MAX_RECORD_DATA_BYTES, bytes.length);
      const data = bytes.subarray(offset, end);
      frames.push(
        this.seal(end === bytes.length ? { kind: "text-end", data } : { kind: "text-part", data }),
      );
      offset = end;
    }
    return frames;
  }

  /** A ping the peer answers with a pong carrying the same bytes. */
  ping(data: Uint8Array = new Uint8Array(0)): Uint8Array {
    this.#checkOpen();
    if (data.length > MAX_PING_BYTES)
      fail("malformed", `A ping carries at most ${MAX_PING_BYTES} bytes.`);
    return this.seal({ kind: "ping", data });
  }

  /** Ends the channel with an authenticated close and returns the last frame to send. */
  close(code = 1000, reason = ""): Uint8Array {
    this.#checkOpen();
    const frame = this.seal({ kind: "close", code, reason });
    this.terminate("closed");
    return frame;
  }

  /**
   * Ends the channel at once, for a socket that closed or timed out: it drops the keys, any
   * unfinished message and any pending enrollment. Safe to call in any state, any number of
   * times. Returns true only if an authenticated close or refusal ended the channel first; a
   * socket that ends without one ended abnormally.
   */
  abort(): boolean {
    if (this.state === "closed") return true;
    this.terminate("failed");
    return false;
  }

  /** Encrypts one record. Running out of messages on the key ends the channel. */
  protected seal(record: ChannelRecord): Uint8Array {
    let body: Uint8Array;
    try {
      body = this.keys!.send.encrypt(new Uint8Array(0), encodeRecord(record));
    } catch (error) {
      if ((error as { code?: unknown }).code === "nonce_exhausted") this.terminate("failed");
      throw error;
    }
    return encodeFrame({ type: "transport", body });
  }

  protected open(body: Uint8Array): ChannelRecord {
    return decodeRecord(this.keys!.receive.decrypt(new Uint8Array(0), body));
  }

  protected takeKeys(keys: TransportKeys): void {
    this.keys = keys;
    this.#handshakeHash = Uint8Array.from(keys.handshakeHash);
  }

  /** The one way into `closed` or `failed`: drops keys, buffered text and anything pending. */
  protected terminate(state: "closed" | "failed"): void {
    if (this.state === "closed" || this.state === "failed") return;
    this.state = state;
    this.keys?.send.clear();
    this.keys?.receive.clear();
    this.keys = null;
    this.#dropPartial();
    this.dropPending();
  }

  /** Subclasses wipe what they hold for the handshake. */
  protected dropPending(): void {}

  /** Handles a record on an open channel. */
  protected receiveRecord(record: ChannelRecord): ChannelEvent[] {
    switch (record.kind) {
      case "text-part":
      case "text-end":
        return this.#receiveText(record.kind, record.data);
      case "ping":
        return [{ type: "send", frame: this.seal({ kind: "pong", data: record.data }) }];
      case "pong":
        return [{ type: "pong", data: Uint8Array.from(record.data) }];
      case "close":
        // An authenticated close cancels a message still arriving.
        this.terminate("closed");
        return [{ type: "close", code: record.code, reason: record.reason }];
      case "confirm":
      case "admission":
        return fail("unexpected", `A ${record.kind} record comes once, first.`);
    }
  }

  #receiveText(kind: "text-part" | "text-end", data: Uint8Array): ChannelEvent[] {
    if (this.#clock !== null) {
      const now = this.#clock();
      if (this.#partialSince === null) {
        if (kind === "text-part") this.#partialSince = now;
      } else if (!(now - this.#partialSince <= MAX_PARTIAL_MESSAGE_MS)) {
        fail("unexpected", "The message took too long to arrive.");
      }
    }
    if (this.#partBytes + data.length > MAX_MESSAGE_BYTES) {
      fail("message_too_large", `A message is at most ${MAX_MESSAGE_BYTES} bytes.`);
    }
    if (this.#budget !== null && !this.#budget.take(data.length)) {
      fail("over_budget", "The host has no room for more buffered text.");
    }
    this.#partBytes += data.length;
    this.#parts.push(Uint8Array.from(data));
    if (kind === "text-part") return [];
    const joined = new Uint8Array(this.#partBytes);
    let offset = 0;
    for (const part of this.#parts) {
      joined.set(part, offset);
      offset += part.length;
    }
    this.#dropPartial();
    return [{ type: "text", text: utf8Decode(joined) }];
  }

  #dropPartial(): void {
    for (const part of this.#parts) part.fill(0);
    this.#budget?.give(this.#partBytes);
    this.#parts = [];
    this.#partBytes = 0;
    this.#partialSince = null;
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

export interface InitiatorOptions extends ChannelOptions {
  readonly relayId: string;
  /** The connector's Noise static public key, pinned by the pairing code. */
  readonly connectorKey: Uint8Array;
  /** The phone's own Noise static key pair. */
  readonly staticKey: KeyPair;
  /** The pairing code's enrollment secret, until the phone is enrolled. */
  readonly enroll?: Uint8Array;
  /** Tests only, to replay known ephemeral keys; production uses `crypto.getRandomValues`. */
  readonly random?: RandomBytes;
}

/**
 * The phone's end. Call `start`, send its frame, then feed every frame from the relay to
 * `receive`. It reports `open` only on the connector's admission record.
 */
export class Initiator extends Channel {
  readonly #handshake: IKHandshake;
  readonly #hello: Uint8Array;

  constructor(options: InitiatorOptions) {
    super("idle", options);
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
    try {
      const body = this.#handshake.writeMessage1(this.#hello);
      this.state = "handshaking";
      return encodeFrame({ type: "handshake1", body });
    } catch (error) {
      this.terminate("failed");
      throw error;
    } finally {
      this.#hello.fill(0);
    }
  }

  protected override dropPending(): void {
    this.#hello.fill(0);
  }

  protected receiveFrame(type: FrameType, body: Uint8Array): ChannelEvent[] {
    if (this.state === "handshaking" && type === "handshake2") {
      const answer = decodeAnswer(this.#handshake.readMessage2(body));
      this.takeKeys(this.#handshake.transportKeys);
      if (answer !== "accepted") {
        this.terminate("closed");
        return [{ type: "refused", reason: answer }];
      }
      const confirm = this.seal({ kind: "confirm" });
      this.state = "confirming";
      return [{ type: "send", frame: confirm }];
    }
    if (this.state === "confirming" && type === "transport") {
      const record = this.open(body);
      if (record.kind !== "admission") {
        fail("unexpected", "The connector's first record must be its admission.");
      }
      if (record.answer !== "accepted") {
        this.terminate("closed");
        return [{ type: "refused", reason: record.answer }];
      }
      this.state = "open";
      return [{ type: "open" }];
    }
    if (this.state === "open" && type === "transport") return this.receiveRecord(this.open(body));
    return fail("unexpected", `A ${type} frame is not expected now.`);
  }
}

export interface ResponderOptions extends ChannelOptions {
  readonly relayId: string;
  /** The connector's Noise static key pair. */
  readonly staticKey: KeyPair;
  readonly gate: PhoneGate;
  /** Tests only, to replay known ephemeral keys; production uses `crypto.getRandomValues`. */
  readonly random?: RandomBytes;
}

/**
 * The connector's end, one per relayed session. Feed it every frame from the relay.
 *
 * At message 1 it asks the gate, read-only, and answers; an "accepted" answer is provisional.
 * When the phone's confirm record arrives it reports `admit` with the phone's key and secret.
 * The host then rechecks and, in one transaction, spends the offer and adds the key (or finds
 * the key still enrolled), and calls `admit()`, which returns the admission frame and opens the
 * channel, or `refuse()`. Act only on the key `admit()` returns, and open no gateway socket
 * before it. Call `abort()` when the socket ends or the host gives up waiting.
 */
export class Responder extends Channel {
  readonly #handshake: IKHandshake;
  readonly #gate: PhoneGate;
  /** The phone's key as message 1 authenticated it; never handed out, only copies. */
  #phoneKey: Uint8Array | null = null;
  #enroll: Uint8Array | null = null;

  constructor(options: ResponderOptions) {
    super("handshaking", options);
    this.#gate = options.gate;
    this.#handshake = new IKHandshake({
      initiator: false,
      prologue: channelPrologue(options.relayId),
      staticKey: options.staticKey,
      ...(options.random ? { random: options.random } : {}),
    });
  }

  /** A copy of the phone's Noise static key, once handshake message 1 is read. */
  get phoneKey(): Uint8Array | null {
    return this.#phoneKey === null ? null : Uint8Array.from(this.#phoneKey);
  }

  /**
   * Admits the phone after the host committed its enrollment, or found it still enrolled.
   * Returns the admission frame to send and a copy of the admitted key.
   */
  admit(): { readonly frame: Uint8Array; readonly phoneKey: Uint8Array } {
    this.#checkAdmitting();
    const phoneKey = Uint8Array.from(this.#phoneKey!);
    const frame = this.seal({ kind: "admission", answer: "accepted" });
    this.dropPending();
    this.state = "open";
    return { frame, phoneKey };
  }

  /** Turns the phone away after all. Returns the frame to send; the channel is closed. */
  refuse(reason: Refusal): Uint8Array {
    this.#checkAdmitting();
    const frame = this.seal({ kind: "admission", answer: reason });
    this.terminate("closed");
    return frame;
  }

  #checkAdmitting(): void {
    if (this.state !== "admitting") fail("unexpected", "No phone is waiting for admission.");
  }

  protected override dropPending(): void {
    this.#enroll?.fill(0);
    this.#enroll = null;
  }

  protected receiveFrame(type: FrameType, body: Uint8Array): ChannelEvent[] {
    if (this.state === "handshaking" && type === "handshake1") {
      const payload = this.#handshake.readMessage1(body);
      const hello = decodeHello(payload);
      payload.fill(0);
      this.#phoneKey = this.#handshake.remoteStaticKey!;
      this.#enroll = hello.enroll ?? null;
      const check = this.#gate.check(
        Uint8Array.from(this.#phoneKey),
        this.#enroll === null ? undefined : Uint8Array.from(this.#enroll),
      );
      const answer: Answer = check === "enrolled" || check === "eligible" ? "accepted" : check;
      const frame = encodeFrame({
        type: "handshake2",
        body: this.#handshake.writeMessage2(encodeAnswer(answer)),
      });
      this.takeKeys(this.#handshake.transportKeys);
      if (answer !== "accepted") {
        this.terminate("closed");
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
      this.state = "admitting";
      return [
        {
          type: "admit",
          phoneKey: Uint8Array.from(this.#phoneKey!),
          enroll: this.#enroll === null ? null : Uint8Array.from(this.#enroll),
        },
      ];
    }
    if (this.state === "open" && type === "transport") return this.receiveRecord(this.open(body));
    return fail("unexpected", `A ${type} frame is not expected now.`);
  }
}
