// RelaySocket against R1's responder in process: it opens only on the connector's admission,
// carries text both ways up to the channel's limits, and every way it ends aborts the channel.

import { describe, expect, it } from "vitest";
import {
  generateKeyPair,
  MAX_MESSAGE_BYTES,
  MAX_PARTIAL_MESSAGE_MS,
  MAX_RECORD_DATA_BYTES,
  ReceiveBudget,
  RelayProtocolError,
  type KeyPair,
} from "@clawtrate/relay-protocol";
import { isPermanentRelayClose, RELAY_CLOSE, RelaySocket } from "../src/relay/socket.ts";
import {
  flush,
  ManualTime,
  RELAY_ID,
  routeFor,
  sealAs,
  TestConnector,
  TestRelay,
} from "./relay-harness.ts";
import { until } from "./fake-gateway.ts";

const SECRET = new Uint8Array(32).fill(9);
const FULL_PART = new Uint8Array(MAX_RECORD_DATA_BYTES).fill(122);

type Setup = {
  connector?: TestConnector;
  phoneKey?: KeyPair;
  enroll?: Uint8Array | null;
  pinned?: Uint8Array;
  budget?: ReceiveBudget;
  time?: ManualTime;
  openTimeoutMs?: number;
};

function setup(options: Setup = {}) {
  const connector = options.connector ?? new TestConnector();
  const relay = new TestRelay(connector);
  const phoneKey = options.phoneKey ?? generateKeyPair();
  const enroll = options.enroll === undefined ? SECRET : options.enroll;
  if (enroll !== null && connector.offers.length === 0) connector.addOffer(SECRET);
  const events: string[] = [];
  const texts: string[] = [];
  const closes: { code: number; reason: string }[] = [];
  let admitted = 0;
  const socket = new RelaySocket({
    route: routeFor(options.pinned ?? connector.staticKey.publicKey),
    staticKey: Promise.resolve(phoneKey),
    enroll,
    createTransport: relay.createTransport,
    onAdmitted: () => (admitted += 1),
    ...(options.budget ? { budget: options.budget } : {}),
    ...(options.time ? { timers: options.time, clock: options.time.clock } : {}),
    ...(options.openTimeoutMs ? { openTimeoutMs: options.openTimeoutMs } : {}),
  });
  socket.onopen = () => events.push("open");
  socket.onmessage = (event) => texts.push(event.data as string);
  socket.onclose = (event) => {
    events.push("close");
    closes.push(event);
  };
  return {
    socket,
    relay,
    connector,
    phoneKey,
    events,
    texts,
    closes,
    admitted: () => admitted,
  };
}

async function opened(options: Setup = {}) {
  const ctx = setup(options);
  await until(() => ctx.socket.readyState === 1);
  await flush();
  return ctx;
}

describe("RelaySocket: opening", () => {
  it("dials the route's relay id and opens on the connector's admission", async () => {
    const ctx = setup();
    expect(ctx.socket.readyState).toBe(0);
    expect(() => ctx.socket.send("too soon")).toThrow(/not open/);
    await until(() => ctx.events.includes("open"));
    expect(ctx.relay.last.url).toBe(`wss://relay.example.test/v1/dial/${RELAY_ID}`);
    expect(ctx.relay.last.binaryType).toBe("arraybuffer");
    // The connector committed the enrollment before it sent the admission.
    expect(ctx.connector.enrolled).toEqual([ctx.phoneKey.publicKey]);
    expect(ctx.connector.offers[0]!.offer.used).toBe(true);
    expect(ctx.admitted()).toBe(1);
  });

  it("does not report open before the admission record, however long the connector takes", async () => {
    const connector = new TestConnector();
    connector.holdAdmission = true;
    const ctx = setup({ connector });
    await until(() => connector.received.some((event) => event.type === "admit"));
    await flush();
    // Message 2 said "accepted", provisionally; the phone still waits.
    expect(ctx.socket.readyState).toBe(0);
    expect(ctx.events).toEqual([]);
    connector.admitNow();
    await until(() => ctx.events.includes("open"));
  });

  it("an enrolled phone opens without a secret and reports no admission", async () => {
    const connector = new TestConnector();
    const phoneKey = generateKeyPair();
    connector.enrolled.push(phoneKey.publicKey);
    const ctx = await opened({ connector, phoneKey, enroll: null });
    expect(ctx.events).toEqual(["open"]);
    expect(ctx.admitted()).toBe(0);
  });

  it("answers the relay's keep-alive", async () => {
    const ctx = await opened();
    ctx.relay.last.deliver('{"t":"ping"}');
    expect(ctx.relay.pongs).toEqual(['{"t":"pong"}']);
  });
});

describe("RelaySocket: refusals", () => {
  it("a connector pinned by another key is never reached: the phone does not open", async () => {
    const other = generateKeyPair();
    const ctx = setup({ pinned: other.publicKey });
    await until(() => ctx.events.includes("close"));
    expect(ctx.events).toEqual(["close"]);
    expect(ctx.connector.errors[0]).toBeInstanceOf(RelayProtocolError);
    expect((ctx.connector.errors[0] as RelayProtocolError).code).toBe("decrypt_failed");
    expect(ctx.connector.enrolled).toEqual([]);
    expect(ctx.connector.offers[0]!.offer.used).toBe(false);
  });

  it("an unknown phone without a secret is refused for good", async () => {
    const ctx = setup({ enroll: null });
    await until(() => ctx.events.includes("close"));
    expect(ctx.closes[0]!.code).toBe(RELAY_CLOSE.notEnrolled);
    expect(isPermanentRelayClose(ctx.closes[0]!.code)).toBe(true);
    expect(ctx.events).toEqual(["close"]);
  });

  it("an expired enrollment secret is refused for good", async () => {
    const connector = new TestConnector();
    connector.addOffer(SECRET, connector.nowMs + 10);
    connector.nowMs += 10;
    const ctx = setup({ connector });
    await until(() => ctx.events.includes("close"));
    expect(ctx.closes[0]!.code).toBe(RELAY_CLOSE.enrollmentRefused);
    expect(isPermanentRelayClose(ctx.closes[0]!.code)).toBe(true);
    expect(connector.enrolled).toEqual([]);
  });

  it("a replayed enrollment secret, already spent by one phone, is refused to another", async () => {
    const connector = new TestConnector();
    const first = await opened({ connector });
    expect(connector.enrolled).toHaveLength(1);
    first.socket.close();
    const second = setup({ connector });
    await until(() => second.events.includes("close"));
    expect(second.closes[0]!.code).toBe(RELAY_CLOSE.enrollmentRefused);
    expect(connector.enrolled).toHaveLength(1);
  });

  it("a secret the connector never offered is refused", async () => {
    const connector = new TestConnector();
    connector.addOffer(new Uint8Array(32).fill(1));
    const ctx = setup({ connector });
    await until(() => ctx.events.includes("close"));
    expect(ctx.closes[0]!.code).toBe(RELAY_CLOSE.enrollmentRefused);
  });

  it("a relay error ends the route with the relay's code", async () => {
    const ctx = setup();
    ctx.relay.autoSplice = false;
    await until(() => ctx.relay.transports.length === 1 && ctx.relay.last.readyState === 1);
    ctx.relay.last.deliver('{"t":"error","code":"connector_offline"}');
    await until(() => ctx.events.includes("close"));
    expect(ctx.closes[0]).toEqual({
      code: RELAY_CLOSE.relayError,
      reason: "relay:connector_offline",
    });
    expect(isPermanentRelayClose(ctx.closes[0]!.code)).toBe(false);
  });
});

describe("RelaySocket: text", () => {
  it("carries gateway frames both ways unchanged, empty and multi-byte included", async () => {
    const ctx = await opened();
    for (const text of ["", '{"type":"req","id":"1","method":"health"}', "ünïcødé 🦞"]) {
      ctx.socket.send(text);
    }
    await until(() => ctx.texts.length === 3);
    expect(ctx.texts).toEqual(["", '{"type":"req","id":"1","method":"health"}', "ünïcødé 🦞"]);
  });

  it("carries the largest message in each direction, and refuses one byte more", async () => {
    const ctx = await opened();
    const largest = "x".repeat(MAX_MESSAGE_BYTES);
    const lengths: number[] = [];
    ctx.connector.onText = (text) => lengths.push(text.length);
    ctx.socket.send(largest);
    await until(() => lengths.length === 1, 20_000);
    expect(lengths).toEqual([MAX_MESSAGE_BYTES]);
    ctx.connector.sendText(largest);
    await until(() => ctx.texts.length === 1, 20_000);
    expect(ctx.texts[0]!.length).toBe(MAX_MESSAGE_BYTES);
    // One more byte is refused before anything is sent, and the route stays open.
    expect(() => ctx.socket.send(`${largest}x`)).toThrow(RelayProtocolError);
    expect(ctx.socket.readyState).toBe(1);
    ctx.socket.send("still open");
    await until(() => lengths.length === 2);
  }, 60_000);
});

describe("RelaySocket: every end aborts the channel", () => {
  it("the person's close sends an authenticated close, and the connector sees its code", async () => {
    const ctx = await opened();
    ctx.socket.close(4000, "bye");
    expect(ctx.socket.readyState).toBe(3);
    await until(() => ctx.connector.received.some((event) => event.type === "close"));
    expect(ctx.connector.received.find((event) => event.type === "close")).toEqual({
      type: "close",
      code: 4000,
      reason: "bye",
    });
    expect(ctx.relay.last.closedWith).not.toBeNull();
    await until(() => ctx.events.includes("close"));
    expect(ctx.closes).toEqual([{ code: 4000, reason: "bye" }]);
    // Nothing more is sent on a closed route.
    ctx.socket.send("after");
    expect(ctx.relay.last.sent.at(-1)).not.toBe("after");
  });

  it("the connector's authenticated close is reported with its code", async () => {
    const ctx = await opened();
    ctx.connector.close(1011, "gateway closed");
    await until(() => ctx.events.includes("close"));
    expect(ctx.closes).toEqual([{ code: 1011, reason: "gateway closed" }]);
  });

  it("a transport that ends without an authenticated close is abnormal, whatever its code", async () => {
    const ctx = await opened();
    ctx.relay.last.drop(1000);
    await until(() => ctx.events.includes("close"));
    expect(ctx.closes[0]!.code).toBe(RELAY_CLOSE.abnormal);
  });

  it("a transport lost mid-message gives the buffered part back to the budget", async () => {
    const budget = new ReceiveBudget(10 * MAX_RECORD_DATA_BYTES);
    const ctx = await opened({ budget });
    const frames = ctx.connector.channel!.sendText("y".repeat(MAX_RECORD_DATA_BYTES + 5));
    ctx.connector.deliver(frames[0]!);
    await until(() => budget.usedBytes === MAX_RECORD_DATA_BYTES);
    ctx.relay.last.drop();
    await until(() => ctx.events.includes("close"));
    expect(budget.usedBytes).toBe(0);
    expect(ctx.texts).toEqual([]);
  });

  it("a transport lost during the handshake closes the route unopened", async () => {
    const connector = new TestConnector();
    connector.holdAdmission = true;
    const ctx = setup({ connector });
    await until(() => connector.received.some((event) => event.type === "admit"));
    ctx.relay.last.drop();
    await until(() => ctx.events.includes("close"));
    expect(ctx.events).toEqual(["close"]);
    // A late admission reaches nothing.
    connector.admitNow();
    await flush();
    expect(ctx.events).toEqual(["close"]);
  });

  it("a tampered frame fails the channel", async () => {
    const ctx = await opened();
    const [frame] = ctx.connector.channel!.sendText("hello");
    const tampered = Uint8Array.from(frame!);
    tampered[tampered.length - 1]! ^= 1;
    ctx.relay.last.deliver(tampered);
    await until(() => ctx.events.includes("close"));
    expect(ctx.closes[0]!.code).toBe(RELAY_CLOSE.protocol);
    expect(ctx.texts).toEqual([]);
    expect(ctx.relay.last.closedWith).not.toBeNull();
  });

  it("a frame before the relay opened the session fails the route", async () => {
    const ctx = setup();
    ctx.relay.autoSplice = false;
    await until(() => ctx.relay.transports.length === 1 && ctx.relay.last.readyState === 1);
    await flush();
    ctx.relay.last.deliver(new Uint8Array([1, 3, 0]));
    await until(() => ctx.events.includes("close"));
    expect(ctx.closes[0]!.code).toBe(RELAY_CLOSE.protocol);
  });

  it("a write that fails ends the route", async () => {
    const ctx = await opened();
    ctx.relay.last.failSends = true;
    ctx.socket.send("lost");
    await until(() => ctx.events.includes("close"));
    expect(ctx.closes[0]!.code).toBe(RELAY_CLOSE.abnormal);
  });

  it("a route that does not open in time ends, and the timer goes", async () => {
    const time = new ManualTime();
    const connector = new TestConnector();
    connector.holdAdmission = true;
    const ctx = setup({ connector, time, openTimeoutMs: 15_000 });
    await until(() => connector.received.some((event) => event.type === "admit"));
    time.advance(14_999);
    expect(ctx.socket.readyState).toBe(0);
    time.advance(1);
    await until(() => ctx.events.includes("close"));
    expect(ctx.closes[0]!.code).toBe(RELAY_CLOSE.timedOut);
    expect(time.pending).toBe(0);
  });
});

describe("RelaySocket: deadline and budget", () => {
  it("a message left unfinished past its deadline ends the route by the host's timer", async () => {
    const time = new ManualTime();
    const budget = new ReceiveBudget(10 * MAX_RECORD_DATA_BYTES);
    const ctx = await opened({ time, budget });
    expect(time.pending).toBe(0);
    const frames = ctx.connector.channel!.sendText("z".repeat(MAX_RECORD_DATA_BYTES + 1));
    ctx.connector.deliver(frames[0]!);
    await until(() => budget.usedBytes > 0);
    // Armed for just after the deadline; the connector then goes quiet.
    expect(time.pending).toBe(1);
    time.advance(MAX_PARTIAL_MESSAGE_MS);
    expect(ctx.socket.readyState).toBe(1);
    time.advance(1);
    await until(() => ctx.events.includes("close"));
    expect(ctx.closes[0]!.code).toBe(RELAY_CLOSE.timedOut);
    expect(budget.usedBytes).toBe(0);
    expect(time.pending).toBe(0);
  });

  it("keep-alives do not extend the deadline", async () => {
    const time = new ManualTime();
    const ctx = await opened({ time });
    const channel = ctx.connector.channel!;
    ctx.connector.deliver(sealAs(channel, { kind: "text-part", data: FULL_PART }));
    await until(() => time.pending === 1);
    // A ping within the deadline is answered and changes nothing.
    time.now += MAX_PARTIAL_MESSAGE_MS;
    ctx.connector.deliver(sealAs(channel, { kind: "ping", data: new Uint8Array(0) }));
    await flush();
    expect(ctx.socket.readyState).toBe(1);
    // Past the deadline, before the timer would run: the ping itself fails the channel.
    time.now += 1;
    ctx.connector.deliver(sealAs(channel, { kind: "ping", data: new Uint8Array(0) }));
    await until(() => ctx.events.includes("close"));
    expect(ctx.closes[0]!.code).toBe(RELAY_CLOSE.timedOut);
  });

  it("a finished message cancels the timer", async () => {
    const time = new ManualTime();
    const ctx = await opened({ time });
    const frames = ctx.connector.channel!.sendText("z".repeat(MAX_RECORD_DATA_BYTES + 1));
    ctx.connector.deliver(frames[0]!);
    await until(() => time.pending === 1);
    ctx.connector.deliver(frames[1]!);
    await until(() => ctx.texts.length === 1);
    expect(time.pending).toBe(0);
  });

  it("a message over the shared budget ends the route", async () => {
    const budget = new ReceiveBudget(MAX_RECORD_DATA_BYTES * 2);
    const ctx = await opened({ budget });
    ctx.connector.sendText("w".repeat(MAX_RECORD_DATA_BYTES * 2));
    await until(() => ctx.events.includes("close"));
    expect(ctx.closes[0]!.code).toBe(RELAY_CLOSE.tooLarge);
    expect(budget.usedBytes).toBe(0);
  });
});
