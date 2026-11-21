// The accounts engine (accounts.ts, accounts-engine.ts; bots.md sections 3 to
// 11): the accounts as each bot sees them, the three account states and the
// evidence for a lock, the strict setting and its report, each sign-in kind
// through each ending, the read after a sign-in, the bounds, and a typed key
// leaving no trace.

import { describe, expect, it } from "vitest";
import {
  ACCOUNTS,
  accountWord,
  enforceState,
  evaluateOrder,
  initialState,
  labelProblem,
  lockCommand,
  MAX_ACCOUNTS,
  MAX_SECRET_CHARS,
  parseModelRef,
  readBotView,
  readFirstBot,
  retainedOrder,
  unlockCommand,
  unreadEvidence,
  withoutSecret,
  worstCase,
  type AccountsState,
  type ClawtrateState,
} from "../src/index.ts";
import { createBridgeSession } from "../src/bridge.ts";
import { HELD_KEY } from "../src/accounts-engine.ts";
import {
  HELD_BOT_CHARS,
  MAX_HELD_BOTS,
  readCreateReply,
  readHeldBot,
  type NewBotPolicy,
} from "../src/new-bot.ts";
import { CLIENT_OWNERS } from "../src/owners.ts";
import { ClawtrateClient } from "../src/client.ts";
import { ADMIN_SCOPES, INTERACTIVE_SCOPES, READ_SCOPES } from "../src/scopes.ts";
import { AccountsGateway, accountsClient, CHOICES } from "./accounts-fake.ts";
import { FAST, URL_A, URL_B } from "./client-harness.ts";
import {
  deferred,
  GatewayError,
  memoryStorage,
  testHost,
  tokenKey,
  until,
} from "./fake-gateway.ts";

const binding = (state: ClawtrateState["accounts"], botId: string) =>
  state.bindings.find((each) => each.botId === botId)!;

describe("the accounts as each bot sees them", () => {
  it("reads every bot's refreshed view, and tells shared accounts from those one bot keeps", async () => {
    const { client, fake, accounts } = await accountsClient();
    const views = fake.gateway.calls("models.authStatus") as Array<{
      agentId: string;
      refresh?: boolean;
    }>;
    // Sharing is decided only from refreshed answers (row 33).
    expect(views.every((each) => each.refresh === true)).toBe(true);
    expect(new Set(views.map((each) => each.agentId))).toEqual(new Set(["main", "otto", "pip"]));
    const byId = Object.fromEntries(accounts().accounts.map((a) => [a.id, a]));
    expect(byId["acme:work"]).toMatchObject({
      provider: "acme",
      label: "Work",
      keptBy: null,
      kind: "gateway",
    });
    expect(byId["acme:home"]).toMatchObject({ label: "Home", keptBy: null });
    expect(byId["acme:studio"]).toMatchObject({ label: "Studio", keptBy: "otto" });
    expect(accounts().labels).toBe(true);
    expect(accounts().mainShared).toBe(true);
    expect(accounts().defaultModel).toBe("acme/dev-1");
    expect(accounts().methods.map((m) => [m.id, m.flow, m.group])).toEqual([
      [CHOICES.device, "code", "subscription"],
      [CHOICES.browser, "paste", "subscription"],
      [CHOICES.key, "key", "subscription"],
    ]);
    expect(accounts().keyProviders).toEqual([
      { provider: "acme", hasKey: true, method: CHOICES.key },
      { provider: "globex", hasKey: false, method: null },
    ]);
    expect(accounts().models.find((m) => m.provider === "globex")).toMatchObject({
      available: false,
    });
    client.stop();
  });

  it("below admin the gateway sends no labels, so accounts are told apart by their ids", async () => {
    const { client, accounts } = await accountsClient({ scopes: INTERACTIVE_SCOPES });
    expect(accounts().labels).toBe(false);
    expect(accounts().accounts.map((a) => [a.id, a.label])).toEqual([
      ["acme:home", null],
      ["acme:studio", null],
      ["acme:work", null],
    ]);
    // Reads still work at the read tier: bindings and orders come with them.
    expect(binding(accounts(), "otto")).toMatchObject({ mode: "account", account: "acme:work" });
    client.stop();
  });

  it("with a single bot there is no second view, so its own accounts are kept by it", async () => {
    const fake = new AccountsGateway();
    fake.bots = [{ id: "otto", name: "Otto" }];
    const { client, accounts } = await accountsClient({ gateway: fake });
    expect(accounts().accounts.find((a) => a.id === "acme:studio")?.keptBy).toBe("otto");
    // No `main` bot: a sign-in cannot be shared, and that is known before it starts.
    expect(accounts().mainShared).toBe(false);
    client.stop();
  });

  it("an unrefreshed view that lists shared accounts as saved is never read", () => {
    // What the gateway's prepared view can say (row 33). The engine never asks for it.
    const view = readBotView({
      providers: [
        {
          provider: "acme",
          profiles: [{ profileId: "acme:work", source: "saved", type: "api_key" }],
        },
      ],
    });
    expect(view.profiles[0]!.source).toBe("saved");
  });
});

describe("a bot's account: bound, locked, and the gateway choosing", () => {
  it("reads each bot's binding from the gateway's config, with its account suffix", async () => {
    const { client, accounts } = await accountsClient();
    expect(binding(accounts(), "otto")).toMatchObject({
      primary: "acme/dev-1@acme:work",
      provider: "acme",
      model: "dev-1",
      account: "acme:work",
      mode: "account",
      fallbacks: [],
    });
    // A bot with no model of its own uses the gateway's default model.
    expect(binding(accounts(), "main")).toMatchObject({ mode: "default-model", account: null });
    expect(accountWord(binding(accounts(), "otto"))).toBe("bound");
    expect(accountWord(binding(accounts(), "main"))).toBe("default-model");
    client.stop();
  });

  it("is locked only for a stored one-account order naming the bound account, however it arose", async () => {
    const fake = new AccountsGateway();
    fake.orders.otto = { acme: ["acme:work"] };
    const { client, accounts } = await accountsClient({ gateway: fake });
    const otto = () => binding(accounts(), "otto");
    expect(otto().order).toEqual({ ids: ["acme:work"], stored: true, configured: null });
    expect(otto().evidence).toMatchObject({ status: "matched", lostAt: null });
    expect(otto().evidence.checkedAt).not.toBeNull();
    expect(otto().evidence.lastMatchAt).toBe(otto().evidence.checkedAt);
    expect(accountWord(otto())).toBe("locked");

    // The order now lists the bound account and another: not a lock, and the lock is gone.
    fake.orders.otto = { acme: ["acme:work", "acme:home"] };
    await client.checkLock("otto");
    expect(otto().evidence.status).toBe("multi");
    expect(otto().evidence.lostAt).not.toBeNull();
    expect(accountWord(otto())).toBe("bound");

    // Back to one account: locked again.
    fake.orders.otto = { acme: ["acme:work"] };
    await client.checkLock("otto");
    expect(accountWord(otto())).toBe("locked");
    expect(otto().evidence.lostAt).toBeNull();
    client.stop();
  });

  it("an order from the gateway's settings, not the bot's own store, is never a lock, even naming only the bound account", async () => {
    const fake = new AccountsGateway();
    fake.configuredOrders.acme = ["acme:work"];
    const { client, accounts } = await accountsClient({ gateway: fake });
    const otto = binding(accounts(), "otto");
    expect(otto.order).toEqual({ ids: ["acme:work"], stored: false, configured: "auth-config" });
    expect(otto.evidence.status).toBe("configured");
    expect(otto.evidence.lastMatchAt).toBeNull();
    expect(accountWord(otto)).toBe("bound");
    // The bot's own stored order then decides.
    fake.orders.otto = { acme: ["acme:work"] };
    await client.checkLock("otto");
    expect(accountWord(binding(accounts(), "otto"))).toBe("locked");
    client.stop();
  });

  it("an account only another bot can see is not this bot's: no account, never a lock", async () => {
    const fake = new AccountsGateway();
    (
      (fake.config.agents as Record<string, unknown>).entries as Record<
        string,
        Record<string, unknown>
      >
    ).pip!.model = {
      primary: "acme/dev-1@acme:studio",
      fallbacks: [],
    };
    fake.orders.pip = { acme: ["acme:studio"] };
    const { client, accounts } = await accountsClient({ gateway: fake });
    for (const read of ["the first read", "a check of the lock"]) {
      const pip = binding(accounts(), "pip");
      expect({
        read,
        missing: pip.accountMissing,
        word: accountWord(pip),
        status: pip.evidence.status,
      }).toEqual({
        read,
        missing: true,
        word: "no-account",
        status: "none",
      });
      await client.checkLock("pip");
    }
    // The account Otto keeps is listed, as Otto's: Pip's binding does not make it Pip's.
    expect(accounts().accounts.find((a) => a.id === "acme:studio")?.keptBy).toBe("otto");
    client.stop();
  });

  it("an answer that account status is unavailable is not an empty reading: the last good read stands", async () => {
    const fake = new AccountsGateway();
    fake.orders.otto = { acme: ["acme:work"] };
    const { client, accounts } = await accountsClient({ gateway: fake });
    const ids = accounts().accounts.map((a) => a.id);
    const confirmed = binding(accounts(), "otto").evidence.lastMatchAt;
    fake.unavailable = true;
    await client.refreshAccounts();
    expect(accounts()).toMatchObject({ status: "error" });
    expect(accounts().error).toMatch(/unavailable \(PREPARED_MODEL_AUTH_UNAVAILABLE\)/);
    expect(accounts().accounts.map((a) => a.id)).toEqual(ids);
    await client.checkLock("otto");
    const evidence = binding(accounts(), "otto").evidence;
    expect(evidence).toMatchObject({
      status: "unavailable",
      error: "PREPARED_MODEL_AUTH_UNAVAILABLE",
      lastMatchAt: confirmed,
    });
    // The last confirmation stands, as of its time; the page says the status is unavailable.
    expect(accountWord(binding(accounts(), "otto"))).toBe("locked");
    client.stop();
  });

  it("a read that fails keeps the last confirmation, with its time, and says the read failed", async () => {
    const fake = new AccountsGateway();
    fake.orders.otto = { acme: ["acme:work"] };
    const { client, accounts } = await accountsClient({ gateway: fake });
    const confirmed = binding(accounts(), "otto").evidence.lastMatchAt;
    fake.failStatusFor = "otto";
    await client.checkLock("otto");
    const evidence = binding(accounts(), "otto").evidence;
    expect(evidence.status).toBe("failed");
    expect(evidence.error).toMatch(/status unavailable/);
    expect(evidence.lastMatchAt).toBe(confirmed);
    expect(accountWord(binding(accounts(), "otto"))).toBe("locked");
    client.stop();
  });

  it("a one-account order naming another account of the provider is a lock out of date", () => {
    const evidence = evaluateOrder(
      unreadEvidence,
      { account: "acme:home", provider: "acme", mode: "account" },
      { ids: ["acme:work"], stored: true, configured: null },
      true,
      100,
    );
    expect(evidence.status).toBe("other");
    expect(
      accountWord({
        botId: "otto",
        primary: "acme/dev-1@acme:home",
        provider: "acme",
        model: "dev-1",
        account: "acme:home",
        mode: "account",
        fallbacks: [],
        suffixLost: false,
        accountMissing: false,
        effort: null,
        order: { ids: ["acme:work"], stored: true, configured: null },
        evidence,
        fallbacksUnwritten: false,
      }),
    ).toBe("stale");
  });

  it("an account no longer on the gateway is not a lock, whatever the order says", () => {
    const evidence = evaluateOrder(
      unreadEvidence,
      { account: "acme:gone", provider: "acme", mode: "account" },
      { ids: ["acme:gone"], stored: true, configured: null },
      false,
      100,
    );
    expect(evidence.status).not.toBe("matched");
  });

  it("reports a bot whose model lists fallbacks, and one whose account suffix went without Clawtrate", async () => {
    const fake = new AccountsGateway();
    // Clawtrate's own record says it set an account for otto; the gateway's model no longer names one.
    fake.prefs["clawtrate.bot-account.otto"] = { mode: "account", account: "acme:work" };
    (
      (fake.config.agents as Record<string, unknown>).entries as Record<
        string,
        Record<string, unknown>
      >
    ).otto!.model = {
      primary: "acme/dev-1",
      fallbacks: [],
    };
    const { client, accounts } = await accountsClient({ gateway: fake });
    expect(binding(accounts(), "pip").fallbacks).toEqual(["globex/dev-1"]);
    expect(binding(accounts(), "otto")).toMatchObject({ mode: "gateway", suffixLost: true });

    // "Remove fallbacks": the model keeps its account, the list becomes empty.
    await client.removeBotFallbacks("pip");
    const patch = fake.gateway.calls("config.patch").at(-1) as {
      raw: string;
      replacePaths: string[];
    };
    expect(JSON.parse(patch.raw)).toEqual({
      agents: { entries: { pip: { model: { fallbacks: [] } } } },
    });
    expect(patch.replacePaths).toEqual(["agents.entries.pip.model.fallbacks"]);
    expect(binding(accounts(), "pip")).toMatchObject({ fallbacks: [], account: "acme:home" });
    client.stop();
  });

  it("a bot set to let the gateway choose is that, not a difference, and a one-account order still stored is shown", async () => {
    const fake = new AccountsGateway();
    fake.prefs["clawtrate.bot-account.otto"] = { mode: "gateway" };
    fake.orders.otto = { acme: ["acme:work"] };
    const { client, accounts } = await accountsClient({ gateway: fake });
    await client.changeBotAccount("otto", null, "acme", "dev-1", null);
    const otto = binding(accounts(), "otto");
    expect(otto).toMatchObject({
      mode: "gateway",
      account: null,
      fallbacks: [],
      suffixLost: false,
    });
    expect(accountWord(otto)).toBe("gateway");
    // The order is never described as gone until a read shows it gone (row 36).
    expect(retainedOrder(otto)).toBe("acme:work");
    delete fake.orders.otto;
    await client.checkLock("otto");
    expect(retainedOrder(binding(accounts(), "otto"))).toBeNull();
    client.stop();
  });

  it("changing a locked bot to another account of its provider leaves the lock out of date", async () => {
    const fake = new AccountsGateway();
    fake.orders.otto = { acme: ["acme:work"] };
    const { client, accounts } = await accountsClient({ gateway: fake });
    expect(accountWord(binding(accounts(), "otto"))).toBe("locked");
    await client.changeBotAccount("otto", "acme:home", "acme", "dev-1", "high");
    const patch = fake.gateway.calls("config.patch").at(-1) as { raw: string };
    expect(JSON.parse(patch.raw)).toEqual({
      agents: {
        entries: {
          otto: {
            model: { primary: "acme/dev-1@acme:home", fallbacks: [] },
            thinkingDefault: "high",
          },
        },
      },
    });
    expect(accountWord(binding(accounts(), "otto"))).toBe("stale");
    expect(fake.prefs["clawtrate.bot-account.otto"]).toEqual({
      mode: "account",
      account: "acme:home",
    });
    client.stop();
  });

  it("builds the lock and unlock commands in the gateway's own form, with the host's prefix", () => {
    expect(lockCommand("openclaw", { botId: "marlow", provider: "openai" }, "openai:work")).toBe(
      "openclaw models auth order set --provider openai --agent marlow openai:work",
    );
    expect(unlockCommand("openclaw --profile clawtrate-dev-x", "marlow", "openai")).toBe(
      "openclaw --profile clawtrate-dev-x models auth order clear --provider openai --agent marlow",
    );
    expect(parseModelRef("acme/dev-1@acme:home")).toEqual({
      provider: "acme",
      model: "dev-1",
      account: "acme:home",
    });
    expect(parseModelRef("openrouter/openai/gpt-5@openrouter:default")).toEqual({
      provider: "openrouter",
      model: "openai/gpt-5",
      account: "openrouter:default",
    });
    expect(parseModelRef("acme/dev-1")).toEqual({
      provider: "acme",
      model: "dev-1",
      account: null,
    });
  });
});

type Entry = Record<string, unknown>;
const entries = (fake: AccountsGateway) =>
  (fake.config.agents as { entries: Record<string, Entry> }).entries;
const patches = (fake: AccountsGateway) =>
  (
    fake.gateway.calls("config.patch") as Array<{
      raw: string;
      baseHash?: string;
      replacePaths?: string[];
    }>
  ).map((call) => ({ ...call, patch: JSON.parse(call.raw) as Record<string, unknown> }));

const viral = {
  name: "Viral",
  avatar: null,
  account: "acme:work",
  provider: "acme",
  model: "dev-1",
  effort: null,
  approvals: "ask",
  attempt: null,
} as const;

/** A new bot's note, as the state shows it. */
const note = (a: AccountsState, botId = "viral") =>
  a.policies.find((each) => each.botId === botId) ?? null;

describe("creating a bot: the one Create sequence (bots.md section 3, controls.md section 10)", () => {
  it("confirmed: agents.create once, then step 2 and step 3 for the id it returned, each guarded by the hash just read and read back", async () => {
    const { client, fake, accounts } = await accountsClient();
    const others = JSON.parse(JSON.stringify(entries(fake))) as Record<string, Entry>;
    const tools = JSON.stringify((fake.config as { tools?: unknown }).tools ?? null);
    const { botId } = await client.createBot({ ...viral, effort: "low" });
    expect(botId).toBe("viral");
    expect(fake.gateway.calls("agents.create")).toEqual([
      { name: "Viral", model: "acme/dev-1@acme:work" },
    ]);
    const [step2, step3] = patches(fake);
    expect(patches(fake)).toHaveLength(2);
    // Step 2: Never, the restrictive deny list and the model with no fallbacks, for that id only.
    expect(step2!.patch).toEqual({
      agents: {
        entries: {
          viral: {
            tools: {
              exec: { mode: "deny" },
              deny: ["gateway", "plugins", "automations", "browser", "message", "t3code__*"],
            },
            model: { primary: "acme/dev-1@acme:work", fallbacks: [] },
            thinkingDefault: "low",
          },
        },
      },
    });
    expect(step2!.baseHash).toBe("h2");
    // Step 3: only the chosen mode and the final deny list, with that list's path to replace.
    expect(step3!.patch).toEqual({
      agents: {
        entries: {
          viral: { tools: { exec: { mode: "ask" }, deny: ["gateway", "plugins", "t3code__*"] } },
        },
      },
    });
    expect(step3!.baseHash).toBe("h3");
    expect(step3!.replacePaths).toEqual(["agents.entries.viral.tools.deny"]);
    // Read back: the saved setting and the gateway's reported label, as two facts.
    expect(note(accounts())).toEqual({
      botId: "viral",
      name: "Viral",
      workspace: "/w/viral",
      chosen: "ask",
      status: "confirmed",
      restrictive: true,
      saved: "ask",
      reported: "guarded",
      retryable: false,
    });
    expect(accounts().creation).toMatchObject({ status: "created", botId: "viral", missing: [] });
    // No other bot's entry and no setting for every bot changed.
    const after = entries(fake);
    for (const [id, entry] of Object.entries(others)) expect(after[id]).toEqual(entry);
    expect(JSON.stringify((fake.config as { tools?: unknown }).tools ?? null)).toBe(tools);
    // Its first task came after step 2, and the bot list shows it.
    expect(fake.gateway.calls("sessions.create")).toEqual([
      { key: "agent:viral:main", agentId: "viral", label: "Main" },
    ]);
    expect(client.state.bots.map((b) => b.id)).toContain("viral");
    expect(binding(accounts(), "viral")).toMatchObject({ account: "acme:work", fallbacks: [] });
    client.stop();
  });

  it("Run without routine approvals writes full, and the same deny list; the read says no label when the gateway reports none", async () => {
    const { client, fake, accounts } = await accountsClient();
    const list = fake.gateway.handlers["agents.list"]!;
    fake.gateway.handlers["agents.list"] = (params) => {
      const answer = list(params) as { agents: Array<Record<string, unknown>> };
      return {
        ...answer,
        agents: answer.agents.map(({ defaultPermissionMode: _, ...agent }) => agent),
      };
    };
    await client.createBot({ ...viral, account: null, approvals: "full" });
    expect(patches(fake)[1]!.patch).toEqual({
      agents: {
        entries: {
          viral: { tools: { exec: { mode: "full" }, deny: ["gateway", "plugins", "t3code__*"] } },
        },
      },
    });
    expect(note(accounts())).toMatchObject({
      status: "confirmed",
      saved: "full",
      reported: "none",
    });
    client.stop();
  });

  it("names every tool server the config has in step 2, and lets step 3 drop them", async () => {
    const fake = new AccountsGateway();
    fake.config.mcp = { servers: { coder: { command: "x" } } };
    const { client } = await accountsClient({ gateway: fake });
    await client.createBot({ ...viral });
    const deny = (call: { patch: Record<string, unknown> }) =>
      (call.patch as { agents: { entries: { viral: { tools: { deny: string[] } } } } }).agents
        .entries.viral.tools.deny;
    expect(deny(patches(fake)[0]!)).toEqual([
      "gateway",
      "plugins",
      "automations",
      "browser",
      "message",
      "t3code__*",
      "coder__*",
    ]);
    expect(deny(patches(fake)[1]!)).toEqual(["gateway", "plugins", "t3code__*"]);
    expect(entries(fake).viral!.tools).toEqual({
      exec: { mode: "ask" },
      deny: ["gateway", "plugins", "t3code__*"],
    });
    client.stop();
  });

  it("the host refuses a Create with no command choice, or no account choice: nothing is sent", async () => {
    const { client, fake, accounts } = await accountsClient();
    await expect(client.createBot({ ...viral, approvals: null })).rejects.toThrow(
      /Choose how the new bot runs commands/,
    );
    await expect(client.createBot({ ...viral, provider: "", model: "" })).rejects.toThrow(
      /Choose an account/,
    );
    expect(fake.gateway.calls("agents.create")).toEqual([]);
    expect(fake.gateway.calls("config.patch")).toEqual([]);
    expect(accounts().creation).toBeNull();
    expect(note(accounts())).toBeNull();
    client.stop();
  });

  for (const [why, answer] of [
    ["no answer before the connection dropped", "drop"],
    ["an answer that it was saved but not applied", "unapplied"],
    ["a reply without an id", "no-id"],
  ] as const) {
    it(`a lost or ambiguous reply (${why}) is not confirmed: no policy or model write, no task, and a bot of that name found later is not adopted`, async () => {
      const { client, fake, accounts } = await accountsClient();
      const create = fake.gateway.handlers["agents.create"]!;
      fake.gateway.handlers["agents.create"] = async (params) => {
        const made = await create(params);
        if (answer === "no-id") return { ok: true, name: "Viral", workspace: "/w/viral" };
        if (answer === "unapplied")
          throw new GatewayError({
            code: "UNAVAILABLE",
            message:
              "Agent configuration was saved but its application to the active Gateway was not confirmed",
          });
        setTimeout(() => fake.gateway.dropAll(), 0);
        return new Promise(() => made);
      };
      await expect(client.createBot({ ...viral })).rejects.toThrow();
      expect(accounts().creation).toMatchObject({ status: "unconfirmed", botId: null });
      expect(fake.gateway.calls("agents.create")).toHaveLength(1);
      expect(fake.gateway.calls("config.patch")).toEqual([]);
      expect(fake.gateway.calls("sessions.create")).toEqual([]);
      expect(fake.prefs["clawtrate.bot-account.viral"]).toBeUndefined();
      expect(note(accounts())).toBeNull();
      // The gateway made it after all, and lists it: still not taken to be this Create's.
      await until(() => client.state.connection.status === "connected");
      await client.retryNow();
      expect(client.state.bots.some((bot) => bot.id === "viral")).toBe(true);
      expect(accounts().creation?.status).toBe("unconfirmed");
      expect(entries(fake).viral!.tools).toBeUndefined();
      // Create is not offered again from this attempt; "Review bots" reads the list again.
      await expect(client.createBot({ ...viral })).rejects.toThrow(/Review the gateway's bot list/);
      expect(fake.gateway.calls("agents.create")).toHaveLength(1);
      const lists = fake.gateway.calls("agents.list").length;
      client.dismissBotCreation();
      await until(() => fake.gateway.calls("agents.list").length > lists);
      expect(accounts().creation).toBeNull();
      client.stop();
    });
  }

  it("a refusal that establishes nothing was made fails, and Create may be tried again", async () => {
    const { client, fake, accounts } = await accountsClient();
    fake.gateway.handlers["agents.create"] = () => {
      throw new GatewayError({ code: "INVALID_REQUEST", message: 'agent "viral" already exists' });
    };
    await expect(client.createBot({ ...viral })).rejects.toThrow(/already exists/);
    expect(accounts().creation).toMatchObject({ status: "failed" });
    expect(fake.gateway.calls("config.patch")).toEqual([]);
    client.stop();
  });

  it("a hash that changed before step 3 stops it: nothing more is written, the list is read again, the composer stays closed; Write it again repeats step 3 alone", async () => {
    const { client, fake, accounts } = await accountsClient();
    const patch = fake.gateway.handlers["config.patch"]!;
    const get = fake.gateway.handlers["config.get"]!;
    // Reads of the config after step 2's write: the first is its read-back, the second step 3's
    // read before writing. Another client changes the config just after that second read.
    let afterStep2 = -1;
    fake.gateway.handlers["config.get"] = (params) => {
      const answer = get(params);
      if (afterStep2 >= 0 && ++afterStep2 === 2) {
        fake.config.ui = { changedBy: "another client" };
        fake.revision += 1;
      }
      return answer;
    };
    fake.gateway.handlers["config.patch"] = (params) => {
      const answer = patch(params);
      if (afterStep2 < 0) afterStep2 = 0;
      return answer;
    };
    const lists = () => fake.gateway.calls("agents.list").length;
    const before = lists();
    await client.createBot({ ...viral });
    expect(fake.gateway.calls("config.patch")).toHaveLength(2);
    expect(entries(fake).viral!.tools).toMatchObject({ exec: { mode: "deny" } });
    expect(note(accounts())).toMatchObject({
      status: "unconfirmed",
      restrictive: true,
      saved: "deny",
      retryable: true,
    });
    expect(lists()).toBeGreaterThan(before + 1);
    // Nothing is sent to it until its setting reads back as chosen.
    await client.openSession("agent:viral:main");
    expect(() => client.sendMessage("agent:viral:main", "hello")).toThrow(
      /couldn't confirm Viral's command setting/,
    );
    await expect(client.createTask("viral", "hello")).rejects.toThrow(/couldn't confirm/);
    await client.retryBotPolicy("viral");
    expect(fake.gateway.calls("agents.create")).toHaveLength(1);
    const last = patches(fake).at(-1)!;
    expect(last.patch).toEqual({
      agents: {
        entries: {
          viral: { tools: { exec: { mode: "ask" }, deny: ["gateway", "plugins", "t3code__*"] } },
        },
      },
    });
    expect(note(accounts())).toMatchObject({ status: "confirmed", saved: "ask" });
    expect(() => client.sendMessage("agent:viral:main", "hello")).not.toThrow();
    client.stop();
  });

  it("step 3 names the deny list in replacePaths: without it the gateway refuses to drop step 2's entries", async () => {
    const { client, fake } = await accountsClient();
    const patch = fake.gateway.handlers["config.patch"]!;
    fake.gateway.handlers["config.patch"] = (params) => {
      const { replacePaths: _, ...rest } = params as Record<string, unknown>;
      return patch(rest);
    };
    await client.createBot({ ...viral });
    expect(note(client.state.accounts)).toMatchObject({ status: "unconfirmed", saved: "deny" });
    client.stop();
  });

  it("F-034: a bot deleted before step 2 is never written, and nothing more goes for it: no preference, no task, no retry", async () => {
    const { client, fake, accounts, storage } = await accountsClient();
    const create = fake.gateway.handlers["agents.create"]!;
    fake.gateway.handlers["agents.create"] = async (params) => {
      const made = await create(params);
      delete entries(fake).viral;
      fake.bots = fake.bots.filter((bot) => bot.id !== "viral");
      fake.revision += 1;
      return made;
    };
    const lists = fake.gateway.calls("agents.list").length;
    await expect(client.createBot({ ...viral })).rejects.toThrow(/changed on the gateway/);
    expect(fake.gateway.calls("config.patch")).toEqual([]);
    expect(entries(fake).viral).toBeUndefined();
    expect(fake.gateway.calls("sessions.create")).toEqual([]);
    expect(fake.prefs["clawtrate.bot-account.viral"]).toBeUndefined();
    expect(fake.gateway.calls("users.prefs.set")).toEqual([]);
    expect(fake.gateway.calls("agents.list").length).toBeGreaterThan(lists);
    expect(note(accounts())).toBeNull();
    expect(accounts().creation).toMatchObject({ status: "unconfirmed" });
    expect(JSON.parse(storage.data.get(HELD_KEY) ?? "[]")).toEqual([]);
    await expect(client.retryBotPolicy("viral")).rejects.toThrow(/nothing to write again/);
    expect(fake.gateway.calls("config.patch")).toEqual([]);
    client.stop();
  });

  it("F-034: an id that no longer identifies the bot Create returned stops everything: the replacement keeps its own settings, and no preference or task goes", async () => {
    const { client, fake, accounts } = await accountsClient();
    let replaceAt = 1;
    const patch = fake.gateway.handlers["config.patch"]!;
    fake.gateway.handlers["config.patch"] = (params) => {
      const answer = patch(params);
      // After step 2, the bot is deleted and another made at the same id.
      if (replaceAt-- === 1) {
        entries(fake).viral = { name: "Viral 2", workspace: "/w/elsewhere" };
        fake.revision += 1;
      }
      return answer;
    };
    await expect(client.createBot({ ...viral })).rejects.toThrow(/changed on the gateway/);
    // Step 2's read-back finds another bot there: step 3 is never sent, and nothing is offered.
    expect(fake.gateway.calls("config.patch")).toHaveLength(1);
    expect(entries(fake).viral).toEqual({ name: "Viral 2", workspace: "/w/elsewhere" });
    expect(note(accounts())).toBeNull();
    expect(fake.gateway.calls("sessions.create")).toEqual([]);
    expect(fake.gateway.calls("users.prefs.set")).toEqual([]);
    client.stop();
  });

  for (const [why, change] of [
    ["the same name and workspace, made again after step 2", "same"],
    ["no workspace", "none"],
  ] as const) {
    it(`F-034: an entry with ${why} is not taken for the bot Create made: step 3 isn't written`, async () => {
      const { client, fake, accounts } = await accountsClient();
      let replaceAt = 1;
      const patch = fake.gateway.handlers["config.patch"]!;
      fake.gateway.handlers["config.patch"] = (params) => {
        const answer = patch(params);
        if (replaceAt-- === 1) {
          entries(fake).viral =
            change === "same" ? { name: "Viral", workspace: "/w/viral" } : { name: "Viral" };
          fake.revision += 1;
        }
        return answer;
      };
      const settled = client.createBot({ ...viral });
      if (change === "none") await expect(settled).rejects.toThrow(/changed on the gateway/);
      else await settled;
      expect(fake.gateway.calls("config.patch")).toHaveLength(1);
      expect(fake.gateway.calls("sessions.create")).toEqual([]);
      if (change === "same") {
        // Its entry isn't the one Clawtrate wrote: held, and Write it again isn't offered.
        expect(note(accounts())).toMatchObject({ status: "restrictive", retryable: false });
        expect(client.state.accounts.policies).toHaveLength(1);
        await expect(client.retryBotPolicy("viral")).rejects.toThrow(/can't identify/);
        expect(fake.gateway.calls("config.patch")).toHaveLength(1);
      } else expect(note(accounts())).toBeNull();
      client.stop();
    });
  }

  it("F-034: a Create reply without the workspace settles nothing: no write follows it", async () => {
    const { client, fake, accounts } = await accountsClient();
    const create = fake.gateway.handlers["agents.create"]!;
    fake.gateway.handlers["agents.create"] = async (params) => {
      const { workspace: _, ...made } = (await create(params)) as Record<string, unknown>;
      return made;
    };
    await expect(client.createBot({ ...viral })).rejects.toThrow(/workspace/);
    expect(accounts().creation).toMatchObject({ status: "unconfirmed" });
    expect(fake.gateway.calls("config.patch")).toEqual([]);
    expect(fake.gateway.calls("users.prefs.set")).toEqual([]);
    expect(fake.gateway.calls("sessions.create")).toEqual([]);
    client.stop();
  });

  it("a step 2 that doesn't read back sends nothing to the bot, its first task included; Write it again writes both steps, then the task", async () => {
    const { client, fake, accounts } = await accountsClient();
    fake.failPatch = "config is locked";
    const made = await client.createBot({ ...viral });
    expect(made).toEqual({ botId: "viral", missing: [] });
    expect(note(accounts())).toMatchObject({
      status: "restrictive",
      restrictive: false,
      retryable: true,
    });
    expect(fake.gateway.calls("sessions.create")).toEqual([]);
    expect(binding(accounts(), "viral").fallbacksUnwritten).toBe(true);
    await expect(client.createTask("viral", "hello")).rejects.toThrow(/couldn't confirm/);
    await client.retryBotPolicy("viral");
    expect(fake.gateway.calls("agents.create")).toHaveLength(1);
    expect(entries(fake).viral).toMatchObject({
      tools: { exec: { mode: "ask" }, deny: ["gateway", "plugins", "t3code__*"] },
      model: { primary: "acme/dev-1@acme:work", fallbacks: [] },
    });
    expect(note(accounts())).toMatchObject({ status: "confirmed", restrictive: true });
    expect(fake.gateway.calls("sessions.create")).toHaveLength(1);
    client.stop();
  });

  it("the note goes once the first message is sent, only from a confirmed setting", async () => {
    const { client, fake, accounts } = await accountsClient();
    fake.failPatch = "config is locked";
    await client.createBot({ ...viral });
    client.dismissBotPolicy("viral");
    expect(note(accounts())?.botId).toBe("viral");
    await client.retryBotPolicy("viral");
    client.dismissBotPolicy("viral");
    expect(note(accounts())).toBeNull();
    client.stop();
  });

  it("the gateway's approvals file blocks commands only when its defaults deny and no entry for the bot says otherwise", async () => {
    const { client, fake } = await accountsClient();
    expect(await client.readApprovalsFile("Viral")).toEqual({ blocks: false });
    fake.approvalsFile = { version: 1, defaults: { security: "deny" }, agents: {} };
    expect(await client.readApprovalsFile("Viral")).toEqual({ blocks: true });
    fake.approvalsFile = {
      version: 1,
      defaults: { security: "deny" },
      agents: { viral: { security: "allowlist" } },
    };
    expect(await client.readApprovalsFile("Viral")).toEqual({ blocks: false });
    fake.approvalsFile = {
      version: 1,
      defaults: { security: "deny" },
      agents: { "*": { security: "full" } },
    };
    expect(await client.readApprovalsFile("Viral")).toEqual({ blocks: false });
    fake.gateway.handlers["exec.approvals.get"] = () => {
      throw new GatewayError({ code: "UNAVAILABLE", message: "no file" });
    };
    expect(await client.readApprovalsFile("Viral")).toEqual({ blocks: false });
    client.stop();
  });
});

describe("a new bot's Create, bound to its gateway and held until its setting reads back", () => {
  const held = (storage: { data: Map<string, string> }) =>
    (JSON.parse(storage.data.get(HELD_KEY) ?? "[]") as Array<{ made: { botId: string } }>).map(
      (each) => each.made.botId,
    );
  const engine = (client: ClawtrateClient) =>
    (
      client as unknown as {
        accounts: {
          planned: Map<string, unknown>;
          held: Map<string, unknown>;
          heldBack: (botId: string) => string | null;
        };
      }
    ).accounts;

  it("F-034: a change of gateway after Create's reply: nothing more is sent, on either gateway, and nothing is shown on the other", async () => {
    const { client, fake, storage } = await accountsClient();
    // The record of the new bot is being kept when the gateway changes.
    const keeping = deferred<unknown>();
    let kept = false;
    const set = storage.set;
    storage.set = async (key, value) => {
      if (key === HELD_KEY && !kept) {
        kept = true;
        await keeping.promise;
      }
      return set(key, value);
    };
    const made = client.createBot({ ...viral });
    await until(() => kept);
    expect(fake.gateway.calls("agents.create")).toHaveLength(1);
    const gets = fake.gateway.calls("config.get").length;
    await client.connect({ url: URL_B });
    await until(
      () =>
        client.state.connection.gatewayUrl === URL_B &&
        client.state.connection.status === "connected",
    );
    const after = {
      gets: fake.gateway.calls("config.get").length,
      lists: fake.gateway.calls("agents.list").length,
    };
    keeping.resolve(undefined);
    expect((await made).missing.length).toBeGreaterThan(0);
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 50));
    // Not one request of the old sequence went out on the new connection.
    expect(fake.gateway.calls("config.patch")).toEqual([]);
    expect(fake.gateway.calls("users.prefs.set")).toEqual([]);
    expect(fake.gateway.calls("sessions.create")).toEqual([]);
    expect(fake.gateway.calls("config.get").length).toBe(after.gets);
    expect(after.gets).toBeGreaterThanOrEqual(gets);
    expect(fake.gateway.calls("agents.list").length).toBe(after.lists);
    expect(client.state.accounts.creation).toBeNull();
    expect(client.state.accounts.policies).toEqual([]);
    expect(engine(client).planned.size).toBe(0);
    // The bot stays held for the gateway that made it, not this one.
    expect(held(storage)).toEqual(["viral"]);
    expect(engine(client).heldBack("viral")).toBeNull();
    client.stop();
  });

  it("F-034: a dropped connection between step 2 and step 3: step 3 waits for Write it again on the next connection, and the bot stays held", async () => {
    const { client, fake, accounts, storage } = await accountsClient();
    const patch = fake.gateway.handlers["config.patch"]!;
    let patched = 0;
    fake.gateway.handlers["config.patch"] = (params) => {
      const answer = patch(params);
      // Step 2 lands; the connection goes before its answer arrives.
      if (++patched === 1) {
        setTimeout(() => fake.gateway.dropAll(), 0);
        return new Promise(() => answer);
      }
      return answer;
    };
    const made = await client.createBot({ ...viral });
    expect(made.missing).toEqual(expect.arrayContaining(["preference", "listed", "task"]));
    expect(fake.gateway.calls("config.patch")).toHaveLength(1);
    expect(fake.gateway.calls("sessions.create")).toEqual([]);
    expect(held(storage)).toEqual(["viral"]);
    await until(() => client.state.connection.status === "connected");
    // On the next connection its note is read again: step 2 landed, step 3 didn't.
    await until(() => note(accounts())?.status === "unconfirmed");
    expect(note(accounts())).toMatchObject({ restrictive: true, saved: "deny", retryable: true });
    await expect(client.createTask("viral", "hello")).rejects.toThrow(/couldn't confirm/);
    await client.retryBotPolicy("viral");
    expect(note(accounts())).toMatchObject({ status: "confirmed", saved: "ask" });
    expect(fake.gateway.calls("config.patch")).toHaveLength(2);
    expect(fake.gateway.calls("sessions.create")).toHaveLength(1);
    expect(held(storage)).toEqual([]);
    client.stop();
  });

  it("F-034: a second Create while the first bot is unfinished keeps the first one held, in every way a task or message is made", async () => {
    const { client, fake, accounts, storage } = await accountsClient();
    fake.failPatch = "config is locked";
    await client.createBot({ ...viral });
    expect(note(accounts())).toMatchObject({ status: "restrictive" });
    client.dismissBotCreation();
    await client.createBot({ ...viral, name: "Second" });
    expect(note(accounts(), "second")).toMatchObject({ status: "confirmed" });
    // The first bot is still held, by its note and its kept record.
    expect(note(accounts())).toMatchObject({ status: "restrictive", retryable: true });
    expect(held(storage)).toEqual(["viral"]);
    await expect(client.createTask("viral", "hello")).rejects.toThrow(/couldn't confirm/);
    await expect(client.newTask("viral")).rejects.toThrow(/couldn't confirm/);
    await expect(client.newMainTask("viral")).rejects.toThrow(/couldn't confirm/);
    expect(fake.gateway.calls("sessions.create")).toEqual([
      { key: "agent:second:main", agentId: "second", label: "Main" },
    ]);
    expect(entries(fake).viral!.tools).toBeUndefined();
    // Its Write it again still writes both steps for it alone, then its first task.
    await client.retryBotPolicy("viral");
    expect(entries(fake).viral!.tools).toMatchObject({ exec: { mode: "ask" } });
    expect(note(accounts())).toMatchObject({ status: "confirmed" });
    expect(fake.gateway.calls("sessions.create")).toHaveLength(2);
    expect(held(storage)).toEqual([]);
    client.stop();
  });

  it("F-034: a fresh host keeps an unfinished bot held: no message, task or empty task before its setting reads back, then Write it again from the kept record", async () => {
    const fake = new AccountsGateway();
    const first = await accountsClient({ gateway: fake });
    fake.failPatch = "config is locked";
    await first.client.createBot({ ...viral });
    first.client.stop();
    // A fresh host that hasn't connected: held from its kept record alone.
    const offline = memoryStorage(Object.fromEntries(first.storage.data));
    offline.data.set("connection", JSON.stringify({ url: URL_A, token: null, suspended: true }));
    const idle = new ClawtrateClient(testHost(fake.gateway, offline), FAST);
    await idle.start();
    expect(idle.state.accounts.policies).toEqual([]);
    await expect(idle.createTask("viral", "hello")).rejects.toThrow(/couldn't confirm/);
    idle.stop();
    // A fresh host with the same storage.
    const client = new ClawtrateClient(testHost(fake.gateway, first.storage), FAST);
    await client.start();
    await until(() => client.state.discovery.status === "ready");
    await expect(client.createTask("viral", "hello")).rejects.toThrow(/couldn't confirm/);
    await expect(client.newTask("viral")).rejects.toThrow(/couldn't confirm/);
    await expect(client.newMainTask("viral")).rejects.toThrow(/couldn't confirm/);
    await until(() => note(client.state.accounts)?.status === "restrictive");
    expect(note(client.state.accounts)).toMatchObject({ retryable: true, saved: null });
    await client.refreshAccounts();
    await client.retryBotPolicy("viral");
    expect(note(client.state.accounts)).toMatchObject({ status: "confirmed", saved: "ask" });
    expect(fake.gateway.calls("sessions.create")).toHaveLength(1);
    expect(JSON.parse(first.storage.data.get(HELD_KEY)!)).toEqual([]);
    client.stop();
  });

  it("F-034: a held bot whose entry another client changed is held without Write it again; one deleted is let go", async () => {
    const fake = new AccountsGateway();
    const first = await accountsClient({ gateway: fake });
    fake.failPatch = "config is locked";
    await first.client.createBot({ ...viral });
    first.client.stop();
    entries(fake).viral!.thinkingDefault = "high";
    fake.revision += 1;
    const client = new ClawtrateClient(testHost(fake.gateway, first.storage), FAST);
    await client.start();
    await until(() => note(client.state.accounts)?.status === "restrictive");
    expect(note(client.state.accounts)).toMatchObject({ retryable: false });
    await expect(client.retryBotPolicy("viral")).rejects.toThrow(/can't identify/);
    // Only the first host's refused step 2.
    expect(fake.gateway.calls("config.patch")).toHaveLength(1);
    delete entries(fake).viral;
    fake.revision += 1;
    await client.refreshBotPolicies();
    expect(note(client.state.accounts)).toBeNull();
    expect(JSON.parse(first.storage.data.get(HELD_KEY)!)).toEqual([]);
    client.stop();
  });

  it("F-034: the host keeps at most MAX_HELD_BOTS unfinished bots, and refuses a Create past them", async () => {
    const fake = new AccountsGateway();
    const { client } = await accountsClient({ gateway: fake });
    for (let index = 0; index < MAX_HELD_BOTS; index += 1) {
      fake.failPatch = "config is locked";
      await client.createBot({ ...viral, name: `Held ${index}` });
      client.dismissBotCreation();
    }
    expect(engine(client).held.size).toBe(MAX_HELD_BOTS);
    const creates = fake.gateway.calls("agents.create").length;
    await expect(client.createBot({ ...viral, name: "One more" })).rejects.toThrow(
      /Nothing was sent/,
    );
    expect(fake.gateway.calls("agents.create")).toHaveLength(creates);
    client.stop();
  });

  it("F-034: a confirmed Create keeps no plan once nothing is left to finish", async () => {
    const { client } = await accountsClient();
    await client.createBot({ ...viral });
    expect(engine(client).planned.size).toBe(0);
    expect(engine(client).held.size).toBe(0);
    client.stop();
  });

  it("F-034: an outcome is dismissed for its own attempt only", async () => {
    const { client, fake, accounts } = await accountsClient();
    fake.gateway.handlers["agents.create"] = () => {
      throw new GatewayError({ code: "INVALID_REQUEST", message: "no" });
    };
    await expect(client.createBot({ ...viral, attempt: "a1" })).rejects.toThrow();
    client.dismissBotCreation("a0");
    expect(accounts().creation).toMatchObject({ status: "failed", attempt: "a1" });
    client.dismissBotCreation("a1");
    expect(accounts().creation).toBeNull();
    client.stop();
  });

  it("F-051: another admin saving Never while the first task is open: both facts follow the reads, and the composer is held again", async () => {
    const { client, fake, accounts } = await accountsClient();
    await client.createBot({ ...viral });
    expect(note(accounts())).toMatchObject({
      status: "confirmed",
      saved: "ask",
      reported: "guarded",
    });
    await client.openSession("agent:viral:main");
    entries(fake).viral!.tools = { exec: { mode: "deny" }, deny: ["gateway", "plugins"] };
    fake.revision += 1;
    await client.refreshBotPolicies();
    expect(note(accounts())).toMatchObject({
      status: "unconfirmed",
      saved: "deny",
      reported: "read-only",
      retryable: false,
    });
    expect(() => client.sendMessage("agent:viral:main", "hello")).toThrow(/couldn't confirm/);
    // Set back as chosen: the note confirms it, and the composer opens.
    entries(fake).viral!.tools = {
      exec: { mode: "ask" },
      deny: ["gateway", "plugins", "t3code__*"],
    };
    fake.revision += 1;
    await client.refreshBotPolicies();
    expect(note(accounts())).toMatchObject({
      status: "confirmed",
      saved: "ask",
      reported: "guarded",
    });
    expect(() => client.sendMessage("agent:viral:main", "hello")).not.toThrow();
    client.stop();
  });

  it("F-051: a reconnect clears both facts until they are read again; a new write clears the label until the list after it", async () => {
    const { client, fake, accounts } = await accountsClient();
    fake.failPatch = "config is locked";
    await client.createBot({ ...viral });
    const seen: Array<NewBotPolicy | null> = [];
    const stop = client.store.subscribe((state) => void seen.push(note(state.accounts)));
    await client.retryBotPolicy("viral");
    const checking = seen.find((each) => each?.status === "checking");
    expect(checking).toMatchObject({ saved: null, reported: null });
    expect(note(accounts())).toMatchObject({ status: "confirmed", reported: "guarded" });
    seen.length = 0;
    fake.gateway.dropAll();
    await until(() => seen.some((each) => each?.status === "checking"));
    expect(seen.find((each) => each?.status === "checking")).toMatchObject({
      saved: null,
      reported: null,
    });
    await until(
      () => note(accounts())?.status === "confirmed" && note(accounts())?.reported !== null,
    );
    expect(note(accounts())).toMatchObject({ saved: "ask", reported: "guarded" });
    stop();
    client.stop();
  });

  it("F-051: an absent label and one Clawtrate has no words for are different facts", async () => {
    const { client, fake, accounts } = await accountsClient();
    const list = fake.gateway.handlers["agents.list"]!;
    let label: string | undefined = "sandboxed";
    fake.gateway.handlers["agents.list"] = (params) => {
      const answer = list(params) as { agents: Array<Record<string, unknown>> };
      return {
        ...answer,
        agents: answer.agents.map(({ defaultPermissionMode: _, ...agent }) =>
          agent.id === "viral" && label !== undefined
            ? { ...agent, defaultPermissionMode: label }
            : agent,
        ),
      };
    };
    await client.createBot({ ...viral });
    expect(note(accounts())).toMatchObject({ reported: "unrecognized" });
    label = undefined;
    entries(fake).viral!.thinkingDefault = "low";
    fake.revision += 1;
    await client.refreshBotPolicies();
    expect(note(accounts())).toMatchObject({ reported: "none" });
    client.stop();
  });

  for (const [why, change, input] of [
    ["an account no longer on the gateway", "gone", {}],
    ["an account kept by one bot alone", "own", { account: "acme:studio" }],
    ["a gateway whose default model's provider changed", "default", { account: null }],
    ["a model no longer listed", "model", { model: "dev-9" }],
  ] as const) {
    it(`F-472: Create on ${why} is refused before anything is sent`, async () => {
      const { client, fake, accounts } = await accountsClient();
      if (change === "gone") fake.shared = fake.shared.filter((each) => each.id !== "acme:work");
      if (change === "default")
        (
          (fake.config.agents as Record<string, unknown>).defaults as Record<string, unknown>
        ).model = { primary: "globex/dev-1" };
      await expect(client.createBot({ ...viral, ...input })).rejects.toThrow(/Nothing was sent/);
      expect(fake.gateway.calls("agents.create")).toEqual([]);
      expect(accounts().creation).toBeNull();
      client.stop();
    });
  }

  it("F-034: identity fields are bounded where they enter: a reply's id, name and workspace, and a kept record", () => {
    const reply = { ok: true, agentId: "viral", name: "Viral", workspace: "/w/viral" };
    expect(readCreateReply(reply)).toEqual({
      botId: "viral",
      name: "Viral",
      workspace: "/w/viral",
    });
    expect(readCreateReply({ ...reply, agentId: "../etc" })).toBeNull();
    expect(readCreateReply({ ...reply, agentId: "a".repeat(65) })).toBeNull();
    expect(readCreateReply({ ...reply, name: "n".repeat(257) })).toBeNull();
    expect(readCreateReply({ ...reply, workspace: "w".repeat(4097) })).toBeNull();
    expect(readCreateReply({ ...reply, workspace: "" })).toBeNull();
    const record = {
      gatewayId: null,
      gatewayUrl: URL_A,
      made: { botId: "viral", name: "Viral", workspace: "/w/viral" },
      chosen: "ask",
      primary: "acme/dev-1",
      effort: null,
      restrictive: false,
      taskMade: false,
      seen: null,
    };
    expect(readHeldBot(record)).toEqual(record);
    expect(JSON.stringify(record).length).toBeLessThanOrEqual(HELD_BOT_CHARS);
    expect(readHeldBot({ ...record, chosen: "deny" })).toBeNull();
    expect(readHeldBot({ ...record, gatewayUrl: "u".repeat(2049) })).toBeNull();
    expect(readHeldBot({ ...record, primary: "p".repeat(513) })).toBeNull();
    expect(readHeldBot({ ...record, made: { ...record.made, botId: "a b" } })).toBeNull();
  });
});

describe("a bot left half-made", () => {
  const input = viral;

  it("a record of the bot's account that is not saved leaves it partial, and Finish saves it", async () => {
    const { client, fake, accounts } = await accountsClient();
    const save = fake.gateway.handlers["users.prefs.set"]!;
    fake.gateway.handlers["users.prefs.set"] = () => {
      throw new GatewayError({ code: "UNAVAILABLE", message: "preferences unavailable" });
    };
    expect(await client.createBot({ ...input })).toEqual({
      botId: "viral",
      missing: ["preference"],
    });
    expect(accounts().creation).toMatchObject({ status: "partial", botId: "viral" });
    expect(fake.prefs["clawtrate.bot-account.viral"]).toBeUndefined();
    fake.gateway.handlers["users.prefs.set"] = save;
    expect(await client.finishBot("viral")).toEqual({ botId: "viral", missing: [] });
    expect(fake.prefs["clawtrate.bot-account.viral"]).toEqual({
      mode: "account",
      account: "acme:work",
    });
    expect(fake.gateway.calls("agents.create")).toHaveLength(1);
    expect(fake.gateway.calls("config.patch")).toHaveLength(2);
    client.stop();
  });

  it("a bot list that can't be read after the writes is no proof it was created: partial until a read shows it", async () => {
    const { client, fake, accounts } = await accountsClient();
    const list = fake.gateway.handlers["agents.list"]!;
    fake.gateway.handlers["agents.list"] = () => {
      throw new GatewayError({ code: "UNAVAILABLE", message: "cannot list bots" });
    };
    const made = await client.createBot({ ...input });
    expect(made.missing).toContain("listed");
    expect(accounts().creation).toMatchObject({ status: "partial", botId: "viral" });
    expect(accounts().creation?.error).toMatch(/reading the gateway's bot list afterwards failed/);
    expect(note(accounts())).toMatchObject({ status: "confirmed", reported: null });
    fake.gateway.handlers["agents.list"] = list;
    expect((await client.finishBot("viral")).missing).toEqual([]);
    expect(client.state.bots.some((bot) => bot.id === "viral")).toBe(true);
    expect(fake.gateway.calls("agents.create")).toHaveLength(1);
    client.stop();
  });

  it("a read of the bot list asked before a bot is made and answered after it does not hide the bot", async () => {
    const { client, fake } = await accountsClient();
    const list = fake.gateway.handlers["agents.list"]!;
    const held = deferred<void>();
    let asked = false;
    // The next read takes the list as it is now, and answers only when let go.
    fake.gateway.handlers["agents.list"] = async (params) => {
      fake.gateway.handlers["agents.list"] = list;
      asked = true;
      const before = list(params);
      await held.promise;
      return before;
    };
    const reread = client.retryNow();
    await until(() => asked);
    expect(await client.createBot({ ...input })).toEqual({ botId: "viral", missing: [] });
    expect(client.state.bots.some((bot) => bot.id === "viral")).toBe(true);
    held.resolve();
    await reread;
    expect(client.state.bots.some((bot) => bot.id === "viral")).toBe(true);
    client.stop();
  });

  it("a bot written whose first task fails is reported with what exists and what is missing, and is finished by its id", async () => {
    const { client, fake, accounts } = await accountsClient();
    fake.gateway.handlers["sessions.create"] = () => {
      throw new GatewayError({ code: "UNAVAILABLE", message: "Task write failed" });
    };
    expect(await client.createBot({ ...input })).toEqual({ botId: "viral", missing: ["task"] });
    expect(accounts().creation).toMatchObject({
      status: "partial",
      botId: "viral",
      missing: ["task"],
      error: "Viral was created, but its first task was not made: Task write failed.",
    });
    // Create is not offered again for it: it exists.
    await expect(client.createBot({ ...input })).rejects.toThrow(/exists already/);
    fake.gateway.handlers["sessions.create"] = () => ({ ok: true });
    expect(await client.finishBot("viral")).toEqual({ botId: "viral", missing: [] });
    expect(accounts().creation).toMatchObject({ status: "created", missing: [] });
    expect(fake.gateway.calls("agents.create")).toHaveLength(1);
    expect(fake.gateway.calls("sessions.create")).toEqual([
      { key: "agent:viral:main", agentId: "viral", label: "Main" },
      { key: "agent:viral:main", agentId: "viral", label: "Main" },
    ]);
    client.stop();
  });

  it("with the gateway choosing: no account suffix and an empty fallback list", async () => {
    const { client, fake, accounts } = await accountsClient();
    await client.createBot({ ...input, name: "", account: null });
    expect(fake.gateway.calls("agents.create")).toEqual([{ name: "New bot", model: "acme/dev-1" }]);
    expect(binding(accounts(), "new-bot")).toMatchObject({
      mode: "gateway",
      account: null,
      fallbacks: [],
    });
    expect(accountWord(binding(accounts(), "new-bot"))).toBe("gateway");
    client.stop();
  });

  it("a bot Clawtrate set whose model has no fallback list is reported, also after a restart", async () => {
    const fake = new AccountsGateway();
    fake.prefs["clawtrate.bot-account.pip"] = { mode: "account", account: "acme:home" };
    (
      (fake.config.agents as Record<string, unknown>).entries as Record<
        string,
        Record<string, unknown>
      >
    ).pip!.model = "acme/dev-1@acme:home";
    const { client, accounts } = await accountsClient({ gateway: fake });
    expect(binding(accounts(), "pip")).toMatchObject({ fallbacks: null, fallbacksUnwritten: true });
    // A bot Clawtrate never set is not its to report.
    expect(binding(accounts(), "otto").fallbacksUnwritten).toBe(false);
    client.stop();
  });
});

describe("the first bot (bots.md section 3): only on a confirmed unused implicit main", () => {
  const unnamedMain = {
    defaultId: "main",
    mainKey: "main",
    scope: "per-sender",
    agents: [{ id: "main", defaultPermissionMode: "read-only" }],
  };
  const noRoster = { config: { gateway: { mode: "local" } }, hash: "h1", valid: true };
  const noTasks = { sessions: [], count: 0, totalCount: 0, hasMore: false, nextOffset: null };

  it("successful reads of exactly one unnamed, non-degraded main, no roster in the config and no tasks: the prompt, with Main's reported policy", () => {
    expect(readFirstBot(unnamedMain, noRoster, noTasks)).toEqual({
      status: "prompt",
      mainPolicy: "read-only",
    });
    expect(readFirstBot({ ...unnamedMain, agents: [{ id: "main" }] }, noRoster, noTasks)).toEqual({
      status: "prompt",
      mainPolicy: null,
    });
    expect(
      readFirstBot(
        unnamedMain,
        { config: { agents: { defaults: { model: { primary: "acme/dev-1" } } } }, valid: true },
        noTasks,
      ).status,
    ).toBe("prompt");
    // A list that carries only `count` proves it with `hasMore: false`.
    expect(readFirstBot(unnamedMain, noRoster, { sessions: [], count: 0, hasMore: false })).toEqual(
      { status: "prompt", mainPolicy: "read-only" },
    );
  });

  for (const [why, list, config, sessions] of [
    [
      "the legacy agents.list in the config",
      unnamedMain,
      { config: { agents: { list: [{ id: "main" }] } } },
      noTasks,
    ],
    [
      "a main configured in agents.entries",
      unnamedMain,
      { config: { agents: { entries: { main: {} } } } },
      noTasks,
    ],
    [
      "main with tasks",
      unnamedMain,
      noRoster,
      { sessions: [{ key: "agent:main:main" }], hasMore: false },
    ],
    ["a session list with more to read", unnamedMain, noRoster, { sessions: [], hasMore: true }],
    [
      "an empty page of a list that counts tasks",
      unnamedMain,
      noRoster,
      { sessions: [], count: 0, totalCount: 3, hasMore: false },
    ],
    [
      "an empty page with a next offset",
      unnamedMain,
      noRoster,
      { sessions: [], count: 0, totalCount: 0, hasMore: false, nextOffset: 1 },
    ],
    ["an empty page without counts", unnamedMain, noRoster, { sessions: [], hasMore: false }],
    [
      "an empty page that counts nothing and may have more",
      unnamedMain,
      noRoster,
      { sessions: [], count: 0 },
    ],
    ["a config the gateway says is invalid", unnamedMain, { ...noRoster, valid: false }, noTasks],
    [
      "a config read that doesn't say it is valid",
      unnamedMain,
      { config: noRoster.config, hash: "h1" },
      noTasks,
    ],
    ["a session list that isn't one", unnamedMain, noRoster, { ok: true }],
    ["a config read that carried no config", unnamedMain, { hash: "h1", valid: true }, noTasks],
    [
      "a named main",
      { ...unnamedMain, agents: [{ id: "main", name: "Juniper" }] },
      noRoster,
      noTasks,
    ],
    [
      "a main named in its identity",
      { ...unnamedMain, agents: [{ id: "main", identity: { name: "Juniper" } }] },
      noRoster,
      noTasks,
    ],
    [
      "a degraded main",
      { ...unnamedMain, agents: [{ id: "main", status: "degraded" }] },
      noRoster,
      noTasks,
    ],
    ["two agents", { ...unnamedMain, agents: [{ id: "main" }, { id: "pip" }] }, noRoster, noTasks],
    ["no agents", { ...unnamedMain, agents: [] }, noRoster, noTasks],
    ["another default", { ...unnamedMain, defaultId: "pip" }, noRoster, noTasks],
    ["a list that isn't one", null, noRoster, noTasks],
  ] as const) {
    it(`the normal roster with ${why}`, () => {
      expect(readFirstBot(list, config, sessions)).toEqual({ status: "roster", mainPolicy: null });
    });
  }

  const implicitGateway = () => {
    const fake = new AccountsGateway();
    fake.bots = [];
    fake.config = {
      gateway: { mode: "local" },
      agents: { defaults: { model: { primary: "acme/dev-1" } } },
      auth: { profiles: {} },
    };
    const sessions = fake.gateway.handlers["sessions.list"]!;
    fake.gateway.handlers["sessions.list"] = (params) =>
      (params as { agentId?: string }).agentId === "main"
        ? { sessions: [], count: 0, totalCount: 0, hasMore: false, nextOffset: null }
        : sessions(params);
    fake.gateway.handlers["agents.list"] = () => {
      const listed = fake.bots.length > 0 ? fake.bots : [{ id: "main", name: "" }];
      return {
        defaultId: fake.bots[0]?.id ?? "main",
        mainKey: "main",
        scope: "per-sender",
        agents: listed.map((bot) => ({
          id: bot.id,
          ...(bot.name ? { identity: { name: bot.name } } : {}),
          defaultPermissionMode: fake.reportedPolicy(bot.id),
        })),
      };
    };
    return fake;
  };

  it("a client on such a gateway opens on the prompt; after Create the roster is what the gateway lists, the new bot alone", async () => {
    const fake = implicitGateway();
    const { client, accounts } = await accountsClient({ gateway: fake });
    await until(() => accounts().firstBot.status === "prompt");
    expect(accounts().firstBot).toEqual({ status: "prompt", mainPolicy: "read-only" });
    expect(fake.gateway.calls("sessions.list")).toContainEqual({
      agentId: "main",
      archived: "all",
      includeGlobal: true,
      includeUnknown: true,
      limit: 1,
    });
    expect(await client.recheckFirstBot()).toEqual({ status: "prompt", mainPolicy: "read-only" });
    await client.createBot({ ...viral, account: null });
    expect(client.state.bots.map((bot) => bot.id)).toEqual(["viral"]);
    expect(accounts().firstBot.status).toBe("roster");
    expect(note(accounts())).toMatchObject({ status: "confirmed", reported: "guarded" });
    client.stop();
  });

  it("a failed read of the config or the session list shows the normal roster", async () => {
    for (const method of ["config.get", "sessions.list"]) {
      const fake = implicitGateway();
      const real = fake.gateway.handlers[method]!;
      fake.gateway.handlers[method] = (params) => {
        if (method === "sessions.list" && (params as { agentId?: string }).agentId !== "main")
          return real(params);
        throw new GatewayError({ code: "UNAVAILABLE", message: "not now" });
      };
      const { client, accounts } = await accountsClient({ gateway: fake });
      await until(() => accounts().firstBot.status === "roster");
      client.stop();
    }
  });

  it("F-005: a failed recheck after a confirmed prompt takes the prompt away", async () => {
    const fake = implicitGateway();
    const { client, accounts } = await accountsClient({ gateway: fake });
    await until(() => accounts().firstBot.status === "prompt");
    fake.gateway.handlers["agents.list"] = () => {
      throw new GatewayError({ code: "UNAVAILABLE", message: "not now" });
    };
    expect(await client.recheckFirstBot()).toEqual({ status: "roster", mainPolicy: null });
    expect(accounts().firstBot.status).not.toBe("prompt");
    client.stop();
  });

  it("F-005: a lost connection takes the prompt away, and a read the old connection asked is not shown", async () => {
    const fake = implicitGateway();
    const held = deferred<unknown>();
    const complete = { sessions: [], count: 0, totalCount: 0, hasMore: false, nextOffset: null };
    let mainReads = 0;
    const sessions = fake.gateway.handlers["sessions.list"]!;
    fake.gateway.handlers["sessions.list"] = (params) => {
      if ((params as { agentId?: string }).agentId !== "main") return sessions(params);
      mainReads += 1;
      // The first connection's read answers late; the next connection's reads never answer.
      return mainReads === 1 ? held.promise : new Promise(() => {});
    };
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: JSON.stringify({
        token: "device-token",
        grantedScopes: ADMIN_SCOPES,
        heldScopes: ADMIN_SCOPES.filter((scope) => scope !== "operator.admin"),
        adminHeld: true,
      }),
    });
    // Slow to reconnect: the old connection's read answers while there is none.
    const client = new ClawtrateClient(testHost(fake.gateway, storage), {
      reconnect: { initialMs: 1500, maxMs: 1500 },
    });
    await client.start();
    await until(() => mainReads === 1);
    fake.gateway.dropAll();
    await until(() => client.state.connection.status !== "connected");
    held.resolve(complete);
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 50));
    expect(client.state.accounts.firstBot.status).not.toBe("prompt");
    client.stop();

    // A prompt already shown goes with its connection.
    const shown = implicitGateway();
    const second = await accountsClient({ gateway: shown });
    await until(() => second.accounts().firstBot.status === "prompt");
    let blocked = false;
    const reads = shown.gateway.handlers["sessions.list"]!;
    shown.gateway.handlers["sessions.list"] = (params) => {
      if ((params as { agentId?: string }).agentId !== "main") return reads(params);
      blocked = true;
      return new Promise(() => {});
    };
    shown.gateway.dropAll();
    await until(() => blocked);
    expect(second.accounts().firstBot.status).not.toBe("prompt");
    second.client.stop();
  });

  it("main with tasks on the gateway is the normal roster, shown as a bot", async () => {
    const fake = implicitGateway();
    fake.gateway.handlers["sessions.list"] = () => ({
      sessions: [{ key: "agent:main:main", sessionId: "s1" }],
      hasMore: false,
    });
    const { client, accounts } = await accountsClient({ gateway: fake });
    await until(() => accounts().firstBot.status === "roster");
    expect(client.state.bots.map((bot) => bot.id)).toEqual(["main"]);
    client.stop();
  });
});

describe("labels", () => {
  it("a label that reads like another's, differing only in spaces or case, is refused", () => {
    const others = [
      {
        id: "acme:home",
        provider: "acme",
        label: "My  plan",
        type: "oauth",
        status: "ok",
        expiresAt: null,
        kind: "subscription" as const,
        made: "sign-in" as const,
        keptBy: null,
        logoutSupported: true,
      },
    ];
    expect(labelProblem(others, "acme:work", "my plan")).toMatch(/Another Acme account/);
    expect(labelProblem(others, "acme:work", " MY   PLAN ")).toMatch(/Another Acme account/);
    expect(labelProblem(others, "acme:work", "My plans")).toBeNull();
  });
});

describe("how an account was made", () => {
  it("a record that says only key says nothing of where it was entered: it is read as not known", async () => {
    const fake = new AccountsGateway();
    fake.prefs["clawtrate.account-kind.acme:work"] = "key";
    const { client, accounts } = await accountsClient({ gateway: fake });
    expect(accounts().accounts.find((a) => a.id === "acme:work")).toMatchObject({
      kind: "key",
      made: null,
    });
    client.stop();
  });

  it("tells a key typed into Clawtrate from a key a browser sign-in saved", async () => {
    const fake = new AccountsGateway();
    fake.prefs["clawtrate.account-kind.acme:work"] = "typed-key";
    fake.prefs["clawtrate.account-kind.acme:home"] = "sign-in-key";
    const { client, accounts } = await accountsClient({ gateway: fake });
    try {
      const find = (id: string) => accounts().accounts.find((a) => a.id === id);
      expect(find("acme:work")).toMatchObject({ kind: "key", made: "typed" });
      expect(find("acme:home")).toMatchObject({ kind: "key", made: "sign-in" });
      // An account Clawtrate has no record of was added on the gateway.
      expect(find("globex:team") ?? find("acme:studio")).toMatchObject({
        kind: "gateway",
        made: null,
      });
    } finally {
      client.stop();
    }
  });
});

describe("sign-ins, through the gateway's own methods", () => {
  it("a link and a code: starting, waiting with the code and the link, connected, and where it landed", async () => {
    const fake = new AccountsGateway();
    fake.orders.otto = { acme: ["acme:work"] };
    const { client, accounts } = await accountsClient({ gateway: fake });
    const started = client.startSignIn(CHOICES.device, "pip");
    expect(accounts().signIn).toMatchObject({
      stage: "starting",
      forBot: "main",
      keptOnly: false,
      flow: "code",
    });
    await started;
    expect(accounts().signIn).toMatchObject({
      stage: "waiting",
      step: {
        code: "QK4F-7PZD",
        expiresInMinutes: 15,
        url: "http://127.0.0.1:1/scripted/signin/device?code=QK4F-7PZD",
      },
    });
    const login = fake.gateway.calls("models.authLogin")[0] as {
      agentId: string;
      authChoice: string;
    };
    expect(login).toMatchObject({ agentId: "main", authChoice: CHOICES.device });
    fake.answerDevice();
    await until(() => accounts().signIn?.stage === "connected");
    // The read after it: the target's view and another bot's, refreshed.
    expect(accounts().signIn?.result).toMatchObject({
      added: ["acme:travel"],
      landed: "shared",
      keptBy: null,
      readFailed: false,
    });
    // Otto's lock was checked after the sign-in.
    expect(accounts().signIn?.result?.locks).toEqual([
      { botId: "otto", account: "acme:work", outcome: "kept" },
    ]);
    expect(fake.prefs["clawtrate.account-kind.acme:travel"]).toBe("subscription");
    expect(accounts().accounts.find((a) => a.id === "acme:travel")).toMatchObject({
      kind: "subscription",
      made: "sign-in",
      keptBy: null,
    });
    client.stop();
  });

  it("a sign-in that adds the new account to a locked bot's order says the lock widened", async () => {
    const fake = new AccountsGateway();
    fake.orders.main = { acme: ["acme:work"] };
    (
      (fake.config.agents as Record<string, unknown>).entries as Record<
        string,
        Record<string, unknown>
      >
    ).main!.model = {
      primary: "acme/dev-1@acme:work",
      fallbacks: [],
    };
    const { client, accounts } = await accountsClient({ gateway: fake });
    expect(accountWord(binding(accounts(), "main"))).toBe("locked");
    await client.startSignIn(CHOICES.device, null);
    fake.answerDevice();
    await until(() => accounts().signIn?.stage === "connected");
    expect(accounts().signIn?.result?.locks).toEqual([
      { botId: "main", account: "acme:work", outcome: "widened" },
    ]);
    client.stop();
  });

  it("a lock check that fails after a sign-in is unchecked: it never says the lock widened", async () => {
    const fake = new AccountsGateway();
    fake.orders.pip = { acme: ["acme:home"] };
    const { client, accounts } = await accountsClient({ gateway: fake });
    expect(accountWord(binding(accounts(), "pip"))).toBe("locked");
    await client.startSignIn(CHOICES.device, null);
    // The read after the sign-in reads main and one other bot; only Pip's own check fails.
    fake.failStatusFor = "pip";
    fake.answerDevice();
    await until(() => accounts().signIn?.stage === "connected");
    expect(accounts().signIn?.result?.locks).toEqual([
      { botId: "pip", account: "acme:home", outcome: "unchecked" },
    ]);
    client.stop();
  });

  for (const [outcome, stage] of [
    ["refuse", "failed"],
    ["expire", "expired"],
  ] as const) {
    it(`a link and a code that ends ${stage}: the gateway's words, and a read of what it now has`, async () => {
      const fake = new AccountsGateway();
      fake.nextEnding = { outcome };
      const { client, accounts } = await accountsClient({ gateway: fake });
      await client.startSignIn(CHOICES.device, null);
      fake.answerDevice();
      await until(
        () => accounts().signIn?.result !== null && accounts().signIn?.result !== undefined,
      );
      expect(accounts().signIn).toMatchObject({ stage });
      expect(accounts().signIn?.error).toMatch(outcome === "refuse" ? /refused/ : /expired/);
      expect(accounts().signIn?.result).toMatchObject({ added: [], readFailed: false });
      client.stop();
    });
  }

  it("cancelled: wizard.cancel, then what the gateway now has", async () => {
    const { client, fake, accounts } = await accountsClient();
    await client.startSignIn(CHOICES.device, null);
    await client.cancelSignIn();
    expect(fake.gateway.calls("wizard.cancel")).toHaveLength(1);
    await until(() => accounts().signIn?.result !== null);
    expect(accounts().signIn).toMatchObject({ stage: "cancelled", result: { added: [] } });
    client.stop();
  });

  it("a sign-in whose read afterwards fails is not called connected: it is unverified until a read shows the account", async () => {
    const { client, fake, accounts } = await accountsClient();
    await client.startSignIn(CHOICES.device, null);
    fake.failStatusFor = "main";
    fake.answerDevice();
    await until(() => accounts().signIn?.result != null);
    expect(accounts().signIn).toMatchObject({
      stage: "unverified",
      result: { readFailed: true, added: [] },
    });
    // Read again, now that the gateway answers: the account is there.
    fake.failStatusFor = null;
    await client.recheckSignIn();
    expect(accounts().signIn).toMatchObject({
      stage: "connected",
      result: { readFailed: false, added: ["acme:travel"], landed: "shared" },
    });
    client.stop();
  });

  it("a sign-in that finishes with no new account is refreshed, not connected", async () => {
    const fake = new AccountsGateway();
    fake.nextEnding = { outcome: "approve", account: "work" };
    const { client, accounts } = await accountsClient({ gateway: fake });
    await client.startSignIn(CHOICES.device, null);
    fake.answerDevice();
    await until(() => accounts().signIn?.result != null);
    expect(accounts().signIn).toMatchObject({ stage: "refreshed", result: { added: [] } });
    client.stop();
  });

  it("a cancel the gateway does not confirm is reported as unknown, never as cancelled or saving; the accounts are read again and the sign-in is kept", async () => {
    const { client, fake, accounts } = await accountsClient();
    await client.startSignIn(CHOICES.device, null);
    fake.gateway.handlers["wizard.cancel"] = () => {
      throw new GatewayError({ code: "UNAVAILABLE", message: "Cancel status unavailable" });
    };
    const reads = fake.gateway.calls("models.authStatus").length;
    expect(await client.cancelSignIn()).toEqual({ cancelled: false });
    expect(accounts().signIn).toMatchObject({
      stage: "waiting",
      saving: false,
      cancelUnknown: true,
      error: "Cancel status unavailable",
    });
    await until(() => fake.gateway.calls("models.authStatus").length > reads);
    // Letting it go would hide a sign-in that may still be running on the gateway.
    expect(await client.dismissSignIn()).toEqual({ dismissed: false });
    expect(accounts().signIn?.stage).toBe("waiting");
    client.stop();
  });

  it("a cancel refused for any reason but saving is unknown: never saving, and the accounts are read again", async () => {
    const { client, fake, accounts } = await accountsClient();
    await client.startSignIn(CHOICES.browser, null);
    fake.gateway.handlers["wizard.cancel"] = () => {
      throw new GatewayError({ code: "INVALID_REQUEST", message: "Cannot cancel: too late" });
    };
    const reads = fake.gateway.calls("models.authStatus").length;
    expect(await client.cancelSignIn()).toEqual({ cancelled: false });
    expect(accounts().signIn).toMatchObject({ cancelUnknown: true, saving: false });
    await until(() => fake.gateway.calls("models.authStatus").length > reads);
    client.stop();
  });

  it("two new accounts after a sign-in that names neither: both are named, and the person's choice is its account", async () => {
    const { client, fake, accounts } = await accountsClient();
    const next = fake.gateway.handlers["wizard.next"]!;
    fake.gateway.handlers["wizard.next"] = (params) => {
      if (!(params as { answer?: unknown }).answer) return next(params);
      fake.shared.push(
        { id: "acme:elsewhere", provider: "acme", type: "oauth" },
        { id: "acme:mine", provider: "acme", type: "oauth" },
      );
      return { done: true, status: "done" };
    };
    await client.startSignIn(CHOICES.browser, null);
    await client.answerSignIn("made-up-code-several");
    expect(accounts().signIn).toMatchObject({
      stage: "several",
      result: { added: ["acme:elsewhere", "acme:mine"] },
    });
    // Nothing is recorded of either until the person says which is theirs.
    expect(Object.keys(fake.prefs).filter((key) => key.includes("acme:elsewhere"))).toEqual([]);
    await client.chooseSignInAccount("acme:mine");
    expect(accounts().signIn).toMatchObject({
      stage: "connected",
      result: { added: ["acme:mine"], landed: "shared" },
    });
    expect(fake.prefs["clawtrate.account-kind.acme:mine"]).toBeDefined();
    expect(fake.prefs["clawtrate.account-kind.acme:elsewhere"]).toBeUndefined();
    await expect(client.chooseSignInAccount("acme:work")).rejects.toThrow();
    client.stop();
  });

  it("a key saved directly whose read afterwards fails is not called saved, and names no account", async () => {
    const { client, fake, accounts } = await accountsClient();
    fake.gateway.handlers["models.authSetApiKey"] = () => ({ profileId: "globex:direct" });
    fake.failStatusFor = "main";
    expect(await client.saveApiKey("globex", "made-up-key-direct-0001", null)).toEqual({
      profileId: null,
    });
    expect(accounts().write).toMatchObject({ what: "key", status: "unverified" });
    expect(accounts().write?.error).toMatch(/reading its accounts afterwards failed/);
    expect(fake.prefs["clawtrate.account-kind.globex:direct"]).toBeUndefined();
    client.stop();
  });

  it("too late to cancel: the gateway refuses because it is saving", async () => {
    const { client, fake, accounts } = await accountsClient();
    await client.startSignIn(CHOICES.device, null);
    fake.refuseCancel = true;
    await client.cancelSignIn();
    expect(accounts().signIn).toMatchObject({ stage: "waiting", saving: true });
    fake.answerDevice();
    await until(() => accounts().signIn?.stage === "connected");
    client.stop();
  });

  it("saved, not confirmed: the gateway saved it and said it could not confirm; the account is read", async () => {
    const fake = new AccountsGateway();
    fake.nextEnding = { outcome: "unconfirmed", account: "spare" };
    const { client, accounts } = await accountsClient({ gateway: fake });
    await client.startSignIn(CHOICES.device, null);
    fake.answerDevice();
    await until(() => accounts().signIn?.result != null);
    expect(accounts().signIn).toMatchObject({
      stage: "unconfirmed",
      result: { added: ["acme:spare"] },
    });
    expect(accounts().signIn?.error).toMatch(/could not confirm/);
    client.stop();
  });

  it("the gateway is busy: it runs one sign-in at a time", async () => {
    const { client, fake, accounts } = await accountsClient();
    fake.sessions.set("other", {
      id: "other",
      choice: CHOICES.device,
      agentId: "main",
      phase: "waiting",
      ending: { outcome: "refuse" },
      release: null,
      result: null,
      answers: [],
    });
    await client.startSignIn(CHOICES.device, null);
    expect(accounts().signIn).toMatchObject({ stage: "busy" });
    expect(accounts().signIn?.error).toMatch(/already in progress/);
    client.stop();
  });

  it("the connection dropped: the sign-in ended with it, and the accounts are read after the reconnect", async () => {
    const { client, fake, accounts } = await accountsClient();
    await client.startSignIn(CHOICES.device, null);
    expect(accounts().signIn?.stage).toBe("waiting");
    fake.gateway.dropAll();
    await until(() => accounts().signIn?.stage === "ended");
    await until(() => client.state.connection.status === "connected");
    await until(() => accounts().signIn?.result !== null);
    expect(accounts().signIn?.result).toMatchObject({ added: [] });
    client.stop();
  });

  it("known beforehand that it can't be shared: no main bot with its own store, so it is started for the bot worked on", async () => {
    const fake = new AccountsGateway();
    (
      (fake.config.agents as Record<string, unknown>).entries as Record<
        string,
        Record<string, unknown>
      >
    ).main!.agentDir = "/s/agents/main/own";
    const { client, accounts } = await accountsClient({ gateway: fake });
    expect(accounts().mainShared).toBe(false);
    await client.startSignIn(CHOICES.device, "pip");
    expect(accounts().signIn).toMatchObject({ forBot: "pip", keptOnly: true });
    fake.answerDevice();
    await until(() => accounts().signIn?.stage === "connected");
    expect(accounts().signIn?.result).toMatchObject({
      added: ["acme:travel"],
      landed: "kept",
      keptBy: "pip",
    });
    expect(accounts().accounts.find((a) => a.id === "acme:travel")?.keptBy).toBe("pip");
    client.stop();
  });

  it("in the browser, the code pasted back: sent once in the next step and kept nowhere", async () => {
    const { client, fake, accounts } = await accountsClient();
    await client.startSignIn(CHOICES.browser, null);
    expect(accounts().signIn).toMatchObject({
      stage: "entering",
      step: {
        sensitive: true,
        placeholder: "Code or address",
        url: "http://127.0.0.1:1/scripted/signin/browser?state=s1",
      },
    });
    const code = "one-time-code-7Q2Z";
    await client.answerSignIn(code);
    await until(() => accounts().signIn?.stage === "connected");
    expect(fake.typed).toContain(code);
    expect(JSON.stringify(client.state)).not.toContain(code);
    client.stop();
  });

  it("a choice the gateway asks that Clawtrate does not offer ends the sign-in rather than guessing", async () => {
    const { client, fake, accounts } = await accountsClient();
    fake.gateway.handlers["wizard.next"] = () => ({
      done: false,
      status: "running",
      step: { id: "s", type: "select", options: [] },
    });
    await client.startSignIn(CHOICES.device, null);
    await until(() => accounts().signIn?.result != null);
    expect(accounts().signIn?.stage).toBe("failed");
    expect(fake.gateway.calls("wizard.cancel")).toHaveLength(1);
    client.stop();
  });
});

/** Every string reachable from `root` through own properties, maps, sets and arrays. */
function reachable(root: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 40) return;
    if (typeof value === "string") return void out.push(value);
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (value instanceof Map)
      for (const [k, v] of value) {
        visit(k, depth + 1);
        visit(v, depth + 1);
      }
    else if (value instanceof Set || Array.isArray(value))
      for (const v of value) visit(v, depth + 1);
    else
      for (const key of Reflect.ownKeys(value))
        visit((value as Record<string | symbol, unknown>)[key], depth + 1);
  };
  visit(root, 0);
  return out;
}

describe("a typed API key leaves no trace", () => {
  const KEY = "clawtrate-dev-key.acme.made-up-0042";

  async function traceless(
    client: ClawtrateClient,
    storage: { data: Map<string, string> },
    logs: string[],
    key: string,
  ) {
    // The state, what a viewer's snapshot carries, everything the host stores and logs,
    // and every string the client object holds in any field or collection.
    expect(JSON.stringify(client.state)).not.toContain(key);
    expect(JSON.stringify([...storage.data.entries()])).not.toContain(key);
    expect(logs.join("\n")).not.toContain(key);
    expect(reachable(client).some((text) => text.includes(key))).toBe(false);
  }

  async function keyClient(fake = new AccountsGateway()) {
    const logs: string[] = [];
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: JSON.stringify({
        token: "device-token",
        grantedScopes: ADMIN_SCOPES,
        heldScopes: INTERACTIVE_SCOPES,
        adminHeld: true,
      }),
    });
    const host = {
      ...testHost(fake.gateway, storage),
      log: (_level: string, message: string) => void logs.push(message),
    };
    const client = new ClawtrateClient(host, FAST);
    await client.start();
    await until(() => client.state.discovery.status === "ready");
    await client.refreshAccounts();
    return { client, storage, logs, fake };
  }

  it("through the provider's key sign-in: saved, sent once, and absent afterwards", async () => {
    const { client, storage, logs, fake } = await keyClient();
    const { profileId } = await client.saveApiKey("acme", KEY, null);
    expect(profileId).toBe("acme:travel");
    expect(fake.typed.filter((value) => value === KEY)).toHaveLength(1);
    expect(client.state.accounts.signIn).toMatchObject({ stage: "connected", byKey: true });
    expect(fake.prefs["clawtrate.account-kind.acme:travel"]).toBe("typed-key");
    await traceless(client, storage, logs, KEY);
    client.stop();
  });

  it("through the provider's key sign-in, refused by a gateway that echoes it: absent from the error and everywhere", async () => {
    const fake = new AccountsGateway();
    fake.nextEnding = { outcome: "refuse" };
    fake.echoTyped = true;
    const { client, storage, logs } = await keyClient(fake);
    await client.saveApiKey("acme", KEY, null);
    expect(client.state.accounts.signIn?.stage).toBe("failed");
    expect(client.state.accounts.signIn?.error).toMatch(/refused/);
    await traceless(client, storage, logs, KEY);
    client.stop();
  });

  it("through models.authSetApiKey: saved, and absent afterwards; refused with an echo, absent from the error", async () => {
    const { client, storage, logs, fake } = await keyClient();
    const { profileId } = await client.saveApiKey("globex", KEY, null);
    expect(profileId).toBe("globex:manual");
    await traceless(client, storage, logs, KEY);

    fake.echoTyped = true;
    const refused = `${KEY}-refused`;
    const error = await client
      .saveApiKey("globex", refused, null)
      .catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/refused/);
    expect((error as Error).message).not.toContain(refused);
    await traceless(client, storage, logs, refused);
    await traceless(client, storage, logs, KEY);
    client.stop();
  });

  it("through the bridge, as a viewer sends it: the command's answer and every snapshot carry none of it", async () => {
    const { client, storage, logs } = await keyClient();
    const viewer = createBridgeSession(client);
    const snapshots: string[] = [];
    const stop = client.store.subscribe((state) => void snapshots.push(JSON.stringify(state)));
    const answer = await viewer.apply({
      type: "saveApiKey",
      provider: "globex",
      key: KEY,
      botId: null,
    });
    stop();
    expect(JSON.stringify(answer)).not.toContain(KEY);
    expect(snapshots.join("")).not.toContain(KEY);
    await traceless(client, storage, logs, KEY);
    viewer.dispose();
    client.stop();
  });

  /** The engine's own copy of what was typed, which must be gone once the sign-in has ended. */
  const held = (client: ClawtrateClient) =>
    (client as unknown as { accounts: { secrets: string[] } }).accounts.secrets;

  it("a later step that echoes a pasted code, in its message or title, shows it to nobody", async () => {
    const { client, storage, logs, fake } = await keyClient();
    const code = "one-time-code-echoed-9Z";
    const next = fake.gateway.handlers["wizard.next"]!;
    fake.gateway.handlers["wizard.next"] = (params) => {
      const { answer } = params as { answer?: { value: string } };
      return answer
        ? {
            done: false,
            status: "running",
            step: {
              id: `retry-${answer.value}`,
              type: "text",
              sensitive: true,
              title: `Code ${answer.value} was not accepted`,
              message: `Code rejected: ${answer.value.trim()}`,
              placeholder: answer.value,
            },
          }
        : next(params);
    };
    await client.startSignIn(CHOICES.browser, null);
    await client.answerSignIn(` ${code} `);
    // Still under way, waiting for another answer: the step is shown, without the code.
    expect(client.state.accounts.signIn).toMatchObject({ stage: "entering" });
    expect(client.state.accounts.signIn?.step?.title).toBe("Code … was not accepted");
    expect(JSON.stringify(client.state)).not.toContain(code);
    // Once the sign-in ends, nothing of it is held.
    await client.dismissSignIn();
    expect(held(client)).toEqual([]);
    await traceless(client, storage, logs, code);
  });

  it("a key echoed by a later step of the key sign-in is shown to nobody, and forgotten when it ends", async () => {
    const { client, storage, logs, fake } = await keyClient();
    const next = fake.gateway.handlers["wizard.next"]!;
    fake.gateway.handlers["wizard.next"] = (params) => {
      const { answer } = params as { answer?: { value: unknown } };
      return answer && typeof answer.value === "string"
        ? {
            done: false,
            status: "running",
            step: {
              id: "again",
              type: "text",
              sensitive: true,
              title: `Key rejected: ${answer.value}`,
            },
          }
        : next(params);
    };
    await client.saveApiKey("acme", KEY, null);
    expect(client.state.accounts.signIn?.step?.title).toBe("Key rejected: …");
    expect(JSON.stringify(client.state)).not.toContain(KEY);
    await client.dismissSignIn();
    expect(held(client)).toEqual([]);
    await traceless(client, storage, logs, KEY);
  });

  it("a failure in the middle that echoes a pasted address's code, decoded, shows none of it", async () => {
    const { client, storage, logs, fake } = await keyClient();
    const address = "http://127.0.0.1:1/callback?code=abc%2Fdef-4417&state=s1";
    const decoded = "abc/def-4417";
    const next = fake.gateway.handlers["wizard.next"]!;
    fake.gateway.handlers["wizard.next"] = (params) => {
      if ((params as { answer?: unknown }).answer)
        throw new GatewayError({
          code: "UNAVAILABLE",
          message: `The provider refused code ${decoded}.`,
        });
      return next(params);
    };
    await client.startSignIn(CHOICES.browser, null);
    await client.answerSignIn(address);
    await until(() => client.state.accounts.signIn?.result != null);
    expect(client.state.accounts.signIn).toMatchObject({
      stage: "failed",
      error: "The provider refused code ….",
    });
    expect(held(client)).toEqual([]);
    for (const form of [address, decoded, "abc%2Fdef-4417"])
      await traceless(client, storage, logs, form);
  });

  it("a pasted address with many query values is held whole first: its pieces never push it out", async () => {
    const { client, storage, logs, fake } = await keyClient();
    const fields = Array.from({ length: 12 }, (_, i) => `f${i}=made-up-value-${i}`).join("&");
    const address = `http://127.0.0.1:1/scripted/back?code=made-up-code-77&${fields}`;
    const next = fake.gateway.handlers["wizard.next"]!;
    fake.gateway.handlers["wizard.next"] = (params) => {
      const { answer } = params as { answer?: { value: string } };
      return answer
        ? {
            done: false,
            status: "running",
            step: { id: "again", type: "text", message: `Got ${answer.value}` },
          }
        : next(params);
    };
    await client.startSignIn(CHOICES.browser, null);
    await client.answerSignIn(address);
    const shown = client.state.accounts.signIn?.step?.message ?? "";
    expect(shown).not.toContain(address);
    expect(shown).not.toContain("made-up-code-77");
    await client.dismissSignIn();
    await traceless(client, storage, logs, address);
  });

  it("the read after a sign-in that fails echoing the pasted code puts none of it in the accounts' error", async () => {
    const { client, fake } = await keyClient();
    const code = "made-up-code-read-after";
    const next = fake.gateway.handlers["wizard.next"]!;
    fake.gateway.handlers["wizard.next"] = (params) => {
      const { answer } = params as { answer?: { value: string } };
      if (!answer) return next(params);
      fake.gateway.handlers["models.authStatus"] = () => {
        throw new GatewayError({
          code: "UNAVAILABLE",
          message: `could not read after ${answer.value}`,
        });
      };
      return { done: true, status: "done" };
    };
    await client.startSignIn(CHOICES.browser, null);
    await client.answerSignIn(code);
    await until(() => client.state.accounts.status === "error");
    expect(client.state.accounts.signIn?.stage).toBe("unverified");
    expect(client.state.accounts.error).toContain("could not read after");
    expect(JSON.stringify(client.state)).not.toContain(code);
  });

  it("a key saved directly holds the key while it lasts: an echoing preference write logs none of it", async () => {
    const { client, storage, logs, fake } = await keyClient();
    const key = "clawtrate-dev-key.globex.made-up-direct";
    fake.gateway.handlers["models.authSetApiKey"] = () => {
      fake.shared.push({ id: "globex:direct", provider: "globex", type: "api_key" });
      return { profileId: "globex:direct" };
    };
    fake.gateway.handlers["users.prefs.set"] = () => {
      throw new GatewayError({ code: "UNAVAILABLE", message: `cannot store ${key}` });
    };
    await client.saveApiKey("globex", key, null);
    expect(logs.some((line) => line.startsWith("could not record an account's kind"))).toBe(true);
    await traceless(client, storage, logs, key);
  });

  it("the safety stop after 64 steps ends the sign-in as failed, says so, and forgets what it was given", async () => {
    const { client, storage, logs, fake } = await keyClient();
    const code = "made-up-code-endless";
    const next = fake.gateway.handlers["wizard.next"]!;
    let answered = false;
    fake.gateway.handlers["wizard.next"] = (params) => {
      answered ||= (params as { answer?: { value: unknown } }).answer?.value === code;
      return answered
        ? { done: false, status: "running", step: { id: "note", type: "note", message: "Noted" } }
        : next(params);
    };
    await client.startSignIn(CHOICES.browser, null);
    await client.answerSignIn(code);
    await until(() => client.state.accounts.signIn?.stage === "failed");
    expect(client.state.accounts.signIn?.error).toMatch(/64 steps/);
    expect(fake.gateway.calls("wizard.cancel")).toHaveLength(1);
    await traceless(client, storage, logs, code);
  });

  it("a log line that echoes the typed key while the sign-in lasts carries none of it", async () => {
    const { client, storage, logs, fake } = await keyClient();
    // The record of how the account was made is written before the sign-in ends; its error echoes the key.
    fake.gateway.handlers["users.prefs.set"] = () => {
      throw new GatewayError({
        code: "UNAVAILABLE",
        message: `cannot store ${String(fake.typed.filter((value) => typeof value === "string").at(-1))}`,
      });
    };
    await client.saveApiKey("acme", KEY, null);
    expect(logs.some((line) => line.startsWith("could not record an account's kind"))).toBe(true);
    await traceless(client, storage, logs, KEY);
  });

  it("withoutSecret takes a key out of anything the gateway answers", () => {
    expect(withoutSecret(`bad key ${KEY} here`, KEY)).toBe("bad key … here");
    expect(withoutSecret(`bad key ${KEY}`, ` ${KEY} `)).toBe("bad key …");
  });
});

describe("labels", () => {
  it("are written as the gateway's display name, and refused when another account of the provider has one", async () => {
    const { client, fake, accounts } = await accountsClient();
    await expect(client.setAccountLabel("acme:home", "work")).rejects.toThrow(
      /Another Acme account is called Work/,
    );
    expect(labelProblem(accounts().accounts, "acme:home", "  ")).toMatch(/another Acme account/);
    await client.setAccountLabel("acme:home", "  Studio  Two ");
    const patch = fake.gateway.calls("config.patch").at(-1) as { raw: string };
    expect(JSON.parse(patch.raw)).toEqual({
      auth: { profiles: { "acme:home": { displayName: "Studio Two" } } },
    });
    expect(accounts().accounts.find((a) => a.id === "acme:home")?.label).toBe("Studio Two");
    client.stop();
  });

  it("a profile the config does not list gets its provider and mode with the label", async () => {
    const { client, fake } = await accountsClient();
    await client.startSignIn(CHOICES.device, null);
    fake.answerDevice();
    await until(() => client.state.accounts.signIn?.stage === "connected");
    await client.setAccountLabel("acme:travel", "Travel");
    const patch = fake.gateway.calls("config.patch").at(-1) as { raw: string };
    expect(JSON.parse(patch.raw)).toEqual({
      auth: {
        profiles: { "acme:travel": { displayName: "Travel", provider: "acme", mode: "oauth" } },
      },
    });
    client.stop();
  });
});

describe("admin access", () => {
  it("is asked for only when the person asks, through the same request, and held once granted", async () => {
    const fake = new AccountsGateway();
    const wait = deferred<unknown>();
    fake.gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-9" });
    fake.gateway.handlers["device.scopes.waitUpgrade"] = () => wait.promise;
    const { client, storage, accounts } = await accountsClient({
      gateway: fake,
      scopes: INTERACTIVE_SCOPES,
    });
    expect(fake.gateway.calls("device.scopes.requestUpgrade")).toEqual([]);
    // A write below admin is refused before anything is sent.
    await expect(
      client.createBot({
        name: "Viral",
        avatar: null,
        account: "acme:work",
        provider: "acme",
        model: "dev-1",
        effort: null,
        approvals: "ask",
        attempt: null,
      }),
    ).rejects.toThrow(/needs admin access/);
    expect(fake.gateway.calls("agents.create")).toEqual([]);
    expect(accounts().accounts.length).toBeGreaterThan(0);

    await client.requestAccess("admin");
    await until(() => client.state.connection.upgrade.status === "pending");
    expect(fake.gateway.calls("device.scopes.requestUpgrade")).toEqual([
      { scopes: [...ADMIN_SCOPES] },
    ]);
    expect(client.state.connection.upgrade.scopes).toEqual([...ADMIN_SCOPES]);
    wait.resolve({
      status: "approved",
      requestId: "up-9",
      deviceToken: "rotated",
      scopes: [...ADMIN_SCOPES],
    });
    await until(() => client.state.connection.canAdmin);
    const stored = JSON.parse(storage.data.get(tokenKey(URL_A))!);
    expect(stored).toMatchObject({ adminHeld: true, heldScopes: [...ADMIN_SCOPES] });
    // Every later connect asks for what was granted.
    fake.gateway.dropAll();
    await until(
      () => client.state.connection.status === "connected" && client.state.connection.canAdmin,
    );
    const connects = fake.gateway.connects as Array<{ scopes: string[] }>;
    expect(connects.at(-1)!.scopes).toEqual([...ADMIN_SCOPES]);
    client.stop();
  });

  it("a read-only connection keeps every account screen's values", async () => {
    const { client, accounts } = await accountsClient({ scopes: READ_SCOPES });
    expect(accounts().status).toBe("ready");
    expect(accounts().bindings.length).toBe(3);
    await expect(client.startSignIn(CHOICES.device, null)).rejects.toThrow(/needs admin access/);
    client.stop();
  });
});

describe("the bounds", () => {
  it("keeps at most the bounded number of accounts, and the state within its schema", async () => {
    const fake = new AccountsGateway();
    for (let i = 0; i < 100; i += 1)
      fake.shared.push({ id: `acme:extra${i}`, provider: "acme", type: "api_key" });
    const { client, accounts } = await accountsClient({ gateway: fake });
    expect(accounts().accounts.length).toBeLessThanOrEqual(MAX_ACCOUNTS);
    expect(JSON.stringify(accounts()).length).toBeLessThanOrEqual(worstCase(ACCOUNTS));
    client.stop();
  });

  it("a state past every account bound is brought within them", () => {
    const huge = "x".repeat(5000);
    const state: ClawtrateState = {
      ...initialState,
      accounts: {
        ...initialState.accounts,
        error: huge,
        accounts: Array.from({ length: 200 }, (_, i) => ({
          id: `acme:${i}`,
          provider: "acme",
          label: huge,
          type: "oauth",
          status: "ok",
          expiresAt: 1,
          kind: "subscription",
          made: "sign-in",
          keptBy: null,
          logoutSupported: true,
        })),
      },
    };
    const enforced = enforceState(state);
    expect(enforced.accounts.accounts.length).toBe(MAX_ACCOUNTS);
    expect(JSON.stringify(enforced.accounts).length).toBeLessThanOrEqual(worstCase(ACCOUNTS));
  });

  it("preference entries Clawtrate did not write are not kept, so each record stays within its registered size", async () => {
    const fake = new AccountsGateway();
    const longId = `acme:${"x".repeat(3_000)}`;
    const largeAccount = `acme:${"y".repeat(3_500)}`;
    fake.prefs[`clawtrate.account-kind.${longId}`] = "subscription";
    fake.prefs["clawtrate.account-kind.acme:fine"] = "key";
    fake.prefs["clawtrate.bot-account.otto"] = { mode: "account", account: largeAccount };
    fake.prefs[`clawtrate.bot-account.${"b".repeat(400)}`] = { mode: "gateway" };
    fake.prefs["clawtrate.bot-account.pip"] = { mode: "account", account: "acme:home" };
    const { client } = await accountsClient({ gateway: fake });
    const engine = (
      client as unknown as {
        accounts: { kinds: Map<string, unknown>; intents: Map<string, unknown> };
      }
    ).accounts;
    expect([...engine.kinds.keys()]).toEqual(["acme:fine"]);
    expect([...engine.intents.keys()]).toEqual(["pip"]);
    for (const [path, map] of [
      ["accounts.kinds", engine.kinds],
      ["accounts.intents", engine.intents],
    ] as const) {
      for (const entry of map) {
        expect(JSON.stringify(entry).length, path).toBeLessThanOrEqual(CLIENT_OWNERS[path]!.each);
      }
    }
    client.stop();
  });

  it("an id that is short but grows when serialized is measured as it is kept, and is not kept", async () => {
    const fake = new AccountsGateway();
    // 125 characters as written, 727 as JSON: each control character is six.
    const grows = `acme:${"\u0002".repeat(120)}`;
    fake.prefs[`clawtrate.account-kind.${grows}`] = "subscription";
    fake.prefs["clawtrate.bot-account.otto"] = { mode: "account", account: grows };
    fake.prefs["clawtrate.bot-account.pip"] = { mode: "account", account: "acme:home" };
    const { client } = await accountsClient({ gateway: fake });
    const engine = (
      client as unknown as {
        accounts: { kinds: Map<string, unknown>; intents: Map<string, unknown> };
      }
    ).accounts;
    expect([...engine.kinds.keys()]).not.toContain(grows);
    expect([...engine.intents.keys()]).toEqual(["pip"]);
    client.stop();
  });

  it("a typed value held for a sign-in fits its registered size however it serializes", async () => {
    const { client, fake } = await accountsClient();
    const engine = (client as unknown as { accounts: { secrets: string[] } }).accounts;
    const next = fake.gateway.handlers["wizard.next"]!;
    fake.gateway.handlers["wizard.next"] = (params) =>
      (params as { answer?: unknown }).answer
        ? { done: false, status: "running", step: { id: "wait", type: "text", message: "Wait" } }
        : next(params);
    await client.startSignIn(CHOICES.browser, null);
    await client.answerSignIn("\u0003".repeat(MAX_SECRET_CHARS));
    expect(engine.secrets).toHaveLength(1);
    expect(JSON.stringify(engine.secrets[0]).length).toBeLessThanOrEqual(
      CLIENT_OWNERS["accounts.secrets"]!.each,
    );
    client.stop();
  });

  it("the engine's own records stay within their counts", async () => {
    const fake = new AccountsGateway();
    for (let i = 0; i < 100; i += 1)
      fake.prefs[`clawtrate.account-kind.acme:k${i}`] = "subscription";
    const { client } = await accountsClient({ gateway: fake });
    const engine = (client as unknown as { accounts: { kinds: Map<string, unknown> } }).accounts;
    expect(engine.kinds.size).toBeLessThanOrEqual(MAX_ACCOUNTS);
    client.stop();
  });
});
