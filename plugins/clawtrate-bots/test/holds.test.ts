// The holds on the tools a bot already has (lib/holds.js): each row of design
// section 3.3's side-door table, for each origin this build can tell apart.

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NOTES_MAX_BYTES,
  SAID,
  decide,
  driveAlias,
  expandPath,
  heldFile,
  describeHolds,
  holdOf,
  storedOff,
  targetBot,
  writtenPaths,
} from "../lib/holds.js";

type Json = Record<string, unknown>;
const origin = (
  o: "B" | "O" | "C",
  read: string | null = null,
  kind = o === "O" ? "chat-app" : o === "B" ? "typed" : "bot-message",
) => ({ origin: o, read, kind });
const B = origin("B");
const Bread = origin("B", "web");
const O = origin("O");
const Oread = origin("O", "web");
const C = origin("C");
const stranger = origin("C", null, "chat-app");
const all = { B, Bread, O, Oread, C, stranger };

const call = (toolName: string, params: Json = {}, extra: Json = {}) => ({
  toolName,
  params,
  ...extra,
});
const on = (event: Json, o: Json, extra: Json = {}) =>
  decide({
    event,
    origin: o,
    run: { kind: (o as { kind: string }).kind },
    caller: "pip",
    ...extra,
  } as never);
const outcomes = (event: Json, extra: Json = {}) =>
  Object.fromEntries(
    Object.entries(all).map(([name, o]) => {
      const d = on(event, o, extra) as Json;
      return [name, d.block ? "not done" : d.approval ? "asks" : d.params ? "changed" : "done"];
    }),
  );

describe("which calls are held", () => {
  it("only section 3.3's side doors", () => {
    expect(holdOf(call("read", { path: "AGENTS.md" }), "pip")).toBeNull();
    expect(holdOf(call("automations", { action: "list" }), "pip")).toBeNull();
    expect(holdOf(call("cron", { action: "add" }), "pip")).toBe("scheduler-add");
    expect(holdOf(call("automations", { action: " Update " }), "pip")).toBe("scheduler-update");
    expect(holdOf(call("heartbeat_respond", { status: "ok" }), "pip")).toBeNull();
    expect(holdOf(call("heartbeat_respond", { scratch: "x" }), "pip")).toBe("notes");
    expect(
      holdOf(call("sessions_send", { sessionKey: "agent:pip:task-1", message: "m" }), "pip"),
    ).toBeNull();
    expect(holdOf(call("sessions_send", { agentId: "marlow", message: "m" }), "pip")).toBe(
      "message",
    );
    expect(holdOf(call("sessions_spawn", { task: "t" }), "pip")).toBeNull();
    expect(holdOf(call("sessions_spawn", { agentId: "marlow", task: "t" }), "pip")).toBe(
      "hand-off",
    );
    expect(holdOf(call("gateway", { action: "config.get" }), "pip")).toBeNull();
    expect(holdOf(call("gateway", { action: "update.run" }), "pip")).toBe("openclaw");
    expect(holdOf(call("openclaw", {}), "pip")).toBe("openclaw");
    expect(holdOf(call("plugins", { action: "list" }), "pip")).toBe("openclaw");
  });
});

describe("the scheduler", () => {
  const job = {
    name: "Morning",
    schedule: { kind: "cron", expr: "0 8 * * *" },
    payload: { kind: "agentTurn", message: "hi" },
  };

  it("add: as on plain OpenClaw for the owner who read nothing; stored off for the owner after reading and for B; not done otherwise", () => {
    expect(outcomes(call("automations", { action: "add", job }))).toEqual({
      B: "changed",
      Bread: "not done",
      O: "done",
      Oread: "changed",
      C: "not done",
      stranger: "not done",
    });
    const b = on(call("automations", { action: "add", job }), B) as {
      params: { job: Json };
      said: string;
    };
    expect(b.params.job.enabled).toBe(false);
    expect(b.said).toBe(SAID.seenFirst);
    expect((on(call("automations", { action: "add", job }), Oread) as { said: string }).said).toBe(
      SAID.turnedOff,
    );
  });

  it("stored off wherever the scheduler reads the job, and no other spelling of the key survives", () => {
    const nested = storedOff({
      action: "add",
      job: { data: { enabled: true }, job: { enabled: true }, " enabled": true, enabled: true },
    });
    expect(nested.job).toEqual({
      data: { enabled: false },
      job: { enabled: false },
      enabled: false,
    });
    const flat = storedOff({ action: "add", name: "x", "Enabled ": true });
    expect(flat).toEqual({ action: "add", name: "x", enabled: false });
    const empty = storedOff({ action: "add", job: {}, enabled: true });
    expect(empty).toEqual({ action: "add", job: {}, enabled: false });
  });

  it("update: only the owner who read nothing (which is also how a routine stored off is started from the chat)", () => {
    expect(
      outcomes(call("cron", { action: "update", jobId: "j1", job: { enabled: true } })),
    ).toEqual({
      B: "not done",
      Bread: "not done",
      O: "done",
      Oread: "not done",
      C: "not done",
      stranger: "not done",
    });
  });

  it("remove: OpenClaw's own approval for the owner who read nothing; not done otherwise", () => {
    expect(outcomes(call("automations", { action: "remove", jobId: "j1" }))).toEqual({
      B: "not done",
      Bread: "not done",
      O: "asks",
      Oread: "not done",
      C: "not done",
      stranger: "not done",
    });
  });

  it("a routine's own run may always end that same routine; any other remove from it is not done", () => {
    const routine = { origin: "C", read: null, kind: "routine" };
    const own = decide({
      event: call("automations", { action: "remove", jobId: "j1" }),
      origin: routine,
      run: { kind: "routine", jobId: "j1" },
      caller: "pip",
    } as never);
    expect(own).toEqual({ pass: true, endsRoutine: "j1" });
    const bySession = decide({
      event: call("automations", { action: "remove", id: "j1" }),
      origin: routine,
      run: { kind: "routine", sessionKey: "agent:pip:cron:j1:run:1" },
      caller: "pip",
    } as never);
    expect(bySession).toEqual({ pass: true, endsRoutine: "j1" });
    const other = decide({
      event: call("automations", { action: "remove", jobId: "j2" }),
      origin: routine,
      run: { kind: "routine", jobId: "j1" },
      caller: "pip",
    } as never);
    expect(other).toMatchObject({ block: true });
    const fromCheckIn = decide({
      event: call("automations", { action: "remove", jobId: "j1" }),
      origin: { ...routine, kind: "check-in" },
      run: { kind: "check-in", jobId: "j1" },
      caller: "pip",
    } as never);
    expect(fromCheckIn).toMatchObject({ block: true });
  });
});

describe("the bot's instruction files", () => {
  const ws = mkdtempSync(join(tmpdir(), "clawtrate-bots-holds-"));
  mkdirSync(join(ws, "notes"));
  writeFileSync(join(ws, "AGENTS.md"), "");
  symlinkSync(join(ws, "AGENTS.md"), join(ws, "notes", "alias.md"));

  it("knows a held file by its path in a bot's workspace, without case, through links and ..", () => {
    const own = (p: string) => heldFile(p, "pip", { pip: ws });
    expect(own("AGENTS.md")).toEqual({ file: "agents.md", bot: "pip" });
    expect(own("Soul.MD")).toEqual({ file: "soul.md", bot: "pip" });
    expect(own(join(ws, "IDENTITY.md"))).toEqual({ file: "identity.md", bot: "pip" });
    expect(own("notes/../USER.md")).toEqual({ file: "user.md", bot: "pip" });
    expect(own("HEARTBEAT.md")).toEqual({ file: "heartbeat.md", bot: "pip" });
    expect(own("notes/AGENTS.md")).toBeNull();
    expect(own("notes/scratch.md")).toBeNull();
    // With no workspace known for the caller, a name is enough.
    expect(heldFile("anything/TOOLS.md", "pip", {})).toEqual({ file: "tools.md", bot: "pip" });
  });

  it("reads what a patch writes, beyond the host's hint", () => {
    const patch =
      "*** Begin Patch\n*** Update File: notes/a.md\n@@\n*** Add File: SOUL.md\n+x\n*** Update File: b.md\n*** Move to: USER.md\n*** End Patch";
    expect(
      writtenPaths(call("apply_patch", { input: patch }, { derivedPaths: ["notes/a.md"] })).sort(),
    ).toEqual(["SOUL.md", "USER.md", "b.md", "notes/a.md"].sort());
    expect(writtenPaths(call("edit", { file_path: "AGENTS.md" }))).toEqual(["AGENTS.md"]);
  });

  it("instructions: only the owner who read nothing", () => {
    for (const tool of ["write", "edit"]) {
      expect(outcomes(call(tool, { path: "AGENTS.md" }), { workspaces: { pip: ws } })).toEqual({
        B: "not done",
        Bread: "not done",
        O: "done",
        Oread: "not done",
        C: "not done",
        stranger: "not done",
      });
    }
    expect(
      on(call("apply_patch", { input: "*** Add File: SOUL.md\n" }), B, { workspaces: { pip: ws } }),
    ).toMatchObject({ block: true });
  });

  it("its own IDENTITY.md: done as the bot's own, except from a chat-app sender who isn't the owner", () => {
    expect(outcomes(call("edit", { path: "IDENTITY.md" }), { workspaces: { pip: ws } })).toEqual({
      B: "done",
      Bread: "done",
      O: "done",
      Oread: "done",
      C: "done",
      stranger: "not done",
    });
  });

  it("another bot's files, from a task another bot started in its workspace: not done", () => {
    const task = { origin: "C", read: null, kind: "task" };
    const run = { kind: "task", provenance: { sourceSessionKey: "agent:pip:main" } };
    for (const path of ["IDENTITY.md", "AGENTS.md"])
      expect(
        decide({
          event: call("write", { path }),
          origin: task,
          run,
          caller: "marlow",
          workspaces: { marlow: ws },
        } as never),
      ).toMatchObject({ block: true });
  });

  it("other files pass", () => {
    expect(
      outcomes(call("write", { path: "notes/scratch.md" }), { workspaces: { pip: ws } }),
    ).toEqual({
      B: "done",
      Bread: "done",
      O: "done",
      Oread: "done",
      C: "done",
      stranger: "done",
    });
  });
});

describe("messages and hand-offs to other bots", () => {
  it("knows the bot a call reaches", () => {
    expect(targetBot(call("sessions_send", { agentId: "Marlow" }), "pip")).toBe("marlow");
    expect(targetBot(call("sessions_send", { sessionKey: "agent:marlow:main" }), "pip")).toBe(
      "marlow",
    );
    expect(
      targetBot(call("sessions_send", { agentId: "pip", label: "Compare trail maps" }), "pip"),
    ).toBe("pip");
    expect(targetBot(call("sessions_send", { sessionKey: "main" }), "pip")).toBe("pip");
    expect(targetBot(call("sessions_send", { message: "m" }), "pip")).toBe("pip");
    // A bare session id may be another bot's: it can't be told, so it counts as another bot.
    expect(targetBot(call("sessions_send", { sessionKey: "9b2c" }), "pip")).toBeNull();
    expect(targetBot(call("conversations_send", { conversationId: "x" }), "pip")).toBeNull();
  });

  it("the owner who read nothing as on plain OpenClaw; B with nothing read within reach; not done otherwise", () => {
    for (const event of [
      call("sessions_send", { agentId: "marlow", message: "m" }),
      call("sessions_spawn", { agentId: "marlow", task: "t" }),
    ]) {
      expect(outcomes(event, { reach: ["marlow"] })).toEqual({
        B: "done",
        Bread: "not done",
        O: "done",
        Oread: "not done",
        C: "not done",
        stranger: "not done",
      });
      expect(outcomes(event, { reach: [] })).toMatchObject({ B: "not done", O: "done" });
    }
    expect(
      outcomes(call("sessions_send", { sessionKey: "9b2c", message: "m" }), { reach: ["marlow"] }),
    ).toMatchObject({ B: "not done" });
  });
});

describe("the check-in's notes", () => {
  const empty = { notes: { scope: "check-in:pip", current: "", owned: false } };
  const own = { notes: { scope: "check-in:pip", current: "- water plants", owned: true } };
  const theirs = { notes: { scope: "check-in:pip", current: "- my own list", owned: false } };
  const write = call("heartbeat_respond", { scratch: "- water plants\n- feed cat" });

  it("over empty notes or its own: done, journaled; not after reading something from outside", () => {
    for (const notes of [empty, own])
      expect(outcomes(write, notes)).toEqual({
        B: "done",
        Bread: "not done",
        O: "done",
        Oread: "not done",
        C: "done",
        stranger: "done",
      });
    expect(on(write, C, own)).toEqual({
      pass: true,
      notesWrite: {
        scope: "check-in:pip",
        previous: "- water plants",
        next: "- water plants\n- feed cat",
      },
    });
  });

  it("over someone else's notes, or notes it couldn't see, not done", () => {
    expect(on(write, C, theirs)).toEqual({ block: true, reason: SAID.notesTheirs });
    expect(on(write, C, { notes: { scope: "check-in:pip", current: undefined } })).toEqual({
      block: true,
      reason: SAID.notesUnseen,
    });
    expect(on(write, C)).toEqual({ block: true, reason: SAID.notesUnseen });
  });

  it("at most 2 KiB", () => {
    const big = call("heartbeat_respond", { scratch: "x".repeat(NOTES_MAX_BYTES + 1) });
    expect(on(big, C, empty)).toEqual({ block: true, reason: SAID.notesTooLong });
    const fits = call("heartbeat_respond", { scratch: "x".repeat(NOTES_MAX_BYTES) });
    expect(on(fits, C, empty)).toMatchObject({ pass: true });
  });
});

describe("changing OpenClaw", () => {
  it("OpenClaw's own approval for the owner who read nothing; refused by the plugin itself otherwise", () => {
    for (const event of [
      call("openclaw", { command: "config set x" }),
      call("plugins", { action: "install" }),
      call("gateway", { action: "update.run" }),
    ]) {
      expect(outcomes(event)).toEqual({
        B: "not done",
        Bread: "not done",
        O: "asks",
        Oread: "not done",
        C: "not done",
        stranger: "not done",
      });
      expect((on(event, C) as { reason: string }).reason).toBe(SAID.noOneToAsk);
    }
  });
});

describe("what the bot is told", () => {
  it("why a change wasn't made: unconfirmed for B with nothing read, 7.3's words otherwise", () => {
    expect((on(call("edit", { path: "AGENTS.md" }), B) as { reason: string }).reason).toBe(
      SAID.unconfirmed,
    );
    expect((on(call("edit", { path: "AGENTS.md" }), Bread) as { reason: string }).reason).toBe(
      SAID.notDone,
    );
    expect((on(call("edit", { path: "AGENTS.md" }), C) as { reason: string }).reason).toBe(
      SAID.notDone,
    );
  });

  it("clawtrate_here's list follows the origin", () => {
    expect(describeHolds(O).join(" ")).toMatch(/work as usual/);
    expect(describeHolds(Oread).join(" ")).toMatch(/turned off until your person turns it on/);
    expect(describeHolds(B).join(" ")).toMatch(/starts once your person has seen it/);
    expect(describeHolds(C).join(" ")).toMatch(/aren't made from this run/);
  });
});

describe("fix round: reading a call as the tool reads it", () => {
  it("D1: a target in snake_case is the same target", () => {
    for (const event of [
      call("sessions_spawn", { task: "t", agent_id: "marlow" }),
      call("sessions_send", { agent_id: "marlow", message: "m" }),
      call("sessions_send", { session_key: "agent:marlow:main", message: "m" }),
    ]) {
      expect(holdOf(event, "pip")).not.toBeNull();
      expect(outcomes(event, { reach: ["marlow"] })).toMatchObject({
        Bread: "not done",
        C: "not done",
        B: "done",
      });
    }
  });

  it("D1: a send is its own only when no key names another target, as the tool takes them", () => {
    // The tool takes the session key over agentId, and looks a label alone up among every bot's sessions.
    for (const params of [
      { agentId: "pip", sessionKey: "agent:marlow:main" },
      { agent_id: "pip", session_key: "agent:marlow:main" },
      { agentId: "marlow", sessionKey: "main" },
      { label: "Review the route" },
    ]) {
      const event = call("sessions_send", { ...params, message: "m" });
      expect(holdOf(event, "pip")).toBe("message");
      expect(outcomes(event, { reach: ["marlow"] })).toMatchObject({
        B: "not done",
        Bread: "not done",
        C: "not done",
      });
    }
    expect(
      holdOf(call("sessions_send", { agentId: "pip", sessionKey: "agent:pip:main" }), "pip"),
    ).toBeNull();
    expect(
      holdOf(
        call("automations", { action: "wake", agentId: "pip", sessionKey: "agent:marlow:main" }),
        "pip",
      ),
    ).toBe("message");
  });

  it("D1: two spellings that name different things are refused", () => {
    const event = call("sessions_send", { agentId: "pip", agent_id: "marlow", message: "m" });
    expect(on(event, O)).toEqual({ block: true, reason: SAID.ambiguous });
  });

  it("D2: ~/, file:// and @ forms of a path are expanded as the file tools do", () => {
    const home = process.env.HOME!;
    expect(expandPath("~/x/AGENTS.md", "/w")).toBe(join(home, "x/AGENTS.md"));
    expect(expandPath("file:///w/AGENTS.md", "/x")).toBe("/w/AGENTS.md");
    expect(expandPath("@AGENTS.md", "/w")).toBe("/w/AGENTS.md");
    expect(expandPath("AGENTS.md</arg_value>", "/w")).toBe("/w/AGENTS.md");
  });

  it("D2: the bot's own AGENTS.md by ~/ or file:// is held; another bot's files by absolute path are clawtrate_bot's change", () => {
    // A home folder of the test's own, as the tools read it ($HOME).
    const home = mkdtempSync(join(tmpdir(), "clawtrate-bots-home-"));
    const saved = process.env.HOME;
    process.env.HOME = home;
    const pip = join(home, "pip");
    const marlow = join(home, "marlow");
    mkdirSync(pip);
    mkdirSync(marlow);
    const workspaces = { pip, marlow };
    const tilde = "~/pip/AGENTS.md";
    expect(on(call("edit", { path: tilde }), B, { workspaces })).toMatchObject({ block: true });
    expect(on(call("edit", { path: `file://${pip}/AGENTS.md` }), B, { workspaces })).toMatchObject({
      block: true,
    });
    expect(outcomes(call("edit", { path: join(marlow, "IDENTITY.md") }), { workspaces })).toEqual({
      B: "not done",
      Bread: "not done",
      O: "done",
      Oread: "not done",
      C: "not done",
      stranger: "not done",
    });
    expect(
      outcomes(call("file_write", { path: join(pip, "SOUL.md") }), { workspaces }),
    ).toMatchObject({ B: "not done", O: "done" });
    process.env.HOME = saved;
  });

  it("D6: an unknown run's IDENTITY.md write from a chat-app sender who isn't the owner, by the hook's own requester", () => {
    const ws = mkdtempSync(join(tmpdir(), "clawtrate-bots-holds-"));
    const unknown = { origin: "C", read: "lost", kind: "unknown" };
    const event = call("edit", { path: "IDENTITY.md" });
    expect(
      decide({
        event,
        origin: unknown,
        run: null,
        caller: "pip",
        workspaces: { pip: ws },
        requester: { channel: "discord", senderIsOwner: false },
      } as never),
    ).toMatchObject({ block: true });
    expect(
      decide({
        event,
        origin: unknown,
        run: null,
        caller: "pip",
        workspaces: { pip: ws },
        requester: { channel: "webchat", senderIsOwner: true },
      } as never),
    ).toEqual({ pass: true });
  });

  it("HEARTBEAT.md is held as the check-in's notes: not after reading", () => {
    const ws = mkdtempSync(join(tmpdir(), "clawtrate-bots-holds-"));
    expect(
      outcomes(call("write", { path: "HEARTBEAT.md" }), { workspaces: { pip: ws } }),
    ).toMatchObject({ B: "done", Bread: "not done", C: "done", Oread: "not done" });
  });
});

describe("fix round: the scheduler's other actions", () => {
  it("D4: run fires a routine only with nothing read, for one already on; the owner as on plain OpenClaw", () => {
    const run = call("automations", { action: "run", jobId: "j1", runMode: "force" });
    expect(outcomes(run, { enabled: () => false })).toEqual({
      B: "not done",
      Bread: "not done",
      O: "done",
      Oread: "not done",
      C: "not done",
      stranger: "not done",
    });
    expect(outcomes(run, { enabled: () => true })).toMatchObject({
      B: "done",
      Bread: "not done",
      C: "not done",
    });
    // Not known: as if it were off.
    expect(outcomes(run, { enabled: () => null })).toMatchObject({ B: "not done" });
    expect(
      outcomes(call("automations", { action: "run", job_id: "j1" }), { enabled: () => false }),
    ).toMatchObject({ B: "not done" });
  });

  it("wake: not after reading or from C; to another bot, the message row", () => {
    expect(outcomes(call("automations", { action: "wake", text: "x" }))).toEqual({
      B: "done",
      Bread: "not done",
      O: "done",
      Oread: "not done",
      C: "not done",
      stranger: "not done",
    });
    expect(holdOf(call("automations", { action: "wake", agentId: "marlow" }), "pip")).toBe(
      "message",
    );
  });

  it("bind is a change to an existing routine; scratch_set is a routine's notes", () => {
    expect(holdOf(call("automations", { action: "bind", jobId: "j1" }), "pip")).toBe(
      "scheduler-update",
    );
    expect(
      outcomes(call("automations", { action: "scratch_set", content: "x", expectedRevision: 2 }), {
        notes: { scope: "routine:j1", current: "", owned: false },
      }),
    ).toMatchObject({ B: "done", Bread: "not done", C: "done" });
  });

  it("D8: a routine's own remove names its job as the tool reads it, and two ids that disagree are refused", () => {
    const routine = { origin: "C", read: null, kind: "routine" };
    const run = { kind: "routine", jobId: "j1" };
    expect(
      decide({
        event: call("cron", { action: "remove", job_id: "j1" }),
        origin: routine,
        run,
        caller: "pip",
      } as never),
    ).toEqual({ pass: true, endsRoutine: "j1" });
    expect(
      decide({
        event: call("cron", { action: "remove", job_id: "j2", id: "j1" }),
        origin: routine,
        run,
        caller: "pip",
      } as never),
    ).toEqual({ block: true, reason: SAID.ambiguous });
  });
});

describe("fix round: other tool names", () => {
  it("D7: conversations_turn is a message to another conversation", () => {
    expect(
      outcomes(call("conversations_turn", { conversationId: "x", message: "m" })),
    ).toMatchObject({ B: "not done", O: "done", C: "not done" });
  });

  it("sessions_create under another bot is a hand-off; its own is not held", () => {
    expect(holdOf(call("sessions_create", { agentId: "marlow", message: "m" }), "pip")).toBe(
      "hand-off",
    );
    expect(holdOf(call("sessions_create", { label: "x" }), "pip")).toBeNull();
  });

  it("personal_instructions set is the USER.md row; get is not held", () => {
    expect(outcomes(call("personal_instructions", { action: "set", content: "x" }))).toMatchObject({
      B: "not done",
      O: "done",
      Oread: "not done",
    });
    expect(holdOf(call("personal_instructions", { action: "get" }), "pip")).toBeNull();
  });
});

describe("fix round 2", () => {
  it("D2: a Windows drive alias is mapped as 2026.11.10 maps it, and held on Windows in either form", () => {
    expect(driveAlias("/c/Users/pip/AGENTS.md")).toBe("C:\\Users\\pip\\AGENTS.md");
    expect(driveAlias("/mnt/d/ws/SOUL.md")).toBe("D:\\ws\\SOUL.md");
    expect(driveAlias("/cygdrive/e/x")).toBe("E:\\x");
    expect(driveAlias("@/c/ws/AGENTS.md")).toBe("@C:\\ws\\AGENTS.md");
    expect(driveAlias("/home/pip/AGENTS.md")).toBe("/home/pip/AGENTS.md");
    const workspaces = { pip: "C:\\Users\\pip\\ws" };
    const windows = { platform: "win32", pathApi: win32 };
    for (const raw of [
      "/c/Users/pip/ws/AGENTS.md",
      "/mnt/c/Users/pip/ws/agents.md",
      "@/c/Users/pip/ws/AGENTS.md",
    ])
      expect(heldFile(raw, "pip", workspaces, windows as never), raw).toEqual({
        file: "agents.md",
        bot: "pip",
      });
    // Elsewhere the alias is a plain absolute path.
    expect(heldFile("/c/Users/pip/ws/AGENTS.md", "pip", { pip: "/w/pip" })).toBeNull();
  });

  it("D4: a routine's run is decided by the enablement the gateway last reported", () => {
    const run = call("automations", { action: "run", jobId: "j1" });
    expect(on(run, B, { enabled: () => true })).toEqual({ pass: true });
    expect(on(run, B, { enabled: () => false })).toMatchObject({ block: true });
  });

  it("D1: a label is resolved as the gateway resolves it, then the reach decides", () => {
    const send = (label: string) => call("sessions_send", { label, message: "m" });
    const resolveLabel = (label: string) =>
      ({ "Compare trail maps": "pip", "Review the route": "marlow", "Otto's list": "otto" })[
        label
      ] ?? null;
    // Its own task: not held at all.
    expect(holdOf(send("Compare trail maps"), "pip", resolveLabel)).toBeNull();
    // Another bot's session within reach: a message, done with nothing read.
    expect(on(send("Review the route"), B, { reach: ["marlow"], resolveLabel })).toEqual({
      pass: true,
    });
    // Another bot's session out of reach, or a label no single session has: held.
    expect(on(send("Otto's list"), B, { reach: ["marlow"], resolveLabel })).toMatchObject({
      block: true,
    });
    expect(on(send("Nobody's"), B, { reach: ["marlow"], resolveLabel })).toMatchObject({
      block: true,
    });
    expect(on(send("Review the route"), Bread, { reach: ["marlow"], resolveLabel })).toMatchObject({
      block: true,
    });
  });

  it("create_goal and next_check schedule no more work from a run that read from outside, nor create_goal from C", () => {
    expect(outcomes(call("create_goal", { objective: "x" }))).toEqual({
      B: "done",
      Bread: "not done",
      O: "done",
      Oread: "not done",
      C: "not done",
      stranger: "not done",
    });
    expect(holdOf(call("update_goal", { status: "complete" }), "pip")).toBeNull();
    const rearm = call("automations", { action: "next_check", in: "10m" });
    expect(holdOf(rearm, "pip")).toBe("rearm");
    expect(on(rearm, origin("C", null, "routine"))).toEqual({ pass: true });
    expect(on(rearm, origin("C", "web", "routine"))).toMatchObject({ block: true });
  });
});
