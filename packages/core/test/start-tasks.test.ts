// Whether a bot can start tasks (#532): the gateway's `sessions_spawn`, as `tools.effective`
// reports it for one of the bot's tasks, kept beside that task's tool map.
import { describe, expect, it } from "vitest";
import { botStartTasks, MAX_START_TASKS_REASON_CHARS, startTasksFrom } from "../src/start-tasks.ts";
import { KEY, openTask } from "./client-harness.ts";
import { until } from "./fake-gateway.ts";

const tool = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  label: id,
  description: "",
  rawDescription: "",
  source: "core",
  ...extra,
});
/** As OpenClaw 2026.10.6 answers it, with the tools the session has and each tool's access. */
const effective = (tools: unknown[], access: unknown[] = []) => ({
  agentId: "otto",
  profile: "full",
  groups: [{ id: "core", label: "Built-in tools", source: "core", tools }],
  toolAccess: { checked: "live-session", profiles: [], tools: access },
  notices: [],
});
const excluded = (...labels: string[]) => ({
  id: "sessions_spawn",
  status: "excluded",
  reasons: labels.map((label) => ({ kind: "allowlist", label, source: "tools.allow" })),
});

describe("whether a bot can start tasks", () => {
  it("can when the session has sessions_spawn", () => {
    expect(startTasksFrom(effective([tool("read"), tool("sessions_spawn")]))).toEqual({
      can: true,
      reason: null,
    });
  });

  it("can't when the session lacks it, with the gateway's reason when it gives one", () => {
    expect(
      startTasksFrom(effective([tool("read")], [excluded("Not included in tools.allow")])),
    ).toEqual({ can: false, reason: "Not included in tools.allow" });
    // Several reasons are joined once each; blank ones are left out.
    expect(
      startTasksFrom(
        effective(
          [tool("read")],
          [excluded("Denied by tools.deny", " ", "Denied by tools.deny", "Not included")],
        ),
      ),
    ).toEqual({ can: false, reason: "Denied by tools.deny; Not included" });
    // No reason given: none is made up.
    expect(startTasksFrom(effective([tool("read")]))).toEqual({ can: false, reason: null });
    // Denied by the session itself, the tool doesn't count.
    expect(
      startTasksFrom(effective([tool("sessions_spawn", { deniedBySession: true })])),
    ).toMatchObject({ can: false });
    // A long reason is cut to its bound.
    const long = startTasksFrom(effective([], [excluded("x".repeat(900))]));
    expect(long?.reason).toHaveLength(MAX_START_TASKS_REASON_CHARS);
  });

  it("says nothing from an answer that lists no tools", () => {
    for (const bad of [null, {}, { groups: "none" }, "tools"])
      expect(startTasksFrom(bad)).toBeNull();
  });

  it("goes by the bot's main conversation first, then its most recently read task", () => {
    const cannot = { can: false, reason: "Not included in tools.allow" };
    const can = { can: true, reason: null };
    expect(botStartTasks("pip", {})).toBeNull();
    expect(
      botStartTasks("pip", {
        "agent:pip:main": { startTasks: can, loadedAt: 1 },
        "agent:pip:deep": { startTasks: cannot, loadedAt: 9 },
      }),
    ).toEqual(can);
    expect(
      botStartTasks("pip", {
        "agent:pip:old": { startTasks: can, loadedAt: 1 },
        "agent:pip:new": { startTasks: cannot, loadedAt: 9 },
        "agent:pipe:main": { startTasks: can, loadedAt: 20 },
        "agent:marlow:main": { startTasks: can, loadedAt: 30 },
      }),
    ).toEqual(cannot);
  });

  it("is kept with the task's tools from tools.effective, and follows a change", async () => {
    const { client, gateway, transcript } = await openTask();
    let answer = effective([tool("read")], [excluded("Not included in tools.allow")]);
    gateway.handlers["tools.effective"] = () => answer;
    try {
      client.closeSession(KEY);
      client.openSession(KEY);
      await until(() => transcript()?.startTasks !== undefined);
      expect(transcript().startTasks).toEqual({
        can: false,
        reason: "Not included in tools.allow",
      });
      // The gateway's plugins changed and the tool is there now: read again, and kept.
      answer = effective([tool("read"), tool("sessions_spawn")]);
      gateway.emit("plugins.changed", { generation: 2 });
      await until(() => transcript()?.startTasks?.can === true);
      // The tool is gone again, and then only the gateway's reason changes: each is kept.
      answer = effective([tool("read")], [excluded("Not included in tools.allow")]);
      gateway.emit("plugins.changed", { generation: 4 });
      await until(() => transcript()?.startTasks?.can === false);
      answer = effective([tool("read")], [excluded("Denied by tools.deny")]);
      gateway.emit("plugins.changed", { generation: 5 });
      await until(() => transcript()?.startTasks?.reason === "Denied by tools.deny");
      // An answer that lists no tools takes the line away rather than keep an old one.
      answer = {} as typeof answer;
      gateway.emit("plugins.changed", { generation: 3 });
      await until(() => transcript()?.startTasks === undefined);
    } finally {
      client.stop();
    }
  });
});

describe("F-566 #799: a bot that has only sessions_create (OpenClaw 2026.11.10)", () => {
  it("can start tasks: either tool starts a task the person sees", () => {
    const denied = excluded("Not included in tools.allow");
    expect(startTasksFrom(effective([tool("sessions_create")], [denied]))).toEqual({
      can: true,
      reason: null,
    });
    // Denied for this session, it doesn't count; neither tool, the spawn tool's reason.
    expect(
      startTasksFrom(effective([tool("sessions_create", { deniedBySession: true })], [denied])),
    ).toEqual({ can: false, reason: "Not included in tools.allow" });
    expect(startTasksFrom(effective([tool("read")], [denied]))).toEqual({
      can: false,
      reason: "Not included in tools.allow",
    });
  });
});
