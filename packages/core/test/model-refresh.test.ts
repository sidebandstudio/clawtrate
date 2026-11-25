// Refresh in the Model menu (#565, F-588): one press asks the gateway to look
// for a provider's models again, compares the menu's rows before and after, and
// says what the gateway reported for the provider. The answer is given only on
// the gateway and connection it was asked on, a second press shares the first,
// and the config's model list for bots is read with the accounts.

import { describe, expect, it } from "vitest";
import { parseBridgeCommand } from "../src/bridge.ts";
import {
  MAX_CATALOG_MODELS,
  MAX_REFRESH_NAME_CHARS,
  MAX_REFRESH_NAMES,
  readModelAllowlist,
} from "../src/accounts.ts";
import { READ_SCOPES } from "../src/scopes.ts";
import { AccountsEngine } from "../src/accounts-engine.ts";
import { initialAccountsState, type AccountsState } from "../src/accounts.ts";
import type { ReadStamp } from "../src/types.ts";
import { AccountsGateway, accountsClient } from "./accounts-fake.ts";
import { stampOn } from "./client-harness.ts";
import { deferred, until } from "./fake-gateway.ts";

type Json = Record<string, unknown>;
const row = (id: string, provider = "acme"): Json => ({
  id,
  provider,
  thinkingLevels: [],
  available: true,
});
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

describe("F-588: Refresh in the Model menu", () => {
  it("F-588: asks the gateway to look again for one provider, for the default bot, on a read-only connection", async () => {
    const { client, fake } = await accountsClient({ scopes: READ_SCOPES });
    const before = fake.gateway.calls("models.list").length;
    const result = await client.refreshModels("acme", stampOn("gateway-a", client));
    const calls = fake.gateway.calls("models.list").slice(before);
    expect(calls).toEqual([{ agentId: "main", provider: "acme", refresh: true }]);
    expect(result).toMatchObject({ status: "done", provider: "acme", addedCount: 0 });
    client.stop();
  });

  it("F-588: names the models the menu lists now and didn't before, and puts them in the menu", async () => {
    const fake = new AccountsGateway();
    const { client, accounts } = await accountsClient({ gateway: fake });
    fake.refreshed = { acme: [row("dev-1"), row("dev-4"), row("dev-2"), row("dev-5")] };
    const result = await client.refreshModels("acme", stampOn("gateway-a", client));
    expect(result).toMatchObject({
      status: "done",
      added: ["dev-4", "dev-5"],
      addedCount: 2,
      removed: [],
      removedCount: 0,
    });
    // The provider's rows in the gateway's order, where they were; the other provider's kept.
    expect(accounts().models.map((m) => `${m.provider}/${m.id}`)).toEqual([
      "acme/dev-1",
      "acme/dev-4",
      "acme/dev-2",
      "acme/dev-5",
      "globex/dev-1",
    ]);
    client.stop();
  });

  it("F-588: names the models it no longer lists", async () => {
    const fake = new AccountsGateway();
    const { client, accounts } = await accountsClient({ gateway: fake });
    fake.refreshed = { acme: [row("dev-1")] };
    const result = await client.refreshModels("acme", stampOn("gateway-a", client));
    expect(result).toMatchObject({ added: [], removed: ["dev-2"], removedCount: 1 });
    expect(
      accounts()
        .models.filter((m) => m.provider === "acme")
        .map((m) => m.id),
    ).toEqual(["dev-1"]);
    client.stop();
  });

  it("F-588: nothing new: the provider not asked again, and the config's list is the whole list only when it declares every model listed", async () => {
    const fake = new AccountsGateway();
    const { client } = await accountsClient({ gateway: fake });
    const ask = () => client.refreshModels("acme", stampOn("gateway-a", client));
    expect(await ask()).toMatchObject({
      addedCount: 0,
      removedCount: 0,
      outcome: null,
      configured: false,
      hostedList: true,
      counts: null,
      partial: false,
      failed: false,
    });
    const declare = (ids: string[], extra: Json = {}) => {
      fake.config.models = {
        providers: {
          acme: { baseUrl: "http://127.0.0.1:1/v1", models: ids.map((id) => ({ id })) },
        },
        ...extra,
      };
      fake.revision += 1;
    };
    // Every model the gateway lists for acme is declared: the config's list is the whole list.
    declare(["dev-1", "dev-2"]);
    expect(await ask()).toMatchObject({ outcome: null, configured: true });
    // One declared beside others the gateway lists of its own (merge mode): not the config's list.
    declare(["dev-1"]);
    expect(await ask()).toMatchObject({ outcome: null, configured: false });
    // The gateway that doesn't check OpenClaw's list online says so.
    declare(["dev-1"], { catalogRefresh: { enabled: false } });
    expect(await ask()).toMatchObject({ hostedList: false });
    client.stop();
  });
  it("F-588: a provider the gateway couldn't ask, with the gateway's reason; one account that answered is enough", async () => {
    const fake = new AccountsGateway();
    const { client } = await accountsClient({ gateway: fake });
    const ask = () => client.refreshModels("acme", stampOn("gateway-a", client));
    fake.refreshMarkers = {
      providerOutcomes: [{ provider: "acme", profileId: "acme:work", status: "auth-rejected" }],
    };
    expect(await ask()).toMatchObject({ outcome: "auth-rejected" });
    fake.refreshMarkers = { providerOutcomes: [{ provider: "acme", status: "unavailable" }] };
    expect(await ask()).toMatchObject({ outcome: "unavailable" });
    fake.refreshMarkers = {
      providerOutcomes: [
        { provider: "acme", profileId: "acme:home", status: "unavailable" },
        { provider: "acme", profileId: "acme:work", status: "ready" },
        { provider: "globex", status: "auth-rejected" },
      ],
    };
    expect(await ask()).toMatchObject({ outcome: "ready" });
    fake.refreshMarkers = { pendingProviders: ["acme"] };
    expect(await ask()).toMatchObject({ outcome: null, partial: true, failed: false });
    // A refresh the gateway says failed is not one still under way.
    fake.refreshMarkers = { refreshFailed: true };
    expect(await ask()).toMatchObject({ partial: false, failed: true });
    client.stop();
  });

  it("F-588: a gateway that refuses or fails the refresh: its reason, cleaned to one line", async () => {
    const fake = new AccountsGateway();
    const { client, accounts } = await accountsClient({ gateway: fake });
    const rows = JSON.stringify(accounts().models);
    fake.failRefresh = {
      code: "UNAVAILABLE",
      message: `Model catalog\u0000 is not ready.\nRetry ${"x".repeat(400)}`,
    };
    const result = await client.refreshModels("acme", stampOn("gateway-a", client));
    expect(result.status).toBe("error");
    const error = result.status === "error" ? result.error : "";
    expect(error.startsWith("Model catalog is not ready. Retry")).toBe(true);
    expect([...error].length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(accounts().models)).toBe(rows);
    client.stop();
  });

  it("F-588: names at most a few models, each cleaned and bounded, and counts the rest", async () => {
    const fake = new AccountsGateway();
    const { client } = await accountsClient({ gateway: fake });
    const long = `new-${"m".repeat(300)}`;
    fake.refreshed = {
      acme: [
        row(`bad‮id\u0007`),
        row(long),
        ...Array.from({ length: 38 }, (_, i) => row(`more-${i}`)),
      ],
    };
    const result = await client.refreshModels("acme", stampOn("gateway-a", client));
    if (result.status !== "done") throw new Error(result.error);
    expect(result.addedCount).toBe(40);
    expect(result.added).toHaveLength(MAX_REFRESH_NAMES);
    expect(result.added[0]).toBe("bad id");
    expect([...result.added[1]!].length).toBe(MAX_REFRESH_NAME_CHARS);
    expect(result.removedCount).toBe(2);
    client.stop();
  });

  it("F-588: the menu keeps its bound, and says how many the gateway listed past it", async () => {
    const fake = new AccountsGateway();
    const { client, accounts } = await accountsClient({ gateway: fake });
    fake.refreshed = { acme: Array.from({ length: 200 }, (_, i) => row(`m-${i}`)) };
    const result = await client.refreshModels("acme", stampOn("gateway-a", client));
    expect(accounts().models).toHaveLength(MAX_CATALOG_MODELS);
    expect(accounts().models.at(-1)).toMatchObject({ provider: "globex" });
    expect(accounts().modelsCut).toEqual([{ provider: "acme", total: 200 }]);
    // Only what the menu shows counts as new.
    expect(result).toMatchObject({ addedCount: MAX_CATALOG_MODELS - 1 });
    client.stop();
  });

  it("F-588: an answer that comes back after a switch to another gateway is dropped, and the rows stay", async () => {
    const fake = new AccountsGateway();
    const { client, accounts } = await accountsClient({ gateway: fake });
    const held = deferred<void>();
    fake.holdRefresh = held.promise;
    fake.refreshed = { acme: [row("dev-1"), row("dev-9")] };
    const asked = client.refreshModels("acme", stampOn("gateway-a", client));
    const outcome = asked.then(
      () => "given",
      (error: Error) => error.message,
    );
    await until(() => fake.gateway.calls("models.list").some((c) => (c as Json).refresh));
    fake.identity = "gateway-b";
    const was = client.state.connection.connectedAt;
    fake.gateway.dropAll();
    await until(
      () =>
        client.state.connection.status === "connected" &&
        client.state.connection.connectedAt !== was,
    );
    held.resolve();
    expect(await outcome).toMatch(/gateway changed/);
    expect(accounts().models.some((m) => m.id === "dev-9")).toBe(false);
    client.stop();
  });

  it("F-588: an answer that comes back after a reconnect to the same gateway is dropped", async () => {
    const fake = new AccountsGateway();
    const { client, accounts } = await accountsClient({ gateway: fake });
    const held = deferred<void>();
    fake.holdRefresh = held.promise;
    fake.refreshed = { acme: [row("dev-1"), row("dev-9")] };
    const outcome = client.refreshModels("acme", stampOn("gateway-a", client)).then(
      () => "given",
      (error: Error) => error.message,
    );
    await until(() => fake.gateway.calls("models.list").some((c) => (c as Json).refresh));
    const was = client.state.connection.connectedAt;
    fake.gateway.dropAll();
    await until(
      () =>
        client.state.connection.status === "connected" &&
        client.state.connection.connectedAt !== was,
    );
    held.resolve();
    expect(await outcome).toMatch(/gateway changed/);
    expect(accounts().models.some((m) => m.id === "dev-9")).toBe(false);
    client.stop();
  });

  it("F-588: an answer that arrives as its connection closes is dropped, not given", async () => {
    const fake = new AccountsGateway();
    const { client, accounts } = await accountsClient({ gateway: fake });
    fake.refreshed = { acme: [row("dev-1"), row("dev-9")] };
    // The connection closes right after the gateway's answer is delivered, before it is read.
    const socket = fake.gateway.sockets.at(-1)!;
    const push = socket.push.bind(socket);
    socket.push = (frame: unknown) => {
      push(frame);
      const id = (frame as Json).id;
      const asked = fake.gateway.requests.find((r) => r.id === id);
      if ((asked?.params as Json | undefined)?.refresh === true) fake.gateway.dropAll();
    };
    const outcome = await client.refreshModels("acme", stampOn("gateway-a", client)).then(
      () => "given",
      (error: Error) => error.message,
    );
    expect(outcome).toMatch(/gateway changed/);
    expect(accounts().models.some((m) => m.id === "dev-9")).toBe(false);
    client.stop();
  });

  it("F-588: a press made on another gateway's screen asks nothing", async () => {
    const { client, fake } = await accountsClient();
    const before = fake.gateway.calls("models.list").length;
    await expect(client.refreshModels("acme", stampOn("gateway-b", client))).rejects.toThrow(
      /gateway changed/,
    );
    await expect(client.refreshModels("acme", stampOn("gateway-a", 1))).rejects.toThrow(
      /gateway changed/,
    );
    expect(fake.gateway.calls("models.list").length).toBe(before);
    client.stop();
  });

  it("F-588: a second press while one runs asks once and shares its answer; another provider waits its turn", async () => {
    const fake = new AccountsGateway();
    const { client } = await accountsClient({ gateway: fake });
    const held = deferred<void>();
    fake.holdRefresh = held.promise;
    fake.refreshed = { acme: [row("dev-1"), row("dev-2"), row("dev-7")] };
    const stamp = stampOn("gateway-a", client);
    const first = client.refreshModels("acme", stamp);
    const second = client.refreshModels("acme", stamp);
    await expect(client.refreshModels("globex", stamp)).rejects.toThrow(/already looking/);
    await settle();
    held.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(a).toMatchObject({ added: ["dev-7"] });
    expect(fake.gateway.calls("models.list").filter((c) => (c as Json).refresh)).toHaveLength(1);
    // Once it has answered, another press asks again.
    await client.refreshModels("acme", stamp);
    expect(fake.gateway.calls("models.list").filter((c) => (c as Json).refresh)).toHaveLength(2);
    client.stop();
  });

  it("F-588: a press for the same provider on another gateway or target is refused, not given the running answer", async () => {
    const fake = new AccountsGateway();
    const { client } = await accountsClient({ gateway: fake });
    const held = deferred<void>();
    fake.holdRefresh = held.promise;
    const first = client.refreshModels("acme", stampOn("gateway-a", client));
    await expect(client.refreshModels("acme", stampOn("gateway-b", client))).rejects.toThrow(
      /gateway changed/,
    );
    await expect(
      client.refreshModels("acme", stampOn("gateway-a", client.state.connection.target + 1)),
    ).rejects.toThrow(/gateway changed/);
    held.resolve();
    await expect(first).resolves.toMatchObject({ status: "done" });
    client.stop();
  });

  it("F-588: Create waits for the whole refresh, its config read included", async () => {
    const fake = new AccountsGateway();
    const { client } = await accountsClient({ gateway: fake });
    const held = deferred<void>();
    const config = fake.gateway.handlers["config.get"]!;
    fake.gateway.handlers["config.get"] = (params) => held.promise.then(() => config(params));
    const refreshing = client.refreshModels("acme", stampOn("gateway-a", client));
    await until(() => fake.gateway.calls("config.get").length > 0);
    const creating = client.createBot({
      name: "Early",
      account: null,
      provider: "acme",
      model: "dev-1",
      effort: null,
      avatar: null,
    });
    await settle();
    expect(fake.gateway.calls("agents.create")).toEqual([]);
    fake.gateway.handlers["config.get"] = config;
    held.resolve();
    await refreshing;
    await creating.catch(() => {});
    expect(fake.gateway.calls("agents.create")).toHaveLength(1);
    client.stop();
  });

  it("F-588: Create pressed while a refresh waits behind an account read still waits for the whole refresh", async () => {
    const fake = new AccountsGateway();
    const { client } = await accountsClient({ gateway: fake });
    // The account read's config read, then the refresh's, each held until let through.
    const config = fake.gateway.handlers["config.get"]!;
    const holds = [deferred<void>(), deferred<void>()];
    let n = 0;
    fake.gateway.handlers["config.get"] = (params) => {
      const hold = holds[n++];
      return hold ? hold.promise.then(() => config(params)) : config(params);
    };
    const reading = client.refreshAccounts();
    await until(() => n === 1);
    const refreshing = client.refreshModels("acme", stampOn("gateway-a", client));
    holds[0]!.resolve();
    await reading;
    await until(() => n === 2);
    const creating = client.createBot({
      name: "Early",
      account: null,
      provider: "acme",
      model: "dev-1",
      effort: null,
      avatar: null,
    });
    await settle();
    expect(fake.gateway.calls("agents.create")).toEqual([]);
    holds[1]!.resolve();
    await refreshing;
    await creating.catch(() => {});
    expect(fake.gateway.calls("agents.create")).toHaveLength(1);
    client.stop();
  });

  it("F-588: a refresh pressed while an account read runs asks only once that read has answered", async () => {
    const fake = new AccountsGateway();
    const { client } = await accountsClient({ gateway: fake });
    const config = fake.gateway.handlers["config.get"]!;
    const held = deferred<void>();
    let first = true;
    fake.gateway.handlers["config.get"] = (params) => {
      if (!first) return config(params);
      first = false;
      return held.promise.then(() => config(params));
    };
    const reading = client.refreshAccounts();
    const refreshing = client.refreshModels("acme", stampOn("gateway-a", client));
    await settle();
    expect(fake.gateway.calls("models.list").filter((c) => (c as Json).refresh)).toEqual([]);
    held.resolve();
    await Promise.all([reading, refreshing]);
    expect(fake.gateway.calls("models.list").filter((c) => (c as Json).refresh)).toHaveLength(1);
    client.stop();
  });

  it("F-588: what is new is against the menu at the press, also when an account read it waits for brings the model first", async () => {
    const fake = new AccountsGateway();
    const { client, accounts } = await accountsClient({ gateway: fake });
    const config = fake.gateway.handlers["config.get"]!;
    const held = deferred<void>();
    let first = true;
    fake.gateway.handlers["config.get"] = (params) => {
      if (!first) return config(params);
      first = false;
      return held.promise.then(() => config(params));
    };
    const reading = client.refreshAccounts();
    // Pressed while the account read runs: the menu shows no dev-7 yet.
    const refreshing = client.refreshModels("acme", stampOn("gateway-a", client));
    expect(accounts().models.some((m) => m.id === "dev-7")).toBe(false);
    // The gateway gained dev-7 meanwhile: the account read's picker brings it first.
    const grown = { acme: [row("dev-1"), row("dev-2"), row("dev-7")] };
    const before = fake.pickerCatalog;
    fake.pickerCatalog = () => ({
      models: [
        ...grown.acme,
        ...((before() as { models: Json[] }).models ?? []).filter((m) => m.provider !== "acme"),
      ],
    });
    fake.refreshed = grown;
    held.resolve();
    await reading;
    expect(await refreshing).toMatchObject({ added: ["dev-7"], addedCount: 1 });
    client.stop();
  });

  it("F-588: a provider cut at the bound: nothing is called gone or new on the strength of the cut, and the counts are said", async () => {
    const fake = new AccountsGateway();
    const acme = Array.from({ length: 200 }, (_, i) => row(`m-${i}`));
    fake.pickerCatalog = () => ({ models: [row("dev-1", "globex"), ...acme] });
    const { client, accounts } = await accountsClient({ gateway: fake });
    expect(accounts().modelsCut).toEqual([{ provider: "acme", total: 200 }]);
    // The gateway gains a model early in the provider's order, which pushes the last shown past
    // the cut: it is still listed, so it isn't gone.
    fake.refreshed = { acme: [row("m-new"), ...acme] };
    const result = await client.refreshModels("acme", stampOn("gateway-a", client));
    expect(result).toMatchObject({
      added: [],
      addedCount: 0,
      removed: [],
      removedCount: 0,
      counts: { before: 200, now: 201 },
    });
    // A model the gateway no longer lists is still named as gone.
    fake.refreshed = { acme: [row("m-new"), ...acme.slice(1)] };
    expect(await client.refreshModels("acme", stampOn("gateway-a", client))).toMatchObject({
      removed: ["m-0"],
      removedCount: 1,
      counts: { before: 201, now: 200 },
    });
    client.stop();
  });

  it("F-588: never alongside an account read: an account read asked meanwhile waits for it", async () => {
    const fake = new AccountsGateway();
    const { client } = await accountsClient({ gateway: fake });
    const held = deferred<void>();
    fake.holdRefresh = held.promise;
    const refreshing = client.refreshModels("acme", stampOn("gateway-a", client));
    await until(() => fake.gateway.calls("models.list").some((c) => (c as Json).refresh));
    const views = fake.gateway.calls("models.authStatus").length;
    const reading = client.refreshAccounts();
    await settle();
    expect(fake.gateway.calls("models.authStatus").length).toBe(views);
    held.resolve();
    await Promise.all([refreshing, reading]);
    expect(fake.gateway.calls("models.authStatus").length).toBeGreaterThan(views);
    client.stop();
  });

  it("F-588: the bridge takes a provider and the screen's stamp, and refuses anything else", () => {
    const stamp = { gatewayId: "gateway-a", target: 4 };
    expect(parseBridgeCommand({ type: "refreshModels", provider: "acme", stamp })).toEqual({
      type: "refreshModels",
      provider: "acme",
      stamp,
    });
    expect(() => parseBridgeCommand({ type: "refreshModels", provider: "acme" })).toThrow();
    expect(() => parseBridgeCommand({ type: "refreshModels", provider: "", stamp })).toThrow();
  });
});

describe("F-588: Refresh, the engine alone", () => {
  /**
   * The engine on the fake gateway with a connection the test moves: its stamp, and whether a
   * refresh's `models.list` answer is held until the test lets it through.
   */
  function engineOn(fake: AccountsGateway) {
    let state: AccountsState = initialAccountsState;
    // Requests here go straight to the handlers, so the refresh's is noted as it is asked.
    const list = fake.gateway.handlers["models.list"]!;
    fake.gateway.handlers["models.list"] = (params) => {
      if ((params as Json).refresh === true) refreshAsked = true;
      return list(params);
    };
    let stamp: ReadStamp = { gatewayId: "gateway-a", target: 1, connectedAt: 1 };
    const engine = new AccountsEngine({
      request: (method, params) =>
        Promise.resolve().then(() => fake.gateway.handlers[method]!(params)),
      get: () => state,
      update: (change) => {
        state = change(state);
      },
      bots: () => [{ id: "main", name: "main", isDefault: true, avatarUrl: null }],
      connected: () => true,
      admin: () => true,
      refreshBots: () => Promise.resolve(),
      gateway: () => Promise.resolve("gateway-a"),
      gatewayNow: () => "gateway-a",
      readStamp: () => stamp,
      target: () => stamp.target,
      createMainTask: () => Promise.resolve(),
      now: () => 0,
      randomId: () => "id",
      log: () => {},
    });
    return {
      engine,
      asked: () => refreshAsked,
      state: () => state,
      setState: (next: AccountsState) => (state = next),
      move: (next: Partial<ReadStamp>) => (stamp = { ...stamp, ...next }),
    };
  }
  const press = { gatewayId: "gateway-a", target: 1 };
  let refreshAsked = false;

  it("F-588: an answer given on a connection made since the press is dropped, though the gateway is the same", async () => {
    const fake = new AccountsGateway();
    refreshAsked = false;
    const on = engineOn(fake);
    const asked = on.asked;
    await on.engine.load();
    const held = deferred<void>();
    fake.holdRefresh = held.promise;
    fake.refreshed = { acme: [row("dev-1"), row("dev-9")] };
    const outcome = on.engine.refreshModels("acme", press).then(
      () => "given",
      (error: Error) => error.message,
    );
    await until(asked);
    // Reconnected to the same gateway and target: the answer still comes, on this fake.
    on.move({ connectedAt: 2 });
    held.resolve();
    expect(await outcome).toMatch(/gateway changed/);
    expect(on.state().models.some((m) => m.id === "dev-9")).toBe(false);
  });

  it("F-588: rows go only into the menu read on the same gateway: one read on another meanwhile is left alone", async () => {
    const fake = new AccountsGateway();
    refreshAsked = false;
    const on = engineOn(fake);
    const asked = on.asked;
    await on.engine.load();
    const held = deferred<void>();
    fake.holdRefresh = held.promise;
    fake.refreshed = { acme: [row("dev-1"), row("dev-9")] };
    const outcome = on.engine.refreshModels("acme", press).then(
      () => "given",
      (error: Error) => error.message,
    );
    await until(asked);
    // The menu's rows were read again meanwhile, on another gateway's identity.
    const other = { ...on.state(), readOn: { gatewayId: "gateway-b", target: 1, connectedAt: 1 } };
    on.setState(other);
    held.resolve();
    expect(await outcome).toMatch(/gateway changed/);
    expect(on.state().models.some((m) => m.id === "dev-9")).toBe(false);
  });
});

describe("F-588: the gateway config's model list for bots", () => {
  /** A config with the default policy, the old list, the bot's own policy and the marker given. */
  const config = (parts: {
    policy?: Json;
    legacy?: Json;
    own?: Json;
    migrated?: boolean;
  }): Json => ({
    config: {
      agents: {
        defaults: {
          ...(parts.policy ? { modelPolicy: parts.policy } : {}),
          ...(parts.legacy ? { models: parts.legacy } : {}),
        },
        entries: { main: parts.own ? { modelPolicy: parts.own } : {} },
      },
      ...(parts.migrated ? { meta: { migrations: { modelPolicyAllowlist: true } } } : {}),
    },
  });
  const legacy = { "acme/dev-1": {}, "globex/dev-1": {} };

  it("F-588: the old agents.defaults.models limits only while the config is unmigrated and has no default policy", () => {
    expect(readModelAllowlist(config({ legacy }), "main")).toEqual({ whole: [] });
    expect(readModelAllowlist(config({ legacy, migrated: true }), "main")).toBeNull();
    expect(readModelAllowlist(config({ legacy, policy: {} }), "main")).toBeNull();
  });

  it("F-588: agents.defaults.modelPolicy.allow limits, migrated or not; empty or absent limits nothing", () => {
    for (const migrated of [true, false]) {
      expect(
        readModelAllowlist(
          config({ policy: { allow: ["acme/dev-1", "globex/*"] }, legacy, migrated }),
          "main",
        ),
      ).toEqual({ whole: ["globex"] });
      expect(
        readModelAllowlist(config({ policy: { allow: [] }, legacy, migrated }), "main"),
      ).toBeNull();
    }
    expect(readModelAllowlist(config({ migrated: true }), "main")).toBeNull();
    expect(readModelAllowlist(config({}), "main")).toBeNull();
  });

  it("F-588: the bot's own modelPolicy.allow replaces the default's, an empty one included", () => {
    const policy = { allow: ["acme/dev-1"] };
    expect(
      readModelAllowlist(config({ policy, own: { allow: ["acme/*"] }, migrated: true }), "main"),
    ).toEqual({ whole: ["acme"] });
    expect(
      readModelAllowlist(config({ policy, own: { allow: [] }, migrated: true }), "main"),
    ).toBeNull();
    // A policy of its own without `allow` keeps the default's.
    expect(readModelAllowlist(config({ policy, own: {}, migrated: true }), "main")).toEqual({
      whole: [],
    });
    // Another bot's policy is not the default bot's.
    expect(
      readModelAllowlist(config({ own: { allow: ["acme/dev-1"] }, migrated: true }), "pip"),
    ).toBeNull();
  });

  it("F-588: only <provider>/* leaves a provider whole: * and */* are not wildcards, and a longer one limits within it", () => {
    expect(
      readModelAllowlist(
        config({ policy: { allow: ["*", "*/*", "openrouter/anthropic/*", "acme/*"] } }),
        "main",
      ),
    ).toEqual({ whole: ["acme"] });
  });

  it("F-588: it is read with the accounts, for the default bot", async () => {
    const fake = new AccountsGateway();
    (fake.config.agents as Json).defaults = {
      ...((fake.config.agents as Json).defaults as Json),
      modelPolicy: { allow: ["acme/dev-1"] },
    };
    const { client, accounts } = await accountsClient({ gateway: fake });
    expect(accounts().modelAllowlist).toEqual({ whole: [] });
    client.stop();
  });
});
