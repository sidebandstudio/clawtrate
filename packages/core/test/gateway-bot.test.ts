// The gateway's own bot (F-562): which bots a person sees and picks from, and
// "Show the gateway's own bot" through the client, off by default and kept by the host.

import { describe, expect, it } from "vitest";
import { parseBridgeCommand } from "../src/bridge.ts";
import { ClawtrateClient } from "../src/client.ts";
import { gatewayBotHidden, listedBots, listedTasks } from "../src/gateway-bot.ts";
import { mapAgents } from "../src/mapping.ts";
import type { Bot, Task } from "../src/types.ts";
import { FAST, URL_A } from "./client-harness.ts";
import { deferred, FakeGateway, memoryStorage, sleep, testHost, until } from "./fake-gateway.ts";

// As `agents.list` reports them: the gateway's default is "atlas", and a bot whose id is
// "main" is an ordinary one. The default is recognized by `defaultId` alone.
const roster = {
  defaultId: "atlas",
  agents: [
    { id: "main", identity: { name: "Main" } },
    { id: "atlas", identity: { name: "Atlas" } },
    { id: "pip", identity: { name: "Pip" } },
  ],
};

function task(botId: string, status: Task["status"]): Task {
  return {
    key: `agent:${botId}:dashboard:1`,
    botId,
    sessionId: null,
    title: "A task",
    preview: null,
    updatedAt: 100,
    status,
    unread: false,
  };
}

const ids = (bots: { id: string }[]) => bots.map((bot) => bot.id);
const list = (bots: Bot[], tasksByBot: Record<string, Task[]>, show: boolean) =>
  listedBots({ bots, tasksByBot, showGatewayBot: show });

describe("F-562: the gateway's own bot", () => {
  it("F-562: is left out while another bot exists, recognized by the gateway's defaultId and not by a name", () => {
    const bots = mapAgents(roster);
    expect(ids(list(bots, {}, false))).toEqual(["main", "pip"]);
    expect(bots.filter((bot) => gatewayBotHidden(bot, bots, false)).map((bot) => bot.id)).toEqual([
      "atlas",
    ]);
  });

  it("F-562: shows when it is the only bot", () => {
    const bots = mapAgents({ defaultId: "atlas", agents: [{ id: "atlas" }] });
    expect(ids(list(bots, {}, false))).toEqual(["atlas"]);
    expect(gatewayBotHidden(bots[0]!, bots, false)).toBe(false);
  });

  it("F-562: shows, first as the gateway lists it, with the switch on", () => {
    const bots = mapAgents(roster);
    expect(ids(list(bots, {}, true))).toEqual(["atlas", "main", "pip"]);
    expect(bots.some((bot) => gatewayBotHidden(bot, bots, true))).toBe(false);
  });

  it("F-562: shows while one of its tasks waits on the person, and leaves once nothing waits", () => {
    const bots = mapAgents(roster);
    const waiting = { atlas: [task("atlas", "done"), task("atlas", "waiting")] };
    expect(ids(list(bots, waiting, false))).toEqual(["atlas", "main", "pip"]);
    // Still left out by the rule: it shows only for what waits.
    expect(gatewayBotHidden(bots[0]!, bots, false)).toBe(true);
    const answered = { atlas: [task("atlas", "running")] };
    expect(ids(list(bots, answered, false))).toEqual(["main", "pip"]);
    // Another bot waiting brings nothing back.
    expect(ids(list(bots, { pip: [task("pip", "waiting")] }, false))).toEqual(["main", "pip"]);
  });

  it("F-562: a gateway that reports selectionRequired has no bot of its own: its first bot, named as defaultId, stays listed", () => {
    // As OpenClaw 2026.10.6 answers for an explicit roster with no owner: `defaultId` is the
    // first configured bot.
    const bots = mapAgents({
      ...roster,
      defaultId: "main",
      ownership: "explicit",
      selectionRequired: true,
    });
    expect(bots[0]).toMatchObject({ id: "main", isDefault: true, ownerless: true });
    expect(ids(list(bots, {}, false))).toEqual(["main", "atlas", "pip"]);
    expect(bots.some((bot) => gatewayBotHidden(bot, bots, false))).toBe(false);
    // With an owner (selectionRequired false), the rule holds again.
    const owned = mapAgents({ ...roster, ownership: "explicit", selectionRequired: false });
    expect(owned.some((bot) => bot.ownerless)).toBe(false);
    expect(ids(list(owned, {}, false))).toEqual(["main", "pip"]);
  });

  it("F-562: the tasks every count and task search reads leave out the bot's tasks while it is out of view", () => {
    const bots = mapAgents(roster);
    const tasksByBot = { atlas: [task("atlas", "done")], pip: [task("pip", "done")] };
    expect(Object.keys(listedTasks({ bots, tasksByBot, showGatewayBot: false }))).toEqual(["pip"]);
    expect(listedTasks({ bots, tasksByBot, showGatewayBot: true })).toBe(tasksByBot);
    // Waiting, its tasks count again, as the bot is listed again.
    const waiting = { ...tasksByBot, atlas: [task("atlas", "waiting")] };
    expect(Object.keys(listedTasks({ bots, tasksByBot: waiting, showGatewayBot: false }))).toEqual([
      "atlas",
      "pip",
    ]);
  });

  it("F-562: a gateway's own bot with an id an object inherits, such as constructor, is still left out", () => {
    const bots = mapAgents({
      defaultId: "constructor",
      agents: [{ id: "constructor" }, { id: "pip" }],
    });
    expect(ids(list(bots, {}, false))).toEqual(["pip"]);
  });

  it("F-562: a gateway that names no default leaves every bot listed", () => {
    const bots = mapAgents({ agents: [{ id: "main" }, { id: "pip" }] });
    expect(ids(list(bots, {}, false))).toEqual(["main", "pip"]);
  });
});

async function connected(saved: Record<string, string> = {}) {
  const gateway = new FakeGateway();
  gateway.handlers["agents.list"] = () => roster;
  const storage = memoryStorage(saved);
  const client = new ClawtrateClient(testHost(gateway, storage), FAST);
  await client.start();
  await client.connect({ url: URL_A, token: "bootstrap" });
  await until(() => client.state.discovery.status === "ready");
  return { client, gateway, storage };
}

describe("F-562: Show the gateway's own bot", () => {
  it("F-562: is off by default, is kept by the host, and asks nothing of the gateway", async () => {
    const { client, gateway, storage } = await connected();
    expect(client.state.showGatewayBot).toBe(false);
    // Every bot stays in the state: cards, links and Delete still find the gateway's own.
    expect(ids(client.state.bots)).toEqual(["atlas", "main", "pip"]);
    const asked = gateway.requests.length;
    await client.setShowGatewayBot(true);
    expect(client.state.showGatewayBot).toBe(true);
    expect(storage.data.get("show-gateway-bot")).toBe("true");
    await client.setShowGatewayBot(false);
    expect(storage.data.get("show-gateway-bot")).toBe("false");
    // Nothing but reads, whatever the client's own timers ask meanwhile.
    expect(
      gateway.requests.slice(asked).filter((each) => !/\.(list|get|history)$/.test(each.method)),
    ).toEqual([]);
    client.stop();

    const again = await connected({ "show-gateway-bot": "true" });
    expect(again.client.state.showGatewayBot).toBe(true);
    again.client.stop();
  });

  it("F-562: a choice made while startup reads the kept one stays, and a stopped startup's late read changes nothing", async () => {
    const storage = memoryStorage({ "show-gateway-bot": "false" });
    const gate = deferred<void>();
    let held = false;
    const get = storage.get;
    storage.get = async (read) => {
      const value = await get(read);
      if (read === "show-gateway-bot" && !held) {
        held = true;
        await gate.promise;
      }
      return value;
    };
    const client = new ClawtrateClient(testHost(new FakeGateway(), storage), FAST);
    try {
      const starting = client.start();
      await until(() => held);
      await client.setShowGatewayBot(true);
      gate.resolve();
      await starting;
      await sleep(20);
      expect(client.state.showGatewayBot).toBe(true);
      expect(storage.data.get("show-gateway-bot")).toBe("true");
    } finally {
      gate.resolve();
      client.stop();
    }
  });

  it("F-562: the composer's @ menu offers the bots the sidebar lists, and the gateway's own with the switch on", async () => {
    const { client, gateway } = await connected();
    gateway.handlers["cron.list"] = () => ({ jobs: [] });
    const names = async () =>
      (await client.readComposerMenu("agent:pip:main", "@")).map((row) => row.name);
    expect(await names()).toEqual(["Main", "Pip"]);
    await client.setShowGatewayBot(true);
    expect(await names()).toEqual(["Atlas", "Main", "Pip"]);
    client.stop();
  });

  it("F-562: a choice the host could not keep is not taken", async () => {
    const { client, storage } = await connected();
    storage.set = () => Promise.reject(new Error("The disk is full."));
    await expect(client.setShowGatewayBot(true)).rejects.toThrow("The disk is full.");
    expect(client.state.showGatewayBot).toBe(false);
    client.stop();
  });

  it("F-562: the bridge takes the command with a flag and nothing else", () => {
    expect(parseBridgeCommand({ type: "setShowGatewayBot", on: true })).toEqual({
      type: "setShowGatewayBot",
      on: true,
    });
    expect(() => parseBridgeCommand({ type: "setShowGatewayBot", on: "yes" })).toThrow(
      "invalid gateway bot setting",
    );
  });
});
