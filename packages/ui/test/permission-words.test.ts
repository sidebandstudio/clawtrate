// The sentence under a line's choices in "What <bot> may do" (controls.md
// sections 4 and 5): it says only what the reads establish, and names whose
// list or which listing a fact comes from.
import { describe, expect, it } from "vitest";
import type { BotPermissions, PermissionLine } from "@clawtrate/core";
import {
  countWords,
  holdsWords,
  saveNote,
  sentence,
  STORED_WORDS,
} from "../src/bots/Permissions.tsx";

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
  heldBy: [],
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
      "Juniper's own settings deny only some of these tools: edit. Never denies them all; Allow takes Juniper's deny off them.",
    );
    // Held by a broader entry: the entry is named, and Allow is promised nothing.
    const held = line({
      value: "limited",
      mark: "gateway",
      choice: null,
      heldBy: ["group:fs"],
      exceptions: [{ kind: "bot-deny", tools: ["edit", "write"], entries: ["group:fs"] }],
    });
    expect(sentence(held, view(), "Juniper")).toBe(
      "Juniper's own settings deny only some of these tools: edit and write (group:fs). Never denies them all.",
    );
  });

  it("settings the gateway stored and reports it isn't using are said as stored, never in force", () => {
    const never = line({ value: "never", mark: "gateway", choice: "never" });
    expect(sentence(never, view(), "Otto")).toMatch(/^Otto can't change files\./);
    expect(sentence(never, view({ settingsApplied: "no" }), "Otto")).toBe(
      "Otto's stored settings say Never. The gateway reports it isn't using its stored settings yet, so this may not be in force.",
    );
  });

  it("the overview does not claim runtime command access from the configured mode", () => {
    const exec = line({
      id: "exec",
      kind: "exec",
      words: "Run commands",
      tools: ["exec", "process"],
      value: "never",
      mark: "set",
      choice: "deny",
      exec: { own: null, every: "deny", applies: "deny" },
    });
    const gateway = line({
      id: "gateway",
      words: "Change the gateway's settings",
      tools: ["gateway", "plugins"],
      value: "never",
      mark: "set",
    });
    const read = line({ id: "read", words: "Read files", tools: ["read", "ls"] });
    const v = view({ lines: [exec, gateway, read], fallback: { bot: false, every: false } });
    const words = holdsWords(v, "Otto").map((each) => each.text);
    expect(words.join(" ")).not.toMatch(/can't run commands|can run commands/);
    expect(words).toContain(
      "Command access depends on the task and machine. Commands run on the gateway's machine outside a sandbox can change its files.",
    );
    expect(words[0]).toBe(
      "Configured for Otto: gateway and plugins, the tools that change the gateway and its plugins and so its rules: denied in the gateway's settings.",
    );
    // Run commands is out of the verdicts' counts.
    expect(countWords(v)).toBe("1 never · 0 ask first · 1 without asking");
  });

  it("fallback Ask and cached rules never appear as an unconditional Allow or Ask", () => {
    const cached = line({
      id: "read",
      words: "Read files",
      tools: ["read", "ls"],
      value: "unknown",
      mark: "unread",
      choice: "ask",
      ownAsk: true,
    });
    expect(sentence(cached, view({ enforcement: "unread" }), "Otto")).toBe(
      "Clawtrate could not confirm which rules the plugin is enforcing.",
    );
  });

  it("an acknowledged rule and a missing settings read-back do not claim the deny list stayed unchanged", () => {
    const said = saveNote(
      { outcome: "partial", error: "request timed out", view: null },
      "ask",
      { words: "Change files" },
      "Pip",
    );
    expect(said.note!.text).toBe(
      "The rules plugin saved Pip's Ask. Clawtrate couldn't confirm the deny-list change. request timed out. Reading what the gateway has now failed.",
    );
    expect(said.note!.text).not.toMatch(/wasn't changed/);
  });

  it("an unapplied Never does not change Offered, or appear in the current Never count", () => {
    const never = line({ value: "never", mark: "gateway", choice: "never" });
    const v = view({
      settingsApplied: "no",
      lines: [never],
      fallback: { bot: false, every: false },
    });
    expect(countWords(v)).toBe(STORED_WORDS);
    expect(countWords(view({ settingsApplied: "unknown", lines: [never] }))).toBe(STORED_WORDS);
  });
});
