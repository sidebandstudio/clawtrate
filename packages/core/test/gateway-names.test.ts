// Names given to gateways on this device (docs/design/titlebar.md, section 4).
import { describe, expect, it } from "vitest";
import { createBridgeSession, parseBridgeCommand } from "../src/bridge.ts";
import { ClawtrateClient, GatewayChangedError } from "../src/client.ts";
import {
  GATEWAY_NAMES_KEY,
  MAX_GATEWAY_NAMES,
  cleanGatewayName,
  gatewayAddress,
  gatewayNameFor,
  readGatewayNames,
  withGatewayName,
  writeGatewayNames,
} from "../src/gateway-names.ts";
import { FakeGateway, helloOk, memoryStorage, testHost, until } from "./fake-gateway.ts";

const URL = "ws://127.0.0.1:19001";
const FAST = { reconnect: { initialMs: 20, maxMs: 40 } };

describe("F-523: gateway names", () => {
  it("keys a name by the normalised address: host case, a default port and a trailing slash don't matter", () => {
    expect(gatewayAddress("wss://Devbox.Example.test:443/")).toBe("wss://devbox.example.test");
    expect(gatewayAddress("ws://127.0.0.1:19001/gw/")).toBe("ws://127.0.0.1:19001/gw");
    expect(gatewayAddress("not a url")).toBeNull();
    expect(
      gatewayAddress(`ws://127.0.0.1:19001/${"a".repeat(2048)}`),
      "too long to name",
    ).toBeNull();
    const names = withGatewayName([], "wss://devbox.example.test/", "Devbox");
    expect(gatewayNameFor(names, "wss://DEVBOX.example.test:443")).toBe("Devbox");
    expect(gatewayNameFor(names, "wss://devbox.example.test:8443")).toBeNull();
    expect(gatewayNameFor(names, null)).toBeNull();
  });

  it("an empty name removes the name; a name is one trimmed line of at most 40 characters", () => {
    const named = withGatewayName([], URL, "Devbox");
    expect(withGatewayName(named, URL, "   ")).toEqual([]);
    expect(cleanGatewayName("  Dev\nbox\u0000 \u202e ")).toBe("Dev box");
    expect([...cleanGatewayName("x".repeat(60))]).toHaveLength(40);
  });

  it("keeps the newest 32 and reads anything unreadable as no names", () => {
    let names = withGatewayName([], URL, "First");
    for (let i = 1; i <= MAX_GATEWAY_NAMES; i++)
      names = withGatewayName(names, `ws://127.0.0.1:${20000 + i}`, `Gateway ${i}`);
    expect(names).toHaveLength(MAX_GATEWAY_NAMES);
    expect(gatewayNameFor(names, URL), "the oldest is dropped").toBeNull();
    expect(readGatewayNames(writeGatewayNames(names))).toEqual(names);
    expect(readGatewayNames("{")).toEqual([]);
    expect(readGatewayNames('{"a":1}')).toEqual([]);
    expect(readGatewayNames('[["ws://a",""],[1,"x"],["ws://b","B"]]')).toEqual([
      { address: "ws://b", name: "B" },
    ]);
  });

  it("names the selected gateway in the host's storage, keeps it across Disconnect, and never sends it", async () => {
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

    await session.apply(
      parseBridgeCommand({ type: "nameGateway", gatewayUrl: URL, name: "  Devbox " }),
    );
    expect(client.state.connection.gatewayName).toBe("Devbox");
    expect(readGatewayNames(storage.data.get(GATEWAY_NAMES_KEY) ?? null)).toEqual([
      { address: URL, name: "Devbox" },
    ]);

    // Only the address the person saw.
    await expect(client.nameGateway("ws://127.0.0.1:19002", "Other")).rejects.toThrow(
      GatewayChangedError,
    );

    await session.apply(parseBridgeCommand({ type: "disconnect", gatewayUrl: URL }));
    expect(client.state.connection.gatewayName).toBeNull();
    await client.connect({ url: URL + "/", token: "bootstrap" });
    await until(() => client.state.connection.status === "connected");
    expect(client.state.connection.gatewayName, "kept across Disconnect").toBe("Devbox");

    // A new client on the same storage reads it back.
    client.stop();
    const again = new ClawtrateClient(testHost(gateway, storage), FAST);
    await again.start();
    await until(() => again.state.connection.status === "connected");
    expect(again.state.connection.gatewayName).toBe("Devbox");

    await again.nameGateway(again.state.connection.gatewayUrl!, "");
    expect(again.state.connection.gatewayName).toBeNull();
    again.stop();

    expect(JSON.stringify(gateway.requests)).not.toContain("Devbox");
  });

  it("a name the host could not keep is not taken", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: true,
      payload: helloOk(["operator.read"], "device-token"),
    });
    const storage = memoryStorage();
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await client.connect({ url: URL, token: "bootstrap" });
    await until(() => client.state.connection.status === "connected");
    storage.set = () => Promise.reject(new Error("The disk is full."));
    await expect(client.nameGateway(URL, "Devbox")).rejects.toThrow("The disk is full.");
    expect(client.state.connection.gatewayName).toBeNull();
    client.stop();
  });

  it("refuses a malformed command before it reaches the client", () => {
    expect(() => parseBridgeCommand({ type: "nameGateway", gatewayUrl: URL })).toThrow(
      "invalid name",
    );
    expect(() => parseBridgeCommand({ type: "nameGateway", name: "x" })).toThrow("invalid url");
    expect(() =>
      parseBridgeCommand({ type: "nameGateway", gatewayUrl: URL, name: "x".repeat(1001) }),
    ).toThrow("invalid name");
  });
});
