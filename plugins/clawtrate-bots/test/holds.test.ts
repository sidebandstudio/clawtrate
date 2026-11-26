// The holds on the tools a bot already has (lib/holds.js): each row of design
// section 3.3's side-door table, for each origin this build can tell apart.

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SAID,
  bootstrapFile,
  decide,
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

  it("a routine's own run removing that same routine is let through to be journaled; any other remove from it is not", () => {
    const routine = { origin: "C", read: null, kind: "routine" };
    const own = decide({
      event: call("automations", { action: "remove", jobId: "j1" }),
      origin: routine,
      run: { kind: "routine", jobId: "j1" },
      caller: "pip",
    } as never);
    expect(own).toEqual({ pass: true, journalRoutine: "j1" });
    const bySession = decide({
      event: call("automations", { action: "remove", id: "j1" }),
      origin: routine,
      run: { kind: "routine", sessionKey: "agent:pip:cron:j1:run:1" },
      caller: "pip",
    } as never);
    expect(bySession).toEqual({ pass: true, journalRoutine: "j1" });
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

  it("knows a bootstrap file by its path in the workspace, without case, through links and ..", () => {
    expect(bootstrapFile("AGENTS.md", ws)).toBe("agents.md");
    expect(bootstrapFile("Soul.MD", ws)).toBe("soul.md");
    expect(bootstrapFile(join(ws, "IDENTITY.md"), ws)).toBe("identity.md");
    expect(bootstrapFile("notes/../USER.md", ws)).toBe("user.md");
    expect(bootstrapFile("notes/AGENTS.md", ws)).toBeNull();
    expect(bootstrapFile("notes/scratch.md", ws)).toBeNull();
    // With no workspace known, a name is enough.
    expect(bootstrapFile("anything/TOOLS.md", null)).toBe("tools.md");
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
      expect(outcomes(call(tool, { path: "AGENTS.md" }), { workspaceDir: ws })).toEqual({
        B: "not done",
        Bread: "not done",
        O: "done",
        Oread: "not done",
        C: "not done",
        stranger: "not done",
      });
    }
    expect(
      on(call("apply_patch", { input: "*** Add File: SOUL.md\n" }), B, { workspaceDir: ws }),
    ).toMatchObject({ block: true });
  });

  it("its own IDENTITY.md: done as the bot's own, except from a chat-app sender who isn't the owner", () => {
    expect(outcomes(call("edit", { path: "IDENTITY.md" }), { workspaceDir: ws })).toEqual({
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
          workspaceDir: ws,
        } as never),
      ).toMatchObject({ block: true });
  });

  it("other files pass", () => {
    expect(outcomes(call("write", { path: "notes/scratch.md" }), { workspaceDir: ws })).toEqual({
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
    expect(targetBot(call("sessions_send", { label: "Compare trail maps" }), "pip")).toBe("pip");
    expect(targetBot(call("sessions_send", { sessionKey: "main" }), "pip")).toBe("pip");
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
  it("not done for any origin until the bot's own block can be told from a person's", () => {
    expect(outcomes(call("heartbeat_respond", { scratch: "new notes" }))).toEqual({
      B: "not done",
      Bread: "not done",
      O: "not done",
      Oread: "not done",
      C: "not done",
      stranger: "not done",
    });
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
