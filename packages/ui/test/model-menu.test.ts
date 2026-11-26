// The Model menu (docs/design/bots.md, section 9): the gateway's picker, then
// the provider's full list behind "View more", held by the screen that read it,
// and the chosen model always has one checked row, whatever has arrived.

import {
  initialAccountsState,
  initialConnectionState,
  initialOpenClawUpdate,
  initialState,
  type AccountsState,
  type CatalogModel,
  type ConnectionState,
  type ModelRefresh,
  type OpenClawUpdate,
  type UpdateRunView,
} from "@clawtrate/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Menu } from "../src/Menu.tsx";
import {
  allowlistLine,
  heldKey,
  modelMenu,
  noteBelow,
  refreshLines,
  refreshSentences,
  refreshWords,
  wildcardLimits,
} from "../src/bots/ModelPair.tsx";

const model = (id: string, available = true): CatalogModel => ({
  provider: "openai",
  id,
  name: null,
  available,
  levels: [],
  defaultLevel: null,
});

const PICKER = [model("gpt-5.5"), model("gpt-5.5-codex", false)];
const FULL = [
  model("gpt-5.5"),
  model("gpt-5.4"),
  model("gpt-5.5-codex", false),
  model("gpt-5.5-pro", false),
];

const state = (picker: CatalogModel[]): AccountsState => ({
  ...initialAccountsState,
  models: picker,
});

/** How many rows the menu shows for the chosen model: the pinned one, the picker's, the held list's. */
function rowsFor(picker: CatalogModel[], held: CatalogModel[] | null, chosen: string) {
  const menu = modelMenu(state(picker), "openai", chosen, held);
  return [
    ...(menu.pinned ? [menu.pinned] : []),
    ...menu.picker.map((m) => m.id),
    ...menu.more.map((m) => m.id),
  ].filter((id) => id === chosen).length;
}

describe("the Model menu", () => {
  it("F-478: the chosen model has exactly one row whatever has arrived, in any order", () => {
    // gpt-5.4 is one only the full list has; gpt-5.5 both have; gpt-9 neither.
    const states: Array<[string, CatalogModel[], CatalogModel[] | null]> = [
      ["nothing yet", [], null],
      ["the picker alone", PICKER, null],
      ["the full list alone", [], FULL],
      ["both", PICKER, FULL],
      ["the full list dropped (closed, another provider, another gateway)", PICKER, null],
    ];
    for (const [when, picker, held] of states)
      for (const chosen of ["gpt-5.5", "gpt-5.4", "gpt-9"])
        expect(rowsFor(picker, held, chosen), `${when}, ${chosen}`).toBe(1);
  });

  it("F-478: \"View more\" lists only the full list's models the picker lacks, in the gateway's order", () => {
    const menu = modelMenu(state(PICKER), "openai", "gpt-5.5", FULL);
    expect(menu.more.map((m) => m.id)).toEqual(["gpt-5.4", "gpt-5.5-pro"]);
  });

  it("F-478: a model neither list has is pinned first, and the held list's row takes its place", () => {
    const before = modelMenu(state(PICKER), "openai", "gpt-5.4", null);
    expect([before.pinned, before.row]).toEqual(["gpt-5.4", undefined]);
    const after = modelMenu(state(PICKER), "openai", "gpt-5.4", FULL);
    expect([after.pinned, after.row?.id]).toEqual([null, "gpt-5.4"]);
  });
});

describe("F-588: Refresh in the Model menu", () => {
  const done = (change: Partial<Extract<ModelRefresh, { status: "done" }>> = {}): ModelRefresh => ({
    status: "done",
    provider: "openai",
    added: [],
    addedCount: 0,
    removed: [],
    removedCount: 0,
    outcome: null,
    configured: false,
    hostedList: true,
    counts: null,
    partial: false,
    failed: false,
    ...change,
  });
  const update: OpenClawUpdate = { current: "2026.10.6", latest: "2026.11.6", channel: "latest" };

  it("F-588: names the new models, the first few and a count, and the ones no longer listed", () => {
    expect(refreshWords(done({ added: ["gpt-6.2-sol"], addedCount: 1 }), "OpenAI", null)).toBe(
      "New: gpt-6.2-sol.",
    );
    expect(
      refreshWords(
        done({ added: ["a", "b", "c", "d", "e"], addedCount: 12, removed: ["z"], removedCount: 1 }),
        "OpenAI",
        update,
      ),
    ).toBe("New: a, b, c, d, e and 7 more. No longer listed: z.");
    // A list cut at its bound: the counts, nothing named new, and only what the gateway dropped.
    expect(
      refreshWords(
        done({ outcome: "ready", counts: { before: 140, now: 141 } }),
        "OpenRouter",
        null,
      ),
    ).toBe("OpenRouter lists 141 models now (140 before).");
    expect(
      refreshWords(
        done({ counts: { before: 140, now: 139 }, removed: ["m-1"], removedCount: 1 }),
        "OpenRouter",
        null,
      ),
    ).toBe("OpenRouter lists 139 models now (140 before). No longer listed: m-1.");
  });

  it("F-588: nothing new says why: asked again, the gateway's config, or a list that comes with OpenClaw", () => {
    expect(refreshWords(done({ outcome: "ready" }), "OpenAI", update)).toBe(
      "Nothing new. The gateway asked OpenAI again, and its list is the same.",
    );
    expect(refreshWords(done({ configured: true }), "Acme", update)).toBe(
      "Nothing new. Acme's models are the ones the gateway's config lists.",
    );
    const notAsked =
      "Nothing new. The gateway didn't ask OpenAI again, so its list is the one it had. Lists that come with OpenClaw get newer models from a newer OpenClaw, and from OpenClaw's model list online, which the gateway checks every 6 hours.";
    const typeIt = "To use a model that isn't listed, choose Use another model and type its id.";
    expect(refreshWords(done(), "OpenAI", null)).toBe(`${notAsked} ${typeIt}`);
    // A gateway whose config turns the online list off gets newer models from a newer OpenClaw only.
    expect(refreshWords(done({ hostedList: false }), "OpenAI", null)).toBe(
      `Nothing new. The gateway didn't ask OpenAI again, so its list is the one it had. Lists that come with OpenClaw get newer models from a newer OpenClaw. ${typeIt}`,
    );
    // With the gateway's report of a newer OpenClaw: its version, and the note under the menu.
    expect(refreshWords(done(), "OpenAI", update)).toBe(
      `${notAsked} OpenClaw 2026.11.6 is out: see the note below. ${typeIt}`,
    );
    // While an update runs, or once it has ended, the note below is its line, not the version's.
    expect(refreshWords(done(), "OpenAI", update, true)).toBe(
      `${notAsked} The note below says where the OpenClaw update stands. ${typeIt}`,
    );
    expect(refreshWords(done(), "OpenAI", null, true)).toBe(
      `${notAsked} The note below says where the OpenClaw update stands. ${typeIt}`,
    );
  });

  it("F-588: a list cut at its bound with as many models as before says only its count, never that it is the same", () => {
    expect(
      refreshWords(
        done({ outcome: "ready", counts: { before: 140, now: 140 } }),
        "OpenRouter",
        null,
      ),
    ).toBe("OpenRouter lists 140 models, as before. The gateway asked OpenRouter again.");
  });

  it("F-588: without the gateway's config nothing is said of its online model list", () => {
    const words = refreshWords(done({ hostedList: null }), "OpenAI", null);
    expect(words).toContain("The gateway didn't ask OpenAI again");
    expect(words).not.toContain("Lists that come with OpenClaw");
  });

  it("F-588: the menu's line is what was found and, when nothing new was, the most specific reason; the rest is one step away", () => {
    const limits =
      "The gateway's config names which of OpenAI's models it lists and lets a task switch to; a bot's own model can still be one it doesn't name.";
    const lines = (change: Partial<ModelRefresh>, list: string | null = null, typed = true) =>
      refreshLines(refreshSentences(done(change), "OpenAI", update, false, typed), list);
    // Found something: the line says it, and the rest is behind "More".
    expect(lines({ added: ["a"], addedCount: 1, outcome: "unavailable" }, limits)).toEqual({
      line: "New: a.",
      more: ["The gateway couldn't get an answer from OpenAI.", limits],
      label: "More",
    });
    expect(lines({ added: ["a"], addedCount: 1 })).toEqual({
      line: "New: a.",
      more: [],
      label: "More",
    });
    // Nothing new: one reason, in the order of preference, the rest behind "Why".
    const notAsked = "The gateway didn't ask OpenAI again, so its list is the one it had.";
    const online =
      "Lists that come with OpenClaw get newer models from a newer OpenClaw, and from OpenClaw's model list online, which the gateway checks every 6 hours.";
    const out = "OpenClaw 2026.11.6 is out: see the note below.";
    const typeIt = "To use a model that isn't listed, choose Use another model and type its id.";
    expect(lines({})).toEqual({
      line: `Nothing new. ${notAsked}`,
      more: [online, out, typeIt],
      label: "Why",
    });
    // The config's list keeps models out: it is the reason, ahead of "not asked again".
    expect(lines({}, limits)).toEqual({
      line: `Nothing new. ${limits}`,
      more: [notAsked, online, out, typeIt],
      label: "Why",
    });
    expect(lines({ outcome: "ready" }, limits).line).toBe(`Nothing new. ${limits}`);
    expect(lines({ outcome: "ready" }).line).toBe(
      "Nothing new. The gateway asked OpenAI again, and its list is the same.",
    );
    expect(lines({ configured: true }).line).toBe(
      "Nothing new. OpenAI's models are the ones the gateway's config lists.",
    );
    // A failure, a refused account or no answer comes before the config's list.
    expect(lines({ failed: true }, limits).line).toBe(
      "Nothing new. The gateway's refresh failed: try Refresh again.",
    );
    expect(lines({ outcome: "auth-rejected" }, limits)).toEqual({
      line: "Nothing new. The gateway couldn't ask OpenAI: OpenAI refused the account.",
      more: [limits],
      label: "Why",
    });
    expect(lines({ outcome: "unavailable", partial: true }, limits)).toEqual({
      line: "Nothing new yet. The gateway couldn't get an answer from OpenAI.",
      more: ["The gateway is still looking for OpenAI's models.", limits],
      label: "Why",
    });
    expect(lines({ partial: true }, limits).line).toBe(
      "Nothing new yet. The gateway is still looking for OpenAI's models.",
    );
    // A refresh the gateway refused: its reason alone, with the config's list behind "More".
    expect(
      refreshLines(
        refreshSentences({ status: "error", error: "Model catalog is not ready." }, "OpenAI", null),
        limits,
      ),
    ).toEqual({
      line: "Couldn't refresh: Model catalog is not ready.",
      more: [limits],
      label: "More",
    });
    // Every sentence is in the line or the panel, once.
    const said = refreshSentences(done(), "OpenAI", update);
    const shown = refreshLines(said, limits);
    expect([shown.line, ...shown.more].join(" ").length).toBe(
      [refreshWords(done(), "OpenAI", update), limits].join(" ").length,
    );
  });

  it("F-588: the line's small item says what it opens, and the panel is plain text in the menu, outside any live region", () => {
    const render = (open: boolean) =>
      renderToStaticMarkup(
        createElement(Menu, {
          label: "Model",
          onClose: () => {},
          entries: [
            { kind: "item", label: "Refresh", note: "Look for new models", onSelect: () => {} },
            {
              kind: "line",
              text: "Nothing new.",
              more: { label: "Why", open, panel: "why-1", onToggle: () => {} },
            },
            ...(open ? [{ kind: "panel" as const, id: "why-1", lines: ["One.", "Two."] }] : []),
          ],
        }),
      );
    const closed = render(false);
    expect(closed).toContain('role="menuitem" aria-expanded="false" aria-controls="why-1"');
    expect(closed).not.toContain("aria-describedby");
    expect(closed).not.toContain("One.");
    const open = render(true);
    expect(open).toContain('aria-expanded="true" aria-controls="why-1" aria-describedby="why-1"');
    expect(open).toContain(
      '<li id="why-1" class="menu-panel" role="none"><p>One.</p><p>Two.</p></li>',
    );
    expect(open).not.toMatch(/aria-live|role="status"|role="alert"/);
  });

  it("F-588: a provider the gateway couldn't ask, with the gateway's reason, and a refresh that failed", () => {
    expect(refreshWords(done({ outcome: "auth-rejected" }), "OpenAI", update)).toBe(
      "Nothing new. The gateway couldn't ask OpenAI: OpenAI refused the account.",
    );
    expect(refreshWords(done({ outcome: "unavailable" }), "OpenAI", update)).toBe(
      "Nothing new. The gateway couldn't get an answer from OpenAI.",
    );
    expect(refreshWords(done({ partial: true }), "OpenAI", update)).toBe(
      "Nothing new yet. The gateway is still looking for OpenAI's models.",
    );
    // A refresh the gateway says failed is said as one, never as still looking.
    expect(refreshWords(done({ failed: true }), "OpenAI", update)).toBe(
      "Nothing new. The gateway's refresh failed: try Refresh again.",
    );
    expect(
      refreshWords(
        { status: "error", error: "The gateway didn't answer in time." },
        "OpenAI",
        null,
      ),
    ).toBe("Couldn't refresh: The gateway didn't answer in time.");
  });

  it("F-588: says what the config's model list limits, only where that is established for the gateway's version", () => {
    const limited = (
      whole: string[] | null,
      version: string | null = "2026.10.6",
      wildcards = false,
      prefixWildcards = wildcards,
    ) =>
      allowlistLine(
        {
          ...initialAccountsState,
          modelAllowlist: whole === null ? null : { whole, wildcards, prefixWildcards },
        },
        "openai",
        version,
      );
    const line =
      "The gateway's config names which of OpenAI's models it lists and lets a task switch to; a bot's own model can still be one it doesn't name.";
    expect(limited(null)).toBeNull();
    expect(limited(["openai"])).toBeNull();
    expect(limited(["anthropic"])).toBe(line);
    expect(limited([], "2026.11.10")).toBe(line);
    // A version where it wasn't established, or none reported: nothing is said.
    expect(limited([], "2026.11.6")).toBeNull();
    expect(limited([], "2027.1.1")).toBeNull();
    expect(limited([], null)).toBeNull();
    // With a wildcard in the list, a bot set to a model it doesn't name runs on one it names.
    const wild =
      "The gateway's config names which of OpenAI's models it lists and lets a task switch to; a bot set to another model runs on one it names.";
    expect(limited(["anthropic"], "2026.10.6", true)).toBe(wild);
    expect(limited([], "2026.11.10", true)).toBe(wild);
    expect(limited(["openai"], "2026.10.6", true)).toBeNull();
    expect(limited([], "2026.11.6", true)).toBeNull();
    // A prefix entry (`openai/gpt-*`) is an exact name to 2026.10.6 and a wildcard to 2026.11.10.
    expect(limited(["anthropic"], "2026.10.6", false, true)).toBe(line);
    expect(limited(["anthropic"], "2026.11.10", false, true)).toBe(wild);
  });

  it("F-588: under a model list with a wildcard that limits the provider, nothing offers a typed model id", () => {
    const typeIt = "To use a model that isn't listed, choose Use another model and type its id.";
    const at = (whole: string[], wildcards: boolean, prefixWildcards = wildcards) => ({
      ...initialAccountsState,
      modelAllowlist: { whole, wildcards, prefixWildcards },
    });
    for (const version of ["2026.10.6", "2026.11.10", "2027.1.1", null]) {
      expect(wildcardLimits(initialAccountsState, "openai", version)).toBe(false);
      expect(wildcardLimits(at([], false), "openai", version)).toBe(false);
      expect(wildcardLimits(at(["anthropic"], true), "openai", version)).toBe(true);
      expect(wildcardLimits(at(["openai"], true), "openai", version)).toBe(false);
    }
    // A prefix entry: an exact name to 2026.10.6, a wildcard to 2026.11.10; on any other version
    // the broader reading leaves the typed id out.
    expect(wildcardLimits(at([], false, true), "openai", "2026.10.6")).toBe(false);
    expect(wildcardLimits(at([], false, true), "openai", "2026.11.10")).toBe(true);
    expect(wildcardLimits(at([], false, true), "openai", "2027.1.1")).toBe(true);
    expect(wildcardLimits(at([], false, true), "openai", null)).toBe(true);
    const nothing: ModelRefresh = {
      status: "done",
      provider: "openai",
      added: [],
      addedCount: 0,
      removed: [],
      removedCount: 0,
      outcome: null,
      configured: false,
      hostedList: true,
      counts: null,
      partial: false,
      failed: false,
    };
    expect(refreshWords(nothing, "OpenAI", null)).toContain(typeIt);
    expect(refreshWords(nothing, "OpenAI", null, false, true)).toContain(typeIt);
    expect(refreshWords(nothing, "OpenAI", null, false, false)).not.toContain(typeIt);
    expect(refreshWords(nothing, "OpenAI", null, false, false)).toContain(
      "The gateway didn't ask OpenAI again",
    );
  });
  it("F-588: points to the note under the menu only as the pair shows it: the offer, where an update stands, or nothing", () => {
    const offer: OpenClawUpdate = { current: "2026.10.6", latest: "2026.11.6", channel: "latest" };
    const at = (update: OpenClawUpdate | null, looking: boolean) => ({
      ...initialState,
      connection: { ...initialState.connection, gatewayId: "gw-a", openclawUpdate: update },
      openclawUpdating: { ...initialOpenClawUpdate, looking },
    });
    const running = {
      runId: "r1",
      gatewayId: "gw-a",
      mine: true,
      from: "2026.10.6",
      to: "2026.11.6",
      phase: "staging",
      outcome: "running",
    } as UpdateRunView;
    expect(noteBelow(at(offer, false), null, offer)).toMatchObject({ offer: true });
    expect(noteBelow(at(offer, false), running, offer)).toMatchObject({ offer: false });
    expect(noteBelow(at(offer, true), null, offer)).toMatchObject({ offer: false });
    expect(noteBelow(at(null, false), null, null)).toBeNull();
    // A hold from an earlier Update press, with no run in view and no newer OpenClaw reported:
    // the pair shows no note, so the result points to none.
    expect(noteBelow(at(null, true), null, null)).toBeNull();
  });

  it("F-588: an answer is held for one provider and one connection: another gateway, a reconnect or a hidden pair is another key", () => {
    const connection: ConnectionState = {
      ...initialConnectionState,
      status: "connected",
      gatewayUrl: "ws://127.0.0.1:19001",
      gatewayId: "gateway-a",
      target: 4,
      connectedAt: 1_000,
    };
    const key = heldKey("openai", connection, true);
    expect(heldKey("openai", { ...connection }, true)).toBe(key);
    for (const other of [
      heldKey("anthropic", connection, true),
      heldKey("openai", { ...connection, gatewayId: "gateway-b" }, true),
      heldKey("openai", { ...connection, connectedAt: 2_000 }, true),
      heldKey("openai", { ...connection, target: 5 }, true),
      heldKey("openai", { ...connection, status: "reconnecting" }, true),
    ])
      expect(other).not.toBe(key);
    expect(heldKey("openai", connection, false)).toBe("");
  });
});
