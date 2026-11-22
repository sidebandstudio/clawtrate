// Two clients that share one host store share one saved gateway. A client's queued
// change to that record acts on what the record holds when the change runs, not on
// what this client last saved, so it never removes or replaces another client's gateway.

import { describe, expect, it } from "vitest";
import { ClawtrateClient } from "../src/client.ts";
import { FAST, URL_A, URL_B } from "./client-harness.ts";
import {
  deferred,
  FakeGateway,
  helloOk,
  memoryStorage,
  sleep,
  testHost,
  tokenKey,
  until,
} from "./fake-gateway.ts";

type ConnectParams = { scopes: string[]; auth?: { token?: string; deviceToken?: string } };

/** A gateway that pairs anyone who connects, issuing `issued` unless a device token was sent. */
function pairingGateway(issued: string, onReply: () => void = () => {}) {
  const gateway = new FakeGateway();
  gateway.connectReply = (params) => {
    const { scopes, auth } = params as ConnectParams;
    onReply();
    return { ok: true, payload: helloOk(scopes, auth?.deviceToken ?? issued) };
  };
  return gateway;
}

const saved = (storage: { data: Map<string, string> }) => {
  const raw = storage.data.get("connection");
  return raw ? (JSON.parse(raw) as { url: string; token: string | null }) : null;
};

describe("clients sharing a store keep each other's saved gateway", () => {
  it("a queued disconnect of A leaves gateway B, saved by another client just before it", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: JSON.stringify({
        token: "token-A",
        grantedScopes: ["operator.read"],
        heldScopes: ["operator.read"],
      }),
    });
    const client = new ClawtrateClient(testHost(pairingGateway("token-A"), storage), FAST);
    const otherGateway = pairingGateway("token-B");
    const other = new ClawtrateClient(testHost(otherGateway, storage), FAST);
    try {
      await client.start();
      await until(() => client.state.connection.status === "connected");
      await other.start({ resume: false });
      // The other client's Connect to B is queued first, so it saves B before the disconnect runs.
      const connecting = other.connect({ url: URL_B, token: "boot-B" });
      const disconnecting = client.disconnect(URL_A);
      await Promise.all([connecting, disconnecting]);
      expect(saved(storage)?.url).toBe(URL_B);
      // This client's own cleanup is as before.
      expect(client.state.connection.status).toBe("idle");
      expect(client.state.connection.gatewayUrl).toBeNull();
      await until(() => other.state.connection.status === "connected");
      other.stop();
      await sleep(30);
      const restarted = new ClawtrateClient(testHost(otherGateway, storage), FAST);
      try {
        const before = otherGateway.connects.length;
        await restarted.start();
        await until(() => restarted.state.connection.status === "connected");
        expect(restarted.state.connection.gatewayUrl).toBe(URL_B);
        expect(otherGateway.connects.length).toBeGreaterThan(before);
      } finally {
        restarted.stop();
      }
    } finally {
      other.stop();
      client.stop();
    }
  });

  it("clearing A's shared token leaves gateway B, saved by another client while A's hello was saving", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: "bootstrap" }),
    });
    let holdNext = false;
    const gateway = pairingGateway("issued-A", () => {
      holdNext = true;
    });
    // This hello's read of the saved device token waits while the other client saves B.
    const held = deferred<void>();
    let waiting = false;
    const get = storage.get;
    storage.get = async (key) => {
      if (holdNext && key === tokenKey(URL_A)) {
        holdNext = false;
        waiting = true;
        await held.promise;
      }
      return get(key);
    };
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    const other = new ClawtrateClient(testHost(pairingGateway("token-B"), storage), FAST);
    try {
      await client.start();
      await until(() => waiting);
      await other.start({ resume: false });
      // No shared token, so the other client's own hello leaves the record as this saves it.
      await other.connect({ url: URL_B });
      expect(saved(storage)).toEqual({ url: URL_B, token: null });
      held.resolve();
      await until(() => storage.data.has(tokenKey(URL_A)));
      await until(() => client.state.connection.status === "connected");
      await sleep(30);
      // A's device token is saved, and the record still names B.
      expect(saved(storage)).toEqual({ url: URL_B, token: null });
    } finally {
      held.resolve();
      other.stop();
      client.stop();
    }
  });
});
