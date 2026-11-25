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

  it("F-588: nothing new: the provider not asked again, and whether the gateway's config declares its models", async () => {
    const fake = new AccountsGateway();
    const { client } = await accountsClient({ gateway: fake });
    const plain = await client.refreshModels("acme", stampOn("gateway-a", client));
    expect(plain).toMatchObject({
      addedCount: 0,
      removedCount: 0,
      outcome: null,
      configured: false,
      partial: false,
    });
    fake.config.models = {
      mode: "replace",
      providers: { acme: { baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "dev-1" }] } },
    };
    fake.revision += 1;
    const declared = await client.refreshModels("acme", stampOn("gateway-a", client));
    expect(declared).toMatchObject({ addedCount: 0, outcome: null, configured: true });
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
    expect(await ask()).toMatchObject({ outcome: null, partial: true });
    fake.refreshMarkers = { refreshFailed: true };
    expect(await ask()).toMatchObject({ partial: true });
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

describe("F-588: the gateway config's model list for bots", () => {
  const config = (models: Json | undefined, extra: Json = {}) => ({
    config: { agents: { defaults: models === undefined ? {} : { models } }, ...extra },
  });

  it("F-588: none, or an empty one, limits nothing; a <provider>/* entry leaves the provider whole", () => {
    expect(readModelAllowlist(config(undefined))).toBeNull();
    expect(readModelAllowlist(config({}))).toBeNull();
    expect(readModelAllowlist(config({ "*": {} }))).toBeNull();
    expect(readModelAllowlist(config({ "acme/dev-1": {}, "globex/*": {} }))).toEqual({
      whole: ["globex"],
    });
  });

  it("F-588: a provider whose models the config declares is whole only when the config replaces every other", () => {
    const providers = { acme: { models: [{ id: "dev-1" }] }, globex: { models: [] } };
    expect(
      readModelAllowlist(config({ "acme/dev-1": {} }, { models: { mode: "replace", providers } })),
    ).toEqual({ whole: ["acme"] });
    expect(readModelAllowlist(config({ "acme/dev-1": {} }, { models: { providers } }))).toEqual({
      whole: [],
    });
  });

  it("F-588: it is read with the accounts", async () => {
    const fake = new AccountsGateway();
    (fake.config.agents as Json).defaults = {
      ...((fake.config.agents as Json).defaults as Json),
      models: { "acme/dev-1": {}, "globex/dev-1": {} },
    };
    const { client, accounts } = await accountsClient({ gateway: fake });
    expect(accounts().modelAllowlist).toEqual({ whole: [] });
    client.stop();
  });
});
