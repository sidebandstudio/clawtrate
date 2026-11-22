// Full access under interleavings: the six are asked for only in an attempt the person
// started, the signed scopes match the saved grant when the frame goes, a replacement token
// and its narrowed grant are one write, a narrowing that waited never lands for a socket
// another took over from, and a typed gateway token ends with its attempt.

import { describe, expect, it } from "vitest";
import { ClawtrateClient, type ClientOptions } from "../src/client.ts";
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

const URL = "ws://127.0.0.1:19960";
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

const saved = (storage: { data: Map<string, string> }) =>
  JSON.parse(storage.data.get(tokenKey(URL)) ?? "null") as {
    token: string;
    heldScopes: string[];
  } | null;

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
    await expect(client.connect({ url: "ws://127.0.0.1:19961", token: "other" })).rejects.toThrow();
    storage.set = set;
    const before = gateway.connects.length;
    await until(() => gateway.connects.length >= before + 2);
    for (const each of gateway.connects as ConnectParams[])
      expect(each.scopes).toEqual([...READ_SCOPES]);
    client.stop();
  });

  it("a token lost right after the first full pairing ends that pairing's request for the six", async () => {
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
    // Lost before any later plan read it.
    storage.data.delete(tokenKey(URL));
    gateway.connectReply = () => refusal("AUTH_TOKEN_MISMATCH");
    const before = gateway.connects.length;
    gateway.dropAll();
    await until(() => gateway.connects.length >= before + 1);
    for (const each of (gateway.connects as ConnectParams[]).slice(before))
      expect(each.scopes).toEqual([...READ_SCOPES]);
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

  it("an approved upgrade of a full pairing keeps its exact grant, so it stays bound to secure storage", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL, token: null }),
      [tokenKey(URL)]: fullRecord("token-A", READ_SCOPES),
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
    void client.requestAccess().catch(() => {});
    await until(() => client.state.connection.upgrade.status === "pending");
    const wanted = (gateway.calls("device.scopes.requestUpgrade")[0] as { scopes: string[] })
      .scopes;
    wait.resolve({ status: "approved", requestId: "up-1", deviceToken: "token-B", scopes: wanted });
    await until(() => saved(storage)?.token === "token-B");
    expect(JSON.parse(storage.data.get(tokenKey(URL))!)).toMatchObject({
      token: "token-B",
      fullGrant: true,
      heldScopes: FULL_SCOPES.filter((scope) => wanted.includes(scope)),
    });
    client.stop();
  });

  const approvingGateway = () => {
    const gateway = new FakeGateway();
    const approval = deferred<unknown>();
    gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-2" });
    gateway.handlers["device.scopes.waitUpgrade"] = () => approval.promise;
    return { gateway, approval };
  };
  const approveWhatWasAsked = async (
    client: ClawtrateClient,
    gateway: FakeGateway,
    approval: ReturnType<typeof deferred<unknown>>,
    tier?: "admin",
  ) => {
    void client.requestAccess(tier).catch(() => {});
    await until(() => client.state.connection.upgrade.status === "pending");
    const wanted = (gateway.calls("device.scopes.requestUpgrade")[0] as { scopes: string[] })
      .scopes;
    approval.resolve({
      status: "approved",
      requestId: "up-2",
      deviceToken: "token-U",
      scopes: wanted,
    });
    return wanted;
  };

  it("an upgrade after a hello narrowed the grant builds on the narrowed grant, not the one planned with", async () => {
    const held = [
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.questions",
      "operator.pairing",
    ];
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL, token: null }),
      [tokenKey(URL)]: fullRecord("token-A", held),
    });
    const { gateway, approval } = approvingGateway();
    // The hello grants everything asked for but pairing: the record narrows.
    gateway.connectReply = (params) => ({
      ok: true,
      payload: helloOk(
        (params as ConnectParams).scopes.filter((scope) => scope !== "operator.pairing"),
      ),
    });
    const client = new ClawtrateClient(host(gateway, storage), FAST);
    await client.start();
    await until(() => saved(storage)?.heldScopes.includes("operator.pairing") === false);
    await approveWhatWasAsked(client, gateway, approval, "admin");
    await until(() => saved(storage)?.token === "token-U");
    expect(JSON.parse(storage.data.get(tokenKey(URL))!)).toMatchObject({ fullGrant: true });
    expect(saved(storage)?.heldScopes).not.toContain("operator.pairing");
    client.stop();
  });

  it("an upgrade right after a fresh full pairing keeps it a full pairing", async () => {
    const storage = memoryStorage();
    const { gateway, approval } = approvingGateway();
    gateway.connectReply = (params) => ({
      ok: true,
      // A first pairing narrowed to read; after the upgrade, what is asked for.
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
    await until(() => client.state.connection.status === "connected");
    await until(() => saved(storage)?.heldScopes.length === 1);
    const wanted = await approveWhatWasAsked(client, gateway, approval);
    await until(() => saved(storage)?.token === "token-U");
    expect(JSON.parse(storage.data.get(tokenKey(URL))!)).toMatchObject({
      fullGrant: true,
      heldScopes: FULL_SCOPES.filter((scope) => wanted.includes(scope)),
    });
    client.stop();
  });

  it("an upgrade whose approval waited while a hello narrowed the grant builds on the narrowed grant", async () => {
    const held = [
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.questions",
      "operator.pairing",
    ];
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL, token: null }),
      [tokenKey(URL)]: fullRecord("token-A", held),
    });
    const { gateway, approval } = approvingGateway();
    let narrow = false;
    gateway.connectReply = (params) => {
      const { scopes } = params as ConnectParams;
      return {
        ok: true,
        payload: helloOk(
          narrow ? scopes.filter((scope) => scope !== "operator.pairing") : [...scopes],
        ),
      };
    };
    const client = new ClawtrateClient(host(gateway, storage), FAST);
    await client.start();
    await until(() => client.state.connection.status === "connected");
    void client.requestAccess("admin").catch(() => {});
    await until(() => client.state.connection.upgrade.status === "pending");
    // While the approval waits, a reconnect's hello narrows the record.
    narrow = true;
    gateway.dropAll();
    await until(() => saved(storage)?.heldScopes.includes("operator.pairing") === false);
    const wanted = (gateway.calls("device.scopes.requestUpgrade")[0] as { scopes: string[] })
      .scopes;
    approval.resolve({
      status: "approved",
      requestId: "up-2",
      deviceToken: "token-U",
      scopes: wanted,
    });
    await until(() => saved(storage)?.token === "token-U");
    expect(saved(storage)?.heldScopes).not.toContain("operator.pairing");
    client.stop();
  });

  it("an upgrade's reply that volunteers pairing, unasked, widens neither what is saved nor what is asked for", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL, token: null }),
      [tokenKey(URL)]: fullRecord("token-A", READ_SCOPES),
    });
    const { gateway, approval } = approvingGateway();
    gateway.connectReply = (params) => ({
      ok: true,
      payload: helloOk([...(params as ConnectParams).scopes]),
    });
    const client = new ClawtrateClient(host(gateway, storage), FAST);
    await client.start();
    await until(() => client.state.connection.status === "connected");
    void client.requestAccess().catch(() => {});
    await until(() => client.state.connection.upgrade.status === "pending");
    const wanted = (gateway.calls("device.scopes.requestUpgrade")[0] as { scopes: string[] })
      .scopes;
    expect(wanted).not.toContain("operator.pairing");
    approval.resolve({
      status: "approved",
      requestId: "up-2",
      deviceToken: "token-U",
      scopes: [...wanted, "operator.pairing"],
    });
    await until(() => saved(storage)?.token === "token-U");
    expect(JSON.parse(storage.data.get(tokenKey(URL))!)).toMatchObject({ fullGrant: true });
    expect(saved(storage)?.heldScopes).not.toContain("operator.pairing");
    // The next reconnect asks for what is held, without it.
    const before = gateway.connects.length;
    gateway.dropAll();
    await until(() => gateway.connects.length > before);
    expect((gateway.connects.at(-1) as ConnectParams).scopes).not.toContain("operator.pairing");
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

  it("a look at another gateway while an upgrade waits leaves that upgrade's full grant as it is", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL, token: null }),
      [tokenKey(URL)]: fullRecord("token-A", READ_SCOPES),
      [tokenKey("ws://127.0.0.1:19962")]: JSON.stringify({
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
    void client.requestAccess().catch(() => {});
    await until(() => client.state.connection.upgrade.status === "pending");
    // A setup look reads another gateway's saved pairing meanwhile.
    expect(await client.deviceAccess("ws://127.0.0.1:19962")).toBe("paired");
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
});
