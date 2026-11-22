// Full access behind a flag (`ClientOptions.fullAccess`; docs/decisions.md,
// "Scopes, once, at the first pairing"):
// a first pairing asks for all six operator scopes, the gateway's confirmed grant is the
// limit, a reconnect asks for exactly what is held, and an existing pairing keeps its
// grant. It needs a host that keeps credentials in secure storage, and stays off otherwise.

import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@openclaw/gateway-protocol";
import { ClawtrateClient, setupGrant, type ClientOptions } from "../src/client.ts";
import type { KeyValueStore } from "../src/host.ts";
import { FULL_SCOPES, INTERACTIVE_SCOPES, READ_SCOPES } from "../src/scopes.ts";
import { FakeGateway, helloOk, memoryStorage, testHost, tokenKey, until } from "./fake-gateway.ts";

const URL = "ws://127.0.0.1:19950";
const SHARED = "shared-gateway-token-7d3f";
const ISSUED = "issued-device-token-41ac";
const CODE = "setup-bootstrap-0123456789abcdefghijklmnopqrstuvw";
const FAST = { reconnect: { initialMs: 20, maxMs: 40 } };

type ConnectParams = {
  scopes: string[];
  caps: string[];
  auth?: { token?: string; deviceToken?: string; bootstrapToken?: string };
};
const connectAt = (gateway: FakeGateway, index: number) =>
  gateway.connects.at(index) as ConnectParams;

/** A gateway that grants what is asked for, or only `grant` of it, and issues one device token. */
function grantingGateway(grant?: readonly string[]) {
  const gateway = new FakeGateway();
  gateway.connectReply = (params) => {
    const { scopes, auth } = params as ConnectParams;
    return { ok: true, payload: helloOk([...(grant ?? scopes)], auth?.deviceToken ?? ISSUED) };
  };
  return gateway;
}

function fullClient(
  gateway: FakeGateway,
  options: {
    storage?: KeyValueStore & { data: Map<string, string> };
    secure?: (() => Promise<boolean>) | null;
    client?: ClientOptions;
    logs?: string[];
  } = {},
) {
  const storage = options.storage ?? memoryStorage();
  const secure = options.secure === undefined ? async () => true : options.secure;
  const host = {
    ...testHost(gateway, storage),
    ...(secure ? { secureCredentials: secure } : {}),
    log: (_level: string, line: string) => options.logs?.push(line),
  };
  const client = new ClawtrateClient(host, { ...FAST, fullAccess: true, ...options.client });
  return { client, storage };
}

const stored = (storage: { data: Map<string, string> }) =>
  JSON.parse(storage.data.get(tokenKey(URL)) ?? "null") as {
    token: string;
    heldScopes: string[];
    adminHeld?: boolean;
    pairingHeld?: boolean;
  } | null;

describe("full access behind a flag", () => {
  it("with silent local pairing, the first pairing asks for the six and holds them, and a reconnect asks for exactly those", async () => {
    const gateway = grantingGateway();
    const logs: string[] = [];
    const { client, storage } = fullClient(gateway, { logs });
    await client.start();
    await client.connect({ url: URL, token: SHARED });
    await until(() => client.state.connection.status === "connected");

    expect(connectAt(gateway, 0).scopes).toEqual([...FULL_SCOPES]);
    expect(connectAt(gateway, 0).caps).toEqual(
      expect.arrayContaining(["tool-events", "approvals", "exec-approvals", "plugin-approvals"]),
    );
    expect(stored(storage)).toMatchObject({
      token: ISSUED,
      heldScopes: [...FULL_SCOPES],
      adminHeld: true,
      pairingHeld: true,
    });
    expect(client.state.connection).toMatchObject({
      scopes: [...FULL_SCOPES],
      canWrite: true,
      canApprove: true,
      canAnswer: true,
      canAdmin: true,
    });

    gateway.dropAll();
    await until(() => gateway.connects.length === 2);
    await until(() => client.state.connection.status === "connected");
    expect(connectAt(gateway, 1)).toMatchObject({
      scopes: [...FULL_SCOPES],
      auth: { deviceToken: ISSUED },
    });

    // Neither credential reaches the state the interface is given, nor the log.
    for (const secret of [SHARED, ISSUED]) {
      expect(JSON.stringify(client.state)).not.toContain(secret);
      expect(logs.join("\n")).not.toContain(secret);
    }
    client.stop();
  });

  it("F-002: with an ordinary pending approval, one request lists the six, and its approval grants them", async () => {
    const gateway = new FakeGateway();
    let approved = false;
    gateway.connectReply = (params) => {
      const { scopes } = params as ConnectParams;
      if (approved) return { ok: true, payload: helloOk([...scopes], ISSUED) };
      return {
        ok: false,
        error: {
          code: "NOT_PAIRED",
          message: "device pairing required",
          details: { code: "PAIRING_REQUIRED", requestId: "req-1", deviceId: "device-1" },
        },
      };
    };
    const { client, storage } = fullClient(gateway);
    await client.start();
    await client.connect({ url: URL, token: SHARED });
    await until(() => client.state.connection.status === "pairing");
    expect(client.state.connection.pairing?.requestedScopes).toEqual([...FULL_SCOPES]);
    expect(connectAt(gateway, 0).scopes).toEqual([...FULL_SCOPES]);

    approved = true;
    await until(() => client.state.connection.status === "connected");
    for (const each of gateway.connects as ConnectParams[])
      expect(each.scopes).toEqual([...FULL_SCOPES]);
    expect(stored(storage)?.heldScopes).toEqual([...FULL_SCOPES]);
    expect(gateway.calls("device.scopes.requestUpgrade")).toEqual([]);
    client.stop();
  });

  it("a narrower grant is the limit: it is held, a reconnect asks for it, nothing asks again, and read-only works", async () => {
    const gateway = grantingGateway(READ_SCOPES);
    gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "never" });
    const { client, storage } = fullClient(gateway);
    await client.start();
    await client.connect({ url: URL, token: SHARED });
    await until(() => client.state.connection.status === "connected");
    expect(connectAt(gateway, 0).scopes).toEqual([...FULL_SCOPES]);
    expect(stored(storage)).toMatchObject({ heldScopes: [...READ_SCOPES] });
    expect(stored(storage)?.adminHeld).toBeUndefined();
    expect(client.state.connection).toMatchObject({
      scopes: [...READ_SCOPES],
      canWrite: false,
      canAdmin: false,
    });

    gateway.dropAll();
    await until(() => gateway.connects.length === 2);
    await until(() => client.state.connection.status === "connected");
    expect(connectAt(gateway, 1).scopes).toEqual([...READ_SCOPES]);
    expect(gateway.calls("device.scopes.requestUpgrade")).toEqual([]);
    client.stop();
  });

  it("an existing pairing keeps its grant: a read token asks for read, and its record is unchanged", async () => {
    const gateway = grantingGateway();
    const record = JSON.stringify({
      token: "device-token",
      grantedScopes: READ_SCOPES,
      heldScopes: READ_SCOPES,
    });
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL, token: null }),
      [tokenKey(URL)]: record,
    });
    const { client } = fullClient(gateway, { storage });
    await client.start();
    await until(() => client.state.connection.status === "connected");
    expect(connectAt(gateway, 0).scopes).toEqual([...READ_SCOPES]);
    expect(storage.data.get(tokenKey(URL))).toBe(record);
    client.stop();
  });

  const closed: Array<[string, (() => Promise<boolean>) | null, ClientOptions]> = [
    ["a host without secure storage", null, {}],
    ["a host whose secure storage isn't in use", async () => false, {}],
    ["a host whose secure storage can't say", async () => Promise.reject(new Error("no")), {}],
    ["a read-only host", async () => true, { readOnly: true }],
    ["the flag off", async () => true, { fullAccess: false }],
  ];
  for (const [name, secure, options] of closed) {
    it(`stays off for ${name}: the first pairing asks for read alone`, async () => {
      const gateway = grantingGateway();
      const { client, storage } = fullClient(gateway, { secure, client: options });
      await client.start();
      await client.connect({ url: URL, token: SHARED });
      await until(() => client.state.connection.status === "connected");
      expect(connectAt(gateway, 0).scopes).toEqual([...READ_SCOPES]);
      expect(stored(storage)?.heldScopes).toEqual([...READ_SCOPES]);
      expect(client.state.connection.canAdmin).toBe(false);
      client.stop();
    });
  }

  it("F-509: a setup code's first pairing asks for the six, and its token is written with what the gateway confirmed", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = (params) => {
      const { scopes, auth } = params as ConnectParams;
      const granted = auth?.bootstrapToken ? [...INTERACTIVE_SCOPES] : scopes;
      return { ok: true, payload: helloOk(granted, ISSUED) };
    };
    const { client, storage } = fullClient(gateway);
    await client.start();
    await client.connectWithSetupCode({
      url: URL,
      bootstrapToken: CODE,
      expiresAtMs: Date.now() + 600_000,
    });
    await until(() => client.state.connection.status === "connected");
    expect(connectAt(gateway, 0)).toMatchObject({
      scopes: [...FULL_SCOPES],
      auth: { bootstrapToken: CODE },
    });
    // A limited code's grant: kept as it is, within the six.
    expect(stored(storage)).toMatchObject({ token: ISSUED, heldScopes: [...INTERACTIVE_SCOPES] });
    expect(stored(storage)?.adminHeld).toBeUndefined();
    client.stop();
  });

  it("a setup grant is within the six only for the operator role and scopes it asked for", () => {
    const hello = (role: string, scopes: string[]) => ({
      protocol: PROTOCOL_VERSION,
      auth: { role, scopes } as never,
    });
    expect(setupGrant(hello("operator", [...FULL_SCOPES]), FULL_SCOPES)).toBe("within");
    expect(setupGrant(hello("operator", [...READ_SCOPES]), FULL_SCOPES)).toBe("within");
    expect(setupGrant(hello("operator", [...FULL_SCOPES, "operator.talk"]), FULL_SCOPES)).toBe(
      "other",
    );
    expect(setupGrant(hello("operator", []), FULL_SCOPES)).toBe("other");
    expect(setupGrant(hello("node", [...READ_SCOPES]), FULL_SCOPES)).toBe("other");
    expect(
      setupGrant(hello("operator", ["operator.sessions.read"]), ["operator.sessions.read"]),
    ).toBe("other");
    // Without full access, exactly read, as before.
    expect(setupGrant(hello("operator", [...READ_SCOPES]))).toBe("read");
    expect(setupGrant(hello("operator", [...FULL_SCOPES]))).toBe("other");
  });
});
