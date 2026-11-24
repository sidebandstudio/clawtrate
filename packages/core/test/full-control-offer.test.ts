// The one-time offer of full control to a device paired before it (setup-effortless.md §6,
// F-500): a read pairing at a protected address on a host with secure storage is offered it
// once; accepting sends one request for the six; granted, narrower, refused and dismissed
// are each saved per device and gateway endpoint, so nothing asks again by itself, across a
// restart and at another spelling of the address.

import { describe, expect, it } from "vitest";
import { ClawtrateClient, FULL_PAIRING_LIMIT, type ProvedRoute } from "../src/client.ts";
import { endpointSpellings, gatewayEndpoint, validateGatewayUrl } from "../src/gateway-url.ts";
import type { KeyValueStore } from "../src/host.ts";
import { FULL_SCOPES, READ_SCOPES } from "../src/scopes.ts";
import { gatewayStamp } from "../src/types.ts";
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

const URL = "wss://gateway.example:19980";
const DEVICE = "device-1";
const FAST = { reconnect: { initialMs: 20, maxMs: 40 }, fullAccess: true };
type ConnectParams = { scopes: string[]; auth?: { deviceToken?: string } };
type Storage = KeyValueStore & { data: Map<string, string> };

const readRecord = JSON.stringify({
  token: "token-A",
  grantedScopes: READ_SCOPES,
  heldScopes: READ_SCOPES,
});
const fullRecord = JSON.stringify({
  token: "token-A",
  grantedScopes: FULL_SCOPES,
  heldScopes: FULL_SCOPES,
  fullGrant: true,
});
const pairedAt = (url = URL, record = readRecord) =>
  memoryStorage({
    connection: JSON.stringify({ url, token: null }),
    [tokenKey(url)]: record,
  });
const offerKey = (url = URL) =>
  `fullControlOffer:${encodeURIComponent(gatewayEndpoint(url)!)}:${DEVICE}`;
const answer = (storage: Storage, url = URL) =>
  JSON.parse(storage.data.get(offerKey(url)) ?? "null")?.answer ?? null;
const record = (storage: Storage, url = URL) =>
  JSON.parse(storage.data.get(tokenKey(url)) ?? "null") as {
    token: string;
    heldScopes: string[];
    fullGrant?: boolean;
  } | null;

/** A gateway that grants each connect what it asks for, and holds each upgrade for `decide`. */
function gatewayFor() {
  const gateway = new FakeGateway();
  gateway.connectReply = (params) => ({
    ok: true,
    payload: helloOk(
      [...(params as ConnectParams).scopes],
      (params as ConnectParams).auth?.deviceToken,
    ),
  });
  const decision = deferred<unknown>();
  gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-1" });
  gateway.handlers["device.scopes.waitUpgrade"] = () => decision.promise;
  // Its identity, which the offer's stamp carries (`GatewayStamp`).
  gateway.handlers["gateway.identity.get"] = () => ({ deviceId: "gateway-a" });
  return {
    gateway,
    decide: (result: object) => decision.resolve({ requestId: "up-1", ...result }),
  };
}

function clientOn(
  gateway: FakeGateway,
  storage: Storage,
  options: { secure?: boolean; readOnly?: boolean; fullAccess?: boolean } = {},
) {
  return new ClawtrateClient(
    { ...testHost(gateway, storage), secureCredentials: async () => options.secure ?? true },
    {
      ...FAST,
      ...(options.fullAccess === false ? { fullAccess: false } : {}),
      ...(options.readOnly ? { readOnly: true } : {}),
    },
  );
}

async function connected(client: ClawtrateClient) {
  await client.start();
  await until(
    () =>
      client.state.connection.status === "connected" && client.state.connection.gatewayId !== null,
  );
  return client;
}

/** The offer as the screen shows it now: its gateway, this device and the connection's stamp. */
const binding = (client: ClawtrateClient, url = URL) => ({
  gatewayUrl: url,
  deviceId: DEVICE,
  stamp: gatewayStamp(client.state.connection),
});
const accept = (client: ClawtrateClient, url = URL) =>
  client.requestFullControl(binding(client, url));

/** A restart on the same storage: what the offer is then, and what was asked. */
async function afterRestart(storage: Storage) {
  const { gateway } = gatewayFor();
  const client = await connected(clientOn(gateway, storage));
  const seen = {
    offer: client.state.connection.fullOffer,
    fullPairing: client.state.connection.fullPairing,
    asked: (gateway.connects.at(-1) as ConnectParams).scopes,
  };
  client.stop();
  return seen;
}

describe("the one-time offer of full control (F-500)", () => {
  it("F-549: a read pairing at a protected address is offered it; accepting sends one request for exactly the six, in order, and a grant makes it a full pairing", async () => {
    const storage = pairedAt();
    const { gateway, decide } = gatewayFor();
    const client = await connected(clientOn(gateway, storage));
    expect((gateway.connects[0] as ConnectParams).scopes).toEqual([...READ_SCOPES]);
    expect(client.state.connection).toMatchObject({ fullOffer: "offer", fullPairing: false });

    await accept(client);
    await until(() => client.state.connection.upgrade.status === "pending");
    expect(gateway.calls("device.scopes.requestUpgrade")).toEqual([{ scopes: [...FULL_SCOPES] }]);
    // Answered as soon as it is sent: the offer doesn't show by itself again.
    expect(answer(storage)).toBe("asked");
    expect(client.state.connection.fullOffer).toBe("settings");

    decide({ status: "approved", deviceToken: "token-F", scopes: [...FULL_SCOPES] });
    await until(() => client.state.connection.fullPairing);
    expect(record(storage)).toMatchObject({
      token: "token-F",
      heldScopes: [...FULL_SCOPES],
      fullGrant: true,
    });
    expect((gateway.connects.at(-1) as ConnectParams).scopes).toEqual([...FULL_SCOPES]);
    expect(client.state.connection).toMatchObject({ canAdmin: true, fullOffer: null });
    expect(answer(storage)).toBe("granted");
    expect(gateway.calls("device.scopes.requestUpgrade")).toHaveLength(1);
    client.stop();

    expect(await afterRestart(storage)).toEqual({
      offer: null,
      fullPairing: true,
      asked: [...FULL_SCOPES],
    });
  });

  it("F-549: a narrower grant is kept as a full pairing, said, and nothing asks again, across a restart", async () => {
    const storage = pairedAt();
    const { gateway, decide } = gatewayFor();
    const client = await connected(clientOn(gateway, storage));
    await accept(client);
    await until(() => client.state.connection.upgrade.status === "pending");
    decide({
      status: "approved",
      deviceToken: "token-N",
      scopes: ["operator.read", "operator.write"],
    });
    await until(() => client.state.connection.fullPairing);
    expect(record(storage)).toMatchObject({
      token: "token-N",
      heldScopes: ["operator.read", "operator.write"],
      fullGrant: true,
    });
    expect(answer(storage)).toBe("narrower");
    expect(client.state.connection).toMatchObject({
      canWrite: true,
      canAdmin: false,
      fullOffer: null,
    });
    await expect(client.requestAccess("admin")).rejects.toThrow(FULL_PAIRING_LIMIT);
    await expect(accept(client)).rejects.toThrow(/isn't offered/);
    expect(gateway.calls("device.scopes.requestUpgrade")).toHaveLength(1);
    client.stop();

    expect(await afterRestart(storage)).toEqual({
      offer: null,
      fullPairing: true,
      asked: ["operator.read", "operator.write"],
    });
  });

  it("F-549: no second request goes for a full pairing between its approval and the next hello", async () => {
    const storage = pairedAt();
    const { gateway, decide } = gatewayFor();
    const client = await connected(clientOn(gateway, storage));
    await accept(client);
    await until(() => client.state.connection.upgrade.status === "pending");
    const set = storage.set.bind(storage);
    let again: Promise<unknown> | null = null;
    storage.set = async (key: string, value: string) => {
      await set(key, value);
      if (key === offerKey() && value.includes("narrower"))
        again ??= accept(client).then(
          () => null,
          (error: unknown) => error,
        );
    };
    decide({
      status: "approved",
      deviceToken: "token-N",
      scopes: ["operator.read", "operator.write"],
    });
    await until(() => again !== null);
    // Refused at once, its outcome kept as it came, so no rejection goes unhandled.
    expect(await again).toBeInstanceOf(Error);
    await until(() => client.state.connection.fullPairing);
    expect(gateway.calls("device.scopes.requestUpgrade")).toHaveLength(1);
    client.stop();
  });

  it("F-549: two accepts at once, a double click or two windows, send one request", async () => {
    const storage = pairedAt();
    const { gateway } = gatewayFor();
    const client = await connected(clientOn(gateway, storage));
    await Promise.all([accept(client), accept(client)]);
    await until(() => client.state.connection.upgrade.status === "pending");
    expect(gateway.calls("device.scopes.requestUpgrade")).toHaveLength(1);
    client.stop();
  });

  it("F-549: an accept whose connection stopped before an answer can be made again after Retry", async () => {
    const storage = pairedAt();
    const { gateway } = gatewayFor();
    const client = await connected(clientOn(gateway, storage));
    await accept(client);
    await until(() => client.state.connection.upgrade.status === "pending");
    // The connection drops while the owner decides, and the gateway then stops letting it back.
    const reply = gateway.connectReply;
    gateway.connectReply = () => ({
      ok: false,
      error: { code: "UNAUTHORIZED", message: "slow down", details: { code: "AUTH_RATE_LIMITED" } },
    });
    gateway.dropAll();
    await until(() => client.state.connection.status === "error");
    gateway.connectReply = reply;
    await client.retryNow();
    await until(
      () =>
        client.state.connection.status === "connected" &&
        client.state.connection.gatewayId !== null &&
        client.state.connection.fullOffer === "settings",
    );
    await accept(client);
    await until(() => gateway.calls("device.scopes.requestUpgrade").length === 2);
    client.stop();
  });

  it("F-549: a refusal keeps the pairing as it was, is saved, and leaves the offer in Settings only, across a restart", async () => {
    const storage = pairedAt();
    const { gateway, decide } = gatewayFor();
    const client = await connected(clientOn(gateway, storage));
    await accept(client);
    await until(() => client.state.connection.upgrade.status === "pending");
    decide({ status: "rejected" });
    await until(() => client.state.connection.upgrade.status === "rejected");
    await until(() => answer(storage) === "refused");
    expect(storage.data.get(tokenKey(URL))).toBe(readRecord);
    expect(client.state.connection).toMatchObject({ fullOffer: "settings", fullPairing: false });
    await sleep(50);
    expect(gateway.calls("device.scopes.requestUpgrade")).toHaveLength(1);
    client.stop();

    expect(await afterRestart(storage)).toEqual({
      offer: "settings",
      fullPairing: false,
      asked: [...READ_SCOPES],
    });
  });

  it("F-549: Keep current access is saved and asks nothing; the pairing is byte-identical, across a restart", async () => {
    const storage = pairedAt();
    const { gateway } = gatewayFor();
    const client = await connected(clientOn(gateway, storage));
    await client.dismissFullControl(binding(client));
    expect(answer(storage)).toBe("dismissed");
    expect(client.state.connection.fullOffer).toBe("settings");
    expect(gateway.calls("device.scopes.requestUpgrade")).toEqual([]);
    expect(storage.data.get(tokenKey(URL))).toBe(readRecord);
    client.stop();

    expect(await afterRestart(storage)).toEqual({
      offer: "settings",
      fullPairing: false,
      asked: [...READ_SCOPES],
    });
    // Still reachable from Settings: the person may ask later, once.
    const { gateway: later, decide } = gatewayFor();
    const again = await connected(clientOn(later, storage));
    await accept(again);
    await until(() => again.state.connection.upgrade.status === "pending");
    expect(later.calls("device.scopes.requestUpgrade")).toEqual([{ scopes: [...FULL_SCOPES] }]);
    decide({ status: "expired" });
    again.stop();
  });

  it("F-549: a pairing that never takes the offer is byte-identical, and nothing is written for it", async () => {
    const storage = pairedAt();
    const before = new Map(storage.data);
    const { gateway } = gatewayFor();
    const client = await connected(clientOn(gateway, storage));
    expect(client.state.connection.fullOffer).toBe("offer");
    gateway.dropAll();
    await until(() => gateway.connects.length === 2);
    await until(() => client.state.connection.status === "connected");
    client.stop();
    expect(storage.data).toEqual(before);
  });

  it.each([
    ["plain ws://", "ws://gateway.example:19981", {}],
    ["a loopback wss:// address", "wss://127.0.0.1:19982", {}],
    ["a session-only host", URL, { secure: false }],
    ["a read-only host", URL, { readOnly: true }],
    ["a host without full access", URL, { fullAccess: false }],
  ] as const)("F-549: isn't offered on %s", async (_name, url, options) => {
    const storage = pairedAt(url);
    const { gateway } = gatewayFor();
    const client = await connected(clientOn(gateway, storage, options));
    expect(client.state.connection.fullOffer).toBeNull();
    await expect(accept(client, url)).rejects.toThrow();
    expect(gateway.calls("device.scopes.requestUpgrade")).toEqual([]);
    expect(storage.data.get(tokenKey(url))).toBe(readRecord);
    client.stop();
  });

  it("F-549: isn't offered at any loopback spelling, even with a secure scheme", async () => {
    const spellings = [
      "wss://localhost:19984",
      "wss://LOCALHOST.:19984",
      "wss://a.localhost:19984",
      "wss://127.1:19984",
      "wss://0.0.0.0:19984",
      "wss://[::1]:19984",
      "wss://[::]:19984",
      "wss://[::ffff:127.0.0.1]:19984",
    ];
    for (const url of spellings) {
      const storage = pairedAt(url);
      const before = new Map(storage.data);
      const { gateway } = gatewayFor();
      const client = await connected(clientOn(gateway, storage));
      expect(client.state.connection.fullOffer, url).toBeNull();
      await expect(accept(client, client.state.connection.gatewayUrl!), url).rejects.toThrow();
      expect(gateway.calls("device.scopes.requestUpgrade"), url).toEqual([]);
      expect(storage.data, url).toEqual(before);
      client.stop();
    }
  });

  it("F-549: over a proved local route, no offer, and a full pairing there asks for nothing more", async () => {
    const LOCAL = "ws://127.0.0.1:19986";
    const ROUTE = ".openclaw-clawtrate";
    for (const record of [readRecord, fullRecord]) {
      const storage = memoryStorage({
        connection: JSON.stringify({ url: LOCAL, token: null, route: ROUTE }),
        [tokenKey(LOCAL)]: JSON.stringify({ ...JSON.parse(record), route: ROUTE }),
      });
      const { gateway } = gatewayFor();
      const sockets: ProvedRoute = {
        createSocket: (url) => gateway.createWebSocket(url),
        verify: async () => true,
      };
      const client = new ClawtrateClient(
        { ...testHost(gateway, storage), secureCredentials: async () => true },
        { ...FAST, localConnect: () => sockets },
      );
      await connected(client);
      expect(client.state.connection.fullOffer).toBeNull();
      if (record === fullRecord) {
        // Full access holds on the proved route: the six are asked for and held.
        expect((gateway.connects.at(-1) as ConnectParams).scopes).toEqual([...FULL_SCOPES]);
        expect(client.state.connection.fullPairing).toBe(true);
        await expect(client.requestAccess("admin")).rejects.toThrow(FULL_PAIRING_LIMIT);
      }
      await expect(accept(client, LOCAL)).rejects.toThrow(/isn't offered/);
      expect(gateway.calls("device.scopes.requestUpgrade")).toEqual([]);
      client.stop();
    }
  });

  it("F-549: the offer is bound to the gateway and device it was shown for", async () => {
    const storage = pairedAt();
    const { gateway } = gatewayFor();
    const client = await connected(clientOn(gateway, storage));
    await expect(client.requestFullControl(binding(client, "wss://other.example"))).rejects.toThrow(
      /isn't offered/,
    );
    await expect(
      client.requestFullControl({ ...binding(client), deviceId: "device-2" }),
    ).rejects.toThrow(/isn't offered/);
    expect(answer(storage)).toBeNull();
    expect(gateway.calls("device.scopes.requestUpgrade")).toEqual([]);
    client.stop();
  });

  it("F-549: the same device at another spelling of its address is the same pairing, with its recorded answer", async () => {
    // Paired read-only at wss://; dismissed there. Connect is now in upper case, with a
    // trailing dot.
    const old = "wss://gateway.example:19983";
    const storage = pairedAt(old);
    storage.data.set(offerKey(old), JSON.stringify({ answer: "dismissed" }));
    const { gateway } = gatewayFor();
    const client = clientOn(gateway, storage);
    await client.start();
    await client.connect({ url: "wss://GATEWAY.example.:19983" });
    await until(() => client.state.connection.status === "connected");
    // Not a second first pairing: the saved pairing's token, asking for what it holds.
    const first = gateway.connects.at(-1) as ConnectParams;
    expect(first.scopes).toEqual([...READ_SCOPES]);
    expect(first.auth?.deviceToken).toBe("token-A");
    expect(client.state.connection.fullOffer).toBe("settings");
    expect(storage.data.get(tokenKey(old))).toBe(readRecord);
    expect(storage.data.has(tokenKey("wss://gateway.example.:19983"))).toBe(false);
    client.stop();
  });

  it("F-549: a wss:// address never takes up a pairing saved at ws://, so a full grant is never kept where ws:// reads it", async () => {
    const plain = "ws://gateway.example:19988";
    const storage = pairedAt(plain);
    const { gateway } = gatewayFor();
    const client = clientOn(gateway, storage);
    await client.start();
    await client.connect({ url: "wss://gateway.example:19988" });
    await until(() => gateway.connects.length > 0);
    expect((gateway.connects.at(-1) as ConnectParams).auth?.deviceToken).toBeUndefined();
    expect(storage.data.get(tokenKey(plain))).toBe(readRecord);
    client.stop();
  });

  it("F-549: endpoints ignore the scheme, case, a trailing dot and a written default port", () => {
    expect(gatewayEndpoint("wss://GW.example.:443")).toBe(gatewayEndpoint("ws://gw.example:443"));
    expect(gatewayEndpoint("wss://gw.example")).toBe("gw.example:443");
    expect(gatewayEndpoint("ws://gw.example")).toBe("gw.example:80");
    expect(gatewayEndpoint("wss://gw.example/base/")).toBe("gw.example:443/base");
    expect(gatewayEndpoint("wss://gw.example:1")).not.toBe(gatewayEndpoint("wss://gw.example:2"));
    expect(gatewayEndpoint("http://gw.example")).toBeNull();
    expect(endpointSpellings("wss://gw.example").sort()).toEqual(
      ["wss://gw.example.", "ws://gw.example:443", "ws://gw.example.:443"].sort(),
    );
    expect(endpointSpellings("wss://[2001:db8::5]:9000")).toEqual(["ws://[2001:db8::5]:9000"]);
  });

  it("F-549: an address with its own pairing keeps it, and a plain ws:// address never borrows one", async () => {
    // Its own record wins over another spelling's, one it could otherwise take up.
    const storage = pairedAt();
    storage.data.set(
      tokenKey("wss://gateway.example.:19980"),
      JSON.stringify({ token: "token-D", grantedScopes: READ_SCOPES, heldScopes: READ_SCOPES }),
    );
    const { gateway } = gatewayFor();
    const client = await connected(clientOn(gateway, storage));
    expect((gateway.connects[0] as ConnectParams).auth?.deviceToken).toBe("token-A");
    client.stop();
    // A ws:// address is never given the token saved for its wss:// spelling.
    const secure = pairedAt();
    const { gateway: plain } = gatewayFor();
    const other = clientOn(plain, secure);
    await other.start();
    await other.connect({ url: "ws://gateway.example:19980" });
    await until(() => plain.connects.length > 0);
    expect((plain.connects.at(-1) as ConnectParams).auth?.deviceToken).toBeUndefined();
    other.stop();
  });
  it("F-549: two accepts, with the owner's refusal between their saves, send one request", async () => {
    const storage = pairedAt();
    const { gateway, decide } = gatewayFor();
    const client = await connected(clientOn(gateway, storage));
    // The second accept's save of its answer waits until after the refusal.
    const set = storage.set.bind(storage);
    const held = deferred<void>();
    let writes = 0;
    storage.set = async (key: string, value: string) => {
      if (key === offerKey() && ++writes === 2) await held.promise;
      await set(key, value);
    };
    const first = accept(client).then(
      () => null,
      (error: unknown) => error,
    );
    const second = accept(client).then(
      () => null,
      (error: unknown) => error,
    );
    await until(() => client.state.connection.upgrade.status === "pending");
    decide({ status: "rejected" });
    await until(() => client.state.connection.upgrade.status === "rejected");
    held.resolve();
    await Promise.all([first, second]);
    await sleep(50);
    expect(gateway.calls("device.scopes.requestUpgrade")).toHaveLength(1);
    client.stop();
  });

  it("F-549: an access request queued at startup sends nothing for a full pairing", async () => {
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL, token: null }),
      // A full pairing the gateway granted read alone: an admin request would be sent.
      [tokenKey(URL)]: JSON.stringify({
        token: "token-A",
        grantedScopes: READ_SCOPES,
        heldScopes: READ_SCOPES,
        fullGrant: true,
      }),
    });
    const { gateway } = gatewayFor();
    // The first read of the saved pairing waits, so the request below comes before its grant
    // is known.
    const hello = deferred<void>();
    let reading = false;
    const get = storage.get.bind(storage);
    storage.get = async (key: string) => {
      if (key === tokenKey(URL) && !reading) {
        reading = true;
        await hello.promise;
      }
      return get(key);
    };
    const client = clientOn(gateway, storage);
    const starting = client.start();
    await until(() => reading);
    const queued = client.requestAccess("admin").then(
      () => null,
      (error: unknown) => error,
    );
    hello.resolve();
    await starting;
    await until(() => client.state.connection.fullPairing);
    await sleep(50);
    expect(gateway.calls("device.scopes.requestUpgrade")).toEqual([]);
    expect(await queued).toBeNull();
    expect(client.state.connection.upgrade.status).toBe("idle");
    client.stop();
  });

  it("F-549: a protected hello that left no saved pairing offers nothing", async () => {
    // A typed token the gateway accepts without issuing a device token.
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({ ok: true, payload: helloOk([...READ_SCOPES], "") });
    gateway.handlers["gateway.identity.get"] = () => ({ deviceId: "gateway-a" });
    const storage = memoryStorage();
    const client = clientOn(gateway, storage);
    await client.start();
    await client.connect({ url: URL, token: "typed-shared-token" });
    await until(
      () =>
        client.state.connection.status === "connected" &&
        client.state.connection.gatewayId !== null,
    );
    expect(storage.data.has(tokenKey(URL))).toBe(false);
    expect(client.state.connection.fullOffer).toBeNull();
    client.stop();
  });

  it("F-549: an address whose query ends in a slash takes up no other spelling's pairing", () => {
    const dialled = validateGatewayUrl("wss://gateway.example/?tenant=one//");
    expect(dialled).toBe("wss://gateway.example/?tenant=one/");
    expect(endpointSpellings(dialled)).toEqual([]);
    // The same query, character for character, in every spelling of an ordinary one.
    for (const each of endpointSpellings("wss://gateway.example/?tenant=one"))
      expect(each).toMatch(/\?tenant=one$/);
  });

  it("F-549: a refused token at a borrowed spelling is removed from that spelling's record", async () => {
    const dotted = "wss://gateway.example.:19987";
    const storage = pairedAt(dotted);
    storage.data.set(
      "connection",
      JSON.stringify({ url: "wss://gateway.example:19987", token: null }),
    );
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: false,
      error: { code: "UNAUTHORIZED", message: "refused", details: { code: "AUTH_TOKEN_MISMATCH" } },
    });
    const client = clientOn(gateway, storage);
    await client.start();
    await until(() => gateway.connects.length > 0);
    expect((gateway.connects[0] as ConnectParams).auth?.deviceToken).toBe("token-A");
    await until(() => !storage.data.has(tokenKey(dotted)));
    client.stop();
  });
});
