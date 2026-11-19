import { describe, expect, it } from "vitest";
import { MAX_MENU_ROWS, mentionRows, slashRows } from "../src/composer-menus.ts";

// Shapes as OpenClaw 2026.10.6 answers them (`skills.status`, `chat.metadata`, `cron.list`).
const skills = {
  skills: [
    { name: "weather", description: "Get the weather.", userInvocable: true, eligible: true },
    { name: "gh-issues", description: "Work on issues.", userInvocable: true, eligible: true },
    { name: "1password", description: "Needs op.", userInvocable: true, eligible: false },
    { name: "internal", description: "Model only.", userInvocable: false, eligible: true },
  ],
};
const metadata = {
  commands: [
    { name: "status", textAliases: ["/status"], description: "Show status." },
    { name: "weather", textAliases: ["/weather"], description: "Run weather." },
    { name: "gh_issues", textAliases: ["/gh_issues"], description: "Run gh-issues." },
    { name: "voice", description: "No text alias." },
  ],
};

describe("the composer's menus", () => {
  it("F-071: / lists the skills a person may run as Skill, with their own command, then the gateway's other commands as Command, and no app's action", () => {
    expect(slashRows(skills, metadata)).toEqual([
      { kind: "skill", name: "weather", description: "Get the weather.", insert: "/weather" },
      { kind: "skill", name: "gh-issues", description: "Work on issues.", insert: "/gh_issues" },
      { kind: "command", name: "status", description: "Show status.", insert: "/status" },
    ]);
    // A row whose text is too long to keep whole is left out, never cut.
    const long = { commands: [{ name: "x", textAliases: [`/${"x".repeat(300)}`] }] };
    expect(slashRows(null, long)).toEqual([]);
    // A skill with no command of its own is asked for by name.
    expect(slashRows(skills, { commands: [] })[0]!.insert).toBe("/skill weather");
    const many = {
      skills: Array.from({ length: 300 }, (_, n) => ({
        name: `s${n}`,
        userInvocable: true,
        eligible: true,
      })),
    };
    expect(slashRows(many, null)).toHaveLength(MAX_MENU_ROWS);
  });

  it("F-070: @ lists the bots, then the routines the gateway keeps, never its own heartbeat", () => {
    const cron = {
      jobs: [
        { displayName: "Heartbeat (main)", payload: { kind: "heartbeat" }, enabled: true },
        { displayName: "Morning disk check", payload: { kind: "agentTurn" }, enabled: false },
      ],
    };
    expect(mentionRows([{ id: "otto", name: "Otto" }], cron)).toEqual([
      { kind: "bot", name: "Otto", description: null, insert: "@Otto" },
      {
        kind: "routine",
        name: "Morning disk check",
        description: "Paused",
        insert: "@Morning disk check",
      },
    ]);
  });
});
