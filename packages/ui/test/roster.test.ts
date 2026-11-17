import type { Bot, Task } from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { arrange, moveInOrder, type RosterPrefs } from "../src/roster.ts";

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
