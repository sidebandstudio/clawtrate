// Parity rows for connecting and pairing that the core decides.
import { PROTOCOL_VERSION } from "@openclaw/gateway-client/browser";
import { describe, expect, it } from "vitest";
import { createBridgeSession, parseBridgeCommand } from "../src/bridge.ts";
import { ClawtrateClient } from "../src/client.ts";
import { pairingEnded, protocolMismatch } from "../src/connect-errors.ts";
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

  it("F-009: a request that is no longer pending says it was rejected or expired, without guessing which; retrying asks again", async () => {
    const gateway = pairingGateway(["req-1", "req-2", "req-3"]);
    const client = new ClawtrateClient(testHost(gateway), FAST);
    await client.connect({ url: URL, token: "t" });
    await until(() => client.state.connection.pairing?.requestId === "req-1");
    // "Check now": the gateway answers with a new request, so the old one is gone.
    await client.retryNow();
    await until(() => client.state.connection.status === "error");
    expect(client.state.connection.error).toMatchObject({ code: "PAIRING_ENDED" });
    expect(client.state.connection.error?.message).toMatch(
      /^It was rejected, or it expired before anyone approved it; the gateway does not say which\. Try again to send a new request/,
    );
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

  it("F-009: however long the request waited, the outcome is the same", async () => {
    let clock = 1_000_000;
    const gateway = pairingGateway(["req-1", "req-2"]);
    const client = new ClawtrateClient({ ...testHost(gateway), now: () => clock }, FAST);
    await client.connect({ url: URL, token: "t" });
    await until(() => client.state.connection.pairing?.requestId === "req-1");
    // Well past OpenClaw's pending lifetime of five minutes: a rejection then
    // looks the same as an expiry, so the client still does not choose one.
    clock += 600_000;
    await client.retryNow();
    await until(() => client.state.connection.status === "error");
    expect(client.state.connection.error).toMatchObject({ code: "PAIRING_ENDED" });
    client.stop();
  });

  it("F-009: a request has ended only when a different one replaces it", () => {
    expect(pairingEnded(null, "a")).toBe(false);
    expect(pairingEnded("a", "a")).toBe(false);
    expect(pairingEnded("a", "")).toBe(false);
    expect(pairingEnded("a", "b")).toBe(true);
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

  it("F-387: Reconnect to a gateway that no longer answers goes from Connecting back to Offline, with the error", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: true,
      payload: helloOk(["operator.read"], "device-token"),
    });
    const client = new ClawtrateClient(testHost(gateway), FAST);
    await client.connect({ url: URL, token: "t" });
    await until(() => client.state.discovery.status === "ready");
    await client.suspend();
    gateway.refuseConnections = true;
    const seen: Array<{ status: string; retryAt: number | null; error: string | null }> = [];
    const stop = client.store.subscribe((state) =>
      seen.push({
        status: state.connection.status,
        retryAt: state.connection.retryAt,
        error: state.connection.error?.code ?? null,
      }),
    );
    await client.retryNow();
    await until(() => client.state.connection.error?.code === "UNREACHABLE");
    // An attempt under way (no retry scheduled), then waiting for the next with the error.
    expect(
      seen.some((s) => s.retryAt === null && s.error === null && s.status !== "disconnected"),
    ).toBe(true);
    await until(() => client.state.connection.retryAt !== null);
    expect(client.state.connection).toMatchObject({
      error: { code: "UNREACHABLE", message: "Nothing answered at 127.0.0.1:19001." },
    });
    expect(["connecting", "reconnecting"]).toContain(client.state.connection.status);
    expect(client.state.bots, "what was on screen stays").toHaveLength(1);
    stop();
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

  it("F-457: after Disconnect, a restarted client stays disconnected until Reconnect, which then lasts across a restart too", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: true,
      payload: helloOk(["operator.read"], "device-token"),
    });
    const storage = memoryStorage();
    const first = new ClawtrateClient(testHost(gateway, storage), FAST);
    await first.start();
    await first.connect({ url: URL, token: "bootstrap" });
    await until(() => first.state.connection.status === "connected");
    await createBridgeSession(first).apply(parseBridgeCommand({ type: "suspend" }));
    first.stop();

    // The app quits and starts again, on the same device storage.
    const attempts = gateway.connects.length;
    const second = new ClawtrateClient(testHost(gateway, storage), FAST);
    await second.start();
    await sleep(150);
    expect(gateway.connects.length, "it does not reconnect by itself").toBe(attempts);
    expect(second.state.connection).toMatchObject({ status: "disconnected", gatewayUrl: URL });
    // Reconnect: the same gateway and device token.
    await createBridgeSession(second).apply(parseBridgeCommand({ type: "retry" }));
    await until(() => second.state.connection.status === "connected");
    second.stop();

    // Having reconnected, the next start opens the gateway as usual.
    const third = new ClawtrateClient(testHost(gateway, storage), FAST);
    await third.start();
    await until(() => third.state.connection.status === "connected");
    third.stop();
  });

  it("a gateway this device could not forget stays connected and saved; forgetting it once it can be written ends as usual", async () => {
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
    const remove = storage.delete.bind(storage);
    storage.delete = () => Promise.reject(new Error("The disk is full."));
    const session = createBridgeSession(client);
    await expect(session.apply(parseBridgeCommand({ type: "disconnect" }))).rejects.toThrow(
      "The disk is full.",
    );
    expect(client.state.connection).toMatchObject({ status: "connected", gatewayUrl: URL });
    expect(client.state.bots).toHaveLength(1);
    expect(storage.data.has("connection"), "the gateway is still saved").toBe(true);
    await sleep(100);
    expect(client.state.connection.status).toBe("connected");
    const open = gateway.sockets.filter((socket) => socket.readyState === 1);
    expect(open, "the connection stays open").toHaveLength(1);
    storage.delete = remove;
    await session.apply(parseBridgeCommand({ type: "disconnect" }));
    expect(client.state.connection).toMatchObject({ status: "idle", gatewayUrl: null });
    expect(storage.data.has("connection")).toBe(false);
    client.stop();
  });
});
