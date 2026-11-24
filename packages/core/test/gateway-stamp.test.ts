// A write from a screen read on one gateway never reaches another, even when both report the
// same identity (one restored from a copy of the other): every guarded write carries back the
// stamp of the read it was built on (`GatewayStamp`), the gateway's identity and the host's
// target, and the host sends nothing once its target moved on. A reconnect to the same target
// keeps it. Two test gateways at two addresses, with made-up bots and files.

import { describe, expect, it, vi } from "vitest";
import { createBridgeSession, parseBridgeCommand } from "../src/bridge.ts";
import {
  ClawtrateClient,
  CONNECTION_CHANGED,
  CONNECTION_CHANGED_AFTER_SEND,
} from "../src/client.ts";
import type { AccountsEngine } from "../src/accounts-engine.ts";
import { pictureWithChoice } from "../src/avatar.ts";
import { ADMIN_SCOPES, FULL_SCOPES, READ_SCOPES } from "../src/scopes.ts";
import { gatewayStamp, type GatewayStamp } from "../src/types.ts";
import { screenStamp, shownStamp } from "../../ui/src/stamp.ts";
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

  it("a host started again at the same clock value, or an earlier one, starts at another number", () => {
    const targets: number[] = [];
    // Fixed draws, so the test can't fail by chance: the clock alone would give the first two the same.
    for (const [clock, draw] of [
      [1_800_000_000_000, 0.25],
      [1_800_000_000_000, 0.5],
      [1_700_000_000_000, 0.75],
    ] as const) {
      const now = vi.spyOn(Date, "now").mockReturnValue(clock);
      const random = vi.spyOn(Math, "random").mockReturnValue(draw);
      try {
        const host = testHost(new FakeGateway(), memoryStorage());
        targets.push((new ClawtrateClient(host, FAST) as unknown as { target: number }).target);
      } finally {
        now.mockRestore();
        random.mockRestore();
      }
    }
    expect(new Set(targets).size).toBe(3);
    for (const target of targets) {
      expect(Number.isSafeInteger(target) && target > 0).toBe(true);
    }
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

// #450: the writes that act on an id a restored copy shares, each read on one gateway and sent
// after a switch to the other, then sent with no switch and after a plain reconnect.
describe("a removal, a task, a bot's model and account, a routine's switch from a stale screen", () => {
  /** What a stale removal or task action could send: none may reach either gateway after the switch. */
  const sentOf = (fake: AccountsGateway, methods: string[]) =>
    fake.gateway.requests.filter((request) => methods.includes(request.method));

  /** Both gateways have one machine "node-1" and one other device "phone-1", as a copy would. */
  const machines = (fake: AccountsGateway) => {
    let nodes = [{ nodeId: "node-1", displayName: "Studio", paired: true }];
    let paired = [{ deviceId: "phone-1", displayName: "Phone", role: "operator" }];
    fake.gateway.handlers["node.list"] = () => ({ nodes });
    fake.gateway.handlers["node.pair.remove"] = (params) => {
      nodes = nodes.filter((node) => node.nodeId !== (params as { nodeId: string }).nodeId);
      return { ok: true };
    };
    fake.gateway.handlers["device.pair.list"] = () => ({ paired });
    fake.gateway.handlers["device.pair.remove"] = (params) => {
      paired = paired.filter((row) => row.deviceId !== (params as { deviceId: string }).deviceId);
      return { ok: true };
    };
  };
  const UNPAIR = ["node.pair.remove", "device.pair.remove"];

  it("Machines: a node or device removal read on one gateway reaches neither after a switch to another with the same id", async () => {
    const { client, a, b, switchToB } = await twoGateways();
    machines(a);
    machines(b);
    const viewer = createBridgeSession(client);
    await viewer.apply({ type: "readMachines" });
    const stamp = gatewayStamp(client.state.connection);
    await switchToB();
    await expect(viewer.apply({ type: "removeMachine", nodeId: "node-1", stamp })).rejects.toThrow(
      CONNECTION_CHANGED,
    );
    await expect(
      viewer.apply({ type: "removeDevice", deviceId: "phone-1", stamp }),
    ).rejects.toThrow(CONNECTION_CHANGED);
    expect(sentOf(a, UNPAIR)).toEqual([]);
    expect(sentOf(b, UNPAIR)).toEqual([]);
    // Read again on the gateway connected now, the removal goes there.
    const fresh = gatewayStamp(client.state.connection);
    await viewer.apply({ type: "removeMachine", nodeId: "node-1", stamp: fresh });
    expect(b.gateway.calls("node.pair.remove")).toEqual([{ nodeId: "node-1" }]);
    client.stop();
  });

  it("Machines: a removal goes with no switch, and after a dropped connection's reconnect", async () => {
    const { client, a } = await twoGateways();
    machines(a);
    const viewer = createBridgeSession(client);
    const stamp = gatewayStamp(client.state.connection);
    await viewer.apply({ type: "removeDevice", deviceId: "phone-1", stamp });
    expect(a.gateway.calls("device.pair.remove")).toEqual([{ deviceId: "phone-1" }]);
    const was = client.state.connection.connectedAt;
    a.gateway.dropAll();
    await until(() => ready(client, URL_A) && client.state.connection.connectedAt !== was);
    await viewer.apply({ type: "removeMachine", nodeId: "node-1", stamp });
    expect(a.gateway.calls("node.pair.remove")).toEqual([{ nodeId: "node-1" }]);
    client.stop();
  });

  /** Both gateways have the task "agent:otto:logs", as a restored copy would. */
  const KEY = "agent:otto:logs";
  const tasks = (fake: AccountsGateway) => {
    fake.gateway.handlers["sessions.describe"] = () => ({
      session: { key: KEY, sessionId: "s-logs", status: "done", archived: false },
    });
    fake.gateway.handlers["sessions.patch"] = () => ({ ok: true });
    fake.gateway.handlers["sessions.delete"] = () => ({ ok: true });
  };
  const TASK_WRITES = ["sessions.patch", "sessions.delete"];

  it("Tasks: an archive or a delete listed on one gateway reaches neither after a switch to another with the same id", async () => {
    const { client, a, b, switchToB } = await twoGateways();
    tasks(a);
    tasks(b);
    const stamp = gatewayStamp(client.state.connection);
    await switchToB();
    const viewer = createBridgeSession(client);
    await expect(
      viewer.apply({ type: "archiveTask", key: KEY, stop: false, stamp }),
    ).rejects.toThrow(CONNECTION_CHANGED);
    await expect(viewer.apply({ type: "deleteTask", key: KEY, stamp })).rejects.toThrow(
      CONNECTION_CHANGED,
    );
    expect(sentOf(a, TASK_WRITES)).toEqual([]);
    expect(sentOf(b, TASK_WRITES)).toEqual([]);
    client.stop();
  });

  it("Tasks: an archive and a delete go with no switch, and after a dropped connection's reconnect", async () => {
    const { client, a } = await twoGateways();
    tasks(a);
    const viewer = createBridgeSession(client);
    const stamp = gatewayStamp(client.state.connection);
    await viewer.apply({ type: "archiveTask", key: KEY, stop: false, stamp });
    expect(a.gateway.calls("sessions.patch")).toHaveLength(1);
    const was = client.state.connection.connectedAt;
    a.gateway.dropAll();
    await until(() => ready(client, URL_A) && client.state.connection.connectedAt !== was);
    expect(client.state.connection.target).toBe(stamp.target);
    await viewer.apply({ type: "deleteTask", key: KEY, stamp });
    expect(a.gateway.calls("sessions.delete")).toHaveLength(1);
    client.stop();
  });

  const SETTING_WRITES = ["config.patch", "users.prefs.set"];
  const ACCOUNT = {
    type: "changeBotAccount",
    botId: "otto",
    account: "acme:home",
    provider: "acme",
    model: "dev-1",
    effort: null,
  } as const;
  const MODEL = { type: "setBotModel", botId: "otto", model: "dev-1", effort: "high" } as const;
  const FALLBACKS = { type: "removeBotFallbacks", botId: "otto" } as const;

  it("A bot's model and account: a change read on one gateway reaches neither after a switch to another with the same id", async () => {
    const { client, a, b, switchToB } = await twoGateways();
    const stamp = gatewayStamp(client.state.connection);
    await switchToB();
    await client.refreshAccounts();
    const viewer = createBridgeSession(client);
    for (const command of [ACCOUNT, MODEL, FALLBACKS])
      await expect(viewer.apply({ ...command, stamp })).rejects.toThrow(CONNECTION_CHANGED);
    expect(sentOf(a, SETTING_WRITES)).toEqual([]);
    expect(sentOf(b, SETTING_WRITES)).toEqual([]);
    // Read again on the gateway connected now, the change goes there.
    await viewer.apply({ ...ACCOUNT, stamp: gatewayStamp(client.state.connection) });
    expect(b.gateway.calls("config.patch")).toHaveLength(1);
    client.stop();
  });

  it("A bot's model and account: a change goes with no switch, and after a dropped connection's reconnect", async () => {
    const { client, a } = await twoGateways();
    const viewer = createBridgeSession(client);
    const stamp = gatewayStamp(client.state.connection);
    await viewer.apply({ ...ACCOUNT, stamp });
    expect(a.gateway.calls("config.patch")).toHaveLength(1);
    const was = client.state.connection.connectedAt;
    a.gateway.dropAll();
    await until(() => ready(client, URL_A) && client.state.connection.connectedAt !== was);
    await client.refreshAccounts();
    await viewer.apply({ ...MODEL, stamp });
    await viewer.apply({ ...FALLBACKS, stamp });
    expect(a.gateway.calls("config.patch")).toHaveLength(3);
    client.stop();
  });

  /** Both gateways have the routine "job-1", as a restored copy would. */
  const JOB = {
    id: "job-1",
    agentId: "otto",
    name: "Water the plants",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 2,
    schedule: { kind: "every", everyMs: 3_600_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Water them" },
    delivery: { mode: "none" },
    state: {},
  };
  const routines = (fake: AccountsGateway) => {
    fake.gateway.handlers["cron.status"] = () => ({ enabled: true });
    fake.gateway.handlers["cron.list"] = () => ({ jobs: [JOB], hasMore: false });
    fake.gateway.handlers["cron.update"] = (params) => ({
      ...JOB,
      ...(params as { patch: object }).patch,
    });
    fake.gateway.handlers["cron.run"] = () => ({ ok: true, enqueued: true, runId: "run-1" });
    fake.gateway.handlers["cron.remove"] = () => ({ removed: true });
  };
  const ROUTINE_WRITES = ["cron.update", "cron.run", "cron.remove"];
  /** A row's three actions, from the list `listedOn` read where `stamp` says. */
  const rowActions = (listedOn: number, stamp: GatewayStamp) =>
    [
      { type: "setRoutineEnabled", id: "job-1", enabled: false, listedOn, stamp },
      { type: "runRoutineNow", id: "job-1", listedOn, stamp },
      { type: "removeRoutine", id: "job-1", listedOn, stamp },
    ] as const;
  const listed = async (client: ClawtrateClient) => {
    const viewer = createBridgeSession(client);
    const was = client.state.routines.revision;
    await viewer.apply({ type: "refreshRoutines" });
    await until(
      () => client.state.routines.status === "loaded" && client.state.routines.revision !== was,
    );
    return viewer;
  };

  it("Routines: a row's switch, Run now and Delete read on one gateway reach neither after a switch to another with the same id", async () => {
    const { client, a, b, switchToB } = await twoGateways();
    routines(a);
    routines(b);
    await listed(client);
    const listedOn = client.state.routines.listedOn;
    const stamp = gatewayStamp(client.state.connection);
    await switchToB();
    const viewer = await listed(client);
    for (const command of rowActions(listedOn, stamp))
      expect(await viewer.apply(command)).toEqual({ status: "not-sent", reason: "changed" });
    expect(sentOf(a, ROUTINE_WRITES)).toEqual([]);
    expect(sentOf(b, ROUTINE_WRITES)).toEqual([]);
    client.stop();
  });

  it("Routines: a page kept across a restarted host is refused, though the new host's list has the same number", async () => {
    const { client: first, a, b, host } = await twoGateways();
    routines(a);
    routines(b);
    await listed(first);
    const stamp = gatewayStamp(first.state.connection);
    first.stop();
    const second = new ClawtrateClient(host, FAST);
    await second.start();
    await until(() => ready(second, URL_A));
    await second.connect({ url: URL_B });
    await until(() => ready(second, URL_B));
    const viewer = await listed(second);
    // The second host's list counter started again: the page's list can have the number of the
    // list read now, and the counter alone can't tell the two apart.
    for (const command of rowActions(second.state.routines.listedOn, stamp))
      expect(await viewer.apply(command)).toEqual({ status: "not-sent", reason: "changed" });
    expect(sentOf(a, ROUTINE_WRITES)).toEqual([]);
    expect(sentOf(b, ROUTINE_WRITES)).toEqual([]);
    second.stop();
  });

  it("Routines: a row's actions go with no switch, and after a dropped connection's reconnect", async () => {
    const { client, a } = await twoGateways();
    routines(a);
    let viewer = await listed(client);
    const stamp = gatewayStamp(client.state.connection);
    const [pause, run] = rowActions(client.state.routines.listedOn, stamp);
    expect(await viewer.apply(pause)).toMatchObject({ status: "saved" });
    expect(await viewer.apply(run)).toMatchObject({ status: "started" });
    const was = client.state.connection.connectedAt;
    a.gateway.dropAll();
    await until(() => ready(client, URL_A) && client.state.connection.connectedAt !== was);
    viewer = await listed(client);
    // The rows of the list read since, with the stamp kept across the reconnect.
    const [, , remove] = rowActions(client.state.routines.listedOn, stamp);
    expect(await viewer.apply(remove)).toEqual({ status: "removed" });
    expect(a.gateway.calls("cron.remove")).toEqual([{ id: "job-1" }]);
    client.stop();
  });

  // Another gateway at the same address, behind a plain reconnect: the target stays, so only the
  // identity tells them apart.
  /** A drops and comes back reporting another identity, on the same target. */
  const replacedBehindReconnect = async (client: ClawtrateClient, a: AccountsGateway) => {
    const target = client.state.connection.target;
    const was = client.state.connection.connectedAt;
    a.identity = "gateway-x";
    a.gateway.dropAll();
    await until(
      () =>
        client.state.connection.status === "connected" &&
        client.state.connection.connectedAt !== was &&
        client.state.connection.gatewayId === "gateway-x",
    );
    expect(client.state.connection.target).toBe(target);
  };
  const ACCOUNT_WRITES = ["models.authLogout", "models.authSetApiKey"];
  const DISCONNECT = { type: "disconnectAccount", profileId: "acme:home" } as const;
  const SAVE_KEY = {
    type: "saveApiKey",
    provider: "globex",
    key: "clawtrate-dev-key.globex.stale",
    botId: null,
  } as const;
  const EVERY_WRITE = [
    ...UNPAIR,
    ...TASK_WRITES,
    ...SETTING_WRITES,
    ...ROUTINE_WRITES,
    ...ACCOUNT_WRITES,
  ];

  it("Every group: a write read on one gateway is refused when another answers at the same address behind a plain reconnect", async () => {
    const { client, a } = await twoGateways();
    machines(a);
    tasks(a);
    const stamp = gatewayStamp(client.state.connection);
    await replacedBehindReconnect(client, a);
    const viewer = createBridgeSession(client);
    for (const command of [
      { type: "removeMachine", nodeId: "node-1", stamp },
      { type: "removeDevice", deviceId: "phone-1", stamp },
      { type: "archiveTask", key: KEY, stop: false, stamp },
      { type: "deleteTask", key: KEY, stamp },
      { ...ACCOUNT, stamp },
      { ...MODEL, stamp },
      { ...FALLBACKS, stamp },
      { ...DISCONNECT, stamp },
      { ...SAVE_KEY, stamp },
    ] as const)
      await expect(viewer.apply(command), command.type).rejects.toThrow(
        "This change was made for another gateway, so nothing was sent.",
      );
    expect(sentOf(a, EVERY_WRITE)).toEqual([]);
    client.stop();
  });

  it("Routines: a row read on one gateway is refused when another answers at the same address behind a plain reconnect", async () => {
    const { client, a } = await twoGateways();
    routines(a);
    await listed(client);
    const stamp = gatewayStamp(client.state.connection);
    await replacedBehindReconnect(client, a);
    const viewer = await listed(client);
    // The rows of the list read since: only the stamp's identity is stale.
    for (const command of rowActions(client.state.routines.listedOn, stamp))
      expect(await viewer.apply(command)).toEqual({ status: "not-sent", reason: "gateway" });
    expect(sentOf(a, ROUTINE_WRITES)).toEqual([]);
    client.stop();
  });

  it("Tasks: a Stop and archive under way when the host switches sends nothing more to the other gateway", async () => {
    const { client, a, b, switchToB } = await twoGateways();
    tasks(a);
    tasks(b);
    // On A the run keeps going, so the archive waits for it to stop; B has the same task, idle.
    a.gateway.handlers["sessions.describe"] = () => ({
      session: { key: KEY, sessionId: "s-logs", status: "running", archived: false },
    });
    a.gateway.handlers["chat.abort"] = () => ({ ok: true });
    const pending = createBridgeSession(client)
      .apply({
        type: "archiveTask",
        key: KEY,
        stop: true,
        stamp: gatewayStamp(client.state.connection),
      })
      .then(
        () => "archived",
        (error: Error) => error.message,
      );
    await until(() => a.gateway.calls("chat.abort").length === 1);
    await switchToB();
    expect(await pending).not.toBe("archived");
    expect(sentOf(a, TASK_WRITES)).toEqual([]);
    expect(sentOf(b, TASK_WRITES)).toEqual([]);
    client.stop();
  });

  // A dropped connection and its reconnect keep the target; another gateway can answer that
  // reconnect at the same address. A later step of a write never goes on the new connection.
  /** A, on `when`, drops and comes back as gateway-x at the same address. */
  const replaceOn = (a: AccountsGateway, method: string, when: () => boolean = () => true) => {
    const answer = a.gateway.handlers[method]!;
    let replaced = false;
    a.gateway.handlers[method] = async (params) => {
      const value = await answer(params);
      if (!replaced && when()) {
        replaced = true;
        a.identity = "gateway-x";
        setTimeout(() => a.gateway.dropAll(), 0);
      }
      return value;
    };
    return () => replaced;
  };

  for (const type of ["archiveTask", "deleteTask"] as const)
    it(`Tasks: a ${type === "archiveTask" ? "Stop and archive" : "delete of a working task"} whose connection drops mid-way, with another gateway answering at the same address, sends nothing more there`, async () => {
      const { client, a } = await twoGateways();
      tasks(a);
      a.gateway.handlers["sessions.describe"] = () => ({
        session: { key: KEY, sessionId: "s-logs", status: "running", archived: false },
      });
      a.gateway.handlers["chat.abort"] = () => ({ ok: true });
      const replaced = replaceOn(a, "chat.abort");
      const target = client.state.connection.target;
      const pending = createBridgeSession(client)
        .apply({
          type,
          key: KEY,
          ...(type === "archiveTask" ? { stop: true } : {}),
          stamp: gatewayStamp(client.state.connection),
        } as Parameters<ReturnType<typeof createBridgeSession>["apply"]>[0])
        .then(
          () => "done",
          (error: Error) => error.message,
        );
      await until(() => replaced() && client.state.connection.gatewayId === "gateway-x", 6_000);
      expect(client.state.connection.target).toBe(target);
      // The stop had gone: what became of the task isn't known, and the screen says so.
      expect(await pending).toBe(CONNECTION_CHANGED_AFTER_SEND);
      expect(sentOf(a, TASK_WRITES)).toEqual([]);
      client.stop();
    });

  it("A bot's account: a change whose connection drops after its patch, with another gateway answering at the same address, records nothing there", async () => {
    const { client, a } = await twoGateways();
    // A takes the patch but is slow to apply it, then drops and comes back as another gateway.
    const get = a.gateway.handlers["config.get"]!;
    a.gateway.handlers["config.get"] = async (params) => {
      const config = (await get(params)) as Record<string, unknown>;
      return a.gateway.calls("config.patch").length === 0
        ? config
        : { ...config, appliedConfigHash: "not yet" };
    };
    const replaced = replaceOn(a, "config.patch");
    const target = client.state.connection.target;
    const pending = createBridgeSession(client)
      .apply({ ...ACCOUNT, stamp: gatewayStamp(client.state.connection) })
      .then(
        () => "saved",
        (error: Error) => error.message,
      );
    await until(() => replaced() && client.state.connection.gatewayId === "gateway-x", 6_000);
    expect(client.state.connection.target).toBe(target);
    expect(await pending).toBe(CONNECTION_CHANGED_AFTER_SEND);
    expect(a.gateway.calls("users.prefs.set")).toEqual([]);
    client.stop();
  });

  for (const what of ["account", "model", "fallbacks"] as const)
    it(`A bot's ${what}: a change whose gateway goes during its last answer is not shown as saved`, async () => {
      const { client, a } = await twoGateways();
      await client.refreshAccounts();
      // The last request each change waits for: the account's record, or the config read back.
      const last = what === "account" ? "users.prefs.set" : "config.get";
      let gone = false;
      const answer = a.gateway.handlers[last]!;
      a.gateway.handlers[last] = async (params) => {
        const value = await answer(params);
        if (a.gateway.calls("config.patch").length > 0) gone = true;
        return value;
      };
      const check = (sent: boolean) => {
        if (gone) throw new Error(sent ? CONNECTION_CHANGED_AFTER_SEND : CONNECTION_CHANGED);
      };
      const accounts = (client as unknown as { accounts: AccountsEngine }).accounts;
      const change =
        what === "account"
          ? accounts.changeAccount("otto", "acme:home", "acme", "dev-1", null, check)
          : what === "model"
            ? accounts.setModel("otto", "dev-1", "high", check)
            : accounts.removeFallbacks("otto", check);
      const failure = await change.then(
        () => "saved",
        (error: Error) => error.message,
      );
      expect(failure).toBe(CONNECTION_CHANGED_AFTER_SEND);
      expect(client.state.accounts.write).toMatchObject({ what, status: "failed" });
      client.stop();
    });

  it("A bot's account: when its gateway goes after the patch is confirmed, the account is not recorded or shown as saved", async () => {
    const { client, a } = await twoGateways();
    // The host's check, as `changeBotAccount` passes it, starts refusing once A has applied the
    // patch: the next step is the account's record, here and on the gateway.
    let gone = false;
    const get = a.gateway.handlers["config.get"]!;
    a.gateway.handlers["config.get"] = async (params) => {
      const config = await get(params);
      if (a.gateway.calls("config.patch").length > 0) gone = true;
      return config;
    };
    const accounts = (client as unknown as { accounts: AccountsEngine }).accounts;
    const failure = await accounts
      .changeAccount("otto", "acme:home", "acme", "dev-1", null, (sent) => {
        if (gone) throw new Error(sent ? CONNECTION_CHANGED_AFTER_SEND : CONNECTION_CHANGED);
      })
      .then(
        () => "saved",
        (error: Error) => error.message,
      );
    expect(failure).toBe(CONNECTION_CHANGED_AFTER_SEND);
    expect(client.state.accounts.write).toMatchObject({ what: "account", status: "failed" });
    expect(a.gateway.calls("users.prefs.set")).toEqual([]);
    client.stop();
  });

  for (const [what, command] of [
    ["account", ACCOUNT],
    ["model", MODEL],
    ["fallbacks", FALLBACKS],
  ] as const)
    it(`A bot's ${what}: a change under way when the host switches sends nothing more to the other gateway`, async () => {
      const { client, a, b, switchToB } = await twoGateways();
      // A takes the patch but is slow to apply it: the change waits, reading A's config again.
      const get = a.gateway.handlers["config.get"]!;
      let switched: Promise<void> | null = null;
      a.gateway.handlers["config.get"] = async (params) => {
        const config = (await get(params)) as Record<string, unknown>;
        if (a.gateway.calls("config.patch").length === 0) return config;
        switched ??= switchToB();
        return { ...config, appliedConfigHash: "not yet" };
      };
      const pending = createBridgeSession(client)
        .apply({ ...command, stamp: gatewayStamp(client.state.connection) })
        .then(
          () => "saved",
          (error: Error) => error.message,
        );
      await until(() => switched !== null);
      await switched;
      // The patch had gone to A: what it did there isn't known, and the screen says so.
      expect(await pending).toBe(CONNECTION_CHANGED_AFTER_SEND);
      // The next read of the config, and any step after the patch, never reached B.
      expect(sentOf(b, SETTING_WRITES)).toEqual([]);
      expect(b.gateway.calls("config.get")).toEqual([]);
      client.stop();
    });

  it("An account's Disconnect and a key: read on one gateway, they reach neither after a switch to another with the same id", async () => {
    const { client, a, b, switchToB } = await twoGateways();
    const stamp = gatewayStamp(client.state.connection);
    await switchToB();
    await client.refreshAccounts();
    const viewer = createBridgeSession(client);
    for (const command of [
      { ...DISCONNECT, stamp },
      { ...SAVE_KEY, stamp },
    ] as const)
      await expect(viewer.apply(command)).rejects.toThrow(CONNECTION_CHANGED);
    expect(sentOf(a, ACCOUNT_WRITES)).toEqual([]);
    expect(sentOf(b, ACCOUNT_WRITES)).toEqual([]);
    expect(b.typed).toEqual([]);
    client.stop();
  });

  it("An account's Disconnect and a key go with no switch, and after a dropped connection's reconnect", async () => {
    const { client, a } = await twoGateways();
    const viewer = createBridgeSession(client);
    const stamp = gatewayStamp(client.state.connection);
    await viewer.apply({ ...SAVE_KEY, stamp });
    expect(a.gateway.calls("models.authSetApiKey")).toHaveLength(1);
    const was = client.state.connection.connectedAt;
    a.gateway.dropAll();
    await until(() => ready(client, URL_A) && client.state.connection.connectedAt !== was);
    await client.refreshAccounts();
    await viewer.apply({ ...DISCONNECT, stamp });
    expect(a.gateway.calls("models.authLogout")).toHaveLength(1);
    client.stop();
  });

  // A screen's held dialog, through the stamp the interface sends (`packages/ui/src/stamp.ts`).
  /** What the interface reads the host's state through. */
  const viewOf = (client: ClawtrateClient) => ({
    getState: () => client.state,
    subscribe: (listener: (state: ClawtrateClient["state"]) => void) =>
      client.store.subscribe(listener),
  });
  const deleteFrom = async (client: ClawtrateClient, shown: ReturnType<typeof shownStamp>) =>
    createBridgeSession(client).apply({
      type: "deleteTask",
      key: KEY,
      stamp: await screenStamp(viewOf(client), shown),
    });

  it("a Delete dialog held across another gateway answering at the same address is refused, as the screen sends it", async () => {
    const { client, a } = await twoGateways();
    tasks(a);
    const shown = shownStamp(client.state.connection);
    await replacedBehindReconnect(client, a);
    await expect(deleteFrom(client, shown)).rejects.toThrow(
      "This change was made for another gateway, so nothing was sent.",
    );
    expect(sentOf(a, TASK_WRITES)).toEqual([]);
    client.stop();
  });

  it("a Delete dialog confirmed before the replacing gateway has named itself is refused once it does", async () => {
    const { client, a } = await twoGateways();
    tasks(a);
    const shown = shownStamp(client.state.connection);
    // A comes back as gateway-x, whose name is not read yet when the person confirms.
    const named = deferred<unknown>();
    a.identityReply = named.promise;
    a.identity = "gateway-x";
    const was = client.state.connection.connectedAt;
    a.gateway.dropAll();
    await until(
      () =>
        client.state.connection.status === "connected" &&
        client.state.connection.connectedAt !== was,
    );
    expect(client.state.connection.gatewayId).toBeNull();
    const pending = deleteFrom(client, shown).then(
      () => "deleted",
      (error: Error) => error.message,
    );
    named.resolve({ deviceId: "gateway-x" });
    expect(await pending).toBe("This change was made for another gateway, so nothing was sent.");
    expect(sentOf(a, TASK_WRITES)).toEqual([]);
    client.stop();
  });

  it("a dialog drawn before the gateway named itself, confirmed on a later connection, is refused rather than taking that one's name", async () => {
    const { client, a } = await twoGateways();
    tasks(a);
    // A reconnect whose identity read doesn't answer: the screen is drawn with no name.
    a.identityReply = new Promise<unknown>(() => {});
    let was = client.state.connection.connectedAt;
    a.gateway.dropAll();
    await until(
      () =>
        client.state.connection.status === "connected" &&
        client.state.connection.connectedAt !== was,
    );
    const shown = shownStamp(client.state.connection);
    expect(shown.gatewayId).toBeNull();
    // Then another gateway answers at the same address, and names itself.
    a.identityReply = null;
    a.identity = "gateway-x";
    was = client.state.connection.connectedAt;
    a.gateway.dropAll();
    await until(() => client.state.connection.gatewayId === "gateway-x");
    expect(client.state.connection.connectedAt).not.toBe(was);
    await expect(deleteFrom(client, shown)).rejects.toThrow(
      "The gateway hasn't said which gateway it is, so nothing was sent.",
    );
    expect(sentOf(a, TASK_WRITES)).toEqual([]);
    client.stop();
  });

  // #505: the rows the rail shows carry the stamp of the read that listed them
  // (`discovery.tasksRead`), not the connection's at the click.
  /** A, listing KEY, on the reconnect that `reconnect` makes; its next task list held. */
  const listing = (fake: AccountsGateway) => {
    const row = { key: KEY, agentId: "otto", sessionId: "s-logs", updatedAt: 10 };
    let hold: Promise<unknown> | null = null;
    const list = async () => {
      if (hold) await hold;
      return { sessions: [row], hasMore: false };
    };
    fake.gateway.handlers["sessions.subscribe"] = async () => ({
      subscribed: true,
      list: await list(),
    });
    fake.gateway.handlers["sessions.list"] = list;
    return { hold: (until: Promise<unknown>) => void (hold = until) };
  };
  /** A drops and comes back; the identity it names is published, the task list not yet. */
  const reconnectAs = async (client: ClawtrateClient, a: AccountsGateway, identity: string) => {
    const was = client.state.connection.connectedAt;
    a.identity = identity;
    a.gateway.dropAll();
    await until(
      () =>
        client.state.connection.status === "connected" &&
        client.state.connection.connectedAt !== was &&
        client.state.connection.gatewayId === identity,
    );
  };
  const taskRowActions = async (client: ClawtrateClient) => {
    const viewer = createBridgeSession(client);
    const stamp = () => screenStamp(viewOf(client), client.state.discovery.tasksRead!);
    const archive = viewer.apply({
      type: "archiveTask",
      key: KEY,
      stop: false,
      stamp: await stamp(),
    });
    const remove = viewer.apply({ type: "deleteTask", key: KEY, stamp: await stamp() });
    return Promise.all(
      [archive, remove].map((each) =>
        each.then(
          () => "sent",
          (e: Error) => e.message,
        ),
      ),
    );
  };

  it("Tasks: a row listed before another gateway answered the reconnect at the same address can't act there, though its identity is published first", async () => {
    const { client, a } = await twoGateways();
    tasks(a);
    const list = listing(a);
    await reconnectAs(client, a, "gateway-a");
    await until(() => client.state.discovery.tasksRead?.gatewayId === "gateway-a");
    expect(client.state.tasksByBot.otto?.map((task) => task.key)).toContain(KEY);
    const listed = client.state.discovery.tasksRead!;
    // Another gateway answers, and names itself before its task list arrives.
    const later = deferred<void>();
    list.hold(later.promise);
    await reconnectAs(client, a, "gateway-x");
    expect(client.state.tasksByBot.otto?.map((task) => task.key)).toContain(KEY);
    expect(client.state.discovery.tasksRead).toEqual(listed);
    expect(await taskRowActions(client)).toEqual([
      "This change was made for another gateway, so nothing was sent.",
      "This change was made for another gateway, so nothing was sent.",
    ]);
    expect(sentOf(a, TASK_WRITES)).toEqual([]);
    // Its list arrives: the rows are its own now, and the same actions go there.
    later.resolve();
    await until(() => client.state.discovery.tasksRead?.gatewayId === "gateway-x");
    expect(await taskRowActions(client)).toEqual(["sent", "sent"]);
    expect(sentOf(a, TASK_WRITES).map((each) => each.method)).toContain("sessions.delete");
    client.stop();
  });

  it("Tasks: a row listed before a plain reconnect to the same gateway acts as soon as it is back, before the list is read again", async () => {
    const { client, a } = await twoGateways();
    tasks(a);
    const list = listing(a);
    await reconnectAs(client, a, "gateway-a");
    await until(() => client.state.discovery.tasksRead?.gatewayId === "gateway-a");
    list.hold(new Promise(() => {}));
    await reconnectAs(client, a, "gateway-a");
    expect(await taskRowActions(client)).toEqual(["sent", "sent"]);
    client.stop();
  });

  it("A bot's settings: a change from accounts read before another gateway answered the reconnect can't go there until they are read again", async () => {
    const { client, a } = await twoGateways();
    expect(client.state.accounts.readOn?.gatewayId).toBe("gateway-a");
    const read = client.state.accounts.readOn!;
    // Another gateway answers at the same address; its accounts aren't read yet.
    const get = a.gateway.handlers["config.get"]!;
    const later = deferred<void>();
    a.gateway.handlers["config.get"] = async (params) => {
      await later.promise;
      return get(params);
    };
    await reconnectAs(client, a, "gateway-x");
    expect(client.state.accounts.readOn).toEqual(read);
    const viewer = createBridgeSession(client);
    const changes = async () => {
      const stamp = await screenStamp(viewOf(client), client.state.accounts.readOn!);
      // One after another, as a person makes them: each patch is held to the config it read.
      const outcomes: string[] = [];
      for (const command of [ACCOUNT, MODEL, FALLBACKS])
        outcomes.push(
          await viewer.apply({ ...command, stamp }).then(
            () => "sent",
            (error: Error) => error.message,
          ),
        );
      return outcomes;
    };
    expect(await changes()).toEqual(
      Array(3).fill("This change was made for another gateway, so nothing was sent."),
    );
    expect(sentOf(a, SETTING_WRITES)).toEqual([]);
    // Read again on it, the same changes go there.
    a.gateway.handlers["config.get"] = get;
    later.resolve();
    await client.refreshAccounts();
    expect(client.state.accounts.readOn?.gatewayId).toBe("gateway-x");
    expect(await changes()).toEqual(["sent", "sent", "sent"]);
    client.stop();
  });

  it("Tasks: an event for a key both gateways share isn't merged into rows read on the other one", async () => {
    const { client, a } = await twoGateways();
    tasks(a);
    const list = listing(a);
    await reconnectAs(client, a, "gateway-a");
    await until(() => client.state.discovery.tasksRead?.gatewayId === "gateway-a");
    const title = () => client.state.tasksByBot.otto?.find((task) => task.key === KEY)?.title;
    const before = title();
    list.hold(new Promise(() => {}));
    await reconnectAs(client, a, "gateway-x");
    // The other gateway's own row for the same key, while its list hasn't come.
    a.gateway.emit("sessions.changed", {
      sessionKey: KEY,
      session: {
        key: KEY,
        agentId: "otto",
        sessionId: "s-x",
        label: "Gateway X's task",
        updatedAt: 99,
      },
    });
    await sleep(100);
    expect(title()).toBe(before);
    expect(client.state.discovery.tasksRead?.gatewayId).toBe("gateway-a");
    client.stop();
  });

  it("A bot's settings: the model menu read on one gateway isn't shown beside another's read", async () => {
    const { client, a } = await twoGateways();
    await until(() => client.state.accounts.models.length > 0);
    // Another gateway answers at the same address; its model picker is slow.
    a.holdPicker = new Promise(() => {});
    await reconnectAs(client, a, "gateway-x");
    await until(() => client.state.accounts.readOn?.gatewayId === "gateway-x");
    expect(client.state.accounts.models).toEqual([]);
    client.stop();
  });

  it("Tasks: a list read on a connection that ended before its identity answered isn't published on the next one", async () => {
    const { client, a } = await twoGateways();
    tasks(a);
    listing(a);
    await reconnectAs(client, a, "gateway-a");
    await until(() => client.state.discovery.tasksRead?.gatewayId === "gateway-a");
    const listed = client.state.discovery.tasksRead!;
    // A reconnect whose bot list fails and whose identity read is held: the task list waits on it.
    const named = deferred<unknown>();
    a.identityReply = named.promise;
    const agents = a.gateway.handlers["agents.list"]!;
    a.gateway.handlers["agents.list"] = () => {
      throw new Error("the bot list is busy");
    };
    let was = client.state.connection.connectedAt;
    a.gateway.dropAll();
    await until(() => client.state.connection.connectedAt !== was);
    // That connection ends; the next one's task list is held.
    a.gateway.handlers["agents.list"] = agents;
    const list = listing(a);
    list.hold(new Promise(() => {}));
    a.identityReply = null;
    was = client.state.connection.connectedAt;
    a.gateway.dropAll();
    await until(
      () =>
        client.state.connection.connectedAt !== was &&
        client.state.connection.gatewayId === "gateway-a",
    );
    // The first one's identity answers now: its list is not published as this connection's.
    named.resolve({ deviceId: "gateway-a" });
    await sleep(100);
    expect(client.state.discovery.tasksRead).toEqual(listed);
    client.stop();
  });

  it("A bot's settings: accounts read before the identity answered act once it does, on the same connection", async () => {
    const { client, a } = await twoGateways();
    // A reconnect whose first identity read fails; it is asked again (`askIdentityAgain`).
    let fails = 1;
    const answer = a.gateway.handlers["gateway.identity.get"]!;
    a.gateway.handlers["gateway.identity.get"] = (params) => {
      if (fails > 0) {
        fails -= 1;
        throw new Error("the gateway was busy");
      }
      return answer(params);
    };
    const was = client.state.connection.connectedAt;
    a.gateway.dropAll();
    await until(() => client.state.connection.connectedAt !== was && fails === 0);
    await client.refreshAccounts();
    expect(client.state.accounts.readOn?.gatewayId).toBeNull();
    await until(() => client.state.connection.gatewayId === "gateway-a", 3_000);
    expect(client.state.accounts.readOn?.gatewayId).toBe("gateway-a");
    const stamp = await screenStamp(viewOf(client), client.state.accounts.readOn!);
    await createBridgeSession(client).apply({ ...MODEL, stamp });
    expect(a.gateway.calls("config.patch").length).toBeGreaterThan(0);
    client.stop();
  });

  it("the gateway's identity, when its first read fails, is read again on the same connection, and a stamp taken then goes", async () => {
    const { client, a } = await twoGateways();
    tasks(a);
    let fails = 1;
    const answer = a.gateway.handlers["gateway.identity.get"]!;
    a.gateway.handlers["gateway.identity.get"] = (params) => {
      if (fails > 0) {
        fails -= 1;
        throw new Error("the gateway was busy");
      }
      return answer(params);
    };
    const was = client.state.connection.connectedAt;
    a.gateway.dropAll();
    await until(() => client.state.connection.connectedAt !== was && fails === 0);
    expect(client.state.connection.gatewayId).toBeNull();
    // No other read asks for it: the connection asks again by itself.
    await until(() => client.state.connection.gatewayId === "gateway-a", 3_000);
    await createBridgeSession(client).apply({
      type: "archiveTask",
      key: KEY,
      stop: false,
      stamp: gatewayStamp(client.state.connection),
    });
    expect(a.gateway.calls("sessions.patch")).toHaveLength(1);
    client.stop();
  });

  it("Every group: a command from a renderer keeps its stamp, and one without a stamp is refused", () => {
    const stamp = { gatewayId: "gateway-a", target: 4 };
    for (const command of [
      { type: "removeMachine", nodeId: "node-1", stamp },
      { type: "removeDevice", deviceId: "phone-1", stamp },
      { type: "archiveTask", key: KEY, stop: true, stamp },
      { type: "deleteTask", key: KEY, stamp },
      { ...ACCOUNT, stamp },
      { ...MODEL, stamp },
      { ...FALLBACKS, stamp },
      ...rowActions(3, stamp),
      { ...DISCONNECT, stamp },
      { ...SAVE_KEY, stamp },
    ] as const) {
      expect(parseBridgeCommand(command)).toEqual(command);
      const { stamp: _stamp, ...bare } = command;
      expect(() => parseBridgeCommand(bare)).toThrow();
    }
  });
});
