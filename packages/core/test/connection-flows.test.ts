// Parity rows for connecting and pairing that the core decides.
import { PROTOCOL_VERSION } from "@openclaw/gateway-client/browser";
import { describe, expect, it } from "vitest";
import { createBridgeSession, parseBridgeCommand } from "../src/bridge.ts";
import { ClawtrateClient } from "../src/client.ts";
import { PAIRING_PENDING_TTL_MS, pairingOutcome, protocolMismatch } from "../src/connect-errors.ts";
import { FakeGateway, helloOk, memoryStorage, sleep, testHost, until } from "./fake-gateway.ts";

const URL = "ws://127.0.0.1:19001";
const FAST = { reconnect: { initialMs: 20, maxMs: 40 } };

/** A gateway that answers every connect with a pairing request; the id can change. */
function pairingGateway(ids: string[]) {
  const gateway = new FakeGateway();
  let attempt = 0;
  gateway.connectReply = () => ({
    ok: false,
    error: {
      code: "NOT_PAIRED",
      message: "device pairing required",
      details: {
        code: "PAIRING_REQUIRED",
        reason: "not-paired",
        requestId: ids[Math.min(attempt++, ids.length - 1)],
        deviceId: "device-1",
        requestedRole: "operator",
        requestedScopes: ["operator.read"],
      },
    },
  });
  return gateway;
}

describe("pairing", () => {
  it("F-002: the pending request lists exactly the scopes this device asked for", async () => {
    const gateway = pairingGateway(["req-1"]);
    const client = new ClawtrateClient(testHost(gateway), FAST);
    await client.connect({ url: URL, token: "t" });
    await until(() => client.state.connection.status === "pairing");
    expect((gateway.connects[0] as { scopes: string[] }).scopes).toEqual(["operator.read"]);
    expect(client.state.connection.pairing?.requestedScopes).toEqual(["operator.read"]);
    client.stop();
  });

  it("F-009: a request that disappears while this client keeps it fresh was rejected; retrying asks again", async () => {
    const gateway = pairingGateway(["req-1", "req-2", "req-3"]);
    const client = new ClawtrateClient(testHost(gateway), FAST);
    await client.connect({ url: URL, token: "t" });
    await until(() => client.state.connection.pairing?.requestId === "req-1");
    // "Check now": the gateway answers with a new request, so the old one was rejected.
    await client.retryNow();
    await until(() => client.state.connection.status === "error");
    expect(client.state.connection.error).toMatchObject({ code: "PAIRING_REJECTED" });
    expect(client.state.connection.pairing).toBe(null);
    const attempts = gateway.connects.length;
    await sleep(100);
    expect(gateway.connects.length, "it stops retrying").toBe(attempts);
    // Trying again shows the new request.
    await client.retryNow();
    await until(() => client.state.connection.status === "pairing");
    expect(client.state.connection.pairing?.requestId).toBe("req-3");
    expect(client.state.connection.error).toBe(null);
    client.stop();
  });

  it("F-009: a request that disappears after nothing refreshed it for the pending lifetime expired", async () => {
    let clock = 1_000_000;
    const gateway = pairingGateway(["req-1", "req-2"]);
    const client = new ClawtrateClient({ ...testHost(gateway), now: () => clock }, FAST);
    await client.connect({ url: URL, token: "t" });
    await until(() => client.state.connection.pairing?.requestId === "req-1");
    clock += PAIRING_PENDING_TTL_MS + 1;
    await client.retryNow();
    await until(() => client.state.connection.status === "error");
    expect(client.state.connection.error).toMatchObject({ code: "PAIRING_EXPIRED" });
    client.stop();
  });

  it("F-009: tells rejected from expired by the pending lifetime of OpenClaw 2026.10.6", () => {
    const seen = { requestId: "a", at: 0 };
    expect(PAIRING_PENDING_TTL_MS).toBe(300_000);
    expect(pairingOutcome(null, "a", 10)).toBe("pending");
    expect(pairingOutcome(seen, "a", 10_000_000)).toBe("pending");
    expect(pairingOutcome(seen, "b", 299_999)).toBe("rejected");
    expect(pairingOutcome(seen, "b", 300_001)).toBe("expired");
  });
});

describe("connecting", () => {
  it("F-003: bots are published as soon as they load, before the tasks have", async () => {
    const gateway = new FakeGateway();
    let release: () => void = () => {};
    const tasks = new Promise<void>((resolve) => (release = resolve));
    gateway.handlers["sessions.subscribe"] = async () => {
      await tasks;
      return { subscribed: true, list: { sessions: [], hasMore: false } };
    };
    const client = new ClawtrateClient(testHost(gateway, memoryStorage()), FAST);
    await client.connect({ url: URL, token: "t" });
    await until(() => client.state.bots.length === 1);
    expect(client.state.discovery.status).toBe("loading");
    release();
    await until(() => client.state.discovery.status === "ready");
    client.stop();
  });

  it("F-009 F-387: an attempt nobody answers says what happened while it retries", async () => {
    const gateway = new FakeGateway();
    gateway.refuseConnections = true;
    const client = new ClawtrateClient(testHost(gateway), FAST);
    await client.connect({ url: URL, token: "t" });
    await until(() => client.state.connection.error?.code === "UNREACHABLE");
    expect(client.state.connection.status).toBe("connecting");
    expect(client.state.connection.error?.message).toBe("Nothing answered at 127.0.0.1:19001.");
    gateway.refuseConnections = false;
    await until(() => client.state.connection.status === "connected");
    expect(client.state.connection.error).toBe(null);
    client.stop();
  });

  it("F-263: a gateway outside the client's protocol range gets no further requests, and the error names both versions", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "protocol mismatch",
        details: {
          code: "PROTOCOL_MISMATCH",
          clientMinProtocol: PROTOCOL_VERSION,
          clientMaxProtocol: PROTOCOL_VERSION,
          expectedProtocol: 5,
          minimumProbeProtocol: 3,
        },
      },
    });
    const client = new ClawtrateClient(testHost(gateway), FAST);
    await client.connect({ url: URL, token: "t" });
    await until(() => client.state.connection.status === "error");
    expect(client.state.connection.error).toMatchObject({
      code: "PROTOCOL_MISMATCH",
      protocol: { gateway: 5, client: PROTOCOL_VERSION },
      message: `This gateway speaks protocol 5. This version of Clawtrate speaks protocol ${PROTOCOL_VERSION}.`,
    });
    await sleep(100);
    expect(gateway.requests, "no feature or mutation requests").toEqual([]);
    expect(gateway.connects, "and no more handshakes until asked").toHaveLength(1);
    // Retry repeats the handshake.
    await client.retryNow();
    await until(() => gateway.connects.length === 2);
    client.stop();
  });

  it("F-263: a hello with another protocol is not used", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({ ok: true, payload: { ...helloOk(), protocol: 9 } });
    const client = new ClawtrateClient(testHost(gateway), FAST);
    await client.connect({ url: URL, token: "t" });
    await until(() => client.state.connection.status === "error");
    expect(client.state.connection.error?.protocol).toEqual({
      gateway: 9,
      client: PROTOCOL_VERSION,
    });
    expect(gateway.requests).toEqual([]);
    client.stop();
  });

  it("F-263: reads the protocol the gateway names from its error details", () => {
    expect(protocolMismatch({ code: "PROTOCOL_MISMATCH", expectedProtocol: 5 })).toEqual({
      gateway: 5,
      client: PROTOCOL_VERSION,
    });
    expect(protocolMismatch({ code: "PROTOCOL_MISMATCH" })).toEqual({
      gateway: null,
      client: PROTOCOL_VERSION,
    });
    expect(protocolMismatch({ code: "PAIRING_REQUIRED" })).toBe(null);
  });

  it("F-457 F-387: Disconnect closes the connection and keeps the pairing and what is on screen; Reconnect connects again", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: true,
      payload: helloOk(["operator.read"], "device-token"),
    });
    const storage = memoryStorage();
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await client.connect({ url: URL, token: "bootstrap" });
    await until(() => client.state.discovery.status === "ready");
    const session = createBridgeSession(client);
    await session.apply(parseBridgeCommand({ type: "suspend" }));
    expect(client.state.connection.status).toBe("disconnected");
    expect(client.state.connection.gatewayUrl).toBe(URL);
    expect(client.state.bots).toHaveLength(1);
    expect([...storage.data.keys()].some((key) => key.startsWith("deviceToken:"))).toBe(true);
    const sockets = gateway.sockets.filter((socket) => socket.readyState === 1);
    expect(sockets, "the connection is closed").toEqual([]);
    await sleep(100);
    expect(client.state.connection.status, "and it stays closed").toBe("disconnected");
    // Reconnect: the same gateway, with the device token, no bootstrap token.
    await session.apply(parseBridgeCommand({ type: "retry" }));
    await until(() => client.state.connection.status === "connected");
    const last = gateway.connects.at(-1) as { auth?: { token?: string; deviceToken?: string } };
    expect(last.auth?.token ?? last.auth?.deviceToken).toBe("device-token");
    client.stop();
  });
});
