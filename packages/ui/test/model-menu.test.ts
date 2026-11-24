// The Model menu (docs/design/bots.md, section 9): the gateway's picker, then
// the provider's full list behind "View more", held by the screen that read it,
// and the chosen model always has one checked row, whatever has arrived.

import { initialAccountsState, type AccountsState, type CatalogModel } from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { modelMenu } from "../src/bots/ModelPair.tsx";

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
