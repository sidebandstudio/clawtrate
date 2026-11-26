// The person's choices and the rail's arrangement follow them to each device on one gateway
// (#639, F-601): two clients, two devices of one person, on one fake gateway whose per-user
// preferences behave as OpenClaw's do (a compare-and-set, `users.prefs.changed` to every
// connection of the user, `no_durable_identity` when the gateway keeps no user for it).

import { describe, expect, it } from "vitest";
import { createBridgeSession, parseBridgeCommand } from "../src/bridge.ts";
import {
  CHOICES_PREF_KEY,
  parseChoices,
  shownChoice,
  writeChoices,
  type ChoicesState,
} from "../src/choices.ts";
import {
  CHOICE_OFFLINE,
  CHOICE_READ_ONLY,
  ClawtrateClient,
  CONNECTION_CHANGED,
} from "../src/client.ts";
import { INTERACTIVE_SCOPES, READ_SCOPES } from "../src/scopes.ts";
import { mergeSidebars, parseSidebar, SIDEBAR_PREF_KEY } from "../src/sidebar.ts";
import { enforceState } from "../src/state-bounds.ts";
import { gatewayStamp, initialState } from "../src/types.ts";
import { FAST, grantingGateway, URL_A, URL_B } from "./client-harness.ts";
import { deferred, memoryStorage, testHost, tokenKey, until } from "./fake-gateway.ts";

/** One gateway's per-user preferences: one user, the owner, for every paired device. */
function prefsGateway(identity = "gateway-a") {
  const gateway = grantingGateway();
  const store: Record<string, unknown> = {};
  const fake = {
    gateway,
    store,
    /** False: the gateway keeps no user for these connections (`gateway.roles` set). */
    durable: true,
    /** Held once: the next write waits for it, after its read. */
    hold: null as Promise<void> | null,
  };
  gateway.handlers["gateway.identity.get"] = () => ({ deviceId: identity });
  gateway.handlers["users.prefs.get"] = (params) => {
    if (!fake.durable) return { status: "no_durable_identity" };
    const keys = (params as { keys?: string[] }).keys ?? Object.keys(store);
    const entries = Object.fromEntries(
      keys.filter((key) => Object.hasOwn(store, key)).map((key) => [key, store[key]]),
    );
    return { status: "ok", entries: JSON.parse(JSON.stringify(entries)) as unknown };
  };
  gateway.handlers["users.prefs.set"] = async (params) => {
    if (!fake.durable) return { status: "no_durable_identity" };
    const held = fake.hold;
    fake.hold = null;
    if (held) await held;
    const { entries, expectedEntries = {} } = params as {
      entries: Record<string, unknown>;
      expectedEntries?: Record<string, unknown>;
    };
    for (const [key, value] of Object.entries(expectedEntries)) {
      const now = Object.hasOwn(store, key) ? JSON.stringify(store[key]) : null;
      if (now !== (value === null ? null : JSON.stringify(value))) return { status: "conflict" };
    }
    for (const [key, value] of Object.entries(entries)) {
      if (value === null) delete store[key];
      else store[key] = JSON.parse(JSON.stringify(value)) as unknown;
    }
    // As the gateway does: the answer first, then every connection of the user hears of it.
    setTimeout(() =>
      gateway.emit("users.prefs.changed", { profileId: "owner", keys: Object.keys(entries) }),
    );
    return { status: "ok" };
  };
  return fake;
}
type PrefsGateway = ReturnType<typeof prefsGateway>;

/** A device of the person, paired with `fake`, with its own storage. */
async function device(
  fake: PrefsGateway,
  options: { held?: readonly string[]; readOnly?: boolean; own?: Record<string, string> } = {},
) {
  const held = options.held ?? INTERACTIVE_SCOPES;
  const storage = memoryStorage({
    connection: JSON.stringify({ url: URL_A, token: null }),
    [tokenKey(URL_A)]: JSON.stringify({
      token: "device-token",
      grantedScopes: held,
      heldScopes: held,
    }),
    ...options.own,
  });
  const client = new ClawtrateClient(testHost(fake.gateway, storage), {
    ...FAST,
    ...(options.readOnly ? { readOnly: true } : {}),
  });
  await client.start();
  await until(
    () =>
      client.state.connection.status === "connected" &&
      client.state.connection.gatewayId !== null &&
      client.state.choices?.status !== "unknown",
  );
  return { client, storage, stamp: () => gatewayStamp(client.state.connection) };
}

const sets = (fake: PrefsGateway) => fake.gateway.calls("users.prefs.set");

describe("F-601: choices follow the person to each device on one gateway", () => {
  it("F-601: each kind changed on one device appears on the other while both are connected", async () => {
    const fake = prefsGateway();
    const a = await device(fake);
    const b = await device(fake);
    await a.client.setShowChannelChats(true, { stamp: a.stamp() });
    await a.client.setShowOtherToolSessions(true, { stamp: a.stamp() });
    await a.client.setShowGatewayBot(true, { stamp: a.stamp() });
    expect(
      await a.client.changeChoices({ commands: true, thinking: true }, { stamp: a.stamp() }),
    ).toBe("gateway");
    await until(
      () =>
        b.client.state.showChannelChats === true &&
        b.client.state.showOtherToolSessions === true &&
        b.client.state.showGatewayBot === true &&
        b.client.state.choices?.prefs?.on.commands === true &&
        b.client.state.choices?.prefs?.on.thinking === true,
    );
    // The rail's arrangement, as before.
    await a.client.changeSidebar({ op: "pin", botId: "main", pinned: true }, null);
    await until(() => b.client.state.sidebar?.prefs?.pins.includes("main") === true);
    // Turned off on the device that turned it on: off on the other, whose own was never on.
    await a.client.setShowChannelChats(false, { stamp: a.stamp() });
    await until(() => b.client.state.showChannelChats === false);
    a.client.stop();
    b.client.stop();
  });

  it("F-601: a change on both devices at once: two choices both survive; one choice goes to the last write", async () => {
    const fake = prefsGateway();
    const a = await device(fake);
    const b = await device(fake);
    // A reads, and its write waits until B has written: A's compare-and-set then conflicts, and
    // its change is applied again to what B left.
    const gate = deferred<void>();
    fake.hold = gate.promise;
    const first = a.client.changeChoices({ channelChats: true }, { stamp: a.stamp() });
    await until(() => sets(fake).length === 1);
    await b.client.changeChoices({ otherTools: true }, { stamp: b.stamp() });
    gate.resolve();
    await first;
    expect(sets(fake)).toHaveLength(3);
    expect(parseChoices(fake.store[CHOICES_PREF_KEY]).on).toEqual({
      channelChats: true,
      otherTools: true,
    });
    await until(
      () =>
        a.client.state.showOtherToolSessions === true && b.client.state.showChannelChats === true,
    );
    // The same choice: the gateway keeps the last write, by its revision on both devices.
    await a.client.changeChoices({ commands: true }, { stamp: a.stamp() });
    await b.client.changeChoices({ commands: false }, { stamp: b.stamp() });
    const rev = parseChoices(fake.store[CHOICES_PREF_KEY]).rev;
    await until(() => a.client.state.choices?.prefs?.rev === rev);
    expect(a.client.state.choices?.prefs?.on.commands).toBe(false);
    a.client.stop();
    b.client.stop();
  });

  it("F-601: a value from the gateway only shows more: what a device turned on itself stays on", async () => {
    const fake = prefsGateway();
    fake.store[CHOICES_PREF_KEY] = { on: { channelChats: false, gatewayBot: true }, rev: 3 };
    const b = await device(fake, { own: { "show-channel-chats": "true" } });
    // Its own on stays on although the gateway holds off; the gateway's on shows.
    expect(b.client.state.showChannelChats).toBe(true);
    expect(b.client.state.showGatewayBot).toBe(true);
    const held: ChoicesState = { status: "ok", prefs: { on: { commands: false } } };
    expect(shownChoice(held, true, "commands")).toBe(true);
    expect(shownChoice(held, false, "commands")).toBe(false);
    expect(
      shownChoice({ status: "ok", prefs: { on: { commands: true } } }, false, "commands"),
    ).toBe(true);
    expect(
      shownChoice({ status: "unavailable", prefs: { on: { commands: true } } }, false, "commands"),
    ).toBe(false);
    b.client.stop();
  });

  it("F-601: a value that tries to hide something or switch on an admin-only option, written by any device (a read-only one can, on 2026.11.10), is ignored", async () => {
    const fake = prefsGateway();
    const own = {
      "show-channel-chats": "true",
      "show-other-tool-sessions": "true",
      "show-gateway-bot": "true",
    };
    const b = await device(fake, { own });
    await until(() => sets(fake).length === 1);
    const before = fake.gateway.requests.length;
    // Written by anything that can write the store, then announced as the gateway announces it.
    fake.store[CHOICES_PREF_KEY] = {
      on: {
        channelChats: false,
        otherTools: false,
        gatewayBot: false,
        commands: false,
        thinking: false,
        guides: true,
        newBots: true,
        admin: true,
      },
      rev: 99,
      guides: { newBots: true },
    };
    fake.gateway.emit("users.prefs.changed", { profileId: "owner", keys: [CHOICES_PREF_KEY] });
    await until(() => b.client.state.choices?.prefs?.rev === 99);
    // What this device turned on stays shown; the unknown names are dropped, not kept.
    expect(b.client.state.showChannelChats).toBe(true);
    expect(b.client.state.showOtherToolSessions).toBe(true);
    expect(b.client.state.showGatewayBot).toBe(true);
    expect(Object.keys(b.client.state.choices?.prefs?.on ?? {}).sort()).toEqual(
      ["channelChats", "commands", "gatewayBot", "otherTools", "thinking"].sort(),
    );
    // Nothing was written or asked for because of it: only the read of the new value.
    expect(fake.gateway.requests.slice(before).map((request) => request.method)).toEqual([
      "users.prefs.get",
    ]);
    b.client.stop();
  });

  it("F-601: an offline device shows what it last had, catches up on reconnect, and can't turn off the gateway's on", async () => {
    const fake = prefsGateway();
    const a = await device(fake);
    const b = await device(fake);
    await a.client.setShowChannelChats(true, { stamp: a.stamp() });
    await until(() => b.client.state.showChannelChats === true);
    await b.client.suspend();
    await until(() => b.client.state.connection.status !== "connected");
    // What it last had, shown while away.
    expect(b.client.state.showChannelChats).toBe(true);
    await expect(b.client.setShowChannelChats(false, { stamp: b.stamp() })).rejects.toThrow(
      CHOICE_OFFLINE,
    );
    // Turning one on while away shows it here, and sends nothing.
    const before = sets(fake).length;
    await b.client.setShowGatewayBot(true, { stamp: b.stamp() });
    expect(b.client.state.showGatewayBot).toBe(true);
    expect(sets(fake)).toHaveLength(before);
    await a.client.setShowOtherToolSessions(true, { stamp: a.stamp() });
    expect(b.client.state.showOtherToolSessions).toBe(false);
    await b.client.retryNow();
    await until(() => b.client.state.showOtherToolSessions === true);
    a.client.stop();
    b.client.stop();
  });

  it("F-601: the first time, a device's own choices fill what the gateway holds none of, once, with nothing to click", async () => {
    const fake = prefsGateway();
    fake.store[CHOICES_PREF_KEY] = { on: { otherTools: false }, rev: 1 };
    const b = await device(fake, {
      own: { "show-channel-chats": "true", "show-other-tool-sessions": "true" },
    });
    await until(() => sets(fake).length === 1);
    // Filled where the gateway held nothing; where it held a choice, the gateway's stays.
    expect(parseChoices(fake.store[CHOICES_PREF_KEY])).toEqual({
      on: { otherTools: false, channelChats: true },
      rev: 2,
    });
    // The interface's own (Show commands) fills too; held choices are never filled again.
    await b.client.mergeChoices({ commands: true, channelChats: false }, { stamp: b.stamp() });
    expect(parseChoices(fake.store[CHOICES_PREF_KEY]).on).toEqual({
      otherTools: false,
      channelChats: true,
      commands: true,
    });
    const writes = sets(fake).length;
    await b.client.mergeChoices({ commands: true }, { stamp: b.stamp() });
    b.client.stop();
    const again = await device(fake, { own: { "show-channel-chats": "true" } });
    expect(sets(fake)).toHaveLength(writes);
    again.client.stop();
  });

  it("F-601: the first time, a device's own arrangement is merged into the gateway's by the stated rule", async () => {
    const gatewayHeld = parseSidebar({
      pins: ["main"],
      hidden: ["pip"],
      sections: [{ name: "Work", bots: ["otto"] }],
      order: ["otto", "main"],
      rev: 4,
    });
    const own = parseSidebar({
      pins: ["marlow", "pip", "main"],
      hidden: ["juno", "main"],
      sections: [
        { name: "Work", bots: ["otto", "marlow"] },
        { name: "Home", bots: ["juno"] },
      ],
      order: ["juno", "otto"],
    });
    expect(mergeSidebars(gatewayHeld, own)).toEqual({
      // The gateway's pins first; a bot hidden on the gateway isn't pinned from the device.
      pins: ["main", "marlow"],
      // A union, except a bot the gateway pins.
      hidden: ["pip", "juno"],
      sections: [
        { name: "Work", bots: ["otto", "marlow"] },
        { name: "Home", bots: ["juno"] },
      ],
      order: ["otto", "main", "juno"],
      rev: 4,
    });
    const fake = prefsGateway();
    fake.store[SIDEBAR_PREF_KEY] = gatewayHeld;
    const b = await device(fake);
    await until(() => b.client.state.sidebar?.status === "ok");
    expect(await b.client.mergeSidebar(own, { stamp: b.stamp() })).toBe(true);
    expect(parseSidebar(fake.store[SIDEBAR_PREF_KEY]).pins).toEqual(["main", "marlow"]);
    expect(parseSidebar(fake.store[SIDEBAR_PREF_KEY]).rev).toBe(5);
    // Nothing added: nothing written.
    const writes = sets(fake).length;
    expect(await b.client.mergeSidebar(own, { stamp: b.stamp() })).toBe(true);
    expect(sets(fake)).toHaveLength(writes);
    b.client.stop();
  });

  it("F-601: a read-only device reads and never writes, and asks for no access", async () => {
    for (const options of [{ readOnly: true }, { held: READ_SCOPES }]) {
      const fake = prefsGateway();
      fake.store[CHOICES_PREF_KEY] = { on: { channelChats: true }, rev: 1 };
      const b = await device(fake, { ...options, own: { "show-gateway-bot": "true" } });
      expect(b.client.state.showChannelChats).toBe(true);
      // On here only; never sent, and the first-time merge isn't made.
      await b.client.setShowOtherToolSessions(true, { stamp: b.stamp() });
      expect(b.client.state.showOtherToolSessions).toBe(true);
      await expect(b.client.setShowChannelChats(false, { stamp: b.stamp() })).rejects.toThrow(
        CHOICE_READ_ONLY,
      );
      await b.client.mergeChoices({ commands: true }, { stamp: b.stamp() });
      expect(
        await b.client.mergeSidebar(parseSidebar({ pins: ["main"] }), { stamp: b.stamp() }),
      ).toBe(false);
      expect(sets(fake)).toEqual([]);
      expect(fake.gateway.calls("device.scopes.requestUpgrade")).toEqual([]);
      b.client.stop();
    }
  });

  it("F-601: a gateway that keeps no user for the connection (roles set): each device keeps its own, with no error", async () => {
    const fake = prefsGateway();
    fake.durable = false;
    const b = await device(fake, { own: { "show-channel-chats": "true" } });
    expect(b.client.state.choices?.status).toBe("unavailable");
    expect(b.client.state.showChannelChats).toBe(true);
    await b.client.setShowGatewayBot(true, { stamp: b.stamp() });
    expect(b.client.state.showGatewayBot).toBe(true);
    expect(await b.client.changeChoices({ commands: true }, { stamp: b.stamp() })).toBe("device");
    expect(sets(fake)).toEqual([]);
    b.client.stop();
  });

  it("F-601: a switch of gateway: one gateway's choices never show on another, and a change stamped on one never reaches the other", async () => {
    const one = prefsGateway("gateway-a");
    const two = prefsGateway("gateway-b");
    one.store[CHOICES_PREF_KEY] = { on: { channelChats: true, gatewayBot: true }, rev: 1 };
    const held = INTERACTIVE_SCOPES;
    const record = JSON.stringify({ token: "device-token", grantedScopes: held, heldScopes: held });
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: record,
      [tokenKey(URL_B)]: record,
    });
    const host = {
      ...testHost(one.gateway, storage),
      createWebSocket: (url: string) => (url === URL_B ? two : one).gateway.createWebSocket(url),
    };
    const client = new ClawtrateClient(host, FAST);
    await client.start();
    await until(
      () => client.state.showChannelChats === true && client.state.connection.gatewayId !== null,
    );
    const stamp = gatewayStamp(client.state.connection);
    // The other gateway's read waits: until it answers, this device's own choices show.
    const read = deferred<void>();
    const get = two.gateway.handlers["users.prefs.get"]!;
    two.gateway.handlers["users.prefs.get"] = async (params) => {
      await read.promise;
      return get(params);
    };
    await client.connect({ url: URL_B });
    await until(() => client.state.connection.gatewayId === "gateway-b");
    expect(client.state.choices?.status).toBe("unknown");
    expect(client.state.showChannelChats).toBe(false);
    expect(client.state.showGatewayBot).toBe(false);
    read.resolve();
    await until(() => client.state.choices?.status === "ok");
    expect(client.state.showChannelChats).toBe(false);
    await expect(client.changeChoices({ commands: true }, { stamp })).rejects.toThrow(
      CONNECTION_CHANGED,
    );
    expect(sets(two)).toEqual([]);
    expect(sets(one)).toEqual([]);
    client.stop();
  });

  it("F-601: a device's pin of a bot the gateway places in a section isn't merged; a revision readers would drop is never written; a change read on another target keeps nothing", async () => {
    const merged = mergeSidebars(
      parseSidebar({ sections: [{ name: "Work", bots: ["otto"] }] }),
      parseSidebar({ pins: ["otto", "pip"] }),
    );
    expect(merged.pins).toEqual(["pip"]);
    expect(merged.sections).toEqual([{ name: "Work", bots: ["otto"] }]);
    const ctx = (rev: number) => ({
      request: async (method: string) =>
        method === "users.prefs.get"
          ? { status: "ok", entries: { [CHOICES_PREF_KEY]: { on: {}, rev } } }
          : { status: "ok" },
    });
    await expect(
      writeChoices(ctx(Number.MAX_SAFE_INTEGER), { commands: true }, "set"),
    ).rejects.toThrow("can't be changed");
    await expect(writeChoices(ctx(7), { commands: true }, "set")).resolves.toMatchObject({
      prefs: { rev: 8 },
    });
    const fake = prefsGateway();
    fake.durable = false;
    const b = await device(fake);
    const stale = { ...b.stamp(), target: b.stamp().target + 1 };
    await expect(b.client.setShowChannelChats(true, { stamp: stale })).rejects.toThrow(
      CONNECTION_CHANGED,
    );
    expect(b.client.state.showChannelChats).toBe(false);
    expect(b.storage.data.has("show-channel-chats")).toBe(false);
    b.client.stop();
  });

  it("F-601: the bounds: only known choices, each a boolean; the state keeps them within its bound", async () => {
    expect(
      parseChoices({
        on: { commands: true, thinking: "yes", hideEverything: true },
        rev: -2,
        more: "x",
      }),
    ).toEqual({ on: { commands: true } });
    expect(parseChoices("not choices")).toEqual({ on: {} });
    expect(() =>
      parseBridgeCommand({
        type: "changeChoices",
        change: { admin: true },
        stamp: { gatewayId: "g", target: 1 },
      }),
    ).toThrow("invalid choice");
    expect(() =>
      parseBridgeCommand({
        type: "changeChoices",
        change: {},
        stamp: { gatewayId: "g", target: 1 },
      }),
    ).toThrow("invalid choice");
    expect(() =>
      parseBridgeCommand({
        type: "changeChoices",
        change: { commands: 1 },
        stamp: { gatewayId: "g", target: 1 },
      }),
    ).toThrow("invalid choice");
    const kept = enforceState({
      ...initialState,
      choices: {
        status: "ok",
        prefs: { on: { commands: true, extra: "x".repeat(10_000) } as never, rev: 1 },
      },
    });
    expect(JSON.stringify(kept.choices).length).toBeLessThan(200);
    // A merge that would pass the gateway's 4,096 bytes leaves the gateway's as it is.
    const fake = prefsGateway();
    const b = await device(fake);
    const long = (n: number) => `${"s".repeat(60)}${n}`;
    const own = parseSidebar({
      sections: Array.from({ length: 16 }, (_, n) => ({
        name: long(n),
        bots: Array.from({ length: 2 }, (_, m) => `bot-${"x".repeat(100)}-${n}-${m}`),
      })),
    });
    const before = sets(fake).length;
    expect(await b.client.mergeSidebar(own, { stamp: b.stamp() })).toBe(true);
    expect(sets(fake)).toHaveLength(before);
    // The engine's write of choices is bounded too.
    await expect(
      writeChoices(
        { request: async () => ({ status: "no_durable_identity" }) },
        { commands: true },
        "set",
      ),
    ).rejects.toThrow("keeps no preferences");
    b.client.stop();
  });

  it("F-601: the bridge carries a change with its stamp, and a viewer's stamp from another gateway is refused", async () => {
    const fake = prefsGateway();
    const a = await device(fake);
    const viewer = createBridgeSession(a.client);
    await expect(
      viewer.apply({ type: "changeChoices", change: { thinking: true }, stamp: a.stamp() }),
    ).resolves.toEqual({ kept: "gateway" });
    expect(parseChoices(fake.store[CHOICES_PREF_KEY]).on.thinking).toBe(true);
    await expect(
      viewer.apply({
        type: "changeChoices",
        change: { thinking: false },
        stamp: { gatewayId: "gateway-z", target: a.stamp().target },
      }),
    ).rejects.toThrow();
    expect(parseChoices(fake.store[CHOICES_PREF_KEY]).on.thinking).toBe(true);
    a.client.stop();
  });
});
