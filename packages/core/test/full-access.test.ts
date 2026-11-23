// Full access behind a flag (`ClientOptions.fullAccess`; docs/decisions.md,
// "Scopes, once, at the first pairing"):
// a first pairing asks for all six operator scopes, the gateway's confirmed grant is the
// limit, a reconnect asks for exactly what is held, and an existing pairing keeps its
// grant. It needs a host that keeps credentials in secure storage, and stays off otherwise.

import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@openclaw/gateway-protocol";
import { ClawtrateClient, setupGrant, type ClientOptions } from "../src/client.ts";
import { protectedGatewayUrl, validateGatewayUrl } from "../src/gateway-url.ts";
import type { KeyValueStore } from "../src/host.ts";
import { FULL_SCOPES, READ_SCOPES } from "../src/scopes.ts";
import { FakeGateway, helloOk, memoryStorage, testHost, tokenKey, until } from "./fake-gateway.ts";

const URL = "wss://gateway.example:19950";
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
    fullGrant?: boolean;
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
      fullGrant: true,
    });
    expect(client.state.connection).toMatchObject({
      scopes: [...FULL_SCOPES],
      canWrite: true,
      canApprove: true,
      canAnswer: true,
      canAdmin: true,
      fullPairing: true,
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
          details: {
            code: "PAIRING_REQUIRED",
            requestId: "req-1",
            deviceId: "device-1",
            // What the gateway reports is not what is shown: the signed request is.
            requestedScopes: ["operator.read"],
          },
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
      // Still a full pairing, holding less: the interface says so and asks for nothing.
      fullPairing: true,
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
    expect(client.state.connection.fullPairing).toBe(false);
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
      expect(client.state.connection.fullPairing).toBe(false);
      client.stop();
    });
  }

  // docs/design/setup-effortless.md §3 and §4: full access only over `wss://` to an address
  // that isn't loopback, until the send gate proves a local socket.
  const unprotected = [
    ["plain ws:// to another computer", "ws://gateway.example:19950"],
    ["ws:// on loopback", "ws://127.0.0.1:19950"],
    ["wss:// on loopback", "wss://127.0.0.1:19950"],
    ["wss:// to localhost", "wss://localhost:19950"],
    ["wss:// to IPv6 loopback", "wss://[::1]:19950"],
  ];
  for (const [name, url] of unprotected) {
    it(`stays off for ${name}: a first pairing there asks for read alone`, async () => {
      const gateway = grantingGateway();
      const { client, storage } = fullClient(gateway);
      await client.start();
      await client.connect({ url: url!, token: SHARED });
      await until(() => client.state.connection.status === "connected");
      expect(connectAt(gateway, 0).scopes).toEqual([...READ_SCOPES]);
      const record = JSON.parse(storage.data.get(tokenKey(url!)) ?? "null") as {
        fullGrant?: boolean;
      };
      expect(record.fullGrant).toBeUndefined();
      expect(client.state.connection).toMatchObject({ canAdmin: false, fullPairing: false });
      client.stop();
    });
  }

  // §3's send gate: this computer's gateway through local connect's proved sockets. Every socket
  // of the connection comes from that route, and the person's consent holds when it opens.
  const LOOPBACK = "ws://127.0.0.1:19950";
  const provedRoute = (gateway: FakeGateway, consent: () => boolean) => {
    const made: string[] = [];
    return {
      made,
      setup: {
        createSocket: (url: string) => (made.push(url), gateway.createWebSocket(url)),
        consent,
      },
    };
  };

  it("through local connect's proved sockets, with the person's consent, a first pairing at this computer's gateway asks for the six", async () => {
    const gateway = grantingGateway();
    const { client, storage } = fullClient(gateway);
    const route = provedRoute(gateway, () => true);
    await client.start();
    await client.connect({ url: LOOPBACK, token: SHARED }, route.setup);
    await until(() => client.state.connection.status === "connected");
    expect(connectAt(gateway, 0).scopes).toEqual([...FULL_SCOPES]);
    expect(route.made).toEqual([LOOPBACK]);
    const record = JSON.parse(storage.data.get(tokenKey(LOOPBACK)) ?? "null") as {
      fullGrant?: boolean;
    };
    expect(record.fullGrant).toBe(true);
    client.stop();
  });

  it("through the proved sockets without the person's consent, it asks for read alone", async () => {
    const gateway = grantingGateway();
    const { client } = fullClient(gateway);
    await client.start();
    await client.connect({ url: LOOPBACK, token: SHARED }, provedRoute(gateway, () => false).setup);
    await until(() => client.state.connection.status === "connected");
    expect(connectAt(gateway, 0).scopes).toEqual([...READ_SCOPES]);
    client.stop();
  });

  it("a loopback setup code still starts read-only, even through the proved sockets (F-509)", async () => {
    const gateway = grantingGateway();
    const { client } = fullClient(gateway);
    await client.start();
    await client.connectWithSetupCode(
      { url: LOOPBACK, bootstrapToken: CODE, expiresAtMs: Date.now() + 600_000 },
      provedRoute(gateway, () => true).setup,
    );
    await until(() => client.state.connection.status === "connected");
    expect(connectAt(gateway, 0).scopes).toEqual([...READ_SCOPES]);
    client.stop();
  });

  it("a protected route is wss:// to an address that isn't loopback, in any spelling", () => {
    for (const url of [
      "wss://gateway.example",
      "wss://gateway.example:8443/openclaw",
      "wss://gateway.example.org",
      "wss://203.example",
      "wss://[2001:db8::1]",
      " wss://GATEWAY.example. ",
    ])
      expect(protectedGatewayUrl(url), url).toBe(true);
    for (const url of [
      "ws://gateway.example",
      "wss://localhost",
      "wss://LOCALHOST.",
      "wss://app.localhost",
      "wss://127.0.1",
      "wss://127.1",
      "wss://0x7f000001",
      "wss://2130706433",
      "wss://127.0.0.1",
      "wss://0.0.0.0",
      "wss://[::1]",
      "wss://[::]",
      "wss://[::ffff:127.0.0.1]",
      "wss://[0:0:0:0:0:0:0:1]",
      // §4: an address with a user name, password or fragment can't be used.
      "wss://user:pw@gateway.example.com",
      "wss://user@gateway.example.com",
      "wss://gateway.example#x",
      "wss://gateway.example#",
      "wss://gateway.example#/",
      "https://gateway.example",
      "not an address",
      "",
    ])
      expect(protectedGatewayUrl(url), url).toBe(false);
    // The form reads the address as typed, the client the address saved: they must agree.
    for (const url of [
      "wss://gateway.example",
      " wss://GATEWAY.example. ",
      "wss://gateway.example/",
      "wss://gateway.example#",
      "wss://gateway.example#/",
      "wss://gateway.example/#/",
      "wss://[::ffff:127.0.0.1]",
      "wss://user@gateway.example.com",
    ])
      expect(protectedGatewayUrl(validateGatewayUrl(url)), url).toBe(protectedGatewayUrl(url));
  });

  it("F-509: a full setup code's first pairing asks for the six, and its token is written with exactly the grant", async () => {
    const gateway = grantingGateway();
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
    expect(stored(storage)).toMatchObject({
      token: ISSUED,
      heldScopes: [...FULL_SCOPES],
      fullGrant: true,
    });
    client.stop();
  });

  it("F-509: a setup retry keeps full access while approval is pending and asks only for read after it ends", async () => {
    const gateway = new FakeGateway();
    let nextStep = "wait_then_retry";
    gateway.connectReply = () => ({
      ok: false,
      error: {
        code: "NOT_PAIRED",
        message: "pairing required",
        details: { code: "PAIRING_REQUIRED", requestId: "req-1", recommendedNextStep: nextStep },
      },
    });
    const { client } = fullClient(gateway);
    try {
      await client.start();
      await client.connectWithSetupCode({
        url: URL,
        bootstrapToken: CODE,
        expiresAtMs: Date.now() + 600_000,
      });
      await until(() => client.state.connection.status === "pairing");

      nextStep = "contact_owner";
      await client.retryNow();
      await until(() => client.state.connection.error?.code === "PAIRING_ENDED");
      expect(connectAt(gateway, -1)).toMatchObject({
        scopes: [...FULL_SCOPES],
        auth: { bootstrapToken: CODE },
      });

      const before = gateway.connects.length;
      await client.retryNow();
      await until(() => gateway.connects.length > before);
      const retry = connectAt(gateway, before);
      expect(retry.scopes).toEqual([...READ_SCOPES]);
      expect(retry.auth?.bootstrapToken).toBeUndefined();
    } finally {
      client.stop();
    }
  });

  it("F-509: a limited code refuses the six; nothing is kept and nothing smaller is asked for by itself", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: false,
      error: {
        code: "UNAUTHORIZED",
        message: "bootstrap token invalid",
        details: { code: "AUTH_BOOTSTRAP_TOKEN_INVALID" },
      },
    });
    const { client, storage } = fullClient(gateway);
    await client.start();
    await client.connectWithSetupCode({
      url: URL,
      bootstrapToken: CODE,
      expiresAtMs: Date.now() + 600_000,
    });
    await until(() => client.state.connection.status === "error");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(stored(storage)).toBe(null);
    for (const each of gateway.connects as ConnectParams[])
      expect(each.scopes).toEqual([...FULL_SCOPES]);
    client.stop();
  });

  const exact: Array<[string, string[], string[]]> = [
    ["questions alone", ["operator.questions"], ["operator.questions"]],
    ["admin alone", ["operator.admin"], ["operator.admin"]],
    [
      "read and pairing, and one it never asked for",
      ["operator.read", "operator.pairing", "operator.talk"],
      ["operator.read", "operator.pairing"],
    ],
  ];
  for (const [name, grant, held] of exact) {
    it(`keeps exactly what was granted by name (${name}), and a reconnect asks for no more`, async () => {
      const gateway = grantingGateway(grant);
      const { client, storage } = fullClient(gateway);
      await client.start();
      await client.connect({ url: URL, token: SHARED });
      await until(() => client.state.connection.status === "connected");
      expect(stored(storage)).toMatchObject({ heldScopes: held, fullGrant: true });
      gateway.dropAll();
      await until(() => gateway.connects.length === 2);
      await until(() => client.state.connection.status === "connected");
      expect(connectAt(gateway, 1).scopes).toEqual(held);
      client.stop();
    });
  }

  it("a reconnect whose grant narrowed, with the same token, narrows the record, and the next asks for that", async () => {
    let grant: string[] | null = null;
    const gateway = new FakeGateway();
    gateway.connectReply = (params) => {
      const { scopes, auth } = params as ConnectParams;
      return { ok: true, payload: helloOk(grant ?? scopes, auth?.deviceToken ?? ISSUED) };
    };
    const { client, storage } = fullClient(gateway);
    await client.start();
    await client.connect({ url: URL, token: SHARED });
    await until(() => client.state.connection.status === "connected");
    expect(stored(storage)?.heldScopes).toEqual([...FULL_SCOPES]);
    grant = [...READ_SCOPES];
    gateway.dropAll();
    await until(() => stored(storage)?.heldScopes.length === 1);
    expect(stored(storage)).toMatchObject({ token: ISSUED, heldScopes: [...READ_SCOPES] });
    gateway.dropAll();
    await until(() => gateway.connects.length === 3);
    expect(connectAt(gateway, 2).scopes).toEqual([...READ_SCOPES]);
    client.stop();
  });

  it("a malformed hello on a first full pairing writes nothing", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: true,
      payload: {
        ...helloOk([...FULL_SCOPES], ISSUED),
        auth: { role: "operator", scopes: "operator.admin", deviceToken: ISSUED },
      },
    });
    const { client, storage } = fullClient(gateway);
    await client.start();
    await client.connect({ url: URL, token: SHARED });
    await until(() => gateway.connects.length >= 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(stored(storage)).toBe(null);
    client.stop();
  });

  it("a full pairing's refused token ends the attempt: nothing asks for the six again until the person connects", async () => {
    const gateway = grantingGateway();
    const { client, storage } = fullClient(gateway);
    await client.start();
    await client.connect({ url: URL, token: SHARED });
    await until(() => client.state.connection.status === "connected");
    gateway.connectReply = () => ({
      ok: false,
      error: {
        code: "UNAUTHORIZED",
        message: "device token mismatch",
        details: { code: "AUTH_DEVICE_TOKEN_MISMATCH" },
      },
    });
    gateway.dropAll();
    await until(() => stored(storage) === null);
    // Waiting for approval from here on: every attempt can be seen, and none is granted.
    const pending = {
      ok: false as const,
      error: {
        code: "NOT_PAIRED",
        message: "device pairing required",
        details: { code: "PAIRING_REQUIRED", requestId: "req-2", deviceId: "device-1" },
      },
    };
    gateway.connectReply = () => pending;
    const before = gateway.connects.length;
    await client.retryNow();
    await until(() => gateway.connects.length > before);
    for (const each of (gateway.connects as ConnectParams[]).slice(before))
      expect(each.scopes).toEqual([...READ_SCOPES]);
    await client.connect({ url: URL, token: SHARED });
    await until(() => (gateway.connects.at(-1) as ConnectParams).scopes.length === 6);
    client.stop();
  });

  it("a full pairing's token asks for read alone on a host without secure storage", async () => {
    const gateway = grantingGateway();
    const record = JSON.stringify({
      token: "device-token",
      grantedScopes: FULL_SCOPES,
      heldScopes: FULL_SCOPES,
      fullGrant: true,
    });
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL, token: null }),
      [tokenKey(URL)]: record,
    });
    const { client } = fullClient(gateway, { storage, secure: async () => false });
    await client.start();
    await until(() => client.state.connection.status === "connected");
    expect(connectAt(gateway, 0).scopes).toEqual([...READ_SCOPES]);
    expect(stored(storage)?.heldScopes).toEqual([...FULL_SCOPES]);
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
