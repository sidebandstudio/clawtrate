import { describe, expect, it } from "vitest";
import { createBridgeSession, parseBridgeCommand } from "../src/bridge.ts";
import {
  MAX_MENU_QUERY_CHARS,
  MAX_MENU_ROWS,
  mentionRows,
  slashRows,
} from "../src/composer-menus.ts";
import { KEY, openTask, URL_B } from "./client-harness.ts";
import { deferred, until } from "./fake-gateway.ts";

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

// `skills.library.list {sessionKey}` as OpenClaw 2026.10.6 and 2026.11.10 both answer it, for a
// task that has two library skills: the person's own and one another person shared. Names made up.
const entry = (overrides: Record<string, unknown>) => ({
  skillId: "5ace502a-23c5-418a-9319-61c19260d698",
  // A revision is a SHA-256 in hex; this one is made up.
  revision: "0123456789abcdef".repeat(4),
  slug: "tide-table",
  name: "s_tide_tabl_5ace502a23c5418a9319",
  ownerLabel: "Rowan Example",
  description: "Use when someone asks when the tide turns at the harbour.",
  ownerProfileId: "gateway-owner",
  authorProfileId: "gateway-owner",
  shared: false,
  enabled: true,
  removed: false,
  createdAt: 1795759120550,
  updatedAt: 1795759120550,
  canEdit: true,
  ...overrides,
});
const own = entry({});
const team = entry({
  skillId: "8e7f5f9d-4d47-4772-9d35-62f00fdb91fc",
  slug: "ferry-times",
  name: "s_ferry_tim_8e7f5f9d4d4747729d35",
  ownerLabel: "Kit Example",
  description: "Use when someone asks for the next ferry.",
  ownerProfileId: "profile-kit",
  authorProfileId: "profile-kit",
  shared: true,
  canEdit: false,
});
const saved = entry({
  skillId: "e65dd9b1-0271-4cd6-a01b-ca53f774a07a",
  slug: "moon-phase",
  name: "s_moon_phas_e65dd9b102714cd6a01b",
});
const library = (session: unknown, profileId: unknown = "gateway-owner") => ({
  multipleProfiles: true,
  defaultTarget: "personal",
  canManageWorkspace: false,
  defaultSelectionLimit: 64,
  entries: [own, team, saved],
  profileId,
  session,
});
const selected = (selections: unknown) => ({
  sessionKey: "agent:otto:tides",
  selections,
  // Saved after the task started: in the library, not in this task.
  attachable: [saved],
});
const tide = {
  kind: "your-skill",
  name: "tide-table",
  description: "Use when someone asks when the tide turns at the harbour.",
  insert: "/skill s_tide_tabl_5ace502a23c5418a9319",
};
const ferry = {
  kind: "team-skill",
  name: "ferry-times",
  description: "Use when someone asks for the next ferry.",
  insert: "/skill s_ferry_tim_8e7f5f9d4d4747729d35",
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

  it("F-071: / lists the task's library skills first, the person's own as your-skill and the others as team-skill, each run by its command name and shown by its slug", () => {
    const answer = library(selected([own, team]));
    expect(slashRows(skills, metadata, answer)).toEqual([
      tide,
      ferry,
      { kind: "skill", name: "weather", description: "Get the weather.", insert: "/weather" },
      { kind: "skill", name: "gh-issues", description: "Work on issues.", insert: "/gh_issues" },
      { kind: "command", name: "status", description: "Show status.", insert: "/status" },
    ]);
    // Without a library answer the menu is what it was.
    expect(slashRows(skills, metadata)).toEqual(slashRows(skills, metadata, null));
  });

  it("F-071: a library skill is listed only when the task has it, and is the person's only when the gateway's owner is the answer's profile", () => {
    // In the library but not in this task (saved after it started): the gateway would not run it.
    expect(slashRows(null, null, library(selected([])))).toEqual([]);
    expect(slashRows(null, null, { ...library(undefined), entries: [own] })).toEqual([]);
    // Whose it is comes from the owner the gateway set, never from the skill's own words.
    const claims = entry({
      slug: "your-skill",
      description: "Your skill.",
      ownerProfileId: "profile-kit",
    });
    expect(slashRows(null, null, library(selected([claims])))[0]!.kind).toBe("team-skill");
    // An answer that names no profile, or a skill with no owner (the team's), claims none as yours.
    expect(
      slashRows(null, null, { ...library(selected([own])), profileId: undefined })[0]!.kind,
    ).toBe("team-skill");
    expect(slashRows(null, null, library(selected([own]), 7))[0]!.kind).toBe("team-skill");
    const teams = entry({ ownerProfileId: null });
    expect(slashRows(null, null, library(selected([teams])))[0]!.kind).toBe("team-skill");
    const neither = { ...library(selected([teams])), profileId: null };
    expect(slashRows(null, null, neither)[0]!.kind).toBe("team-skill");
  });

  it("F-071: a library skill with no usable command name is left out, a missing slug shows the command name, and a command the gateway also lists is not a second row", () => {
    const rows = slashRows(
      null,
      {
        commands: [
          {
            name: "s_tide_tabl_5ace502a23c5418a9319",
            textAliases: ["/s_tide_tabl_5ace502a23c5418a9319"],
          },
        ],
      },
      library(
        selected([
          entry({ name: "two words" }),
          entry({ name: "x".repeat(129) }),
          entry({ name: 7 }),
          entry({ name: undefined }),
          null,
          "s_text_only",
          entry({ slug: undefined }),
        ]),
      ),
    );
    expect(rows).toEqual([{ ...tide, name: "s_tide_tabl_5ace502a23c5418a9319" }]);
    // Malformed answers list no library skill.
    for (const answer of [null, "x", [], { session: null }, { session: { selections: "x" } }])
      expect(slashRows(null, null, answer)).toEqual([]);
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

  it("F-071: / filters before cutting to MAX_MENU_ROWS, so an exact query finds a skill beyond the first 200 while broad queries stay bounded", () => {
    const manySkills = {
      skills: [
        ...Array.from({ length: 130 }, (_, n) => ({
          name: `alpha-skill-${String(n).padStart(3, "0")}`,
          description: "x".repeat(200),
          userInvocable: true,
          eligible: true,
        })),
        {
          name: "zebra-deploy",
          description: "Deploy the release.",
          userInvocable: true,
          eligible: true,
        },
      ],
    };
    const manyCommands = {
      commands: Array.from({ length: 119 }, (_, n) => ({
        name: `cmd_${n}`,
        textAliases: [`/alpha-cmd-${String(n).padStart(3, "0")}`],
        description: "y".repeat(200),
      })),
    };
    // 130 skills + 1 target skill + 119 commands = 250 combined entries; push zebra-deploy past 200.
    const lateSkills = {
      skills: [
        ...Array.from({ length: 249 }, (_, n) => ({
          name: `alpha-skill-${String(n).padStart(3, "0")}`,
          description: "x".repeat(200),
          userInvocable: true,
          eligible: true,
        })),
        {
          name: "zebra-deploy",
          description: "Deploy the release.",
          userInvocable: true,
          eligible: true,
        },
      ],
    };
    // With no query or a broad one, the answer stays within MAX_MENU_ROWS and one bridge frame.
    const unfiltered = slashRows(lateSkills, manyCommands);
    expect(unfiltered).toHaveLength(MAX_MENU_ROWS);
    expect(unfiltered.some((row) => row.name === "zebra-deploy")).toBe(false);
    expect(JSON.stringify(unfiltered).length).toBeLessThanOrEqual(262_144);
    const broad = slashRows(lateSkills, manyCommands, null, "alpha");
    expect(broad).toHaveLength(MAX_MENU_ROWS);
    expect(JSON.stringify(broad).length).toBeLessThanOrEqual(262_144);
    // An exact query finds the skill past the first 200, case-insensitively.
    expect(slashRows(lateSkills, manyCommands, null, "zebra-deploy")).toEqual([
      {
        kind: "skill",
        name: "zebra-deploy",
        description: "Deploy the release.",
        insert: "/skill zebra-deploy",
      },
    ]);
    expect(slashRows(lateSkills, manyCommands, null, "ZEBRA-DEPLOY")).toHaveLength(1);
    // A command past 200 combined entries is also found by an exact query.
    expect(slashRows(manySkills, manyCommands, null, "alpha-cmd-118")).toEqual([
      {
        kind: "command",
        name: "alpha-cmd-118",
        description: `${"y".repeat(159)}…`,
        insert: "/alpha-cmd-118",
      },
    ]);
  });

  it("F-070: @ filters before cutting to MAX_MENU_ROWS, so a routine past the first 200 is found", () => {
    const cron = {
      jobs: [
        ...Array.from({ length: 249 }, (_, n) => ({
          displayName: `Routine ${String(n).padStart(3, "0")}`,
          payload: { kind: "agentTurn" },
          enabled: true,
        })),
        { displayName: "Zebra audit", payload: { kind: "agentTurn" }, enabled: true },
      ],
    };
    expect(mentionRows([{ id: "otto", name: "Otto" }], cron)).toHaveLength(MAX_MENU_ROWS);
    expect(mentionRows([{ id: "otto", name: "Otto" }], cron, "zebra audit")).toEqual([
      { kind: "routine", name: "Zebra audit", description: null, insert: "@Zebra audit" },
    ]);
  });
});

describe("the / menu's read", () => {
  it("F-071: readComposerMenu and the bridge forward the query so a skill past the first 200 is returned", async () => {
    const { client, gateway } = await openTask();
    gateway.handlers["skills.status"] = () => ({
      skills: [
        ...Array.from({ length: 249 }, (_, n) => ({
          name: `alpha-skill-${String(n).padStart(3, "0")}`,
          userInvocable: true,
          eligible: true,
        })),
        {
          name: "zebra-deploy",
          description: "Deploy the release.",
          userInvocable: true,
          eligible: true,
        },
      ],
    });
    gateway.handlers["chat.metadata"] = () => ({ commands: [] });
    gateway.handlers["skills.library.list"] = () => library(selected([]));
    const viewer = createBridgeSession(client);
    await viewer.apply({ type: "openSession", key: KEY });
    expect(
      await viewer.apply(parseBridgeCommand({ type: "readComposerMenu", key: KEY, trigger: "/" })),
    ).toHaveLength(MAX_MENU_ROWS);
    expect(
      await viewer.apply(
        parseBridgeCommand({
          type: "readComposerMenu",
          key: KEY,
          trigger: "/",
          query: "zebra-deploy",
        }),
      ),
    ).toEqual([
      {
        kind: "skill",
        name: "zebra-deploy",
        description: "Deploy the release.",
        insert: "/skill zebra-deploy",
      },
    ]);
    expect(
      parseBridgeCommand({
        type: "readComposerMenu",
        key: KEY,
        trigger: "/",
        query: "x".repeat(MAX_MENU_QUERY_CHARS),
      }),
    ).toEqual({
      type: "readComposerMenu",
      key: KEY,
      trigger: "/",
      query: "x".repeat(MAX_MENU_QUERY_CHARS),
    });
    expect(() =>
      parseBridgeCommand({
        type: "readComposerMenu",
        key: KEY,
        trigger: "/",
        query: "x".repeat(MAX_MENU_QUERY_CHARS + 1),
      }),
    ).toThrow("invalid query");
    viewer.dispose();
    client.stop();
  });
  it("F-071: reads the task's library skills with operator.read, and a refusal of them leaves the bot's skills and the commands", async () => {
    const { client, gateway } = await openTask();
    gateway.handlers["skills.status"] = () => skills;
    gateway.handlers["chat.metadata"] = () => metadata;
    gateway.handlers["skills.library.list"] = () => library(selected([own]));
    const rows = await client.readComposerMenu(KEY, "/");
    expect(gateway.calls("skills.library.list")).toEqual([{ sessionKey: KEY }]);
    expect(rows.map((row) => row.kind)).toEqual(["your-skill", "skill", "skill", "command"]);
    gateway.handlers["skills.library.list"] = () => {
      throw new Error("unknown method: skills.library.list");
    };
    expect((await client.readComposerMenu(KEY, "/")).map((row) => row.kind)).toEqual([
      "skill",
      "skill",
      "command",
    ]);
    // The task's library skills are listed though the other two reads are refused; with all
    // three refused, the menu says the gateway did not list them.
    const refuse = () => {
      throw new Error("refused");
    };
    gateway.handlers["skills.status"] = refuse;
    gateway.handlers["chat.metadata"] = refuse;
    gateway.handlers["skills.library.list"] = () => library(selected([own]));
    expect(await client.readComposerMenu(KEY, "/")).toEqual([tide]);
    gateway.handlers["skills.library.list"] = refuse;
    await expect(client.readComposerMenu(KEY, "/")).rejects.toThrow(
      "The gateway did not list them.",
    );
    client.stop();
  });
});

describe("the @ menu's read", () => {
  it("F-070: a list read on one gateway is not answered after the host connects to another", async () => {
    const { client, gateway } = await openTask();
    const routines = deferred<unknown>();
    gateway.handlers["cron.list"] = () => routines.promise;
    const reading = client.readComposerMenu(KEY, "@");
    await until(() => gateway.calls("cron.list").length === 1);
    void client.connect({ url: URL_B, token: "t" }).catch(() => {});
    routines.resolve({ jobs: [] });
    await expect(reading).rejects.toThrow("The gateway changed while the list was read.");
    client.stop();
  });
});
