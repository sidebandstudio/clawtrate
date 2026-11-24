// A write from a screen read on one gateway never reaches another, even when both report the
// same identity (one restored from a copy of the other): every guarded write carries back the
// stamp of the read it was built on (`GatewayStamp`), the gateway's identity and the host's
// target, and the host sends nothing once its target moved on. A reconnect to the same target
// keeps it. Two test gateways at two addresses, with made-up bots and files.

import { describe, expect, it } from "vitest";
import { createBridgeSession, parseBridgeCommand } from "../src/bridge.ts";
import { ClawtrateClient, CONNECTION_CHANGED } from "../src/client.ts";
import { pictureWithChoice } from "../src/avatar.ts";
import { ADMIN_SCOPES, FULL_SCOPES, READ_SCOPES } from "../src/scopes.ts";
import { gatewayStamp, type GatewayStamp } from "../src/types.ts";
import { AccountsGateway } from "./accounts-fake.ts";
import { FAST, URL_A, URL_B } from "./client-harness.ts";
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

const PICTURE = pictureWithChoice(
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC",
  { family: "shellfolk", shell: "turret", color: "pink" },
)!;
const NEW_BOT = {
  name: "Viral",
  avatar: null,
  account: "acme:home",
  provider: "acme",
  model: "dev-1",
  effort: null,
} as const;
/** What a write sends to a gateway: none of these may reach the one the screen wasn't read on. */
const WRITES = ["agents.update", "agents.create", "agents.files.set", "config.patch", "cron.add"];

/** A host paired with two gateways that both say they are "gateway-a", and connected to the first. */
async function twoGateways() {
  const a = new AccountsGateway();
  const b = new AccountsGateway();
  b.identity = a.identity;
  const record = JSON.stringify({
    token: "device-token",
    grantedScopes: ADMIN_SCOPES,
    heldScopes: ADMIN_SCOPES.filter((scope) => scope !== "operator.admin"),
    adminHeld: true,
  });
  const storage = memoryStorage({
    connection: JSON.stringify({ url: URL_A, token: null }),
    [tokenKey(URL_A)]: record,
    [tokenKey(URL_B)]: record,
  });
  const host = {
    ...testHost(a.gateway, storage),
    createWebSocket: (url: string) => (url === URL_B ? b : a).gateway.createWebSocket(url),
  };
  const client = new ClawtrateClient(host, FAST);
  await client.start();
  await until(() => ready(client, URL_A));
  await client.refreshAccounts();
  const sent = (fake: AccountsGateway) =>
    fake.gateway.requests.filter((request) => WRITES.includes(request.method));
  return {
    client,
    host,
    a,
    b,
    sent,
    /** The person switches the host to the other gateway's address. */
    switchToB: async () => {
      await client.connect({ url: URL_B });
      await until(() => ready(client, URL_B));
    },
  };
}

const ready = (client: ClawtrateClient, url: string) =>
  client.state.connection.status === "connected" &&
  client.state.connection.gatewayUrl === url &&
  client.state.connection.gatewayId === "gateway-a" &&
  client.state.discovery.status === "ready";

describe("a write from a stale screen", () => {
  it("a bot picture and a Create read on one gateway reach neither gateway after a switch to another with the same id", async () => {
    const { client, a, b, sent, switchToB } = await twoGateways();
    const stamp = gatewayStamp(client.state.connection);
    await switchToB();
    // The same identity: only the host's target tells the two apart.
    expect(client.state.connection.gatewayId).toBe(stamp.gatewayId);
    expect(client.state.connection.target).not.toBe(stamp.target);
    const viewer = createBridgeSession(client);
    await expect(
      viewer.apply({ type: "setBotPicture", botId: "otto", avatar: PICTURE, stamp }),
    ).rejects.toThrow(CONNECTION_CHANGED);
    await expect(viewer.apply({ type: "createBot", ...NEW_BOT, stamp })).rejects.toThrow(
      CONNECTION_CHANGED,
    );
    await expect(viewer.apply({ type: "finishBot", botId: "viral", stamp })).rejects.toThrow(
      CONNECTION_CHANGED,
    );
    expect(sent(a)).toEqual([]);
    expect(sent(b)).toEqual([]);
    // Read again on the gateway connected now, the same picture goes.
    expect(
      await viewer.apply({
        type: "setBotPicture",
        botId: "otto",
        avatar: PICTURE,
        stamp: gatewayStamp(client.state.connection),
      }),
    ).toEqual({ confirmed: true });
    expect(sent(b).map((request) => request.method)).toEqual(["agents.update"]);
    client.stop();
  });

  it("a check-in, a routine and a memory edit read on one gateway are not sent after the switch", async () => {
    const { client, a, b, sent, switchToB } = await twoGateways();
    const stamp = gatewayStamp(client.state.connection);
    await switchToB();
    const viewer = createBridgeSession(client);
    await expect(
      viewer.apply({
        type: "saveCheckIn",
        saveId: "save-1",
        botId: "otto",
        stamp,
        every: "24h",
        prompt: null,
        was: { every: null, prompt: null },
        kept: [],
      }),
    ).rejects.toThrow(CONNECTION_CHANGED);
    expect(
      await viewer.apply({
        type: "createRoutine",
        input: {
          botId: "otto",
          name: "Water the plants",
          text: "Water them",
          schedule: {
            kind: "every",
            expr: null,
            tz: null,
            everyMs: 3_600_000,
            anchorMs: null,
            staggerMs: null,
            at: null,
            name: null,
          },
          target: "isolated",
          delivery: "none",
        },
        key: "draft-1",
        stamp,
      }),
    ).toEqual({ status: "not-sent", reason: "changed" });
    await expect(
      viewer.apply({
        type: "writeMemory",
        botId: "otto",
        path: "MEMORY.md",
        stamp,
        expectedHash: null,
        content: "Water the plants on Sundays.",
      }),
    ).rejects.toThrow(CONNECTION_CHANGED);
    expect(sent(a)).toEqual([]);
    expect(sent(b)).toEqual([]);
    client.stop();
  });

  it("a Create under way when the host switches sends nothing more to the other gateway", async () => {
    const { client, a, b, sent, switchToB } = await twoGateways();
    const answer = deferred<unknown>();
    const create = a.gateway.handlers["agents.create"]!;
    a.gateway.handlers["agents.create"] = async (params) => {
      await answer.promise;
      return create(params);
    };
    const pending = client.createBot(NEW_BOT, gatewayStamp(client.state.connection)).then(
      () => "created",
      (error: Error) => error.message,
    );
    await until(() => a.gateway.calls("agents.create").length === 1);
    await switchToB();
    answer.resolve(null);
    expect(await pending).not.toBe("created");
    expect(sent(b)).toEqual([]);
    client.stop();
  });
});

describe("a bot write that spans the change", () => {
  /** A Create whose bot is made on the first gateway, its next step held there. */
  const heldCreate = async (client: ClawtrateClient, a: AccountsGateway) => {
    const step = deferred<unknown>();
    const files = a.gateway.handlers["agents.files.set"]!;
    a.gateway.handlers["agents.files.set"] = async (params) => {
      await step.promise;
      return files(params);
    };
    const pending = client.createBot(NEW_BOT, gatewayStamp(client.state.connection)).then(
      (made) => made,
      (error: Error) => error.message,
    );
    await until(() => a.gateway.calls("agents.files.set").length === 1);
    return { release: () => step.resolve(null), pending };
  };

  it("a Create cut off by the switch is never continued or finished on the other gateway", async () => {
    const { client, a, b, sent, switchToB } = await twoGateways();
    const create = await heldCreate(client, a);
    await switchToB();
    create.release();
    await create.pending;
    // Finishing it, as the host does for the Create it remembers, is refused too.
    await expect(client.finishBot("viral")).rejects.toThrow();
    expect(sent(b)).toEqual([]);
    client.stop();
  });

  it("a Create cut off by a new Connect to the same address sends nothing more there", async () => {
    const { client, a, sent } = await twoGateways();
    const create = await heldCreate(client, a);
    const before = sent(a).length;
    // The person connects again, at the same address: what answers there may not be what was.
    await client.connect({ url: URL_A });
    await until(() => ready(client, URL_A));
    create.release();
    await create.pending;
    expect(sent(a).slice(before)).toEqual([]);
    client.stop();
  });
});

describe("the host's target", () => {
  const picture = (client: ClawtrateClient, stamp: GatewayStamp) =>
    createBridgeSession(client).apply({
      type: "setBotPicture",
      botId: "otto",
      avatar: PICTURE,
      stamp,
    });

  it("is kept across a dropped connection and its reconnect to the same gateway: the screen's write goes", async () => {
    const { client, a } = await twoGateways();
    const stamp = gatewayStamp(client.state.connection);
    const was = client.state.connection.connectedAt;
    a.gateway.dropAll();
    await until(() => ready(client, URL_A) && client.state.connection.connectedAt !== was);
    expect(client.state.connection.target).toBe(stamp.target);
    expect(await picture(client, stamp)).toEqual({ confirmed: true });
    expect(a.gateway.calls("agents.update")).toHaveLength(1);
    client.stop();
  });

  it("moves on with a Disconnect then a Connect to the same address: the screen read before is refused", async () => {
    const { client, a } = await twoGateways();
    const stamp = gatewayStamp(client.state.connection);
    await client.disconnect();
    expect(client.state.connection.target).toBeGreaterThan(stamp.target);
    await client.connect({ url: URL_A });
    await until(() => ready(client, URL_A));
    await expect(picture(client, stamp)).rejects.toThrow(CONNECTION_CHANGED);
    expect(a.gateway.calls("agents.update")).toEqual([]);
    // Read again, it goes.
    expect(await picture(client, gatewayStamp(client.state.connection))).toEqual({
      confirmed: true,
    });
    client.stop();
  });

  it("moves on with the Disconnect that keeps the gateway, then Reconnect", async () => {
    const { client, a, sent } = await twoGateways();
    const stamp = gatewayStamp(client.state.connection);
    await client.suspend();
    await client.retryNow();
    await until(() => ready(client, URL_A));
    expect(client.state.connection.target).toBeGreaterThan(stamp.target);
    await expect(client.setBotPicture("otto", PICTURE, stamp)).rejects.toThrow(CONNECTION_CHANGED);
    expect(sent(a)).toEqual([]);
    client.stop();
  });

  it("a restarted host never hands out a number a page kept from the last one", async () => {
    const { client: first, a, b, sent, host } = await twoGateways();
    await first.connect({ url: URL_A });
    await until(() => ready(first, URL_A));
    const stamp = gatewayStamp(first.state.connection);
    first.stop();
    // The same storage and gateways, as the web host has them after a restart; its pages stay.
    const second = new ClawtrateClient(host, FAST);
    await second.start();
    await until(() => ready(second, URL_A));
    await second.connect({ url: URL_B });
    await until(() => ready(second, URL_B));
    await expect(second.setBotPicture("otto", PICTURE, stamp)).rejects.toThrow(CONNECTION_CHANGED);
    expect(sent(a)).toEqual([]);
    expect(sent(b)).toEqual([]);
    second.stop();
  });

  it("a Connect whose new target makes a subscriber stop the client opens nothing more", async () => {
    const { client, b } = await twoGateways();
    const was = client.state.connection.target;
    // A host that stops the client as soon as it is told of the new target.
    let stopped = false;
    const unsubscribe = client.store.subscribe((state) => {
      if (stopped || state.connection.target === was) return;
      stopped = true;
      client.stop();
    });
    await client.connect({ url: URL_B });
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    unsubscribe();
    expect(b.gateway.connects).toEqual([]);
  });

  it("never comes back to a number an earlier screen holds", async () => {
    const { client, switchToB } = await twoGateways();
    const seen = [client.state.connection.target];
    await switchToB();
    seen.push(client.state.connection.target);
    await client.connect({ url: URL_A });
    await until(() => ready(client, URL_A));
    seen.push(client.state.connection.target);
    expect(new Set(seen).size).toBe(3);
    expect([...seen].sort((x, y) => x - y)).toEqual(seen);
    client.stop();
  });
});

// The one-time offer of full control (setup-effortless.md §6, F-549) is bound by the same stamp.
describe("the offer of full control on a stale screen", () => {
  const WSS_A = "wss://gateway-a.example:19993";
  const WSS_B = "wss://gateway-b.example:19994";
  const READ = JSON.stringify({
    token: "device-token",
    grantedScopes: READ_SCOPES,
    heldScopes: READ_SCOPES,
  });

  /** A gateway that grants what is asked, names itself "gateway-a", and holds each upgrade. */
  function offering() {
    const gateway = new FakeGateway();
    gateway.connectReply = (params) => {
      const { scopes, auth } = params as { scopes: string[]; auth?: { deviceToken?: string } };
      return { ok: true, payload: helloOk([...scopes], auth?.deviceToken) };
    };
    gateway.handlers["gateway.identity.get"] = () => ({ deviceId: "gateway-a" });
    const decision = deferred<unknown>();
    gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-1" });
    gateway.handlers["device.scopes.waitUpgrade"] = () => decision.promise;
    return {
      gateway,
      decide: (result: object) => decision.resolve({ requestId: "up-1", ...result }),
    };
  }

  /** A host paired read-only with both, at protected addresses, connected to the first. */
  async function pairedWithBoth() {
    const a = offering();
    const b = offering();
    const storage = memoryStorage({
      connection: JSON.stringify({ url: WSS_A, token: null }),
      [tokenKey(WSS_A)]: READ,
      [tokenKey(WSS_B)]: READ,
    });
    const host = {
      ...testHost(a.gateway, storage),
      createWebSocket: (url: string) => (url === WSS_B ? b : a).gateway.createWebSocket(url),
      secureCredentials: async () => true,
    };
    const client = new ClawtrateClient(host, { ...FAST, fullAccess: true });
    await client.start();
    const offered = (url: string) =>
      client.state.connection.status === "connected" &&
      client.state.connection.gatewayUrl === url &&
      client.state.connection.gatewayId === "gateway-a" &&
      client.state.connection.fullOffer === "offer";
    await until(() => offered(WSS_A));
    return { client, a, b, offered };
  }

  it("F-549: an offer shown on one gateway sends no request after a switch to another at another address with the same id", async () => {
    const { client, a, b, offered } = await pairedWithBoth();
    // What the dialog took when it opened on A.
    const stamp = gatewayStamp(client.state.connection);
    await client.connect({ url: WSS_B });
    await until(() => offered(WSS_B));
    expect(client.state.connection.gatewayId).toBe(stamp.gatewayId);
    expect(client.state.connection.target).not.toBe(stamp.target);
    // The stale dialog accepts, and dismisses, with the address now shown: nothing goes.
    const viewer = createBridgeSession(client);
    const stale = { gatewayUrl: WSS_B, deviceId: "device-1", stamp };
    await expect(viewer.apply({ type: "requestFullControl", ...stale })).rejects.toThrow(
      CONNECTION_CHANGED,
    );
    await viewer.apply({ type: "dismissFullControl", ...stale });
    await sleep(50);
    expect(a.gateway.calls("device.scopes.requestUpgrade")).toEqual([]);
    expect(b.gateway.calls("device.scopes.requestUpgrade")).toEqual([]);
    expect(client.state.connection.fullOffer).toBe("offer");
    client.stop();
  });

  it("F-549: an accept or a dismissal from a renderer keeps its stamp, and one without a stamp is refused", () => {
    const stamp = { gatewayId: "gateway-a", target: 4 };
    for (const type of ["requestFullControl", "dismissFullControl"] as const) {
      const command = { type, gatewayUrl: WSS_A, deviceId: "device-1", stamp };
      expect(parseBridgeCommand(command)).toEqual(command);
      expect(() => parseBridgeCommand({ type, gatewayUrl: WSS_A, deviceId: "device-1" })).toThrow();
    }
  });

  it("F-549: the reconnect that brings the offer's grant keeps the target, so its own answer is taken", async () => {
    const { client, a } = await pairedWithBoth();
    const stamp = gatewayStamp(client.state.connection);
    const viewer = createBridgeSession(client);
    await viewer.apply({
      type: "requestFullControl",
      gatewayUrl: WSS_A,
      deviceId: "device-1",
      stamp,
    });
    await until(() => client.state.connection.upgrade.status === "pending");
    expect(a.gateway.calls("device.scopes.requestUpgrade")).toEqual([{ scopes: [...FULL_SCOPES] }]);
    const connects = a.gateway.connects.length;
    a.decide({ status: "approved", deviceToken: "token-F", scopes: [...FULL_SCOPES] });
    await until(() => client.state.connection.fullPairing);
    // A reconnect, not a new target: what was read before the grant still names this gateway.
    expect(a.gateway.connects.length).toBeGreaterThan(connects);
    expect(client.state.connection.target).toBe(stamp.target);
    expect(client.state.connection.scopes).toEqual([...FULL_SCOPES]);
    client.stop();
  });
});
