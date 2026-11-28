import { describe, expect, it } from "vitest";
import {
  attachedCommand,
  detached,
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

// The person's own skill saved after the task started, offered to attach.
const moon = {
  kind: "your-skill",
  name: "moon-phase",
  description: "Use when someone asks when the tide turns at the harbour.",
  insert: "/skill s_moon_phas_e65dd9b102714cd6a01b",
  attach: { skillId: "e65dd9b1-0271-4cd6-a01b-ca53f774a07a", revision: own.revision },
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

  it("F-071: / offers the person's own skill the task could attach, after the task's own, only when the connection may attach it", () => {
    const answer = library(selected([own]));
    expect(slashRows(null, null, answer, true)).toEqual([tide, moon]);
    // Without operator.write the task's own skills alone, as before.
    expect(slashRows(null, null, answer, false)).toEqual([tide]);
    expect(slashRows(null, null, answer)).toEqual([tide]);
    // Only the person's own, switched on and still in the library, with an id and a revision to
    // attach: another's skill, or one the gateway's answer can't pin, is not offered.
    const offered = (attachable: unknown[], profileId: unknown = "gateway-owner") =>
      slashRows(null, null, library({ ...selected([]), attachable }, profileId), true);
    expect(offered([team])).toEqual([]);
    expect(offered([saved], null)).toEqual([]);
    expect(offered([entry({ enabled: false })])).toEqual([]);
    expect(offered([entry({ enabled: undefined })])).toEqual([]);
    expect(offered([entry({ removed: true })])).toEqual([]);
    expect(offered([entry({ skillId: undefined })])).toEqual([]);
    expect(offered([entry({ revision: 7 })])).toEqual([]);
    expect(offered([entry({ name: "two words" })])).toEqual([]);
    for (const attachable of ["x", null, [null, "x"]])
      expect(slashRows(null, null, library({ ...selected([]), attachable }), true)).toEqual([]);
  });

  it("F-071: an attach is established only by the task's selections holding that skill at that revision, a detach only by their leaving it out", () => {
    const pin = { skillId: saved.skillId, revision: saved.revision, name: saved.name };
    const answer = (selections: unknown) => ({
      sessionKey: "agent:otto:tides",
      selections,
      sessionActivation: "next-turn",
    });
    expect(attachedCommand(answer([pin]), saved.skillId, saved.revision)).toBe(saved.name);
    expect(attachedCommand(answer([]), saved.skillId, saved.revision)).toBeNull();
    expect(
      attachedCommand(
        answer([{ ...pin, revision: "f".repeat(64) }]),
        saved.skillId,
        saved.revision,
      ),
    ).toBeNull();
    expect(
      attachedCommand(answer([{ ...pin, name: "two words" }]), saved.skillId, saved.revision),
    ).toBeNull();
    expect(attachedCommand(null, saved.skillId, saved.revision)).toBeNull();
    expect(detached(answer([]), saved.skillId)).toBe(true);
    expect(detached(answer([pin]), saved.skillId)).toBe(false);
    expect(detached(answer(undefined), saved.skillId)).toBe(false);
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

describe("the / menu's read", () => {
  it("F-071: reads the task's library skills with operator.read, and a refusal of them leaves the bot's skills and the commands", async () => {
    const { client, gateway } = await openTask();
    gateway.handlers["skills.status"] = () => skills;
    gateway.handlers["chat.metadata"] = () => metadata;
    gateway.handlers["skills.library.list"] = () => library(selected([own]));
    const rows = await client.readComposerMenu(KEY, "/");
    expect(gateway.calls("skills.library.list")).toEqual([{ sessionKey: KEY }]);
    expect(rows.map((row) => row.kind)).toEqual([
      "your-skill",
      "your-skill",
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
    expect(await client.readComposerMenu(KEY, "/")).toEqual([tide, moon]);
    gateway.handlers["skills.library.list"] = refuse;
    await expect(client.readComposerMenu(KEY, "/")).rejects.toThrow(
      "The gateway did not list them.",
    );
    client.stop();
  });
});

describe("attaching a library skill", () => {
  it("F-071: choosing an attachable skill sends the attach with its id and revision before the skill's command, and Undo detaches it", async () => {
    const { client, gateway } = await openTask();
    let selections: unknown[] = [];
    gateway.handlers["skills.library.list"] = () => library(selected(selections));
    gateway.handlers["skills.library.activate"] = (params) => {
      const { action, skillId, revision } = params as Record<string, string>;
      selections =
        action === "attach"
          ? [{ skillId, revision, name: saved.name, ownerProfileId: "gateway-owner" }]
          : [];
      return { sessionKey: KEY, selections, sessionActivation: "next-turn" };
    };
    const row = (await client.readComposerMenu(KEY, "/")).find((each) => each.attach);
    expect(row).toMatchObject({ name: "moon-phase", attach: { skillId: saved.skillId } });
    const { command } = await client.attachLibrarySkill(
      KEY,
      row!.attach!.skillId,
      row!.attach!.revision,
    );
    client.sendMessage(KEY, `/skill ${command} for tonight`);
    await until(() => gateway.calls("chat.send").length === 1);
    const order = gateway.requests
      .filter((each) => each.method === "skills.library.activate" || each.method === "chat.send")
      .map((each) => [each.method, each.params]);
    expect(order).toEqual([
      [
        "skills.library.activate",
        { sessionKey: KEY, action: "attach", skillId: saved.skillId, revision: saved.revision },
      ],
      ["chat.send", expect.objectContaining({ message: `/skill ${saved.name} for tonight` })],
    ]);
    expect(await client.detachLibrarySkill(KEY, saved.skillId)).toEqual({ detached: true });
    expect(gateway.calls("skills.library.activate").at(-1)).toEqual({
      sessionKey: KEY,
      action: "detach",
      skillId: saved.skillId,
    });
    // An answer that doesn't list the skill establishes no attach.
    gateway.handlers["skills.library.activate"] = () => ({ sessionKey: KEY, selections: [] });
    await expect(client.attachLibrarySkill(KEY, saved.skillId, saved.revision)).rejects.toThrow(
      "The gateway's answer doesn't list the skill on this task.",
    );
    client.stop();
  });

  it("F-071 #848: an attach or detach whose answer is lost is unconfirmed, and a refusal is said in the gateway's words", async () => {
    const { client, gateway } = await openTask();
    gateway.handlers["skills.library.activate"] = () => {
      throw new Error("skill revision is stale");
    };
    await expect(client.attachLibrarySkill(KEY, saved.skillId, saved.revision)).rejects.toThrow(
      "skill revision is stale",
    );
    // The request goes, and the connection drops before its answer: nothing says it failed.
    const held = deferred<unknown>();
    gateway.handlers["skills.library.activate"] = () => held.promise;
    const attach = client.attachLibrarySkill(KEY, saved.skillId, saved.revision);
    await until(() => gateway.calls("skills.library.activate").length === 2);
    gateway.dropAll();
    expect(await attach).toEqual({ command: null });
    await until(() => client.state.connection.status === "connected");
    gateway.handlers["skills.library.activate"] = () => held.promise;
    const detach = client.detachLibrarySkill(KEY, saved.skillId);
    await until(() => gateway.calls("skills.library.activate").length === 3);
    gateway.dropAll();
    expect(await detach).toEqual({ detached: false });
    client.stop();
  });

  it("F-071: a connection without operator.write is offered only the task's own library skills", async () => {
    const { client, gateway } = await openTask({ held: ["operator.read"] });
    gateway.handlers["skills.library.list"] = () => library(selected([own]));
    expect(await client.readComposerMenu(KEY, "/")).toEqual([tide]);
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
