// Two clients that share one host store share one saved gateway. Each of a client's
// writes to that record acts on the record as it is when the write runs, not on what this
// client last saved, so it never removes, replaces or brings back another client's gateway.

import { describe, expect, it } from "vitest";
import { ClawtrateClient } from "../src/client.ts";
import { FAST, URL_A, URL_B } from "./client-harness.ts";
import type { KeyValueStore } from "../src/host.ts";
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

const URL_C = "ws://127.0.0.1:19003";
const CODE = "setup-bootstrap-0123456789abcdefghijklmnopqrstuvw";
const readToken = (token: string) =>
  JSON.stringify({ token, grantedScopes: ["operator.read"], heldScopes: ["operator.read"] });

/** Hold the next read of `key` once `armed()` says so, until the returned gate opens. */
function holdRead(storage: KeyValueStore, key: string, armed: () => boolean = () => true) {
  const gate = deferred<void>();
  let waiting = false;
  let done = false;
  const get = storage.get;
  storage.get = async (read) => {
    if (!done && read === key && armed()) {
      done = true;
      waiting = true;
      await gate.promise;
    }
    return get(read);
  };
  return { release: () => gate.resolve(), waiting: () => waiting };
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

  it("clearing A's shared token keeps what another client saved for A meanwhile, such as a suspend", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: "bootstrap" }),
    });
    let replied = false;
    const gateway = pairingGateway("issued-A", () => {
      replied = true;
    });
    const hold = holdRead(storage, tokenKey(URL_A), () => replied);
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    const other = new ClawtrateClient(testHost(new FakeGateway(), storage), FAST);
    try {
      await client.start();
      await until(hold.waiting);
      // The other client shows A and is disconnected from it, which is saved.
      await other.start({ resume: "disconnected" });
      await other.suspend();
      expect(saved(storage)).toMatchObject({ url: URL_A, suspended: true });
      hold.release();
      await until(() => storage.data.has(tokenKey(URL_A)));
      await until(() => client.state.connection.status === "connected");
      await sleep(30);
      expect(saved(storage)).toEqual({ url: URL_A, token: null, suspended: true });
    } finally {
      hold.release();
      other.stop();
      client.stop();
    }
  });

  it("a typed token ending after another client saved gateway B leaves B saved", async () => {
    const storage = memoryStorage();
    const gateway = new FakeGateway();
    // The other client's save of B waits while this attempt's refusal comes in.
    const saving = deferred<void>();
    const set = storage.set;
    storage.set = async (key, value) => {
      if (key === "connection" && value.includes(URL_B)) await saving.promise;
      return set(key, value);
    };
    const other = new ClawtrateClient(testHost(pairingGateway("token-B"), storage), FAST);
    let connecting: Promise<void> | null = null;
    gateway.connectReply = () => {
      connecting ??= other.connect({ url: URL_B });
      return {
        ok: false,
        error: { code: "UNAUTHORIZED", message: "refused", details: { code: "AUTH_RATE_LIMITED" } },
      };
    };
    const client = new ClawtrateClient(
      { ...testHost(gateway, storage), credentialStatus: async () => "secure" },
      FAST,
    );
    try {
      await other.start({ resume: false });
      await client.start();
      await client.connect({ url: URL_A, token: "typed-token" });
      await until(() => client.state.connection.error?.code === "AUTH_RATE_LIMITED");
      saving.resolve();
      await connecting;
      await sleep(30);
      expect(saved(storage)).toEqual({ url: URL_B, token: null });
    } finally {
      saving.resolve();
      other.stop();
      client.stop();
    }
  });

  it("suspending after another client saved gateway B leaves B saved", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: readToken("token-A"),
    });
    const client = new ClawtrateClient(testHost(pairingGateway("token-A"), storage), FAST);
    const other = new ClawtrateClient(testHost(pairingGateway("token-B"), storage), FAST);
    try {
      await client.start();
      await until(() => client.state.connection.status === "connected");
      await other.start({ resume: false });
      await other.connect({ url: URL_B });
      await client.suspend();
      expect(client.state.connection.status).toBe("disconnected");
      expect(saved(storage)).toEqual({ url: URL_B, token: null });
    } finally {
      other.stop();
      client.stop();
    }
  });

  it("a setup's late save leaves gateway C, which another client chose while it was pairing", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: readToken("token-A"),
    });
    const gateway = new FakeGateway();
    gateway.connectReply = (params, url) => {
      const { scopes, auth } = params as ConnectParams & { auth?: { bootstrapToken?: string } };
      if (url === URL_B && auth?.bootstrapToken)
        return {
          ok: true,
          payload: {
            ...helloOk(),
            auth: { role: "operator", scopes: ["operator.read"], deviceToken: "token-B" },
          },
        };
      return { ok: true, payload: helloOk(scopes, auth?.deviceToken ?? "token-A") };
    };
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    const other = new ClawtrateClient(testHost(pairingGateway("token-C"), storage), FAST);
    try {
      await client.start();
      await until(() => client.state.connection.status === "connected");
      await other.start({ resume: false });
      // The setup's hello reads B's token record and waits while the other client chooses C.
      const before = gateway.connects.length;
      const hold = holdRead(storage, tokenKey(URL_B), () => gateway.connects.length > before);
      await client.connectWithSetupCode({
        url: URL_B,
        bootstrapToken: CODE,
        expiresAtMs: Date.now() + 600_000,
      });
      await until(hold.waiting);
      const choosing = other.connect({ url: URL_C });
      await sleep(10);
      hold.release();
      await choosing;
      await until(() => storage.data.has(tokenKey(URL_B)));
      await until(() => client.state.connection.status === "connected");
      await sleep(30);
      expect(saved(storage)).toEqual({ url: URL_C, token: null });
    } finally {
      other.stop();
      client.stop();
    }
  });

  it("a setup reuse's late save leaves gateway C, which another client chose while its hello was saving", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: readToken("token-A"),
      [tokenKey(URL_B)]: readToken("token-B"),
    });
    const gateway = pairingGateway("unused");
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    const other = new ClawtrateClient(testHost(pairingGateway("token-C"), storage), FAST);
    try {
      await client.start();
      await until(() => client.state.connection.status === "connected");
      await other.start({ resume: false });
      // The reuse's hello reads B's token record and waits while the other client chooses C.
      const before = gateway.connects.length;
      const hold = holdRead(storage, tokenKey(URL_B), () => gateway.connects.length > before);
      await client.connectForSetup(URL_B);
      await until(hold.waiting);
      await other.connect({ url: URL_C });
      hold.release();
      await until(() => client.state.connection.status === "connected");
      await sleep(30);
      expect(saved(storage)).toEqual({ url: URL_C, token: null });
    } finally {
      other.stop();
      client.stop();
    }
  });

  it("setup's Back forgets the gateway this client saved before setup began", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: readToken("token-A"),
    });
    const gateway = new FakeGateway();
    gateway.connectReply = (params, url) => {
      const { scopes, auth } = params as ConnectParams;
      if (url === URL_B)
        return {
          ok: false,
          error: {
            code: "NOT_PAIRED",
            message: "pairing required",
            details: { code: "PAIRING_REQUIRED", requestId: "req-1", deviceId: "device-1" },
          },
        };
      return { ok: true, payload: helloOk(scopes, auth?.deviceToken) };
    };
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    try {
      await client.start();
      await until(() => client.state.connection.status === "connected");
      const selection = client.nextSelection();
      await client.connectWithSetupCode({
        url: URL_B,
        bootstrapToken: CODE,
        expiresAtMs: Date.now() + 600_000,
      });
      await until(() => client.state.connection.status === "pairing");
      await client.disconnect(URL_B, selection);
      expect(saved(storage)).toBeNull();
    } finally {
      client.stop();
    }
  });

  it("Reconnect keeps what another client changed in this gateway's record meanwhile", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: "bootstrap", suspended: true }),
    });
    const closed = new FakeGateway();
    closed.refuseConnections = true;
    const client = new ClawtrateClient(testHost(closed, storage), FAST);
    const other = new ClawtrateClient(testHost(pairingGateway("issued-A"), storage), FAST);
    try {
      await client.start();
      await other.start();
      // The other client pairs, which drops the shared token, and suspends.
      await other.retryNow();
      await until(() => other.state.connection.status === "connected");
      await until(() => saved(storage)?.token === null);
      await other.suspend();
      await client.retryNow();
      expect(saved(storage)).toEqual({ url: URL_A, token: null, suspended: false });
    } finally {
      other.stop();
      client.stop();
    }
  });

  it("suspending keeps what another client changed in this gateway's record meanwhile", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: "bootstrap" }),
    });
    const closed = new FakeGateway();
    closed.refuseConnections = true;
    const client = new ClawtrateClient(testHost(closed, storage), FAST);
    const other = new ClawtrateClient(testHost(pairingGateway("issued-A"), storage), FAST);
    try {
      await client.start();
      // The other client pairs, which drops the shared token.
      await other.start();
      await until(() => other.state.connection.status === "connected");
      await until(() => saved(storage)?.token === null);
      await client.suspend();
      expect(saved(storage)).toEqual({ url: URL_A, token: null, suspended: true });
    } finally {
      other.stop();
      client.stop();
    }
  });
});
