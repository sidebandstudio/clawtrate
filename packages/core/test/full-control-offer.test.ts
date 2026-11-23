// The one-time offer of full control to a device paired before it (setup-effortless.md §6,
// F-500): a read pairing at a protected address on a host with secure storage is offered it
// once; accepting sends one request for the six; granted, narrower, refused and dismissed
// are each saved per device and gateway endpoint, so nothing asks again by itself, across a
// restart and at another spelling of the address.

import { describe, expect, it } from "vitest";
import { ClawtrateClient, FULL_PAIRING_LIMIT } from "../src/client.ts";
import { endpointSpellings, gatewayEndpoint } from "../src/gateway-url.ts";
import type { KeyValueStore } from "../src/host.ts";
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
  await until(() => client.state.connection.status === "connected");
  return client;
}

const accept = (client: ClawtrateClient, url = URL) =>
  client.requestFullControl({ gatewayUrl: url, deviceId: DEVICE });

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
  it("F-NEW1: a read pairing at a protected address is offered it; accepting sends one request for exactly the six, in order, and a grant makes it a full pairing", async () => {
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

  it("F-NEW1: a narrower grant is kept as a full pairing, said, and nothing asks again, across a restart", async () => {
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

  it("F-NEW1: a refusal keeps the pairing as it was, is saved, and leaves the offer in Settings only, across a restart", async () => {
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

  it("F-NEW1: Keep current access is saved and asks nothing; the pairing is byte-identical, across a restart", async () => {
    const storage = pairedAt();
    const { gateway } = gatewayFor();
    const client = await connected(clientOn(gateway, storage));
    await client.dismissFullControl({ gatewayUrl: URL, deviceId: DEVICE });
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

  it("F-NEW1: a pairing that never takes the offer is byte-identical, and nothing is written for it", async () => {
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
  ] as const)("F-NEW1: isn't offered on %s", async (_name, url, options) => {
    const storage = pairedAt(url);
    const { gateway } = gatewayFor();
    const client = await connected(clientOn(gateway, storage, options));
    expect(client.state.connection.fullOffer).toBeNull();
    await expect(accept(client, url)).rejects.toThrow();
    expect(gateway.calls("device.scopes.requestUpgrade")).toEqual([]);
    expect(storage.data.get(tokenKey(url))).toBe(readRecord);
    client.stop();
  });

  it("F-NEW1: the offer is bound to the gateway and device it was shown for", async () => {
    const storage = pairedAt();
    const { gateway } = gatewayFor();
    const client = await connected(clientOn(gateway, storage));
    await expect(
      client.requestFullControl({ gatewayUrl: "wss://other.example", deviceId: DEVICE }),
    ).rejects.toThrow(/isn't offered/);
    await expect(
      client.requestFullControl({ gatewayUrl: URL, deviceId: "device-2" }),
    ).rejects.toThrow(/isn't offered/);
    expect(answer(storage)).toBeNull();
    expect(gateway.calls("device.scopes.requestUpgrade")).toEqual([]);
    client.stop();
  });

  it("F-NEW2: the same device at another spelling of its address is the same pairing, with its recorded answer", async () => {
    // Paired read-only at ws:// with a port; dismissed there. Connect is now at wss://, in
    // upper case, with a trailing dot.
    const old = "ws://gateway.example:19983";
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

  it("F-NEW2: endpoints ignore the scheme, case, a trailing dot and a written default port", () => {
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

  it("F-NEW2: an address with its own pairing keeps it, and a plain ws:// address never borrows one", async () => {
    // Its own record wins over another spelling's.
    const storage = pairedAt();
    storage.data.set(
      tokenKey("ws://gateway.example:19980"),
      JSON.stringify({ token: "token-W", grantedScopes: READ_SCOPES, heldScopes: READ_SCOPES }),
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
});
