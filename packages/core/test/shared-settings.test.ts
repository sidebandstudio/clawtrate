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
 * Stop `client` right after B's device token is written, and note any save of B to the record
 * after that.
 */
function stopOnTokenWrite(storage: KeyValueStore, client: () => ClawtrateClient) {
  let stopped = false;
  let savedAfterStop = false;
  const set = storage.set;
  storage.set = async (key, value) => {
    if (stopped && key === "connection" && value.includes(URL_B)) savedAfterStop = true;
    await set(key, value);
    if (!stopped && key === tokenKey(URL_B)) {
      stopped = true;
      client().stop();
    }
  };
  return { stopped: () => stopped, savedAfterStop: () => savedAfterStop };
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
    const watch = stopOnTokenWrite(storage, () => client);
    try {
      await client.start();
      await until(() => client.state.connection.status === "connected");
      await client.connectWithSetupCode(setupCode);
      await until(watch.stopped);
      await sleep(30);
      expect(watch.stopped()).toBe(true);
      expect(watch.savedAfterStop()).toBe(false);
      expect(saved(storage)).toEqual({ url: URL_A, token: null });
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
      const watch = stopOnTokenWrite(storage, () => client);
      await client.connectForSetup(URL_B);
      await until(watch.stopped);
      await sleep(30);
      expect(watch.stopped()).toBe(true);
      expect(watch.savedAfterStop()).toBe(false);
      expect(saved(storage)).toEqual({ url: URL_A, token: null });
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
      const hold = holdRead(storage, "connection");
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

  it("startup reads the saved gateway again when another client saved B during the read, and resumes B", async () => {
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
      // The read returned A from before B was saved; the client reads again, and keeps B.
      await until(() => client.state.connection.status === "connected");
      expect(client.state.connection.gatewayUrl).toBe(URL_B);
      // B is the record it resumed, so setup's Back forgets it, as for any resumed gateway.
      const selection = client.nextSelection();
      await client.connectWithSetupCode({ ...setupCode, url: URL_C });
      await until(() => client.state.connection.status === "pairing");
      await client.disconnect(URL_C, selection);
      expect(saved(storage)).toBeNull();
    } finally {
      gate.resolve();
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
