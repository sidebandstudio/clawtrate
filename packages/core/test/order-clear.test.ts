// Unlock, and Clear a kept order, with a button (#660, F-592): `models.authOrderSet {provider,
// agentId}` with no account ids, after the person's confirmation, only on the gateway and for the
// bot and order the screen showed; each outcome, and the state shown only from the gateway's own
// read after it.

import { describe, expect, it } from "vitest";
import { createBridgeSession, parseBridgeCommand } from "../src/bridge.ts";
import { ClawtrateClient, CONNECTION_CHANGED } from "../src/client.ts";
import { AccountsEngine, type AccountsContext } from "../src/accounts-engine.ts";
import {
  accountWord,
  clearShown,
  initialAccountsState,
  ORDER_CLEAR_WAIT_MS,
  type AccountsState,
} from "../src/accounts.ts";
import { ADMIN_SCOPES, READ_SCOPES } from "../src/scopes.ts";
import { gatewayStamp } from "../src/types.ts";
import { AccountsGateway, accountsClient } from "./accounts-fake.ts";
import { FAST, URL_A, URL_B } from "./client-harness.ts";
import { deferred, GatewayError, memoryStorage, testHost, tokenKey, until } from "./fake-gateway.ts";

const otto = (state: AccountsState) => state.bindings.find((each) => each.botId === "otto")!;

/** Otto locked to Work, or with no fixed account and an order kept naming Work alone. */
async function locked(mode: "unlock" | "clear" = "unlock") {
  const fake = new AccountsGateway();
  fake.orders.otto = { acme: ["acme:work"] };
  if (mode === "clear") {
    const entries = (fake.config.agents as { entries: Record<string, { model: unknown }> }).entries;
    entries.otto!.model = { primary: "acme/dev-1", fallbacks: [] };
  }
  const ready = await accountsClient({ gateway: fake });
  const press = (account = "acme:work") =>
    createBridgeSession(ready.client).apply({
      type: "clearBotOrder",
      botId: "otto",
      provider: "acme",
      account,
      kind: mode,
      stamp: gatewayStamp(ready.client.state.connection),
    });
  return { ...ready, press };
}

describe("F-592: Unlock and Clear, over the connection", () => {
  it("sends models.authOrderSet with no account ids, and shows Bound only once the gateway's read says so", async () => {
    const { client, fake, accounts, press } = await locked();
    expect(accountWord(otto(accounts()))).toBe("locked");
    // The read after the press is held: the answer alone changes nothing on screen.
    const status = fake.gateway.handlers["models.authStatus"]!;
    const held = deferred<void>();
    let reads = 0;
    fake.gateway.handlers["models.authStatus"] = async (params) => {
      if (fake.gateway.calls("models.authOrderSet").length > 0 && reads++ === 0)
        await held.promise;
      return status(params);
    };
    const done = press();
    await until(() => fake.gateway.calls("models.authOrderSet").length === 1);
    expect(fake.gateway.calls("models.authOrderSet")).toEqual([
      { provider: "acme", agentId: "otto" },
    ]);
    await until(() => reads === 1);
    expect(fake.orders.otto?.acme).toBeUndefined();
    expect(accounts().clear).toMatchObject({ botId: "otto", status: "sending" });
    expect(accountWord(otto(accounts()))).toBe("locked");
    held.resolve();
    await done;
    expect(accounts().clear).toMatchObject({
      botId: "otto",
      provider: "acme",
      kind: "unlock",
      account: "acme:work",
      status: "cleared",
      error: null,
    });
    expect(otto(accounts()).order).toBeNull();
    expect(otto(accounts()).evidence.lostAt).not.toBeNull();
    expect(accountWord(otto(accounts()))).toBe("bound");
    // No restart: the connection the press went on is the one still open.
    expect(fake.gateway.connects).toHaveLength(1);
    client.stop();
  });

  it("clears an order kept for a bot the gateway chooses for", async () => {
    const { client, fake, accounts, press } = await locked("clear");
    expect(otto(accounts()).mode).toBe("gateway");
    await press();
    expect(fake.gateway.calls("models.authOrderSet")).toEqual([
      { provider: "acme", agentId: "otto" },
    ]);
    expect(accounts().clear).toMatchObject({ kind: "clear", status: "cleared" });
    expect(otto(accounts()).order).toBeNull();
    client.stop();
  });

  it("an order the gateway's settings give stays, and the bot's own is gone: cleared, and never a lock", async () => {
    const fake = new AccountsGateway();
    fake.orders.otto = { acme: ["acme:work"] };
    fake.configuredOrders.acme = ["acme:work"];
    const { client, accounts } = await accountsClient({ gateway: fake });
    expect(accountWord(otto(accounts()))).toBe("locked");
    await client.clearBotOrder("otto", "acme", "acme:work", "unlock", gatewayStamp(client.state.connection));
    expect(accounts().clear?.status).toBe("cleared");
    expect(otto(accounts()).order).toMatchObject({ stored: false, configured: "auth-config" });
    expect(otto(accounts()).evidence.status).toBe("configured");
    expect(accountWord(otto(accounts()))).toBe("bound");
    client.stop();
  });

  it("the gateway refuses: its words, and the page keeps what its read shows", async () => {
    const { client, fake, accounts, press } = await locked();
    fake.orderSet = () => {
      throw new GatewayError({
        code: "UNAVAILABLE",
        message: "auth profile order is temporarily unavailable",
      });
    };
    await press();
    expect(accounts().clear).toMatchObject({
      status: "refused",
      error: expect.stringContaining("auth profile order is temporarily unavailable"),
    });
    expect(accountWord(otto(accounts()))).toBe("locked");
    client.stop();
  });

  it("the gateway answers yes and its read still shows the order: kept, still Locked", async () => {
    const { client, fake, accounts, press } = await locked();
    fake.orderSet = (params) => ({ provider: params.provider, profileIds: null });
    await press();
    expect(accounts().clear?.status).toBe("kept");
    expect(accountWord(otto(accounts()))).toBe("locked");
    client.stop();
  });

  it("the gateway answers yes and the read after fails: unread, and the last confirmation stands", async () => {
    const { client, fake, accounts, press } = await locked();
    fake.orderSet = (params) => {
      delete fake.orders.otto;
      fake.failStatusFor = "otto";
      return { provider: params.provider, profileIds: null };
    };
    await press();
    expect(accounts().clear?.status).toBe("unread");
    expect(otto(accounts()).evidence.status).toBe("failed");
    // A failed read keeps the last confirmation, with its time: nothing says Bound yet.
    expect(accountWord(otto(accounts()))).toBe("locked");
    fake.failStatusFor = null;
    await client.checkLock("otto");
    expect(accountWord(otto(accounts()))).toBe("bound");
    client.stop();
  });

  it("the answer doesn't arrive: unanswered, until the gateway's next read shows the order gone", async () => {
    const { client, fake, accounts, press } = await locked();
    fake.orderSet = () => {
      delete fake.orders.otto;
      fake.gateway.dropAll();
      return new Promise(() => {});
    };
    await press();
    const clear = accounts().clear!;
    expect(clear).toMatchObject({ status: "unanswered" });
    expect(clear.error).not.toBeNull();
    // The press read nothing on the connection that came back: what it showed was its own.
    expect(clearShown(clear, otto(accounts()))).toBe("unanswered");
    // The page's next read, on the connection that came back, finds the order gone.
    await until(() => client.state.connection.status === "connected", 8000);
    await client.checkLock("otto");
    expect(accountWord(otto(accounts()))).toBe("bound");
    expect(clearShown(accounts().clear!, otto(accounts()))).toBe("cleared");
    client.stop();
  });

  it("an unsure ending is settled only by a read since, finding no stored order for its provider", async () => {
    const { client, fake, accounts, press } = await locked();
    fake.orderSet = (params) => ({ provider: params.provider, profileIds: null });
    await press();
    const kept = accounts().clear!;
    expect(kept.status).toBe("kept");
    expect(clearShown(kept, otto(accounts()))).toBe("kept");
    // Still stored at the next read: kept.
    await client.checkLock("otto");
    expect(clearShown(kept, otto(accounts()))).toBe("kept");
    // Gone at a read before the press: never counts.
    const gone = { ...otto(accounts()), order: null };
    expect(clearShown(kept, { ...gone, evidence: { ...gone.evidence, checkedAt: kept.at - 1 } })).toBe(
      "kept",
    );
    // Gone at a read since: cleared. A refusal is the gateway's answer and stays one.
    expect(clearShown(kept, gone)).toBe("cleared");
    expect(clearShown({ ...kept, status: "refused" }, gone)).toBe("refused");
    expect(clearShown(kept, { ...gone, provider: "globex" })).toBe("kept");
    client.stop();
  });

  it("the order changed while the confirmation was open: nothing is sent, and the page shows the order now", async () => {
    const { client, fake, accounts, press } = await locked();
    // Another device, or the command line, moved Otto's order to Home alone.
    fake.orders.otto = { acme: ["acme:home"] };
    await press();
    expect(fake.gateway.calls("models.authOrderSet")).toEqual([]);
    expect(accounts().clear?.status).toBe("moved");
    expect(otto(accounts()).order?.ids).toEqual(["acme:home"]);
    expect(accountWord(otto(accounts()))).toBe("stale");
    // Cleared elsewhere meanwhile: the same, nothing sent.
    delete fake.orders.otto;
    await press("acme:home");
    expect(fake.gateway.calls("models.authOrderSet")).toEqual([]);
    expect(accounts().clear?.status).toBe("moved");
    expect(accountWord(otto(accounts()))).toBe("bound");
    client.stop();
  });

  it("needs admin: below it, nothing is sent", async () => {
    const fake = new AccountsGateway();
    fake.orders.otto = { acme: ["acme:work"] };
    const { client, accounts } = await accountsClient({ gateway: fake, scopes: READ_SCOPES });
    await expect(
      client.clearBotOrder("otto", "acme", "acme:work", "unlock", gatewayStamp(client.state.connection)),
    ).rejects.toThrow("needs admin access");
    expect(fake.gateway.calls("models.authOrderSet")).toEqual([]);
    expect(accounts().clear).toBeNull();
    client.stop();
  });

  it("is a person's press only: the bridge takes it with its bot, order and stamp, never without", () => {
    const stamp = { gatewayId: "gateway-a", target: 4 };
    const command = {
      type: "clearBotOrder",
      botId: "otto",
      provider: "acme",
      account: "acme:work",
      kind: "unlock",
      stamp,
    };
    expect(parseBridgeCommand(command)).toEqual(command);
    for (const broken of [
      { ...command, stamp: undefined },
      { ...command, account: undefined },
      { ...command, account: "acme work" },
      { ...command, kind: "lock" },
      { ...command, botId: "../otto" },
    ])
      expect(() => parseBridgeCommand(broken), JSON.stringify(broken)).toThrow();
  });
});

describe("F-592: a press bound to the gateway and the bot on screen", () => {
  async function twoGateways() {
    const a = new AccountsGateway();
    const b = new AccountsGateway();
    b.identity = a.identity;
    a.orders.otto = { acme: ["acme:work"] };
    b.orders.otto = { acme: ["acme:work"] };
    const record = JSON.stringify({
      token: "device-token",
      grantedScopes: ADMIN_SCOPES,
      heldScopes: ADMIN_SCOPES.filter((scope) => scope !== "operator.admin"),
      adminHeld: true,
    });
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: record,
      [tokenKey(URL_B)]: record,
    });
    const host = {
      ...testHost(a.gateway, storage),
      createWebSocket: (url: string) => (url === URL_B ? b : a).gateway.createWebSocket(url),
    };
    const client = new ClawtrateClient(host, FAST);
    await client.start();
    const on = (url: string) =>
      client.state.connection.status === "connected" &&
      client.state.connection.gatewayUrl === url &&
      client.state.connection.gatewayId !== null;
    await until(() => on(URL_A));
    await client.refreshAccounts();
    const switchToB = async () => {
      await client.connect({ url: URL_B });
      await until(() => on(URL_B));
    };
    return { client, a, b, switchToB };
  }

  it("a press read on one gateway reaches neither after a switch to another with the same id", async () => {
    const { client, a, b, switchToB } = await twoGateways();
    const stamp = gatewayStamp(client.state.connection);
    await switchToB();
    await client.refreshAccounts();
    await expect(client.clearBotOrder("otto", "acme", "acme:work", "unlock", stamp)).rejects.toThrow(
      CONNECTION_CHANGED,
    );
    expect(a.gateway.calls("models.authOrderSet")).toEqual([]);
    expect(b.gateway.calls("models.authOrderSet")).toEqual([]);
    expect(b.orders.otto?.acme).toEqual(["acme:work"]);
    client.stop();
  });

  it("a switch while the press reads the order first sends nothing to either, and says nothing on the other", async () => {
    const { client, a, b, switchToB } = await twoGateways();
    const status = a.gateway.handlers["models.authStatus"]!;
    const held = deferred<void>();
    a.gateway.handlers["models.authStatus"] = async (params) => {
      await held.promise;
      return status(params);
    };
    const pressed = client.clearBotOrder(
      "otto",
      "acme",
      "acme:work",
      "unlock",
      gatewayStamp(client.state.connection),
    );
    await until(() => client.state.accounts.clear?.status === "sending");
    await switchToB();
    held.resolve();
    await pressed;
    expect(a.gateway.calls("models.authOrderSet")).toEqual([]);
    expect(b.gateway.calls("models.authOrderSet")).toEqual([]);
    expect(b.gateway.calls("models.authStatus")).not.toContainEqual({
      agentId: "otto",
      refresh: true,
    });
    // The line was about the gateway it was pressed for: another's page says nothing of it.
    expect(client.state.accounts.clear).toBeNull();
    client.stop();
  });

  it("acts on the bot it was pressed for alone: another bot shown meanwhile gets nothing", async () => {
    const { client, a } = await twoGateways();
    a.orders.pip = { acme: ["acme:home"] };
    await client.refreshAccounts();
    const status = a.gateway.handlers["models.authStatus"]!;
    const held = deferred<void>();
    a.gateway.handlers["models.authStatus"] = async (params) => {
      if ((params as { agentId: string }).agentId === "otto") await held.promise;
      return status(params);
    };
    const pressed = client.clearBotOrder(
      "otto",
      "acme",
      "acme:work",
      "unlock",
      gatewayStamp(client.state.connection),
    );
    // The person opens Pip's page while Otto's press is under way: Pip's order is read, not cleared.
    await client.checkLock("pip");
    held.resolve();
    await pressed;
    expect(a.gateway.calls("models.authOrderSet")).toEqual([{ provider: "acme", agentId: "otto" }]);
    expect(a.orders.pip?.acme).toEqual(["acme:home"]);
    expect(client.state.accounts.clear?.botId).toBe("otto");
    client.stop();
  });
});

describe("F-592: the answer's wait", () => {
  it("waits ORDER_CLEAR_WAIT_MS for the answer, then lets the gateway's read decide", async () => {
    let state: AccountsState = {
      ...initialAccountsState,
      status: "ready",
      bindings: [
        {
          botId: "otto",
          primary: "acme/dev-1@acme:work",
          provider: "acme",
          model: "dev-1",
          account: "acme:work",
          mode: "account",
          fallbacks: [],
          suffixLost: false,
          accountMissing: false,
          effort: null,
          order: { ids: ["acme:work"], stored: true, configured: null },
          evidence: {
            status: "matched",
            checkedAt: 1,
            lastMatchAt: 1,
            lostAt: null,
            error: null,
          },
          fallbacksUnwritten: false,
        },
      ],
    };
    let stored = true;
    const waits: Array<number | undefined> = [];
    const view = () => ({
      providers: [
        {
          provider: "acme",
          profiles: [{ profileId: "acme:work", type: "api_key", source: "inherited" }],
          ...(stored ? { profileOrder: ["acme:work"], profileOrderStored: true } : {}),
        },
      ],
    });
    const ctx = {
      request: async (method: string, _params: unknown, options?: { timeoutMs?: number }) => {
        if (method === "models.authStatus") return view();
        if (method === "config.get")
          return {
            config: { agents: { entries: { otto: { model: { primary: "acme/dev-1@acme:work", fallbacks: [] } } } } },
          };
        if (method === "models.authOrderSet") {
          waits.push(options?.timeoutMs);
          // Taken, and the answer lost to the client's wait.
          stored = false;
          throw new Error("gateway request timeout for models.authOrderSet");
        }
        throw new Error(`unexpected ${method}`);
      },
      get: () => state,
      update: (change: (a: AccountsState) => AccountsState) => {
        state = change(state);
      },
      connected: () => true,
      admin: () => true,
      now: () => 10,
      log: () => {},
    } as unknown as AccountsContext;
    const engine = new AccountsEngine(ctx);
    await engine.clearOrder("otto", "acme", "acme:work", "unlock");
    expect(waits).toEqual([ORDER_CLEAR_WAIT_MS]);
    // The answer didn't come; the read after it found the order gone.
    expect(state.clear?.status).toBe("cleared");
    stored = true;
    state = { ...state, clear: null };
    const engine2 = new AccountsEngine({
      ...ctx,
      request: async (method: string, params: unknown, options?: { timeoutMs?: number }) => {
        if (method === "models.authOrderSet") throw new Error("gateway request timeout");
        return ctx.request(method, params, options);
      },
    });
    await engine2.clearOrder("otto", "acme", "acme:work", "unlock");
    expect(state.clear).toMatchObject({ status: "unanswered", error: "gateway request timeout" });
  });
});
