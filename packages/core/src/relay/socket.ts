// A WebSocketLike that reaches a gateway through Clawtrate's relay. Underneath is one ordinary
// WebSocket to the relay's dial address. Once the relay splices it to the connector's session,
// the phone runs the Noise IK channel from `@clawtrate/relay-protocol` as the initiator, with
// the connector's static key pinned by the route; the gateway's own text frames travel inside
// that channel unchanged, so the gateway's pairing, approvals and scopes decide everything.
//
// It reports open only on the connector's admission record, which comes after the connector
// has checked (and, on a first pairing, committed) this phone's enrollment. Every way it ends
// aborts the channel, which wipes its keys and anything half received.

import {
  decodeRelayToEndpoint,
  Initiator,
  isSendableCloseCode,
  MAX_MESSAGE_BYTES,
  RELAY_PONG,
  ReceiveBudget,
  RelayProtocolError,
  type ChannelEvent,
  type KeyPair,
  type RandomBytes,
  type Refusal,
} from "@clawtrate/relay-protocol";
import type { WebSocketLike } from "../host.ts";
import { connectorKeyBytes, relayDialUrl, type RelayRoute } from "./route.ts";

/**
 * The socket to the relay: a WHATWG WebSocket that can send and receive binary messages.
 * Browsers, Node 22+ and React Native provide it; the host sets nothing up beyond `new`.
 */
export type RelayTransport = {
  readonly readyState: number;
  binaryType?: string;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export type RelayTransportFactory = (url: string) => RelayTransport;

/**
 * Close codes a RelaySocket reports for its own reasons. A close the connector sends inside the
 * channel (the gateway's own close, bridged) is reported with the connector's code and reason.
 */
export const RELAY_CLOSE = {
  /** The transport to the relay ended without an authenticated close. */
  abnormal: 1006,
  /** The connector does not know this phone. Permanent. */
  notEnrolled: 4401,
  /** The connector refused the enrollment secret: spent, expired or wrong. Permanent. */
  enrollmentRefused: 4403,
  /** A frame failed: tampered, replayed, out of order, or from another key than the pinned one. */
  protocol: 4400,
  /** The channel did not open in time, or a message stayed unfinished past its deadline. */
  timedOut: 4408,
  /** A message larger than a relay channel carries, or no room left in the receive budget. */
  tooLarge: 4413,
  /** The relay reported an error; the reason is `relay:<code>`. */
  relayError: 4502,
} as const;

/** True for a close the connector made because of who this phone is: retrying will not help. */
export function isPermanentRelayClose(code: number): boolean {
  return code === RELAY_CLOSE.notEnrolled || code === RELAY_CLOSE.enrollmentRefused;
}

/** How long the relay, the splice, the handshake and the admission may take together. */
export const RELAY_OPEN_TIMEOUT_MS = 15_000;

/**
 * One buffered-text budget for every relay channel in the process, unless the host gives its
 * own: room for one message of the largest size while it is joined (two copies).
 */
export const DEFAULT_RELAY_RECEIVE_BUDGET = new ReceiveBudget(2 * MAX_MESSAGE_BYTES);

export type RelayTimers = {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

export type RelaySocketOptions = {
  readonly route: RelayRoute;
  /** The phone's Noise static key pair, or a promise of it while the host loads it. */
  readonly staticKey: KeyPair | Promise<KeyPair>;
  /** The pairing code's enrollment secret, until the phone is enrolled. Copied, then wiped. */
  readonly enroll?: Uint8Array | null;
  readonly createTransport: RelayTransportFactory;
  /** Called once, when a connector admits the phone on a channel that carried `enroll`. */
  readonly onAdmitted?: () => void;
  /** Shared by the host's relay channels; `DEFAULT_RELAY_RECEIVE_BUDGET` otherwise. */
  readonly budget?: ReceiveBudget;
  /**
   * The host's monotonic clock in whole milliseconds, for the partial-message deadline. By
   * default `Date.now()`, held so that it never goes back.
   */
  readonly clock?: () => number;
  readonly timers?: RelayTimers;
  readonly openTimeoutMs?: number;
  /** Tests only: known ephemeral keys. */
  readonly random?: RandomBytes;
};

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

const globalTimers: RelayTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

function heldClock(): () => number {
  let last = 0;
  return () => (last = Math.max(last, Date.now()));
}

/** A binary message from the relay as bytes, or null if it is not binary. */
function bytesOf(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

type Ending = { code: number; reason: string };

export class RelaySocket implements WebSocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  readonly #route: RelayRoute;
  readonly #connectorKey: Uint8Array;
  readonly #createTransport: RelayTransportFactory;
  readonly #onAdmitted: (() => void) | null;
  readonly #budget: ReceiveBudget;
  readonly #clock: () => number;
  readonly #timers: RelayTimers;
  readonly #random: RandomBytes | null;
  #enroll: Uint8Array | null;
  /** This channel carries an enrollment secret: its admission is the phone's enrollment. */
  #enrolling = false;
  #state = CONNECTING;
  #transport: RelayTransport | null = null;
  #channel: Initiator | null = null;
  #openTimer: unknown = null;
  #partialTimer: unknown = null;
  #partialDeadline: number | null = null;

  constructor(options: RelaySocketOptions) {
    const key = connectorKeyBytes(options.route.connectorKey);
    if (key === null) throw new Error("The route's connector key is not a key.");
    this.#route = options.route;
    this.#connectorKey = key;
    this.#createTransport = options.createTransport;
    this.#onAdmitted = options.onAdmitted ?? null;
    this.#budget = options.budget ?? DEFAULT_RELAY_RECEIVE_BUDGET;
    this.#clock = options.clock ?? heldClock();
    this.#timers = options.timers ?? globalTimers;
    this.#random = options.random ?? null;
    this.#enroll = options.enroll ? Uint8Array.from(options.enroll) : null;
    this.#openTimer = this.#timers.set(
      () => this.#fail(RELAY_CLOSE.timedOut, "The relay route did not open in time."),
      options.openTimeoutMs ?? RELAY_OPEN_TIMEOUT_MS,
    );
    void Promise.resolve(options.staticKey).then(
      (staticKey) => this.#dial(staticKey),
      () => this.#fail(RELAY_CLOSE.protocol, "This device's relay key could not be loaded."),
    );
  }

  get readyState(): number {
    return this.#state;
  }

  /** The route this socket reaches. */
  get route(): RelayRoute {
    return this.#route;
  }

  /** Sends one gateway text frame through the channel. */
  send(data: string): void {
    if (this.#state === CONNECTING) throw new Error("The relay route is not open yet.");
    if (this.#state !== OPEN || this.#channel === null) return;
    let frames: Uint8Array[];
    try {
      frames = this.#channel.sendText(String(data));
    } catch (error) {
      // Too large for a channel: refused, and the channel stays open, as a WebSocket would.
      if (error instanceof RelayProtocolError && error.code === "message_too_large") throw error;
      this.#failFrom(error);
      return;
    }
    this.#write(frames);
  }

  /**
   * Ends the route. An open channel sends the connector an authenticated close first, so the
   * connector closes the gateway's socket with the same code.
   */
  close(code = 1000, reason = ""): void {
    if (this.#state === CLOSING || this.#state === CLOSED) return;
    const sendable = isSendableCloseCode(code) ? code : 1000;
    if (this.#state === OPEN && this.#channel !== null) {
      let frame: Uint8Array | null = null;
      try {
        frame = this.#channel.close(sendable, reason);
      } catch {
        // A reason over the limit, say: the transport closes without it.
      }
      if (frame !== null) this.#write([frame]);
    }
    this.#finish({ code: sendable, reason });
  }

  #dial(staticKey: KeyPair): void {
    if (this.#state !== CONNECTING) return;
    let transport: RelayTransport;
    try {
      this.#channel = new Initiator({
        relayId: this.#route.relayId,
        connectorKey: this.#connectorKey,
        staticKey,
        ...(this.#enroll ? { enroll: this.#enroll } : {}),
        budget: this.#budget,
        clock: this.#clock,
        ...(this.#random ? { random: this.#random } : {}),
      });
      // The channel holds its own copy until its first frame is written.
      this.#enrolling = this.#enroll !== null;
      this.#wipeEnroll();
      transport = this.#createTransport(relayDialUrl(this.#route));
    } catch (error) {
      this.#failFrom(error);
      return;
    }
    this.#transport = transport;
    transport.binaryType = "arraybuffer";
    transport.onmessage = (event) => this.#receive(event.data);
    transport.onclose = () => this.#transportClosed();
    transport.onerror = () => {
      // The close that follows ends the route; the error says nothing more.
    };
  }

  #receive(data: unknown): void {
    if (this.#state === CLOSING || this.#state === CLOSED || this.#channel === null) return;
    if (typeof data === "string") {
      this.#receiveRelay(data);
      return;
    }
    const bytes = bytesOf(data);
    if (bytes === null) {
      this.#fail(RELAY_CLOSE.protocol, "The relay sent something that is not a frame.");
      return;
    }
    let events: ChannelEvent[];
    try {
      events = this.#channel.receive(bytes);
    } catch (error) {
      this.#failFrom(error);
      return;
    }
    this.#armPartialTimer();
    for (const event of events) {
      if (this.#state === CLOSING || this.#state === CLOSED) return;
      this.#handle(event);
    }
  }

  #receiveRelay(text: string): void {
    let message;
    try {
      message = decodeRelayToEndpoint(text);
    } catch {
      this.#fail(RELAY_CLOSE.protocol, "The relay sent a message this route does not take.");
      return;
    }
    switch (message.t) {
      case "open": {
        // The relay spliced this socket to the connector's session: start the handshake once.
        if (this.#channel!.currentState !== "idle") {
          this.#fail(RELAY_CLOSE.protocol, "The relay opened the session twice.");
          return;
        }
        let frame: Uint8Array;
        try {
          frame = this.#channel!.start();
        } catch (error) {
          this.#failFrom(error);
          return;
        }
        this.#write([frame]);
        return;
      }
      case "error":
        this.#fail(RELAY_CLOSE.relayError, `relay:${message.code}`);
        return;
      case "ping":
        this.#write([RELAY_PONG]);
        return;
      case "pong":
        return;
    }
  }

  #handle(event: ChannelEvent): void {
    switch (event.type) {
      case "send":
        this.#write([event.frame]);
        return;
      case "open": {
        this.#state = OPEN;
        this.#clearOpenTimer();
        if (this.#enrolling) this.#emit(() => this.#onAdmitted?.());
        this.#emit(() => this.onopen?.({}));
        return;
      }
      case "text":
        this.#emit(() => this.onmessage?.({ data: event.text }));
        return;
      case "pong":
        return;
      case "close":
        this.#finish({ code: event.code, reason: event.reason });
        return;
      case "refused":
        this.#finish(refusalEnding(event.reason));
        return;
      case "admit":
        // Only a connector's channel admits; the initiator never reports it.
        this.#fail(RELAY_CLOSE.protocol, "Unexpected admission request.");
        return;
    }
  }

  /** Writes frames in order; the first write that fails ends the route. */
  #write(frames: readonly (Uint8Array | string)[]): void {
    const transport = this.#transport;
    if (transport === null) return;
    try {
      for (const frame of frames) transport.send(frame);
    } catch {
      this.#fail(RELAY_CLOSE.abnormal, "The relay connection could not be written to.");
    }
  }

  /**
   * Once a message begins, a timer for just after its deadline: a connector that goes quiet
   * mid-message sends nothing for the channel to check.
   */
  #armPartialTimer(): void {
    const deadline = this.#channel?.partialMessageDeadline ?? null;
    if (deadline === this.#partialDeadline) return;
    this.#clearPartialTimer();
    this.#partialDeadline = deadline;
    if (deadline === null) return;
    const wait = Math.max(0, deadline + 1 - this.#clock());
    this.#partialTimer = this.#timers.set(() => {
      this.#partialTimer = null;
      try {
        if (this.#channel?.expirePartialMessage()) {
          this.#fail(RELAY_CLOSE.timedOut, "A message took too long to arrive.");
        } else {
          // Not past it yet by the channel's own reading: look again.
          this.#partialDeadline = null;
          this.#armPartialTimer();
        }
      } catch (error) {
        this.#failFrom(error);
      }
    }, wait);
  }

  #transportClosed(): void {
    if (this.#state === CLOSED) return;
    // No authenticated close came first, whatever code the relay's socket carried.
    this.#finish({ code: RELAY_CLOSE.abnormal, reason: "The relay connection ended." });
  }

  #failFrom(error: unknown): void {
    const code = error instanceof RelayProtocolError ? error.code : null;
    if (code === "timed_out") {
      this.#fail(RELAY_CLOSE.timedOut, "A message took too long to arrive.");
    } else if (code === "message_too_large" || code === "over_budget") {
      this.#fail(RELAY_CLOSE.tooLarge, "A message was too large for this relay route.");
    } else {
      this.#fail(RELAY_CLOSE.protocol, "The relay channel failed.");
    }
  }

  #fail(code: number, reason: string): void {
    this.#finish({ code, reason });
  }

  /** The one way to CLOSED: abort the channel, stop the timers, close the transport, tell the host. */
  #finish(ending: Ending): void {
    if (this.#state === CLOSED) return;
    this.#state = CLOSED;
    this.#channel?.abort();
    this.#channel = null;
    this.#wipeEnroll();
    this.#clearOpenTimer();
    this.#clearPartialTimer();
    const transport = this.#transport;
    this.#transport = null;
    if (transport !== null) {
      transport.onmessage = null;
      transport.onclose = null;
      transport.onerror = null;
      try {
        transport.close(1000);
      } catch {
        // Already closed.
      }
    }
    this.#emit(() => this.onclose?.(ending));
  }

  /** Host callbacks run after the current step, as a WebSocket's events do, and never throw back in. */
  #emit(callback: () => void): void {
    void Promise.resolve()
      .then(callback)
      .catch(() => {});
  }

  #wipeEnroll(): void {
    this.#enroll?.fill(0);
    this.#enroll = null;
  }

  #clearOpenTimer(): void {
    if (this.#openTimer !== null) this.#timers.clear(this.#openTimer);
    this.#openTimer = null;
  }

  #clearPartialTimer(): void {
    if (this.#partialTimer !== null) this.#timers.clear(this.#partialTimer);
    this.#partialTimer = null;
    this.#partialDeadline = null;
  }
}

function refusalEnding(reason: Refusal): Ending {
  return reason === "not_enrolled"
    ? { code: RELAY_CLOSE.notEnrolled, reason: "This phone is not enrolled with the connector." }
    : {
        code: RELAY_CLOSE.enrollmentRefused,
        reason: "The connector refused this pairing code: it was used, expired or wrong.",
      };
}
