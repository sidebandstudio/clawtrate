// #799: a bot's chosen model on the model list that limits it, and Undo.
import { describe, expect, it } from "vitest";
import {
  allowAddition,
  type AllowAddition,
  allowRemoval,
  botModelRef,
  listAllows,
  ownModelRefused,
} from "../src/model-allow.ts";
import { INTERACTIVE_SCOPES } from "../src/scopes.ts";
import { AccountsEngine } from "../src/accounts-engine.ts";
import {
  initialAccountsState,
  MAX_ALLOWLIST_ENTRIES,
  type AccountsState,
} from "../src/accounts.ts";
import { AccountsGateway, accountsClient } from "./accounts-fake.ts";

const V10 = "2026.10.6";
const V11 = "2026.11.10";
const MIGRATED = { meta: { migrations: { modelPolicyAllowlist: true } } };
const cfg = (config: Record<string, unknown>) => ({
  hash: "h1",
  config: { ...MIGRATED, ...config },
});
const gpt = { provider: "openai", model: "gpt-5.5" };
/** The line the screens show after Otto's model `acme/dev-2` was added: Undo is for it. */
const SHOWN = { botId: "otto", entry: "acme/dev-2" };

describe("F-042: which list a chosen model goes on (#799)", () => {
  it("the bot's own list, when it has one: only that entry appended, nothing else", () => {
    const config = cfg({
      agents: {
        defaults: { modelPolicy: { allow: ["acme/dev-1"] } },
        entries: {
          pip: { modelPolicy: { allow: ["acme/dev-2"] } },
          otto: { modelPolicy: { allow: ["acme/dev-3"] } },
        },
      },
    });
    expect(allowAddition(config, "pip", gpt, V11)).toEqual({
      patch: {
        agents: { entries: { pip: { modelPolicy: { allow: ["acme/dev-2", "openai/gpt-5.5"] } } } },
      },
      replacePaths: ["agents.entries.pip.modelPolicy.allow"],
      entry: "openai/gpt-5.5",
      place: "bot",
    });
  });

  it("else the gateway's default list; another bot's list is never touched", () => {
    const config = cfg({
      agents: {
        defaults: { modelPolicy: { allow: ["acme/dev-1", 7, ""] } },
        entries: { otto: { modelPolicy: { allow: ["acme/dev-3"] } } },
      },
    });
    const added = allowAddition(config, "pip", gpt, V10) as AllowAddition;
    expect(added.patch).toEqual({
      agents: { defaults: { modelPolicy: { allow: ["acme/dev-1", 7, "", "openai/gpt-5.5"] } } },
    });
    expect(JSON.stringify(added.patch)).not.toContain("otto");
    expect(added.place).toBe("gateway");
  });

  it("else, on a config never migrated, the old models map, by one key", () => {
    const config = {
      hash: "h",
      config: { agents: { defaults: { models: { "acme/dev-1": { alias: "dev" } } } } },
    };
    expect(allowAddition(config, "pip", gpt, V10)).toEqual({
      patch: { agents: { defaults: { models: { "openai/gpt-5.5": {} } } } },
      replacePaths: [],
      entry: "openai/gpt-5.5",
      place: "models",
    });
  });

  it("never a list where none limits the bot: none, an empty one, or a migrated config's map", () => {
    for (const config of [
      cfg({}),
      cfg({ agents: { defaults: { modelPolicy: { allow: [] } } } }),
      cfg({ agents: { defaults: { modelPolicy: { allow: ["  "] } } } }),
      cfg({
        agents: {
          entries: { pip: { modelPolicy: { allow: [] } } },
          defaults: { modelPolicy: { allow: ["acme/dev-1"] } },
        },
      }),
      cfg({ agents: { defaults: { models: { "acme/dev-1": {} } } } }),
      null,
    ])
      expect(allowAddition(config, "pip", gpt, V11)).toBeNull();
  });

  it("never when the list already allows it, as each version reads it", () => {
    const allows = (entries: string[], version: string | null) =>
      allowAddition(
        cfg({ agents: { defaults: { modelPolicy: { allow: entries } } } }),
        "pip",
        gpt,
        version,
      ) === null;
    for (const version of [V10, V11, null]) {
      expect(allows(["openai/gpt-5.5"], version)).toBe(true);
      expect(allows(["OpenAI/gpt-5.5"], version)).toBe(true);
      expect(allows([" openai/gpt-5.5 "], version)).toBe(true);
      expect(allows(["openai/*"], version)).toBe(true);
      expect(allows(["openai/gpt-5.4"], version)).toBe(false);
      expect(allows(["anthropic/*"], version)).toBe(false);
      // The model as written: another case is one exact entry more, never a wider one.
      expect(allows(["openai/GPT-5.5"], version)).toBe(false);
    }
    // A prefix only from 2026.11.10; 2026.10.6 reads it as an exact id that names nothing.
    expect(allows(["openai/gpt-*"], V11)).toBe(true);
    expect(allows(["openai/gpt-*"], V10)).toBe(false);
    expect(allows(["openai/gpt-*"], null)).toBe(false);
    expect(
      listAllows(["openrouter/anthropic/*"], { provider: "openrouter", model: "anthropic/x" }, V10),
    ).toBe(true);
    expect(
      listAllows(["openrouter/anthropic/*"], { provider: "openrouter", model: "openai/x" }, V11),
    ).toBe(false);
  });

  it("never a wildcard or another model: exactly the chosen provider/model, without its account", () => {
    const config = cfg({ agents: { defaults: { modelPolicy: { allow: ["acme/dev-1"] } } } });
    const added = allowAddition(
      config,
      "pip",
      { provider: "openai", model: "gpt-5.5" },
      V11,
    ) as AllowAddition;
    const allow = (added.patch as { agents: { defaults: { modelPolicy: { allow: string[] } } } })
      .agents.defaults.modelPolicy.allow;
    expect(allow).toEqual(["acme/dev-1", "openai/gpt-5.5"]);
    expect(allow.some((entry) => entry.includes("*") || entry.includes("@"))).toBe(false);
  });
});

describe("F-042: Undo takes out that one entry, only while it is there (#799)", () => {
  it("the entry, and nothing else, from the list that governs the bot", () => {
    const config = cfg({
      agents: {
        defaults: { modelPolicy: { allow: ["acme/dev-1", "openai/gpt-5.5", "acme/dev-2"] } },
      },
    });
    expect(allowRemoval(config, "pip", "openai/gpt-5.5", "gateway")).toEqual({
      patch: { agents: { defaults: { modelPolicy: { allow: ["acme/dev-1", "acme/dev-2"] } } } },
      replacePaths: ["agents.defaults.modelPolicy.allow"],
    });
  });

  it("nothing when it is gone, and never the last entry, which would lift the limit", () => {
    expect(
      allowRemoval(
        cfg({ agents: { defaults: { modelPolicy: { allow: ["acme/dev-1"] } } } }),
        "pip",
        "openai/gpt-5.5",
        "gateway",
      ),
    ).toBe("gone");
    expect(allowRemoval(cfg({}), "pip", "openai/gpt-5.5", "gateway")).toBe("gone");
    expect(
      allowRemoval(
        cfg({ agents: { defaults: { modelPolicy: { allow: ["openai/gpt-5.5"] } } } }),
        "pip",
        "openai/gpt-5.5",
        "gateway",
      ),
    ).toBe("last");
    // The old models map on a config never migrated: its key, and never its last one.
    const old = (models: Record<string, unknown>) => ({
      hash: "h",
      config: { agents: { defaults: { models } } },
    });
    expect(
      allowRemoval(
        old({ "acme/dev-1": {}, "openai/gpt-5.5": {} }),
        "pip",
        "openai/gpt-5.5",
        "models",
      ),
    ).toEqual({
      patch: { agents: { defaults: { models: { "openai/gpt-5.5": null } } } },
      replacePaths: [],
    });
    expect(allowRemoval(old({ "openai/gpt-5.5": {} }), "pip", "openai/gpt-5.5", "models")).toBe(
      "last",
    );
    expect(allowRemoval(old({ "acme/dev-1": {} }), "pip", "openai/gpt-5.5", "models")).toBe("gone");
    // Moved to the bot's own list since: not the list it was added to.
    expect(
      allowRemoval(
        cfg({
          agents: {
            defaults: { modelPolicy: { allow: ["acme/dev-1", "openai/gpt-5.5"] } },
            entries: { pip: { modelPolicy: { allow: ["acme/dev-2"] } } },
          },
        }),
        "pip",
        "openai/gpt-5.5",
        "gateway",
      ),
    ).toBe("gone");
  });
});

describe("F-042: a bot whose own model its list refuses (#799)", () => {
  it("its own model, else the default; its account dropped", () => {
    const config = cfg({
      agents: {
        defaults: { model: { primary: "acme/dev-1" }, modelPolicy: { allow: ["acme/dev-1"] } },
        entries: { pip: { model: { primary: "openai/gpt-5.5@openai:work" } }, otto: {} },
      },
    });
    expect(botModelRef(config, "pip")).toEqual(gpt);
    expect(ownModelRefused(config, "pip", V11)).toEqual(gpt);
    expect(ownModelRefused(config, "otto", V11)).toBeNull();
  });
});

// The engine: the model write, "Allow <model>" and Undo, against the fake gateway.
type Patch = { raw: string; baseHash?: string; replacePaths?: string[] };
const patches = (fake: AccountsGateway) => fake.gateway.calls("config.patch") as Patch[];
const defaults = (fake: AccountsGateway) =>
  (fake.config.agents as { defaults: Record<string, unknown> }).defaults;
const entries = (fake: AccountsGateway) =>
  (fake.config.agents as { entries: Record<string, Record<string, unknown>> }).entries;
/** The gateway's default list, as the migration leaves a list of exact models. */
function limited(fake: AccountsGateway, allow: string[]) {
  defaults(fake).modelPolicy = { allow };
  fake.config.meta = { migrations: { modelPolicyAllowlist: true } };
}

describe("F-042: setting a bot's model puts it on the list that limits the bot (#799)", () => {
  it("in the same write as the model, with the line, and Undo takes out that entry alone", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-1"]);
    const { client, accounts } = await accountsClient({ gateway: fake });
    await client.setBotModel("otto", "dev-2", null);
    const writes = patches(fake);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!.raw)).toEqual({
      agents: {
        entries: { otto: { model: { primary: "acme/dev-2@acme:work", fallbacks: [] } } },
        defaults: { modelPolicy: { allow: ["acme/dev-1", "acme/dev-2"] } },
      },
    });
    expect(writes[0]!.replacePaths).toEqual([
      "agents.entries.otto.model.fallbacks",
      "agents.defaults.modelPolicy.allow",
    ]);
    expect(accounts().allowed).toMatchObject({
      botId: "otto",
      entry: "acme/dev-2",
      scope: "gateway",
      status: "added",
    });
    // Someone adds a model meanwhile; Undo keeps it and the model, and takes out its own entry.
    limited(fake, ["acme/dev-1", "acme/dev-2", "acme/dev-3"]);
    fake.revision += 1;
    await client.undoModelAllowed(SHOWN);
    expect(defaults(fake).modelPolicy).toEqual({ allow: ["acme/dev-1", "acme/dev-3"] });
    expect((entries(fake).otto!.model as { primary: string }).primary).toBe("acme/dev-2@acme:work");
    expect(patches(fake).at(-1)!.baseHash).toBe(`h${fake.revision - 1}`);
    expect(accounts().allowed?.status).toBe("undone");
    // Refused again: the bot's own model is off the list.
    expect(accounts().modelsRefused).toEqual([{ botId: "otto", provider: "acme", model: "dev-2" }]);
    client.stop();
  });

  it("an account change that moves the model does the same; a model the list allows adds nothing", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-1", "acme/dev-2"]);
    const { client, accounts } = await accountsClient({ gateway: fake });
    await client.changeBotAccount("otto", "acme:home", "acme", "dev-2", null);
    expect(JSON.parse(patches(fake).at(-1)!.raw).agents.defaults).toBeUndefined();
    expect(accounts().allowed).toBeNull();
    limited(fake, ["acme/dev-1"]);
    await client.changeBotAccount("otto", "acme:home", "acme", "dev-2", null);
    expect(defaults(fake).modelPolicy).toEqual({ allow: ["acme/dev-1", "acme/dev-2"] });
    client.stop();
  });

  it("no list where none was, and nothing on another bot's list", async () => {
    const fake = new AccountsGateway();
    entries(fake).pip!.modelPolicy = { allow: ["acme/dev-1"] };
    const { client } = await accountsClient({ gateway: fake });
    await client.setBotModel("otto", "dev-2", null);
    const raw = JSON.parse(patches(fake).at(-1)!.raw);
    expect(raw).toEqual({
      agents: { entries: { otto: { model: { primary: "acme/dev-2@acme:work", fallbacks: [] } } } },
    });
    expect(defaults(fake).modelPolicy).toBeUndefined();
    expect(entries(fake).pip!.modelPolicy).toEqual({ allow: ["acme/dev-1"] });
    client.stop();
  });

  it("a refused model write writes no list either", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-1"]);
    const { client, accounts } = await accountsClient({ gateway: fake });
    fake.failPatch = "invalid model";
    await expect(client.setBotModel("otto", "dev-2", null)).rejects.toThrow("invalid model");
    expect(defaults(fake).modelPolicy).toEqual({ allow: ["acme/dev-1"] });
    expect(accounts().allowed).toBeNull();
    client.stop();
  });

  it("Undo writes nothing once the entry is gone, and never takes out an entry it didn't add", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-1"]);
    const { client, accounts } = await accountsClient({ gateway: fake });
    await client.setBotModel("otto", "dev-2", null);
    limited(fake, ["acme/dev-1"]);
    const before = patches(fake).length;
    await client.undoModelAllowed(SHOWN);
    expect(patches(fake)).toHaveLength(before);
    expect(accounts().allowed?.status).toBe("kept");
    client.stop();
  });

  it("Undo is held to the hash it read: a config changed in between is refused, and nothing changes", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-1"]);
    const { client, accounts } = await accountsClient({ gateway: fake });
    await client.setBotModel("otto", "dev-2", null);
    const get = fake.gateway.handlers["config.get"]!;
    fake.gateway.handlers["config.get"] = (params) => {
      const answer = get(params);
      fake.revision += 1;
      fake.gateway.handlers["config.get"] = get;
      return answer;
    };
    await expect(client.undoModelAllowed(SHOWN)).rejects.toThrow("config changed");
    expect(defaults(fake).modelPolicy).toEqual({ allow: ["acme/dev-1", "acme/dev-2"] });
    expect(accounts().allowed?.status).toBe("failed");
    client.stop();
  });
});

describe("F-042 F-587: Allow <model>, for a bot whose own model its list refuses (#799)", () => {
  it("is read with the accounts, and one press writes the entry and shows the same line", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-2"]);
    const { client, accounts } = await accountsClient({ gateway: fake });
    expect(accounts().modelsRefused).toEqual([
      // The default bot runs on the gateway's default model, off the list too.
      { botId: "main", provider: "acme", model: "dev-1" },
      { botId: "otto", provider: "acme", model: "dev-1" },
      { botId: "pip", provider: "acme", model: "dev-1" },
    ]);
    await client.allowBotModel("otto");
    expect(JSON.parse(patches(fake).at(-1)!.raw)).toEqual({
      agents: { defaults: { modelPolicy: { allow: ["acme/dev-2", "acme/dev-1"] } } },
    });
    expect(accounts().allowed).toMatchObject({
      botId: "otto",
      entry: "acme/dev-1",
      status: "added",
    });
    // The gateway's default list: every bot on that model is allowed now.
    expect(accounts().modelsRefused).toEqual([]);
    // Pressed again, with nothing refused: nothing is written.
    const before = patches(fake).length;
    await client.allowBotModel("otto");
    expect(patches(fake)).toHaveLength(before);
    client.stop();
  });

  it("is never written without admin access, and asks for none", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-2"]);
    const { client } = await accountsClient({ gateway: fake, scopes: INTERACTIVE_SCOPES });
    await expect(client.allowBotModel("otto")).rejects.toThrow(/admin/i);
    await expect(client.undoModelAllowed(SHOWN)).rejects.toThrow(/admin/i);
    expect(patches(fake)).toHaveLength(0);
    client.stop();
  });
});

// Review of #910: each case where a line or its Undo could act on what it wasn't read from.
describe("F-042: a line and its Undo act only on what they were read from (#799)", () => {
  it("Undo takes the entry only out of the list it went on, and never out of another", () => {
    // Went on the gateway's list; the bot has since been given a list of its own holding it too.
    const moved = cfg({
      agents: {
        defaults: { modelPolicy: { allow: ["acme/dev-1", "openai/gpt-5.5"] } },
        entries: { pip: { modelPolicy: { allow: ["openai/gpt-5.5", "acme/dev-3"] } } },
      },
    });
    expect(allowRemoval(moved, "pip", "openai/gpt-5.5", "gateway")).toBe("gone");
    // Went on the bot's own list, which still governs it: out of that list.
    expect(allowRemoval(moved, "pip", "openai/gpt-5.5", "bot")).toEqual({
      patch: { agents: { entries: { pip: { modelPolicy: { allow: ["acme/dev-3"] } } } } },
      replacePaths: ["agents.entries.pip.modelPolicy.allow"],
    });
    // Went on the old models map; the config has since moved it to the default list: not the same.
    const migrated = cfg({
      agents: { defaults: { modelPolicy: { allow: ["acme/dev-1", "openai/gpt-5.5"] } } },
    });
    expect(allowRemoval(migrated, "pip", "openai/gpt-5.5", "models")).toBe("gone");
  });

  it("Undo after the bot got a list of its own writes nothing and says the entry is gone from it", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-1"]);
    const { client, accounts } = await accountsClient({ gateway: fake });
    await client.setBotModel("otto", "dev-2", null);
    expect(accounts().allowed).toMatchObject({ list: "gateway", entry: "acme/dev-2" });
    entries(fake).otto!.modelPolicy = { allow: ["acme/dev-2", "acme/dev-3"] };
    fake.revision += 1;
    const before = patches(fake).length;
    await client.undoModelAllowed(SHOWN);
    expect(patches(fake)).toHaveLength(before);
    expect(accounts().allowed).toMatchObject({ status: "kept", error: "gone" });
    expect(defaults(fake).modelPolicy).toEqual({ allow: ["acme/dev-1", "acme/dev-2"] });
    expect(entries(fake).otto!.modelPolicy).toEqual({ allow: ["acme/dev-2", "acme/dev-3"] });
    client.stop();
  });

  it("Undo is for the line shown: another bot's or an older entry writes nothing", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-1"]);
    const { client, accounts } = await accountsClient({ gateway: fake });
    await client.setBotModel("otto", "dev-2", null);
    const before = patches(fake).length;
    for (const shown of [
      { botId: "pip", entry: "acme/dev-2" },
      { botId: "otto", entry: "acme/dev-3" },
    ])
      await expect(client.undoModelAllowed(shown)).rejects.toThrow(
        "That change is no longer the latest one here, so nothing was undone.",
      );
    expect(patches(fake)).toHaveLength(before);
    expect(accounts().allowed?.status).toBe("added");
    client.stop();
  });

  it("a read that fails after the gateway took the write keeps the line and its Undo", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-1"]);
    const { client, accounts } = await accountsClient({ gateway: fake });
    const get = fake.gateway.handlers["config.get"]!;
    let patched = false;
    const patch = fake.gateway.handlers["config.patch"]!;
    fake.gateway.handlers["config.patch"] = (params) => {
      const answer = patch(params);
      patched = true;
      return answer;
    };
    fake.gateway.handlers["config.get"] = (params) => {
      if (patched) throw new Error("gateway request timeout for config.get");
      return get(params);
    };
    await expect(client.setBotModel("otto", "dev-2", null)).rejects.toThrow(/config\.get/);
    // The gateway took it: the line says so, and Undo takes it out again.
    expect(defaults(fake).modelPolicy).toEqual({ allow: ["acme/dev-1", "acme/dev-2"] });
    expect(accounts().allowed).toMatchObject({ entry: "acme/dev-2", status: "added" });
    fake.gateway.handlers["config.get"] = get;
    await client.undoModelAllowed(SHOWN);
    expect(defaults(fake).modelPolicy).toEqual({ allow: ["acme/dev-1"] });
    expect(accounts().allowed?.status).toBe("undone");
    client.stop();
  });

  it("a list past what Clawtrate writes back still refuses the model, and Allow says why", async () => {
    const fake = new AccountsGateway();
    const full = Array.from({ length: MAX_ALLOWLIST_ENTRIES }, (_, i) => `acme/old-${i}`);
    limited(fake, full);
    const { client, accounts } = await accountsClient({ gateway: fake });
    expect(accounts().modelsRefused.map((each) => each.botId)).toContain("otto");
    await expect(client.allowBotModel("otto")).rejects.toThrow(
      `This gateway's model list has ${MAX_ALLOWLIST_ENTRIES} entries or more, more than Clawtrate writes back, so it wasn't changed.`,
    );
    expect(patches(fake)).toHaveLength(0);
    // The model menu still saves the model, alone.
    await client.setBotModel("otto", "dev-2", null);
    expect(JSON.parse(patches(fake).at(-1)!.raw).agents.defaults).toBeUndefined();
    expect(accounts().allowed).toBeNull();
    client.stop();
  });
});

describe("F-042: a gateway's line and refusals stay with it (#799)", () => {
  /** An engine on the fake gateway's own answers, to reset in the middle of a write. */
  function engineOn(fake: AccountsGateway, during?: (method: string) => void) {
    let state: AccountsState = initialAccountsState;
    const engine: AccountsEngine = new AccountsEngine({
      request: async (method, params) => {
        during?.(method);
        return fake.gateway.handlers[method]!(params);
      },
      readAgain: (read) => read(),
      get: () => state,
      update: (change) => {
        state = change(state);
      },
      bots: () => [{ id: "otto", name: "Otto", isDefault: true, avatarUrl: null }],
      connected: () => true,
      admin: () => true,
      serverVersion: () => "2026.11.10",
      refreshBots: async () => {},
      gateway: async () => "gateway-a",
      gatewayNow: () => "gateway-a",
      readStamp: () => ({ gatewayId: "gateway-a", target: 1, connectedAt: 1 }),
      target: () => 1,
      createMainTask: async () => {},
      now: () => Date.now(),
      randomId: () => "r",
      log: () => {},
    });
    return { engine, state: () => state };
  }

  it("a connection to another gateway clears the line and the refusals", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-2"]);
    const { engine, state } = engineOn(fake);
    await engine.allowModel("otto");
    expect(state().allowed).toMatchObject({ botId: "otto", status: "added" });
    engine.reset();
    expect(state().allowed).toBeNull();
    expect(state().modelsRefused).toEqual([]);
  });

  it("a write that a switch of gateway overtook publishes nothing into the new one", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-2"]);
    const holder: { engine: AccountsEngine | null } = { engine: null };
    const { engine, state } = engineOn(fake, (method) => {
      // The person switches gateway while this one takes the patch.
      if (method === "config.patch") holder.engine!.reset();
    });
    holder.engine = engine;
    await engine.allowModel("otto");
    expect(defaults(fake).modelPolicy).toEqual({ allow: ["acme/dev-2", "acme/dev-1"] });
    expect(state().allowed).toBeNull();
    expect(state().modelsRefused).toEqual([]);
  });
});
