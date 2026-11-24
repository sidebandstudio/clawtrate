// The bot list follows the gateway's `config.changed` events: one `agents.list`
// read at a time with at most one more queued, stale reads dropped across
// reconnects, and a deleted bot's cached task rows pruned.
import { describe, expect, it } from "vitest";
import { ClawtrateClient } from "../src/client.ts";
import { MAX_BOTS } from "../src/state-bounds.ts";
import { FAST, URL_A } from "./client-harness.ts";
import { FakeGateway, GatewayError, memoryStorage, testHost, until } from "./fake-gateway.ts";

async function connect(gateway: FakeGateway) {
  const client = new ClawtrateClient(testHost(gateway, memoryStorage()), FAST);
  await client.connect({ url: URL_A, token: "t" });
  await until(() => client.state.discovery.status === "ready");
  return client;
}

describe("the bot list follows gateway config changes", () => {
  it("F-558: rereads agents.list on config.changed, follows added, renamed and deleted bots, and prunes a deleted bot's tasks", async () => {
    let agents: Array<Record<string, unknown>> = [
      { id: "main", identity: { name: "Juniper" } },
      { id: "otto", identity: { name: "Otto" } },
    ];
    let fail = false;
    const gateway = new FakeGateway();
    gateway.handlers["agents.list"] = () => {
      if (fail) throw new GatewayError({ code: "UNAVAILABLE", message: "busy" });
      return { defaultId: "main", agents };
    };
    gateway.handlers["sessions.subscribe"] = () => ({
      subscribed: true,
      list: {
        sessions: [
          { key: "agent:main:main", agentId: "main", updatedAt: 10 },
          { key: "agent:otto:main", agentId: "otto", updatedAt: 20, unread: true },
        ],
        hasMore: false,
      },
    });
    const client = await connect(gateway);
    try {
      expect(client.state.bots.map((bot) => [bot.id, bot.name])).toEqual([
        ["main", "Juniper"],
        ["otto", "Otto"],
      ]);
      expect(Object.keys(client.state.tasksByBot).sort()).toEqual(["main", "otto"]);

      // A bot is renamed and a new bot is added from another client.
      agents = [
        { id: "main", identity: { name: "Juniper" } },
        { id: "otto", identity: { name: "Otto Prime" } },
        { id: "pip", identity: { name: "Pip" } },
      ];
      gateway.emit("config.changed", { path: "openclaw.json", hash: "h1", ts: 1 });
      await until(() => client.state.bots.some((bot) => bot.id === "pip"));
      expect(client.state.bots.map((bot) => [bot.id, bot.name])).toEqual([
        ["main", "Juniper"],
        ["otto", "Otto Prime"],
        ["pip", "Pip"],
      ]);
      expect(client.state.tasksByBot.otto).toHaveLength(1);

      // A bot is deleted from another client: it leaves the list and its task rows are pruned.
      agents = [
        { id: "main", identity: { name: "Juniper" } },
        { id: "pip", identity: { name: "Pip" } },
      ];
      gateway.emit("config.changed", { path: "openclaw.json", hash: "h2", ts: 2 });
      await until(() => !client.state.bots.some((bot) => bot.id === "otto"));
      expect(client.state.bots.map((bot) => bot.id)).toEqual(["main", "pip"]);
      expect(client.state.tasksByBot.otto).toBeUndefined();
      expect(client.state.tasksByBot.main).toHaveLength(1);

      // A failed reread keeps the previous list.
      fail = true;
      const before = gateway.calls("agents.list").length;
      gateway.emit("config.changed", { path: "openclaw.json", hash: "h3", ts: 3 });
      await until(() => gateway.calls("agents.list").length > before);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(client.state.bots.map((bot) => bot.id)).toEqual(["main", "pip"]);

      // The existing MAX_BOTS bound still holds on reread.
      fail = false;
      agents = Array.from({ length: MAX_BOTS + 5 }, (_, index) => ({
        id: index === 0 ? "main" : `bot-${index}`,
        identity: { name: `Bot ${index}` },
      }));
      gateway.emit("config.changed", { path: "openclaw.json", hash: "h4", ts: 4 });
      await until(() => client.state.bots.length === MAX_BOTS);
      expect(client.state.bots).toHaveLength(MAX_BOTS);
    } finally {
      client.stop();
    }
  });

  it("F-558: coalesces bursts of config.changed into at most one read in flight plus one queued, and drops stale reads after reconnect", async () => {
    const gateway = new FakeGateway();
    const client = await connect(gateway);
    const answers: Array<(value: unknown) => void> = [];
    gateway.handlers["agents.list"] = () => new Promise((resolve) => answers.push(resolve));
    try {
      // Four events in a burst: one read starts, one more runs after it answers.
      gateway.emit("config.changed", { hash: "h1", ts: 1 });
      await until(() => answers.length === 1);
      gateway.emit("config.changed", { hash: "h2", ts: 2 });
      gateway.emit("config.changed", { hash: "h3", ts: 3 });
      gateway.emit("config.changed", { hash: "h4", ts: 4 });
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(answers).toHaveLength(1);

      answers[0]!({
        defaultId: "main",
        agents: [
          { id: "main", identity: { name: "Juniper" } },
          { id: "intermediate", identity: { name: "Intermediate" } },
        ],
      });
      await until(() => answers.length === 2);
      answers[1]!({
        defaultId: "main",
        agents: [
          { id: "main", identity: { name: "Juniper" } },
          { id: "final", identity: { name: "Final" } },
        ],
      });
      await until(() => client.state.bots.some((bot) => bot.id === "final"));
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(answers).toHaveLength(2);
      expect(client.state.bots.map((bot) => bot.id)).toEqual(["main", "final"]);

      // A reconnect while a reread is in flight ignores the old answer and still reads on the new socket.
      gateway.emit("config.changed", { hash: "h5", ts: 5 });
      await until(() => answers.length === 3);
      const staleAnswer = answers[2]!;
      let latestAgents: Array<Record<string, unknown>> = [
        { id: "main", identity: { name: "Juniper" } },
        { id: "after-reconnect", identity: { name: "After Reconnect" } },
      ];
      gateway.handlers["agents.list"] = () => ({ defaultId: "main", agents: latestAgents });
      gateway.dropAll();
      await until(() => client.state.bots.some((bot) => bot.id === "after-reconnect"));
      staleAnswer({
        defaultId: "main",
        agents: [{ id: "main", identity: { name: "Stale" } }],
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(client.state.bots.map((bot) => [bot.id, bot.name])).toEqual([
        ["main", "Juniper"],
        ["after-reconnect", "After Reconnect"],
      ]);

      // A later config.changed on the new connection still triggers a fresh reread.
      latestAgents = [{ id: "main", identity: { name: "Fresh" } }];
      gateway.emit("config.changed", { hash: "h6", ts: 6 });
      await until(() => client.state.bots[0]?.name === "Fresh");
      expect(client.state.bots.map((bot) => [bot.id, bot.name])).toEqual([["main", "Fresh"]]);
    } finally {
      client.stop();
    }
  });
});
