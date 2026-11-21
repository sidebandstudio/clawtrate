// The words of a new bot's command choice and its read-back
// (docs/design/controls.md section 10; bots.md section 3): each sentence as
// the design states it, the saved setting and the reported policy as two
// separate facts, and no sentence that claims what a command will do.

import type { NewBotPolicy } from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import {
  CHOICE_ROWS,
  chooseLine,
  fileLine,
  inheritsLine,
  machineLine,
  mainPolicySentence,
  policyNote,
} from "../src/bots/policy-words.ts";

const policy = (change: Partial<NewBotPolicy>): NewBotPolicy => ({
  botId: "viral",
  name: "Viral",
  workspace: "/w/viral",
  chosen: "ask",
  status: "confirmed",
  restrictive: true,
  saved: "ask",
  missingDeny: [],
  reported: "guarded",
  retryable: false,
  ...change,
});

describe("F-051: the Approvals step and what it says", () => {
  it("offers the two rows with their lines, and the lines under them", () => {
    expect(CHOICE_ROWS.map((row) => [row.title, row.line("Viral")])).toEqual([
      [
        "Ask before acting",
        "Sets Viral's command policy to ask for approval when a command misses the machine's allowlist.",
      ],
      [
        "Run without routine approvals",
        "Sets Viral's command policy to run without routine approval. The machine, the task or a rule can still require approval or block a command.",
      ],
    ]);
    expect(machineLine("Viral")).toBe(
      "Commands use the machine and permissions set by the gateway. Viral's command setting replaces the gateway-wide command mode for this bot.",
    );
    // No promise of a page the bot's settings don't have yet.
    expect(machineLine("Viral")).not.toMatch(/later|settings\./);
    expect(fileLine(false)).toBe(
      "The gateway's approvals file can require approval or block commands.",
    );
    expect(fileLine(true)).toBe("The gateway's approvals file blocks commands.");
    expect(inheritsLine("Viral")).toBe(
      "Before Clawtrate sets Viral's policy, the new bot inherits the gateway's settings.",
    );
    expect(chooseLine("Viral")).toBe("Choose how Viral runs commands.");
  });
});

describe("F-051: the note in the new bot's first task, as read", () => {
  it("names the saved setting, then the reported label, as two sentences", () => {
    expect(policyNote(policy({})).lines).toEqual([
      "Viral's saved command setting is Ask before acting.",
      "The gateway reports that the default command policy asks on an allowlist miss.",
    ]);
    expect(policyNote(policy({ chosen: "full", saved: "full", reported: "full" })).lines).toEqual([
      "Viral's saved command setting is Run without routine approvals.",
      "The gateway reports no routine approval in the default command policy.",
    ]);
    expect(policyNote(policy({ reported: "read-only" })).lines[1]).toBe(
      "The gateway reports that the default command policy disables commands.",
    );
    expect(policyNote(policy({ reported: "none" })).lines[1]).toBe(
      "The gateway didn't report a default command policy for Viral.",
    );
    // No read of the list since the setting was read, or a label Clawtrate has no sentence for:
    // nothing is said of it, and an unknown label is not said to be missing.
    expect(policyNote(policy({ reported: null })).lines).toHaveLength(1);
    expect(policyNote(policy({ reported: "workspace" })).lines).toHaveLength(1);
    expect(policyNote(policy({ reported: "unrecognized" })).lines).toHaveLength(1);
  });

  it("says when the setting can't be confirmed, and the mode a fresh read returned", () => {
    expect(policyNote(policy({ status: "unconfirmed", saved: "deny", reported: null }))).toEqual({
      tone: "warn",
      title: "Clawtrate couldn't confirm Viral's command setting.",
      lines: [
        "Review the gateway's settings before sending a task.",
        "Its saved command setting is Never.",
        "The command setting is tools.exec.mode in Viral's entry of the gateway's settings.",
      ],
    });
    expect(
      policyNote(policy({ status: "restrictive", restrictive: false, saved: null, reported: null }))
        .lines,
    ).toEqual([
      "Review the gateway's settings before sending a task.",
      "The command setting is tools.exec.mode in Viral's entry of the gateway's settings.",
    ]);
    // A confirmed status whose mode isn't the chosen one is never said as chosen.
    expect(policyNote(policy({ saved: "full" })).tone).toBe("warn");
    expect(policyNote(policy({ status: "checking" })).lines).toEqual([
      "Checking what was written…",
    ]);
  });

  it("F-051: says which read-back condition holds the task: the saved mode, a tool no longer blocked, and the label beside them", () => {
    // Saved as chosen, with a tool Clawtrate blocks missing from the deny list.
    expect(
      policyNote(policy({ status: "unconfirmed", missingDeny: ["t3code__*"], reported: null }))
        .lines,
    ).toEqual([
      "Review the gateway's settings before sending a task.",
      "Its saved command setting is Ask before acting.",
      "Its settings don't block this tool Clawtrate blocks for a new bot: t3code__*.",
      "The command setting is tools.exec.mode in Viral's entry of the gateway's settings.",
    ]);
    expect(
      policyNote(policy({ status: "unconfirmed", missingDeny: ["gateway", "plugins"] })).lines[2],
    ).toBe(
      "Its settings don't block these tools Clawtrate blocks for a new bot: gateway, plugins.",
    );
    // Another mode saved: the gateway's fresh label is said too, as its own fact.
    expect(
      policyNote(policy({ status: "unconfirmed", saved: "deny", reported: "read-only" })).lines,
    ).toEqual([
      "Review the gateway's settings before sending a task.",
      "Its saved command setting is Never.",
      "The gateway reports that the default command policy disables commands.",
      "The command setting is tools.exec.mode in Viral's entry of the gateway's settings.",
    ]);
  });

  it("never claims an effective result", () => {
    for (const each of [
      policy({}),
      policy({ chosen: "full", saved: "full", reported: "full" }),
      policy({ status: "unconfirmed", saved: "deny" }),
    ]) {
      const words = policyNote(each).lines.join(" ");
      expect(words).not.toMatch(/effective|will run|runs commands without|always asks/i);
    }
  });
});

describe("F-005: what the first-bot prompt says below admin of Main", () => {
  it("one sentence per reported label, nothing when none is reported", () => {
    expect(mainPolicySentence("guarded")).toBe(
      "The gateway reports that Main's default command policy asks on an allowlist miss.",
    );
    expect(mainPolicySentence("full")).toBe(
      "The gateway reports no routine approval in Main's default command policy.",
    );
    expect(mainPolicySentence("read-only")).toBe(
      "The gateway reports that Main's default command policy disables commands.",
    );
    expect(mainPolicySentence(null)).toBeNull();
  });
});
