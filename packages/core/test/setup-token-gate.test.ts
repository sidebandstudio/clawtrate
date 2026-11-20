// The setup connection (docs/design/setup.md §7, §19 "What the engine
// supplies"): the host's one-time code is sent once, kept in memory only, and
// the first device token is written only when the gateway granted the
// operator role and exactly `operator.read`.

import { describe, expect, it } from "vitest";
import {
  ClawtrateClient,
  SETUP_ENDPOINT_CHANGED,
  SETUP_GRANT_REFUSED,
  setupGrant,
} from "../src/client.ts";
import { PROTOCOL_VERSION } from "@openclaw/gateway-protocol";
import {
  FakeGateway,
  gatedStorage,
  helloOk,
  memoryStorage,
  sleep,
  testHost,
  tokenKey,
  until,
} from "./fake-gateway.ts";

const URL = "ws://127.0.0.1:19940";
const CODE = "setup-bootstrap-0123456789abcdefghijklmnopqrstuvw";
const FAST = { reconnect: { initialMs: 20, maxMs: 40 } };
const LATER = () => Date.now() + 600_000;

type ConnectParams = {
  scopes: string[];
  role: string;
  auth?: { bootstrapToken?: string; token?: string; deviceToken?: string };
};

/** A gateway that answers the setup connect with the given auth block. */
function gatewayGranting(auth: Record<string, unknown>) {
  const gateway = new FakeGateway();
  gateway.connectReply = (params) => {
    const { auth: sent } = params as ConnectParams;
    if (sent?.deviceToken === "device-token")
      return { ok: true, payload: helloOk(["operator.read"], "device-token") };
    return { ok: true, payload: { ...helloOk(), auth } };
  };
  return gateway;
}

/** Every value the client wrote to storage, and its state, as one string. */
function everywhere(client: ClawtrateClient, storage: { data: Map<string, string> }): string {
  return JSON.stringify([...storage.data.entries()]) + JSON.stringify(client.state);
}

describe("the setup connection's token gate", () => {
  it("F-492 F-494: the host's code is sent once asking for read alone, the read token is written, and the code is in no storage or state", async () => {
    const gateway = gatewayGranting({
      role: "operator",
      scopes: ["operator.read"],
      deviceToken: "device-token",
    });
    const storage = memoryStorage();
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await client.connectWithSetupCode({ url: URL, bootstrapToken: CODE, expiresAtMs: LATER() });
    await until(() => client.state.connection.status === "connected");

    const sent = gateway.connects[0] as ConnectParams;
    expect(sent.auth?.bootstrapToken).toBe(CODE);
    expect(sent.auth?.token).toBeUndefined();
    expect(sent.role).toBe("operator");
    expect(sent.scopes).toEqual(["operator.read"]);
    expect(JSON.parse(storage.data.get(tokenKey(URL))!)).toMatchObject({
      token: "device-token",
      heldScopes: ["operator.read"],
    });
    expect(JSON.parse(storage.data.get("connection")!)).toEqual({ url: URL, token: null });
    expect(everywhere(client, storage)).not.toContain(CODE);

    // A reconnect uses the device token; the code is never sent again.
    gateway.dropAll();
    await until(() => gateway.connects.length === 2);
    await until(() => client.state.connection.status === "connected");
    expect((gateway.connects[1] as ConnectParams).auth).toEqual({ deviceToken: "device-token" });
    client.stop();
  });

  const refused: Array<[string, Record<string, unknown>]> = [
    ["extra scopes", { role: "operator", scopes: ["operator.read", "operator.write"] }],
    ["no scopes", { role: "operator", scopes: [] }],
    ["another role", { role: "node", scopes: ["operator.read"] }],
    ["talk beside read", { role: "operator", scopes: ["operator.read", "operator.talk"] }],
  ];
  for (const [name, auth] of refused) {
    it(`F-492: a grant with ${name} writes nothing, saves no gateway and disconnects`, async () => {
      const gateway = gatewayGranting({ ...auth, deviceToken: "granted-token" });
      const storage = memoryStorage();
      const client = new ClawtrateClient(testHost(gateway, storage), FAST);
      await client.start();
      await client.connectWithSetupCode({ url: URL, bootstrapToken: CODE, expiresAtMs: LATER() });
      await until(() => client.state.connection.status === "error");

      expect(client.state.connection.error?.code).toBe(SETUP_GRANT_REFUSED);
      expect(client.state.connection.error?.message).toBe(
        "The gateway granted something other than read access, so Clawtrate disconnected.",
      );
      expect([...storage.data.keys()].filter((key) => key.startsWith("deviceToken:"))).toEqual([]);
      expect(storage.data.has("connection")).toBe(false);
      expect(everywhere(client, storage)).not.toContain("granted-token");
      expect(everywhere(client, storage)).not.toContain(CODE);
      // Nothing reconnects by itself, and nothing sends the code again.
      await sleep(200);
      expect(gateway.connects).toHaveLength(1);
      client.stop();
    });
  }

  it("F-492: a connection cancelled before its grant is checked writes nothing", async () => {
    const gateway = gatewayGranting({
      role: "operator",
      scopes: ["operator.read"],
      deviceToken: "device-token",
    });
    const storage = gatedStorage();
    const replied = gateway.connectReply;
    // The lifecycle reads the stored token before it stores the new one: hold that read.
    gateway.connectReply = (params, url) => {
      storage.hold(tokenKey(URL));
      return replied(params, url);
    };
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await client.connectWithSetupCode({ url: URL, bootstrapToken: CODE, expiresAtMs: LATER() });
    await until(() => storage.waiting(tokenKey(URL)) > 0);
    await client.disconnect();
    storage.release(tokenKey(URL));
    await sleep(100);

    expect(storage.data.has(tokenKey(URL))).toBe(false);
    expect(storage.data.has("connection")).toBe(false);
    expect(client.state.connection.status).toBe("idle");
    client.stop();
  });

  it("F-492 F-494: a refused code ends in its own error, is forgotten and is not sent again", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "unauthorized: setup code invalid, expired, revoked, or already used",
        details: { code: "AUTH_BOOTSTRAP_TOKEN_INVALID", canRetryWithDeviceToken: false },
      },
    });
    const storage = memoryStorage();
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await client.connectWithSetupCode({ url: URL, bootstrapToken: CODE, expiresAtMs: LATER() });
    await until(() => client.state.connection.status === "error");
    expect(client.state.connection.error?.code).toBe("AUTH_BOOTSTRAP_TOKEN_INVALID");
    await sleep(200);
    expect(gateway.connects).toHaveLength(1);
    // A retry has no code left to send.
    await client.retryNow();
    await until(() => gateway.connects.length === 2);
    expect((gateway.connects[1] as ConnectParams).auth?.bootstrapToken).toBeUndefined();
    expect(everywhere(client, storage)).not.toContain(CODE);
    client.stop();
  });

  it("F-492: nothing answering on the port ends in its own error without retrying", async () => {
    const gateway = new FakeGateway();
    gateway.refuseConnections = true;
    const client = new ClawtrateClient(testHost(gateway, memoryStorage()), FAST);
    await client.start();
    await client.connectWithSetupCode({ url: URL, bootstrapToken: CODE, expiresAtMs: LATER() });
    await until(() => client.state.connection.status === "error");
    expect(client.state.connection.error?.code).toBe("UNREACHABLE");
    const attempts = gateway.sockets.length;
    await sleep(200);
    expect(gateway.sockets).toHaveLength(attempts);
    client.stop();
  });

  it("F-492: a gateway that asks before every device ends on the pairing screen, and approval then writes the read token", async () => {
    const gateway = new FakeGateway();
    let approved = false;
    gateway.connectReply = (params) => {
      const { auth } = params as ConnectParams;
      if (!approved)
        return {
          ok: false,
          error: {
            code: "NOT_PAIRED",
            message: "device pairing required",
            details: {
              code: "PAIRING_REQUIRED",
              requestId: "e5eb4aa8-175f-40f1-bc7a-8f15cfc40942",
              deviceId: "device-1",
              requestedScopes: ["operator.read"],
            },
          },
        };
      expect(auth?.bootstrapToken).toBe(CODE);
      return { ok: true, payload: helloOk(["operator.read"], "device-token") };
    };
    const storage = memoryStorage();
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await client.connectWithSetupCode({ url: URL, bootstrapToken: CODE, expiresAtMs: LATER() });
    await until(() => client.state.connection.status === "pairing");
    expect(client.state.connection.pairing?.requestId).toBe("e5eb4aa8-175f-40f1-bc7a-8f15cfc40942");
    expect(storage.data.has(tokenKey(URL))).toBe(false);
    approved = true;
    await client.retryNow();
    await until(() => client.state.connection.status === "connected");
    expect(JSON.parse(storage.data.get(tokenKey(URL))!).heldScopes).toEqual(["operator.read"]);
    expect(everywhere(client, storage)).not.toContain(CODE);
    client.stop();
  });

  it("F-494: an expired code is never sent", async () => {
    const gateway = gatewayGranting({ role: "operator", scopes: ["operator.read"] });
    const client = new ClawtrateClient(testHost(gateway, memoryStorage()), FAST);
    await client.start();
    await client.connectWithSetupCode({
      url: URL,
      bootstrapToken: CODE,
      expiresAtMs: Date.now() - 1,
    });
    await until(() => gateway.connects.length === 1);
    expect((gateway.connects[0] as ConnectParams).auth?.bootstrapToken).toBeUndefined();
    client.stop();
  });

  it("F-492: the grant check accepts the operator role with exactly read, on this protocol, and nothing else", () => {
    const hello = (auth: Record<string, unknown>, protocol: number = PROTOCOL_VERSION) =>
      ({ protocol, auth }) as Parameters<typeof setupGrant>[0];
    expect(setupGrant(hello({ role: "operator", scopes: ["operator.read"] }))).toBe("read");
    expect(setupGrant(hello({ role: "operator", scopes: ["operator.read"] }, 3))).toBe("other");
    expect(setupGrant(hello({ role: "operator", scopes: ["operator.write"] }))).toBe("other");
    expect(setupGrant(hello({ role: "operator", scopes: ["operator.admin"] }))).toBe("other");
    expect(setupGrant(hello({ role: "operator" }))).toBe("other");
    expect(setupGrant(hello({ scopes: ["operator.read"] }))).toBe("other");
    expect(setupGrant(hello({ role: "node", scopes: ["operator.read"] }))).toBe("other");
  });
});

/** A client whose every published state and log line is kept, as text. */
function recorded(gateway: FakeGateway, storage = memoryStorage()) {
  const logs: string[] = [];
  const host = {
    ...testHost(gateway, storage),
    log: (_level: string, line: string) => void logs.push(line),
  };
  const client = new ClawtrateClient(host, FAST);
  const snapshots: string[] = [];
  client.store.subscribe((state) => snapshots.push(JSON.stringify(state)));
  return { client, storage, everything: () => [...snapshots, ...logs].join("\n") };
}

describe("what a setup connection publishes, whatever the gateway sends", () => {
  it("F-494: a refusal that echoes the code puts it in no state, snapshot or log line", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: `unauthorized: setup code ${CODE} invalid`,
        details: { code: "AUTH_BOOTSTRAP_TOKEN_INVALID", remediationHint: `retry without ${CODE}` },
      },
    });
    const { client, everything } = recorded(gateway);
    await client.start();
    await client.connectWithSetupCode({ url: URL, bootstrapToken: CODE, expiresAtMs: LATER() });
    await until(() => client.state.connection.status === "error");
    expect(client.state.connection.error).toMatchObject({
      code: "AUTH_BOOTSTRAP_TOKEN_INVALID",
      message: "The one-time code didn't work.",
      hint: null,
    });
    expect(everything()).not.toContain(CODE);
    client.stop();
  });

  it("F-494: a pairing that echoes the code in its request, hint and scopes keeps it out of state", async () => {
    const gateway = new FakeGateway();
    gateway.connectReply = () => ({
      ok: false,
      error: {
        code: "NOT_PAIRED",
        message: `pairing required for ${CODE}`,
        details: {
          code: "PAIRING_REQUIRED",
          requestId: CODE,
          deviceId: `device-${CODE}`,
          remediationHint: `approve ${CODE}`,
          requestedScopes: ["operator.read", CODE],
        },
      },
    });
    const { client, everything } = recorded(gateway);
    await client.start();
    await client.connectWithSetupCode({ url: URL, bootstrapToken: CODE, expiresAtMs: LATER() });
    await until(() => client.state.connection.status === "pairing");
    expect(everything()).not.toContain(CODE);
    client.stop();
  });

  it("F-492: a reconnect right after a read-only first pairing uses and stores read only, whatever is granted", async () => {
    const gateway = new FakeGateway();
    let connects = 0;
    gateway.connectReply = () =>
      (connects += 1) === 1
        ? { ok: true, payload: helloOk(["operator.read"], "device-token") }
        : { ok: true, payload: helloOk(["operator.read", "operator.write"], "wider-token") };
    const storage = memoryStorage();
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await client.connectWithSetupCode({ url: URL, bootstrapToken: CODE, expiresAtMs: LATER() });
    await until(() => client.state.connection.status === "connected");
    gateway.dropAll();
    await until(() => connects === 2 && client.state.connection.status === "connected");
    expect(client.state.connection.scopes).toEqual(["operator.read"]);
    expect(client.state.connection.canWrite).toBe(false);
    expect(JSON.parse(storage.data.get(tokenKey(URL))!)).toMatchObject({
      token: "wider-token",
      grantedScopes: ["operator.read"],
      heldScopes: ["operator.read"],
    });
    client.stop();
  });

  it("F-515: a setup hello on another protocol writes nothing and ends on the protocol notice", async () => {
    const gateway = gatewayGranting({
      role: "operator",
      scopes: ["operator.read"],
      deviceToken: "device-token",
    });
    const replied = gateway.connectReply;
    gateway.connectReply = (params, url) => {
      const reply = replied(params, url);
      return reply.ok
        ? { ok: true, payload: { ...(reply.payload as object), protocol: 3 } }
        : reply;
    };
    const storage = memoryStorage();
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await client.connectWithSetupCode({ url: URL, bootstrapToken: CODE, expiresAtMs: LATER() });
    await until(() => client.state.connection.status === "error");
    expect(client.state.connection.error?.code).toBe("PROTOCOL_MISMATCH");
    expect(storage.data.has(tokenKey(URL))).toBe(false);
    client.stop();
  });

  it("F-492: says what this device can already do on a gateway", async () => {
    const storage = memoryStorage({
      [tokenKey("ws://127.0.0.1:19960")]: JSON.stringify({
        token: "t",
        grantedScopes: ["operator.read"],
        heldScopes: ["operator.read", "operator.write"],
      }),
      [tokenKey(URL)]: JSON.stringify({
        token: "t",
        grantedScopes: ["operator.read"],
        heldScopes: ["operator.read"],
      }),
    });
    const client = new ClawtrateClient(testHost(new FakeGateway(), storage), FAST);
    expect(await client.deviceAccess(URL)).toBe("read");
    expect(await client.deviceAccess("ws://127.0.0.1:19960")).toBe("more");
    expect(await client.deviceAccess("ws://127.0.0.1:19980")).toBe("new");
  });
});

describe("the setup connection's endpoint check", () => {
  it("F-492: a setup connection opens no socket when the host's check of its listener fails, and sends no code", async () => {
    const gateway = gatewayGranting({
      role: "operator",
      scopes: ["operator.read"],
      deviceToken: "device-token",
    });
    const storage = memoryStorage();
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await client.connectWithSetupCode(
      { url: URL, bootstrapToken: CODE, expiresAtMs: LATER() },
      { check: () => false },
    );
    await until(() => client.state.connection.status === "error");
    expect(client.state.connection.error?.code).toBe(SETUP_ENDPOINT_CHANGED);
    expect(gateway.sockets).toHaveLength(0);
    expect(storage.data.has(tokenKey(URL))).toBe(false);
    expect(everywhere(client, storage)).not.toContain(CODE);
    client.stop();
  });

  it("F-492: while a pairing waits, a retry after the listener changed opens no second socket", async () => {
    const gateway = new FakeGateway();
    let approved = false;
    gateway.connectReply = () =>
      approved
        ? { ok: true, payload: helloOk(["operator.read"], "device-token") }
        : {
            ok: false,
            error: {
              code: "NOT_PAIRED",
              message: "device pairing required",
              details: {
                code: "PAIRING_REQUIRED",
                requestId: "e5eb4aa8-175f-40f1-bc7a-8f15cfc40942",
              },
            },
          };
    let same = true;
    const storage = memoryStorage();
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await client.connectWithSetupCode(
      { url: URL, bootstrapToken: CODE, expiresAtMs: LATER() },
      { check: () => same },
    );
    await until(() => client.state.connection.status === "pairing");
    expect(gateway.sockets).toHaveLength(1);
    same = false;
    approved = true;
    await client.retryNow();
    await until(() => client.state.connection.error?.code === SETUP_ENDPOINT_CHANGED);
    expect(gateway.sockets).toHaveLength(1);
    expect(storage.data.has(tokenKey(URL))).toBe(false);
    client.stop();
  });
});
