// The gateway's own bot (F-562): which bots a person sees and picks from, and
// "Show the gateway's own bot" through the client, off by default and kept by the host.

import { describe, expect, it } from "vitest";
import { parseBridgeCommand } from "../src/bridge.ts";
import { ClawtrateClient } from "../src/client.ts";
import { filesSayUntouched } from "../src/gateway-bot-files.ts";
import { gatewayBotHidden, listedBots, listedTasks } from "../src/gateway-bot.ts";
import { mapAgents } from "../src/mapping.ts";
import type { Bot, Task } from "../src/types.ts";
import { FAST, URL_A } from "./client-harness.ts";
import {
  deferred,
  FakeGateway,
  helloOk,
  memoryStorage,
  sleep,
  testHost,
  until,
} from "./fake-gateway.ts";

// As `agents.list` reports them: the gateway's default is "atlas", and a bot whose id is
// "main" is an ordinary one. The default is recognized by `defaultId` alone. It has no name of its
// own, as a gateway's own bot nobody has talked to has none.
const roster = {
  defaultId: "atlas",
  agents: [
    { id: "main", identity: { name: "Main" } },
    { id: "atlas" },
    { id: "pip", identity: { name: "Pip" } },
  ],
};

// `agents.files.list` as OpenClaw 2026.10.6 and 2026.11.10 answered it on a development gateway:
// after the bot's first message, before its own files changed (untouched), and after (used).
const files = (agentId: string, names: [string, boolean][]) => ({
  agentId,
  workspace: "/srv/openclaw/workspace",
  files: names.map(([name, missing]) => ({
    name,
    path: `/srv/openclaw/workspace/${name}`,
    missing,
    ...(missing ? {} : { size: 1_000, updatedAtMs: 1 }),
  })),
});
const STARTING = ["AGENTS.md", "SOUL.md", "USER.md", "BOOTSTRAP.md", "MEMORY.md"];
const beforeFirstTurn = (id: string) =>
  files(
    id,
    STARTING.map((name) => [name, true]),
  );
const untouched = (id: string) =>
  files(id, [
    ["AGENTS.md", false],
    ["SOUL.md", false],
    ["USER.md", false],
    ["BOOTSTRAP.md", false],
    ["MEMORY.md", true],
  ]);
const used = (id: string) =>
  files(id, [
    ["AGENTS.md", false],
    ["SOUL.md", false],
    ["USER.md", false],
    ["MEMORY.md", true],
  ]);

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
const list = (
  bots: Bot[],
  tasksByBot: Record<string, Task[]>,
  show: boolean,
  untouchedGatewayBot: string | null = "atlas",
) => listedBots({ bots, tasksByBot, showGatewayBot: show, untouchedGatewayBot });

describe("F-562: the gateway's own bot", () => {
  it("F-562: is left out while another bot exists, recognized by the gateway's defaultId and not by a name", () => {
    const bots = mapAgents(roster);
    expect(ids(list(bots, {}, false))).toEqual(["main", "pip"]);
    expect(
      bots.filter((bot) => gatewayBotHidden(bot, bots, false, "atlas")).map((bot) => bot.id),
    ).toEqual(["atlas"]);
  });

  it("F-562: shows when it is the only bot", () => {
    const bots = mapAgents({ defaultId: "atlas", agents: [{ id: "atlas" }] });
    expect(ids(list(bots, {}, false))).toEqual(["atlas"]);
    expect(gatewayBotHidden(bots[0]!, bots, false, "atlas")).toBe(false);
  });

  it("F-562: shows, first as the gateway lists it, with the switch on", () => {
    const bots = mapAgents(roster);
    expect(ids(list(bots, {}, true))).toEqual(["atlas", "main", "pip"]);
    expect(bots.some((bot) => gatewayBotHidden(bot, bots, true, "atlas"))).toBe(false);
  });

  it("F-562: shows while one of its tasks waits on the person, and leaves once nothing waits", () => {
    const bots = mapAgents(roster);
    const waiting = { atlas: [task("atlas", "done"), task("atlas", "waiting")] };
    expect(ids(list(bots, waiting, false))).toEqual(["atlas", "main", "pip"]);
    // Still left out by the rule: it shows only for what waits.
    expect(gatewayBotHidden(bots[0]!, bots, false, "atlas")).toBe(true);
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
    expect(bots.some((bot) => gatewayBotHidden(bot, bots, false, "atlas"))).toBe(false);
    // With an owner (selectionRequired false), the rule holds again.
    const owned = mapAgents({ ...roster, ownership: "explicit", selectionRequired: false });
    expect(owned.some((bot) => bot.ownerless)).toBe(false);
    expect(ids(list(owned, {}, false))).toEqual(["main", "pip"]);
  });

  it("F-562: the tasks every count and task search reads leave out the bot's tasks while it is out of view", () => {
    const bots = mapAgents(roster);
    const tasksByBot = { atlas: [task("atlas", "done")], pip: [task("pip", "done")] };
    const from = (show: boolean, tasks: Record<string, Task[]>) =>
      listedTasks({ bots, tasksByBot: tasks, showGatewayBot: show, untouchedGatewayBot: "atlas" });
    expect(Object.keys(from(false, tasksByBot))).toEqual(["pip"]);
    expect(from(true, tasksByBot)).toBe(tasksByBot);
    // Not known to be untouched: its tasks count, as the bot is listed.
    expect(listedTasks({ bots, tasksByBot, showGatewayBot: false })).toBe(tasksByBot);
    // Waiting, its tasks count again, as the bot is listed again.
    const waiting = { ...tasksByBot, atlas: [task("atlas", "waiting")] };
    expect(Object.keys(from(false, waiting))).toEqual(["atlas", "pip"]);
  });

  it("F-562: a gateway's own bot with an id an object inherits, such as constructor, is still left out", () => {
    const bots = mapAgents({
      defaultId: "constructor",
      agents: [{ id: "constructor" }, { id: "pip" }],
    });
    expect(ids(list(bots, {}, false, "constructor"))).toEqual(["pip"]);
    // An id every object has is never taken for a verdict that names another bot.
    expect(ids(list(bots, {}, false, "toString"))).toEqual(["constructor", "pip"]);
  });

  it("F-562: a gateway that names no default leaves every bot listed", () => {
    const bots = mapAgents({ agents: [{ id: "main" }, { id: "pip" }] });
    expect(ids(list(bots, {}, false))).toEqual(["main", "pip"]);
  });
});

/** A hello as OpenClaw sends it: its version, and the methods it offers. */
function hello(
  version: string | null = "2026.11.10",
  methods: string[] = ["agents.list", "agents.files.list", "users.prefs.get", "users.prefs.set"],
  scopes: string[] = ["operator.read", "operator.write"],
) {
  const base = helloOk(scopes);
  return {
    ok: true as const,
    payload: {
      ...base,
      server: { ...base.server, version },
      features: { methods, events: [] },
    },
  };
}

async function connected(
  saved: Record<string, string> = {},
  setUp: (gateway: FakeGateway) => void = (gateway) => {
    gateway.connectReply = () => hello();
    gateway.handlers["agents.files.list"] = (params) =>
      untouched((params as { agentId: string }).agentId);
  },
) {
  const gateway = new FakeGateway();
  gateway.handlers["agents.list"] = () => roster;
  setUp(gateway);
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
    await until(() => client.state.untouchedGatewayBot === "atlas");
    expect(await names()).toEqual(["Main", "Pip"]);
    await client.setShowGatewayBot(true);
    expect(await names()).toEqual(["atlas", "Main", "Pip"]);
    client.stop();
  });

  it("F-562: a choice the host could not keep is not taken", async () => {
    const { client, storage } = await connected();
    storage.set = () => Promise.reject(new Error("The disk is full."));
    await expect(client.setShowGatewayBot(true)).rejects.toThrow("The disk is full.");
    expect(client.state.showGatewayBot).toBe(false);
    client.stop();
  });

  it("F-562: two quick changes keep the last one asked, in storage and in the state, when the first write finishes last", async () => {
    const { client, storage } = await connected();
    const set = storage.set.bind(storage);
    const first = deferred<void>();
    let writes = 0;
    storage.set = async (key, value) => {
      if (key === "show-gateway-bot" && (writes += 1) === 1) await first.promise;
      return set(key, value);
    };
    const on = client.setShowGatewayBot(true);
    const off = client.setShowGatewayBot(false);
    await sleep(20);
    first.resolve();
    await Promise.all([on, off]);
    expect(storage.data.get("show-gateway-bot")).toBe("false");
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

describe("F-562: the gateway's own bot is left out only while untouched (main-bot-onboarding.md 15.2)", () => {
  const bots = mapAgents(roster);
  const atlas = bots.find((bot) => bot.id === "atlas")!;

  it("F-562: untouched and unnamed, it is left out", () => {
    expect(gatewayBotHidden(atlas, bots, false, "atlas")).toBe(true);
    expect(ids(list(bots, {}, false, "atlas"))).toEqual(["main", "pip"]);
  });

  it("F-562: not known to be untouched, it is shown: no verdict, a verdict for another bot", () => {
    for (const verdict of [null, undefined, "pip", "ATLAS", ""]) {
      expect(gatewayBotHidden(atlas, bots, false, verdict)).toBe(false);
      expect(ids(listedBots({ bots, tasksByBot: {}, untouchedGatewayBot: verdict }))).toEqual([
        "atlas",
        "main",
        "pip",
      ]);
    }
  });

  it("F-562: a name of its own makes it the person's, shown whatever its files say", () => {
    const named = mapAgents({
      ...roster,
      agents: roster.agents.map((agent) =>
        agent.id === "atlas" ? { id: "atlas", identity: { name: "Juniper" } } : agent,
      ),
    });
    expect(ids(list(named, {}, false, "atlas"))).toEqual(["atlas", "main", "pip"]);
    // Its id written another way is no name of its own.
    const same = mapAgents({
      ...roster,
      agents: roster.agents.map((agent) =>
        agent.id === "atlas" ? { id: "atlas", identity: { name: " Atlas " } } : agent,
      ),
    });
    expect(ids(list(same, {}, false, "atlas"))).toEqual(["main", "pip"]);
  });

  it("F-562: the files say untouched only before its first turn, or while BOOTSTRAP.md is there and MEMORY.md isn't", () => {
    expect(filesSayUntouched(beforeFirstTurn("atlas"), "atlas")).toBe(true);
    expect(filesSayUntouched(untouched("atlas"), "atlas")).toBe(true);
    // OpenClaw deleted BOOTSTRAP.md: its files are its own, or a memory folder exists.
    expect(filesSayUntouched(used("atlas"), "atlas")).toBe(false);
    // It keeps memory.
    const remembers = untouched("atlas");
    remembers.files = remembers.files.map((file) =>
      file.name === "MEMORY.md" ? { ...file, missing: false } : file,
    );
    expect(filesSayUntouched(remembers, "atlas")).toBe(false);
  });

  it("F-562: an answer of another shape is a doubt, and a doubt shows it", () => {
    for (const answer of [
      null,
      "nothing",
      {},
      { files: "BOOTSTRAP.md" },
      { files: [] },
      { files: [{ missing: false }] },
      { files: [{ name: "BOOTSTRAP.md", missing: "no" }] },
      { files: [null] },
      { ...untouched("pip") },
    ])
      expect(filesSayUntouched(answer, "atlas")).toBe(false);
  });
});

describe("F-562: reading whether the gateway's own bot is untouched", () => {
  const filesAsked = (gateway: FakeGateway) => gateway.calls("agents.files.list");

  it("F-562: reads its files after the bot list, and leaves it out when they say untouched", async () => {
    const { client, gateway } = await connected();
    await until(() => client.state.untouchedGatewayBot === "atlas");
    expect(filesAsked(gateway)).toEqual([{ agentId: "atlas" }]);
    expect(ids(listedBots(client.state))).toEqual(["main", "pip"]);
    client.stop();
  });

  it("F-562: before its first turn too", async () => {
    const { client } = await connected({}, (gateway) => {
      gateway.connectReply = () => hello("2026.10.6");
      gateway.handlers["agents.files.list"] = () => beforeFirstTurn("atlas");
    });
    await until(() => client.state.untouchedGatewayBot === "atlas");
    client.stop();
  });

  it("F-562: a bot the person has used is shown", async () => {
    const { client, gateway } = await connected({}, (gateway) => {
      gateway.connectReply = () => hello();
      gateway.handlers["agents.files.list"] = () => used("atlas");
    });
    await until(() => filesAsked(gateway).length === 1);
    await sleep(20);
    expect(client.state.untouchedGatewayBot ?? null).toBeNull();
    expect(ids(listedBots(client.state))).toEqual(["atlas", "main", "pip"]);
    client.stop();
  });

  it("F-562: every doubt shows it: not offered, an older or unknown version, a refusal, no answer yet", async () => {
    const cases: [string, (gateway: FakeGateway) => void, boolean][] = [
      [
        "not offered",
        (gateway) => {
          gateway.connectReply = () => hello("2026.11.10", ["agents.list"]);
          gateway.handlers["agents.files.list"] = () => untouched("atlas");
        },
        false,
      ],
      [
        "an older version",
        (gateway) => {
          gateway.connectReply = () => hello("2026.9.30");
          gateway.handlers["agents.files.list"] = () => untouched("atlas");
        },
        false,
      ],
      [
        "an unknown version",
        (gateway) => {
          gateway.connectReply = () => hello(null);
          gateway.handlers["agents.files.list"] = () => untouched("atlas");
        },
        false,
      ],
      [
        "a refusal",
        (gateway) => {
          gateway.connectReply = () => hello();
          gateway.handlers["agents.files.list"] = () => {
            throw new Error("missing scope: operator.read");
          };
        },
        true,
      ],
    ];
    for (const [, setUp, asks] of cases) {
      const { client, gateway } = await connected({}, setUp);
      await sleep(30);
      expect(filesAsked(gateway).length > 0).toBe(asks);
      expect(client.state.untouchedGatewayBot ?? null).toBeNull();
      expect(ids(listedBots(client.state))).toContain("atlas");
      client.stop();
    }
    // An answer that hasn't come: shown meanwhile.
    const held = deferred<unknown>();
    const { client } = await connected({}, (gateway) => {
      gateway.connectReply = () => hello();
      gateway.handlers["agents.files.list"] = () => held.promise;
    });
    await sleep(30);
    expect(ids(listedBots(client.state))).toContain("atlas");
    held.resolve(untouched("atlas"));
    await until(() => client.state.untouchedGatewayBot === "atlas");
    client.stop();
  });

  it("F-562: a bot with a name of its own, or a gateway with one bot, is never read", async () => {
    const { client, gateway } = await connected({}, (gateway) => {
      gateway.connectReply = () => hello();
      gateway.handlers["agents.list"] = () => ({
        defaultId: "atlas",
        agents: [{ id: "atlas", identity: { name: "Juniper" } }, { id: "pip" }],
      });
      gateway.handlers["agents.files.list"] = () => untouched("atlas");
    });
    await sleep(30);
    expect(filesAsked(gateway)).toEqual([]);
    expect(ids(listedBots(client.state))).toEqual(["atlas", "pip"]);
    client.stop();
  });

  it("F-562: an answer for a bot that is no longer the gateway's own is dropped, and the new one is read", async () => {
    const held = deferred<unknown>();
    const { client, gateway } = await connected({}, (gateway) => {
      gateway.connectReply = () => hello();
      gateway.handlers["agents.files.list"] = (params) =>
        (params as { agentId: string }).agentId === "atlas" ? held.promise : used("pip");
    });
    await until(() => filesAsked(gateway).length === 1);
    // The default moves to pip, unnamed, while atlas's read is out.
    gateway.handlers["agents.list"] = () => ({
      ...roster,
      defaultId: "pip",
      agents: [{ id: "atlas" }, { id: "pip" }],
    });
    gateway.emit("config.changed", {});
    await until(() => client.state.bots.some((bot) => bot.id === "pip" && bot.isDefault));
    // atlas's answer, untouched, comes last: it describes a bot that is no longer the default.
    held.resolve(untouched("atlas"));
    await until(() =>
      filesAsked(gateway).some((each) => (each as { agentId: string }).agentId === "pip"),
    );
    await sleep(30);
    expect(client.state.untouchedGatewayBot ?? null).toBeNull();
    expect(ids(listedBots(client.state))).toEqual(["pip", "atlas"]);
    client.stop();
  });

  it("F-562: a verdict goes with a rename: the bot named since is shown at once, with nothing read", async () => {
    const { client, gateway } = await connected();
    await until(() => client.state.untouchedGatewayBot === "atlas");
    const asked = filesAsked(gateway).length;
    gateway.handlers["agents.list"] = () => ({
      ...roster,
      agents: roster.agents.map((agent) =>
        agent.id === "atlas" ? { id: "atlas", identity: { name: "Juniper" } } : agent,
      ),
    });
    gateway.emit("config.changed", {});
    await until(() => client.state.bots.some((bot) => bot.name === "Juniper"));
    expect(ids(listedBots(client.state))).toEqual(["atlas", "main", "pip"]);
    await sleep(20);
    expect(filesAsked(gateway).length).toBe(asked);
    client.stop();
  });
});
