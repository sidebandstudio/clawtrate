// A bot that takes a name in the chat (F-552): the name it writes on its
// IDENTITY.md's `- Name:` line becomes one card, and only the person's Rename
// sends `agents.update`. The files and answers are as a development gateway
// on OpenClaw 2026.10.6 gave them: `agents.update` rewrites the line as
// `- Name: <name>` and the bot list then shows it.

import { describe, expect, it } from "vitest";
import { identityFile } from "../src/accounts-engine.ts";
import {
  identityName,
  MAX_BOT_NAME_CHARS,
  MAX_IDENTITY_CHARS,
  NAME_DECLINES_KEY,
  plainName,
} from "../src/bot-names.ts";
import { ADMIN_SCOPES, INTERACTIVE_SCOPES, READ_SCOPES } from "../src/scopes.ts";
import { agentEvent, openTask, URL_A, grantingGateway } from "./client-harness.ts";
import { GatewayError, memoryStorage, sleep, tokenKey, until } from "./fake-gateway.ts";

const KEY = "agent:new-bot:main";

/** A gateway with the default bot and one New bot made, whose IDENTITY.md the test writes. */
function namingGateway(fileOf: (name: string) => string = (name) => identityFile(name, false)) {
  const gateway = grantingGateway();
  const bot = { name: "New bot", file: fileOf("New bot") };
  gateway.handlers["agents.list"] = () => ({
    defaultId: "main",
    agents: [
      { id: "main", identity: { name: "Juniper" } },
      { id: "new-bot", name: bot.name, identity: { name: bot.name } },
    ],
  });
  gateway.handlers["agents.files.get"] = (params) => {
    const { agentId, name } = params as { agentId: string; name: string };
    if (name !== "IDENTITY.md") throw new Error("only IDENTITY.md is read");
    const content = agentId === "new-bot" ? bot.file : "# IDENTITY.md\n\n- Name: Juniper2\n";
    return { file: { name, missing: false, content, hash: "a".repeat(64) } };
  };
  // As the gateway does: the config's name, and the file's `- Name:` line rewritten.
  gateway.handlers["agents.update"] = (params) => {
    const { name } = params as { name: string };
    bot.name = name;
    bot.file = bot.file.replace(/^- \*{0,2}Name:\*{0,2} .*$/m, `- Name: ${name}`);
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
      { botId: "new-bot", name: "Johnny", from: "New bot", status: "open", error: null },
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
    await client.acceptBotName("new-bot", "Johnny");
    expect(gateway.calls("agents.update")).toEqual([{ agentId: "new-bot", name: "Johnny" }]);
    expect(client.state.bots.find((each) => each.id === "new-bot")?.name).toBe("Johnny");
    expect(client.state.botNames).toEqual([]);
    // The file and the config agree, with one name line: the next run brings no card.
    expect(bot.file.match(/Name:/g)).toHaveLength(2); // the line, and the prose naming it
    expect(identityName(bot.file)).toBe("Johnny");
    endRun(gateway);
    await until(() => reads(gateway) === 2);
    await sleep(30);
    expect(client.state.botNames).toEqual([]);
    // A second Rename of the same card is refused, and sends nothing.
    await expect(client.acceptBotName("new-bot", "Johnny")).rejects.toThrow(/no longer waiting/);
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
    await expect(client.acceptBotName("new-bot", "Johnny2")).rejects.toThrow(/no longer waiting/);
    // Renamed elsewhere since the card was drawn: the read just before sending finds it.
    bot.name = "Scout";
    await expect(client.acceptBotName("new-bot", "Johnny")).rejects.toThrow(
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
    await expect(client.acceptBotName("new-bot", "Johnny")).rejects.toThrow();
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
      JSON.stringify({ [`${URL_A}\nnew-bot`]: "Johnny" }),
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

  it("F-552: no read on a connection that can't rename, nor for the default bot or a bot Clawtrate didn't make", async () => {
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
    await until(() => reads(gateway) === 1);
    // Not Clawtrate's file: no card, and no read again on this connection.
    endRun(gateway);
    await sleep(50);
    expect(reads(gateway)).toBe(1);
    expect(gateway.calls("agents.files.get")).toEqual([
      { agentId: "new-bot", name: "IDENTITY.md" },
    ]);
    expect(client.state.botNames ?? []).toEqual([]);
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
    await expect(client.acceptBotName("new-bot", "Johnny")).rejects.toThrow();
    expect(gateway.calls("agents.update")).toEqual([]);
    client.stop();
  });

  it("F-552: markup, control characters, line breaks and a 10,000-character name are bounded and kept as plain text", async () => {
    expect(plainName("<b>Jo</b>\u0000\u0007hn\nny\r\n\u2028 *x*")).toBe("<b>Jo</b> hn ny *x*");
    expect(plainName(" \n\t\u0000 ")).toBeNull();
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
    await client.acceptBotName("new-bot", name);
    expect(gateway.calls("agents.update")).toEqual([{ agentId: "new-bot", name }]);

    // A file longer than an identity file gets no card.
    bot.file = identityFile("Pip", false) + "x".repeat(MAX_IDENTITY_CHARS);
    endRun(gateway);
    await until(() => reads(gateway) === 2);
    await sleep(30);
    expect(client.state.botNames).toEqual([]);
    client.stop();
  });
});
