// The sentence under a line's choices in "What <bot> may do" (controls.md
// sections 4 and 5): it says only what the reads establish, and names whose
// list or which listing a fact comes from.
import { describe, expect, it } from "vitest";
import type { BotPermissions, PermissionLine } from "@clawtrate/core";
import { sentence } from "../src/bots/Permissions.tsx";

// Local time, so the words are the same in any time zone.
const READ_AT = new Date(2026, 10, 20, 17, 39).getTime();

const view = (over: Partial<BotPermissions> = {}) =>
  ({
    readAt: READ_AT,
    settingsApplied: "yes",
    enforcement: "read",
    plugin: { kind: "unavailable" },
    ...over,
  }) as BotPermissions;

const line = (over: Partial<PermissionLine>): PermissionLine => ({
  id: "files",
  kind: "group",
  words: "Change files",
  tools: ["write", "edit", "apply_patch"],
  value: "allowed",
  mark: null,
  exceptions: [],
  choice: "allow",
  ownAsk: false,
  undoAsk: false,
  exec: null,
  offered: "yes",
  ...over,
});

describe("the sentence under a line's choices", () => {
  it("a line not offered says whose allow list leaves it out, or the latest task's listing", () => {
    expect(
      sentence(line({ value: "not-offered", mark: "set", choice: null }), view(), "Otto"),
    ).toBe(
      "The gateway's settings for every bot don't offer this to Otto. Set on the gateway; Clawtrate can't change it.",
    );
    expect(
      sentence(line({ value: "not-offered", mark: "gateway", choice: null }), view(), "Otto"),
    ).toBe(
      "Otto's own allow list in the gateway's settings leaves this out. This page doesn't change allow lists.",
    );
    expect(sentence(line({ value: "not-offered", offered: "no" }), view(), "Otto")).toBe(
      "The settings Clawtrate reads leave this open, and the gateway didn't list it in Otto's latest task's tools at 5:39 PM. Something this page doesn't read may remove it.",
    );
  });

  it("a deny of the bot's own on some of a line's tools names them, and promises nothing for the rest", () => {
    const partial = line({
      value: "limited",
      mark: "gateway",
      choice: null,
      exceptions: [{ kind: "bot-deny", tools: ["edit"] }],
    });
    expect(sentence(partial, view(), "Juniper")).toBe(
      "Juniper's own settings deny only some of these tools: edit. The gateway still offers the rest unless something else removes them. Never denies them all; Allow takes Juniper's deny off.",
    );
  });

  it("settings the gateway stored and reports it isn't using are said as stored, never in force", () => {
    const never = line({ value: "never", mark: "gateway", choice: "never" });
    expect(sentence(never, view(), "Otto")).toMatch(/^Otto can't change files\./);
    expect(sentence(never, view({ settingsApplied: "no" }), "Otto")).toBe(
      "Otto's stored settings say Never. The gateway reports it isn't using its stored settings yet, so this may not be in force.",
    );
  });
});
