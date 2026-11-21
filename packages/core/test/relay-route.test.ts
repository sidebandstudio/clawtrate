// The relay route in the client: the gateway's protocol runs unchanged through RelaySocket, the
// route's device token is kept under the connector's key, the pairing code's secrets are
// dropped once used, and a connector's refusal stops reconnecting.

import { describe, expect, it } from "vitest";
import { generateKeyPair, toBase64Url } from "@clawtrate/relay-protocol";
import { ClawtrateClient } from "../src/client.ts";
import type { ClawtrateHost, WebSocketLike } from "../src/host.ts";
import type { RelayCode } from "../src/relay/code.ts";
import { relayRouteAddress, relayRouteKey, type RelayRoute } from "../src/relay/route.ts";
import { FakeGateway, helloOk, memoryStorage, testHost, until } from "./fake-gateway.ts";
import { routeFor, TestConnector, TestRelay } from "./relay-harness.ts";

const SECRET = new Uint8Array(32).fill(9);
const relayTokenKey = (route: RelayRoute) =>
  `deviceToken:${encodeURIComponent(relayRouteKey(route))}:device-1:operator`;

type ConnectParams = {
  scopes: string[];
  auth?: { token?: string; bootstrapToken?: string; deviceToken?: string };
};

/** A gateway that pairs a device with its bootstrap token and then knows its device token. */
function pairingGateway(): FakeGateway {
  const gateway = new FakeGateway();
  gateway.connectReply = (params) => {
    const { scopes } = params as ConnectParams;
    return { ok: true, payload: helloOk(scopes, "device-token-1") };
  };
  return gateway;
}

/**
 * A connector stand-in that bridges each admitted phone to its own gateway socket, passing text
 * frames both ways unchanged.
 */
function bridge(connector: TestConnector, gateway: FakeGateway): void {
  connector.onAdmitted = () => {
    const socket: WebSocketLike = gateway.createWebSocket("ws://127.0.0.1:19001");
    socket.onmessage = (event) => connector.sendText(String(event.data));
    connector.onText = (text) => socket.send(text);
  };
}

function relayHost(gateway: FakeGateway, relay: TestRelay, storage = memoryStorage()) {
  const phoneKey = generateKeyPair();
  const host: ClawtrateHost = {
    ...testHost(gateway, storage),
    // A relay route never opens a direct socket.
    createWebSocket: () => {
      throw new Error("not a direct route");
    },
    relay: { createTransport: relay.createTransport, loadStaticKey: async () => phoneKey },
  };
  return { host, storage, phoneKey };
}

function codeFor(route: RelayRoute): RelayCode {
  return { route, enroll: SECRET, bootstrapToken: "bootstrap-1", expiresAtMs: 2_000_000 };
}

describe("the relay route", () => {
  it("pairs through the relay: hello with the requested scopes, token kept under the connector key", async () => {
    const gateway = pairingGateway();
    const connector = new TestConnector();
    connector.addOffer(SECRET);
    bridge(connector, gateway);
    const relay = new TestRelay(connector);
    const { host, storage, phoneKey } = relayHost(gateway, relay);
    const client = new ClawtrateClient(host);
    await client.start();
    const route = routeFor(connector.staticKey.publicKey);
    await client.connectRelay(codeFor(route));
    await until(() => client.state.connection.status === "connected");

    expect(client.state.connection.gatewayUrl).toBe(relayRouteAddress(route));
    const connect = gateway.connects[0] as ConnectParams;
    expect(connect.scopes).toEqual(["operator.read"]);
    // The code's token is the setup code's bootstrap token, never sent as the shared token.
    expect(connect.auth?.bootstrapToken).toBe("bootstrap-1");
    expect(connect.auth?.token).toBeUndefined();
    expect(connector.enrolled).toEqual([phoneKey.publicKey]);
    // A request and its answer went through the channel: the bots were listed.
    await until(() => client.state.bots.length === 1);
    expect(gateway.calls("agents.list")).toHaveLength(1);

    const stored = JSON.parse(storage.data.get(relayTokenKey(route))!) as { token: string };
    expect(stored.token).toBe("device-token-1");
    // No token under the relay's address, and both secrets from the code are gone.
    expect([...storage.data.keys()].filter((key) => key.startsWith("deviceToken:"))).toEqual([
      relayTokenKey(route),
    ]);
    await until(() => {
      const settings = JSON.parse(storage.data.get("connection")!) as {
        token: string | null;
        relay: { enroll: string | null };
      };
      return settings.token === null && settings.relay.enroll === null;
    });
    client.stop();
  });

  it("offers a route's token to that connector's key alone, wherever its relay is", async () => {
    const gateway = pairingGateway();
    const connector = new TestConnector();
    const relay = new TestRelay(connector);
    const storage = memoryStorage();
    const { host, phoneKey } = relayHost(gateway, relay, storage);
    connector.enrolled.push(phoneKey.publicKey);
    bridge(connector, gateway);
    // A token for another connector reached through the same relay and relay id.
    const other = routeFor(generateKeyPair().publicKey);
    storage.data.set(
      relayTokenKey(other),
      JSON.stringify({ token: "other-token", grantedScopes: [], heldScopes: ["operator.read"] }),
    );
    // And this connector's own token, from when it was reached through another relay.
    const route = routeFor(connector.staticKey.publicKey);
    const moved = routeFor(connector.staticKey.publicKey, "wss://old-relay.example.test");
    storage.data.set(
      relayTokenKey(moved),
      JSON.stringify({ token: "own-token", grantedScopes: [], heldScopes: ["operator.read"] }),
    );
    expect(relayTokenKey(moved)).toBe(relayTokenKey(route));
    const client = new ClawtrateClient(host);
    await client.start();
    await client.connectRelay({ ...codeFor(route) });
    await until(() => client.state.connection.status === "connected");
    const connect = gateway.connects[0] as ConnectParams;
    expect(connect.auth?.deviceToken).toBe("own-token");
    expect(JSON.stringify(gateway.connects)).not.toContain("other-token");
    client.stop();
  });

  it("another connector behind the same relay and relay id is another gateway", async () => {
    const gateway = pairingGateway();
    const connector = new TestConnector();
    const relay = new TestRelay(connector);
    const { host, phoneKey } = relayHost(gateway, relay);
    connector.enrolled.push(phoneKey.publicKey);
    bridge(connector, gateway);
    const client = new ClawtrateClient(host, { reconnect: { initialMs: 10, maxMs: 20 } });
    await client.start();
    const first = routeFor(connector.staticKey.publicKey);
    await client.connectRelay(codeFor(first));
    await until(() => client.state.bots.length === 1);
    // Same relay, same relay id, another connector key: nothing shown for the first is kept.
    const second = routeFor(generateKeyPair().publicKey);
    expect(relayRouteAddress(second)).not.toBe(relayRouteAddress(first));
    await client.connectRelay(codeFor(second));
    expect(client.state.connection.gatewayUrl).toBe(relayRouteAddress(second));
    expect(client.state.bots).toEqual([]);
    client.stop();
  });

  it("stops when the connector refuses this device, and says so", async () => {
    const gateway = pairingGateway();
    const connector = new TestConnector();
    // No offer: the code's secret is refused.
    const relay = new TestRelay(connector);
    const { host } = relayHost(gateway, relay);
    const client = new ClawtrateClient(host, { reconnect: { initialMs: 10, maxMs: 20 } });
    await client.start();
    await client.connectRelay(codeFor(routeFor(connector.staticKey.publicKey)));
    await until(() => client.state.connection.status === "error");
    expect(client.state.connection.error?.code).toBe("RELAY_REFUSED");
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 200));
    expect(relay.transports).toHaveLength(1);
    expect(gateway.connects).toHaveLength(0);
    client.stop();
  });

  it("is refused by a host that cannot reach a relay, and a saved route must match its address", async () => {
    const gateway = pairingGateway();
    const storage = memoryStorage();
    const client = new ClawtrateClient(testHost(gateway, storage));
    await client.start();
    const route = routeFor(generateKeyPair().publicKey);
    await expect(client.connectRelay(codeFor(route))).rejects.toThrow(/relay/);

    storage.data.set(
      "connection",
      JSON.stringify({
        url: relayRouteAddress(routeFor(generateKeyPair().publicKey)),
        token: null,
        relay: { route, enroll: null },
      }),
    );
    await expect(client.savedSettings()).rejects.toThrow(/does not match/);
    storage.data.set(
      "connection",
      JSON.stringify({
        url: relayRouteAddress(route),
        token: null,
        relay: { route: { ...route, connectorKey: toBase64Url(new Uint8Array(32)) }, enroll: null },
      }),
    );
    await expect(client.savedSettings()).rejects.toThrow(/connector key/);
  });
});
