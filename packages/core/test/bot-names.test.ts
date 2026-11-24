// A bot that takes a name in the chat (F-552): the name it writes on its
// IDENTITY.md's `- Name:` line becomes one card, and only the person's Rename
// sends `agents.update`. The files and answers are as a development gateway
// on OpenClaw 2026.10.6 gave them: `agents.update` rewrites the line as
// `- Name: <name>`, with every other identity field of the config, the
// picture's data URL included, and the bot list then shows it.

import { describe, expect, it } from "vitest";
import { identityFile } from "../src/accounts-engine.ts";
import {
  BotNames,
  type BotNamesContext,
  identityName,
  MAX_BOT_NAME_CHARS,
  MAX_IDENTITY_CHARS,
  MAX_NAME_CARDS,
  NAME_DECLINES_KEY,
  plainName,
} from "../src/bot-names.ts";
import { MAX_BOTS } from "../src/state-bounds.ts";
import {
  gatewayStamp,
  type Bot,
  type ConnectionState,
  type GatewayStamp,
  type NameProposal,
} from "../src/types.ts";
import { ADMIN_SCOPES, INTERACTIVE_SCOPES, READ_SCOPES } from "../src/scopes.ts";
import { ClawtrateClient } from "../src/client.ts";
import { agentEvent, FAST, openTask, URL_A, URL_B, grantingGateway } from "./client-harness.ts";
import {
  deferred,
  GatewayError,
  memoryStorage,
  sleep,
  testHost,
  tokenKey,
  until,
} from "./fake-gateway.ts";

const KEY = "agent:new-bot:main";

const PICTURE = `data:image/png;base64,${"A".repeat(30_000)}`;
/** A revision of the file's content, in the gateway's 64-hex form (FNV-1a, repeated). */
const hashOf = (content: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) h = Math.imul(h ^ content.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0").repeat(8);
};

/**
 * A gateway with the default bot and one New bot made, whose IDENTITY.md the test writes. With
 * `picture`, the bot's config identity has one, as New bot saves a chosen picture.
 */
function namingGateway(
  fileOf: (name: string) => string = (name) => identityFile(name, false),
  options: { picture?: boolean } = {},
) {
  const gateway = grantingGateway();
  const bot = { name: "New bot", file: fileOf("New bot"), gatewayId: "gw-a" };
  gateway.handlers["gateway.identity.get"] = () => ({ deviceId: bot.gatewayId });
  gateway.handlers["agents.list"] = () => ({
    defaultId: "main",
    agents: [
      { id: "main", identity: { name: "Juniper" } },
      {
        id: "new-bot",
        name: bot.name,
        identity: { name: bot.name, ...(options.picture ? { avatar: PICTURE } : {}) },
      },
    ],
  });
  gateway.handlers["agents.files.get"] = (params) => {
    const { agentId, name } = params as { agentId: string; name: string };
    if (name !== "IDENTITY.md") throw new Error("only IDENTITY.md is read");
    const content = agentId === "new-bot" ? bot.file : "# IDENTITY.md\n\n- Name: Juniper2\n";
    return { file: { name, missing: false, content, hash: hashOf(content) } };
  };
  gateway.handlers["agents.files.set"] = (params) => {
    const { content, expectedHash } = params as { content: string; expectedHash: string };
    if (expectedHash !== hashOf(bot.file))
      throw new GatewayError({ code: "CONFLICT", message: "IDENTITY.md changed" });
    bot.file = content;
    return { ok: true };
  };
  // As the gateway does (`mergeIdentityMarkdownContent`): the config's name on the first `-` Name
  // line, and each other identity field the config holds as a line of its own below it.
  gateway.handlers["agents.update"] = (params) => {
    const { name } = params as { name: string };
    bot.name = name;
    bot.file = bot.file.replace(
      /^- \*{0,2}Name:\*{0,2} .*$/m,
      `- Name: ${name}${options.picture ? `\n- Avatar: ${PICTURE}` : ""}`,
    );
    return { ok: true, agentId: "new-bot" };
  };
  /** The bot edits its own file, as `#take-name` does. */
  const takeName = (name: string) => {
    bot.file = bot.file.replace(/^- \*{0,2}Name:\*{0,2} .*$/m, `- **Name:** ${name}`);
  };
  return { gateway, bot, takeName };
}

const adminStorage = (held: readonly string[] = ADMIN_SCOPES) =>
  memoryStorage({
    connection: JSON.stringify({ url: URL_A, token: null }),
    [tokenKey(URL_A)]: JSON.stringify({
      token: "device-token",
      grantedScopes: held,
      heldScopes: held.filter((scope) => scope !== "operator.admin"),
      ...(held.includes("operator.admin") ? { adminHeld: true } : {}),
    }),
  });

let run = 0;
function endRun(gateway: ReturnType<typeof namingGateway>["gateway"], key = KEY) {
  run += 1;
  gateway.emit("agent", agentEvent(`run-${run}`, 1, "lifecycle", { phase: "end" }, key));
}
const reads = (gateway: ReturnType<typeof namingGateway>["gateway"]) =>
  gateway.calls("agents.files.get").length;
const BOT: Bot = {
  id: "new-bot",
  name: "New bot",
  emoji: null,
  avatarUrl: null,
  theme: null,
  model: null,
  isDefault: false,
};
const STAMP: GatewayStamp = { gatewayId: "gw-a", target: 1 };

/** The engine alone, on a context of the test's own: its reads, writes, slots and list. */
function engine(options: Partial<BotNamesContext> = {}) {
  const bots: Bot[] = [{ ...BOT }];
  const published: NameProposal[][] = [];
  const out = {
    bots,
    published,
    onUpdate: () => {},
    engine: null as unknown as BotNames,
    ctxRun: () => out.engine.afterRun("new-bot"),
  };
  out.engine = new BotNames({
    bots: () => bots,
    canRename: () => true,
    gateway: () => STAMP.gatewayId,
    stamp: () => STAMP,
    sameGateway: async () => {},
    storage: memoryStorage(),
    takeRead: () => () => {},
    refreshBots: async () => {},
    missingScope: () => false,
    publish: (each) => published.push(each),
    log: () => {},
    ...options,
    request: async (method, params) => {
      if (method === "agents.update") out.onUpdate();
      return (options.request ?? (async () => ({})))(method, params);
    },
  });
  return out;
}

/** Where the client is connected now: the stamp a card read now carries. */
const here = (client: { state: { connection: ConnectionState } }) =>
  gatewayStamp(client.state.connection);

describe("F-552: a bot that takes a name", () => {
  it("F-552: a name on file that differs from the bot's is one card, and nothing is sent until Rename", async () => {
    const { gateway, takeName } = namingGateway();
    const storage = adminStorage();
    const { client } = await openTask({ gateway, storage, held: ADMIN_SCOPES, key: KEY });
    // The file still names it as it was made: one read, no card.
    endRun(gateway);
    await until(() => reads(gateway) === 1);
    await sleep(30);
    expect(client.state.botNames ?? []).toEqual([]);

    takeName("Johnny");
    endRun(gateway);
    await until(() => (client.state.botNames ?? []).length === 1);
    expect(client.state.botNames).toEqual([
      {
        botId: "new-bot",
        name: "Johnny",
        from: "New bot",
        stamp: { gatewayId: "gw-a", target: client.state.connection.target },
        status: "open",
        error: null,
      },
    ]);
    // Another run ends: still one card, one read each run, and no write.
    endRun(gateway);
    await until(() => reads(gateway) === 3);
    await sleep(30);
    expect(client.state.botNames).toHaveLength(1);
    expect(gateway.calls("agents.update")).toEqual([]);
    expect(client.state.bots.find((bot) => bot.id === "new-bot")?.name).toBe("New bot");
    client.stop();
  });

  it("F-552: Rename sends exactly one agents.update with the name shown, and the card goes once the bot list shows it", async () => {
    const { gateway, bot, takeName } = namingGateway();
    const { client } = await openTask({
      gateway,
      storage: adminStorage(),
      held: ADMIN_SCOPES,
      key: KEY,
    });
    takeName("Johnny");
    endRun(gateway);
    await until(() => (client.state.botNames ?? []).length === 1);
    await client.acceptBotName("new-bot", "Johnny", here(client));
    expect(gateway.calls("agents.update")).toEqual([{ agentId: "new-bot", name: "Johnny" }]);
    expect(client.state.bots.find((each) => each.id === "new-bot")?.name).toBe("Johnny");
    expect(client.state.botNames).toEqual([]);
    // The file and the config agree, with one name line: the next run brings no card.
    expect(bot.file.match(/Name:/g)).toHaveLength(2); // the line, and the prose naming it
    expect(identityName(bot.file)).toBe("Johnny");
    // One read when the run ended, one after Rename for the picture line, and nothing written.
    expect(reads(gateway)).toBe(2);
    expect(gateway.calls("agents.files.set")).toEqual([]);
    endRun(gateway);
    await until(() => reads(gateway) === 3);
    await sleep(30);
    expect(client.state.botNames).toEqual([]);
    // A second Rename of the same card is refused, and sends nothing.
    await expect(client.acceptBotName("new-bot", "Johnny", here(client))).rejects.toThrow(
      /no longer waiting/,
    );
    expect(gateway.calls("agents.update")).toHaveLength(1);
    client.stop();
  });

  it("F-552: Rename sends only the name on the card, and nothing once the bot was renamed otherwise", async () => {
    const { gateway, bot, takeName } = namingGateway();
    const { client } = await openTask({
      gateway,
      storage: adminStorage(),
      held: ADMIN_SCOPES,
      key: KEY,
    });
    takeName("Johnny");
    endRun(gateway);
    await until(() => (client.state.botNames ?? []).length === 1);
    await expect(client.acceptBotName("new-bot", "Johnny2", here(client))).rejects.toThrow(
      /no longer waiting/,
    );
    // Drawn for another gateway: nothing is sent.
    await expect(
      client.acceptBotName("new-bot", "Johnny", { ...here(client), gatewayId: "gw-b" }),
    ).rejects.toThrow(/found on another gateway, so nothing was sent/);
    // Renamed elsewhere since the card was drawn: the read just before sending finds it.
    bot.name = "Scout";
    await expect(client.acceptBotName("new-bot", "Johnny", here(client))).rejects.toThrow(
      /renamed Scout meanwhile, so nothing was sent/,
    );
    expect(gateway.calls("agents.update")).toEqual([]);
    expect(client.state.botNames).toEqual([]);
    client.stop();
  });

  it("F-552: a rename the gateway refuses for its scope says so on the card", async () => {
    const { gateway, takeName } = namingGateway();
    gateway.handlers["agents.update"] = () => {
      throw new GatewayError({
        code: "INVALID_REQUEST",
        message: "missing scope: operator.admin",
        details: { code: "MISSING_SCOPE", missingScope: "operator.admin" },
      });
    };
    const { client } = await openTask({
      gateway,
      storage: adminStorage(),
      held: ADMIN_SCOPES,
      key: KEY,
    });
    takeName("Johnny");
    endRun(gateway);
    await until(() => (client.state.botNames ?? []).length === 1);
    await expect(client.acceptBotName("new-bot", "Johnny", here(client))).rejects.toThrow();
    expect(client.state.botNames?.[0]).toMatchObject({
      status: "failed",
      error: "The gateway refused: renaming a bot needs admin access.",
    });
    expect(client.state.connection.canAdmin).toBe(false);
    // Without admin now, the next run reads nothing.
    const before = reads(gateway);
    endRun(gateway);
    await sleep(50);
    expect(reads(gateway)).toBe(before);
    client.stop();
  });

  it("F-552: Not now is kept for that bot and that name across a restart, and another name brings a new card", async () => {
    const { gateway, takeName } = namingGateway();
    const storage = adminStorage();
    const first = await openTask({ gateway, storage, held: ADMIN_SCOPES, key: KEY });
    takeName("Johnny");
    endRun(gateway);
    await until(() => (first.client.state.botNames ?? []).length === 1);
    await first.client.declineBotName("new-bot", "Johnny");
    expect(first.client.state.botNames).toEqual([]);
    expect(storage.data.get(NAME_DECLINES_KEY)).toBe(
      JSON.stringify({ ["gw-a\nnew-bot"]: "Johnny" }),
    );
    first.client.stop();

    const second = await openTask({ gateway, storage, held: ADMIN_SCOPES, key: KEY });
    const before = reads(gateway);
    endRun(gateway);
    await until(() => reads(gateway) === before + 1);
    await sleep(30);
    expect(second.client.state.botNames ?? []).toEqual([]);

    takeName("Scout");
    endRun(gateway);
    await until(() => (second.client.state.botNames ?? []).length === 1);
    expect(second.client.state.botNames?.[0]).toMatchObject({ name: "Scout", from: "New bot" });
    expect(gateway.calls("agents.update")).toEqual([]);
    second.client.stop();
  });

  it("F-552: a rename made elsewhere clears the card when the bot list is read again", async () => {
    const { gateway, bot, takeName } = namingGateway();
    const { client } = await openTask({
      gateway,
      storage: adminStorage(),
      held: ADMIN_SCOPES,
      key: KEY,
    });
    takeName("Johnny");
    endRun(gateway);
    await until(() => (client.state.botNames ?? []).length === 1);
    // Renamed to that name in another of the person's clients; the list is read on reconnect.
    bot.name = "Johnny";
    gateway.dropAll();
    await until(() => client.state.bots.find((each) => each.id === "new-bot")?.name === "Johnny");
    expect(client.state.botNames).toEqual([]);
    expect(gateway.calls("agents.update")).toEqual([]);
    client.stop();
  });

  it("F-552: no read on a connection that can't rename or for the default bot; a bot not made in New bot gets a card, and a file too long is read once", async () => {
    for (const held of [READ_SCOPES, INTERACTIVE_SCOPES]) {
      const { gateway, takeName } = namingGateway();
      takeName("Johnny");
      const { client } = await openTask({ gateway, storage: adminStorage(held), held, key: KEY });
      endRun(gateway);
      await sleep(50);
      expect(reads(gateway), held.join()).toBe(0);
      expect(client.state.botNames ?? []).toEqual([]);
      client.stop();
    }

    const { gateway } = namingGateway(() => "# IDENTITY.md\n\n- **Name:** Johnny\n");
    const { client } = await openTask({
      gateway,
      storage: adminStorage(),
      held: ADMIN_SCOPES,
      key: KEY,
    });
    client.openSession("agent:main:main");
    endRun(gateway, "agent:main:main");
    endRun(gateway);
    // The gateway's own file, not New bot's: a card all the same. The default bot is not read.
    await until(() => (client.state.botNames ?? []).length === 1);
    expect(client.state.botNames![0]).toMatchObject({ name: "Johnny", from: "New bot" });
    expect(gateway.calls("agents.files.get")).toEqual([
      { agentId: "new-bot", name: "IDENTITY.md" },
    ]);
    // A file too long to read for a name: read once, the card gone, then left alone.
    gateway.handlers["agents.files.get"] = () => ({
      file: { missing: false, content: "x".repeat(MAX_IDENTITY_CHARS + 1), hash: "a".repeat(64) },
    });
    endRun(gateway);
    await until(() => (client.state.botNames ?? []).length === 0);
    endRun(gateway);
    await sleep(50);
    expect(reads(gateway)).toBe(2);
    client.stop();
  });

  it("F-552: a host that only reads, as the iPhone app's, reads nothing and can't rename", async () => {
    const { gateway, takeName } = namingGateway();
    takeName("Johnny");
    const { client } = await openTask({
      gateway,
      storage: adminStorage(),
      held: ADMIN_SCOPES,
      key: KEY,
      client: { readOnly: true },
    });
    endRun(gateway);
    await sleep(50);
    expect(reads(gateway)).toBe(0);
    await expect(client.acceptBotName("new-bot", "Johnny", here(client))).rejects.toThrow();
    expect(gateway.calls("agents.update")).toEqual([]);
    client.stop();
  });

  it("F-552: Rename of a bot with a picture leaves the picture in its settings and out of IDENTITY.md", async () => {
    const { gateway, bot, takeName } = namingGateway((name) => identityFile(name, true), {
      picture: true,
    });
    const { client } = await openTask({
      gateway,
      storage: adminStorage(),
      held: ADMIN_SCOPES,
      key: KEY,
    });
    takeName("Johnny");
    endRun(gateway);
    await until(() => (client.state.botNames ?? []).length === 1);
    await client.acceptBotName("new-bot", "Johnny", here(client));
    expect(gateway.calls("agents.update")).toEqual([{ agentId: "new-bot", name: "Johnny" }]);
    // The gateway wrote the picture into the file; it was taken out again, held to that file.
    const [write] = gateway.calls("agents.files.set") as Array<{ expectedHash: string }>;
    expect(gateway.calls("agents.files.set")).toHaveLength(1);
    expect(write!.expectedHash).toMatch(/^[a-f0-9]{64}$/);
    expect(bot.file).not.toMatch(/^- Avatar:/m);
    expect(bot.file).toBe(
      identityFile("New bot", true).replace("- **Name:** New bot", "- Name: Johnny"),
    );
    expect(bot.file.length).toBeLessThan(1_000);
    expect(client.state.botNames).toEqual([]);
    // Its next run reads the short file and finds nothing to ask.
    endRun(gateway);
    await until(() => reads(gateway) === 3);
    await sleep(30);
    expect(client.state.botNames).toEqual([]);
    client.stop();
  });

  it("F-552: Rename announces only what happened: nothing sent for a bot gone, and an unconfirmed name is an error", async () => {
    const { gateway, bot, takeName } = namingGateway();
    const { client } = await openTask({
      gateway,
      storage: adminStorage(),
      held: ADMIN_SCOPES,
      key: KEY,
    });
    takeName("Johnny");
    endRun(gateway);
    await until(() => (client.state.botNames ?? []).length === 1);
    // The bot list doesn't show the new name after the write.
    const list = gateway.handlers["agents.list"]!;
    gateway.handlers["agents.update"] = () => ({ ok: true, agentId: "new-bot" });
    const unconfirmed = await client.acceptBotName("new-bot", "Johnny", here(client)).then(
      () => null,
      (error: Error) => error.message,
    );
    // Said as what happened: the update went out, and the list doesn't show the name.
    expect(unconfirmed).toBe(
      "Rename was sent, but the gateway's bot list doesn't show Johnny yet.",
    );
    expect(unconfirmed).not.toMatch(/saved/i);
    expect(client.state.botNames![0]!.error).toBe(unconfirmed);
    expect(client.state.botNames![0]).toMatchObject({ status: "failed" });
    // The bot is gone when Rename reads the list again: nothing is sent, and it says so.
    gateway.handlers["agents.list"] = () => ({ defaultId: "main", agents: [{ id: "main" }] });
    await expect(client.acceptBotName("new-bot", "Johnny", here(client))).rejects.toThrow(
      /no longer on the gateway, so nothing was sent/,
    );
    expect(gateway.calls("agents.update")).toHaveLength(1);
    gateway.handlers["agents.list"] = list;
    expect(bot.name).toBe("New bot");
    client.stop();
  });

  it("F-552: a run that ends while Rename is out leaves its card until the rename settles", async () => {
    const { gateway, takeName } = namingGateway();
    const { client } = await openTask({
      gateway,
      storage: adminStorage(),
      held: ADMIN_SCOPES,
      key: KEY,
    });
    takeName("Johnny");
    endRun(gateway);
    await until(() => (client.state.botNames ?? []).length === 1);
    const held = deferred<void>();
    const update = gateway.handlers["agents.update"]!;
    gateway.handlers["agents.update"] = async (params) => {
      await held.promise;
      return update(params);
    };
    const renaming = client.acceptBotName("new-bot", "Johnny", here(client));
    await until(() => gateway.calls("agents.update").length === 1);
    // The bot puts its old name back meanwhile, and a run ends.
    takeName("New bot");
    endRun(gateway);
    await until(() => reads(gateway) === 2);
    await sleep(30);
    expect(client.state.botNames).toMatchObject([{ name: "Johnny", status: "renaming" }]);
    held.resolve();
    await renaming;
    expect(client.state.bots.find((each) => each.id === "new-bot")?.name).toBe("Johnny");
    expect(client.state.botNames).toEqual([]);
    client.stop();
  });

  it("F-552: a card left open across a switch of gateway sends nothing to the next one", async () => {
    const { gateway, bot, takeName } = namingGateway();
    const storage = adminStorage();
    const { client } = await openTask({ gateway, storage, held: ADMIN_SCOPES, key: KEY });
    takeName("Johnny");
    endRun(gateway);
    await until(() => (client.state.botNames ?? []).length === 1);
    const onA = here(client);
    // Another gateway, with a bot of the same id whose file names it Johnny too.
    bot.gatewayId = "gw-b";
    storage.data.set(tokenKey(URL_B), storage.data.get(tokenKey(URL_A))!);
    await client.connect({ url: URL_B });
    await until(() => client.state.connection.gatewayId === "gw-b");
    expect(client.state.botNames ?? []).toEqual([]);
    await expect(client.acceptBotName("new-bot", "Johnny", onA)).rejects.toThrow(
      /no longer waiting/,
    );
    client.openSession(KEY);
    await until(() => client.state.transcripts[KEY]?.status === "ready");
    endRun(gateway);
    await until(() => (client.state.botNames ?? []).length === 1);
    // The first gateway's card, clicked late, is not this one's.
    await expect(client.acceptBotName("new-bot", "Johnny", onA)).rejects.toThrow(/another gateway/);
    expect(gateway.calls("agents.update")).toEqual([]);
    client.stop();
  });

  it("F-552: a card read on one gateway sends nothing after the host switches to another address that reports the same id", async () => {
    // Two gateways at two addresses that both say they are "gw-a" (one restored from a copy of
    // the other), each with a bot "new-bot" whose file names it Johnny.
    const a = namingGateway();
    const b = namingGateway();
    a.takeName("Johnny");
    b.takeName("Johnny");
    const storage = adminStorage();
    storage.data.set(tokenKey(URL_B), storage.data.get(tokenKey(URL_A))!);
    const client = new ClawtrateClient(
      {
        ...testHost(a.gateway, storage),
        createWebSocket: (url: string) => (url === URL_B ? b : a).gateway.createWebSocket(url),
      },
      FAST,
    );
    await client.start();
    await until(() => client.state.discovery.status === "ready");
    client.openSession(KEY);
    await until(() => client.state.transcripts[KEY]?.status === "ready");
    endRun(a.gateway);
    await until(() => (client.state.botNames ?? []).length === 1);
    const onA = client.state.botNames![0]!.stamp;
    expect(onA).toEqual(here(client));

    await client.connect({ url: URL_B });
    await until(
      () =>
        client.state.connection.gatewayUrl === URL_B &&
        client.state.connection.gatewayId === "gw-a" &&
        client.state.discovery.status === "ready",
    );
    // The same id, but the host was pointed anew: another target.
    expect(here(client).target).not.toBe(onA.target);
    client.openSession(KEY);
    await until(() => client.state.transcripts[KEY]?.status === "ready");
    endRun(b.gateway);
    await until(() => (client.state.botNames ?? []).length === 1);
    // A's card, clicked late: it isn't B's, so nothing reaches either gateway.
    await expect(client.acceptBotName("new-bot", "Johnny", onA)).rejects.toThrow(
      /found on another gateway, so nothing was sent/,
    );
    for (const fake of [a, b]) {
      expect(fake.gateway.calls("agents.update")).toEqual([]);
      expect(fake.gateway.calls("agents.files.set")).toEqual([]);
    }
    // B's own card renames B's bot.
    await client.acceptBotName("new-bot", "Johnny", here(client));
    expect(b.gateway.calls("agents.update")).toEqual([{ agentId: "new-bot", name: "Johnny" }]);
    expect(a.gateway.calls("agents.update")).toEqual([]);
    client.stop();
  });

  it("F-552: a card read before a dropped connection still renames after it reconnects to the same gateway", async () => {
    const { gateway, takeName } = namingGateway();
    const { client } = await openTask({
      gateway,
      storage: adminStorage(),
      held: ADMIN_SCOPES,
      key: KEY,
    });
    takeName("Johnny");
    endRun(gateway);
    await until(() => (client.state.botNames ?? []).length === 1);
    const card = client.state.botNames![0]!.stamp;
    gateway.dropAll();
    await until(() => client.state.connection.status !== "connected");
    await until(
      () =>
        client.state.connection.status === "connected" && client.state.discovery.status === "ready",
    );
    expect(here(client)).toEqual(card);
    await client.acceptBotName("new-bot", "Johnny", card);
    expect(gateway.calls("agents.update")).toEqual([{ agentId: "new-bot", name: "Johnny" }]);
    client.stop();
  });

  it("F-552: on a gateway that names no identity, no card is drawn and a Rename sends nothing", async () => {
    const { gateway, takeName } = namingGateway();
    gateway.handlers["gateway.identity.get"] = () => ({});
    const { client } = await openTask({
      gateway,
      storage: adminStorage(),
      held: ADMIN_SCOPES,
      key: KEY,
    });
    takeName("Johnny");
    endRun(gateway);
    await until(() => reads(gateway) === 1);
    await sleep(30);
    // A stamp with no identity matches nothing, so nothing read there can be renamed.
    expect(client.state.botNames ?? []).toEqual([]);
    await expect(
      client.acceptBotName("new-bot", "Johnny", { gatewayId: null, target: 0 }),
    ).rejects.toThrow(/no longer waiting/);
    expect(gateway.calls("agents.update")).toEqual([]);
    client.stop();
  });

  it("F-552: a bot whose name is longer than a card's gets no card proposing that name cut short", async () => {
    const long = "Quartermaster of the Northern Supply Routes 2026";
    expect(Array.from(long).length).toBeGreaterThan(MAX_BOT_NAME_CHARS);
    const { gateway, bot } = namingGateway(() => `# IDENTITY.md\n\n- **Name:** ${long}\n`);
    bot.name = long;
    const { client } = await openTask({
      gateway,
      storage: adminStorage(),
      held: ADMIN_SCOPES,
      key: KEY,
    });
    endRun(gateway);
    await until(() => reads(gateway) === 1);
    await sleep(30);
    expect(client.state.botNames ?? []).toEqual([]);
    client.stop();
  });

  it("F-552: when taking the picture out loses its race, the rename stands and the next name still gets a card", async () => {
    const { gateway, bot, takeName } = namingGateway((name) => identityFile(name, true), {
      picture: true,
    });
    const { client } = await openTask({
      gateway,
      storage: adminStorage(),
      held: ADMIN_SCOPES,
      key: KEY,
    });
    takeName("Johnny");
    endRun(gateway);
    await until(() => (client.state.botNames ?? []).length === 1);
    // The file changes between the read after the rename and the write held to it.
    const get = gateway.handlers["agents.files.get"]!;
    let race = false;
    gateway.handlers["agents.files.get"] = (params) => {
      const answer = get(params);
      if (race) {
        race = false;
        bot.file += "\nA line the bot wrote meanwhile.\n";
      }
      return answer;
    };
    const update = gateway.handlers["agents.update"]!;
    gateway.handlers["agents.update"] = (params) => {
      race = true;
      return update(params);
    };
    await client.acceptBotName("new-bot", "Johnny", here(client));
    expect(client.state.bots.find((each) => each.id === "new-bot")?.name).toBe("Johnny");
    expect(bot.file).toMatch(/^- Avatar: data:/m);
    expect(bot.file.length).toBeGreaterThan(MAX_IDENTITY_CHARS);
    // The copied picture isn't counted: the bot's next name gets its card, whose Rename retries.
    takeName("Max");
    endRun(gateway);
    await until(() => (client.state.botNames ?? []).length === 1);
    expect(client.state.botNames![0]).toMatchObject({ name: "Max", from: "Johnny" });
    gateway.handlers["agents.update"] = update;
    await client.acceptBotName("new-bot", "Max", here(client));
    expect(bot.file).not.toMatch(/^- Avatar:/m);
    client.stop();
  });

  it("F-552: a read during which the connection came to answer as another gateway shows no card", async () => {
    let gateway: string | null = "gw-a";
    const held = deferred<void>();
    const published: NameProposal[][] = [];
    const bots: Bot[] = [
      {
        id: "new-bot",
        name: "New bot",
        emoji: null,
        avatarUrl: null,
        theme: null,
        model: null,
        isDefault: false,
      },
    ];
    const names = new BotNames({
      request: async () => {
        await held.promise;
        return { file: { content: identityFile("Johnny", false), hash: "a".repeat(64) } };
      },
      bots: () => bots,
      canRename: () => true,
      gateway: () => gateway,
      stamp: (): GatewayStamp => ({ gatewayId: gateway, target: 1 }),
      sameGateway: async () => {},
      storage: memoryStorage(),
      takeRead: () => () => {},
      refreshBots: async () => {},
      missingScope: () => false,
      publish: (each) => published.push(each),
      log: () => {},
    });
    const read = names.afterRun("new-bot");
    // The same address now answers as another gateway, with a bot of the same id.
    gateway = "gw-b";
    held.resolve();
    await read;
    expect(published).toEqual([]);
    // The next read is that gateway's, and its card says so.
    await names.afterRun("new-bot");
    expect(published.at(-1)).toMatchObject([
      { name: "Johnny", stamp: { gatewayId: "gw-b", target: 1 } },
    ]);
  });

  it("F-552: a late Not now for an earlier name keeps the later one declined", async () => {
    const { gateway, takeName } = namingGateway();
    const storage = adminStorage();
    const { client } = await openTask({ gateway, storage, held: ADMIN_SCOPES, key: KEY });
    takeName("Johnny");
    endRun(gateway);
    await until(() => (client.state.botNames ?? []).length === 1);
    takeName("Scout");
    endRun(gateway);
    await until(() => client.state.botNames?.[0]?.name === "Scout");
    await client.declineBotName("new-bot", "Scout");
    // Not now from a view still showing the Johnny card arrives after.
    await client.declineBotName("new-bot", "Johnny");
    expect(storage.data.get(NAME_DECLINES_KEY)).toBe(
      JSON.stringify({ ["gw-a\nnew-bot"]: "Scout" }),
    );
    endRun(gateway);
    await until(() => reads(gateway) === 3);
    await sleep(30);
    expect(client.state.botNames ?? []).toEqual([]);
    client.stop();
  });

  it("F-552: a Rename cut off by a reset sends nothing and leaves the next gateway's card alone", async () => {
    const listed = deferred<void>();
    let bots: Bot[] = [{ ...BOT, name: "New bot" }];
    const requests: string[] = [];
    const names = engine({
      bots: () => bots,
      request: async (method) => {
        requests.push(method);
        return { file: { content: identityFile("Johnny", false), hash: "a".repeat(64) } };
      },
      refreshBots: () => listed.promise,
    });
    await names.ctxRun();
    const renaming = names.engine.accept("new-bot", "Johnny", STAMP).then(
      () => null,
      (error: Error) => error.message,
    );
    // Another gateway meanwhile, whose bot of the same id has another name and its own card.
    names.engine.reset();
    bots = [{ ...BOT, name: "Scout" }];
    await names.ctxRun();
    expect(names.published.at(-1)).toMatchObject([{ name: "Johnny", from: "Scout" }]);
    listed.resolve();
    expect(await renaming).toBe("The connection changed, so nothing was sent.");
    expect(requests).not.toContain("agents.update");
    expect(names.published.at(-1)).toMatchObject([{ name: "Johnny", from: "Scout" }]);
  });

  it("F-552: the cleanup read waits for a free file read like every other, and the rename stands", async () => {
    let free = 1;
    const requests: string[] = [];
    const names = engine({
      request: async (method) => {
        requests.push(method);
        return { file: { content: identityFile("Johnny", false), hash: "a".repeat(64) } };
      },
      takeRead: () => {
        if (free === 0) return null;
        free -= 1;
        return () => void (free += 1);
      },
    });
    await names.ctxRun();
    expect(requests).toEqual(["agents.files.get"]);
    // Every read is in use when the update lands: the cleanup read isn't sent.
    free = 0;
    const bots = names.bots;
    names.onUpdate = () => (bots[0] = { ...bots[0]!, name: "Johnny" });
    await names.engine.accept("new-bot", "Johnny", STAMP);
    expect(requests).toEqual(["agents.files.get", "agents.update"]);
  });

  it("F-552: Suspend drops the cards and the files skipped, and a reconnect reads afresh", async () => {
    const { gateway, bot, takeName } = namingGateway();
    const { client } = await openTask({
      gateway,
      storage: adminStorage(),
      held: ADMIN_SCOPES,
      key: KEY,
    });
    // A file too long: read once, then skipped on this target.
    const short = bot.file;
    bot.file = short + "x".repeat(MAX_IDENTITY_CHARS);
    endRun(gateway);
    await until(() => reads(gateway) === 1);
    bot.file = short;
    takeName("Johnny");
    endRun(gateway);
    await sleep(50);
    expect(reads(gateway)).toBe(1);
    await client.suspend();
    await client.retryNow();
    await until(
      () =>
        client.state.connection.status === "connected" && client.state.discovery.status === "ready",
    );
    client.openSession(KEY);
    endRun(gateway);
    await until(() => (client.state.botNames ?? []).length === 1);
    // Pointed anew: that card is gone with it.
    await client.suspend();
    expect(client.state.botNames ?? []).toEqual([]);
    client.stop();
  });

  it("F-552: a run that ends after its task was closed reads nothing, though the task is kept for its message", async () => {
    const { gateway, takeName } = namingGateway();
    const { client } = await openTask({
      gateway,
      storage: adminStorage(),
      held: ADMIN_SCOPES,
      key: KEY,
    });
    takeName("Johnny");
    client.sendMessage(KEY, "Hi");
    await until(() => gateway.calls("chat.send").length === 1);
    client.closeSession(KEY);
    endRun(gateway);
    await sleep(80);
    expect(reads(gateway)).toBe(0);
    expect(client.state.botNames ?? []).toEqual([]);
    client.stop();
  });

  it("F-552: markup, control characters, line breaks and a 10,000-character name are bounded and kept as plain text", async () => {
    expect(plainName("<b>Jo</b>\u0000\u0007hn\nny\r\n\u2028 *x*")).toBe("<b>Jo</b> hn ny *x*");
    expect(plainName(" \n\t\u0000 ")).toBeNull();
    // Direction controls and invisible spaces go; the joiners emoji need stay.
    expect(plainName("Johnny\u202egnp.exe")).toBe("Johnnygnp.exe");
    expect(plainName("Ot\u200bto")).toBe("Otto");
    expect(plainName("\u2067Jo\u2069\u200e\u200f\u061c\u2060\ufeffhn")).toBe("John");
    expect(plainName("👩\u200d💻")).toBe("👩\u200d💻");
    expect(plainName("\u202e\u200b")).toBeNull();
    // As many cards as the state lists bots.
    expect(MAX_NAME_CARDS).toBe(MAX_BOTS);
    expect(plainName("J".repeat(10_000))).toBe("J".repeat(MAX_BOT_NAME_CHARS));
    // A cut never splits a character in two.
    expect(plainName("🦀".repeat(50))).toBe("🦀".repeat(MAX_BOT_NAME_CHARS));
    // Read as the gateway reads it: the last `Name` line, emphasis off, a placeholder skipped.
    expect(identityName("- **Name:** Pip\n- Name: _Scout_\n")).toBe("Scout");
    expect(identityName("- **Name:** _(pick something you like)_\n")).toBeNull();
    for (const picture of [false, true])
      expect(identityName(identityFile("Maple", picture)), String(picture)).toBe("Maple");

    const { gateway, bot } = namingGateway();
    const { client } = await openTask({
      gateway,
      storage: adminStorage(),
      held: ADMIN_SCOPES,
      key: KEY,
    });
    bot.file = bot.file.replace(
      /^- \*\*Name:\*\* .*$/m,
      `- **Name:** <img src=x onerror=alert(1)>\u0007${"y".repeat(10_000)}`,
    );
    endRun(gateway);
    await until(() => (client.state.botNames ?? []).length === 1);
    const name = client.state.botNames![0]!.name;
    const markup = "<img src=x onerror=alert(1)> ";
    expect(name).toBe(markup + "y".repeat(MAX_BOT_NAME_CHARS - markup.length));
    expect(Array.from(name)).toHaveLength(MAX_BOT_NAME_CHARS);
    await client.acceptBotName("new-bot", name, here(client));
    expect(gateway.calls("agents.update")).toEqual([{ agentId: "new-bot", name }]);

    // A file longer than an identity file gets no card.
    bot.file = identityFile("Pip", false) + "x".repeat(MAX_IDENTITY_CHARS);
    endRun(gateway);
    await until(() => reads(gateway) === 3);
    await sleep(30);
    expect(client.state.botNames).toEqual([]);
    client.stop();
  });
});
