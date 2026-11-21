// Bounded reassembly, a shared receive budget, the partial-message deadline, and ending a
// channel: exhaustion, abort and close.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeRecord,
  encodeFrame,
  encodeRecord,
  generateKeyPair,
  Initiator,
  MAX_MESSAGE_BYTES,
  MAX_PARTIAL_MESSAGE_MS,
  MAX_RECORD_DATA_BYTES,
  MAX_TEXT_RECORDS,
  ReceiveBudget,
  RelayProtocolError,
  Responder,
  type ChannelOptions,
  type ChannelRecord,
  type TransportKeys,
} from "../src/index.ts";
import { CipherState } from "../src/noise.ts";
import { deliver, makePair, openPair, RELAY_ID, TestGate, type Pair } from "./helpers.ts";

afterEach(() => vi.restoreAllMocks());

/** A pair whose connector takes the given options. */
function pairWith(options: ChannelOptions, gate = new TestGate()): Pair {
  const phoneKey = generateKeyPair();
  const connectorKey = generateKeyPair();
  gate.enrolled.push(Uint8Array.from(phoneKey.publicKey));
  const phone = new Initiator({
    relayId: RELAY_ID,
    connectorKey: connectorKey.publicKey,
    staticKey: phoneKey,
  });
  const connector = new Responder({ relayId: RELAY_ID, staticKey: connectorKey, gate, ...options });
  const pair = { phone, connector, gate, phoneKey, connectorKey };
  openPair(pair);
  return pair;
}

function keysOf(channel: Initiator | Responder): TransportKeys {
  return (channel as unknown as { keys: TransportKeys }).keys;
}

const TWO_RECORDS = "x".repeat(MAX_RECORD_DATA_BYTES + 1);

/**
 * Seals records one at a time in the sender's order, the way a peer may interleave them; the
 * channel's own `sendText` makes all of a message's records at once.
 */
function sealAs(channel: Initiator | Responder, record: ChannelRecord): Uint8Array {
  return encodeFrame({
    type: "transport",
    body: keysOf(channel).send.encrypt(new Uint8Array(0), encodeRecord(record)),
  });
}
const FULL_PART: ChannelRecord = {
  kind: "text-part",
  data: new Uint8Array(MAX_RECORD_DATA_BYTES).fill(120),
};

describe("reassembly bounds", () => {
  it("a text-part record must be a full record, so a message takes at most 401 records", () => {
    expect(MAX_TEXT_RECORDS).toBe(401);
    for (const length of [1, MAX_RECORD_DATA_BYTES - 1]) {
      expect(() => decodeRecord(Uint8Array.of(2, ...new Uint8Array(length)))).toThrow(
        RelayProtocolError,
      );
      expect(() => encodeRecord({ kind: "text-part", data: new Uint8Array(length) })).toThrow(
        RelayProtocolError,
      );
    }
    const pair = makePair();
    openPair(pair);
    expect(pair.phone.sendText("x".repeat(MAX_MESSAGE_BYTES))).toHaveLength(MAX_TEXT_RECORDS);
  });

  it("refuses an oversize string before encoding it", () => {
    const pair = makePair();
    openPair(pair);
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    expect(() => pair.phone.sendText("x".repeat(MAX_MESSAGE_BYTES + 1))).toThrow(
      expect.objectContaining({ code: "message_too_large" }),
    );
    expect(encode).not.toHaveBeenCalled();
  });

  it("shares one receive budget across channels and gives it back", () => {
    const budget = new ReceiveBudget(MAX_RECORD_DATA_BYTES + 10);
    const a = pairWith({ budget });
    const b = pairWith({ budget });
    const [aPart, aEnd] = a.phone.sendText(TWO_RECORDS);
    const [bPart] = b.phone.sendText(TWO_RECORDS);
    expect(a.connector.receive(aPart!)).toEqual([]);
    expect(budget.usedBytes).toBe(MAX_RECORD_DATA_BYTES);
    expect(a.connector.bufferedBytes).toBe(MAX_RECORD_DATA_BYTES);
    expect(() => b.connector.receive(bPart!)).toThrow(
      expect.objectContaining({ code: "over_budget" }),
    );
    expect(b.connector.currentState).toBe("failed");
    expect(a.connector.receive(aEnd!)).toEqual([{ type: "text", text: TWO_RECORDS }]);
    expect(budget.usedBytes).toBe(0);
    // Ending a channel mid-message gives its share back.
    const [again] = a.phone.sendText(TWO_RECORDS);
    a.connector.receive(again!);
    expect(budget.usedBytes).toBe(MAX_RECORD_DATA_BYTES);
    a.connector.abort();
    expect(budget.usedBytes).toBe(0);
  });

  it("fails a message still unfinished after MAX_PARTIAL_MESSAGE_MS by the host's clock", () => {
    let now = 1_000;
    const pair = pairWith({ clock: () => now });
    pair.connector.receive(sealAs(pair.phone, FULL_PART));
    expect(pair.connector.partialMessageSince).toBe(1_000);
    // Keep-alives in between do not extend it.
    now += MAX_PARTIAL_MESSAGE_MS;
    const [pong] = pair.connector.receive(
      sealAs(pair.phone, { kind: "ping", data: new Uint8Array(0) }),
    );
    if (pong?.type !== "send") throw new Error("No pong.");
    now += 1;
    const end = sealAs(pair.phone, { kind: "text-end", data: Uint8Array.of(120) });
    expect(() => pair.connector.receive(end)).toThrow(RelayProtocolError);
    expect(pair.connector.currentState).toBe("failed");
    expect(pair.connector.bufferedBytes).toBe(0);
  });

  it("accepts a message finished exactly at the deadline", () => {
    let now = 0;
    const pair = pairWith({ clock: () => now });
    const [part, end] = pair.phone.sendText(TWO_RECORDS);
    pair.connector.receive(part!);
    now = MAX_PARTIAL_MESSAGE_MS;
    expect(pair.connector.receive(end!)).toEqual([{ type: "text", text: TWO_RECORDS }]);
    expect(pair.connector.partialMessageSince).toBeNull();
  });
});

describe("ending a channel", () => {
  it("a send the key cannot finish fails the channel before any frame is made", () => {
    const pair = makePair();
    openPair(pair);
    CipherState.leaveRemainingForTests(keysOf(pair.phone).send, 1);
    const encrypt = vi.spyOn(CipherState.prototype, "encrypt");
    expect(() => pair.phone.sendText(TWO_RECORDS)).toThrow(
      expect.objectContaining({ code: "nonce_exhausted" }),
    );
    // Nothing was encrypted: the record count was checked first.
    expect(encrypt).not.toHaveBeenCalled();
    expect(pair.phone.currentState).toBe("failed");
    expect(keysOf(pair.phone)).toBeNull();
    expect(() => pair.phone.sendText("x")).toThrow(expect.objectContaining({ code: "failed" }));
  });

  it("running out of messages on a ping or close fails the channel too", () => {
    for (const send of [(p: Pair) => p.phone.ping(), (p: Pair) => p.phone.close()]) {
      const pair = makePair();
      openPair(pair);
      CipherState.leaveRemainingForTests(keysOf(pair.phone).send, 0);
      expect(() => send(pair)).toThrow(expect.objectContaining({ code: "nonce_exhausted" }));
      expect(pair.phone.currentState).toBe("failed");
      expect(keysOf(pair.phone)).toBeNull();
    }
  });

  it("the last message a key allows still goes", () => {
    const pair = makePair();
    openPair(pair);
    CipherState.leaveRemainingForTests(keysOf(pair.phone).send, 1);
    CipherState.leaveRemainingForTests(keysOf(pair.connector).receive, 1);
    expect(deliver(pair.connector, pair.phone.sendText("last"))).toEqual([
      { type: "text", text: "last" },
    ]);
  });

  it("abort is safe in any state, any number of times, and tells an authenticated close apart", () => {
    const pair = makePair();
    expect(pair.phone.abort()).toBe(false);
    expect(pair.phone.abort()).toBe(false);
    expect(pair.phone.currentState).toBe("failed");

    const open = makePair();
    openPair(open);
    expect(open.phone.abort()).toBe(false);
    expect(keysOf(open.phone)).toBeNull();

    const closed = makePair();
    openPair(closed);
    closed.phone.receive(closed.connector.close(1000, "done"));
    expect(closed.connector.abort()).toBe(true);
    expect(closed.phone.abort()).toBe(true);
    expect(closed.phone.currentState).toBe("closed");
  });

  it("an authenticated close in the middle of a message cancels it", () => {
    const pair = makePair();
    openPair(pair);
    pair.connector.receive(sealAs(pair.phone, FULL_PART));
    expect(pair.connector.bufferedBytes).toBe(MAX_RECORD_DATA_BYTES);
    const close = sealAs(pair.phone, { kind: "close", code: 4000, reason: "bye" });
    expect(pair.connector.receive(close)).toEqual([{ type: "close", code: 4000, reason: "bye" }]);
    expect(pair.connector.bufferedBytes).toBe(0);
  });
});
