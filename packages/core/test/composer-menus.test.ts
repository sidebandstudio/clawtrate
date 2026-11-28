import { describe, expect, it } from "vitest";
import { MAX_MENU_ROWS, mentionRows, slashRows } from "../src/composer-menus.ts";
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
});

describe("library skills to add (#889)", () => {
  const moon = {
    kind: "your-skill-to-add",
    name: "moon-phase",
    description: "Use when someone asks when the tide turns at the harbour.",
    insert: "/skill s_moon_phas_e65dd9b102714cd6a01b",
    attach: {
      skillId: "e65dd9b1-0271-4cd6-a01b-ca53f774a07a",
      revision: "0123456789abcdef".repeat(4),
    },
  };
  // A team skill (no owner), and another person's shared skill: both a new task would get.
  const harbour = entry({
    skillId: "11111111-2222-4333-8444-555555555555",
    slug: "harbour-map",
    name: "s_harbour_ma_111111112222433384",
    ownerProfileId: null,
    description: "The harbour's map.",
  });
  const shared = entry({
    skillId: "66666666-7777-4888-8999-000000000000",
    slug: "ferry-times",
    name: "s_ferry_tim_666666667777488889",
    ownerProfileId: "profile-kit",
    shared: true,
    description: "Use when someone asks for the next ferry.",
  });
  const toAdd = (attachable: unknown[], profileId: unknown = "gateway-owner") =>
    library({ sessionKey: "agent:otto:tides", selections: [own], attachable }, profileId);

  it("F-071: lists the person's own skills the task doesn't have after the task's, tagged to add with the entry and revision the list showed, then the team's", () => {
    const rows = slashRows(skills, metadata, toAdd([shared, harbour, saved]), true);
    expect(rows.slice(0, 4)).toEqual([
      tide,
      moon,
      {
        kind: "team-skill-to-add",
        name: "ferry-times",
        description: "Use when someone asks for the next ferry.",
        insert: "/skill s_ferry_tim_666666667777488889",
        attach: { skillId: "66666666-7777-4888-8999-000000000000", revision: moon.attach.revision },
      },
      {
        kind: "team-skill-to-add",
        name: "harbour-map",
        description: "The harbour's map.",
        insert: "/skill s_harbour_ma_111111112222433384",
        attach: { skillId: "11111111-2222-4333-8444-555555555555", revision: moon.attach.revision },
      },
    ]);
    expect(rows.slice(4).map((row) => row.kind)).toEqual(["skill", "skill", "command"]);
  });

  it("F-071: offers none on a connection that can't add one, and leaves out a skill that is off, removed, another person's own, or malformed", () => {
    // Without write access the menu is what it was.
    expect(slashRows(null, null, toAdd([saved]))).toEqual([tide]);
    expect(slashRows(null, null, toAdd([saved]), false)).toEqual([tide]);
    const left = [
      entry({ ...saved, enabled: false }),
      entry({ ...saved, enabled: undefined }),
      entry({ ...saved, removed: true }),
      // Another person's, not shared: listed only because the connection is an admin.
      entry({ ...saved, ownerProfileId: "profile-kit", shared: false }),
      entry({ ...saved, skillId: "not-an-id" }),
      entry({ ...saved, revision: "abc" }),
      entry({ ...saved, revision: undefined }),
      entry({ ...saved, name: "two words" }),
      null,
      "s_text_only",
    ];
    expect(slashRows(null, null, toAdd(left), true)).toEqual([tide]);
    // Whose it is comes from the gateway's owner against the answer's profile, never its words.
    const claims = entry({ ...saved, slug: "your-skill", ownerProfileId: "profile-kit" });
    expect(slashRows(null, null, toAdd([claims]), true)).toEqual([tide]);
    // An answer without a profile can't tell the person's own; a team skill is still the team's.
    expect(
      slashRows(null, null, toAdd([saved, harbour], null), true).map((row) => row.kind),
    ).toEqual(["team-skill", "team-skill-to-add"]);
    for (const attachable of ["x", null, {}])
      expect(slashRows(null, null, toAdd(attachable as unknown[]), true)).toEqual([tide]);
  });

  it("F-071: the menu read offers them only to a connection that holds operator.write and isn't pinned read-only", async () => {
    for (const [held, readOnly, kinds] of [
      [["operator.read", "operator.write"], false, ["your-skill", "your-skill-to-add"]],
      [["operator.read"], false, ["your-skill"]],
      [["operator.read", "operator.write"], true, ["your-skill"]],
    ] as const) {
      const { client, gateway } = await openTask({ held, client: { readOnly } });
      gateway.handlers["skills.library.list"] = () => library(selected([own]));
      try {
        expect((await client.readComposerMenu(KEY, "/")).map((row) => row.kind)).toEqual(kinds);
      } finally {
        client.stop();
      }
    }
  });
});

describe("the / menu's read", () => {
  it("F-071: reads the task's library skills with operator.read, and a refusal of them leaves the bot's skills and the commands", async () => {
    const { client, gateway } = await openTask();
    gateway.handlers["skills.status"] = () => skills;
    gateway.handlers["chat.metadata"] = () => metadata;
    gateway.handlers["skills.library.list"] = () => library(selected([own]));
    const rows = await client.readComposerMenu(KEY, "/");
    expect(gateway.calls("skills.library.list")).toEqual([{ sessionKey: KEY }]);
    // This connection may write, so the skill saved since the task started is offered (#889).
    expect(rows.map((row) => row.kind)).toEqual([
      "your-skill",
      "your-skill-to-add",
      "skill",
      "skill",
      "command",
    ]);
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
    expect(await client.readComposerMenu(KEY, "/")).toEqual([
      tide,
      expect.objectContaining({ kind: "your-skill-to-add", name: "moon-phase" }),
    ]);
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
