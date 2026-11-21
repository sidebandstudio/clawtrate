// Routes (docs/decisions.md, "Routes, when the setup flow's SSH package is
// built"): a routed connection's device token is kept for its route, never for
// the address it answers on now, so an SSH forward that comes back on another
// local port reconnects with the same token, keeps what is on screen, and sends
// nothing while the route is held.

import { describe, expect, it } from "vitest";
import { ClawtrateClient } from "../src/client.ts";
import { FakeGateway, helloOk, memoryStorage, sleep, testHost, until } from "./fake-gateway.ts";

const ROUTE = "ssh-0123456789abcdef01234567";
const ROUTE_TOKEN = `deviceToken:route:${ROUTE}:device-1:operator`;

function setup() {
  const gateway = new FakeGateway();
  gateway.connectReply = () => ({ ok: true, payload: helloOk(["operator.read"], "token-1") });
  const storage = memoryStorage();
  const client = new ClawtrateClient(testHost(gateway, storage), {
    reconnect: { initialMs: 20, maxMs: 40 },
  });
  return { gateway, storage, client };
}

describe("a routed connection", () => {
  it("keeps its first token for the route, never for the address, and only for exactly read", async () => {
    const { gateway, storage, client } = setup();
    await client.start();
    await client.connectRoute({
      url: "ws://127.0.0.1:50001",
      route: ROUTE,
      code: { bootstrapToken: "b".repeat(43), expiresAtMs: Date.now() + 60_000 },
    });
    await until(() => client.state.connection.status === "connected");
    expect(JSON.parse(storage.data.get(ROUTE_TOKEN)!)).toMatchObject({ token: "token-1" });
    expect([...storage.data.keys()].filter((key) => key.startsWith("deviceToken"))).toEqual([
      ROUTE_TOKEN,
    ]);
    expect(await client.hasRouteToken(ROUTE)).toBe(true);
    expect(await client.hasDeviceToken("ws://127.0.0.1:50001")).toBe(false);
    expect((gateway.connects[0] as { auth: { bootstrapToken: string } }).auth.bootstrapToken).toBe(
      "b".repeat(43),
    );
  });

  it("comes back on another address with the route's own token, keeps what is on screen, and sends nothing while held", async () => {
    const { gateway, storage, client } = setup();
    storage.data.set(
      ROUTE_TOKEN,
      JSON.stringify({
        token: "token-1",
        grantedScopes: ["operator.read"],
        heldScopes: ["operator.read"],
      }),
    );
    await client.start();
    await client.connectRoute({ url: "ws://127.0.0.1:50001", route: ROUTE });
    await until(
      () => client.state.connection.status === "connected" && client.state.bots.length > 0,
    );
    const sockets = gateway.sockets.length;
    client.holdRoute(ROUTE);
    expect(client.state.connection.status).toBe("reconnecting");
    gateway.dropAll();
    await sleep(200);
    // Held: no socket is opened again by the client's own retries.
    expect(gateway.sockets.length).toBe(sockets);
    expect(client.state.bots.length).toBeGreaterThan(0);
    await client.connectRoute({ url: "ws://127.0.0.1:50002", route: ROUTE });
    expect(client.state.connection.status).toBe("reconnecting");
    expect(client.state.bots.length).toBeGreaterThan(0);
    await until(() => client.state.connection.status === "connected");
    expect(gateway.sockets.at(-1)!.url).toBe("ws://127.0.0.1:50002");
    const auth = (gateway.connects.at(-1) as { auth: Record<string, string> }).auth;
    expect(auth.bootstrapToken).toBeUndefined();
    expect(JSON.stringify(auth)).toContain("token-1");
  });

  it("is never resumed by the client itself: its host opens the route first", async () => {
    const { gateway, storage, client } = setup();
    storage.data.set(
      "connection",
      JSON.stringify({ url: "ws://127.0.0.1:50001", token: null, route: ROUTE }),
    );
    await client.start();
    await sleep(50);
    expect(gateway.sockets).toEqual([]);
    expect(client.state.connection.status).toBe("idle");
    expect((await client.savedSettings())?.route).toBe(ROUTE);
  });

  it("a dropped route token is gone, and another route's token is never offered", async () => {
    const { gateway, storage, client } = setup();
    storage.data.set(
      ROUTE_TOKEN,
      JSON.stringify({ token: "token-1", heldScopes: ["operator.read"] }),
    );
    await client.start();
    await client.dropRouteToken(ROUTE);
    expect(storage.data.has(ROUTE_TOKEN)).toBe(false);
    storage.data.set(
      ROUTE_TOKEN,
      JSON.stringify({ token: "token-1", heldScopes: ["operator.read"] }),
    );
    await client.connectRoute({
      url: "ws://127.0.0.1:50001",
      route: "ssh-ffffffffffffffffffffffff",
    });
    await until(() => gateway.connects.length > 0);
    expect(JSON.stringify(gateway.connects[0])).not.toContain("token-1");
    expect(() => client.holdRoute("not-a-route")).not.toThrow();
    await expect(client.connectRoute({ url: "ws://127.0.0.1:1", route: "../x" })).rejects.toThrow();
  });
});
