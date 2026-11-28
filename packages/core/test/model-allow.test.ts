// #799: a bot's chosen model on the model list that limits it, and Undo.
import { describe, expect, it } from "vitest";
import {
  allowAddition,
  type AllowAddition,
  allowRemoval,
  botModelRef,
  listAllows,
  listVerdict,
  ownModelRefusal,
  withoutProfile,
} from "../src/model-allow.ts";
import { INTERACTIVE_SCOPES } from "../src/scopes.ts";
import { AccountsEngine } from "../src/accounts-engine.ts";
import {
  initialAccountsState,
  MAX_ALLOWLIST_ENTRIES,
  MAX_MODEL_ID_CHARS,
  type AccountsState,
} from "../src/accounts.ts";
import { parseBridgeCommand } from "../src/bridge.ts";
import { AccountsGateway, accountsClient } from "./accounts-fake.ts";
import { until } from "./fake-gateway.ts";

const V10 = "2026.10.6";
const V11 = "2026.11.10";
const MIGRATED = { meta: { migrations: { modelPolicyAllowlist: true } } };
const cfg = (config: Record<string, unknown>) => ({
  hash: "h1",
  config: { ...MIGRATED, ...config },
});
const gpt = { provider: "openai", model: "gpt-5.5" };
/** The addition a screen shows, which its Undo names: its bot and its id. */
const shownOf = (accounts: AccountsState) => ({
  botId: accounts.allowed!.botId,
  id: accounts.allowed!.id,
});
/** Otto's own model in the accounts fake: what "Allow" names for Otto. */
const DEV1 = { provider: "acme", model: "dev-1" };

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

  it("never the old models map of a config never migrated: the refusal says why instead", () => {
    // Every write migrates that map from the config before it, unless one of its keys fails the
    // gateway's own check: a key added there may never take effect, so none is.
    const config = {
      hash: "h",
      config: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5" },
            models: { "acme/dev-1": { alias: "dev" } },
          },
        },
      },
    };
    for (const version of [V10, V11]) {
      expect(allowAddition(config, "pip", gpt, version)).toBe("layout");
      expect(ownModelRefusal(config, "pip", version)).toEqual({ ...gpt, why: "layout" });
    }
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
    // On a version it doesn't know, it can't tell: nothing is written.
    expect(allows(["openai/gpt-*"], null)).toBe(true);
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

/** A JSON merge patch applied as the gateway applies one (arrays whole, null removes). */
function merged(base: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out: Record<string, unknown> =
    base && typeof base === "object" && !Array.isArray(base)
      ? { ...(base as Record<string, unknown>) }
      : {};
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === null) delete out[key];
    else out[key] = merged(out[key], value);
  }
  return out;
}
/** The config after an addition, and the addition: what its Undo takes out. */
function addTo(config: { hash: string; config: Record<string, unknown> }, ref = gpt) {
  const addition = allowAddition(config, "pip", ref, V11) as AllowAddition;
  const after = {
    hash: "h2",
    config: merged(config.config, addition.patch) as Record<string, unknown>,
  };
  return { after, undo: { entry: addition.entry, place: addition.place } };
}

describe("F-042: Undo takes out that one entry, from the list it went on (#799)", () => {
  it("the entry, and nothing else, from the list it went on", () => {
    const { after, undo } = addTo(
      cfg({ agents: { defaults: { modelPolicy: { allow: ["acme/dev-1", "acme/dev-2"] } } } }),
    );
    expect(allowRemoval(after, "pip", undo)).toEqual({
      patch: { agents: { defaults: { modelPolicy: { allow: ["acme/dev-1", "acme/dev-2"] } } } },
      replacePaths: ["agents.defaults.modelPolicy.allow"],
    });
  });

  it("nothing from a config that doesn't hold it so, and never a list's last entry", () => {
    const { undo } = addTo(
      cfg({ agents: { defaults: { modelPolicy: { allow: ["acme/dev-1"] } } } }),
    );
    const list = (allow: unknown[], extra: Record<string, unknown> = {}) =>
      cfg({ agents: { defaults: { modelPolicy: { allow } }, ...extra } });
    // Not there.
    expect(allowRemoval(list(["acme/dev-1"]), "pip", undo)).toBeNull();
    // On a list that no longer decides: the bot has one of its own.
    expect(
      allowRemoval(
        list(["acme/dev-1", "openai/gpt-5.5"], {
          entries: { pip: { modelPolicy: { allow: ["openai/gpt-5.5", "acme/dev-3"] } } },
        }),
        "pip",
        undo,
      ),
    ).toBeNull();
    // Its only entry: taking it out would allow every model.
    expect(allowRemoval(list(["openai/gpt-5.5"]), "pip", undo)).toBeNull();
    // No list governs the bot at all.
    expect(allowRemoval(cfg({}), "pip", undo)).toBeNull();
  });
});

describe("F-042: a bot whose own model its list refuses (#799)", () => {
  it("its own model, else the default; its profile split off as the gateway splits it", () => {
    const config = cfg({
      agents: {
        defaults: { model: { primary: "acme/dev-1" }, modelPolicy: { allow: ["acme/dev-1"] } },
        entries: {
          pip: { model: { primary: "openai/gpt-5.5@openai:work" } },
          otto: {},
          // A short profile, and a quantization that is the model's own.
          fern: { model: { primary: "OpenAI/gpt-5.5@work" } },
          wren: { model: { primary: "ollama/example@q4_k_m" } },
        },
      },
    });
    expect(botModelRef(config, "pip")).toEqual(gpt);
    expect(botModelRef(config, "fern")).toEqual(gpt);
    expect(botModelRef(config, "wren")).toEqual({ provider: "ollama", model: "example@q4_k_m" });
    expect(ownModelRefusal(config, "pip", V11)).toEqual({ ...gpt, why: null });
    expect(ownModelRefusal(config, "otto", V11)).toBeNull();
    expect(withoutProfile("openai/gpt-5.5@work")).toBe("openai/gpt-5.5");
    expect(withoutProfile("ollama/example@q4_k_m@home")).toBe("ollama/example@q4_k_m");
    expect(withoutProfile("acme/dev-1@20250101")).toBe("acme/dev-1@20250101");
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
    // Undo takes out its own entry, keeps the model, and is held to the hash it read.
    const hash = `h${fake.revision}`;
    await client.undoModelAllowed(shownOf(accounts()));
    expect(defaults(fake).modelPolicy).toEqual({ allow: ["acme/dev-1"] });
    expect((entries(fake).otto!.model as { primary: string }).primary).toBe("acme/dev-2@acme:work");
    expect(patches(fake).at(-1)!.baseHash).toBe(hash);
    expect(accounts().allowed?.status).toBe("undone");
    // Refused again: the bot's own model is off the list.
    expect(accounts().modelsRefused).toEqual([
      { botId: "otto", provider: "acme", model: "dev-2", why: null },
    ]);
    client.stop();
  });

  it("Undo after someone changed that list writes nothing: the entry there may be theirs", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-1"]);
    const { client, accounts } = await accountsClient({ gateway: fake });
    await client.setBotModel("otto", "dev-2", null);
    // Someone adds a model meanwhile.
    limited(fake, ["acme/dev-1", "acme/dev-2", "acme/dev-3"]);
    fake.revision += 1;
    const before = patches(fake).length;
    await client.undoModelAllowed(shownOf(accounts()));
    expect(patches(fake)).toHaveLength(before);
    expect(accounts().allowed).toMatchObject({ status: "changed" });
    expect(defaults(fake).modelPolicy).toEqual({
      allow: ["acme/dev-1", "acme/dev-2", "acme/dev-3"],
    });
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
    await client.undoModelAllowed(shownOf(accounts()));
    expect(patches(fake)).toHaveLength(before);
    expect(accounts().allowed?.status).toBe("changed");
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
    await expect(client.undoModelAllowed(shownOf(accounts()))).rejects.toThrow("config changed");
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
      { botId: "main", provider: "acme", model: "dev-1", why: null },
      { botId: "otto", provider: "acme", model: "dev-1", why: null },
      { botId: "pip", provider: "acme", model: "dev-1", why: null },
    ]);
    await client.allowBotModel("otto", DEV1);
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
    await client.allowBotModel("otto", DEV1);
    expect(patches(fake)).toHaveLength(before);
    client.stop();
  });

  it("is never written without admin access, and asks for none", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-2"]);
    const { client } = await accountsClient({ gateway: fake, scopes: INTERACTIVE_SCOPES });
    await expect(client.allowBotModel("otto", DEV1)).rejects.toThrow(/admin/i);
    await expect(client.undoModelAllowed({ botId: "otto", id: "a" })).rejects.toThrow(/admin/i);
    expect(patches(fake)).toHaveLength(0);
    client.stop();
  });
});

// Review of #910: each case where a line or its Undo could act on what it wasn't read from.
describe("F-042: a line and its Undo act only on what they were read from (#799)", () => {
  it("Undo takes the entry out of the bot's own list when that is the list it went on", () => {
    const { after, undo } = addTo(
      cfg({
        agents: {
          defaults: { modelPolicy: { allow: ["acme/dev-1"] } },
          entries: { pip: { modelPolicy: { allow: ["acme/dev-3"] } } },
        },
      }),
    );
    expect(undo.place).toBe("bot");
    expect(allowRemoval(after, "pip", undo)).toEqual({
      patch: { agents: { entries: { pip: { modelPolicy: { allow: ["acme/dev-3"] } } } } },
      replacePaths: ["agents.entries.pip.modelPolicy.allow"],
    });
  });

  it("Undo after the bot got a list of its own writes nothing, and says the settings changed", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-1"]);
    const { client, accounts } = await accountsClient({ gateway: fake });
    await client.setBotModel("otto", "dev-2", null);
    expect(accounts().allowed).toMatchObject({ scope: "gateway", entry: "acme/dev-2" });
    entries(fake).otto!.modelPolicy = { allow: ["acme/dev-2", "acme/dev-3"] };
    fake.revision += 1;
    const before = patches(fake).length;
    await client.undoModelAllowed(shownOf(accounts()));
    expect(patches(fake)).toHaveLength(before);
    expect(accounts().allowed).toMatchObject({ status: "changed" });
    expect(defaults(fake).modelPolicy).toEqual({ allow: ["acme/dev-1", "acme/dev-2"] });
    expect(entries(fake).otto!.modelPolicy).toEqual({ allow: ["acme/dev-2", "acme/dev-3"] });
    client.stop();
  });

  it("Undo is for the addition shown: an old Undo after it was undone and allowed again writes nothing", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-1"]);
    const { client, accounts } = await accountsClient({ gateway: fake });
    await client.setBotModel("otto", "dev-2", null);
    const first = shownOf(accounts());
    await client.undoModelAllowed(first);
    expect(defaults(fake).modelPolicy).toEqual({ allow: ["acme/dev-1"] });
    // Allowed again, by the press: a new addition of the same entry.
    await client.allowBotModel("otto", { provider: "acme", model: "dev-2" });
    expect(defaults(fake).modelPolicy).toEqual({ allow: ["acme/dev-1", "acme/dev-2"] });
    expect(accounts().allowed!.id).not.toBe(first.id);
    // A viewer's old Undo arrives now: it names the first addition, so nothing is undone.
    const before = patches(fake).length;
    for (const shown of [first, { botId: "pip", id: accounts().allowed!.id }])
      await expect(client.undoModelAllowed(shown)).rejects.toThrow(
        "That change is no longer the latest one here, so nothing was undone.",
      );
    expect(patches(fake)).toHaveLength(before);
    expect(defaults(fake).modelPolicy).toEqual({ allow: ["acme/dev-1", "acme/dev-2"] });
    expect(accounts().allowed?.status).toBe("added");
    client.stop();
  });

  it("a read that fails after the gateway took the write keeps the line, and a read again gives its Undo", async () => {
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
    // The gateway took it: the line says so, with no revision to hold an Undo to yet.
    expect(defaults(fake).modelPolicy).toEqual({ allow: ["acme/dev-1", "acme/dev-2"] });
    expect(accounts().allowed).toMatchObject({
      entry: "acme/dev-2",
      status: "added",
      revision: null,
    });
    fake.gateway.handlers["config.get"] = get;
    // The accounts are read again by themselves: that read's revision is the one Undo is held to.
    await until(() => accounts().allowed?.revision === `h${fake.revision}`);
    await client.undoModelAllowed(shownOf(accounts()));
    expect(defaults(fake).modelPolicy).toEqual({ allow: ["acme/dev-1"] });
    expect(accounts().allowed?.status).toBe("undone");
    client.stop();
  });

  it("saving the same model again after a failed read keeps the line, and ends its Undo", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-1"]);
    const { client, accounts } = await accountsClient({ gateway: fake });
    const get = fake.gateway.handlers["config.get"]!;
    const patch = fake.gateway.handlers["config.patch"]!;
    let failNext = false;
    fake.gateway.handlers["config.patch"] = (params) => {
      const answer = patch(params);
      failNext = true;
      return answer;
    };
    fake.gateway.handlers["config.get"] = (params) => {
      if (failNext) {
        failNext = false;
        throw new Error("gateway request timeout for config.get");
      }
      return get(params);
    };
    await expect(client.setBotModel("otto", "dev-2", null)).rejects.toThrow(/config\.get/);
    const first = shownOf(accounts());
    await until(() => accounts().allowed?.revision !== null);
    // The person saves again: the entry is there already, so nothing is added; the line stays.
    fake.gateway.handlers["config.patch"] = patch;
    await client.setBotModel("otto", "dev-2", "low");
    expect(defaults(fake).modelPolicy).toEqual({ allow: ["acme/dev-1", "acme/dev-2"] });
    expect(shownOf(accounts())).toEqual(first);
    // That save changed the config since the addition: its Undo writes nothing now.
    const before = patches(fake).length;
    await client.undoModelAllowed(first);
    expect(patches(fake)).toHaveLength(before);
    expect(accounts().allowed?.status).toBe("changed");
    expect(defaults(fake).modelPolicy).toEqual({ allow: ["acme/dev-1", "acme/dev-2"] });
    // Another model saved afterwards, which adds nothing, ends the line.
    await client.setBotModel("otto", "dev-1", null);
    expect(accounts().allowed).toBeNull();
    client.stop();
  });

  it("a list past what Clawtrate writes back still refuses the model, and Allow says why", async () => {
    const fake = new AccountsGateway();
    const full = Array.from({ length: MAX_ALLOWLIST_ENTRIES }, (_, i) => `acme/old-${i}`);
    limited(fake, full);
    const { client, accounts } = await accountsClient({ gateway: fake });
    expect(accounts().modelsRefused.map((each) => each.botId)).toContain("otto");
    await expect(client.allowBotModel("otto", DEV1)).rejects.toThrow(
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

/** An engine on the fake gateway's own answers, to reset in the middle of a write. */
function engineOn(
  fake: AccountsGateway,
  during?: (method: string) => void,
  gateway: () => string = () => "gateway-a",
  now: () => number = () => Date.now(),
) {
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
    gateway: async () => gateway(),
    gatewayNow: () => gateway(),
    readStamp: () => ({ gatewayId: "gateway-a", target: 1, connectedAt: 1 }),
    target: () => 1,
    createMainTask: async () => {},
    now,
    randomId: () => `r${Math.random()}`,
    log: () => {},
  });
  return { engine, state: () => state };
}

describe("F-042: a gateway's line and refusals stay with it (#799)", () => {
  it("a connection to another gateway clears the line and the refusals", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-2", "acme/dev-3"]);
    const { engine, state } = engineOn(fake);
    // The accounts read first: Otto's own model is refused, so there is a refusal to clear.
    await engine.load();
    expect(state().modelsRefused).toEqual([{ botId: "otto", ...DEV1, why: null }]);
    await engine.allowModel("otto", DEV1);
    expect(state().allowed).toMatchObject({ botId: "otto", status: "added" });
    // Otto moved to a model the list refuses, read again: a line and a refusal both stand.
    (entries(fake).otto!.model as { primary: string }).primary = "acme/dev-4@acme:work";
    fake.revision += 1;
    await engine.load();
    expect(state().modelsRefused).toEqual([
      { botId: "otto", provider: "acme", model: "dev-4", why: null },
    ]);
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
    await engine.load();
    expect(state().modelsRefused.length).toBeGreaterThan(0);
    await engine.allowModel("otto", DEV1);
    expect(defaults(fake).modelPolicy).toEqual({ allow: ["acme/dev-2", "acme/dev-1"] });
    expect(state().allowed).toBeNull();
    expect(state().modelsRefused).toEqual([]);
  });

  it("Undo on another gateway at the same address writes nothing", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-2"]);
    let gateway = "gateway-a";
    const { engine, state } = engineOn(fake, undefined, () => gateway);
    await engine.load();
    await engine.allowModel("otto", DEV1);
    expect(state().allowed).toMatchObject({ gatewayId: "gateway-a", status: "added" });
    // The same address now answers as another gateway, and no reset came between.
    gateway = "gateway-b";
    const before = patches(fake).length;
    await expect(engine.undoAllowed({ botId: "otto", id: state().allowed!.id })).rejects.toThrow(
      "That change was made on another gateway, so nothing was undone.",
    );
    expect(patches(fake)).toHaveLength(before);
    expect(defaults(fake).modelPolicy).toEqual({ allow: ["acme/dev-2", "acme/dev-1"] });
  });

  it("an Undo the running gateway hasn't applied yet shows no refusal on the next read, until it has", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-2"]);
    const get = fake.gateway.handlers["config.get"]!;
    let lagging = false;
    fake.gateway.handlers["config.get"] = (params) => {
      const answer = get(params) as Record<string, unknown>;
      return lagging ? { ...answer, appliedConfigHash: `r${fake.revision - 1}` } : answer;
    };
    // A clock that moves on fast, so the wait for the applied revision ends at its bound.
    let clock = 0;
    const { engine, state } = engineOn(fake, undefined, undefined, () => (clock += 5_000));
    await engine.load();
    await engine.allowModel("otto", DEV1);
    await engine.load();
    expect(state().modelsRefused).toEqual([]);
    // The removal is saved and taken, and the running gateway hasn't applied it yet.
    const patch = fake.gateway.handlers["config.patch"]!;
    fake.gateway.handlers["config.patch"] = (params) => {
      const answer = patch(params);
      lagging = true;
      return answer;
    };
    await engine.undoAllowed({ botId: "otto", id: state().allowed!.id });
    expect(state().allowed?.status).toBe("undone");
    await engine.load();
    expect(state().modelsRefused).toEqual([]);
    // Once it runs the removal, the next read shows the refusal.
    lagging = false;
    await engine.load();
    expect(state().modelsRefused).toEqual([{ botId: "otto", ...DEV1, why: null }]);
  });

  it("a read of a config the running gateway hasn't applied yet changes no refusal", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-2"]);
    const get = fake.gateway.handlers["config.get"]!;
    let lagging = false;
    fake.gateway.handlers["config.get"] = (params) => {
      const answer = get(params) as Record<string, unknown>;
      // Saved, not yet applied: the running gateway still has the revision before.
      return lagging ? { ...answer, appliedConfigHash: `r${fake.revision - 1}` } : answer;
    };
    const patch = fake.gateway.handlers["config.patch"]!;
    fake.gateway.handlers["config.patch"] = (params) => {
      const answer = patch(params);
      lagging = true;
      return answer;
    };
    // A clock that moves on fast, so the wait for the applied revision ends at its bound.
    let clock = 0;
    const { engine, state } = engineOn(fake, undefined, undefined, () => (clock += 5_000));
    await engine.load();
    expect(state().modelsRefused).toEqual([{ botId: "otto", ...DEV1, why: null }]);
    await engine.allowModel("otto", DEV1);
    // The line says what the gateway took; the refusal stays until a read shows it applied.
    expect(state().allowed).toMatchObject({ entry: "acme/dev-1", status: "added" });
    expect(state().modelsRefused).toEqual([{ botId: "otto", ...DEV1, why: null }]);
  });
});

describe("F-042: Allow, a model choice and a typed id add only what the person chose (#799)", () => {
  it("Allow adds the model its button named, and nothing when the bot has moved on", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-2"]);
    const { client, accounts } = await accountsClient({ gateway: fake });
    // Another admin moves Otto to dev-3, which the list refuses too, before this press arrives.
    (entries(fake).otto!.model as { primary: string }).primary = "acme/dev-3@acme:work";
    fake.revision += 1;
    await expect(client.allowBotModel("otto", DEV1)).rejects.toThrow(
      "The bot's model has changed since this was shown, so nothing was changed.",
    );
    expect(patches(fake)).toHaveLength(0);
    // And the refusal shown is the one true now.
    expect(accounts().modelsRefused.find((each) => each.botId === "otto")).toEqual({
      botId: "otto",
      provider: "acme",
      model: "dev-3",
      why: null,
    });
    client.stop();
  });

  it("a typed pattern is refused before any gateway call, and no addition is ever a pattern", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-2"]);
    const { client } = await accountsClient({ gateway: fake });
    const reads = fake.gateway.calls("config.get").length;
    for (const model of ["*", "dev-*", "dev/*"])
      await expect(client.setBotModel("otto", model, null)).rejects.toThrow("invalid model");
    expect(fake.gateway.calls("config.get")).toHaveLength(reads);
    expect(patches(fake)).toHaveLength(0);
    for (const model of ["*", "dev-*"])
      expect(() =>
        parseBridgeCommand({
          type: "setBotModel",
          botId: "otto",
          model,
          effort: null,
          stamp: { gatewayId: "gateway-a", target: 1 },
        }),
      ).toThrow("invalid model");
    // A model in the config that would be a pattern is never written as an entry.
    expect(
      allowAddition(
        cfg({ agents: { defaults: { modelPolicy: { allow: ["acme/dev-2"] } } } }),
        "pip",
        { provider: "acme", model: "dev-*" },
        V11,
      ),
    ).toBeNull();
    client.stop();
  });

  it("changing only the effort adds nothing to a list", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-2"]);
    const { client, accounts } = await accountsClient({ gateway: fake });
    await client.setBotModel("otto", "dev-1", "low");
    expect(JSON.parse(patches(fake).at(-1)!.raw)).toEqual({
      agents: {
        entries: {
          otto: {
            model: { primary: "acme/dev-1@acme:work", fallbacks: [] },
            thinkingDefault: "low",
          },
        },
      },
    });
    expect(defaults(fake).modelPolicy).toEqual({ allow: ["acme/dev-2"] });
    expect(accounts().allowed).toBeNull();
    client.stop();
  });

  it("a model with an `@` of its own is allowed and undone by its addition's id", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-2"]);
    (entries(fake).otto!.model as { primary: string }).primary = "ollama/example@q4_k_m";
    const { client, accounts } = await accountsClient({ gateway: fake });
    const shown = { provider: "ollama", model: "example@q4_k_m" };
    const stamp = { gatewayId: "gateway-a", target: 1 };
    // As the bridge carries each: the model as the config names it, the Undo by id.
    expect(
      parseBridgeCommand({ type: "allowBotModel", botId: "otto", ...shown, stamp }),
    ).toMatchObject({ model: "example@q4_k_m" });
    await client.allowBotModel("otto", shown);
    expect(defaults(fake).modelPolicy).toEqual({ allow: ["acme/dev-2", "ollama/example@q4_k_m"] });
    const undo = { type: "undoModelAllowed", ...shownOf(accounts()), stamp };
    expect(parseBridgeCommand(undo)).toMatchObject({ id: accounts().allowed!.id });
    await client.undoModelAllowed(shownOf(accounts()));
    expect(defaults(fake).modelPolicy).toEqual({ allow: ["acme/dev-2"] });
    client.stop();
  });

  it("an Undo the gateway took, with the read after it failing, shows the refusal once read again", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-1"]);
    const { client, accounts } = await accountsClient({ gateway: fake });
    await client.setBotModel("otto", "dev-2", null);
    expect(accounts().modelsRefused.find((each) => each.botId === "otto")).toBeUndefined();
    const get = fake.gateway.handlers["config.get"]!;
    const patch = fake.gateway.handlers["config.patch"]!;
    let failNext = false;
    fake.gateway.handlers["config.patch"] = (params) => {
      const answer = patch(params);
      failNext = true;
      return answer;
    };
    fake.gateway.handlers["config.get"] = (params) => {
      if (failNext) {
        failNext = false;
        throw new Error("gateway request timeout for config.get");
      }
      return get(params);
    };
    await client.undoModelAllowed(shownOf(accounts()));
    expect(accounts().allowed?.status).toBe("undone");
    // What it refuses now comes from a read of the running gateway, made again.
    await until(() => accounts().modelsRefused.some((each) => each.botId === "otto"));
    expect(accounts().modelsRefused.find((each) => each.botId === "otto")).toEqual({
      botId: "otto",
      provider: "acme",
      model: "dev-2",
      why: null,
    });
    client.stop();
  });
});

describe("F-042: a list read as the gateway reads it (#799)", () => {
  const aliased = (allow: string[], primary = "openai/gpt-5.5") =>
    cfg({
      agents: {
        defaults: {
          models: { "openai/gpt-5.5": { alias: "workhorse" } },
          modelPolicy: { allow },
        },
        entries: { pip: { model: { primary } } },
      },
    });

  it("whole-segment wildcards with spaces around their segments, on both versions", () => {
    const ref = { provider: "openrouter", model: "anthropic/example" };
    for (const version of [V10, V11]) {
      expect(listVerdict(["openrouter/anthropic / *"], ref, version)).toBe("allows");
      expect(listVerdict([" OpenRouter / anthropic/*"], ref, version)).toBe("allows");
      expect(listVerdict(["openrouter/openai/*"], ref, version)).toBe("refuses");
    }
  });

  it("a configured alias, as a list entry and as the bot's model; a bare name it can't place, unknown", () => {
    expect(ownModelRefusal(aliased(["workhorse"]), "pip", V11)).toBeNull();
    expect(allowAddition(aliased(["workhorse"]), "pip", gpt, V11)).toBeNull();
    // The bot's model given as the alias resolves to the model the list refuses.
    expect(botModelRef(aliased(["acme/dev-1"], "workhorse"), "pip")).toEqual(gpt);
    expect(ownModelRefusal(aliased(["acme/dev-1"], "workhorse"), "pip", V11)).toEqual({
      ...gpt,
      why: null,
    });
    // An alias entry for another model: the list is read whole, and it refuses this one.
    expect(ownModelRefusal(aliased(["workhorse"], "acme/dev-1"), "pip", V11)).toEqual({
      provider: "acme",
      model: "dev-1",
      why: null,
    });
    // A bare entry the config doesn't alias may be a provider's alias: nothing claimed or written.
    expect(ownModelRefusal(aliased(["fastest"]), "pip", V11)).toBeNull();
    expect(allowAddition(aliased(["fastest"]), "pip", gpt, V11)).toBeNull();
  });

  it("a profile suffix, short or long, on the bot's model and on an entry", () => {
    expect(
      ownModelRefusal(aliased(["openai/gpt-5.5"], "openai/gpt-5.5@work"), "pip", V11),
    ).toBeNull();
    expect(listVerdict(["openai/gpt-5.5@work"], gpt, V10)).toBe("allows");
    // An `@` that is part of the model's own id stays.
    expect(
      listVerdict(["ollama/example"], { provider: "ollama", model: "example@q4_k_m" }, V11),
    ).toBe("refuses");
  });
});

// The confirming read of #910, and the automated review on its head: each case, one test.
describe("F-042: aliases, as each version resolves them (#799)", () => {
  const OWN = (models: Record<string, unknown>, primary: string, extra = {}) =>
    cfg({
      agents: {
        defaults: { modelPolicy: { allow: ["acme/dev-1"] }, ...extra },
        entries: { pip: { model: { primary }, models } },
      },
    });

  it("an alias qualified by its model's provider, as an entry and as the bot's model", () => {
    const config = (allow: string[], primary: string) =>
      cfg({
        agents: {
          defaults: {
            models: { "openai/gpt-5.5": { alias: "workhorse" } },
            modelPolicy: { allow },
          },
          entries: { pip: { model: { primary } } },
        },
      });
    // `openai/workhorse` on the list allows the model it names: no refusal, no Allow.
    expect(ownModelRefusal(config(["openai/workhorse"], "openai/gpt-5.5"), "pip", V11)).toBeNull();
    expect(
      allowAddition(config(["openai/workhorse"], "openai/gpt-5.5"), "pip", gpt, V10),
    ).toBeNull();
    // As the bot's model, profile and all: the model it names is what the list refuses.
    expect(botModelRef(config(["acme/dev-1"], "OpenAI/workhorse@work"), "pip")).toEqual(gpt);
    expect(ownModelRefusal(config(["acme/dev-1"], "openai/workhorse"), "pip", V10)).toEqual({
      ...gpt,
      why: null,
    });
    // Qualified by another provider, it names nothing of that alias: read as written.
    expect(botModelRef(config(["acme/dev-1"], "acme/workhorse"), "pip")).toEqual({
      provider: "acme",
      model: "workhorse",
    });
  });

  it("the bot's own aliases, for its model, and for its own list only", () => {
    // Its own map names its model.
    expect(botModelRef(OWN({ "acme/dev-9": { alias: "mine" } }, "mine"), "pip")).toEqual({
      provider: "acme",
      model: "dev-9",
    });
    expect(ownModelRefusal(OWN({ "acme/dev-9": { alias: "mine" } }, "mine"), "pip", V11)).toEqual({
      provider: "acme",
      model: "dev-9",
      why: null,
    });
    const mine = { "openai/gpt-5.5": { alias: "mine" } };
    // Its own list reads its own aliases: `openai/mine` there is gpt-5.5.
    const own = cfg({
      agents: {
        entries: {
          pip: {
            model: { primary: "openai/gpt-5.5" },
            models: mine,
            modelPolicy: { allow: ["openai/mine"] },
          },
        },
      },
    });
    expect(ownModelRefusal(own, "pip", V11)).toBeNull();
    // The gateway's list doesn't: there it names a model called `mine`.
    expect(
      ownModelRefusal(
        OWN(mine, "openai/gpt-5.5", { modelPolicy: { allow: ["openai/mine"] } }),
        "pip",
        V11,
      ),
    ).toEqual({ ...gpt, why: null });
  });

  it("the last row for a model wins, and an empty alias takes it away", () => {
    const two = {
      "openai/gpt-5.4": { alias: "workhorse" },
      "openai/gpt-5.5": { alias: "workhorse" },
    };
    const config = (own: Record<string, unknown>) =>
      cfg({
        agents: {
          defaults: { models: two, modelPolicy: { allow: ["acme/dev-1"] } },
          entries: { pip: { model: { primary: "workhorse" }, models: own } },
        },
      });
    expect(botModelRef(config({}), "pip")).toEqual(gpt);
    expect(botModelRef(config({ "openai/gpt-5.5": { alias: "" } }), "pip")).toEqual({
      provider: "openai",
      model: "gpt-5.4",
    });
  });

  it("an exact row of a configured provider passes over aliases; one the app can't place is unknown", () => {
    const config = (
      extra: Record<string, unknown>,
      primary = "openai/gpt-5.5",
      allow = ["openai/workhorse"],
    ) =>
      cfg({
        ...extra,
        agents: {
          defaults: {
            models: { "openai/gpt-5.5": { alias: "workhorse" } },
            modelPolicy: { allow },
          },
          entries: { pip: { model: { primary } } },
        },
      });
    // `openai/workhorse` is OpenAI's own row here: it names that model, not gpt-5.5.
    const rows = { models: { providers: { OpenAI: { models: [{ id: "workhorse" }] } } } };
    expect(ownModelRefusal(config(rows), "pip", V11)).toEqual({ ...gpt, why: null });
    // A row keyed by a bare name, or an alias with a `/` of its own: the app can't tell.
    const bare = cfg({
      agents: {
        defaults: {
          models: { "gpt-5.5": { alias: "workhorse" } },
          modelPolicy: { allow: ["acme/dev-1"] },
        },
        entries: { pip: { model: { primary: "openai/workhorse" } } },
      },
    });
    expect(botModelRef(bare, "pip")).toBeNull();
    expect(ownModelRefusal(bare, "pip", V11)).toBeNull();
    const slashed = cfg({
      agents: {
        defaults: {
          models: { "openai/gpt-5.5": { alias: "team/fast" } },
          modelPolicy: { allow: ["acme/dev-1"] },
        },
        entries: { pip: { model: { primary: "team/fast" } } },
      },
    });
    expect(botModelRef(slashed, "pip")).toBeNull();
  });

  it("Allow never writes an entry the gateway reads as another model", () => {
    // `openai/gpt-6` is an alias of gpt-7 here, so no exact entry names gpt-6.
    const config = cfg({
      agents: {
        defaults: {
          models: { "openai/gpt-7": { alias: "gpt-6" } },
          modelPolicy: { allow: ["acme/dev-1"] },
        },
        entries: { pip: { model: { primary: "openai/gpt-6" } } },
      },
    });
    expect(botModelRef(config, "pip")).toEqual({ provider: "openai", model: "gpt-7" });
    const six = { provider: "openai", model: "gpt-6" };
    expect(allowAddition(config, "pip", six, V11)).toBeNull();
  });

  it("on 2026.11.10 a prefix matches the model it names whole, too", () => {
    const ref = { provider: "acme", model: "dev-2" };
    expect(listVerdict(["acme/dev-2*"], ref, V11)).toBe("allows");
    expect(listVerdict(["acme/dev-*"], ref, V11)).toBe("allows");
    // 2026.10.6 reads neither as a wildcard.
    expect(listVerdict(["acme/dev-2*"], ref, V10)).toBe("refuses");
  });

  it("Allow names the model an alias resolved to, and writes nothing once the alias names another", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-2"]);
    defaults(fake).models = { "acme/dev-1": { alias: "workhorse" } };
    (entries(fake).otto!.model as { primary: string }).primary = "acme/workhorse@acme:work";
    const { client, accounts } = await accountsClient({ gateway: fake });
    const shown = accounts().modelsRefused.find((each) => each.botId === "otto")!;
    expect(shown).toEqual({ botId: "otto", ...DEV1, why: null });
    // With Settings open, another admin points the alias at another model.
    defaults(fake).models = { "acme/dev-3": { alias: "workhorse" } };
    fake.revision += 1;
    await expect(
      client.allowBotModel("otto", { provider: shown.provider, model: shown.model }),
    ).rejects.toThrow("The bot's model has changed since this was shown, so nothing was changed.");
    expect(patches(fake)).toHaveLength(0);
    // For the model it names now, the entry is that model, never the alias.
    await client.allowBotModel("otto", { provider: "acme", model: "dev-3" });
    expect(defaults(fake).modelPolicy).toEqual({ allow: ["acme/dev-2", "acme/dev-3"] });
    client.stop();
  });
});

describe("F-042: Effort, Undo's revision and the old layout (#799)", () => {
  const stamp = { gatewayId: "gateway-a", target: 1 };

  it("Effort writes the effort alone, for the model it was drawn for, and nothing once that moved", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-2"]);
    const { client } = await accountsClient({ gateway: fake });
    await client.setBotEffort("otto", DEV1, "high");
    expect(JSON.parse(patches(fake).at(-1)!.raw)).toEqual({
      agents: { entries: { otto: { thinkingDefault: "high" } } },
    });
    // Another viewer saves dev-2 before this viewer's Effort press arrives.
    (entries(fake).otto!.model as { primary: string }).primary = "acme/dev-2@acme:work";
    fake.revision += 1;
    const before = patches(fake).length;
    await expect(client.setBotEffort("otto", DEV1, "low")).rejects.toThrow(
      "The bot's model has changed since this was shown, so nothing was changed.",
    );
    expect(patches(fake)).toHaveLength(before);
    expect(defaults(fake).modelPolicy).toEqual({ allow: ["acme/dev-2"] });
    expect(
      parseBridgeCommand({ type: "setBotEffort", botId: "otto", ...DEV1, effort: "high", stamp }),
    ).toEqual({ type: "setBotEffort", botId: "otto", ...DEV1, effort: "high", stamp });
    client.stop();
  });

  it("Undo is bound to the revision after its addition: an identical entry put back by another hand is theirs", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-1"]);
    const { client, accounts } = await accountsClient({ gateway: fake });
    await client.setBotModel("otto", "dev-2", null);
    expect(accounts().allowed).toMatchObject({ status: "added", revision: `h${fake.revision}` });
    // Another admin takes it out and puts it back in the same place: the list reads the same.
    limited(fake, ["acme/dev-1"]);
    fake.revision += 1;
    limited(fake, ["acme/dev-1", "acme/dev-2"]);
    fake.revision += 1;
    const before = patches(fake).length;
    await client.undoModelAllowed(shownOf(accounts()));
    expect(patches(fake)).toHaveLength(before);
    expect(accounts().allowed?.status).toBe("changed");
    expect(defaults(fake).modelPolicy).toEqual({ allow: ["acme/dev-1", "acme/dev-2"] });
    client.stop();
  });

  it("an Undo whose read is out while another hand takes the entry out and puts it back writes nothing", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-2"]);
    let undoing = false;
    const { engine, state } = engineOn(fake, (method) => {
      if (!undoing || method !== "config.get") return;
      undoing = false;
      // While the Undo's read is out: removed and put back, the list reading as it did.
      limited(fake, ["acme/dev-2"]);
      fake.revision += 1;
      limited(fake, ["acme/dev-2", "acme/dev-1"]);
      fake.revision += 1;
    });
    await engine.load();
    await engine.allowModel("otto", DEV1);
    const before = patches(fake).length;
    undoing = true;
    await engine.undoAllowed({ botId: "otto", id: state().allowed!.id });
    expect(patches(fake)).toHaveLength(before);
    expect(state().allowed?.status).toBe("changed");
    expect(defaults(fake).modelPolicy).toEqual({ allow: ["acme/dev-2", "acme/dev-1"] });
  });

  it("a read after the config changed ends Undo before it is pressed; the move case too", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-1"]);
    const { client, accounts } = await accountsClient({ gateway: fake });
    await client.setBotModel("otto", "dev-2", null);
    // An admin gives Otto a list of its own and takes the entry off the gateway's, in one edit.
    entries(fake).otto!.modelPolicy = { allow: ["acme/dev-2"] };
    defaults(fake).modelPolicy = { allow: ["acme/dev-1"] };
    fake.revision += 1;
    await client.refreshAccounts();
    expect(accounts().allowed?.status).toBe("changed");
    client.stop();
  });

  it("the old models layout: the refusal says why, Allow writes nothing, a model choice saves the model alone", async () => {
    const fake = new AccountsGateway();
    defaults(fake).models = { "acme/dev-2": {} };
    const { client, accounts } = await accountsClient({ gateway: fake });
    expect(accounts().modelsRefused.find((each) => each.botId === "otto")).toEqual({
      botId: "otto",
      ...DEV1,
      why: "layout",
    });
    await expect(client.allowBotModel("otto", DEV1)).rejects.toThrow(
      "This gateway's model list is set up in a way Clawtrate doesn't change, so it wasn't changed.",
    );
    expect(patches(fake)).toHaveLength(0);
    await client.setBotModel("otto", "dev-3", null);
    expect(JSON.parse(patches(fake).at(-1)!.raw).agents.defaults).toBeUndefined();
    expect(accounts().allowed).toBeNull();
    client.stop();
  });

  it("a configured id past what the bridge carries: refused, with no Allow, by the one rule both use", () => {
    const long = "x".repeat(MAX_MODEL_ID_CHARS + 1);
    const config = (model: string) =>
      cfg({
        agents: {
          defaults: { modelPolicy: { allow: ["acme/dev-1"] } },
          entries: { pip: { model: { primary: `acme/${model}` } } },
        },
      });
    expect(ownModelRefusal(config(long), "pip", V11)).toEqual({
      provider: "acme",
      model: long,
      why: "long",
    });
    expect(allowAddition(config(long), "pip", { provider: "acme", model: long }, V11)).toBe("long");
    const press = (model: string) =>
      parseBridgeCommand({ type: "allowBotModel", botId: "pip", provider: "acme", model, stamp });
    expect(() => press(long)).toThrow("invalid model");
    const fits = "x".repeat(MAX_MODEL_ID_CHARS);
    expect(ownModelRefusal(config(fits), "pip", V11)).toEqual({
      provider: "acme",
      model: fits,
      why: null,
    });
    expect(press(fits)).toMatchObject({ model: fits });
  });
});

describe("F-042: lost replies, read again, and the gateway the refusals are from (#799)", () => {
  it("a patch whose reply is lost: not confirmed, then made, with Undo, once a read shows its entry", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-2"]);
    const patch = fake.gateway.handlers["config.patch"]!;
    fake.gateway.handlers["config.patch"] = (params) => {
      patch(params);
      throw new Error("gateway request timeout for config.patch");
    };
    const { engine, state } = engineOn(fake);
    await engine.load();
    // Held while it isn't known: the line says so, and offers no Undo.
    const get = fake.gateway.handlers["config.get"]!;
    let hold: (() => void) | null = null;
    fake.gateway.handlers["config.get"] = (params) => {
      if (state().allowed?.status !== "unconfirmed" || hold) return get(params);
      return new Promise((resolve) => (hold = () => resolve(get(params))));
    };
    await engine.allowModel("otto", DEV1);
    expect(state().allowed).toMatchObject({ entry: "acme/dev-1", status: "unconfirmed" });
    await until(() => hold !== null);
    hold!();
    await until(() => state().allowed?.status === "added");
    expect(state().allowed?.revision).toBe(`h${fake.revision}`);
    fake.gateway.handlers["config.patch"] = patch;
    await engine.undoAllowed({ botId: "otto", id: state().allowed!.id });
    expect(defaults(fake).modelPolicy).toEqual({ allow: ["acme/dev-2"] });
  });

  it("a patch whose reply is lost and that wasn't made: the line says so, and the refusal stays", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-2"]);
    fake.gateway.handlers["config.patch"] = () => {
      throw new Error("gateway request timeout for config.patch");
    };
    const { engine, state } = engineOn(fake);
    await engine.load();
    await engine.allowModel("otto", DEV1);
    await until(() => state().allowed?.status === "not-added");
    expect(state().allowed).toMatchObject({ entry: "acme/dev-1", revision: null });
    expect(state().modelsRefused).toEqual([{ botId: "otto", ...DEV1, why: null }]);
  });

  it("an Undo whose reply is lost waits for the applied removal without sending it again", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-2"]);
    const { engine, state } = engineOn(fake);
    await engine.load();
    await engine.allowModel("otto", DEV1);
    expect(state().allowed?.status).toBe("added");
    const patch = fake.gateway.handlers["config.patch"]!;
    const get = fake.gateway.handlers["config.get"]!;
    let sent = 0;
    let recovered = 0;
    fake.gateway.handlers["config.patch"] = (params) => {
      sent += 1;
      patch(params);
      throw new Error("gateway request timeout for config.patch");
    };
    fake.gateway.handlers["config.get"] = (params) => {
      const answer = get(params) as Record<string, unknown>;
      if (!sent) return answer;
      expect(state().allowed?.status).toBe("undoing");
      expect(state().modelsRefused).toEqual([]);
      recovered += 1;
      return recovered === 1 ? { ...answer, appliedConfigHash: `r${fake.revision - 1}` } : answer;
    };
    await engine.undoAllowed({ botId: "otto", id: state().allowed!.id });
    expect(state().allowed?.status).toBe("undone");
    expect(defaults(fake).modelPolicy).toEqual({ allow: ["acme/dev-2"] });
    expect(state().modelsRefused).toEqual([{ botId: "otto", ...DEV1, why: null }]);
    expect(sent).toBe(1);
    expect(recovered).toBe(2);
  });

  it("a lost Undo reply shows changed if the original list still contains the entry", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-2"]);
    const { engine, state } = engineOn(fake);
    await engine.load();
    await engine.allowModel("otto", DEV1);
    fake.gateway.handlers["config.patch"] = () => {
      entries(fake).otto!.modelPolicy = { allow: ["acme/dev-2"] };
      fake.revision += 1;
      throw new Error("gateway request timeout for config.patch");
    };
    await engine.undoAllowed({ botId: "otto", id: state().allowed!.id });
    expect(state().allowed?.status).toBe("changed");
    expect(defaults(fake).modelPolicy).toEqual({ allow: ["acme/dev-2", "acme/dev-1"] });
  });

  it("an alias row past the rows the app reads leaves the list unknown: no refusal, no Allow", () => {
    const rows: Record<string, unknown> = {};
    for (let i = 0; i < MAX_ALLOWLIST_ENTRIES; i += 1) rows[`acme/old-${i}`] = {};
    rows["openai/gpt-5.5"] = { alias: "workhorse" };
    const config = cfg({
      agents: {
        defaults: { models: rows, modelPolicy: { allow: ["openai/workhorse"] } },
        entries: { pip: { model: { primary: "openai/gpt-5.5" } } },
      },
    });
    expect(ownModelRefusal(config, "pip", V11)).toBeNull();
    expect(allowAddition(config, "pip", gpt, V11)).toBeNull();
  });

  it("Effort carries a configured id with an `@` of its own, and writes only the effort", async () => {
    const fake = new AccountsGateway();
    (entries(fake).otto!.model as { primary: string }).primary = "ollama/example@q4_k_m";
    const { client, accounts } = await accountsClient({ gateway: fake });
    const binding = accounts().bindings.find((each) => each.botId === "otto")!;
    const shown = { provider: binding.provider!, model: binding.model! };
    const stamp = { gatewayId: "gateway-a", target: 1 };
    expect(
      parseBridgeCommand({ type: "setBotEffort", botId: "otto", ...shown, effort: "high", stamp }),
    ).toMatchObject({ model: shown.model });
    await client.setBotEffort("otto", shown, "high");
    expect(JSON.parse(patches(fake).at(-1)!.raw)).toEqual({
      agents: { entries: { otto: { thinkingDefault: "high" } } },
    });
    client.stop();
  });

  it("an Undo whose reads after it fail a few times is read again until one lands", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-1"]);
    const { engine, state } = engineOn(fake);
    await engine.load();
    await engine.allowModel("otto", { provider: "acme", model: "dev-1" }).catch(() => {});
    // Otto's own model is allowed already: give it one that is refused, allowed by its press.
    (entries(fake).otto!.model as { primary: string }).primary = "acme/dev-2@acme:work";
    fake.revision += 1;
    await engine.load();
    await engine.allowModel("otto", { provider: "acme", model: "dev-2" });
    expect(state().allowed?.status).toBe("added");
    const get = fake.gateway.handlers["config.get"]!;
    const patch = fake.gateway.handlers["config.patch"]!;
    let failing = 0;
    fake.gateway.handlers["config.patch"] = (params) => {
      const answer = patch(params);
      // The read after it, and the first read again, fail.
      failing = 2;
      return answer;
    };
    fake.gateway.handlers["config.get"] = (params) => {
      if (failing > 0) {
        failing -= 1;
        throw new Error("gateway request timeout for config.get");
      }
      return get(params);
    };
    await engine.undoAllowed({ botId: "otto", id: state().allowed!.id });
    expect(state().allowed?.status).toBe("undone");
    await until(() => state().modelsRefused.length > 0, 6000);
    expect(state().modelsRefused).toEqual([
      { botId: "otto", provider: "acme", model: "dev-2", why: null },
    ]);
  });

  it("an accounts read that began before Allow landed doesn't bring its refusal back", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-2"]);
    const { engine, state } = engineOn(fake);
    await engine.load();
    expect(state().modelsRefused).toEqual([{ botId: "otto", ...DEV1, why: null }]);
    // A read whose config is answered now, and whose other answers come after the press.
    const get = fake.gateway.handlers["config.get"]!;
    const views = fake.gateway.handlers["models.authStatus"]!;
    let release: (() => void) | null = null;
    let first = true;
    fake.gateway.handlers["models.authStatus"] = (params) => {
      if (!first) return views(params);
      first = false;
      return new Promise((resolve) => (release = () => resolve(views(params))));
    };
    const reading = engine.load();
    await until(() => release !== null);
    fake.gateway.handlers["config.get"] = get;
    await engine.allowModel("otto", DEV1);
    expect(state().modelsRefused).toEqual([]);
    release!();
    await reading;
    expect(state().modelsRefused).toEqual([]);
  });

  it("an ordinary read of a config the running gateway hasn't applied keeps the refusals", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-2"]);
    const { engine, state } = engineOn(fake);
    await engine.load();
    // Someone saved Otto's model onto the list; the running gateway hasn't applied it yet.
    limited(fake, ["acme/dev-2", "acme/dev-1"]);
    fake.revision += 1;
    const get = fake.gateway.handlers["config.get"]!;
    fake.gateway.handlers["config.get"] = (params) => ({
      ...(get(params) as Record<string, unknown>),
      appliedConfigHash: `r${fake.revision - 1}`,
    });
    await engine.load();
    expect(state().modelsRefused).toEqual([{ botId: "otto", ...DEV1, why: null }]);
    fake.gateway.handlers["config.get"] = get;
    await engine.load();
    expect(state().modelsRefused).toEqual([]);
  });

  it("another gateway's refusals go once the connection names a new one", async () => {
    const fake = new AccountsGateway();
    limited(fake, ["acme/dev-2"]);
    const { engine, state } = engineOn(fake);
    await engine.load();
    expect(state().modelsRefused).toHaveLength(1);
    // The same gateway naming itself again keeps them.
    engine.onGateway("gateway-a");
    expect(state().modelsRefused).toHaveLength(1);
    limited(fake, ["acme/dev-1"]);
    fake.config.agents = { ...(fake.config.agents as object) };
    fake.gateway.handlers["config.get"] = () => {
      throw new Error("gateway request timeout for config.get");
    };
    engine.onGateway("gateway-b");
    expect(state().modelsRefused).toEqual([]);
    // And still none once the read it starts has failed.
    await until(() => state().error !== null);
    expect(state().modelsRefused).toEqual([]);
  });
});
