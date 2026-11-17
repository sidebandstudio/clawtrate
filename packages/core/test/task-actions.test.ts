import { describe, expect, it } from "vitest";
import {
  ActiveRunError,
  archiveParams,
  archiveTask,
  archivedListParams,
  deleteParams,
  deleteTask,
  listArchived,
  mapArchivedRow,
  markTask,
  MAX_ARCHIVED_LISTED,
  newMainTask,
  newTask,
  newTaskParams,
  pinParams,
  renameParams,
  renameTask,
  restoreTask,
  STOP_SETTLE_MS,
  taskLabel,
  unreadParams,
  type TaskActionContext,
} from "../src/task-actions.ts";

// The gateway's own rules for what `operator.write` may send, copied from
// OpenClaw 2026.10.6 (`dist/session-method-scopes-base-CuhU2F_D.mjs`,
// `SESSIONS_PATCH_WRITE_SCOPE_MUTATIONS`, `SESSIONS_PATCH_WRITE_SCOPE_ENVELOPE_FIELDS`,
// `SESSIONS_DELETE_WRITE_SCOPE_FIELDS` and the three `resolve…RequiredScope`).
const PATCH_MUTATIONS = new Set([
  "label",
  "autoLabel",
  "icon",
  "color",
  "category",
  "boardFace",
  "boardPresentation",
  "pinned",
  "archived",
  "snoozedUntil",
  "unread",
  "model",
  "agentRuntime",
  "thinkingLevel",
  "fastMode",
  "permissionMode",
]);
const PATCH_ENVELOPE = new Set([
  "key",
  "agentId",
  "expectedSessionId",
  "expectedLifecycleRevision",
  "expectedPermissionMode",
  "expectedMarkedUnreadAt",
]);
const DELETE_FIELDS = new Set([
  "key",
  "agentId",
  "deleteTranscript",
  "expectedSessionId",
  "archivedOnly",
]);
function patchScope(params: Record<string, unknown>): string {
  if (params.permissionMode === "full" || Object.hasOwn(params, "sandboxMode"))
    return "operator.admin";
  return Object.keys(params).every((key) => PATCH_ENVELOPE.has(key) || PATCH_MUTATIONS.has(key))
    ? "operator.write"
    : "operator.admin";
}
function createScope(params: Record<string, unknown>): string {
  return params.incognito === true ||
    Object.hasOwn(params, "execNode") ||
    Object.hasOwn(params, "toolOverrides") ||
    params.permissionMode === "full"
    ? "operator.admin"
    : "operator.write";
}
function deleteScope(params: Record<string, unknown>): string {
  if (params.archivedOnly !== true) return "operator.admin";
  return Object.keys(params).every((key) => DELETE_FIELDS.has(key))
    ? "operator.write"
    : "operator.admin";
}

const KEY = "agent:pip:dashboard:0f0e0d0c-aaaa-bbbb-cccc-000000000001";

/** A gateway answering from a table of rows, recording every call in order. */
function fakeGateway(rows: Record<string, Record<string, unknown>>) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let clock = 0;
  let written = false;
  let mainMade = false;
  let mark = "idle";
  const ctx: TaskActionContext = {
    request: async (method, raw) => {
      const params = raw as Record<string, unknown>;
      calls.push({ method, params });
      const key = params.key as string;
      switch (method) {
        case "sessions.describe":
          return { session: rows[key] ? { key, ...rows[key] } : null };
        case "chat.abort":
          // The run settles after two more reads.
          setTimeout(() => {}, 0);
          return { ok: true, aborted: true };
        case "sessions.patch":
          if (typeof params.label === "string" && params.label === "Taken")
            throw new Error("label already in use: Taken");
          if (rows[key])
            Object.assign(rows[key], { archived: params.archived ?? rows[key].archived });
          return { ok: true };
        case "sessions.delete":
          delete rows[key];
          return { ok: true, deleted: true };
        case "sessions.create": {
          const label = params.label as string | undefined;
          if (label === "Main" || label === "Main 2")
            throw new Error(`label already in use: ${label}`);
          return {
            ok: true,
            key: "agent:pip:dashboard:new",
            sessionId: "s-new",
            entry: { sessionId: "s-new", label, updatedAt: 5, createdAt: 5, secret: "x" },
          };
        }
        default:
          return {};
      }
    },
    ensureWrite: async () => {
      written = true;
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    runMark: () => mark,
  };
  return { ctx, calls, wrote: () => written, setMark: (next: string) => (mark = next) };
}

describe("the rail's task actions", () => {
  it("F-054 F-056 F-277 F-278 F-022: every call they make stays at operator.write", () => {
    expect(createScope(newTaskParams("pip", null))).toBe("operator.write");
    expect(createScope(newTaskParams("pip", "Main"))).toBe("operator.write");
    expect(patchScope(renameParams(KEY, "Weekly plan"))).toBe("operator.write");
    expect(patchScope(pinParams(KEY, true))).toBe("operator.write");
    expect(patchScope(unreadParams(KEY, true))).toBe("operator.write");
    expect(patchScope(unreadParams(KEY, false, null))).toBe("operator.write");
    expect(patchScope(unreadParams(KEY, false, 1234))).toBe("operator.write");
    expect(patchScope(archiveParams(KEY, "s-1", true))).toBe("operator.write");
    expect(patchScope(archiveParams(KEY, "s-1", false))).toBe("operator.write");
    expect(deleteScope(deleteParams(KEY, "s-1"))).toBe("operator.write");
    // And the rule itself: one admin field makes a label edit admin.
    expect(patchScope({ ...renameParams(KEY, "x"), expectedToolOverrides: null })).toBe(
      "operator.admin",
    );
  });

  it("names a task with one trimmed line, and refuses an empty or overlong name", () => {
    expect(taskLabel("  Weekly \n plan ")).toBe("Weekly plan");
    expect(() => taskLabel("   ")).toThrow("A task needs a name.");
    expect(() => taskLabel("x".repeat(513))).toThrow("at most 512");
  });

  it("F-054: a new task asks for write first, then creates it empty, answering its key and a row of known fields only", async () => {
    const { ctx, calls, wrote } = fakeGateway({});
    const created = await newTask(ctx, "pip", null);
    expect(wrote()).toBe(true);
    expect(calls).toEqual([{ method: "sessions.create", params: { agentId: "pip" } }]);
    expect(created).toEqual({
      key: "agent:pip:dashboard:new",
      row: {
        key: "agent:pip:dashboard:new",
        agentId: "pip",
        sessionId: "s-new",
        updatedAt: 5,
        createdAt: 5,
      },
    });
  });

  it("F-424: a bot's replacement first task is Main, or the next free Main", async () => {
    const { ctx, calls } = fakeGateway({});
    await newMainTask(ctx, "pip");
    expect(calls.map((call) => call.params.label)).toEqual(["Main", "Main 2", "Main 3"]);
  });

  it("F-056: a rename taken by another task of the bot says so in the person's words", async () => {
    const { ctx } = fakeGateway({ [KEY]: { sessionId: "s-1" } });
    await expect(renameTask(ctx, KEY, "Taken")).rejects.toThrow(
      'Another task of this bot is already called "Taken".',
    );
  });

  it("F-022: Mark as unread sends unread alone; a read on opening names the marker it saw", async () => {
    const { ctx, calls } = fakeGateway({});
    await markTask(ctx, KEY, true);
    await markTask(ctx, KEY, false, 1700);
    await markTask(ctx, KEY, false, null);
    expect(calls.map((call) => call.params)).toEqual([
      { key: KEY, unread: true },
      { key: KEY, unread: false, expectedMarkedUnreadAt: 1700 },
      { key: KEY, unread: false, expectedMarkedUnreadAt: null },
    ]);
  });

  it("F-277: archiving names the session it is meant for", async () => {
    const { ctx, calls } = fakeGateway({ [KEY]: { sessionId: "s-1", hasActiveRun: false } });
    await archiveTask(ctx, KEY, { stop: false });
    expect(calls.at(-1)).toEqual({
      method: "sessions.patch",
      params: { key: KEY, archived: true, expectedSessionId: "s-1" },
    });
  });

  it("F-277: a run that starts while Archive checks is not stopped: nothing is archived and the person is asked", async () => {
    const gateway = fakeGateway({ [KEY]: { sessionId: "s-1", hasActiveRun: false } });
    const request = gateway.ctx.request;
    gateway.ctx.request = async (method, params) => {
      const answer = await request(method, params);
      // Another device starts a run just after the gateway described the task as idle.
      if (method === "sessions.describe") gateway.setMark("run-2");
      return answer;
    };
    await expect(archiveTask(gateway.ctx, KEY, { stop: false })).rejects.toBeInstanceOf(
      ActiveRunError,
    );
    expect(gateway.calls.map((call) => call.method)).toEqual(["sessions.describe"]);
  });

  it("F-277: a task whose run is active is not archived without Stop, and nothing is asked of it", async () => {
    const { ctx, calls } = fakeGateway({ [KEY]: { sessionId: "s-1", hasActiveRun: true } });
    await expect(archiveTask(ctx, KEY, { stop: false })).rejects.toBeInstanceOf(ActiveRunError);
    expect(calls.map((call) => call.method)).toEqual(["sessions.describe"]);
  });

  it("F-277: Stop and archive stops the run, waits for the gateway to say it stopped, then archives", async () => {
    const rows: Record<string, Record<string, unknown>> = {
      [KEY]: { sessionId: "s-1", hasActiveRun: true },
    };
    const { ctx, calls } = fakeGateway(rows);
    let reads = 0;
    const request = ctx.request;
    ctx.request = async (method, params) => {
      if (method === "sessions.describe" && ++reads === 3) rows[KEY]!.hasActiveRun = false;
      return request(method, params);
    };
    await archiveTask(ctx, KEY, { stop: true });
    expect(calls.map((call) => call.method)).toEqual([
      "sessions.describe",
      "chat.abort",
      "sessions.describe",
      "sessions.describe",
      "sessions.patch",
    ]);
    expect(calls[1]!.params).toEqual({ sessionKey: KEY });
  });

  it("F-278: a run that does not stop within its deadline leaves the task as it was", async () => {
    const { ctx, calls } = fakeGateway({ [KEY]: { sessionId: "s-1", hasActiveRun: true } });
    await expect(deleteTask(ctx, KEY)).rejects.toThrow("did not stop in time");
    expect(calls.some((call) => call.method === "sessions.patch")).toBe(false);
    expect(calls.some((call) => call.method === "sessions.delete")).toBe(false);
    expect(calls.filter((call) => call.method === "sessions.describe").length).toBeGreaterThan(
      STOP_SETTLE_MS / 1000,
    );
  });

  it("F-278: delete stops an active run first, archives, then deletes with its transcript", async () => {
    const rows: Record<string, Record<string, unknown>> = {
      [KEY]: { sessionId: "s-1", hasActiveRun: true },
    };
    const { ctx, calls } = fakeGateway(rows);
    const request = ctx.request;
    ctx.request = async (method, params) => {
      if (method === "chat.abort") rows[KEY]!.hasActiveRun = false;
      return request(method, params);
    };
    await deleteTask(ctx, KEY);
    expect(calls.map((call) => call.method)).toEqual([
      "sessions.describe",
      "chat.abort",
      "sessions.describe",
      "sessions.patch",
      "sessions.delete",
    ]);
    expect(calls.at(-1)!.params).toEqual({
      key: KEY,
      archivedOnly: true,
      deleteTranscript: true,
      expectedSessionId: "s-1",
    });
  });

  it("F-278: an archived task is deleted without archiving again; a gone one is left alone", async () => {
    const { ctx, calls } = fakeGateway({ [KEY]: { sessionId: "s-1", archived: true } });
    await deleteTask(ctx, KEY);
    expect(calls.map((call) => call.method)).toEqual(["sessions.describe", "sessions.delete"]);
    await deleteTask(ctx, KEY);
    expect(calls.at(-1)!.method).toBe("sessions.describe");
  });

  it("F-277: restore names the session and does nothing to a task that is not archived", async () => {
    const { ctx, calls } = fakeGateway({ [KEY]: { sessionId: "s-1", archived: true } });
    await restoreTask(ctx, KEY);
    expect(calls.at(-1)!.params).toEqual({ key: KEY, archived: false, expectedSessionId: "s-1" });
    const before = calls.length;
    await restoreTask(ctx, KEY);
    expect(calls.length).toBe(before + 1);
  });

  it("F-277: the Archived group lists one bot's archived rows, newest archive first, at most fifty", async () => {
    expect(archivedListParams("pip")).toMatchObject({ agentId: "pip", archived: true });
    const rows = Array.from({ length: MAX_ARCHIVED_LISTED + 5 }, (_, index) => ({
      key: `agent:pip:dashboard:${String(index).padStart(8, "0")}-0000`,
      agentId: "pip",
      sessionId: `s-${index}`,
      label: `Task ${index}`,
      archived: true,
      archivedAt: 1000 + index,
    }));
    rows.push({ ...rows[0]!, key: "agent:otto:x", agentId: "otto" });
    rows.push({ ...rows[0]!, key: "agent:pip:live", archived: false } as never);
    const ctx = {
      request: async () => ({ sessions: rows, hasMore: false }),
      ensureWrite: async () => {},
      now: () => 0,
      sleep: async () => {},
      runMark: () => "",
    };
    const listed = await listArchived(ctx, "pip");
    expect(listed.tasks).toHaveLength(MAX_ARCHIVED_LISTED);
    expect(listed.more).toBe(true);
    expect(listed.tasks[0]!.title).toBe(`Task ${MAX_ARCHIVED_LISTED + 4}`);
    expect(listed.tasks.every((task) => task.botId === "pip")).toBe(true);
    expect(
      mapArchivedRow({ key: "agent:pip:dashboard:abcdef12-3456", archived: true }, "pip"),
    ).toMatchObject({
      title: "New task",
    });
  });
});
