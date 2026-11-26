import type { Bot, Task } from "@clawtrate/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, type SidebarPrefs, type SidebarState } from "@clawtrate/core";
import { pressSwitch } from "../src/preferences.ts";
import {
  arrange,
  hiddenWithUnread,
  mirrorOf,
  moveInOrder,
  readRoster,
  rosterKey,
  rosterScope,
  seedWanted,
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

  it("F-601 F-027: a hidden bot that waits on the person shows in the list until it doesn't", () => {
    const waiting = {
      ...at("pip", 5),
      status: "waiting" as const,
      waitingFor: "approval" as const,
    };
    const hidden = prefs({ hidden: ["pip", "otto"] });
    const arranged = arrange(BOTS, { ...TASKS, pip: [waiting] }, hidden);
    expect(names(arranged.list)).toContain("Pip");
    expect(names(arranged.hidden)).toEqual(["Otto"]);
    // Answered, it goes back where the person put it.
    expect(names(arrange(BOTS, { ...TASKS, pip: [at("pip", 5)] }, hidden).hidden)).toEqual([
      "Otto",
      "Pip",
    ]);
  });
});

describe("F-601: the arrangement on the gateway and this device's copy", () => {
  const ok = (prefs: SidebarPrefs | null): SidebarState => ({ status: "ok", prefs });
  const own = prefs({ pinned: ["pip"], hidden: ["otto"] });

  it("F-601: a device's own copy starts the gateway's only while it holds none, once, and only on a writing connection that is up", () => {
    expect(seedWanted(own, ok(null), true, true)).toBe(true);
    // The gateway holds one: never merged into, whatever the copy says.
    expect(seedWanted(own, ok({ pins: [], hidden: [], sections: [], order: [] }), true, true)).toBe(
      false,
    );
    // Once: a device that has met the gateway's (or started it) never starts it again, even after
    // the gateway's preferences are cleared.
    expect(seedWanted({ ...own, merged: true }, ok(null), true, true)).toBe(false);
    // A reinstall or a cleared store has nothing of its own.
    expect(seedWanted(prefs({}), ok(null), true, true)).toBe(false);
    expect(seedWanted(own, ok(null), false, true)).toBe(false);
    expect(seedWanted(own, ok(null), true, false)).toBe(false);
    expect(seedWanted(own, { status: "unavailable", prefs: null }, true, true)).toBe(false);
    expect(seedWanted(own, undefined, true, true)).toBe(false);
  });

  it("F-601: once the gateway holds an arrangement, this device's copy mirrors it: an older copy is dropped, its sort and its own shown bots kept", () => {
    const stale = prefs({
      pinned: ["pip"],
      hidden: ["otto"],
      sort: "name",
      sections: [{ name: "Old", bots: ["marlow"] }],
      shownHere: ["main"],
    });
    expect(
      mirrorOf({ pins: ["main"], hidden: [], sections: [], order: ["otto"], rev: 3 }, stale),
    ).toEqual({
      pinned: ["main"],
      hidden: [],
      sort: "name",
      manual: ["otto"],
      sections: [],
      shownHere: ["main"],
      merged: true,
    });
  });

  it("F-601: the merged mark is kept, read back, and only as a mark", () => {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
      removeItem: (key: string) => data.delete(key),
    });
    try {
      const write = (scope: string, value: unknown) =>
        data.set(`clawtrate.${rosterKey(scope)}`, JSON.stringify(value));
      write("gateway:a1", { ...own, merged: true });
      write("gateway:b2", own);
      write("gateway:c3", { ...own, merged: "yes" });
      expect(readRoster("gateway:a1").merged).toBe(true);
      expect(seedWanted(readRoster("gateway:a1"), ok(null), true, true)).toBe(false);
      // Another gateway's mark is its own: this one still starts its gateway's.
      expect(readRoster("gateway:b2")).not.toHaveProperty("merged");
      expect(seedWanted(readRoster("gateway:b2"), ok(null), true, true)).toBe(true);
      expect(readRoster("gateway:c3")).not.toHaveProperty("merged");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("F-601 F-027: a hidden bot with something to act on is listed; one with something unread is counted on the fold; one shown here is listed", () => {
    const task = (botId: string, change: Partial<Task>): Task => ({ ...at(botId, 5), ...change });
    const hidden = prefs({ hidden: ["pip", "otto", "marlow", "main"] });
    for (const status of ["waiting", "blocked"] as const) {
      const arranged = arrange(BOTS, { ...TASKS, pip: [task("pip", { status })] }, hidden);
      expect(names(arranged.list), status).toContain("Pip");
    }
    for (const status of ["failed", "done-with-failures", "done"] as const) {
      const arranged = arrange(BOTS, { ...TASKS, pip: [task("pip", { status })] }, hidden);
      expect(names(arranged.hidden), status).toContain("Pip");
    }
    // An unread reply, and a failed run's end, on hidden bots: counted on the fold.
    const tasks = {
      pip: [task("pip", { unread: true })],
      otto: [task("otto", { status: "failed", unread: true })],
      marlow: [task("marlow", { unread: true })],
    };
    const arranged = arrange(BOTS, tasks, hidden);
    expect(hiddenWithUnread(arranged.hidden, tasks, {})).toBe(3);
    // Read here already: not counted.
    expect(hiddenWithUnread(arranged.hidden, tasks, { [tasks.marlow[0]!.key]: 5 })).toBe(2);
    // Shown on this device although the gateway hides it.
    expect(names(arrange(BOTS, TASKS, { ...hidden, shownHere: ["pip"] }).list)).toContain("Pip");
  });
});

describe("F-601: a press of a conversation switch", () => {
  it("F-601: is kept on this device first, so a gateway that refuses it can't stop an on, and a refused off is said", async () => {
    const kept: boolean[] = [];
    const state = { ...initialState, choices: { status: "ok" as const, prefs: null } };
    const refusing = {
      getState: () => state,
      invoke: () => Promise.reject(new Error("refused")),
    } as unknown as Parameters<typeof pressSwitch>[3];
    await expect(pressSwitch("commands", false, (on) => kept.push(on), refusing)).rejects.toThrow(
      "refused",
    );
    await pressSwitch("thinking", true, (on) => kept.push(on), null);
    expect(kept).toEqual([false, true]);
    // Kept before the gateway is asked, so an "on" shows whatever it answers.
    let order: string[] = [];
    const watching = {
      getState: () => state,
      invoke: () => {
        order.push("sent");
        return Promise.resolve({ kept: "device" });
      },
    } as unknown as Parameters<typeof pressSwitch>[3];
    await pressSwitch("commands", true, () => order.push("kept"), watching);
    expect(order).toEqual(["kept", "sent"]);
    // Where the gateway keeps no choices for this connection, nothing is sent.
    order = [];
    const none = {
      ...watching,
      getState: () => ({ ...state, choices: { status: "unavailable" as const, prefs: null } }),
    } as unknown as Parameters<typeof pressSwitch>[3];
    await pressSwitch("commands", true, () => order.push("kept"), none);
    expect(order).toEqual(["kept"]);
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
