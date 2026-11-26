// Refresh in the Model menu (#565, F-588): one press asks the gateway to look
// for a provider's models again, compares the menu's rows before and after, and
// says what the gateway reported for the provider. The answer is given only on
// the gateway and connection it was asked on, a second press shares the first,
// and the config's model list for bots is read with the accounts.

import { GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import { describe, expect, it } from "vitest";
import { parseBridgeCommand } from "../src/bridge.ts";
import {
  MAX_CATALOG_MODELS,
  MAX_REFRESH_NAME_CHARS,
  MAX_REFRESH_NAMES,
  effectiveAllowlist,
  MAX_KEY_PROVIDERS,
  readModelAllowlist,
} from "../src/accounts.ts";
import { READ_SCOPES } from "../src/scopes.ts";
import { AccountsEngine } from "../src/accounts-engine.ts";
import { initialAccountsState, type AccountsState } from "../src/accounts.ts";
import type { ReadStamp } from "../src/types.ts";
import { AccountsGateway, accountsClient } from "./accounts-fake.ts";
import { stampOn } from "./client-harness.ts";
import { deferred, GatewayError, until } from "./fake-gateway.ts";

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
  it("F-588: a model list that filters the provider's rows says nothing of the config's list, the default's or the bot's own", async () => {
    const fake = new AccountsGateway();
    const { client, accounts } = await accountsClient({ gateway: fake });
    const ask = () => client.refreshModels("acme", stampOn("gateway-a", client));
    const agents = fake.config.agents as Json;
    fake.config.models = {
      providers: {
        acme: { baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "dev-1" }, { id: "dev-2" }] },
      },
    };
    // Two models declared, a list naming one: the gateway lists that one alone.
    fake.refreshed = { acme: [row("dev-1")] };
    agents.defaults = { ...(agents.defaults as Json), modelPolicy: { allow: ["acme/dev-1"] } };
    fake.revision += 1;
    expect(await ask()).toMatchObject({ outcome: null, configured: false });
    // The same list as the default bot's own: the menu says no list, and still not the config's.
    agents.defaults = { ...(agents.defaults as Json), modelPolicy: {} };
    const entries = (agents.entries ?? {}) as Json;
    agents.entries = {
      ...entries,
      main: { ...(entries.main as Json), modelPolicy: { allow: ["acme/dev-1"] } },
    };
    fake.revision += 1;
    expect(await ask()).toMatchObject({ outcome: null, configured: false });
    expect(accounts().modelAllowlist).toBeNull();
    // A list that leaves acme whole doesn't filter it: the config's list is the whole list.
    agents.entries = {
      ...entries,
      main: { ...(entries.main as Json), modelPolicy: { allow: ["acme/*"] } },
    };
    fake.refreshed = { acme: [row("dev-1"), row("dev-2")] };
    fake.revision += 1;
    expect(await ask()).toMatchObject({ outcome: null, configured: true });
    client.stop();
  });

  it("F-588: a press the gateway answers UNAVAILABLE asks once and says why; the next press asks again", async () => {
    const fake = new AccountsGateway();
    const { client } = await accountsClient({ gateway: fake });
    const list = fake.gateway.handlers["models.list"]!;
    let refreshes = 0;
    fake.gateway.handlers["models.list"] = (params) => {
      if ((params as Json).refresh === true && ++refreshes === 1)
        throw new GatewayError({
          code: "UNAVAILABLE",
          message: "Model catalog is not ready. Retry after Gateway startup or refresh finishes.",
        });
      return list(params);
    };
    const ask = () => client.refreshModels("acme", stampOn("gateway-a", client));
    expect(await ask()).toEqual({
      status: "error",
      error: "Model catalog is not ready. Retry after Gateway startup or refresh finishes.",
    });
    // A refresh runs the provider's discovery again: only a person's press asks it, once.
    await settle();
    expect(refreshes).toBe(1);
    expect(await ask()).toMatchObject({ status: "done" });
    expect(refreshes).toBe(2);
    client.stop();
  });

  it("F-588: an account read whose config read fails still waits for its other reads before a refresh asks", async () => {
    const fake = new AccountsGateway();
    const { client } = await accountsClient({ gateway: fake });
    const config = fake.gateway.handlers["config.get"]!;
    const status = fake.gateway.handlers["models.authStatus"]!;
    const held = deferred<void>();
    let refuse = true;
    fake.gateway.handlers["config.get"] = (params) => {
      if (!refuse) return config(params);
      refuse = false;
      throw new GatewayError({ code: "INVALID_REQUEST", message: "config refused" });
    };
    fake.gateway.handlers["models.authStatus"] = (params) =>
      held.promise.then(() => status(params));
    const reading = client.refreshAccounts().catch(() => {});
    const refreshing = client.refreshModels("acme", stampOn("gateway-a", client));
    await settle();
    await settle();
    // The account read's config read failed, and its bots' account reads are still out.
    expect(fake.gateway.calls("models.list").filter((c) => (c as Json).refresh)).toEqual([]);
    held.resolve();
    await reading;
    await refreshing;
    expect(fake.gateway.calls("models.list").filter((c) => (c as Json).refresh)).toHaveLength(1);
    client.stop();
  });

  it("F-588: an account read whose bot's account read fails still waits for the other bots' before a refresh asks", async () => {
    const fake = new AccountsGateway();
    const { client } = await accountsClient({ gateway: fake });
    expect(fake.bots.length).toBeGreaterThan(1);
    const [first] = fake.bots;
    const status = fake.gateway.handlers["models.authStatus"]!;
    const held = deferred<void>();
    let holding = true;
    fake.gateway.handlers["models.authStatus"] = (params) => {
      if (!holding) return status(params);
      // One bot's account read is refused at once; the others' are still out.
      if ((params as Json).agentId === first!.id)
        throw new GatewayError({ code: "INVALID_REQUEST", message: "status refused" });
      return held.promise.then(() => status(params));
    };
    const reading = client.refreshAccounts().catch(() => {});
    const refreshing = client.refreshModels("acme", stampOn("gateway-a", client));
    await settle();
    await settle();
    expect(fake.gateway.calls("models.list").filter((c) => (c as Json).refresh)).toEqual([]);
    holding = false;
    held.resolve();
    await reading;
    await refreshing;
    expect(fake.gateway.calls("models.list").filter((c) => (c as Json).refresh)).toHaveLength(1);
    client.stop();
  });

  it("F-588: a refresh's and View more's errors carry no credential this client holds", async () => {
    const fake = new AccountsGateway();
    const { client } = await accountsClient({ gateway: fake });
    fake.gateway.handlers["models.list"] = () => {
      throw new GatewayError({ code: "UNAVAILABLE", message: "busy reading device-token now" });
    };
    const refreshed = await client.refreshModels("acme", stampOn("gateway-a", client));
    expect(refreshed).toMatchObject({ status: "error" });
    expect(JSON.stringify(refreshed)).not.toContain("device-token");
    const listed = await client.loadModelCatalog("acme");
    expect(listed).toMatchObject({ status: "error" });
    expect(JSON.stringify(listed)).not.toContain("device-token");
    client.stop();
  });

  it("F-588: without the gateway's config, whether it checks OpenClaw's list online is unknown", async () => {
    const fake = new AccountsGateway();
    const { client } = await accountsClient({ gateway: fake });
    fake.gateway.handlers["config.get"] = () => {
      throw new GatewayError({ code: "INVALID_REQUEST", message: "config refused" });
    };
    expect(await client.refreshModels("acme", stampOn("gateway-a", client))).toMatchObject({
      status: "done",
      hostedList: null,
      configured: false,
    });
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

  it("F-588: a whole list that grows past the menu's bound on this refresh says so, and is never called the same", async () => {
    const fake = new AccountsGateway();
    const { client } = await accountsClient({ gateway: fake });
    const rows = (n: number) => Array.from({ length: n }, (_, i) => row(`m-${i}`));
    const ask = () => client.refreshModels("acme", stampOn("gateway-a", client));
    // 127 of Acme's beside Globex's one: the menu holds them all.
    fake.refreshed = { acme: rows(MAX_CATALOG_MODELS - 1) };
    expect(await ask()).toMatchObject({ counts: null, cut: null });
    // One more: the menu keeps 127, and the result says the gateway lists more than it shows.
    fake.refreshed = { acme: rows(MAX_CATALOG_MODELS) };
    expect(await ask()).toMatchObject({
      addedCount: 0,
      removedCount: 0,
      counts: null,
      cut: { shown: MAX_CATALOG_MODELS - 1, now: MAX_CATALOG_MODELS },
    });
    client.stop();
  });

  it("F-588: what a refresh found gone is only what the gateway no longer lists, never what the bound pushed out", async () => {
    const fake = new AccountsGateway();
    const { client, accounts } = await accountsClient({ gateway: fake });
    const rows = (ids: string[]) => ids.map((id) => row(id));
    const ask = () => client.refreshModels("acme", stampOn("gateway-a", client));
    const all = Array.from({ length: MAX_CATALOG_MODELS - 1 }, (_, i) => `m-${i}`);
    fake.refreshed = { acme: rows(all) };
    await ask();
    // Two new models first and one gone: the menu's last Acme model is pushed past the bound,
    // the gateway still lists it, and only the one it no longer lists is gone.
    const last = all.at(-1)!;
    fake.refreshed = { acme: rows(["m-new", "m-newer", ...all.filter((id) => id !== "m-0")]) };
    const result = await ask();
    expect(accounts().models.some((m) => m.id === last)).toBe(false);
    expect(result).toMatchObject({ removedIds: ["m-0"], removedCount: 1 });
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
    const entered = deferred<void>();
    const config = fake.gateway.handlers["config.get"]!;
    fake.gateway.handlers["config.get"] = (params) => {
      entered.resolve();
      return held.promise.then(() => config(params));
    };
    const refreshing = client.refreshModels("acme", stampOn("gateway-a", client));
    // The refresh's own config read is out, and held, before Create is pressed.
    await entered.promise;
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
    const create = () =>
      client.createBot({
        name: "Early",
        account: null,
        provider: "acme",
        model: "dev-1",
        effort: null,
        avatar: null,
      });
    const reading = client.refreshAccounts();
    await until(() => n === 1);
    const refreshing = client.refreshModels("acme", stampOn("gateway-a", client));
    // Create is pressed while the refresh is still queued behind the account read.
    const creating = create();
    await settle();
    expect(fake.gateway.calls("agents.create")).toEqual([]);
    holds[0]!.resolve();
    await reading;
    await until(() => n === 2);
    await settle();
    expect(fake.gateway.calls("agents.create")).toEqual([]);
    holds[1]!.resolve();
    await refreshing;
    await creating.catch(() => {});
    expect(fake.gateway.calls("agents.create")).toHaveLength(1);
    client.stop();
  });

  it("F-588: Create pressed after the account read a refresh waited for, while the refresh reads its config, still waits for it", async () => {
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
    const create = () =>
      client.createBot({
        name: "Early",
        account: null,
        provider: "acme",
        model: "dev-1",
        effort: null,
        avatar: null,
      });
    const reading = client.refreshAccounts();
    await until(() => n === 1);
    const refreshing = client.refreshModels("acme", stampOn("gateway-a", client));
    holds[0]!.resolve();
    await reading;
    // The account read took the picker's wait over; the refresh holds its own config read.
    await until(() => n === 2);
    const creating = create();
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
  function engineOn(fake: AccountsGateway, refreshMs?: number) {
    let state: AccountsState = initialAccountsState;
    // Requests here go straight to the handlers, so the refresh's is noted as it is asked.
    const list = fake.gateway.handlers["models.list"]!;
    fake.gateway.handlers["models.list"] = (params) => {
      if ((params as Json).refresh === true) refreshAsked = true;
      return list(params);
    };
    let stamp: ReadStamp = { gatewayId: "gateway-a", target: 1, connectedAt: 1 };
    const engine = new AccountsEngine({
      // A request with a time limit is given up on after it, as a client's is.
      request: (method, params, options) => {
        const answer = Promise.resolve().then(() => fake.gateway.handlers[method]!(params));
        const ms = options?.timeoutMs;
        if (ms === undefined) return answer;
        let timer: ReturnType<typeof setTimeout> | undefined;
        return Promise.race([
          answer,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new GatewayProtocolRequestTimeoutError({
                    method,
                    timeoutMs: ms,
                    requestSent: true,
                  }),
                ),
              ms,
            );
          }),
        ]).finally(() => clearTimeout(timer));
      },
      ...(refreshMs === undefined ? {} : { refreshMs }),
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
      readAgain: (read) => read(),
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

  it("F-588: one deadline from the press covers the whole refresh: nothing is asked once it has passed", async () => {
    const fake = new AccountsGateway();
    refreshAsked = false;
    const on = engineOn(fake, 150);
    await on.engine.load();
    const config = fake.gateway.handlers["config.get"]!;
    const late = { status: "error", error: "The gateway didn't answer in time." };
    // The refresh's config read takes longer than the whole press may.
    const held = deferred<void>();
    fake.gateway.handlers["config.get"] = (params) => held.promise.then(() => config(params));
    expect(await on.engine.refreshModels("acme", press)).toEqual(late);
    expect(on.asked()).toBe(false);
    // An account read that takes longer than the whole press: the refresh asks nothing after it.
    const loading = on.engine.load();
    expect(await on.engine.refreshModels("acme", press)).toEqual(late);
    held.resolve();
    await loading;
    await settle();
    expect(on.asked()).toBe(false);
  });

  it("F-588: a config read the deadline ended ends the refresh, though the clock reads time left", async () => {
    const fake = new AccountsGateway();
    refreshAsked = false;
    const on = engineOn(fake, 150);
    await on.engine.load();
    // The request's timer and the wall clock can disagree by a millisecond or more: the read is
    // given up on as timed out while Date.now() still reads time before the deadline.
    fake.gateway.handlers["config.get"] = () => {
      throw new GatewayProtocolRequestTimeoutError({
        method: "config.get",
        timeoutMs: 150,
        requestSent: true,
      });
    };
    expect(await on.engine.refreshModels("acme", press)).toEqual({
      status: "error",
      error: "The gateway didn't answer in time.",
    });
    expect(on.asked()).toBe(false);
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
  const none = { whole: [], wildcards: false, prefixWildcards: false };

  it("F-588: the old agents.defaults.models limits only while the config is unmigrated and has no default policy", () => {
    expect(readModelAllowlist(config({ legacy }))).toEqual(none);
    expect(readModelAllowlist(config({ legacy, migrated: true }))).toBeNull();
    expect(readModelAllowlist(config({ legacy, policy: {} }))).toBeNull();
  });

  it("F-588: agents.defaults.modelPolicy.allow limits, migrated or not; empty or absent limits nothing", () => {
    for (const migrated of [true, false]) {
      expect(
        readModelAllowlist(
          config({ policy: { allow: ["acme/dev-1", "globex/*"] }, legacy, migrated }),
        ),
      ).toEqual({ whole: ["globex"], wildcards: true, prefixWildcards: true });
      expect(readModelAllowlist(config({ policy: { allow: [] }, legacy, migrated }))).toBeNull();
    }
    expect(readModelAllowlist(config({ migrated: true }))).toBeNull();
    expect(readModelAllowlist(config({}))).toBeNull();
  });

  it("F-588: a bot's own modelPolicy.allow replaces the default's for that bot, an empty one included", () => {
    const policy = { allow: ["acme/dev-1"] };
    expect(
      effectiveAllowlist(config({ policy, own: { allow: ["acme/*"] }, migrated: true }), "main"),
    ).toEqual({ whole: ["acme"], wildcards: true, prefixWildcards: true });
    expect(
      effectiveAllowlist(config({ policy, own: { allow: [] }, migrated: true }), "main"),
    ).toBeNull();
    // A policy of its own without `allow` keeps the default's.
    expect(effectiveAllowlist(config({ policy, own: {}, migrated: true }), "main")).toEqual(none);
    // Another bot's policy is not this bot's; a bot with no entry has the default's.
    expect(
      effectiveAllowlist(config({ own: { allow: ["acme/dev-1"] }, migrated: true }), "pip"),
    ).toBeNull();
    expect(effectiveAllowlist(config({ policy, migrated: true }), null)).toEqual(none);
  });

  it("F-588: the menu says a list only when no bot has one of its own, so the default's is every bot's", () => {
    const policy = { allow: ["acme/dev-1"] };
    // The default list alone is the list for every bot, and for a new one.
    expect(readModelAllowlist(config({ policy, migrated: true }))).toEqual(none);
    // The default bot's own list, an empty one beside the default's, another bot's own list.
    expect(
      readModelAllowlist(config({ policy, own: { allow: ["acme/dev-1"] }, migrated: true })),
    ).toBeNull();
    expect(readModelAllowlist(config({ policy, own: { allow: [] }, migrated: true }))).toBeNull();
    const otto = config({ policy, migrated: true }) as { config: { agents: { entries: Json } } };
    otto.config.agents.entries.otto = { modelPolicy: { allow: ["globex/dev-1"] } };
    expect(readModelAllowlist(otto)).toBeNull();
    // A policy of its own without `allow` is no list of its own.
    expect(readModelAllowlist(config({ policy, own: {}, migrated: true }))).toEqual(none);
  });

  it("F-588: only <provider>/* leaves a provider whole: * and */* are not wildcards, and a longer one limits within it", () => {
    expect(
      readModelAllowlist(
        config({ policy: { allow: ["*", "*/*", "openrouter/anthropic/*", "acme/*"] } }),
      ),
    ).toEqual({ whole: ["acme"], wildcards: true, prefixWildcards: true });
    // Both versions trim each segment, so a space before the `*` still allows the provider whole.
    expect(
      readModelAllowlist(config({ policy: { allow: ["openai/ *", "Acme /*", "globex / *"] } })),
    ).toEqual({
      whole: ["openai", "acme", "globex"],
      wildcards: true,
      prefixWildcards: true,
    });
  });

  it("F-588: a list whose whole-provider entries aren't all kept says nothing", () => {
    const others = Array.from({ length: MAX_KEY_PROVIDERS }, (_, i) => `p${i}/*`);
    // OpenAI's whole entry past the providers kept: OpenAI would read as limited, which the
    // gateway never said.
    expect(readModelAllowlist(config({ policy: { allow: [...others, "openai/*"] } }))).toBeNull();
    expect(
      readModelAllowlist(config({ policy: { allow: [`${"x".repeat(300)}/*`, "acme/dev-1"] } })),
    ).toBeNull();
    // All kept: the list.
    expect(readModelAllowlist(config({ policy: { allow: others.slice(1) } }))?.whole).toHaveLength(
      MAX_KEY_PROVIDERS - 1,
    );
  });

  it("F-588: wildcards are read as each version reads them: 2026.11.10 also reads a prefix", () => {
    const read = (allow: string[]) => {
      const list = readModelAllowlist(config({ policy: { allow }, migrated: true }));
      return [list?.wildcards, list?.prefixWildcards];
    };
    expect(read(["acme/dev-1", "globex/dev-1"])).toEqual([false, false]);
    expect(read(["acme/dev-1", "globex/*"])).toEqual([true, true]);
    expect(read(["openrouter/anthropic/*"])).toEqual([true, true]);
    // A prefix: an exact name to 2026.10.6, a wildcard to 2026.11.10, which doesn't allow the
    // provider whole.
    expect(read(["openai/gpt-*"])).toEqual([false, true]);
    expect(read(["acme/dev-1", "acme/ dev-*"])).toEqual([false, true]);
    expect(readModelAllowlist(config({ policy: { allow: ["openai/gpt-*"] } }))?.whole).toEqual([]);
    // Not wildcards to either: no provider before it, a `*` inside a segment, or white space in
    // the prefix.
    expect(read(["acme/dev-1", "*", "*/*", "/*", "acme/*/x", "acme/dev *"])).toEqual([
      false,
      false,
    ]);
  });

  it("F-588: it is read with the accounts, for the default bot", async () => {
    const fake = new AccountsGateway();
    (fake.config.agents as Json).defaults = {
      ...((fake.config.agents as Json).defaults as Json),
      modelPolicy: { allow: ["acme/dev-1"] },
    };
    const { client, accounts } = await accountsClient({ gateway: fake });
    expect(accounts().modelAllowlist).toEqual({
      whole: [],
      wildcards: false,
      prefixWildcards: false,
    });
    client.stop();
  });
});
