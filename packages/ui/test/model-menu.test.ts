// The Model menu (docs/design/bots.md, section 9): the gateway's picker, then
// the provider's full list behind "View more", held by the screen that read it,
// and the chosen model always has one checked row, whatever has arrived.

import {
  initialAccountsState,
  initialConnectionState,
  type AccountsState,
  type CatalogModel,
  type ConnectionState,
  type ModelRefresh,
  type OpenClawUpdate,
} from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { allowlistLine, heldKey, modelMenu, refreshWords } from "../src/bots/ModelPair.tsx";

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
  });

  it("F-588: nothing new says why: asked again, the gateway's config, or a list that comes with OpenClaw", () => {
    expect(refreshWords(done({ outcome: "ready" }), "OpenAI", update)).toBe(
      "Nothing new. The gateway asked OpenAI again, and its list is the same.",
    );
    expect(refreshWords(done({ configured: true }), "Acme", update)).toBe(
      "Nothing new. Acme's models are the ones the gateway's config lists.",
    );
    expect(refreshWords(done(), "OpenAI", null)).toBe(
      "Nothing new. The gateway didn't ask OpenAI again, so its list is the one it had. Lists that come with OpenClaw get newer models from a newer OpenClaw.",
    );
    // With the gateway's report of a newer OpenClaw: its version, and the note under the menu.
    expect(refreshWords(done(), "OpenAI", update)).toBe(
      "Nothing new. The gateway didn't ask OpenAI again, so its list is the one it had. Lists that come with OpenClaw get newer models from a newer OpenClaw. OpenClaw 2026.11.6 is out: see the note below.",
    );
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
      "Nothing new. The gateway's refresh failed. Try Refresh again.",
    );
    expect(
      refreshWords(
        { status: "error", error: "The gateway didn't answer in time." },
        "OpenAI",
        null,
      ),
    ).toBe("Couldn't refresh: The gateway didn't answer in time.");
  });

  it("F-588: says when the gateway's config limits a provider's models, and only then", () => {
    const limited = (whole: string[] | null) =>
      allowlistLine(
        { ...initialAccountsState, modelAllowlist: whole === null ? null : { whole } },
        "openai",
      );
    expect(limited(null)).toBeNull();
    expect(limited(["openai"])).toBeNull();
    expect(limited(["anthropic"])).toBe(
      "The gateway's config names which of OpenAI's models bots can use, and lists only those.",
    );
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
