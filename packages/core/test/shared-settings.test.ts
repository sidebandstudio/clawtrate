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

/** A gateway that pairs B only with a setup code's request, and connects A with its device token. */
function setupGateway() {
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
  return gateway;
}

/** A gateway that asks every device at `target` to wait for pairing, and connects others. */
function pairingAt(target: string) {
  const gateway = new FakeGateway();
  gateway.connectReply = (params, url) => {
    const { scopes, auth } = params as ConnectParams;
    if (url === target)
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
  return gateway;
}

const pairingAtB = () => pairingAt(URL_B);

const setupCode = { url: URL_B, bootstrapToken: CODE, expiresAtMs: Date.now() + 600_000 };

/**
 * Stop `client` if it reads the saved record once B's device token is saved, and note any save
 * of B to the record after that.
 */
function stopOnRecordRead(
  storage: KeyValueStore & { data: Map<string, string> },
  client: () => ClawtrateClient,
) {
  let stopped = false;
  let savedAfterStop = false;
  const get = storage.get;
  storage.get = async (key) => {
    if (!stopped && key === "connection" && storage.data.has(tokenKey(URL_B))) {
      stopped = true;
      const value = await get(key);
      client().stop();
      return value;
    }
    return get(key);
  };
  const set = storage.set;
  storage.set = async (key, value) => {
    if (stopped && key === "connection" && value.includes(URL_B)) savedAfterStop = true;
    return set(key, value);
  };
  return { savedAfterStop: () => savedAfterStop };
}

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

  it("setup's Back on a client that resumed nothing leaves gateway A, saved by another client during setup", async () => {
    const storage = memoryStorage();
    const client = new ClawtrateClient(testHost(pairingAtB(), storage), FAST);
    const other = new ClawtrateClient(testHost(pairingGateway("token-A"), storage), FAST);
    try {
      await client.start({ resume: false });
      const selection = client.nextSelection();
      await client.connectWithSetupCode(setupCode);
      await until(() => client.state.connection.status === "pairing");
      await other.start({ resume: false });
      await other.connect({ url: URL_A });
      await client.disconnect(URL_B, selection);
      expect(saved(storage)).toEqual({ url: URL_A, token: null });
    } finally {
      other.stop();
      client.stop();
    }
  });

  it("setup's Back leaves gateway A, saved again by another client after it chose C during setup", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: readToken("token-A"),
    });
    const client = new ClawtrateClient(testHost(pairingAtB(), storage), FAST);
    const other = new ClawtrateClient(testHost(pairingGateway("token-A"), storage), FAST);
    try {
      await client.start();
      await until(() => client.state.connection.status === "connected");
      const selection = client.nextSelection();
      await client.connectWithSetupCode(setupCode);
      await until(() => client.state.connection.status === "pairing");
      await other.start({ resume: false });
      await other.connect({ url: URL_C });
      await other.connect({ url: URL_A });
      await client.disconnect(URL_B, selection);
      expect(saved(storage)).toEqual({ url: URL_A, token: null });
    } finally {
      other.stop();
      client.stop();
    }
  });

  it("a setup stopped while it saves its gateway leaves gateway A for a restart", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: readToken("token-A"),
    });
    const client = new ClawtrateClient(testHost(setupGateway(), storage), FAST);
    const watch = stopOnRecordRead(storage, () => client);
    try {
      await client.start();
      await until(() => client.state.connection.status === "connected");
      await client.connectWithSetupCode(setupCode);
      await until(() => storage.data.has(tokenKey(URL_B)));
      await sleep(30);
      expect(watch.savedAfterStop()).toBe(false);
    } finally {
      client.stop();
    }
  });

  it("a setup reuse stopped while it saves its gateway leaves gateway A for a restart", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: readToken("token-A"),
      [tokenKey(URL_B)]: readToken("token-B"),
    });
    const gateway = pairingGateway("unused");
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    try {
      await client.start();
      await until(() => client.state.connection.status === "connected");
      const watch = stopOnRecordRead(storage, () => client);
      await client.connectForSetup(URL_B);
      await sleep(50);
      expect(watch.savedAfterStop()).toBe(false);
    } finally {
      client.stop();
    }
  });

  it("a setup for B saves B, though another client saved C before the person chose B", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: readToken("token-A"),
    });
    const client = new ClawtrateClient(testHost(setupGateway(), storage), FAST);
    const other = new ClawtrateClient(testHost(pairingGateway("token-C"), storage), FAST);
    try {
      await client.start();
      await until(() => client.state.connection.status === "connected");
      await other.start({ resume: false });
      await other.connect({ url: URL_C });
      await client.connectWithSetupCode(setupCode);
      await until(() => client.state.connection.status === "connected");
      await until(() => saved(storage)?.url === URL_B);
      expect(saved(storage)).toEqual({ url: URL_B, token: null });
    } finally {
      other.stop();
      client.stop();
    }
  });

  it("a setup on a client that resumed nothing leaves gateway C, which another client chose while it was pairing", async () => {
    const storage = memoryStorage();
    const gateway = setupGateway();
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    const other = new ClawtrateClient(testHost(pairingGateway("token-C"), storage), FAST);
    try {
      await client.start({ resume: false });
      await other.start({ resume: false });
      const hold = holdRead(storage, tokenKey(URL_B), () => gateway.connects.length > 0);
      await client.connectWithSetupCode(setupCode);
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

  it("suspending after another client forgot gateway A leaves A forgotten", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: readToken("token-A"),
    });
    const client = new ClawtrateClient(testHost(pairingGateway("token-A"), storage), FAST);
    const other = new ClawtrateClient(testHost(pairingGateway("token-A"), storage), FAST);
    try {
      await client.start();
      await other.start();
      await until(() => client.state.connection.status === "connected");
      await until(() => other.state.connection.status === "connected");
      await other.disconnect(URL_A);
      await client.suspend();
      expect(client.state.connection.status).toBe("disconnected");
      expect(saved(storage)).toBeNull();
    } finally {
      other.stop();
      client.stop();
    }
  });

  it("suspending a typed attempt keeps the token another client typed for A since", async () => {
    const storage = memoryStorage();
    const closed = new FakeGateway();
    closed.refuseConnections = true;
    const client = new ClawtrateClient(
      { ...testHost(closed, storage), credentialStatus: async () => "secure" },
      FAST,
    );
    const other = new ClawtrateClient(testHost(closed, storage), FAST);
    try {
      await client.start({ resume: false });
      await other.start({ resume: false });
      await client.connect({ url: URL_A, token: "typed-1" });
      await other.connect({ url: URL_A, token: "typed-2" });
      await client.suspend();
      expect(saved(storage)).toEqual({ url: URL_A, token: "typed-2", suspended: true });
    } finally {
      other.stop();
      client.stop();
    }
  });

  it("clearing A's shared token keeps the newer token another client saved for A meanwhile", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: "bootstrap" }),
      [tokenKey(URL_A)]: readToken("token-A"),
    });
    let replied = false;
    const gateway = pairingGateway("token-A", () => {
      replied = true;
    });
    const hold = holdRead(storage, tokenKey(URL_A), () => replied);
    const closed = new FakeGateway();
    closed.refuseConnections = true;
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    const other = new ClawtrateClient(testHost(closed, storage), FAST);
    try {
      await client.start();
      await until(hold.waiting);
      await other.start({ resume: false });
      await other.connect({ url: URL_A, token: "bootstrap-2" });
      hold.release();
      await until(() => client.state.connection.status === "connected");
      await sleep(30);
      expect(saved(storage)).toEqual({ url: URL_A, token: "bootstrap-2" });
    } finally {
      hold.release();
      other.stop();
      client.stop();
    }
  });

  it("Reconnect lifts a suspension another client saved while this one's hello cleared the shared token", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: "bootstrap" }),
      [tokenKey(URL_A)]: readToken("token-A"),
    });
    let replied = false;
    const gateway = pairingGateway("token-A", () => {
      replied = true;
    });
    const hold = holdRead(storage, tokenKey(URL_A), () => replied);
    const closed = new FakeGateway();
    closed.refuseConnections = true;
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    const other = new ClawtrateClient(testHost(closed, storage), FAST);
    try {
      await client.start();
      await until(hold.waiting);
      await other.start();
      await other.suspend();
      hold.release();
      await until(() => saved(storage)?.token === null);
      expect(saved(storage)).toMatchObject({ url: URL_A, suspended: true });
      // The connection drops and stays down until the person's Reconnect.
      gateway.refuseConnections = true;
      gateway.dropAll();
      await until(() => client.state.connection.status !== "connected");
      gateway.refuseConnections = false;
      await client.retryNow();
      expect(saved(storage)).toMatchObject({ url: URL_A, suspended: false });
    } finally {
      hold.release();
      other.stop();
      client.stop();
    }
  });

  it("Reconnect after another client saved B leaves out the shared token cleared before the suspend", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: "bootstrap" }),
    });
    const closed = new FakeGateway();
    closed.refuseConnections = true;
    const client = new ClawtrateClient(testHost(closed, storage), FAST);
    const other = new ClawtrateClient(testHost(pairingGateway("issued-A"), storage), FAST);
    try {
      await client.start();
      // The other client pairs, which drops the shared token, and then chooses B.
      await other.start();
      await until(() => other.state.connection.status === "connected");
      await until(() => saved(storage)?.token === null);
      await client.suspend();
      await other.connect({ url: URL_B });
      await client.retryNow();
      expect(saved(storage)).toEqual({ url: URL_A, token: null, suspended: false });
    } finally {
      other.stop();
      client.stop();
    }
  });

  it("a setup for B saves B, though another client's hello cleared A's shared token while B paired", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: "bootstrap" }),
    });
    const gateway = setupGateway();
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    const other = new ClawtrateClient(testHost(pairingGateway("token-A"), storage), FAST);
    try {
      await client.start({ resume: "disconnected" });
      const hold = holdRead(storage, tokenKey(URL_B), () => gateway.connects.length > 0);
      await client.connectWithSetupCode(setupCode);
      await until(hold.waiting);
      await other.start();
      await until(() => saved(storage)?.token === null);
      hold.release();
      await until(() => client.state.connection.status === "connected");
      await until(() => saved(storage)?.url === URL_B);
      other.stop();
      client.stop();
      const restarted = new ClawtrateClient(testHost(new FakeGateway(), storage), FAST);
      try {
        await restarted.start({ resume: "disconnected" });
        expect(restarted.state.connection.gatewayUrl).toBe(URL_B);
      } finally {
        restarted.stop();
      }
    } finally {
      other.stop();
      client.stop();
    }
  });

  it("a setup for B saves B, though another client went Back from its unsaved setup while B paired", async () => {
    const storage = memoryStorage();
    const gateway = setupGateway();
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    // The other client's setup is for C, which waits for pairing: a second socket for B would
    // stop this one's pairing.
    const waitsAtC = pairingAtB();
    const refuse = waitsAtC.connectReply;
    waitsAtC.connectReply = (params) => refuse(params, URL_B);
    const other = new ClawtrateClient(testHost(waitsAtC, storage), FAST);
    try {
      await client.start();
      const hold = holdRead(storage, tokenKey(URL_B), () => gateway.connects.length > 0);
      await client.connectWithSetupCode(setupCode);
      await until(hold.waiting);
      await other.start({ resume: false });
      const selection = other.nextSelection();
      await other.connectWithSetupCode({ ...setupCode, url: URL_C });
      await until(() => other.state.connection.status === "pairing");
      expect(saved(storage)).toBeNull();
      await other.disconnect(URL_C, selection);
      hold.release();
      await until(() => client.state.connection.status === "connected");
      await until(() => saved(storage) !== null);
      expect(saved(storage)).toEqual({ url: URL_B, token: null });
    } finally {
      other.stop();
      client.stop();
    }
  });

  it("Reconnect after another client cleared A's shared token and chose B, before this one's suspend, leaves the token out", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: "bootstrap" }),
    });
    const closed = new FakeGateway();
    closed.refuseConnections = true;
    const client = new ClawtrateClient(testHost(closed, storage), FAST);
    const other = new ClawtrateClient(testHost(pairingGateway("issued-A"), storage), FAST);
    try {
      await client.start();
      // The other client pairs, which drops the shared token, and then chooses B.
      await other.start();
      await until(() => other.state.connection.status === "connected");
      await until(() => saved(storage)?.token === null);
      await other.connect({ url: URL_B });
      await client.suspend();
      await client.retryNow();
      expect(saved(storage)).toEqual({ url: URL_A, token: null, suspended: false });
    } finally {
      other.stop();
      client.stop();
    }
  });

  it("setup's Back leaves gateway B, which another client saved with its own token during setup for B", async () => {
    const storage = memoryStorage();
    const closed = new FakeGateway();
    closed.refuseConnections = true;
    const client = new ClawtrateClient(testHost(pairingAtB(), storage), FAST);
    const other = new ClawtrateClient(testHost(closed, storage), FAST);
    try {
      await client.start();
      const selection = client.nextSelection();
      await client.connectWithSetupCode(setupCode);
      await until(() => client.state.connection.status === "pairing");
      await other.start({ resume: false });
      await other.connect({ url: URL_B, token: "typed-B" });
      await client.disconnect(URL_B, selection);
      expect(saved(storage)).toEqual({ url: URL_B, token: "typed-B" });
    } finally {
      other.stop();
      client.stop();
    }
  });

  it("Reconnect lifts a suspension another client saved before this one's refused token was cleared", async () => {
    const storage = memoryStorage({ connection: JSON.stringify({ url: URL_A, token: null }) });
    const gateway = new FakeGateway();
    const other = new ClawtrateClient(testHost(new FakeGateway(), storage), FAST);
    let suspending: Promise<void> | null = null;
    gateway.connectReply = () => {
      // The other client's suspension is queued before this refusal's clean-up.
      suspending ??= other.suspend();
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
      await other.start({ resume: "disconnected" });
      await client.start({ resume: false });
      await client.connect({ url: URL_A, token: "typed-token" });
      await until(() => client.state.connection.error?.code === "AUTH_RATE_LIMITED");
      await suspending;
      await until(() => saved(storage)?.token === null);
      expect(saved(storage)).toMatchObject({ url: URL_A, suspended: true });
      await client.retryNow();
      expect(saved(storage)).toEqual({ url: URL_A, token: null, suspended: false });
    } finally {
      other.stop();
      client.stop();
    }
  });

  it("setup's Back forgets gateway A, which this client resumed after another client saved it during startup", async () => {
    const storage = memoryStorage();
    const client = new ClawtrateClient(testHost(pairingAtB(), storage), FAST);
    const other = new ClawtrateClient(testHost(pairingGateway("token-A"), storage), FAST);
    try {
      const hold = holdRead(storage, "show-channel-chats");
      const starting = client.start();
      await until(hold.waiting);
      await other.start({ resume: false });
      await other.connect({ url: URL_A });
      hold.release();
      await starting;
      await until(() => client.state.connection.status === "connected");
      expect(client.state.connection.gatewayUrl).toBe(URL_A);
      const selection = client.nextSelection();
      await client.connectWithSetupCode(setupCode);
      await until(() => client.state.connection.status === "pairing");
      await client.disconnect(URL_B, selection);
      expect(saved(storage)).toBeNull();
    } finally {
      other.stop();
      client.stop();
    }
  });

  it("setup's Back leaves gateway B, saved while startup's read returned a stale record", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: readToken("token-A"),
    });
    const gate = deferred<void>();
    let waiting = false;
    let held = false;
    const get = storage.get;
    storage.get = async (key) => {
      if (!held && key === "connection") {
        held = true;
        const stale = await get(key);
        waiting = true;
        await gate.promise;
        return stale;
      }
      return get(key);
    };
    const client = new ClawtrateClient(testHost(pairingAt(URL_C), storage), FAST);
    const other = new ClawtrateClient(testHost(pairingGateway("token-B"), storage), FAST);
    try {
      const starting = client.start();
      await until(() => waiting);
      await other.start({ resume: false });
      await other.connect({ url: URL_B });
      gate.resolve();
      await starting;
      await until(() => client.state.connection.status === "connected");
      expect(client.state.connection.gatewayUrl).toBe(URL_A);
      const selection = client.nextSelection();
      await client.connectWithSetupCode({ ...setupCode, url: URL_C });
      await until(() => client.state.connection.status === "pairing");
      await client.disconnect(URL_C, selection);
      expect(saved(storage)).toEqual({ url: URL_B, token: null });
    } finally {
      gate.resolve();
      other.stop();
      client.stop();
    }
  });
});
