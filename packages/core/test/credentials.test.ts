// A credential never crosses gateways, and losing access is represented and
// recoverable: every stored token, handshake and persistence step belongs to
// the gateway it came from, and anything finishing after a switch is dropped.

import { describe, expect, it } from "vitest";
import { ClawtrateClient } from "../src/client.ts";
import { INTERACTIVE_SCOPES, READ_SCOPES } from "../src/scopes.ts";
import { FAST, KEY, openTask, URL_A, URL_B } from "./client-harness.ts";
import {
  deferred,
  FakeGateway,
  GatewayError,
  gatedStorage,
  helloOk,
  memoryStorage,
  sleep,
  testHost,
  tokenKey,
  until,
} from "./fake-gateway.ts";

type ConnectParams = { scopes: string[]; auth?: { token?: string; deviceToken?: string } };

/** One fake serving two gateways, each issuing its own device token. */
function twoGateways() {
  const gateway = new FakeGateway();
  gateway.connectReply = (params, url) => {
    const { scopes, auth } = params as ConnectParams;
    const issued = url === URL_A ? "token-A" : "token-B";
    return { ok: true, payload: helloOk(scopes, auth?.deviceToken ?? issued) };
  };
  return gateway;
}

const connectAuth = (gateway: FakeGateway, index: number) =>
  (gateway.connects[index] as ConnectParams).auth;

describe("a credential never crosses gateways", () => {
  it("drops A's token write that completes after switching to B", async () => {
    const gateway = twoGateways();
    const storage = gatedStorage();
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    // Hold A's token read inside the hello handling, then switch to B.
    const originalReply = gateway.connectReply;
    gateway.connectReply = (params, url) => {
      if (url === URL_A) storage.hold(tokenKey(URL_A));
      return originalReply(params, url);
    };
    await client.connect({ url: URL_A, token: "boot-A" });
    await until(() => storage.waiting(tokenKey(URL_A)) > 0);
    gateway.connectReply = originalReply;
    await client.connect({ url: URL_B, token: "boot-B" });
    await until(
      () =>
        client.state.connection.status === "connected" &&
        client.state.connection.gatewayUrl === URL_B,
    );
    await until(() => storage.data.has(tokenKey(URL_B)));
    storage.release(tokenKey(URL_A));
    await sleep(30);

    expect(JSON.parse(storage.data.get(tokenKey(URL_B))!).token).toBe("token-B");
    expect(storage.data.has(tokenKey(URL_A))).toBe(false);
    // B's settings keep B's URL; A's late hello did not touch them.
    expect(JSON.parse(storage.data.get("connection")!)).toEqual({ url: URL_B, token: null });
    gateway.dropAll();
    await until(() => gateway.connects.length >= 3);
    const auth = connectAuth(gateway, gateway.connects.length - 1);
    expect(auth?.deviceToken ?? auth?.token).toBe("token-B");
    client.stop();
  });

  it("keeps B's bootstrap token when A's hello finishes late", async () => {
    const gateway = twoGateways();
    const storage = gatedStorage();
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    const reply = gateway.connectReply;
    gateway.connectReply = (params, url) => {
      if (url === URL_A) {
        storage.hold(tokenKey(URL_A));
        return reply(params, url);
      }
      // B is not paired yet: it holds a pending pairing request.
      return {
        ok: false,
        error: {
          code: "NOT_PAIRED",
          message: "pairing required",
          details: { code: "PAIRING_REQUIRED", requestId: "req-B" },
        },
      };
    };
    await client.connect({ url: URL_A, token: "boot-A" });
    await until(() => storage.waiting(tokenKey(URL_A)) > 0);
    await client.connect({ url: URL_B, token: "boot-B" });
    await until(() => client.state.connection.status === "pairing");
    storage.release(tokenKey(URL_A));
    await sleep(30);
    expect(JSON.parse(storage.data.get("connection")!)).toEqual({ url: URL_B, token: "boot-B" });
    client.stop();
  });

  it("drops an upgrade that is approved after switching gateways", async () => {
    const gateway = twoGateways();
    const wait = deferred<unknown>();
    gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-A" });
    gateway.handlers["device.scopes.waitUpgrade"] = () => wait.promise;
    const storage = memoryStorage();
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await client.connect({ url: URL_A, token: "boot-A" });
    await until(() => client.state.connection.status === "connected");
    await client.requestAccess();
    await until(() => client.state.connection.upgrade.status === "pending");
    await client.connect({ url: URL_B, token: "boot-B" });
    await until(
      () =>
        client.state.connection.gatewayUrl === URL_B &&
        client.state.connection.status === "connected",
    );
    wait.resolve({
      status: "approved",
      requestId: "up-A",
      deviceToken: "rotated-A",
      scopes: [...INTERACTIVE_SCOPES],
    });
    await sleep(30);
    expect(JSON.parse(storage.data.get(tokenKey(URL_B))!).token).toBe("token-B");
    for (const value of storage.data.values()) expect(value).not.toContain("rotated-A");
    expect(client.state.connection.requestedScopes).toEqual([...READ_SCOPES]);
    client.stop();
  });
});

describe("losing access is represented and recoverable (B1)", () => {
  it("drops the scope the gateway refused and asks again on retry instead of repeating the call", async () => {
    const { client, gateway, transcript } = await openTask();
    let refuse = true;
    gateway.handlers["chat.send"] = () => {
      if (refuse) {
        throw new GatewayError({
          code: "FORBIDDEN",
          message: "missing scope",
          details: {
            code: "MISSING_SCOPE",
            missingScope: "operator.write",
            requiredScopes: ["operator.write"],
          },
        });
      }
      return { runId: "run-1", status: "started" };
    };
    gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-1" });
    gateway.handlers["device.scopes.waitUpgrade"] = () => new Promise(() => {});
    const id = client.sendMessage(KEY, "hi");
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(client.state.connection.scopes).not.toContain("operator.write");
    expect(client.state.connection.canWrite).toBe(false);
    refuse = false;
    client.retryMessage(KEY, id);
    await until(() => gateway.calls("device.scopes.requestUpgrade").length === 1);
    expect(gateway.calls("chat.send")).toHaveLength(1);
    expect(transcript().outbox[0]!.status).toBe("awaiting-access");
    client.stop();
  });

  it("settles waiting work when the gateway stops accepting this device, and clears every capability flag", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = (params) => ({
      ok: true,
      payload: helloOk((params as ConnectParams).scopes, "device-token"),
    });
    const wait = deferred<unknown>();
    gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-1" });
    gateway.handlers["device.scopes.waitUpgrade"] = () => wait.promise;
    gateway.handlers["question.list"] = () => ({ questions: [] });
    for (const method of ["exec.approval.list", "plugin.approval.list", "openclaw.approval.list"]) {
      gateway.handlers[method] = () => [];
    }
    const { client, transcript } = await openTask({ gateway, held: INTERACTIVE_SCOPES });
    expect(client.state.connection).toMatchObject({
      canWrite: true,
      canAnswer: true,
      canApprove: true,
    });
    // The token is revoked: every reconnect is refused.
    gateway.connectReply = () => ({
      ok: false,
      error: {
        code: "UNAUTHORIZED",
        message: "device token mismatch",
        details: { code: "AUTH_DEVICE_TOKEN_MISMATCH", recommendedNextStep: "re_pair" },
      },
    });
    gateway.dropAll();
    await until(() => client.state.connection.status !== "connected");
    expect(client.state.connection).toMatchObject({
      canWrite: false,
      canAnswer: false,
      canApprove: false,
    });
    client.sendMessage(KEY, "while reconnecting");
    await until(() => client.state.connection.status === "error", 3_000);
    await until(() => transcript().outbox[0]?.status === "failed");
    expect(transcript().runs.every((run) => run.state !== "running")).toBe(true);
    client.stop();
  });

  it("asks again for a scope a capped grant left out, rather than waiting forever", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = (params) => {
      const { scopes, auth } = params as ConnectParams;
      return { ok: true, payload: helloOk(scopes, auth?.deviceToken ?? "device-token") };
    };
    let requests = 0;
    const waits = [deferred<unknown>(), deferred<unknown>()];
    gateway.handlers["device.scopes.requestUpgrade"] = () => ({
      requestId: `up-${(requests += 1)}`,
    });
    gateway.handlers["device.scopes.waitUpgrade"] = () => waits[requests - 1]!.promise;
    gateway.handlers["question.list"] = () => ({ questions: [] });
    for (const method of ["exec.approval.list", "plugin.approval.list", "openclaw.approval.list"]) {
      gateway.handlers[method] = () => [];
    }
    const { client, storage } = await openTask({ gateway, held: READ_SCOPES });
    await client.requestAccess();
    await until(() => requests === 1);
    // The owner's role policy caps the grant at read and write.
    waits[0]!.resolve({
      status: "approved",
      requestId: "up-1",
      deviceToken: "rotated",
      scopes: ["operator.read", "operator.write"],
    });
    await until(() => client.state.connection.canWrite);
    expect(client.state.connection.requestedScopes).toEqual(["operator.read", "operator.write"]);
    expect(client.state.connection.canAnswer).toBe(false);
    expect(JSON.parse(storage.data.get(tokenKey(URL_A))!).heldScopes).toEqual([
      "operator.read",
      "operator.write",
    ]);
    // Read access is kept throughout.
    expect(client.state.connection.scopes).toContain("operator.read");
    client.stop();
  });
});

const tokenMismatch = {
  code: "UNAUTHORIZED",
  message: "device token mismatch",
  details: { code: "AUTH_DEVICE_TOKEN_MISMATCH", recommendedNextStep: "re_pair" },
};

const savedToken = (token: string) =>
  JSON.stringify({ token, grantedScopes: [...READ_SCOPES], heldScopes: [...READ_SCOPES] });

/** A client connected to A with `token-A` saved, on a gateway that accepts the token it is sent. */
async function pairedOnA(storage = memoryStorage()) {
  storage.data.set("connection", JSON.stringify({ url: URL_A, token: null }));
  storage.data.set(tokenKey(URL_A), savedToken("token-A"));
  const gateway = new FakeGateway();
  gateway.connectReply = (params) => {
    const { scopes, auth } = params as ConnectParams;
    return { ok: true, payload: helloOk(scopes, auth?.deviceToken) };
  };
  const client = new ClawtrateClient(testHost(gateway, storage), FAST);
  await client.start();
  await until(() => client.state.connection.status === "connected");
  return { client, gateway, storage };
}

describe("a refused device token never removes a newer one", () => {
  it("keeps token B when the refusal of token A arrives after B was saved, and connects with B", async () => {
    const { client, gateway, storage } = await pairedOnA();
    const accept = gateway.connectReply;
    // The attempt offers A; before the gateway's refusal of A arrives, B is saved.
    gateway.connectReply = (params, url) => {
      if ((params as ConnectParams).auth?.deviceToken !== "token-A") return accept(params, url);
      storage.data.set(tokenKey(URL_A), savedToken("token-B"));
      return { ok: false, error: tokenMismatch };
    };
    gateway.dropAll();
    await until(() => client.state.connection.error?.code === "AUTH_DEVICE_TOKEN_MISMATCH");
    await sleep(30);
    expect(JSON.parse(storage.data.get(tokenKey(URL_A))!).token).toBe("token-B");
    await client.retryNow();
    await until(() => client.state.connection.status === "connected");
    expect(connectAuth(gateway, gateway.connects.length - 1)?.deviceToken).toBe("token-B");
    client.stop();
  });

  it("an automatic retry skips the refused token while its deletion waits", async () => {
    const { client, gateway, storage } = await pairedOnA();
    const held = deferred<void>();
    const remove = storage.delete;
    storage.delete = async (key) => {
      if (key === tokenKey(URL_A)) await held.promise;
      await remove(key);
    };
    try {
      gateway.connectReply = () => ({
        ok: false,
        error: { ...tokenMismatch, details: { code: "AUTH_TOKEN_MISMATCH" } },
      });
      gateway.dropAll();
      await until(() => gateway.connects.length >= 3);
      expect(connectAuth(gateway, 1)?.deviceToken).toBe("token-A");
      expect(connectAuth(gateway, 2)?.deviceToken).toBeUndefined();
    } finally {
      held.resolve();
      client.stop();
    }
  });

  it("a late hello preserves a token replaced since the handshake started", async () => {
    const { client, gateway, storage } = await pairedOnA();
    const otherGateway = new FakeGateway();
    const other = new ClawtrateClient(testHost(otherGateway, storage), FAST);
    const held = deferred<void>();
    let holdNext = false;
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
    try {
      gateway.connectReply = () => {
        holdNext = true;
        return { ok: true, payload: helloOk([...READ_SCOPES], "older-token") };
      };
      otherGateway.connectReply = () => ({
        ok: true,
        payload: helloOk([...READ_SCOPES], "newer-token"),
      });
      gateway.dropAll();
      await until(() => waiting);
      await other.start();
      await until(() => other.state.connection.status === "connected");
      held.resolve();
      await until(() => client.state.connection.status === "connected");
      expect(JSON.parse(storage.data.get(tokenKey(URL_A))!).token).toBe("newer-token");
    } finally {
      held.resolve();
      other.stop();
      client.stop();
    }
  });

  it("never sends a token refused and removed while its connect was being signed", async () => {
    const { client, gateway, storage } = await pairedOnA();
    const otherGateway = new FakeGateway();
    otherGateway.connectReply = (params) => {
      const { scopes, auth } = params as ConnectParams;
      return { ok: true, payload: helloOk(scopes, auth?.deviceToken) };
    };
    const host = testHost(otherGateway, storage);
    const signed = deferred<void>();
    let signs = 0;
    host.signer.sign = async () => {
      if ((signs += 1) === 1) await signed.promise;
      return "signature";
    };
    const other = new ClawtrateClient(host, FAST);
    try {
      // The other client's plan has chosen token-A and is being signed.
      await other.start();
      await until(() => signs === 1);
      gateway.connectReply = () => ({ ok: false, error: tokenMismatch });
      gateway.dropAll();
      await until(() => !storage.data.has(tokenKey(URL_A)));
      signed.resolve();
      await until(() => other.state.connection.status === "connected");
      expect(otherGateway.connects.length).toBeGreaterThan(0);
      for (let i = 0; i < otherGateway.connects.length; i += 1) {
        expect(connectAuth(otherGateway, i)?.deviceToken).toBeUndefined();
      }
    } finally {
      signed.resolve();
      other.stop();
      client.stop();
    }
  });

  it("skips every refused token while their removals wait, not only the last one refused", async () => {
    const { client, gateway, storage } = await pairedOnA();
    const otherGateway = new FakeGateway();
    otherGateway.connectReply = (params) => {
      const { scopes, auth } = params as ConnectParams;
      if (auth?.deviceToken !== "token-0")
        return { ok: true, payload: helloOk(scopes, auth?.deviceToken) };
      return { ok: false, error: { ...tokenMismatch, details: { code: "AUTH_TOKEN_MISMATCH" } } };
    };
    const host = testHost(otherGateway, storage);
    const arrive = deferred<void>();
    let late = false;
    host.createWebSocket = (url) => {
      const socket = otherGateway.createWebSocket(url);
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        if (!data.includes('"token-0"')) return send(data);
        late = true;
        void arrive.promise.then(() => send(data));
      };
      return socket;
    };
    const held = deferred<void>();
    const remove = storage.delete;
    storage.delete = async (key) => {
      if (key === tokenKey(URL_A)) await held.promise;
      await remove(key);
    };
    const other = new ClawtrateClient(host, FAST);
    try {
      // The other client sends an older token-0, which reaches its gateway late.
      storage.data.set(tokenKey(URL_A), savedToken("token-0"));
      await other.start();
      await until(() => late);
      // Then token-A is saved and refused, and its removal waits.
      storage.data.set(tokenKey(URL_A), savedToken("token-A"));
      gateway.connectReply = () => ({ ok: false, error: tokenMismatch });
      gateway.dropAll();
      await until(() => client.state.connection.error?.code === "AUTH_DEVICE_TOKEN_MISMATCH");
      expect(connectAuth(gateway, 1)?.deviceToken).toBe("token-A");
      // token-0's refusal comes last; the retry after it must still skip token-A.
      arrive.resolve();
      await until(() => otherGateway.connects.length >= 2);
      expect(connectAuth(otherGateway, 0)?.deviceToken).toBe("token-0");
      expect(connectAuth(otherGateway, 1)?.deviceToken).toBeUndefined();
    } finally {
      arrive.resolve();
      held.resolve();
      other.stop();
      client.stop();
    }
  });

  it("never sends a token refused after its last read and before its frame", async () => {
    const { client, gateway, storage } = await pairedOnA();
    const otherGateway = new FakeGateway();
    otherGateway.connectReply = (params) => {
      const { scopes, auth } = params as ConnectParams;
      return { ok: true, payload: helloOk(scopes, auth?.deviceToken) };
    };
    const host = testHost(otherGateway, storage);
    const signed = deferred<void>();
    let signs = 0;
    host.signer.sign = async () => {
      if ((signs += 1) === 1) await signed.promise;
      return "signature";
    };
    // The other client's read after signing finds token-A; token-A's refusal is accepted
    // before that read hands it back, so before its frame goes.
    let lateRead = false;
    const get = storage.get;
    storage.get = async (key) => {
      const value = await get(key);
      if (lateRead && key === tokenKey(URL_A)) {
        lateRead = false;
        gateway.connectReply = () => ({ ok: false, error: tokenMismatch });
        gateway.dropAll();
        await until(() => client.state.connection.error?.code === "AUTH_DEVICE_TOKEN_MISMATCH");
      }
      return value;
    };
    const other = new ClawtrateClient(host, FAST);
    try {
      await other.start();
      await until(() => signs === 1);
      lateRead = true;
      signed.resolve();
      await until(() => other.state.connection.status === "connected");
      expect(connectAuth(gateway, 1)?.deviceToken).toBe("token-A");
      expect(otherGateway.connects.length).toBeGreaterThan(0);
      for (let i = 0; i < otherGateway.connects.length; i += 1) {
        expect(connectAuth(otherGateway, i)?.deviceToken).toBeUndefined();
      }
    } finally {
      signed.resolve();
      other.stop();
      client.stop();
    }
  });

  it("a setup reuse never sends a token replaced while its connect was being signed", async () => {
    const storage = memoryStorage({ [tokenKey(URL_A)]: savedToken("token-A") });
    const gateway = new FakeGateway();
    gateway.connectReply = (params) => {
      if ((params as ConnectParams).auth?.deviceToken !== "token-B")
        return { ok: false, error: tokenMismatch };
      return { ok: true, payload: helloOk([...READ_SCOPES], "token-B") };
    };
    const host = testHost(gateway, storage);
    const signed = deferred<void>();
    let signs = 0;
    host.signer.sign = async () => {
      if ((signs += 1) === 1) await signed.promise;
      return "signature";
    };
    const client = new ClawtrateClient(host, FAST);
    try {
      await client.start();
      await client.connectForSetup(URL_A);
      // The plan has chosen token-A and is being signed when token-B replaces it.
      await until(() => signs === 1);
      storage.data.set(tokenKey(URL_A), savedToken("token-B"));
      signed.resolve();
      await until(() => gateway.connects.length > 0);
      expect(connectAuth(gateway, 0)?.deviceToken).toBe("token-B");
      await until(() => client.state.connection.status === "connected");
    } finally {
      signed.resolve();
      client.stop();
    }
  });

  it("keeps the shared token while no device token is saved, so a restart still connects", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: "bootstrap" }),
    });
    const gateway = new FakeGateway();
    let holdNext = false;
    gateway.connectReply = (params) => {
      const { scopes, auth } = params as ConnectParams;
      if (!auth?.token && !auth?.deviceToken) {
        return {
          ok: false,
          error: {
            code: "UNAUTHORIZED",
            message: "missing token",
            details: { code: "AUTH_TOKEN_MISSING" },
          },
        };
      }
      holdNext = true;
      return { ok: true, payload: helloOk(scopes, "issued-token") };
    };
    // This hello's save waits while a newer socket on the same store opens and closes unsaved.
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
    const closing = new FakeGateway();
    closing.refuseConnections = true;
    const other = new ClawtrateClient(testHost(closing, storage), FAST);
    try {
      await client.start();
      await until(() => waiting);
      await other.start();
      await until(() => closing.sockets.some((socket) => socket.readyState === 3));
      other.stop();
      held.resolve();
      await until(() => client.state.connection.status === "connected");
      await sleep(30);
      client.stop();
      expect(storage.data.has(tokenKey(URL_A))).toBe(false);
      const restarted = new ClawtrateClient(testHost(gateway, storage), FAST);
      const before = gateway.connects.length;
      await restarted.start();
      await until(() => gateway.connects.length > before);
      expect(connectAuth(gateway, before)?.token).toBe("bootstrap");
      await until(() => restarted.state.connection.status === "connected");
      restarted.stop();
    } finally {
      held.resolve();
      other.stop();
      client.stop();
    }
  });

  it("keeps the token an approved access request rotated to, after another socket opened first", async () => {
    const { client, gateway, storage } = await pairedOnA();
    const approval = deferred<unknown>();
    gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-A" });
    gateway.handlers["device.scopes.waitUpgrade"] = () => approval.promise;
    const otherGateway = new FakeGateway();
    otherGateway.connectReply = (params) => {
      const { scopes, auth } = params as ConnectParams;
      return { ok: true, payload: helloOk(scopes, auth?.deviceToken) };
    };
    const other = new ClawtrateClient(testHost(otherGateway, storage), FAST);
    try {
      await client.requestAccess();
      await until(() => client.state.connection.upgrade.status === "pending");
      // Another client on the store opens its socket before the approval reaches this one.
      await other.start();
      await until(() => other.state.connection.status === "connected");
      approval.resolve({
        status: "approved",
        requestId: "up-A",
        deviceToken: "token-R",
        scopes: [...INTERACTIVE_SCOPES],
      });
      await until(() => client.state.connection.upgrade.status !== "pending");
      const before = gateway.connects.length;
      gateway.dropAll();
      await until(() => gateway.connects.length > before);
      expect(connectAuth(gateway, gateway.connects.length - 1)?.deviceToken).toBe("token-R");
    } finally {
      other.stop();
      client.stop();
    }
  });

  it("keeps a rotated token when an older hello of the socket that owns the key finishes after it", async () => {
    const { client, gateway, storage } = await pairedOnA();
    const approval = deferred<unknown>();
    gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-A" });
    gateway.handlers["device.scopes.waitUpgrade"] = () => approval.promise;
    let holdOther = false;
    const otherGateway = new FakeGateway();
    otherGateway.connectReply = (params) => {
      const { scopes, auth } = params as ConnectParams;
      holdOther = true;
      return { ok: true, payload: helloOk(scopes, auth?.deviceToken) };
    };
    // The other client's hello save waits, and so does this client's reconnect after the
    // approval, before it opens a socket: the other client's socket still owns the key.
    const otherHeld = deferred<void>();
    const reconnectHeld = deferred<void>();
    let holdReconnect = false;
    let otherWaiting = false;
    let reconnectWaiting = false;
    const get = storage.get;
    storage.get = async (key) => {
      if (holdOther && key === tokenKey(URL_A)) {
        holdOther = false;
        otherWaiting = true;
        await otherHeld.promise;
      } else if (holdReconnect && key === tokenKey(URL_A)) {
        holdReconnect = false;
        reconnectWaiting = true;
        await reconnectHeld.promise;
      }
      return get(key);
    };
    const other = new ClawtrateClient(testHost(otherGateway, storage), FAST);
    try {
      await client.requestAccess();
      await until(() => client.state.connection.upgrade.status === "pending");
      await other.start();
      await until(() => otherWaiting);
      // The rotation is approved and saved before the other client's older hello finishes.
      holdReconnect = true;
      approval.resolve({
        status: "approved",
        requestId: "up-A",
        deviceToken: "token-R",
        scopes: [...INTERACTIVE_SCOPES],
      });
      await until(() => reconnectWaiting);
      expect(JSON.parse(storage.data.get(tokenKey(URL_A))!).token).toBe("token-R");
      otherHeld.resolve();
      await until(() => other.state.connection.status === "connected");
      await sleep(30);
      const before = gateway.connects.length;
      reconnectHeld.resolve();
      await until(() => gateway.connects.length > before);
      const next = gateway.connects[gateway.connects.length - 1] as ConnectParams;
      expect(next.auth?.deviceToken).toBe("token-R");
      expect(next.scopes).toEqual([...INTERACTIVE_SCOPES]);
    } finally {
      otherHeld.resolve();
      reconnectHeld.resolve();
      other.stop();
      client.stop();
    }
  });

  it("removes the saved token when the gateway refuses it", async () => {
    const { client, gateway, storage } = await pairedOnA();
    // Saved with surrounding whitespace: a connect sends it trimmed.
    storage.data.set(tokenKey(URL_A), savedToken(" \ttoken-A\n"));
    gateway.connectReply = () => ({ ok: false, error: tokenMismatch });
    gateway.dropAll();
    await until(() => client.state.connection.error?.code === "AUTH_DEVICE_TOKEN_MISMATCH");
    expect(connectAuth(gateway, gateway.connects.length - 1)?.deviceToken).toBe("token-A");
    await until(() => !storage.data.has(tokenKey(URL_A)));
    expect(client.state.connection.paired).toBe(false);
    client.stop();
  });

  it("removes a refused token if switching gateways is already queued", async () => {
    const storage = memoryStorage();
    const gate = deferred<void>();
    let switchSaving = false;
    const set = storage.set;
    storage.set = async (key, value) => {
      if (key === "connection" && value.includes(URL_B)) {
        switchSaving = true;
        await gate.promise;
      }
      await set(key, value);
    };
    const { client, gateway } = await pairedOnA(storage);
    try {
      let switched: Promise<void> | null = null;
      gateway.connectReply = (params, url) => {
        const { scopes, auth } = params as ConnectParams;
        if (url === URL_B) return { ok: true, payload: helloOk(scopes, "token-B") };
        // A's reconnect is refused just as the person switches to B.
        switched ??= client.connect({ url: URL_B, token: "boot-B" });
        expect(auth?.deviceToken).toBe("token-A");
        return { ok: false, error: tokenMismatch };
      };
      gateway.dropAll();
      await until(
        () => switchSaving && client.state.connection.error?.code === "AUTH_DEVICE_TOKEN_MISMATCH",
      );
      gate.resolve();
      await switched;
      await until(
        () =>
          client.state.connection.gatewayUrl === URL_B &&
          client.state.connection.status === "connected",
      );
      await sleep(30);
      expect(storage.data.has(tokenKey(URL_A))).toBe(false);
    } finally {
      gate.resolve();
      client.stop();
    }
  });

  it.each(["hello", "scope upgrade"] as const)(
    "keeps token B saved by a %s when a refusal of token A is made while B is being written",
    async (source) => {
      const storage = memoryStorage();
      const writeB = deferred<void>();
      let waitingB = false;
      let recording = false;
      const applied: string[] = [];
      const set = storage.set;
      const remove = storage.delete;
      storage.set = async (key, value) => {
        const token = key === tokenKey(URL_A) ? (JSON.parse(value) as { token: string }).token : "";
        if (token === "token-B") {
          waitingB = true;
          await writeB.promise;
        }
        await set(key, value);
        if (recording && token) applied.push(`save ${token}`);
      };
      storage.delete = async (key) => {
        if (recording && key === tokenKey(URL_A)) applied.push("remove");
        await remove(key);
      };
      const { client, gateway } = await pairedOnA(storage);
      try {
        recording = true;
        let issued = false;
        // A token is issued only when B is; any token sent is accepted, until A is refused.
        let refuseA = false;
        gateway.connectReply = (params) => {
          const { scopes, auth } = params as ConnectParams;
          if (auth?.deviceToken === "token-A" && refuseA)
            return { ok: false, error: tokenMismatch };
          if (source === "hello" && !issued) {
            issued = true;
            return { ok: true, payload: helloOk(scopes, "token-B") };
          }
          return { ok: true, payload: helloOk(scopes) };
        };
        if (source === "hello") {
          gateway.dropAll();
        } else {
          gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-1" });
          gateway.handlers["device.scopes.waitUpgrade"] = () => ({
            status: "approved",
            requestId: "up-1",
            deviceToken: "token-B",
            scopes: [...INTERACTIVE_SCOPES],
          });
          await client.requestAccess();
        }
        await until(() => waitingB);
        // B's write is still on its way to disk: the reconnect offers A, and A is refused.
        refuseA = true;
        gateway.dropAll();
        await until(() => client.state.connection.error?.code === "AUTH_DEVICE_TOKEN_MISMATCH");
        expect(connectAuth(gateway, gateway.connects.length - 1)?.deviceToken).toBe("token-A");
        writeB.resolve();
        await until(() => applied.length > 0);
        // A hello's token is reused with Retry; an approved upgrade reconnects by itself.
        if (source === "hello") await client.retryNow();
        await until(
          () =>
            client.state.connection.status === "connected" &&
            connectAuth(gateway, gateway.connects.length - 1)?.deviceToken === "token-B",
        );
        await sleep(30);
        expect(applied).toEqual(["save token-B"]);
        expect(JSON.parse(storage.data.get(tokenKey(URL_A))!).token).toBe("token-B");
      } finally {
        writeB.resolve();
        client.stop();
      }
    },
  );

  it("keeps a stored token when the failed attempt used the shared token", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: "bootstrap" }),
    });
    // The third read of A's token is the library's, as it builds the plan: B is saved just before.
    let reads = 0;
    const get = storage.get;
    storage.get = async (key) => {
      if (key === tokenKey(URL_A) && (reads += 1) === 3) {
        storage.data.set(tokenKey(URL_A), savedToken("token-B"));
      }
      return get(key);
    };
    const gateway = new FakeGateway();
    gateway.connectReply = (params) => {
      const { scopes, auth } = params as ConnectParams;
      if (auth?.token === "bootstrap") {
        return {
          ok: false,
          error: {
            code: "UNAUTHORIZED",
            message: "token mismatch",
            details: { code: "AUTH_TOKEN_MISMATCH" },
          },
        };
      }
      return { ok: true, payload: helloOk(scopes) };
    };
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await until(() => client.state.connection.error?.code === "AUTH_TOKEN_MISMATCH");
    expect(connectAuth(gateway, 0)).toEqual({ token: "bootstrap" });
    await sleep(30);
    await client.retryNow();
    await until(() => client.state.connection.status === "connected");
    expect(connectAuth(gateway, gateway.connects.length - 1)).toEqual({ deviceToken: "token-B" });
    expect(JSON.parse(storage.data.get(tokenKey(URL_A))!).token).toBe("token-B");
    client.stop();
  });
});
