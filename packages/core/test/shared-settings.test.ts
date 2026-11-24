// Two clients that share one host store share one saved gateway. A client's queued
// Disconnect, and its clearing of the shared token after a pairing, check the record
// as it is when they run, so neither removes nor replaces another client's gateway.

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

  describe("while one client is still reading the saved gateway at startup", () => {
    /** A store whose read of `key` waits for `release`, before or after it reads the value. */
    function pausedRead(key: string, when: "before" | "after") {
      const storage = memoryStorage({ connection: JSON.stringify({ url: URL_A, token: null }) });
      const reading = deferred<void>();
      const gate = deferred<void>();
      const get = storage.get;
      let paused = false;
      storage.get = async (read) => {
        if (read !== key || paused) return get(read);
        paused = true;
        const value = when === "after" ? await get(read) : null;
        reading.resolve();
        await gate.promise;
        return when === "after" ? value : get(read);
      };
      return { storage, reading: reading.promise, release: () => gate.resolve() };
    }

    it("F-457: a Suspend sent then leaves gateway B, saved by another client after the read", async () => {
      const { storage, reading, release } = pausedRead("connection", "after");
      const gatewayA = pairingGateway("token-A");
      const client = new ClawtrateClient(testHost(gatewayA, storage), FAST);
      const other = new ClawtrateClient(testHost(pairingGateway("token-B"), storage), FAST);
      try {
        const starting = client.start();
        await reading;
        await other.start({ resume: false });
        await other.connect({ url: URL_B });
        expect(saved(storage)?.url).toBe(URL_B);
        const suspending = client.suspend();
        release();
        await Promise.all([starting, suspending]);
        await sleep(50);
        expect(saved(storage)).toEqual({ url: URL_B, token: null });
        expect(gatewayA.sockets, "the Suspend still keeps A offline").toHaveLength(0);
        expect(client.state.connection.status).toBe("disconnected");
      } finally {
        release();
        other.stop();
        client.stop();
      }
    });

    it("F-457: a stopped client's Suspend no longer holds another client's Connect", async () => {
      const { storage, reading, release } = pausedRead("turn-limit-minutes", "before");
      const set = storage.set;
      const remove = storage.delete;
      const writes: string[] = [];
      let deletes = 0;
      storage.set = (key, value) => {
        if (key === "connection") writes.push(value);
        return set(key, value);
      };
      storage.delete = (key) => {
        if (key === "connection") deletes += 1;
        return remove(key);
      };
      const client = new ClawtrateClient(testHost(pairingGateway("token-A"), storage), FAST);
      const other = new ClawtrateClient(testHost(pairingGateway("token-B"), storage), FAST);
      try {
        const starting = client.start();
        await reading;
        const suspending = client.suspend();
        client.stop();
        await other.start({ resume: false });
        let connected = false;
        const connecting = other.connect({ url: URL_B }).then(() => (connected = true));
        await until(() => connected);
        expect(saved(storage)?.url).toBe(URL_B);
        await Promise.all([suspending, connecting]);
        release();
        await starting;
        expect(writes).toEqual([JSON.stringify({ url: URL_B, token: null })]);
        expect(deletes).toBe(0);
      } finally {
        release();
        other.stop();
        client.stop();
      }
    });

    it("F-457: stopping while a startup Suspend rechecks the saved gateway frees the shared queue", async () => {
      const storage = memoryStorage({ connection: JSON.stringify({ url: URL_A, token: null }) });
      const firstRead = deferred<void>();
      const firstGate = deferred<void>();
      const rechecking = deferred<void>();
      const recheckGate = deferred<void>();
      const get = storage.get;
      let reads = 0;
      storage.get = async (key) => {
        if (key !== "connection") return get(key);
        reads += 1;
        if (reads === 1) {
          firstRead.resolve();
          await firstGate.promise;
        } else if (reads === 2) {
          rechecking.resolve();
          await recheckGate.promise;
        }
        return get(key);
      };
      const gatewayA = pairingGateway("token-A");
      const client = new ClawtrateClient(testHost(gatewayA, storage), FAST);
      const other = new ClawtrateClient(testHost(pairingGateway("token-B"), storage), FAST);
      try {
        const starting = client.start();
        await firstRead.promise;
        const suspending = client.suspend();
        firstGate.resolve();
        await rechecking.promise;
        client.stop();
        await other.start({ resume: false });
        const connecting = other.connect({ url: URL_B });
        let settled = false;
        const all = Promise.all([starting, suspending, connecting]).then(() => (settled = true));
        await until(() => settled, 1_000);
        await all;
        expect(saved(storage)).toEqual({ url: URL_B, token: null });
        recheckGate.resolve();
        await sleep(50);
        expect(saved(storage)).toEqual({ url: URL_B, token: null });
        expect(gatewayA.sockets).toHaveLength(0);
      } finally {
        firstGate.resolve();
        recheckGate.resolve();
        other.stop();
        client.stop();
      }
    });

    it("F-457: Suspend then Retry at startup keeps a newer token saved for the same gateway", async () => {
      const storage = memoryStorage({
        connection: JSON.stringify({ url: URL_A, token: "old-token" }),
      });
      const reading = deferred<void>();
      const gate = deferred<void>();
      const get = storage.get;
      let paused = false;
      storage.get = async (key) => {
        if (key !== "connection" || paused) return get(key);
        paused = true;
        const value = await get(key);
        reading.resolve();
        await gate.promise;
        return value;
      };
      const gatewayA = new FakeGateway();
      gatewayA.connectReply = () => ({
        ok: false,
        error: {
          code: "NOT_PAIRED",
          message: "pairing required",
          details: { code: "PAIRING_REQUIRED", requestId: "req-1", deviceId: "device-1" },
        },
      });
      const otherGateway = new FakeGateway();
      otherGateway.refuseConnections = true;
      const client = new ClawtrateClient(testHost(gatewayA, storage), FAST);
      const other = new ClawtrateClient(testHost(otherGateway, storage), FAST);
      try {
        const starting = client.start();
        await reading.promise;
        await other.start({ resume: false });
        await other.connect({ url: URL_A, token: "new-token" });
        other.stop();
        expect(saved(storage)).toEqual({ url: URL_A, token: "new-token" });

        const written: Array<{ url: string; token: string | null; suspended?: boolean }> = [];
        const set = storage.set;
        storage.set = (key, value) => {
          if (key === "connection") {
            written.push(
              JSON.parse(value) as { url: string; token: string | null; suspended?: boolean },
            );
          }
          return set(key, value);
        };

        const suspending = client.suspend();
        const retrying = client.retryNow();
        gate.resolve();
        await Promise.all([starting, suspending, retrying]);
        expect(written).toEqual([
          { url: URL_A, token: "new-token", suspended: true },
          { url: URL_A, token: "new-token", suspended: false },
        ]);
        expect(saved(storage)).toEqual({ url: URL_A, token: "new-token", suspended: false });
        await until(() => gatewayA.connects.length >= 1);
        expect((gatewayA.connects[0] as ConnectParams).auth?.token).toBe("new-token");
      } finally {
        gate.resolve();
        other.stop();
        client.stop();
      }
    });
  });

  it("F-387: Retry after another client chose B saves this client's gateway, the person's latest choice", async () => {
    const storage = memoryStorage();
    const client = new ClawtrateClient(testHost(pairingGateway("token-A"), storage), FAST);
    const other = new ClawtrateClient(testHost(pairingGateway("token-B"), storage), FAST);
    try {
      await client.start({ resume: false });
      await client.connect({ url: URL_A });
      await until(() => client.state.connection.status === "connected");
      await client.suspend();
      await other.start({ resume: false });
      await other.connect({ url: URL_B });
      await client.retryNow();
      expect(saved(storage)).toMatchObject({ url: URL_A, suspended: false });
    } finally {
      other.stop();
      client.stop();
    }
  });
});
