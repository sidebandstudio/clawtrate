import { describe, expect, it } from "vitest";
import {
  applySidebarChange,
  changeSidebar,
  MAX_SIDEBAR_BOTS,
  MAX_SECTION_NAME_CHARS,
  MAX_SIDEBAR_BYTES,
  MAX_SIDEBAR_SECTIONS,
  parseSidebar,
  sidebarBytes,
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

  it("F-014 F-016: a change that would take the arrangement past the gateway's 4,096 bytes is refused in plain words, and nothing is written", async () => {
    // Long but legal ids: 31 of them pinned leave the arrangement just under the gateway's limit.
    const pins = Array.from({ length: 31 }, (_, index) => `p${index}`.padEnd(125, "x"));
    const sections: Array<{ name: string; bots: string[] }> = [];
    const store = prefsStore({ pins, sections, hidden: [], order: [] });
    expect(sidebarBytes(parseSidebar(store.value()))).toBeLessThanOrEqual(MAX_SIDEBAR_BYTES);
    await expect(
      changeSidebar(
        store.ctx,
        { op: "section", botId: "extra", section: "é".repeat(MAX_SECTION_NAME_CHARS) },
        null,
      ),
    ).rejects.toThrow("The gateway keeps at most 4,096 bytes of arrangement");
    expect(store.calls.filter((call) => call.method === "users.prefs.set")).toHaveLength(0);
  });

  it("F-014: pinning past the cap is refused in plain words rather than dropped", () => {
    const pins = Array.from({ length: MAX_SIDEBAR_BOTS }, (_, index) => `b${index}`);
    expect(() =>
      applySidebarChange(parseSidebar({ pins }), { op: "pin", botId: "one-more", pinned: true }),
    ).toThrow(`At most ${MAX_SIDEBAR_BOTS} bots can be pinned.`);
  });

  it("F-014: a move keeps every other bot where the gateway holds it, so another device's move made meanwhile survives", async () => {
    // Another device moves Cato to the front between our read and our write.
    let value: unknown = {
      pins: [],
      sections: [],
      hidden: [],
      order: ["atlas", "bree", "cato", "dax"],
    };
    let meddled = false;
    const calls: string[] = [];
    const ctx: SidebarContext = {
      request: async (method, raw) => {
        calls.push(method);
        const params = raw as Record<string, Record<string, unknown>>;
        if (method === "users.prefs.get")
          return { status: "ok", entries: { [SIDEBAR_PREF_KEY]: value } };
        if (!meddled) {
          meddled = true;
          value = { pins: [], sections: [], hidden: [], order: ["cato", "atlas", "bree", "dax"] };
          return { status: "conflict" };
        }
        value = params.entries![SIDEBAR_PREF_KEY];
        return { status: "ok" };
      },
      ensureWrite: async () => {},
    };
    // This device moves Dax before Atlas.
    const state = await changeSidebar(
      ctx,
      { op: "move", botId: "dax", before: "atlas", shown: ["atlas", "bree", "cato", "dax"] },
      null,
    );
    expect(state.prefs?.order).toEqual(["cato", "dax", "atlas", "bree"]);
    expect(calls.filter((method) => method === "users.prefs.set")).toHaveLength(2);
  });

  it("F-014: a move places the bots the stored order does not name yet in the order shown", () => {
    const moved = applySidebarChange(parseSidebar({ order: ["bree"] }), {
      op: "move",
      botId: "atlas",
      before: null,
      shown: ["bree", "cato", "atlas"],
    });
    expect(moved.order).toEqual(["bree", "cato", "atlas"]);
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
