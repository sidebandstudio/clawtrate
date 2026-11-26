// Unlock, and Clear a kept order, with a button (#660, F-592): `models.authOrderSet {provider,
// agentId}` with no account ids, after the person's confirmation, only on the gateway and for the
// bot and order the screen showed; each outcome, and the state shown only from the gateway's own
// read after it.

import { describe, expect, it, vi } from "vitest";
import { createBridgeSession, parseBridgeCommand } from "../src/bridge.ts";
import { ClawtrateClient, CONNECTION_CHANGED } from "../src/client.ts";
import { AccountsEngine, type AccountsContext } from "../src/accounts-engine.ts";
import {
  accountWord,
  clearShown,
  initialAccountsState,
  MAX_ACCOUNTS,
  NO_ACCOUNT_STATUS,
  ORDER_CLEAR_WAIT_MS,
  providerNotListed,
  unconfirmedOrder,
  type AccountsState,
  type BotBinding,
  type OrderClear,
} from "../src/accounts.ts";
import { ADMIN_SCOPES, READ_SCOPES } from "../src/scopes.ts";
import { gatewayStamp } from "../src/types.ts";
import { AccountsGateway, accountsClient } from "./accounts-fake.ts";
import { FAST, URL_A, URL_B } from "./client-harness.ts";
import {
  deferred,
  GatewayError,
  memoryStorage,
  testHost,
  tokenKey,
  until,
} from "./fake-gateway.ts";

/** Every timestamp from now on the same millisecond: reads are told apart by their order alone. */
function fixedClock(): () => void {
  const spy = vi.spyOn(Date, "now").mockReturnValue(Date.now());
  return () => spy.mockRestore();
}

const otto = (state: AccountsState) => state.bindings.find((each) => each.botId === "otto")!;
/** What the page's line says now: its status, or null when it shows nothing. */
const shown = (clear: OrderClear, binding: BotBinding) =>
  clearShown(clear, binding)?.status ?? null;

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
      press: "press-0001",
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
      if (fake.gateway.calls("models.authOrderSet").length > 0 && reads++ === 0) await held.promise;
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
    // The person's own unlock is not a lock lost: no "The lock is gone" for it.
    expect(otto(accounts()).evidence).toMatchObject({ status: "none", lostAt: null });
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
    await client.clearBotOrder(
      "press-0001",
      "otto",
      "acme",
      "acme:work",
      "unlock",
      gatewayStamp(client.state.connection),
    );
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
    expect(shown(clear, otto(accounts()))).toBe("unanswered");
    // The page's next read, on the connection that came back, finds the order gone.
    await until(() => client.state.connection.status === "connected", 8000);
    await client.checkLock("otto");
    expect(accountWord(otto(accounts()))).toBe("bound");
    expect(shown(accounts().clear!, otto(accounts()))).toBe("cleared");
    client.stop();
  });

  it("an unsure ending is settled only by a read since, finding no stored order for its provider", async () => {
    const { client, fake, accounts, press } = await locked();
    fake.orderSet = (params) => ({ provider: params.provider, profileIds: null });
    await press();
    const kept = accounts().clear!;
    expect(kept.status).toBe("kept");
    expect(shown(kept, otto(accounts()))).toBe("kept");
    // Still stored at the next read: kept.
    await client.checkLock("otto");
    expect(shown(kept, otto(accounts()))).toBe("kept");
    // Gone at a read begun before the send's answer: never counts.
    const gone = { ...otto(accounts()), order: null };
    expect(
      shown(kept, { ...gone, evidence: { ...gone.evidence, readSeq: kept.sentSeq! - 1 } }),
    ).toBe("kept");
    // Nor at the send's own number: only a read begun after it.
    expect(shown(kept, { ...gone, evidence: { ...gone.evidence, readSeq: kept.sentSeq! } })).toBe(
      "kept",
    );
    // Gone at a read since: cleared, at that read's time. A refusal is the gateway's answer.
    expect(clearShown(kept, gone)).toEqual({
      status: "cleared",
      checkedAt: gone.evidence.checkedAt,
    });
    expect(shown({ ...kept, status: "refused" }, gone)).toBe("refused");
    expect(shown(kept, { ...gone, provider: "globex" })).toBe("kept");
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

  it("a cleared line goes once a later read finds the order back, and names the time of its own read", async () => {
    const { client, accounts, press } = await locked();
    await press();
    const clear = accounts().clear!;
    expect(clearShown(clear, otto(accounts()))).toEqual({
      status: "cleared",
      checkedAt: clear.checkedAt,
    });
    expect(clear.checkedSeq).toBe(otto(accounts()).evidence.readSeq);
    // A later read that still finds none: the line keeps the time of the press's own read.
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    await client.checkLock("otto");
    expect(otto(accounts()).evidence.checkedAt).toBeGreaterThan(clear.checkedAt!);
    expect(clearShown(clear, otto(accounts()))?.checkedAt).toBe(clear.checkedAt);
    client.stop();
  });

  it("the press's own read is the one its line and the announcement name, however the clock moves", async () => {
    const { client, accounts, press } = await locked();
    // Every reading of the clock a millisecond later than the last.
    let tick = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => (tick += 1));
    try {
      await press();
    } finally {
      spy.mockRestore();
    }
    const clear = accounts().clear!;
    expect(clear.status).toBe("cleared");
    expect(clear.checkedSeq).toBe(otto(accounts()).evidence.readSeq);
    expect(clear.checkedAt).toBe(otto(accounts()).evidence.checkedAt);
    client.stop();
  });

  it("on one clock tick: a Check now that finds the order back takes the Unlocked line away", async () => {
    const { client, fake, accounts, press } = await locked();
    const restore = fixedClock();
    try {
      await press();
      expect(shown(accounts().clear!, otto(accounts()))).toBe("cleared");
      // Locked again (on 2026.10.6 beside the running gateway, or by another device), then read,
      // all in the same millisecond as the press's own read.
      fake.orders.otto = { acme: ["acme:work"] };
      await client.checkLock("otto");
      expect(otto(accounts()).evidence.checkedAt).toBe(accounts().clear!.checkedAt);
      expect(accountWord(otto(accounts()))).toBe("locked");
      expect(clearShown(accounts().clear!, otto(accounts()))).toBeNull();
    } finally {
      restore();
    }
    client.stop();
  });

  it("the gateway refuses but its read finds the order gone: cleared, the read before the answer", async () => {
    const { client, fake, accounts, press } = await locked();
    fake.orderSet = () => {
      delete fake.orders.otto;
      throw new GatewayError({ code: "UNAVAILABLE", message: "said no, did it anyway" });
    };
    await press();
    expect(accounts().clear).toMatchObject({ status: "cleared", error: null });
    client.stop();
  });

  it("an order only the gateway's settings give, where the bot's own was: moved, nothing sent", async () => {
    const { client, fake, accounts, press } = await locked();
    delete fake.orders.otto;
    fake.configuredOrders.acme = ["acme:work"];
    await press();
    expect(fake.gateway.calls("models.authOrderSet")).toEqual([]);
    expect(accounts().clear?.status).toBe("moved");
    client.stop();
  });

  it("one press at a time: a second for the bot sends nothing and leaves the first's line; another bot's is refused", async () => {
    const { client, fake, accounts } = await locked();
    fake.orders.pip = { acme: ["acme:home"] };
    await client.refreshAccounts();
    const held = deferred<void>();
    fake.orderSet = async (params) => {
      await held.promise;
      delete fake.orders[params.agentId]?.[params.provider];
      return { provider: params.provider, profileIds: null };
    };
    const stamp = gatewayStamp(client.state.connection);
    const first = client.clearBotOrder("press-0001", "otto", "acme", "acme:work", "unlock", stamp);
    await until(() => fake.gateway.calls("models.authOrderSet").length === 1);
    // The same bot again (Cancel or Escape while busy, or the page left and opened again).
    await client.clearBotOrder("press-0002", "otto", "acme", "acme:work", "unlock", stamp);
    expect(accounts().clear).toMatchObject({ id: "press-0001", status: "sending" });
    await expect(
      client.clearBotOrder("press-0003", "pip", "acme", "acme:home", "unlock", stamp),
    ).rejects.toThrow("Another Unlock or Clear order is under way");
    held.resolve();
    await first;
    expect(fake.gateway.calls("models.authOrderSet")).toEqual([
      { provider: "acme", agentId: "otto" },
    ]);
    expect(accounts().clear).toMatchObject({ id: "press-0001", status: "cleared" });
    // Once it has ended, the next press goes.
    await client.clearBotOrder("press-0004", "pip", "acme", "acme:home", "unlock", stamp);
    expect(accounts().clear).toMatchObject({ id: "press-0004", botId: "pip", status: "cleared" });
    client.stop();
  });

  it("an older read that answers last never puts back the order the press cleared", async () => {
    const { client, fake, accounts, press } = await locked();
    // Check now begins first: its order is read at once, its config answer held.
    const get = fake.gateway.handlers["config.get"]!;
    const held = deferred<void>();
    let holding = true;
    fake.gateway.handlers["config.get"] = async (params) => {
      const answer = get(params);
      if (holding) {
        holding = false;
        await held.promise;
      }
      return answer;
    };
    // On one clock tick: only the order the reads began in tells them apart.
    const restore = fixedClock();
    try {
      const older = client.checkLock("otto");
      await until(() => !holding);
      await press();
      expect(accountWord(otto(accounts()))).toBe("bound");
      held.resolve();
      await older;
      expect(accountWord(otto(accounts()))).toBe("bound");
      expect(shown(accounts().clear!, otto(accounts()))).toBe("cleared");
    } finally {
      restore();
    }
    client.stop();
  });

  it("an older Check now that fails after the press says nothing over the press's read", async () => {
    const { client, fake, accounts, press } = await locked();
    // Check now begins first, and its order read is held, then fails.
    const status = fake.gateway.handlers["models.authStatus"]!;
    const held = deferred<void>();
    let holding = true;
    fake.gateway.handlers["models.authStatus"] = async (params) => {
      if (holding) {
        holding = false;
        await held.promise;
        throw new GatewayError({ code: "UNAVAILABLE", message: "slow, then down" });
      }
      return status(params);
    };
    const restore = fixedClock();
    try {
      const older = client.checkLock("otto");
      await until(() => !holding);
      await press();
      expect(accountWord(otto(accounts()))).toBe("bound");
      held.resolve();
      await older;
      expect(otto(accounts()).evidence.status).toBe("none");
      expect(accountWord(otto(accounts()))).toBe("bound");
      expect(shown(accounts().clear!, otto(accounts()))).toBe("cleared");
    } finally {
      restore();
    }
    client.stop();
  });

  it("a later Check now that fails after the person's unlock keeps it unlocked, not 'Locked, as of'", async () => {
    const { client, fake, accounts, press } = await locked();
    await press();
    expect(accountWord(otto(accounts()))).toBe("bound");
    fake.failStatusFor = "otto";
    await client.checkLock("otto");
    expect(otto(accounts()).evidence.status).toBe("failed");
    expect(accountWord(otto(accounts()))).toBe("bound");
    client.stop();
  });

  it("a lock confirmed by a newer read while the press's read is slow keeps its confirmation", async () => {
    const { client, fake, accounts, press } = await locked();
    // The press's read after its send: its config answer held.
    const get = fake.gateway.handlers["config.get"]!;
    const held = deferred<void>();
    let holding = false;
    fake.gateway.handlers["config.get"] = async (params) => {
      const answer = get(params);
      if (!holding && fake.gateway.calls("models.authOrderSet").length > 0) {
        holding = true;
        await held.promise;
      }
      return answer;
    };
    const pressed = press();
    await until(() => holding);
    // Locked again meanwhile, and confirmed by a newer read.
    fake.orders.otto = { acme: ["acme:work"] };
    await client.checkLock("otto");
    expect(accountWord(otto(accounts()))).toBe("locked");
    held.resolve();
    await pressed;
    // The newest read decides: it found the order kept, so the press says so, never "Unlocked".
    expect(shown(accounts().clear!, otto(accounts()))).toBe("kept");
    // A later read that fails: the newer confirmation stands.
    fake.failStatusFor = "otto";
    await client.checkLock("otto");
    expect(otto(accounts()).evidence.status).toBe("failed");
    expect(accountWord(otto(accounts()))).toBe("locked");
    client.stop();
  });

  for (const [now, sends] of [
    [["acme:home"], false],
    [["acme:work"], true],
  ] as const)
    it(`a newer read shown before the send, finding ${now.join(", ")}: ${sends ? "the press goes on" : "nothing is sent"}`, async () => {
      const { client, fake, accounts, press } = await locked();
      // The press's read before its send: its config answer held.
      const get = fake.gateway.handlers["config.get"]!;
      const held = deferred<void>();
      let holding = false;
      let pressing = false;
      fake.gateway.handlers["config.get"] = async (params) => {
        const answer = get(params);
        if (pressing && !holding) {
          holding = true;
          await held.promise;
        }
        return answer;
      };
      pressing = true;
      const pressed = press();
      await until(() => holding);
      // A newer Check now (or another device) shows the order as it is now.
      fake.orders.otto = { acme: [...now] };
      await client.checkLock("otto");
      held.resolve();
      await pressed;
      if (sends) {
        expect(fake.gateway.calls("models.authOrderSet")).toHaveLength(1);
        expect(accounts().clear?.status).toBe("cleared");
      } else {
        expect(fake.gateway.calls("models.authOrderSet")).toEqual([]);
        expect(accounts().clear?.status).toBe("moved");
        expect(fake.orders.otto).toEqual({ acme: ["acme:home"] });
      }
      client.stop();
    });

  it("the press forgets the lock only of the provider it cleared", async () => {
    const { client, fake, accounts, press } = await locked();
    // While the clear is under way Otto moves to Globex, where a lock of its own is kept.
    fake.shared.push({ id: "globex:team", provider: "globex", type: "token" });
    fake.orderSet = (params) => {
      delete fake.orders.otto?.acme;
      (fake.orders.otto ??= {}).globex = ["globex:team"];
      const entries = (fake.config.agents as { entries: Record<string, { model: unknown }> })
        .entries;
      entries.otto!.model = { primary: "globex/dev-1@globex:team", fallbacks: [] };
      return { provider: params.provider, profileIds: null };
    };
    await press();
    expect(accounts().clear?.status).toBe("cleared");
    expect(otto(accounts()).provider).toBe("globex");
    expect(otto(accounts()).evidence.lastMatchAt).not.toBeNull();
    client.stop();
  });

  it("an unsure ending settled by a later read settles the bot's evidence with it: no 'The lock is gone'", async () => {
    const { client, fake, accounts, press } = await locked();
    fake.orderSet = (params) => {
      delete fake.orders.otto;
      fake.failStatusFor = "otto";
      return { provider: params.provider, profileIds: null };
    };
    await press();
    expect(accounts().clear?.status).toBe("unread");
    fake.failStatusFor = null;
    await client.checkLock("otto");
    expect(accounts().clear).toMatchObject({ status: "cleared", error: null });
    expect(accounts().clear?.checkedSeq).toBe(otto(accounts()).evidence.readSeq);
    expect(otto(accounts()).evidence).toMatchObject({ lostAt: null, lastMatchAt: null });
    client.stop();
  });

  it("an accounts load begun before the press that answers last never puts the order back either", async () => {
    const { client, fake, accounts, press } = await locked();
    const get = fake.gateway.handlers["config.get"]!;
    const held = deferred<void>();
    let holding = true;
    fake.gateway.handlers["config.get"] = async (params) => {
      const answer = get(params);
      if (holding) {
        holding = false;
        await held.promise;
      }
      return answer;
    };
    const restore = fixedClock();
    try {
      const load = client.refreshAccounts();
      await until(() => !holding && fake.gateway.calls("models.authStatus").length > 0);
      await press();
      expect(accountWord(otto(accounts()))).toBe("bound");
      held.resolve();
      await load;
      expect(accountWord(otto(accounts()))).toBe("bound");
    } finally {
      restore();
    }
    client.stop();
  });

  it("another gateway answering at the same address shows nothing of the press", async () => {
    const { client, accounts, press } = await locked();
    await press();
    const engine = (client as unknown as { accounts: AccountsEngine }).accounts;
    engine.onGateway("gateway-a");
    expect(accounts().clear?.status).toBe("cleared");
    engine.onGateway("gateway-other");
    expect(accounts().clear).toBeNull();
    client.stop();
  });

  it("needs admin: below it, nothing is sent", async () => {
    const fake = new AccountsGateway();
    fake.orders.otto = { acme: ["acme:work"] };
    const { client, accounts } = await accountsClient({ gateway: fake, scopes: READ_SCOPES });
    await expect(
      client.clearBotOrder(
        "press-0001",
        "otto",
        "acme",
        "acme:work",
        "unlock",
        gatewayStamp(client.state.connection),
      ),
    ).rejects.toThrow("needs admin access");
    expect(fake.gateway.calls("models.authOrderSet")).toEqual([]);
    expect(accounts().clear).toBeNull();
    client.stop();
  });

  it("is a person's press only: the bridge takes it with its bot, order and stamp, never without", () => {
    const stamp = { gatewayId: "gateway-a", target: 4 };
    const command = {
      type: "clearBotOrder",
      press: "press-0001",
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

describe("F-592: an answer with no account status proves nothing", () => {
  // The gateway always sends `providers`, an empty list included: an answer without it is no read.
  for (const [shape, answer] of [
    ["no payload", undefined],
    ["a record with no providers list", { ts: 1 }],
  ] as const) {
    it(`the read after the press gets ${shape}: unread, never Unlocked`, async () => {
      const { client, fake, accounts, press } = await locked();
      fake.orderSet = (params) => {
        delete fake.orders.otto;
        fake.blankStatus = { agentId: "otto", answer };
        return { provider: params.provider, profileIds: null };
      };
      await press();
      expect(accounts().clear?.status).toBe("unread");
      expect(shown(accounts().clear!, otto(accounts()))).toBe("unread");
      expect(otto(accounts()).evidence).toMatchObject({
        status: "failed",
        error: NO_ACCOUNT_STATUS,
      });
      expect(accountWord(otto(accounts()))).toBe("locked");
      // A Check now that gets the same answer settles nothing either.
      await client.checkLock("otto");
      expect(accounts().clear?.status).toBe("unread");
      expect(shown(accounts().clear!, otto(accounts()))).toBe("unread");
      // The gateway's own read, once it gives one, decides.
      fake.blankStatus = null;
      await client.checkLock("otto");
      expect(shown(accounts().clear!, otto(accounts()))).toBe("cleared");
      client.stop();
    });

    it(`the read before the send gets ${shape}: nothing is sent`, async () => {
      const { client, fake, accounts, press } = await locked();
      fake.blankStatus = { agentId: "otto", answer };
      await press();
      expect(fake.gateway.calls("models.authOrderSet")).toHaveLength(0);
      expect(accounts().clear).toMatchObject({ status: "unsent", error: NO_ACCOUNT_STATUS });
      client.stop();
    });

    it(`an accounts load that gets ${shape}: an error, never a bot with no order`, async () => {
      const { client, fake, accounts } = await locked();
      fake.blankStatus = { agentId: "otto", answer };
      await client.refreshAccounts();
      expect(accounts().status).toBe("error");
      expect(accounts().error).toContain(NO_ACCOUNT_STATUS);
      expect(otto(accounts()).order).toMatchObject({ ids: ["acme:work"], stored: true });
      expect(accountWord(otto(accounts()))).toBe("locked");
      client.stop();
    });
  }
});

describe("F-592: reads ordered by when each began, a failure included", () => {
  it("an older Check now that answers after a newer one failed publishes nothing over the failure", async () => {
    const { client, fake, accounts } = await locked();
    // The older Check now's config answer is held; its status answer is already in.
    const get = fake.gateway.handlers["config.get"]!;
    const held = deferred<void>();
    let holding = true;
    fake.gateway.handlers["config.get"] = async (params) => {
      const answer = get(params);
      if (holding) {
        holding = false;
        await held.promise;
      }
      return answer;
    };
    const restore = fixedClock();
    try {
      const older = client.checkLock("otto");
      await until(() => !holding);
      fake.failStatusFor = "otto";
      await client.checkLock("otto");
      expect(otto(accounts()).evidence).toMatchObject({ status: "failed" });
      const failed = otto(accounts()).evidence;
      held.resolve();
      await older;
      expect(otto(accounts()).evidence).toEqual(failed);
    } finally {
      restore();
    }
    client.stop();
  });

  it("an accounts load begun before a Check now that failed publishes nothing over the failure", async () => {
    const { client, fake, accounts } = await locked();
    const get = fake.gateway.handlers["config.get"]!;
    const held = deferred<void>();
    let holding = true;
    fake.gateway.handlers["config.get"] = async (params) => {
      const answer = get(params);
      if (holding) {
        holding = false;
        await held.promise;
      }
      return answer;
    };
    const restore = fixedClock();
    try {
      const load = client.refreshAccounts();
      await until(() => !holding && fake.gateway.calls("models.authStatus").length > 0);
      fake.failStatusFor = "otto";
      await client.checkLock("otto");
      const failed = otto(accounts()).evidence;
      expect(failed.status).toBe("failed");
      held.resolve();
      await load;
      expect(otto(accounts()).evidence).toEqual(failed);
    } finally {
      restore();
    }
    client.stop();
  });
});

describe("F-592: a press settled by the gateway's newest read", () => {
  it("a Check now that finds the order gone while the press's read is slow: the press ends cleared, no 'The lock is gone'", async () => {
    const { client, fake, accounts, press } = await locked();
    // The gateway answers yes but the order is still there at the press's read; its config held.
    fake.orderSet = (params) => ({ provider: params.provider, profileIds: null });
    const get = fake.gateway.handlers["config.get"]!;
    const held = deferred<void>();
    let holding = false;
    fake.gateway.handlers["config.get"] = async (params) => {
      const answer = get(params);
      if (!holding && fake.gateway.calls("models.authOrderSet").length > 0) {
        holding = true;
        await held.promise;
      }
      return answer;
    };
    const pressed = press();
    await until(() => holding);
    // Gone by the time of a newer read.
    delete fake.orders.otto;
    await client.checkLock("otto");
    expect(otto(accounts()).order).toBeNull();
    held.resolve();
    await pressed;
    expect(accounts().clear).toMatchObject({
      status: "cleared",
      checkedSeq: otto(accounts()).evidence.readSeq,
    });
    expect(otto(accounts()).evidence).toMatchObject({ lostAt: null, lastMatchAt: null });
    expect(shown(accounts().clear!, otto(accounts()))).toBe("cleared");
    client.stop();
  });

  it("a newer read that still finds the order keeps the press unsure and its lock evidence", async () => {
    const { client, fake, accounts, press } = await locked();
    fake.orderSet = (params) => ({ provider: params.provider, profileIds: null });
    const get = fake.gateway.handlers["config.get"]!;
    const held = deferred<void>();
    let holding = false;
    fake.gateway.handlers["config.get"] = async (params) => {
      const answer = get(params);
      if (!holding && fake.gateway.calls("models.authOrderSet").length > 0) {
        holding = true;
        await held.promise;
      }
      return answer;
    };
    const pressed = press();
    await until(() => holding);
    await client.checkLock("otto");
    const evidence = otto(accounts()).evidence;
    held.resolve();
    await pressed;
    expect(accounts().clear?.status).toBe("kept");
    expect(otto(accounts()).evidence).toEqual(evidence);
    expect(accountWord(otto(accounts()))).toBe("locked");
    client.stop();
  });
});

describe("F-592: a provider the answer doesn't list is no reading of its order", () => {
  /** Otto's status as the fake gives it, with acme taken out or pushed past the cap. */
  const without = (fake: AccountsGateway, how: "other only" | "past the cap") => {
    const status = fake.status.bind(fake);
    return (agentId: string) => {
      const answer = status(agentId) as { providers: Array<{ provider: string }> };
      const others = answer.providers.filter((each) => each.provider !== "acme");
      if (how === "other only") return { ...answer, providers: others };
      const acme = answer.providers.filter((each) => each.provider === "acme");
      const filler = Array.from({ length: MAX_ACCOUNTS }, (_, i) => ({
        provider: `filler-${i}`,
        profiles: [],
      }));
      return { ...answer, providers: [...others, ...filler, ...acme] };
    };
  };

  for (const how of ["other only", "past the cap"] as const) {
    it(`the read after the press lists ${how === "other only" ? "only another provider" : "the provider past the cap"}: unread, never Unlocked`, async () => {
      const { client, fake, accounts, press } = await locked();
      const blank = without(fake, how);
      // The order stays stored: the gateway answered yes and kept it.
      fake.orderSet = (params) => {
        fake.blankStatus = { agentId: "otto", answer: blank("otto") };
        return { provider: params.provider, profileIds: null };
      };
      await press();
      expect(fake.orders.otto?.acme).toEqual(["acme:work"]);
      expect(accounts().clear?.status).toBe("unread");
      expect(shown(accounts().clear!, otto(accounts()))).toBe("unread");
      expect(otto(accounts()).evidence).toMatchObject({
        status: "failed",
        providerRead: false,
        error: providerNotListed("acme"),
      });
      // Nothing says the lock went: the last confirmation stands.
      expect(otto(accounts()).evidence.lostAt).toBeNull();
      expect(otto(accounts()).evidence.lastMatchAt).not.toBeNull();
      // A Check now with the same answer settles nothing.
      await client.checkLock("otto");
      expect(shown(accounts().clear!, otto(accounts()))).toBe("unread");
      client.stop();
    });

    it(`the read before the send lists ${how === "other only" ? "only another provider" : "the provider past the cap"}: nothing is sent`, async () => {
      const { client, fake, accounts, press } = await locked();
      fake.blankStatus = { agentId: "otto", answer: without(fake, how)("otto") };
      await press();
      expect(fake.gateway.calls("models.authOrderSet")).toHaveLength(0);
      expect(accounts().clear).toMatchObject({
        status: "unsent",
        error: providerNotListed("acme"),
      });
      client.stop();
    });
  }

  it("a Clear whose read after lists only another provider: unread", async () => {
    const { client, fake, accounts, press } = await locked("clear");
    const blank = without(fake, "other only");
    fake.orderSet = (params) => {
      fake.blankStatus = { agentId: "otto", answer: blank("otto") };
      return { provider: params.provider, profileIds: null };
    };
    await press();
    expect(accounts().clear?.status).toBe("unread");
    expect(shown(accounts().clear!, otto(accounts()))).toBe("unread");
    client.stop();
  });
});

describe("F-592: the press's read after, discarded for a newer read, decides nothing", () => {
  /** The press's read after its send, its config answer held until `release`. */
  function holdReadAfter(fake: AccountsGateway) {
    const get = fake.gateway.handlers["config.get"]!;
    const held = deferred<void>();
    const state = { holding: false };
    fake.gateway.handlers["config.get"] = async (params) => {
      const answer = get(params);
      if (!state.holding && fake.gateway.calls("models.authOrderSet").length > 0) {
        state.holding = true;
        await held.promise;
      }
      return answer;
    };
    return { state, release: () => held.resolve() };
  }

  it("a newer Check now that fails first: unread, never Unlocked beside 'Last confirmed locked'", async () => {
    const { client, fake, accounts, press } = await locked();
    const hold = holdReadAfter(fake);
    const restore = fixedClock();
    try {
      const pressed = press();
      await until(() => hold.state.holding);
      // The order is gone at the press's read; the newer Check now fails.
      fake.failStatusFor = "otto";
      await client.checkLock("otto");
      expect(otto(accounts()).evidence.status).toBe("failed");
      fake.failStatusFor = null;
      hold.release();
      await pressed;
      expect(accounts().clear?.status).toBe("unread");
      expect(shown(accounts().clear!, otto(accounts()))).toBe("unread");
      expect(otto(accounts()).evidence.status).toBe("failed");
    } finally {
      restore();
    }
    client.stop();
  });

  it("a newer Check now that finds the order gone first: cleared at that read, no 'The lock is gone'", async () => {
    const { client, fake, accounts, press } = await locked();
    const hold = holdReadAfter(fake);
    const restore = fixedClock();
    try {
      const pressed = press();
      await until(() => hold.state.holding);
      await client.checkLock("otto");
      const newer = otto(accounts()).evidence;
      expect(newer.lostAt).not.toBeNull();
      hold.release();
      await pressed;
      expect(accounts().clear).toMatchObject({ status: "cleared", checkedSeq: newer.readSeq });
      expect(shown(accounts().clear!, otto(accounts()))).toBe("cleared");
      expect(otto(accounts()).evidence).toMatchObject({ lostAt: null, lastMatchAt: null });
    } finally {
      restore();
    }
    client.stop();
  });

  for (const [what, change] of [
    ["named another gateway", { gatewayId: "gateway-other" }],
    ["changed (another hello)", { connectedAt: -1 }],
  ] as const)
    it(`a read after answered once the connection ${what}: unread`, async () => {
      const { client, fake, accounts, press } = await locked();
      const hold = holdReadAfter(fake);
      const engine = (client as unknown as { accounts: AccountsEngine }).accounts;
      const ctx = (engine as unknown as { ctx: AccountsContext }).ctx;
      const stamp = ctx.readStamp.bind(ctx);
      let other = false;
      // The read after begins on the press's gateway; by its answer the connection names another.
      (ctx as { readStamp: AccountsContext["readStamp"] }).readStamp = () =>
        other ? { ...stamp(), ...change } : stamp();
      const pressed = press();
      await until(() => hold.state.holding);
      other = true;
      hold.release();
      await pressed;
      expect(accounts().clear?.status).toBe("unread");
      expect(shown(accounts().clear!, otto(accounts()))).toBe("unread");
      client.stop();
    });
});

describe("F-592: never clear what the person didn't confirm", () => {
  it("a newer read that fails after moving the bot to an unlisted provider, while the read before the send is out: nothing is sent", async () => {
    const { client, fake, accounts, press } = await locked();
    // The press's read before the send: its config answer held, its status already Work alone.
    const get = fake.gateway.handlers["config.get"]!;
    const held = deferred<void>();
    let arm = false;
    let holding = false;
    fake.gateway.handlers["config.get"] = async (params) => {
      const answer = get(params);
      if (arm && !holding) {
        holding = true;
        await held.promise;
      }
      return answer;
    };
    const restore = fixedClock();
    try {
      arm = true;
      const pressed = press();
      await until(() => holding);
      // Meanwhile, on the gateway: Otto moves to a Globex account, and its Acme order to Home.
      const entries = (fake.config.agents as { entries: Record<string, { model: unknown }> })
        .entries;
      entries.otto!.model = { primary: "globex/dev-1@globex:team", fallbacks: [] };
      fake.orders.otto = { acme: ["acme:home"] };
      // A newer read whose answer leaves Globex out: a failed reading of Otto's order.
      const status = fake.status("otto") as { providers: Array<{ provider: string }> };
      fake.blankStatus = {
        agentId: "otto",
        answer: { ...status, providers: status.providers.filter((p) => p.provider !== "globex") },
      };
      await client.checkLock("otto");
      expect(otto(accounts())).toMatchObject({ provider: "globex" });
      expect(otto(accounts()).evidence).toMatchObject({ status: "failed", providerRead: false });
      held.resolve();
      await pressed;
      expect(fake.gateway.calls("models.authOrderSet")).toHaveLength(0);
      expect(fake.orders.otto?.acme).toEqual(["acme:home"]);
      expect(accounts().clear).toMatchObject({
        status: "unsent",
        error: unconfirmedOrder("unlock"),
      });
    } finally {
      restore();
    }
    client.stop();
  });

  for (const [what, change] of [
    ["with nothing else changed", null],
    ["while the order changed from Work to Home", ["acme:home"]],
  ] as const)
    it(`a newer read that failed, ${what}: nothing is sent, and the page asks to check first`, async () => {
      const { client, fake, accounts, press } = await locked();
      // The press's read before the send: its config answer held, its status Work alone.
      const get = fake.gateway.handlers["config.get"]!;
      const held = deferred<void>();
      let arm = false;
      let holding = false;
      fake.gateway.handlers["config.get"] = async (params) => {
        const answer = get(params);
        if (arm && !holding) {
          holding = true;
          await held.promise;
        }
        return answer;
      };
      const restore = fixedClock();
      try {
        arm = true;
        const pressed = press();
        await until(() => holding);
        if (change) fake.orders.otto = { acme: [...change] };
        // A newer Check now fails: the page keeps its last reading, Work alone, and confirms nothing.
        fake.failStatusFor = "otto";
        await client.checkLock("otto");
        expect(otto(accounts()).evidence.status).toBe("failed");
        expect(otto(accounts()).order).toMatchObject({ ids: ["acme:work"], stored: true });
        fake.failStatusFor = null;
        held.resolve();
        await pressed;
        expect(fake.gateway.calls("models.authOrderSet")).toHaveLength(0);
        expect(fake.orders.otto?.acme).toEqual(change ?? ["acme:work"]);
        expect(accounts().clear).toMatchObject({
          status: "unsent",
          error: unconfirmedOrder("unlock"),
        });
        expect(shown(accounts().clear!, otto(accounts()))).toBe("unsent");
        // A Check now that succeeds since leaves the ending as it was: nothing was sent.
        await client.checkLock("otto");
        expect(shown(accounts().clear!, otto(accounts()))).toBe("unsent");
      } finally {
        restore();
      }
      client.stop();
    });

  it("an accounts load that fails to read Otto while the order goes from Work to Home: nothing is sent", async () => {
    const { client, fake, accounts, press } = await locked();
    // The press's read before the send: its config answer held, its status Work alone.
    const get = fake.gateway.handlers["config.get"]!;
    const held = deferred<void>();
    let arm = false;
    let holding = false;
    fake.gateway.handlers["config.get"] = async (params) => {
      const answer = get(params);
      if (arm && !holding) {
        holding = true;
        await held.promise;
      }
      return answer;
    };
    const restore = fixedClock();
    try {
      arm = true;
      const pressed = press();
      await until(() => holding);
      fake.orders.otto = { acme: ["acme:home"] };
      // A full accounts read whose request for Otto fails.
      fake.failStatusFor = "otto";
      await client.refreshAccounts();
      expect(accounts().status).toBe("error");
      expect(otto(accounts()).evidence.status).toBe("failed");
      fake.failStatusFor = null;
      held.resolve();
      await pressed;
      expect(fake.gateway.calls("models.authOrderSet")).toHaveLength(0);
      expect(fake.orders.otto?.acme).toEqual(["acme:home"]);
      expect(accounts().clear).toMatchObject({
        status: "unsent",
        error: unconfirmedOrder("unlock"),
      });
      expect(shown(accounts().clear!, otto(accounts()))).toBe("unsent");
    } finally {
      restore();
    }
    client.stop();
  });

  /**
   * Otto locked to Work, the press out with its read before the send held (its status answered
   * Work alone, its config answer held), and the clock fixed. `release` lets that read finish.
   */
  async function heldPress() {
    const ready = await locked();
    const get = ready.fake.gateway.handlers["config.get"]!;
    const held = deferred<void>();
    let holding = false;
    ready.fake.gateway.handlers["config.get"] = async (params) => {
      const answer = get(params);
      if (!holding) {
        holding = true;
        await held.promise;
      }
      return answer;
    };
    const restore = fixedClock();
    const pressed = ready.press();
    await until(() => holding);
    const release = async () => {
      held.resolve();
      await pressed;
    };
    return { ...ready, release, restore };
  }

  /** Each bot's next `models.authStatus` held until its own release; the others answer. */
  function holdStatusOf(fake: AccountsGateway, botId: string) {
    const status = fake.gateway.handlers["models.authStatus"]!;
    const held = deferred<void>();
    let asked = false;
    fake.gateway.handlers["models.authStatus"] = async (params) => {
      if ((params as { agentId: string }).agentId === botId && !asked) {
        asked = true;
        await held.promise;
      }
      return status(params);
    };
    return { asked: () => asked, release: () => held.resolve() };
  }

  it("a newer load fails for Otto while its read for Pip is still out: nothing is sent, Home stays", async () => {
    const { client, fake, accounts, release, restore } = await heldPress();
    try {
      fake.orders.otto = { acme: ["acme:home"] };
      // The load's request for Otto fails at once; its failure is recorded only when the load
      // ends, which waits for Pip's.
      const pip = holdStatusOf(fake, "pip");
      fake.failStatusFor = "otto";
      const loading = client.refreshAccounts();
      await until(() => pip.asked());
      await until(() =>
        fake.gateway
          .calls("models.authStatus")
          .some((each) => (each as { agentId: string }).agentId === "otto"),
      );
      fake.failStatusFor = null;
      await release();
      expect(fake.gateway.calls("models.authOrderSet")).toHaveLength(0);
      expect(fake.orders.otto?.acme).toEqual(["acme:home"]);
      expect(accounts().clear).toMatchObject({
        status: "unsent",
        error: unconfirmedOrder("unlock"),
      });
      pip.release();
      await loading;
      expect(shown(accounts().clear!, otto(accounts()))).toBe("unsent");
    } finally {
      restore();
    }
    client.stop();
  });

  it("a newer load reads Home for Otto but fails for Pip, so Otto's reading is dropped: nothing is sent", async () => {
    const { client, fake, accounts, release, restore } = await heldPress();
    try {
      fake.orders.otto = { acme: ["acme:home"] };
      fake.failStatusFor = "pip";
      await client.refreshAccounts();
      expect(accounts().status).toBe("error");
      // Otto's own read answered; it went with the rest of the load, so the page still shows Work.
      expect(otto(accounts()).order).toMatchObject({ ids: ["acme:work"], stored: true });
      fake.failStatusFor = null;
      await release();
      expect(fake.gateway.calls("models.authOrderSet")).toHaveLength(0);
      expect(fake.orders.otto?.acme).toEqual(["acme:home"]);
      expect(accounts().clear).toMatchObject({
        status: "unsent",
        error: unconfirmedOrder("unlock"),
      });
    } finally {
      restore();
    }
    client.stop();
  });

  it("a newer Check now still out when the press's read comes back: nothing is sent, Home stays", async () => {
    const { client, fake, accounts, release, restore } = await heldPress();
    try {
      fake.orders.otto = { acme: ["acme:home"] };
      const check = holdStatusOf(fake, "otto");
      const checking = client.checkLock("otto");
      await until(() => check.asked());
      await release();
      expect(fake.gateway.calls("models.authOrderSet")).toHaveLength(0);
      expect(fake.orders.otto?.acme).toEqual(["acme:home"]);
      expect(accounts().clear).toMatchObject({
        status: "unsent",
        error: unconfirmedOrder("unlock"),
      });
      check.release();
      await checking;
      expect(otto(accounts()).order).toMatchObject({ ids: ["acme:home"], stored: true });
    } finally {
      restore();
    }
    client.stop();
  });

  it("a newer load applied for Otto that still shows Work alone: the press goes on", async () => {
    const { client, fake, accounts, release, restore } = await heldPress();
    try {
      await client.refreshAccounts();
      expect(accounts().status).toBe("ready");
      const evidence = otto(accounts()).evidence;
      expect(evidence.readSeq).toBe(evidence.startedSeq);
      await release();
      expect(fake.gateway.calls("models.authOrderSet")).toEqual([
        { provider: "acme", agentId: "otto" },
      ]);
      expect(accounts().clear?.status).toBe("cleared");
    } finally {
      restore();
    }
    client.stop();
  });

  it("the read before the send that fails: unsent, and the bot's page says the read failed", async () => {
    const { client, fake, accounts, press } = await locked();
    fake.failStatusFor = "otto";
    await press();
    expect(fake.gateway.calls("models.authOrderSet")).toHaveLength(0);
    expect(accounts().clear?.status).toBe("unsent");
    expect(otto(accounts()).evidence).toMatchObject({
      status: "failed",
      error: "status unavailable",
    });
    client.stop();
  });

  it("a load that fails to read one bot says so on that bot alone; the others keep their reading", async () => {
    const { client, fake, accounts } = await locked();
    const pip = () => accounts().bindings.find((each) => each.botId === "pip")!;
    const before = pip().evidence;
    fake.failStatusFor = "otto";
    await client.refreshAccounts();
    expect(accounts().status).toBe("error");
    expect(otto(accounts()).evidence).toMatchObject({
      status: "failed",
      error: "status unavailable",
    });
    // As after a failed Check now: the last confirmation stands.
    expect(accountWord(otto(accounts()))).toBe("locked");
    // Its reading is as it was; only the load's read, sent for it too, is stamped as begun.
    expect(pip().evidence).toEqual({ ...before, startedSeq: expect.any(Number) });
    expect(pip().evidence.startedSeq).toBeGreaterThan(before.startedSeq ?? 0);
    client.stop();
  });

  it("a load whose config read fails leaves every bot's order unread, as each one's Check now would", async () => {
    const { client, fake, accounts } = await locked();
    fake.gateway.handlers["config.get"] = () => {
      throw new GatewayError({ code: "UNAVAILABLE", message: "config down" });
    };
    await client.refreshAccounts();
    expect(accounts().status).toBe("error");
    for (const binding of accounts().bindings)
      expect(binding.evidence).toMatchObject({ status: "failed", error: "config down" });
    client.stop();
  });

  it("a newer read that failed and a newer one that succeeded since, finding Work alone: the press goes on", async () => {
    const { client, fake, accounts, press } = await locked();
    const get = fake.gateway.handlers["config.get"]!;
    const held = deferred<void>();
    let arm = false;
    let holding = false;
    fake.gateway.handlers["config.get"] = async (params) => {
      const answer = get(params);
      if (arm && !holding) {
        holding = true;
        await held.promise;
      }
      return answer;
    };
    const restore = fixedClock();
    try {
      arm = true;
      const pressed = press();
      await until(() => holding);
      fake.failStatusFor = "otto";
      await client.checkLock("otto");
      fake.failStatusFor = null;
      await client.checkLock("otto");
      expect(otto(accounts()).evidence.status).toBe("matched");
      held.resolve();
      await pressed;
      expect(fake.gateway.calls("models.authOrderSet")).toHaveLength(1);
      expect(accounts().clear?.status).toBe("cleared");
    } finally {
      restore();
    }
    client.stop();
  });
});

describe("F-592: a newest attempt that failed settles nothing", () => {
  it("a Check now finds the order gone and a later one fails, while the press's read after is out: unread", async () => {
    const { client, fake, accounts, press } = await locked();
    fake.orderSet = (params) => ({ provider: params.provider, profileIds: null });
    // The press's read after: its config answer held.
    const get = fake.gateway.handlers["config.get"]!;
    const held = deferred<void>();
    let holding = false;
    fake.gateway.handlers["config.get"] = async (params) => {
      const answer = get(params);
      if (!holding && fake.gateway.calls("models.authOrderSet").length > 0) {
        holding = true;
        await held.promise;
      }
      return answer;
    };
    const restore = fixedClock();
    try {
      const pressed = press();
      await until(() => holding);
      delete fake.orders.otto;
      await client.checkLock("otto");
      expect(otto(accounts()).order).toBeNull();
      fake.failStatusFor = "otto";
      await client.checkLock("otto");
      const evidence = otto(accounts()).evidence;
      expect(evidence.status).toBe("failed");
      held.resolve();
      await pressed;
      expect(accounts().clear?.status).toBe("unread");
      expect(shown(accounts().clear!, otto(accounts()))).toBe("unread");
      // The lock evidence the gone read left is not touched by the press.
      expect(otto(accounts()).evidence).toEqual(evidence);
      // A read that succeeds again decides.
      fake.failStatusFor = null;
      await client.checkLock("otto");
      expect(shown(accounts().clear!, otto(accounts()))).toBe("cleared");
    } finally {
      restore();
    }
    client.stop();
  });

  it("clearShown: a read that found the order gone, with a failed attempt after it, shows the press as it ended", () => {
    const clear: OrderClear = {
      id: "press-0001",
      gatewayId: "gateway-a",
      botId: "otto",
      provider: "acme",
      kind: "unlock",
      account: "acme:work",
      status: "unread",
      error: null,
      at: 1,
      sentSeq: 1,
      checkedSeq: null,
      checkedAt: null,
    };
    const gone = (attemptSeq: number): BotBinding => ({
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
      order: null,
      evidence: {
        status: "failed",
        checkedAt: 2,
        lastMatchAt: null,
        lostAt: null,
        readSeq: 2,
        attemptSeq,
        readGateway: "gateway-a",
        providerRead: true,
        error: null,
      },
      fallbacksUnwritten: false,
    });
    expect(shown(clear, gone(2))).toBe("cleared");
    expect(shown(clear, gone(3))).toBe("unread");
  });
});

describe("F-592: a newer read published just after the press's read after", () => {
  it("the newest read decides, and the bot's evidence is settled with the outcome: no 'The lock is gone'", async () => {
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
            readSeq: null,
            attemptSeq: null,
            readGateway: null,
            providerRead: true,
            error: null,
          },
          fallbacksUnwritten: false,
        },
      ],
    };
    let stored = true;
    let sent = false;
    let injected: number | null = null;
    const ctx = {
      request: async (method: string) => {
        if (method === "models.authStatus")
          return {
            providers: [
              {
                provider: "acme",
                profiles: [{ profileId: "acme:work", type: "api_key", source: "inherited" }],
                ...(stored ? { profileOrder: ["acme:work"], profileOrderStored: true } : {}),
              },
            ],
          };
        if (method === "config.get")
          return {
            config: {
              agents: {
                entries: { otto: { model: { primary: "acme/dev-1@acme:work", fallbacks: [] } } },
              },
            },
          };
        if (method === "models.authOrderSet") {
          sent = true;
          stored = false;
          return { provider: "acme", profileIds: null };
        }
        throw new Error(`unexpected ${method}`);
      },
      get: () => state,
      update: (change: (a: AccountsState) => AccountsState) => {
        state = change(state);
        // At once after the press's read after is published, a newer read lands: the order gone,
        // and the lock it remembers said lost, as `evaluateOrder` does.
        const b = state.bindings[0]!;
        if (sent && injected === null && b.order === null && b.evidence.readSeq !== null) {
          injected = b.evidence.readSeq + 100;
          state = {
            ...state,
            bindings: [
              {
                ...b,
                evidence: {
                  ...b.evidence,
                  status: "none",
                  checkedAt: 20,
                  lostAt: 20,
                  readSeq: injected,
                  attemptSeq: injected,
                },
              },
            ],
          };
        }
      },
      connected: () => true,
      admin: () => true,
      gatewayNow: () => "gateway-a",
      readStamp: () => ({ gatewayId: "gateway-a", target: 1, connectedAt: 1 }),
      now: () => 10,
      log: () => {},
    } as unknown as AccountsContext;
    const engine = new AccountsEngine(ctx);
    await engine.clearOrder("press-0001", "otto", "acme", "acme:work", "unlock");
    expect(injected).not.toBeNull();
    expect(state.clear).toMatchObject({ status: "cleared", checkedSeq: injected, checkedAt: 20 });
    expect(state.bindings[0]!.evidence).toMatchObject({ lostAt: null, lastMatchAt: null });
    expect(shown(state.clear!, state.bindings[0]!)).toBe("cleared");
  });
});

describe("F-592: a press settled only by a read of its own gateway", () => {
  it("a read while the gateway is unnamed, or of another one, settles nothing; the same gateway's does", async () => {
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
            readSeq: null,
            attemptSeq: null,
            readGateway: null,
            providerRead: true,
            error: null,
          },
          fallbacksUnwritten: false,
        },
      ],
    };
    let stored = true;
    let stamp = { gatewayId: "gateway-a" as string | null, target: 1, connectedAt: 1 };
    const ctx = {
      request: async (method: string) => {
        if (method === "models.authStatus")
          return {
            providers: [
              {
                provider: "acme",
                profiles: [{ profileId: "acme:work", type: "api_key", source: "inherited" }],
                ...(stored ? { profileOrder: ["acme:work"], profileOrderStored: true } : {}),
              },
            ],
          };
        if (method === "config.get")
          return {
            config: {
              agents: {
                entries: { otto: { model: { primary: "acme/dev-1@acme:work", fallbacks: [] } } },
              },
            },
          };
        // Its answer lost; the order still there at the read after.
        if (method === "models.authOrderSet") throw new Error("gateway request timeout");
        throw new Error(`unexpected ${method}`);
      },
      get: () => state,
      update: (change: (a: AccountsState) => AccountsState) => {
        state = change(state);
      },
      connected: () => true,
      admin: () => true,
      gatewayNow: () => stamp.gatewayId,
      readStamp: () => stamp,
      now: () => 10,
      log: () => {},
    } as unknown as AccountsContext;
    const engine = new AccountsEngine(ctx);
    await engine.clearOrder("press-0001", "otto", "acme", "acme:work", "unlock");
    expect(state.clear).toMatchObject({ gatewayId: "gateway-a", status: "unanswered" });
    // The order goes; the connection comes back at the same address, its gateway not yet named.
    stored = false;
    stamp = { gatewayId: null, target: 1, connectedAt: 2 };
    await engine.checkLock("otto");
    expect(state.bindings[0]!.order).toBeNull();
    expect(state.clear?.status).toBe("unanswered");
    expect(shown(state.clear!, state.bindings[0]!)).toBe("unanswered");
    // Another gateway named on it: still nothing of the press.
    stamp = { gatewayId: "gateway-b", target: 1, connectedAt: 3 };
    await engine.checkLock("otto");
    expect(state.clear?.status).toBe("unanswered");
    expect(shown(state.clear!, state.bindings[0]!)).toBe("unanswered");
    // The gateway it was sent to, after a reconnect: its read settles the press.
    stamp = { gatewayId: "gateway-a", target: 1, connectedAt: 4 };
    await engine.checkLock("otto");
    expect(state.clear).toMatchObject({
      status: "cleared",
      checkedSeq: state.bindings[0]!.evidence.readSeq,
    });
    expect(shown(state.clear!, state.bindings[0]!)).toBe("cleared");
  });

  it("a read on a connection that changed while it was out is no read of the press's gateway", () => {
    const clear: OrderClear = {
      id: "press-0001",
      gatewayId: "gateway-a",
      botId: "otto",
      provider: "acme",
      kind: "unlock",
      account: "acme:work",
      status: "unread",
      error: null,
      at: 1,
      sentSeq: 1,
      checkedSeq: null,
      checkedAt: null,
    };
    const gone = (readGateway: string | null): BotBinding => ({
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
      order: null,
      evidence: {
        status: "none",
        checkedAt: 2,
        lastMatchAt: null,
        lostAt: null,
        readSeq: 2,
        attemptSeq: 2,
        readGateway,
        providerRead: true,
        error: null,
      },
      fallbacksUnwritten: false,
    });
    expect(shown(clear, gone("gateway-a"))).toBe("cleared");
    expect(shown(clear, gone(null))).toBe("unread");
    expect(shown(clear, gone("gateway-b"))).toBe("unread");
    expect(shown({ ...clear, gatewayId: null }, gone(null))).toBe("unread");
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
    await expect(
      client.clearBotOrder("press-0001", "otto", "acme", "acme:work", "unlock", stamp),
    ).rejects.toThrow(CONNECTION_CHANGED);
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
      "press-0001",
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

  it("a switch begun as the first read answers sends nothing to either gateway", async () => {
    const { client, a, b } = await twoGateways();
    const status = a.gateway.handlers["models.authStatus"]!;
    let switching: Promise<void> | null = null;
    a.gateway.handlers["models.authStatus"] = (params) => {
      // The person points the host at the other gateway while the answer is on its way.
      switching ??= client.connect({ url: URL_B });
      return status(params);
    };
    await client.clearBotOrder(
      "press-0001",
      "otto",
      "acme",
      "acme:work",
      "unlock",
      gatewayStamp(client.state.connection),
    );
    await switching;
    await until(() => client.state.connection.gatewayUrl === URL_B);
    expect(a.gateway.calls("models.authOrderSet")).toEqual([]);
    expect(b.gateway.calls("models.authOrderSet")).toEqual([]);
    expect(b.orders.otto?.acme).toEqual(["acme:work"]);
    client.stop();
  });

  it("the client gives the press a check bound to the screen's connection: after a switch it refuses", async () => {
    const { client, switchToB } = await twoGateways();
    const engine = (client as unknown as { accounts: AccountsEngine }).accounts;
    let given: ((sent: boolean) => void) | undefined;
    engine.clearOrder = async (_id, _bot, _provider, _account, _kind, beforeSend) => {
      given = beforeSend;
    };
    await client.clearBotOrder(
      "press-0001",
      "otto",
      "acme",
      "acme:work",
      "unlock",
      gatewayStamp(client.state.connection),
    );
    expect(() => given!(false)).not.toThrow();
    await switchToB();
    expect(() => given!(false)).toThrow(CONNECTION_CHANGED);
    client.stop();
  });

  it("the engine asks that check before the send and before the read after", async () => {
    const { client, a } = await twoGateways();
    const engine = (client as unknown as { accounts: AccountsEngine }).accounts;
    // Refusing from the first read's answer on: nothing is sent.
    let gone = false;
    const status = a.gateway.handlers["models.authStatus"]!;
    a.gateway.handlers["models.authStatus"] = (params) => {
      gone = true;
      return status(params);
    };
    await engine.clearOrder("press-0001", "otto", "acme", "acme:work", "unlock", () => {
      if (gone) throw new Error("changed");
    });
    expect(a.gateway.calls("models.authOrderSet")).toEqual([]);
    expect(client.state.accounts.clear).toMatchObject({ status: "unsent", error: "changed" });
    // Refusing from the send on: no read after it, and nothing said to be cleared.
    a.gateway.handlers["models.authStatus"] = status;
    const reads = () => a.gateway.calls("models.authStatus").length;
    let sent = false;
    let readsAtSend = 0;
    await engine.clearOrder("press-0001", "otto", "acme", "acme:work", "unlock", (wrote) => {
      if (wrote && !sent) {
        sent = true;
        readsAtSend = reads();
      }
      if (sent) throw new Error("changed after the send");
    });
    expect(a.gateway.calls("models.authOrderSet")).toHaveLength(1);
    expect(reads()).toBe(readsAtSend);
    expect(client.state.accounts.clear?.status).toBe("unread");
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
      "press-0001",
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
            readSeq: null,
            attemptSeq: null,
            readGateway: null,
            providerRead: true,
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
            config: {
              agents: {
                entries: { otto: { model: { primary: "acme/dev-1@acme:work", fallbacks: [] } } },
              },
            },
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
      gatewayNow: () => "gateway-a",
      readStamp: () => ({ gatewayId: "gateway-a", target: 1, connectedAt: 1 }),
      now: () => 10,
      log: () => {},
    } as unknown as AccountsContext;
    const engine = new AccountsEngine(ctx);
    await engine.clearOrder("press-0001", "otto", "acme", "acme:work", "unlock");
    expect(waits).toEqual([ORDER_CLEAR_WAIT_MS]);
    // The answer didn't come; the read after it found the order gone.
    expect(state.clear?.status).toBe("cleared");
    stored = true;
    // A new engine numbers its reads afresh: nothing it reads carries the first engine's numbers.
    const fresh = (a: AccountsState): AccountsState => ({
      ...a,
      clear: null,
      bindings: a.bindings.map((b) => ({
        ...b,
        evidence: { ...b.evidence, readSeq: null, attemptSeq: null, startedSeq: null },
      })),
    });
    state = fresh(state);
    const engine2 = new AccountsEngine({
      ...ctx,
      request: async (method: string, params: unknown, options?: { timeoutMs?: number }) => {
        if (method === "models.authOrderSet") throw new Error("gateway request timeout");
        return ctx.request(method, params, options);
      },
    });
    await engine2.clearOrder("press-0001", "otto", "acme", "acme:work", "unlock");
    expect(state.clear).toMatchObject({ status: "unanswered", error: "gateway request timeout" });
    // Another gateway (`reset`) while the first read is out: nothing is sent, with no host check.
    stored = true;
    state = fresh(state);
    const sent: string[] = [];
    let engine3: AccountsEngine | null = null;
    engine3 = new AccountsEngine({
      ...ctx,
      request: async (method: string, params: unknown, options?: { timeoutMs?: number }) => {
        sent.push(method);
        if (method === "models.authStatus") engine3!.reset();
        return ctx.request(method, params, options);
      },
    });
    await engine3.clearOrder("press-0002", "otto", "acme", "acme:work", "unlock");
    expect(sent).not.toContain("models.authOrderSet");
  });
});
