import type { Bot, Task } from "@clawtrate/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  arrange,
  moveInOrder,
  readRoster,
  rosterKey,
  rosterScope,
  type RosterPrefs,
} from "../src/roster.ts";

const bot = (id: string, name: string, isDefault = false): Bot => ({
  id,
  name,
  emoji: null,
  avatarUrl: null,
  theme: null,
  model: null,
  isDefault,
});

const at = (botId: string, updatedAt: number | null): Task => ({
  key: `agent:${botId}:${updatedAt}`,
  botId,
  sessionId: null,
  title: "t",
  preview: null,
  updatedAt,
  status: "done",
  unread: false,
});

// The gateway's order: its default bot first.
const BOTS = [
  bot("main", "juniper", true),
  bot("marlow", "Marlow"),
  bot("otto", "Otto"),
  bot("pip", "Pip"),
];
const TASKS = {
  main: [at("main", 30)],
  marlow: [at("marlow", 50)],
  otto: [at("otto", 10), at("otto", 90)],
};
const prefs = (change: Partial<RosterPrefs>): RosterPrefs => ({
  pinned: [],
  hidden: [],
  sort: "recent",
  manual: [],
  sections: [],
  ...change,
});
const names = (list: Bot[]) => list.map((b) => b.name);

describe("F-031 F-266: the rail's order", () => {
  it("F-031: sorts by recent activity by default, a bot with no tasks last", () => {
    expect(names(arrange(BOTS, TASKS, prefs({})).list)).toEqual([
      "Otto",
      "Marlow",
      "juniper",
      "Pip",
    ]);
  });

  it("F-031: sorts by name ignoring case, and keeps pinned bots first in their own order", () => {
    const arranged = arrange(BOTS, TASKS, prefs({ sort: "name", pinned: ["pip", "otto"] }));
    expect(names(arranged.pinned)).toEqual(["Pip", "Otto"]);
    expect(names(arranged.list)).toEqual(["juniper", "Marlow"]);
  });

  it("F-266: the manual order holds, and bots it does not know follow in the gateway's order", () => {
    const arranged = arrange(BOTS, TASKS, prefs({ sort: "manual", manual: ["pip", "otto"] }));
    expect(names(arranged.list)).toEqual(["Pip", "Otto", "juniper", "Marlow"]);
    expect(moveInOrder(["pip", "otto", "main", "marlow"], "marlow", 1)).toEqual([
      "pip",
      "marlow",
      "otto",
      "main",
    ]);
    expect(moveInOrder(["a", "b", "c"], "a", 9)).toEqual(["b", "c", "a"]);
    expect(moveInOrder(["a", "b", "c"], "c", -1)).toEqual(["c", "a", "b"]);
  });

  it("F-027: hidden bots leave the list and the pins, and are kept apart", () => {
    const arranged = arrange(BOTS, TASKS, prefs({ pinned: ["otto"], hidden: ["otto", "pip"] }));
    expect(names(arranged.pinned)).toEqual([]);
    expect(names(arranged.list)).toEqual(["Marlow", "juniper"]);
    expect(names(arranged.hidden)).toEqual(["Otto", "Pip"]);
  });
});

describe("each gateway's arrangement", () => {
  const data = new Map<string, string>();
  beforeEach(() => {
    data.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
      removeItem: (key: string) => data.delete(key),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const saved = (prefs: Partial<RosterPrefs>) =>
    JSON.stringify({ pinned: [], hidden: [], sort: "recent", manual: [], ...prefs });

  it("F-013 F-027 F-266: is kept under the gateway's identity, else its address, and one gateway's never applies to another", () => {
    expect(rosterScope({ gatewayId: "a1", gatewayUrl: "ws://127.0.0.1:18789" })).toBe("gateway:a1");
    expect(rosterScope({ gatewayId: null, gatewayUrl: "ws://127.0.0.1:18789" })).toBe(
      "address:ws://127.0.0.1:18789",
    );
    expect(rosterScope({ gatewayId: null, gatewayUrl: null })).toBe(null);
    data.set(`clawtrate.${rosterKey("gateway:a1")}`, saved({ pinned: ["main"], hidden: ["otto"] }));
    expect(readRoster("gateway:a1")).toMatchObject({ pinned: ["main"], hidden: ["otto"] });
    // Another gateway with the same bot ids starts with nothing pinned or hidden.
    expect(readRoster("gateway:b2")).toMatchObject({ pinned: [], hidden: [] });
    // The same gateway at another address is the same gateway.
    expect(readRoster("gateway:a1", "address:ws://127.0.0.1:28789")).toMatchObject({
      pinned: ["main"],
    });
    expect(readRoster(null)).toMatchObject({ pinned: [], hidden: [], sort: "recent" });
  });

  it("F-013 F-027 F-266: a gateway opened for the first time starts with no pins, nothing hidden and the default order, even when old state that names no gateway exists", () => {
    const before = saved({ pinned: ["otto"], hidden: ["marlow"], sort: "manual", manual: ["pip"] });
    data.set("clawtrate.roster", before);
    expect(readRoster("gateway:a1")).toEqual({
      pinned: [],
      hidden: [],
      sort: "recent",
      manual: [],
      sections: [],
    });
    expect(readRoster("gateway:a1", "address:ws://127.0.0.1:18789")).toEqual({
      pinned: [],
      hidden: [],
      sort: "recent",
      manual: [],
      sections: [],
    });
    expect(readRoster("address:ws://127.0.0.1:18789")).toMatchObject({ pinned: [], hidden: [] });
    // The old state is not read into any gateway, and is left where it is.
    expect(data.get("clawtrate.roster")).toBe(before);
    expect([...data.keys()]).toEqual(["clawtrate.roster"]);
  });

  it("F-013 F-027 F-266: an arrangement kept under the address moves to the identity once the gateway gives one", () => {
    const byAddress = saved({ pinned: ["pip"] });
    data.set(`clawtrate.${rosterKey("address:ws://127.0.0.1:18789")}`, byAddress);
    data.set("clawtrate.roster", saved({ pinned: ["otto"] }));
    expect(readRoster("gateway:a1", "address:ws://127.0.0.1:18789")).toMatchObject({
      pinned: ["pip"],
    });
    expect(data.has(`clawtrate.${rosterKey("address:ws://127.0.0.1:18789")}`)).toBe(false);
  });
});
