import { describe, expect, it } from "vitest";
import {
  applySidebarChange,
  changeSidebar,
  MAX_SIDEBAR_BOTS,
  MAX_SIDEBAR_SECTIONS,
  parseSidebar,
  readSidebar,
  SIDEBAR_PREF_KEY,
  SIDEBAR_WRITE_ATTEMPTS,
  type SidebarContext,
} from "../src/sidebar.ts";
import { MAX_BOTS } from "../src/state-bounds.ts";

/** A user-preference store that answers like `users.prefs` (compare-and-set). */
function prefsStore(initial: unknown, options: { identity?: boolean; meddle?: number } = {}) {
  let value: unknown = initial;
  let meddle = options.meddle ?? 0;
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let asked = 0;
  const ctx: SidebarContext = {
    request: async (method, raw) => {
      const params = raw as Record<string, unknown>;
      calls.push({ method, params });
      if (options.identity === false) return { status: "no_durable_identity" };
      if (method === "users.prefs.get")
        return { status: "ok", entries: value === undefined ? {} : { [SIDEBAR_PREF_KEY]: value } };
      const expected = (params.expectedEntries as Record<string, unknown>)[SIDEBAR_PREF_KEY];
      if (meddle > 0) {
        // Another device writes between our read and our write.
        meddle -= 1;
        value = { pins: ["otto"], sections: [], hidden: [], order: [], from: "other" };
        return { status: "conflict" };
      }
      if (JSON.stringify(expected ?? null) !== JSON.stringify(value ?? null))
        return { status: "conflict" };
      value = (params.entries as Record<string, unknown>)[SIDEBAR_PREF_KEY];
      return { status: "ok" };
    },
    ensureWrite: async () => {
      asked += 1;
    },
  };
  return { ctx, calls, value: () => value, asked: () => asked };
}

describe("the rail's arrangement on the gateway", () => {
  it("bounds every list to the state's own bot count", () => {
    expect(MAX_SIDEBAR_BOTS).toBe(MAX_BOTS);
  });

  it("F-014 F-016: reads what the gateway holds as an arrangement, dropping what is not one", () => {
    expect(
      parseSidebar({
        pins: ["atlas", "atlas", 3, "bad id!"],
        sections: [
          { name: "  Work  ", bots: ["pixel", "atlas"] },
          { name: "Work", bots: ["other"] },
          { name: "Home", bots: ["pixel"] },
          { name: "", bots: ["x"] },
          "nope",
        ],
        hidden: ["h"],
        order: ["atlas", "pixel"],
        extra: true,
      }),
    ).toEqual({
      pins: ["atlas"],
      sections: [{ name: "Work", bots: ["pixel", "atlas"] }],
      hidden: ["h"],
      order: ["atlas", "pixel"],
    });
    expect(parseSidebar("nonsense")).toEqual({ pins: [], sections: [], hidden: [], order: [] });
    const many = Array.from({ length: 40 }, (_, index) => `bot${index}`);
    expect(parseSidebar({ pins: many }).pins).toHaveLength(MAX_SIDEBAR_BOTS);
  });

  it("F-014: Pin adds a bot at the end of the pins and Unpin removes it; hiding a bot unpins it", () => {
    const empty = parseSidebar({});
    const pinned = applySidebarChange(
      applySidebarChange(empty, { op: "pin", botId: "a", pinned: true }),
      {
        op: "pin",
        botId: "b",
        pinned: true,
      },
    );
    expect(pinned.pins).toEqual(["a", "b"]);
    expect(applySidebarChange(pinned, { op: "pin", botId: "a", pinned: false }).pins).toEqual([
      "b",
    ]);
    const hidden = applySidebarChange(pinned, { op: "hide", botId: "b", hidden: true });
    expect(hidden).toMatchObject({ pins: ["a"], hidden: ["b"] });
  });

  it("F-016: Move to new section makes it; Move to moves a bot between sections; an emptied section goes", () => {
    let prefs = parseSidebar({});
    prefs = applySidebarChange(prefs, { op: "section", botId: "a", section: "Work" });
    prefs = applySidebarChange(prefs, { op: "section", botId: "b", section: "Work" });
    expect(prefs.sections).toEqual([{ name: "Work", bots: ["a", "b"] }]);
    prefs = applySidebarChange(prefs, { op: "section", botId: "a", section: "Home" });
    expect(prefs.sections).toEqual([
      { name: "Work", bots: ["b"] },
      { name: "Home", bots: ["a"] },
    ]);
    prefs = applySidebarChange(prefs, { op: "section", botId: "b", section: null });
    expect(prefs.sections).toEqual([{ name: "Home", bots: ["a"] }]);
    expect(() => applySidebarChange(prefs, { op: "section", botId: "c", section: "   " })).toThrow(
      "A section needs a name.",
    );
  });

  it(`F-016: refuses a section past ${MAX_SIDEBAR_SECTIONS}`, () => {
    let prefs = parseSidebar({});
    for (let index = 0; index < MAX_SIDEBAR_SECTIONS; index += 1)
      prefs = applySidebarChange(prefs, {
        op: "section",
        botId: `b${index}`,
        section: `S${index}`,
      });
    expect(() =>
      applySidebarChange(prefs, { op: "section", botId: "x", section: "One more" }),
    ).toThrow(`at most ${MAX_SIDEBAR_SECTIONS}`);
  });

  it("F-014: with no arrangement yet, the first change starts from this device's and is written as must-be-absent", async () => {
    const store = prefsStore(undefined);
    const base = { pins: ["otto"], sections: [], hidden: ["marlow"], order: [] };
    const state = await changeSidebar(store.ctx, { op: "pin", botId: "pip", pinned: true }, base);
    expect(store.asked()).toBe(1);
    expect(state).toEqual({
      status: "ok",
      prefs: { pins: ["otto", "pip"], sections: [], hidden: ["marlow"], order: [] },
    });
    const set = store.calls.find((call) => call.method === "users.prefs.set")!;
    expect(set.params.expectedEntries).toEqual({ [SIDEBAR_PREF_KEY]: null });
    expect(store.value()).toEqual(state.prefs);
  });

  it("F-014: a conflict applies the change again to what another device wrote, keeping both", async () => {
    const store = prefsStore({ pins: [], sections: [], hidden: [], order: [] }, { meddle: 1 });
    const state = await changeSidebar(store.ctx, { op: "pin", botId: "pip", pinned: true }, null);
    expect(state.prefs?.pins).toEqual(["otto", "pip"]);
    expect(store.calls.filter((call) => call.method === "users.prefs.set")).toHaveLength(2);
  });

  it("gives up after a bounded number of conflicts", async () => {
    const store = prefsStore({}, { meddle: SIDEBAR_WRITE_ATTEMPTS });
    await expect(
      changeSidebar(store.ctx, { op: "pin", botId: "pip", pinned: true }, null),
    ).rejects.toThrow("kept changing");
  });

  it("a connection with no durable user reads the arrangement as unavailable and cannot change it", async () => {
    const store = prefsStore({}, { identity: false });
    expect(await readSidebar(store.ctx)).toEqual({ status: "unavailable", prefs: null });
    await expect(
      changeSidebar(store.ctx, { op: "pin", botId: "pip", pinned: true }, null),
    ).rejects.toThrow("keeps no preferences");
  });

  it("reads an absent arrangement as none yet", async () => {
    expect(await readSidebar(prefsStore(undefined).ctx)).toEqual({ status: "ok", prefs: null });
  });
});
