// Full access under interleavings: the six are asked for only in an attempt the person
// started, the signed scopes match the saved grant when the frame goes, a replacement token
// and its narrowed grant are one write, a narrowing that waited never lands for a socket
// another took over from, and a typed gateway token ends with its attempt.

import { describe, expect, it, onTestFinished } from "vitest";
import { ClawtrateClient, FULL_PAIRING_LIMIT, type ClientOptions } from "../src/client.ts";
import type { ClawtrateHost, KeyValueStore } from "../src/host.ts";
import { FULL_SCOPES, READ_SCOPES } from "../src/scopes.ts";
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

const URL = "wss://gateway.example:19960";
const FAST: ClientOptions = { reconnect: { initialMs: 20, maxMs: 40 }, fullAccess: true };
type ConnectParams = { scopes: string[]; auth?: { token?: string; deviceToken?: string } };

const host = (
  gateway: FakeGateway,
  storage: KeyValueStore,
  extra: Partial<ClawtrateHost> = {},
): ClawtrateHost => ({
  ...testHost(gateway, storage as KeyValueStore & { data: Map<string, string> }),
  secureCredentials: async () => true,
  ...extra,
});

const fullRecord = (token: string, held: readonly string[] = FULL_SCOPES) =>
  JSON.stringify({ token, grantedScopes: held, heldScopes: held, fullGrant: true });
/** A pairing made before full control: read alone. */
const readRecord = (token: string) =>
  JSON.stringify({ token, grantedScopes: READ_SCOPES, heldScopes: READ_SCOPES });
/** Accept the offer of full control for this file's gateway and device. */
const askFull = (client: ClawtrateClient) =>
  client.requestFullControl({ gatewayUrl: URL, deviceId: "device-1" });

const saved = (storage: { data: Map<string, string> }) =>
  JSON.parse(storage.data.get(tokenKey(URL)) ?? "null") as {
    token: string;
    heldScopes: string[];
  } | null;

type NodeEvents = {
  on(event: string, listener: (reason: unknown) => void): void;
  off(event: string, listener: (reason: unknown) => void): void;
};

const refusal = (code: string) => ({
  ok: false as const,
  error: { code: "UNAUTHORIZED", message: "refused", details: { code } },
});

describe("full access under interleavings", () => {
  it("a refusal accepted while its token's removal waits stops the next attempt asking for the six", async () => {
    const storage = memoryStorage();
    const removal = deferred<void>();
    const remove = storage.delete;
    storage.delete = async (key) => {
      if (key === tokenKey(URL)) await removal.promise;
      return remove(key);
    };
    const gateway = new FakeGateway();
    gateway.connectReply = (params) => ({
      ok: true,
      payload: helloOk([...(params as ConnectParams).scopes], "token-A"),
    });
    const client = new ClawtrateClient(host(gateway, storage), FAST);
    await client.start();
    await client.connect({ url: URL, token: "shared" });
    await until(() => client.state.connection.status === "connected");
    // Refused; the client retries by itself while the token's removal still waits.
    const before = gateway.connects.length;
    gateway.connectReply = () => refusal("AUTH_TOKEN_MISMATCH");
    gateway.dropAll();
    await until(() => gateway.connects.length >= before + 3);
    expect((gateway.connects[before] as ConnectParams).auth?.deviceToken).toBe("token-A");
    // No retry asks for the six in the refused token's place.
    for (const each of (gateway.connects as ConnectParams[]).slice(before + 1)) {
      expect(each.auth?.deviceToken).toBeUndefined();
      expect(each.scopes).toEqual([...READ_SCOPES]);
    }
    removal.resolve();
    client.stop();
  });

  it("a grant narrowed by another connection while this one signed doesn't go out as the six", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL, token: null }),
      [tokenKey(URL)]: fullRecord("token-A"),
    });
    const gateway = new FakeGateway();
    gateway.connectReply = (params) => ({
      ok: true,
      payload: helloOk([...(params as ConnectParams).scopes]),
    });
    const signing = deferred<void>();
    let holdSign = false;
    let signHeld = false;
    const client = new ClawtrateClient(
      host(gateway, storage, {
        signer: {
          loadIdentity: async () => ({ deviceId: "device-1", publicKey: "public-key" }),
          sign: async () => {
            if (holdSign) {
              holdSign = false;
              signHeld = true;
              await signing.promise;
            }
            return "signature";
          },
        },
      }),
      FAST,
    );
    await client.start();
    await until(() => client.state.connection.status === "connected");
    holdSign = true;
    gateway.dropAll();
    await until(() => signHeld);
    // Meanwhile the same token is narrowed to read.
    storage.data.set(tokenKey(URL), fullRecord("token-A", READ_SCOPES));
    const before = gateway.connects.length;
    signing.resolve();
    await until(() => gateway.connects.length > before);
    for (const each of (gateway.connects as ConnectParams[]).slice(before))
      expect(each.scopes).toEqual([...READ_SCOPES]);
    client.stop();
  });

  it("a replacement token and its narrowed grant are saved together, in one write", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL, token: null }),
      [tokenKey(URL)]: fullRecord("token-A"),
    });
    const gateway = new FakeGateway();
    gateway.connectReply = (params) => ({
      ok: true,
      payload: helloOk([...(params as ConnectParams).scopes], "token-A"),
    });
    const client = new ClawtrateClient(host(gateway, storage), FAST);
    await client.start();
    await until(() => client.state.connection.status === "connected");
    const writes: string[] = [];
    const set = storage.set;
    storage.set = async (key, value) => {
      if (key === tokenKey(URL)) writes.push(value);
      return set(key, value);
    };
    gateway.connectReply = () => ({ ok: true, payload: helloOk([...READ_SCOPES], "token-B") });
    gateway.dropAll();
    await until(() => saved(storage)?.token === "token-B");
    await sleep(50);
    expect(
      writes.map((value) => JSON.parse(value) as { token: string; heldScopes: string[] }),
    ).toEqual([expect.objectContaining({ token: "token-B", heldScopes: [...READ_SCOPES] })]);
    client.stop();
  });

  it("a narrowing whose read waited while another socket took over the store writes nothing", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL, token: null }),
      [tokenKey(URL)]: fullRecord("token-A"),
    });
    const gateway = new FakeGateway();
    gateway.connectReply = (params) => ({
      ok: true,
      payload: helloOk([...(params as ConnectParams).scopes]),
    });
    const client = new ClawtrateClient(host(gateway, storage), FAST);
    await client.start();
    await until(() => client.state.connection.status === "connected");
    const held = deferred<void>();
    let holdNext = false;
    let waiting = false;
    const get = storage.get;
    storage.get = async (key) => {
      if (holdNext && key === tokenKey(URL)) {
        holdNext = false;
        waiting = true;
        await held.promise;
      }
      return get(key);
    };
    // This client's next hello grants read without a new token: its narrowing read waits.
    gateway.connectReply = () => {
      holdNext = true;
      return { ok: true, payload: helloOk([...READ_SCOPES]) };
    };
    gateway.dropAll();
    await until(() => waiting);
    // Another connection on the same store takes it over and keeps the six.
    const otherGateway = new FakeGateway();
    otherGateway.connectReply = (params) => ({
      ok: true,
      payload: helloOk([...(params as ConnectParams).scopes]),
    });
    const other = new ClawtrateClient(host(otherGateway, storage), FAST);
    // It takes the store over as it opens; its own hello waits behind this client's queue.
    await other.start();
    await until(() => otherGateway.connects.length === 1);
    held.resolve();
    await until(() => other.state.connection.status === "connected");
    await sleep(50);
    expect(saved(storage)?.heldScopes).toEqual([...FULL_SCOPES]);
    other.stop();
    client.stop();
  });

  it("a typed gateway token ends with a refusal, and Reconnect doesn't send it", async () => {
    const storage = memoryStorage();
    const gateway = new FakeGateway();
    gateway.connectReply = () => refusal("AUTH_RATE_LIMITED");
    const client = new ClawtrateClient(
      host(gateway, storage, { credentialStatus: async () => "secure" }),
      FAST,
    );
    await client.start();
    await client.connect({ url: URL, token: "typed-token-1" });
    await until(() => client.state.connection.error?.code === "AUTH_RATE_LIMITED");
    await until(() => JSON.parse(storage.data.get("connection")!).token === null);
    const before = gateway.connects.length;
    await client.retryNow();
    await until(() => gateway.connects.length > before);
    for (const each of (gateway.connects as ConnectParams[]).slice(before))
      expect(each.auth?.token).toBeUndefined();
    client.stop();
  });

  it("a typed gateway token ends with Disconnect while its approval waits, and Reconnect doesn't send it", async () => {
    const storage = memoryStorage();
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: false,
      error: {
        code: "NOT_PAIRED",
        message: "pairing required",
        details: { code: "PAIRING_REQUIRED", requestId: "req-1", deviceId: "device-1" },
      },
    });
    const client = new ClawtrateClient(
      host(gateway, storage, { credentialStatus: async () => "secure" }),
      FAST,
    );
    await client.start();
    await client.connect({ url: URL, token: "typed-token-2" });
    await until(() => client.state.connection.status === "pairing");
    // Retries while the approval waits keep the token: the attempt goes on.
    await until(() => gateway.connects.length >= 2);
    expect((gateway.connects.at(-1) as ConnectParams).auth?.token).toBe("typed-token-2");
    await client.suspend();
    expect(JSON.parse(storage.data.get("connection")!)).toMatchObject({
      token: null,
      suspended: true,
    });
    const before = gateway.connects.length;
    await client.retryNow();
    await until(() => gateway.connects.length > before);
    for (const each of (gateway.connects as ConnectParams[]).slice(before))
      expect(each.auth?.token).toBeUndefined();
    client.stop();
  });

  it("a switch that couldn't be saved leaves the open attempt as it was: it doesn't start asking for the six", async () => {
    const storage = memoryStorage({ connection: JSON.stringify({ url: URL, token: "shared" }) });
    const gateway = new FakeGateway();
    gateway.connectReply = () => refusal("AUTH_TOKEN_MISMATCH");
    const client = new ClawtrateClient(host(gateway, storage), FAST);
    await client.start();
    await until(() => gateway.connects.length >= 1);
    const set = storage.set;
    storage.set = async (key, value) => {
      if (key === "connection") throw new Error("disk full");
      return set(key, value);
    };
    await expect(
      client.connect({ url: "wss://gateway.example:19961", token: "other" }),
    ).rejects.toThrow();
    storage.set = set;
    const before = gateway.connects.length;
    await until(() => gateway.connects.length >= before + 2);
    for (const each of gateway.connects as ConnectParams[])
      expect(each.scopes).toEqual([...READ_SCOPES]);
    client.stop();
  });

  it("a token lost right after the first full pairing ends that pairing's request for the six, and the retry doesn't send the typed token", async () => {
    const storage = memoryStorage();
    const gateway = new FakeGateway();
    gateway.connectReply = (params) => ({
      ok: true,
      payload: helloOk([...(params as ConnectParams).scopes], "token-A"),
    });
    const client = new ClawtrateClient(host(gateway, storage), FAST);
    await client.start();
    await client.connect({ url: URL, token: "shared" });
    await until(() => client.state.connection.status === "connected");
    await until(() => saved(storage) !== null);
    // Paired: the typed token is dropped from the saved settings.
    await until(() => JSON.parse(storage.data.get("connection")!).token === null);
    // Lost before any later plan read it.
    storage.data.delete(tokenKey(URL));
    gateway.connectReply = () => refusal("AUTH_TOKEN_MISMATCH");
    const before = gateway.connects.length;
    gateway.dropAll();
    await until(() => gateway.connects.length >= before + 1);
    // The same connection's retry plans afresh: read alone, and no typed token after pairing.
    for (const each of (gateway.connects as ConnectParams[]).slice(before)) {
      expect(each.scopes).toEqual([...READ_SCOPES]);
      expect(each.auth?.token).toBeUndefined();
    }
    client.stop();
  });

  it("Retry after a tokenless pairing request ended asks for read, not the six", async () => {
    const storage = memoryStorage();
    const gateway = new FakeGateway();
    let request = 0;
    gateway.connectReply = () => ({
      ok: false,
      error: {
        code: "NOT_PAIRED",
        message: "pairing required",
        details: {
          code: "PAIRING_REQUIRED",
          requestId: `req-${(request += 1)}`,
          deviceId: "device-1",
        },
      },
    });
    const client = new ClawtrateClient(host(gateway, storage), FAST);
    await client.start();
    await client.connect({ url: URL, token: "shared" });
    await until(() => client.state.connection.status === "pairing");
    expect((gateway.connects[0] as ConnectParams).scopes).toEqual([...FULL_SCOPES]);
    // The next answer names another request: the first one ended.
    await until(() => client.state.connection.status === "error", 8_000);
    const before = gateway.connects.length;
    await client.retryNow();
    await until(() => gateway.connects.length > before);
    expect((gateway.connects[before] as ConnectParams).scopes).toEqual([...READ_SCOPES]);
    client.stop();
  }, 12_000);

  it("a pairing wait the gateway ends ends the typed token's attempt, while one to retry keeps it", async () => {
    const storage = memoryStorage();
    const gateway = new FakeGateway();
    let nextStep = "wait_then_retry";
    gateway.connectReply = () => ({
      ok: false,
      error: {
        code: "NOT_PAIRED",
        message: "pairing required",
        details: {
          code: "PAIRING_REQUIRED",
          requestId: "req-1",
          deviceId: "device-1",
          recommendedNextStep: nextStep,
        },
      },
    });
    const client = new ClawtrateClient(
      host(gateway, storage, { credentialStatus: async () => "secure" }),
      FAST,
    );
    await client.start();
    await client.connect({ url: URL, token: "shared" });
    await until(() => client.state.connection.status === "pairing");
    // Waiting to retry: Retry still sends the typed token and asks for the six.
    let before = gateway.connects.length;
    await client.retryNow();
    await until(() => gateway.connects.length > before);
    expect((gateway.connects[before] as ConnectParams).auth?.token).toBe("shared");
    expect((gateway.connects[before] as ConnectParams).scopes).toEqual([...FULL_SCOPES]);
    // The gateway then ends the wait: nothing retries, and the attempt is over.
    nextStep = "contact_owner";
    before = gateway.connects.length;
    await client.retryNow();
    await until(() => gateway.connects.length > before);
    await until(() => JSON.parse(storage.data.get("connection")!).token === null);
    before = gateway.connects.length;
    await client.retryNow();
    await until(() => gateway.connects.length > before);
    expect((gateway.connects[before] as ConnectParams).auth?.token).toBeUndefined();
    expect((gateway.connects[before] as ConnectParams).scopes).toEqual([...READ_SCOPES]);
    client.stop();
  });

  it("a Disconnect that couldn't be saved keeps the typed token's attempt, so the next one still ends it", async () => {
    const storage = memoryStorage();
    const gateway = new FakeGateway();
    gateway.connectReply = () => refusal("AUTH_TOKEN_MISMATCH");
    const client = new ClawtrateClient(
      host(gateway, storage, { credentialStatus: async () => "secure" }),
      FAST,
    );
    await client.start();
    await client.connect({ url: URL, token: "typed-token-3" });
    await until(() => gateway.connects.length >= 1);
    const set = storage.set;
    storage.set = async (key, value) => {
      if (key === "connection") throw new Error("disk full");
      return set(key, value);
    };
    await expect(client.suspend()).rejects.toThrow();
    storage.set = set;
    await client.suspend();
    expect(JSON.parse(storage.data.get("connection")!)).toMatchObject({
      token: null,
      suspended: true,
    });
    client.stop();
  });

  it("a setup reusing a saved six-scope pairing asks for read alone, its retries too, and later ordinary reconnects for the saved grant", async () => {
    const storage = memoryStorage({ [tokenKey(URL)]: fullRecord("token-A") });
    const gateway = new FakeGateway();
    let answered = 0;
    gateway.connectReply = (params) => {
      // The first socket drops before its hello: the setup retries.
      if ((answered += 1) === 1) gateway.dropAll();
      return { ok: true, payload: helloOk([...(params as ConnectParams).scopes], "token-A") };
    };
    const client = new ClawtrateClient(host(gateway, storage), FAST);
    await client.start();
    await client.connectForSetup(URL);
    await until(() => client.state.connection.status === "connected");
    // The setup's first frame and its retries before its hello.
    expect(gateway.connects.length).toBeGreaterThanOrEqual(2);
    for (const each of gateway.connects as ConnectParams[])
      expect(each.scopes).toEqual([...READ_SCOPES]);
    expect(saved(storage)?.heldScopes).toEqual([...FULL_SCOPES]);
    // Setup is over: an ordinary reconnect asks for the saved grant.
    const before = gateway.connects.length;
    gateway.dropAll();
    await until(() => gateway.connects.length > before);
    expect((gateway.connects[before] as ConnectParams).scopes).toEqual([...FULL_SCOPES]);
    client.stop();
  });

  it("an ordinary reconnect granted nothing narrows the full pairing's record to nothing, and asks for no more", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL, token: null }),
      [tokenKey(URL)]: fullRecord("token-A"),
    });
    const gateway = new FakeGateway();
    gateway.connectReply = (params) => ({
      ok: true,
      payload: helloOk([...(params as ConnectParams).scopes]),
    });
    const client = new ClawtrateClient(host(gateway, storage), FAST);
    await client.start();
    await until(() => client.state.connection.status === "connected");
    gateway.connectReply = () => ({ ok: true, payload: helloOk([]) });
    gateway.dropAll();
    await until(() => saved(storage)?.heldScopes.length === 0);
    const before = gateway.connects.length;
    gateway.dropAll();
    await until(() => gateway.connects.length > before);
    expect((gateway.connects[before] as ConnectParams).scopes).toEqual([]);
    client.stop();
  });

  it("F-NEW1: an approved full-control request saves the six it asked for as a full pairing, bound to secure storage", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL, token: null }),
      [tokenKey(URL)]: readRecord("token-A"),
    });
    const gateway = new FakeGateway();
    gateway.connectReply = (params) => ({
      ok: true,
      payload: helloOk(
        [...(params as ConnectParams).scopes],
        (params as ConnectParams).auth?.deviceToken,
      ),
    });
    const wait = deferred<unknown>();
    gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-1" });
    gateway.handlers["device.scopes.waitUpgrade"] = () => wait.promise;
    const client = new ClawtrateClient(host(gateway, storage), FAST);
    await client.start();
    await until(() => client.state.connection.status === "connected");
    void askFull(client).catch(() => {});
    await until(() => client.state.connection.upgrade.status === "pending");
    const wanted = (gateway.calls("device.scopes.requestUpgrade")[0] as { scopes: string[] })
      .scopes;
    expect(wanted).toEqual([...FULL_SCOPES]);
    wait.resolve({ status: "approved", requestId: "up-1", deviceToken: "token-B", scopes: wanted });
    await until(() => saved(storage)?.token === "token-B");
    expect(JSON.parse(storage.data.get(tokenKey(URL))!)).toMatchObject({
      token: "token-B",
      fullGrant: true,
      heldScopes: FULL_SCOPES.filter((scope) => wanted.includes(scope)),
    });
    client.stop();
  });

  /** Every value written to this device's token key, parsed. */
  const tokenWrites = (storage: KeyValueStore & { data: Map<string, string> }) => {
    const writes: Array<{ token: string; heldScopes: string[]; fullGrant?: boolean }> = [];
    const set = storage.set;
    storage.set = async (key, value) => {
      if (key === tokenKey(URL)) writes.push(JSON.parse(value));
      return set(key, value);
    };
    return writes;
  };
  const approvingGateway = () => {
    const gateway = new FakeGateway();
    const approval = deferred<unknown>();
    gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-2" });
    gateway.handlers["device.scopes.waitUpgrade"] = () => approval.promise;
    return { gateway, approval };
  };
  it("a smaller ask while full control waits doesn't replace that request", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL, token: null }),
      [tokenKey(URL)]: readRecord("token-A"),
    });
    const { gateway } = approvingGateway();
    gateway.connectReply = (params) => ({
      ok: true,
      payload: helloOk([...(params as ConnectParams).scopes]),
    });
    const client = new ClawtrateClient(host(gateway, storage), FAST);
    await client.start();
    await until(() => client.state.connection.fullOffer === "offer");
    void askFull(client).catch(() => {});
    await until(() => client.state.connection.upgrade.status === "pending");
    await client.requestAccess("admin");
    await client.requestAccess("pairing");
    await sleep(50);
    expect(gateway.calls("device.scopes.requestUpgrade")).toHaveLength(1);
    expect(client.state.connection.upgrade).toMatchObject({
      status: "pending",
      scopes: [...FULL_SCOPES],
    });
    client.stop();
  });

  it("an approved full-control rotation whose reads of the saved grant fail is saved as a full pairing, and reconnects to the same gateway with it", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL, token: null }),
      [tokenKey(URL)]: readRecord("token-A"),
    });
    const { gateway, approval } = approvingGateway();
    gateway.connectReply = (params) => ({
      ok: true,
      payload: helloOk([...(params as ConnectParams).scopes]),
    });
    const client = new ClawtrateClient(host(gateway, storage), FAST);
    await client.start();
    await until(() => client.state.connection.status === "connected");
    void askFull(client).catch(() => {});
    await until(() => client.state.connection.upgrade.status === "pending");
    // Every read of the saved grant fails until the rotation is saved.
    const get = storage.get;
    storage.get = async (key) => {
      if (key === tokenKey(URL) && saved(storage)?.token !== "token-U")
        throw new Error("read failed");
      return get(key);
    };
    const writes = tokenWrites(storage);
    const wanted = (gateway.calls("device.scopes.requestUpgrade")[0] as { scopes: string[] })
      .scopes;
    const before = gateway.connects.length;
    approval.resolve({
      status: "approved",
      requestId: "up-2",
      deviceToken: "token-U",
      scopes: wanted,
    });
    await until(() => writes.some((write) => write.token === "token-U"));
    // Saved as a full pairing with the six, whatever the reads gave.
    const first = writes.find((write) => write.token === "token-U")!;
    expect(first.fullGrant).toBe(true);
    expect(first.heldScopes).toEqual([...FULL_SCOPES]);
    // The reconnect goes to the same gateway, with the rotated token.
    await until(() => gateway.connects.length > before);
    expect((gateway.connects[before] as ConnectParams).auth?.deviceToken).toBe("token-U");
    expect(client.state.connection.gatewayUrl).toBe(URL);
    client.stop();
  });

  /** A saved rotation whose reconnect can't read the record: reads fail from the save on. */
  const rotationWithFailingReads = async () => {
    // Nothing the failed reconnect leaves may go unhandled.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    // The test process's own: this package's tests have no Node types.
    const proc = (globalThis as unknown as { process: NodeEvents }).process;
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL, token: null }),
      [tokenKey(URL)]: readRecord("token-A"),
    });
    const { gateway, approval } = approvingGateway();
    gateway.connectReply = (params) => ({
      ok: true,
      payload: helloOk([...(params as ConnectParams).scopes]),
    });
    const client = new ClawtrateClient(host(gateway, storage), FAST);
    onTestFinished(() => {
      try {
        client.stop();
      } finally {
        proc.off("unhandledRejection", onUnhandled);
      }
    });
    proc.on("unhandledRejection", onUnhandled);
    await client.start();
    await until(() => client.state.connection.status === "connected");
    void askFull(client).catch(() => {});
    await until(() => client.state.connection.upgrade.status === "pending");
    const reads = { fail: false, failed: 0 };
    const get = storage.get;
    const set = storage.set;
    storage.set = async (key, value) => {
      await set(key, value);
      if (key === tokenKey(URL) && JSON.parse(value).token === "token-U") reads.fail = true;
    };
    storage.get = async (key) => {
      if (reads.fail && key === tokenKey(URL)) {
        reads.failed += 1;
        throw new Error("read failed");
      }
      return get(key);
    };
    const wanted = (gateway.calls("device.scopes.requestUpgrade")[0] as { scopes: string[] })
      .scopes;
    const before = gateway.connects.length;
    approval.resolve({
      status: "approved",
      requestId: "up-2",
      deviceToken: "token-U",
      scopes: wanted,
    });
    // The reopen fails: the error is shown, and another try is scheduled.
    await until(() => client.state.connection.error?.code === "RECONNECT_FAILED");
    expect(client.state.connection.retryAt).not.toBeNull();
    expect(client.state.connection.gatewayUrl).toBe(URL);
    expect(saved(storage)?.token).toBe("token-U");
    const tries = reads.failed;
    await until(() => reads.failed > tries);
    return { client, gateway, reads, before, unhandled };
  };

  it("a reconnect after a saved rotation whose read of the record fails shows an error and retries until it reconnects with the rotated token", async () => {
    const { client, gateway, reads, before, unhandled } = await rotationWithFailingReads();
    // Reads come back: the retry reconnects to the same gateway with the rotated token.
    reads.fail = false;
    await until(() => gateway.connects.length > before);
    expect((gateway.connects[before] as ConnectParams).auth?.deviceToken).toBe("token-U");
    await until(() => client.state.connection.status === "connected");
    expect(client.state.connection.error).toBeNull();
    expect(client.state.connection.gatewayUrl).toBe(URL);
    expect(unhandled).toEqual([]);
  });

  it("a host that stops the client when it receives a retry notification stays stopped", async () => {
    const { client, gateway, reads, unhandled } = await rotationWithFailingReads();
    const priorRetry = client.state.connection.retryAt;
    const stopped = deferred<void>();
    const connects = gateway.connects.length;
    const unsubscribe = client.store.subscribe(({ connection }) => {
      if (connection.error?.code !== "RECONNECT_FAILED" || connection.retryAt === priorRetry)
        return;
      unsubscribe();
      client.stop();
      reads.fail = false;
      stopped.resolve();
    });
    onTestFinished(unsubscribe);
    await stopped.promise;
    await sleep(150);
    expect(gateway.connects.length).toBe(connects);
    expect(unhandled).toEqual([]);
  });

  it("does not open a socket when the host stops a recovered retry from its connecting notification", async () => {
    const { client, gateway, reads, unhandled } = await rotationWithFailingReads();
    const sockets = gateway.sockets.length;
    const stopped = deferred<void>();
    const unsubscribe = client.store.subscribe(({ connection }) => {
      if (connection.error || !["connecting", "reconnecting"].includes(connection.status)) return;
      unsubscribe();
      client.stop();
      stopped.resolve();
    });
    onTestFinished(unsubscribe);
    reads.fail = false;
    await stopped.promise;
    expect(gateway.sockets).toHaveLength(sockets);
    expect(unhandled).toEqual([]);
  });

  it.each(["suspend", "disconnect"] as const)(
    "a reconnect after a saved rotation that keeps failing stops retrying after %s",
    async (end) => {
      const { client, gateway, reads, unhandled } = await rotationWithFailingReads();
      await client[end]();
      const stopped = reads.failed;
      const connects = gateway.connects.length;
      await sleep(150);
      expect(reads.failed, end).toBe(stopped);
      expect(gateway.connects.length, end).toBe(connects);
      expect(client.state.connection.status, end).toBe(end === "suspend" ? "disconnected" : "idle");
      expect(unhandled).toEqual([]);
    },
  );

  it("core asks for nothing more for a full pairing granted less: no request goes, whatever asks", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL, token: null }),
      [tokenKey(URL)]: fullRecord("token-A", READ_SCOPES),
    });
    const { gateway } = approvingGateway();
    gateway.connectReply = (params) => ({
      ok: true,
      payload: helloOk([...(params as ConnectParams).scopes]),
    });
    const client = new ClawtrateClient(host(gateway, storage), FAST);
    await client.start();
    await until(() => client.state.connection.status === "connected");
    expect(client.state.connection).toMatchObject({ fullPairing: true, fullOffer: null });
    for (const tier of ["interactive", "admin", "pairing"] as const)
      await expect(client.requestAccess(tier)).rejects.toThrow(FULL_PAIRING_LIMIT);
    await expect(askFull(client)).rejects.toThrow(/isn't offered/);
    // An operation that needs a scope the pairing doesn't hold fails at once (`ensureScope`).
    await expect(client.createTask("main", "hello")).rejects.toThrow(FULL_PAIRING_LIMIT);
    await sleep(50);
    expect(gateway.calls("device.scopes.requestUpgrade")).toEqual([]);
    expect(client.state.connection.upgrade.status).toBe("idle");
    client.stop();
  });

  it("a refusal accepted while a Connect is being saved stands after it, and a later Connect asks for the six again", async () => {
    const storage = memoryStorage();
    const gateway = new FakeGateway();
    gateway.connectReply = (params) => ({
      ok: true,
      payload: helloOk([...(params as ConnectParams).scopes], "token-A"),
    });
    const client = new ClawtrateClient(host(gateway, storage), FAST);
    await client.start();
    await client.connect({ url: URL, token: "shared" });
    await until(() => client.state.connection.status === "connected");
    // The next Connect's save waits; meanwhile the saved token is refused.
    const saving = deferred<void>();
    const set = storage.set;
    let held = false;
    storage.set = async (key, value) => {
      if (key === "connection" && !held) {
        held = true;
        await saving.promise;
      }
      return set(key, value);
    };
    const connecting = client.connect({ url: URL, token: "shared" });
    await until(() => held);
    gateway.connectReply = () => refusal("AUTH_TOKEN_MISMATCH");
    const before = gateway.connects.length;
    gateway.dropAll();
    await until(() => client.state.connection.error?.code === "AUTH_TOKEN_MISMATCH");
    gateway.connectReply = () => refusal("AUTH_TOKEN_MISMATCH");
    saving.resolve();
    await connecting;
    await until(() => gateway.connects.length >= before + 2);
    // Every attempt after the refusal, the Connect's own included, asks for read.
    for (const each of (gateway.connects as ConnectParams[]).slice(before + 1))
      expect(each.scopes).toEqual([...READ_SCOPES]);
    // A Connect the person starts afterwards may ask for the six again.
    const later = gateway.connects.length;
    await client.connect({ url: URL, token: "shared" });
    await until(() => gateway.connects.length > later);
    expect((gateway.connects[later] as ConnectParams).scopes).toEqual([...FULL_SCOPES]);
    client.stop();
  });

  it("a look at another gateway while full control waits leaves that request's full grant as it is", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL, token: null }),
      [tokenKey(URL)]: readRecord("token-A"),
      [tokenKey("wss://gateway.example:19962")]: JSON.stringify({
        token: "token-B",
        grantedScopes: READ_SCOPES,
        heldScopes: READ_SCOPES,
      }),
    });
    const { gateway, approval } = approvingGateway();
    gateway.connectReply = (params) => ({
      ok: true,
      payload: helloOk([...(params as ConnectParams).scopes]),
    });
    const client = new ClawtrateClient(host(gateway, storage), FAST);
    await client.start();
    await until(() => client.state.connection.status === "connected");
    void askFull(client).catch(() => {});
    await until(() => client.state.connection.upgrade.status === "pending");
    // A setup look reads another gateway's saved pairing meanwhile.
    expect(await client.deviceAccess("wss://gateway.example:19962")).toBe("paired");
    const wanted = (gateway.calls("device.scopes.requestUpgrade")[0] as { scopes: string[] })
      .scopes;
    approval.resolve({
      status: "approved",
      requestId: "up-2",
      deviceToken: "token-U",
      scopes: wanted,
    });
    await until(() => saved(storage)?.token === "token-U");
    expect(JSON.parse(storage.data.get(tokenKey(URL))!)).toMatchObject({ fullGrant: true });
    client.stop();
  });

  /** Delays the next read of the token key after it has read: its answer is from before. */
  const delayNextRead = (storage: KeyValueStore & { data: Map<string, string> }) => {
    const release = deferred<void>();
    let armed = true;
    let read = false;
    const get = storage.get;
    storage.get = async (key) => {
      const value = await get(key);
      if (armed && key === tokenKey(URL)) {
        armed = false;
        read = true;
        await release.promise;
      }
      return value;
    };
    return { release: () => release.resolve(), read: () => read };
  };

  it("a passive read from before a fresh full pairing that lands late doesn't cost the pairing its full grant", async () => {
    const storage = memoryStorage();
    const { gateway } = approvingGateway();
    gateway.connectReply = (params) => ({
      ok: true,
      payload: helloOk(
        (params as ConnectParams).auth?.deviceToken === "token-U"
          ? [...(params as ConnectParams).scopes]
          : [...READ_SCOPES],
        (params as ConnectParams).auth?.deviceToken ?? "token-A",
      ),
    });
    const client = new ClawtrateClient(host(gateway, storage), FAST);
    await client.start();
    await client.connect({ url: URL, token: "shared" });
    // A passive read finds no pairing yet, and waits while the first pairing is saved.
    const late = delayNextRead(storage);
    const reading = client.deviceAccess(URL);
    await until(() => late.read());
    await until(() => JSON.parse(storage.data.get(tokenKey(URL)) ?? "{}").fullGrant === true);
    late.release();
    expect(await reading).toBe("new");
    await until(() => client.state.connection.status === "connected");
    expect(JSON.parse(storage.data.get(tokenKey(URL))!).fullGrant).toBe(true);
    expect(client.state.connection.fullPairing).toBe(true);
    client.stop();
  });

  it("a refusal from the old gateway while a Connect to another is being saved leaves the new one asking for the six", async () => {
    const URL_B = "wss://gateway.example:19963";
    const storage = memoryStorage();
    const gateway = new FakeGateway();
    gateway.connectReply = (params, url) =>
      url === URL_B
        ? { ok: true, payload: helloOk([...(params as ConnectParams).scopes], "token-B") }
        : { ok: true, payload: helloOk([...(params as ConnectParams).scopes], "token-A") };
    const client = new ClawtrateClient(host(gateway, storage), FAST);
    await client.start();
    await client.connect({ url: URL, token: "shared-A" });
    await until(() => client.state.connection.status === "connected");
    // The Connect to B waits at its save; meanwhile A refuses its saved token.
    const saving = deferred<void>();
    const set = storage.set;
    let held = false;
    storage.set = async (key, value) => {
      if (key === "connection" && !held) {
        held = true;
        await saving.promise;
      }
      return set(key, value);
    };
    const connecting = client.connect({ url: URL_B, token: "shared-B" });
    await until(() => held);
    gateway.connectReply = (params, url) =>
      url === URL_B
        ? { ok: true, payload: helloOk([...(params as ConnectParams).scopes], "token-B") }
        : refusal("AUTH_TOKEN_MISMATCH");
    gateway.dropAll();
    await until(() => client.state.connection.error?.code === "AUTH_TOKEN_MISMATCH");
    saving.resolve();
    await connecting;
    await until(
      () =>
        (gateway.connects as Array<ConnectParams & { url?: string }>).length > 0 &&
        client.state.connection.gatewayUrl === URL_B,
    );
    await until(() => client.state.connection.status === "connected");
    // B's first pairing asked for the six.
    expect(client.state.connection.requestedScopes).toEqual([...FULL_SCOPES]);
    client.stop();
  });

  it("a refusal for a gateway while a Connect to it waits still stands after another gateway's attempt ends", async () => {
    const URL_C = "wss://gateway.example:19964";
    const storage = memoryStorage();
    const gateway = new FakeGateway();
    const asked: Array<{ url: string; scopes: string[] }> = [];
    let refuse = new Set<string>();
    gateway.connectReply = (params, url) => {
      const scopes = [...(params as ConnectParams).scopes];
      asked.push({ url: url ?? "", scopes });
      if (!refuse.has(url ?? "")) return { ok: true, payload: helloOk(scopes, "token-A") };
      // This gateway refuses its saved token; C ends its attempt with a refusal that pauses.
      return refusal(url === URL_C ? "AUTH_RATE_LIMITED" : "AUTH_TOKEN_MISMATCH");
    };
    const client = new ClawtrateClient(host(gateway, storage), FAST);
    await client.start();
    await client.connect({ url: URL, token: "shared" });
    await until(() => client.state.connection.status === "connected");
    // A Connect to C, then one back to this gateway: both wait at their saves, in turn.
    const gates = [deferred<void>(), deferred<void>()];
    let saves = 0;
    const set = storage.set;
    storage.set = async (key, value) => {
      if (key === "connection" && saves < gates.length) await gates[saves++]!.promise;
      return set(key, value);
    };
    const toC = client.connect({ url: URL_C, token: "shared-C" });
    await until(() => saves === 1);
    const back = client.connect({ url: URL, token: "shared" });
    // This gateway refuses its saved token after the Connect back to it began.
    refuse = new Set([URL]);
    gateway.dropAll();
    await until(() => client.state.connection.error?.code === "AUTH_TOKEN_MISMATCH");
    // C's attempt then ends too, before the Connect back is applied.
    refuse = new Set([URL_C]);
    gates[0]!.resolve();
    await toC;
    await until(() => saves === 2);
    await until(
      () =>
        client.state.connection.gatewayUrl === URL_C &&
        client.state.connection.error?.code === "AUTH_RATE_LIMITED",
    );
    refuse = new Set();
    const before = asked.length;
    gates[1]!.resolve();
    await back;
    await until(() => asked.slice(before).some((each) => each.url === URL));
    // The refusal accepted after the Connect back began stands: its new pairing asks for read.
    expect(asked.slice(before).find((each) => each.url === URL)!.scopes).toEqual([...READ_SCOPES]);
    client.stop();
  });

  it("refusals at two other gateways while a Connect to a fresh one waits leave its first pairing asking for the six", async () => {
    const URL_B = "wss://gateway.example:19964";
    const URL_C = "wss://gateway.example:19965";
    const storage = memoryStorage();
    const gateway = new FakeGateway();
    const asked: Array<{ url: string; scopes: string[] }> = [];
    let refuse = new Set<string>();
    gateway.connectReply = (params, url) => {
      const scopes = [...(params as ConnectParams).scopes];
      asked.push({ url: url ?? "", scopes });
      if (!refuse.has(url ?? "")) return { ok: true, payload: helloOk(scopes, "token-A") };
      // A refuses its saved token; B ends its attempt with a refusal that pauses.
      return refusal(url === URL_B ? "AUTH_RATE_LIMITED" : "AUTH_TOKEN_MISMATCH");
    };
    const client = new ClawtrateClient(host(gateway, storage), FAST);
    await client.start();
    await client.connect({ url: URL, token: "shared" });
    await until(() => client.state.connection.status === "connected");
    // A Connect to B, then one to C, a gateway this device never paired with: both wait.
    const gates = [deferred<void>(), deferred<void>()];
    let saves = 0;
    const set = storage.set;
    storage.set = async (key, value) => {
      if (key === "connection" && saves < gates.length) await gates[saves++]!.promise;
      return set(key, value);
    };
    const toB = client.connect({ url: URL_B, token: "shared-B" });
    await until(() => saves === 1);
    const toC = client.connect({ url: URL_C, token: "shared-C" });
    // A refuses its saved token, then B's attempt ends, before the Connect to C is applied.
    refuse = new Set([URL]);
    gateway.dropAll();
    await until(() => client.state.connection.error?.code === "AUTH_TOKEN_MISMATCH");
    refuse = new Set([URL_B]);
    gates[0]!.resolve();
    await toB;
    await until(() => saves === 2);
    await until(
      () =>
        client.state.connection.gatewayUrl === URL_B &&
        client.state.connection.error?.code === "AUTH_RATE_LIMITED",
    );
    refuse = new Set();
    const before = asked.length;
    gates[1]!.resolve();
    await toC;
    await until(() => asked.slice(before).some((each) => each.url === URL_C));
    // Neither refusal was C's: its first pairing asks for the six.
    expect(asked.slice(before).find((each) => each.url === URL_C)!.scopes).toEqual([
      ...FULL_SCOPES,
    ]);
    client.stop();
  });

  it("a Connect that never takes effect, queued after one to a fresh gateway, leaves that one's first pairing asking for the six", async () => {
    const URL_B = "wss://gateway.example:19964";
    const URL_C = "wss://gateway.example:19965";
    const storage = memoryStorage();
    const gateway = new FakeGateway();
    const asked: Array<{ url: string; scopes: string[] }> = [];
    let refuse = new Set<string>();
    gateway.connectReply = (params, url) => {
      const scopes = [...(params as ConnectParams).scopes];
      asked.push({ url: url ?? "", scopes });
      if (!refuse.has(url ?? "")) return { ok: true, payload: helloOk(scopes, "token-A") };
      // A refuses its saved token; B ends its attempt with a refusal that pauses.
      return refusal(url === URL_B ? "AUTH_RATE_LIMITED" : "AUTH_TOKEN_MISMATCH");
    };
    const client = new ClawtrateClient(host(gateway, storage), FAST);
    await client.start();
    await client.connect({ url: URL, token: "shared" });
    await until(() => client.state.connection.status === "connected");
    // A Connect to B, then one to C, a gateway this device never paired with: both wait.
    const gates = [deferred<void>(), deferred<void>()];
    let saves = 0;
    const set = storage.set;
    storage.set = async (key, value) => {
      if (key === "connection" && saves < gates.length) await gates[saves++]!.promise;
      return set(key, value);
    };
    const toB = client.connect({ url: URL_B, token: "shared-B" });
    await until(() => saves === 1);
    const toC = client.connect({ url: URL_C, token: "shared-C" });
    // Then a Connect that fails validation: it never takes effect, and C stays the choice.
    const invalid = client.connect({ url: "not a gateway", token: "x" }).catch(() => "refused");
    // A refuses its saved token, then B's attempt ends, before the Connect to C is applied.
    refuse = new Set([URL]);
    gateway.dropAll();
    await until(() => client.state.connection.error?.code === "AUTH_TOKEN_MISMATCH");
    refuse = new Set([URL_B]);
    gates[0]!.resolve();
    await toB;
    await until(() => saves === 2);
    await until(
      () =>
        client.state.connection.gatewayUrl === URL_B &&
        client.state.connection.error?.code === "AUTH_RATE_LIMITED",
    );
    refuse = new Set();
    const before = asked.length;
    gates[1]!.resolve();
    await toC;
    expect(await invalid).toBe("refused");
    await until(() => asked.slice(before).some((each) => each.url === URL_C));
    // Neither refusal was C's, and the invalid Connect changed nothing: C asks for the six.
    expect(asked.slice(before).find((each) => each.url === URL_C)!.scopes).toEqual([
      ...FULL_SCOPES,
    ]);
    client.stop();
  });
});
