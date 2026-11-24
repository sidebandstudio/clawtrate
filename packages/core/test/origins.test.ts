// Sessions another tool opened with a bot (F-563): told apart by what the gateway records on
// the row (`origins.ts`), and kept out of the task list, its preview, unread, order, search and
// the Archived group unless "Show sessions from other tools" is on. The row shapes are the ones
// OpenClaw 2026.10.6 reported on a development gateway (docs/research/session-origins.md).

import { describe, expect, it } from "vitest";
import { parseBridgeCommand } from "../src/bridge.ts";
import { ClawtrateClient } from "../src/client.ts";
import { groupTasks, mapSessionRow } from "../src/mapping.ts";
import { isOtherToolSession } from "../src/origins.ts";
import { MAX_LISTED_TASKS } from "../src/state-bounds.ts";
import { listArchived, type TaskActionContext } from "../src/task-actions.ts";
import { INTERACTIVE_SCOPES } from "../src/scopes.ts";
import { FAST, grantingGateway, URL_A } from "./client-harness.ts";
import {
  deferred,
  FakeGateway,
  memoryStorage,
  sleep,
  testHost,
  tokenKey,
  until,
} from "./fake-gateway.ts";

const OWNER = { type: "human", id: "gateway-owner" };
/** A task made in Clawtrate: `sessions.create` with no key, by an operator. */
const CLAWTRATE = "agent:pip:dashboard:ac860166-3144-4c7f-8eb0-b6ad6caeca92";
/** An API client's session through the gateway's HTTP API, with a `user`: no `createdVia`. */
const API = "agent:pip:openai-user:probe-client";
/** A scheduled routine's custom session (`sessionTarget: "session:nightly-sync"`). */
const SCHEDULED = "agent:pip:nightly-sync";
const MAIN = "agent:pip:main";
/** A row with no provenance and no class of another surface: not placed, so listed. */
const LEGACY = "agent:pip:notes";

const rows = () => [
  {
    key: API,
    agentId: "pip",
    classification: "custom",
    lastMessagePreview: "Here is a plain reply.",
    updatedAt: 500,
    unread: true,
  },
  {
    key: SCHEDULED,
    agentId: "pip",
    createdVia: "cron",
    createdActor: { type: "system" },
    classification: "custom",
    lastMessagePreview: "Nightly sync done.",
    updatedAt: 400,
    unread: true,
  },
  {
    key: CLAWTRATE,
    agentId: "pip",
    createdVia: "operator",
    createdActor: OWNER,
    classification: "dashboard",
    label: "Trail plan",
    lastMessagePreview: "The trail is open.",
    updatedAt: 300,
  },
  {
    key: LEGACY,
    agentId: "pip",
    classification: "custom",
    lastMessagePreview: "Notes",
    updatedAt: 200,
  },
  {
    key: MAIN,
    agentId: "pip",
    createdVia: "operator",
    classification: "main",
    isMain: true,
    updatedAt: 100,
  },
];

describe("F-563: which sessions another tool opened, from the row alone", () => {
  it("is another tool's when the gateway records a run, a routine, a plugin, a voice session or its own work", () => {
    for (const via of ["run", "cron", "plugin", "talk", "internal"]) {
      expect(isOtherToolSession({ key: "agent:pip:x", createdVia: via }), via).toBe(true);
    }
  });

  it("is the person's, the bot's or a channel's when the gateway records that, whatever the key", () => {
    for (const via of ["operator", "spawn", "channel"]) {
      expect(
        isOtherToolSession({
          key: "agent:pip:openai-user:x",
          createdVia: via,
          classification: "explicit",
        }),
        via,
      ).toBe(false);
    }
  });

  it("reads the gateway's route class or an HTTP API key only when no provenance is recorded", () => {
    for (const classification of [
      "explicit",
      "tui",
      "hook",
      "node",
      "harness",
      "voice",
      "dreaming",
      "system",
      "heartbeat",
      "acp",
      "cron",
    ]) {
      expect(isOtherToolSession({ key: "agent:pip:x", classification }), classification).toBe(true);
    }
    for (const key of [
      "agent:pip:openai-user:client-1",
      "agent:pip:openai:5f1c6a0e-0000-4000-8000-000000000000",
      "agent:pip:openresponses-user:c",
      "agent:pip:openresponses:5f1c",
    ]) {
      expect(isOtherToolSession({ key }), key).toBe(true);
    }
    expect(isOtherToolSession({ sessionKey: "agent:pip:openai-user:c" })).toBe(true);
    // A blank key gives way to the session key, as the list reads a row's key.
    const blank = { key: " ", sessionKey: "agent:pip:openai-user:c", agentId: "pip" };
    expect(isOtherToolSession(blank)).toBe(true);
    expect(groupTasks([blank], {}).pip ?? []).toEqual([]);
  });

  it("never the bot's main session, nor a row Clawtrate can't place", () => {
    // A main session the gateway names main: what started its latest turn does not matter.
    expect(isOtherToolSession({ key: MAIN, classification: "main", createdVia: "cron" })).toBe(
      false,
    );
    expect(isOtherToolSession({ key: MAIN, createdVia: "run" })).toBe(false);
    expect(isOtherToolSession({ key: "agent:pip:x", isMain: true, createdVia: "run" })).toBe(false);
    for (const row of [
      { key: LEGACY, classification: "custom" },
      { key: "agent:pip:direct:u1", classification: "direct" },
      { key: CLAWTRATE, classification: "dashboard" },
      { key: "agent:pip:x", createdVia: "a-newer-kind" },
      { key: "agent:pip:openaiish:x" },
      { key: "agent:pip:notes:openai-user:x" },
      { key: "openai-user:x" },
      {},
    ]) {
      expect(isOtherToolSession(row), JSON.stringify(row)).toBe(false);
    }
  });

  it("marks the task, and groupTasks leaves it out unless asked", () => {
    expect(mapSessionRow(rows()[0]!)).toMatchObject({ key: API, otherTool: true });
    expect(mapSessionRow(rows()[2]!)).not.toHaveProperty("otherTool");
    const keys = (options: Parameters<typeof groupTasks>[1]) =>
      (groupTasks(rows(), options).pip ?? []).map((task) => task.key);
    expect(keys({})).toEqual([CLAWTRATE, LEGACY, MAIN]);
    expect(keys({ showOtherToolSessions: true })).toEqual([
      API,
      SCHEDULED,
      CLAWTRATE,
      LEGACY,
      MAIN,
    ]);
  });
});

/** A client on the gateway: paired at the read tier, or with `interactive` holding the scopes to answer. */
async function connected(
  saved: Record<string, string> = {},
  listed: Record<string, unknown>[] = rows(),
  interactive = false,
) {
  const gateway = interactive ? grantingGateway() : new FakeGateway();
  gateway.handlers["sessions.subscribe"] = () => ({
    subscribed: true,
    list: { sessions: listed, hasMore: false },
  });
  gateway.handlers["sessions.list"] = () => ({ sessions: listed, hasMore: false });
  const paired = {
    connection: JSON.stringify({ url: URL_A, token: null }),
    [tokenKey(URL_A)]: JSON.stringify({
      token: "device-token",
      grantedScopes: INTERACTIVE_SCOPES,
      heldScopes: INTERACTIVE_SCOPES,
    }),
  };
  const storage = memoryStorage(interactive ? { ...paired, ...saved } : saved);
  const client = new ClawtrateClient(testHost(gateway, storage), FAST);
  await client.start();
  if (!interactive) await client.connect({ url: URL_A, token: "bootstrap" });
  await until(() => client.state.discovery.status === "ready");
  const keys = () => (client.state.tasksByBot.pip ?? []).map((task) => task.key);
  return { client, gateway, storage, keys };
}

describe("F-563: Show sessions from other tools", () => {
  it("F-563: off by default: other tools' sessions are not listed, and the bot's preview, unread and order are its own tasks'", async () => {
    const { client, keys } = await connected();
    expect(client.state.showOtherToolSessions).toBe(false);
    expect(keys()).toEqual([CLAWTRATE, LEGACY, MAIN]);
    // The newest of the bot's tasks, and so its preview and its time in the sidebar's order.
    const [latest] = client.state.tasksByBot.pip!;
    expect(latest).toMatchObject({ key: CLAWTRATE, preview: "The trail is open.", updatedAt: 300 });
    expect(client.state.tasksByBot.pip!.some((task) => task.unread)).toBe(false);
    client.stop();
  });

  it("F-563: turning it on lists them at once, without reading the list again, and the choice is kept", async () => {
    const { client, gateway, storage, keys } = await connected();
    const reads =
      gateway.calls("sessions.list").length + gateway.calls("sessions.subscribe").length;
    await client.setShowOtherToolSessions(true);
    expect(client.state.showOtherToolSessions).toBe(true);
    expect(keys()).toEqual([API, SCHEDULED, CLAWTRATE, LEGACY, MAIN]);
    expect(client.state.tasksByBot.pip![0]).toMatchObject({ otherTool: true, unread: true });
    expect(storage.data.get("show-other-tool-sessions")).toBe("true");
    await client.setShowOtherToolSessions(false);
    expect(keys()).toEqual([CLAWTRATE, LEGACY, MAIN]);
    await sleep(300);
    expect(gateway.calls("sessions.list").length + gateway.calls("sessions.subscribe").length).toBe(
      reads,
    );
    client.stop();

    const again = await connected({ "show-other-tool-sessions": "true" });
    expect(again.client.state.showOtherToolSessions).toBe(true);
    expect(again.keys()).toEqual([API, SCHEDULED, CLAWTRATE, LEGACY, MAIN]);
    again.client.stop();
  });

  it("F-563: the two switches are independent", async () => {
    const discord = {
      key: "agent:pip:discord:channel:1",
      agentId: "pip",
      channel: "discord",
      updatedAt: 600,
    };
    const { client, keys } = await connected({}, [...rows(), discord]);
    await client.setShowChannelChats(true);
    expect(keys()).toEqual([discord.key, CLAWTRATE, LEGACY, MAIN]);
    await client.setShowOtherToolSessions(true);
    await client.setShowChannelChats(false);
    expect(keys()).toEqual([API, SCHEDULED, CLAWTRATE, LEGACY, MAIN]);
    client.stop();
  });

  it("F-563: what the person sets while startup reads the preferences stays", async () => {
    const storage = memoryStorage({ "show-other-tool-sessions": "false" });
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    const get = storage.get;
    storage.get = async (read) => {
      const value = await get(read);
      if (read === "show-other-tool-sessions" && !held) {
        held = true;
        await gate;
      }
      return value;
    };
    const client = new ClawtrateClient(testHost(new FakeGateway(), storage), FAST);
    try {
      const starting = client.start();
      await until(() => held);
      await client.setShowOtherToolSessions(true);
      release();
      await starting;
      expect(client.state.showOtherToolSessions).toBe(true);
      expect(storage.data.get("show-other-tool-sessions")).toBe("true");
    } finally {
      release();
      client.stop();
    }
  });

  it("F-563: a choice the host could not keep is not taken", async () => {
    const { client, storage, keys } = await connected();
    storage.set = () => Promise.reject(new Error("The disk is full."));
    await expect(client.setShowOtherToolSessions(true)).rejects.toThrow("The disk is full.");
    expect(client.state.showOtherToolSessions).toBe(false);
    expect(keys()).toEqual([CLAWTRATE, LEGACY, MAIN]);
    client.stop();
  });

  it("F-563: a sessions.changed event that records another tool moves a task out of the list, and back when shown", async () => {
    const { client, gateway, keys } = await connected();
    gateway.emit("sessions.changed", {
      sessionKey: LEGACY,
      agentId: "pip",
      createdVia: "run",
      lastMessagePreview: "From a script",
      updatedAt: 900,
    });
    await until(() => !keys().includes(LEGACY));
    expect(client.state.tasksByBot.pip![0]!.key).toBe(CLAWTRATE);
    await client.setShowOtherToolSessions(true);
    expect(client.state.tasksByBot.pip![0]).toMatchObject({ key: LEGACY, otherTool: true });
    client.stop();
  });

  it("F-563: the client keeps the row's createdVia", async () => {
    const { client } = await connected();
    await client.setShowOtherToolSessions(true);
    expect(client.state.tasksByBot.pip!.find((task) => task.key === SCHEDULED)?.otherTool).toBe(
      true,
    );
    client.stop();
  });

  it("F-563: a change in another tool's session the cap could not keep does not read the whole list again", async () => {
    const own = Array.from({ length: MAX_LISTED_TASKS }, (_, index) => ({
      key: `agent:pip:dashboard:${String(index).padStart(8, "0")}-0000`,
      agentId: "pip",
      createdVia: "operator",
      updatedAt: 1_000 + index,
    }));
    const { client, gateway } = await connected({}, own);
    const reads = () => gateway.calls("sessions.list").length;
    const before = reads();
    gateway.emit("sessions.changed", {
      sessionKey: "agent:pip:openai-user:busy-client",
      agentId: "pip",
      updatedAt: 99_999,
    });
    await sleep(400);
    expect(reads()).toBe(before);
    gateway.emit("sessions.changed", { sessionKey: "agent:pip:dashboard:new-one", agentId: "pip" });
    await until(() => reads() > before);
    client.stop();
  });

  it("F-563: a hidden session of another tool that asks the person something is listed while it waits", async () => {
    const { client, gateway, keys } = await connected({}, rows(), true);
    expect(keys()).not.toContain(API);
    gateway.emit("question.requested", {
      id: "q1",
      sessionKey: API,
      runId: "r1",
      createdAtMs: 600,
    });
    await until(() => keys().includes(API));
    expect(client.state.tasksByBot.pip!.find((task) => task.key === API)?.status).toBe("waiting");
    gateway.emit("question.resolved", { id: "q1" });
    await until(() => !keys().includes(API));
    client.stop();
  });

  it("F-563: a hidden session of another tool with a pending approval is listed while it waits, though no task is open", async () => {
    const { client, gateway, keys } = await connected({}, rows(), true);
    expect(keys()).not.toContain(API);
    // A plugin's approval, with no lifecycle event: it is routed to no open task.
    gateway.emit("plugin.approval.requested", {
      id: "pa1",
      request: { title: "Send the report", description: "To the team", sessionKey: API },
      createdAtMs: 600,
      expiresAtMs: 9_999_999_999_999,
    });
    await until(() => keys().includes(API));
    expect(client.state.tasksByBot.pip!.find((task) => task.key === API)?.status).toBe("waiting");
    gateway.emit("plugin.approval.resolved", { id: "pa1", decision: "allow-once" });
    await until(() => !keys().includes(API));
    client.stop();
  });

  it("F-563: a waiting session the 500-row cap left out is read back and kept ahead of the person's own tasks, and gives the place back once answered", async () => {
    const own = Array.from({ length: MAX_LISTED_TASKS }, (_, index) => ({
      key: `agent:pip:dashboard:${String(index).padStart(8, "0")}-0000`,
      agentId: "pip",
      createdVia: "operator",
      updatedAt: 1_000 + index,
    }));
    const api = { ...rows()[0]!, updatedAt: 99_999 };
    const { client, gateway, keys } = await connected({}, [...own, api], true);
    // Another tool's session gives way to the person's own tasks at the cap.
    expect(keys()).not.toContain(API);
    expect(keys()).toHaveLength(MAX_LISTED_TASKS);
    const reads = gateway.calls("sessions.list").length;
    gateway.emit("exec.approval.requested", {
      id: "ap-api",
      request: {
        command: "uname -s",
        host: "gateway",
        agentId: "pip",
        sessionKey: API,
        runId: "r1",
        allowedDecisions: ["allow-once", "deny"],
      },
      createdAtMs: 100_000,
      expiresAtMs: 9_000_000_000_000,
    });
    await until(() => keys().includes(API));
    expect(gateway.calls("sessions.list").length).toBeGreaterThan(reads);
    expect(keys()).toHaveLength(MAX_LISTED_TASKS);
    expect(client.state.tasksByBot.pip!.find((task) => task.key === API)?.status).toBe("waiting");
    // It took the oldest of the person's tasks' place while it waits, and no longer.
    expect(keys()).not.toContain(own[0]!.key);
    gateway.emit("exec.approval.resolved", { id: "ap-api", decision: "allow-once" });
    await until(() => keys().includes(own[0]!.key));
    expect(keys()).not.toContain(API);
    expect(keys()).toHaveLength(MAX_LISTED_TASKS);
    client.stop();
  });

  it("F-563: a session that starts waiting while a list read is under way is read again if that read cut it", async () => {
    const own = Array.from({ length: MAX_LISTED_TASKS }, (_, index) => ({
      key: `agent:pip:dashboard:${String(index).padStart(8, "0")}-0000`,
      agentId: "pip",
      createdVia: "operator",
      updatedAt: 1_000 + index,
    }));
    const api = { ...rows()[0]!, updatedAt: 99_999 };
    // Held at connect, while the person's tasks leave room.
    const { client, gateway, keys } = await connected({}, [...own.slice(1), api], true);
    await client.setShowOtherToolSessions(true);
    expect(keys()).toContain(API);
    await client.setShowOtherToolSessions(false);
    // The next read's first page cuts it, as the person's tasks now fill the list; its second
    // page is held until the session starts waiting.
    const second = deferred<unknown>();
    let pages = 0;
    gateway.handlers["sessions.list"] = (params) => {
      if ((params as { offset?: number }).offset === undefined)
        return { sessions: [api, ...own], hasMore: true, nextOffset: own.length + 1 };
      pages += 1;
      return pages === 1 ? second.promise : { sessions: [], hasMore: false };
    };
    gateway.emit("sessions.changed", { sessionKey: "agent:pip:dashboard:new-one", agentId: "pip" });
    await until(() => pages === 1);
    gateway.emit("exec.approval.requested", {
      id: "ap-api",
      request: {
        command: "uname -s",
        host: "gateway",
        agentId: "pip",
        sessionKey: API,
        runId: "r1",
        allowedDecisions: ["allow-once", "deny"],
      },
      createdAtMs: 100_000,
      expiresAtMs: 9_000_000_000_000,
    });
    await sleep(50);
    // That read ends without the session; one more read brings it in.
    second.resolve({ sessions: [], hasMore: false });
    await until(() => keys().includes(own[0]!.key));
    await until(() => keys().includes(API) && !keys().includes(own[0]!.key));
    expect(client.state.tasksByBot.pip!.find((task) => task.key === API)?.status).toBe("waiting");
    client.stop();
  });

  it("F-563: an open session stays listed when the switch goes off or its question is answered, until it is left", async () => {
    const { client, gateway, keys } = await connected({}, rows(), true);
    gateway.handlers["chat.history"] = () => ({ messages: [] });
    gateway.handlers["question.list"] = () => ({ questions: [] });
    for (const method of ["exec.approval.list", "plugin.approval.list", "openclaw.approval.list"])
      gateway.handlers[method] = () => [];
    await client.setShowOtherToolSessions(true);
    client.openSession(API);
    await client.setShowOtherToolSessions(false);
    expect(keys()).toContain(API);
    expect(keys()).not.toContain(SCHEDULED);
    client.closeSession(API);
    expect(keys()).not.toContain(API);
    // Opened while it waits, answering it does not take it from the list.
    gateway.emit("question.requested", {
      id: "q1",
      sessionKey: API,
      runId: "r1",
      createdAtMs: 600,
    });
    await until(() => keys().includes(API));
    client.openSession(API);
    gateway.emit("question.resolved", { id: "q1" });
    await until(
      () => client.state.tasksByBot.pip!.find((task) => task.key === API)?.status !== "waiting",
    );
    expect(keys()).toContain(API);
    client.closeSession(API);
    expect(keys()).not.toContain(API);
    client.stop();
  });

  it("F-563: an open session of another tool keeps its place when a new task fills the list, and gives it back once left", async () => {
    const own = Array.from({ length: MAX_LISTED_TASKS - 1 }, (_, index) => ({
      key: `agent:pip:dashboard:${String(index).padStart(8, "0")}-0000`,
      agentId: "pip",
      createdVia: "operator",
      updatedAt: 1_000 + index,
    }));
    const listed: Record<string, unknown>[] = [...own, { ...rows()[0]!, updatedAt: 99_999 }];
    const { client, gateway, keys } = await connected({}, listed, true);
    gateway.handlers["chat.history"] = () => ({ messages: [] });
    gateway.handlers["sessions.create"] = () => {
      listed.push({
        key: "agent:pip:dashboard:new-task",
        agentId: "pip",
        createdVia: "operator",
        updatedAt: 200_000,
      });
      return { key: "agent:pip:dashboard:new-task", entry: { updatedAt: 200_000 } };
    };
    client.openSession(API);
    expect(keys()).toContain(API);
    await client.newTask("pip");
    await until(() => keys().includes("agent:pip:dashboard:new-task"));
    expect(keys()).toContain(API);
    expect(keys()).toHaveLength(MAX_LISTED_TASKS);
    client.closeSession(API);
    await until(() => keys().includes(own[0]!.key));
    expect(keys()).not.toContain(API);
    client.stop();
  });

  it("F-563: the person's own open task kept at a full list gives the place back once left", async () => {
    const listed: Record<string, unknown>[] = Array.from(
      { length: MAX_LISTED_TASKS },
      (_, index) => ({
        key: `agent:pip:dashboard:${String(index).padStart(8, "0")}-0000`,
        agentId: "pip",
        createdVia: "operator",
        updatedAt: 1_000 + index,
      }),
    );
    const [oldest, next] = listed.map((row) => row.key as string);
    const { client, gateway, keys } = await connected({}, [...listed], true);
    gateway.handlers["chat.history"] = () => ({ messages: [] });
    gateway.handlers["sessions.list"] = () => ({ sessions: listed, hasMore: false });
    gateway.handlers["sessions.create"] = () => {
      listed.push({
        key: "agent:pip:dashboard:new-task",
        agentId: "pip",
        createdVia: "operator",
        updatedAt: 200_000,
      });
      return { key: "agent:pip:dashboard:new-task", entry: { updatedAt: 200_000 } };
    };
    client.openSession(oldest!);
    await client.newTask("pip");
    // The open one keeps its place; the next oldest gives way while it is open.
    expect(keys()).toContain(oldest);
    expect(keys()).not.toContain(next);
    client.closeSession(oldest!);
    await until(() => keys().includes(next!));
    expect(keys()).not.toContain(oldest);
    expect(keys()).toHaveLength(MAX_LISTED_TASKS);
    client.stop();
  });

  it("F-563: search results are filtered by the switches as they are when the results arrive", async () => {
    const { client, gateway } = await connected();
    await client.setShowChannelChats(true);
    await client.setShowOtherToolSessions(true);
    const reply = deferred<unknown>();
    gateway.handlers["sessions.search"] = () => reply.promise;
    const found = client.searchMessages("trail", null);
    await until(() => gateway.calls("sessions.search").length === 1);
    await client.setShowOtherToolSessions(false);
    reply.resolve({
      results: [API, CLAWTRATE].map((sessionKey) => ({
        sessionKey,
        sessionId: "s",
        messageId: `m-${sessionKey}`,
        role: "user",
        timestamp: 1,
        snippet: "trail",
      })),
    });
    expect((await found).hits.map((hit) => hit.sessionKey)).toEqual([CLAWTRATE]);
    client.stop();
  });

  it("F-563: message search leaves out another tool's sessions, and shows them when on", async () => {
    const { client, gateway } = await connected();
    const hit = (sessionKey: string) => ({
      sessionKey,
      sessionId: "s",
      messageId: `m-${sessionKey}`,
      role: "user",
      timestamp: 1,
      snippet: "trail",
    });
    // A routine's custom session the list does not hold, which the reply's row places; a session
    // with no row anywhere, which is shown, as the list shows a row it can't place.
    const routine = "agent:pip:weekly-report";
    const unknown = "agent:pip:openai:not-held";
    gateway.handlers["sessions.search"] = () => ({
      results: [hit(API), hit(CLAWTRATE), hit(SCHEDULED), hit(routine), hit(unknown)],
      sessions: [
        { key: routine, agentId: "pip", createdVia: "cron", classification: "custom" },
        { key: API, agentId: "pip", classification: "custom" },
      ],
    });
    const keys = async () =>
      (await client.searchMessages("trail", null)).hits.map((each) => each.sessionKey);
    expect(await keys()).toEqual([CLAWTRATE, unknown]);
    await client.setShowOtherToolSessions(true);
    expect(await keys()).toEqual([API, CLAWTRATE, SCHEDULED, routine, unknown]);
    client.stop();
  });

  it("F-563: the Archived group leaves other tools' sessions out unless they are shown", async () => {
    const archived = rows().map((row) => ({ ...row, archived: true, archivedAt: row.updatedAt }));
    const ctx = {
      request: () => Promise.resolve({ sessions: archived, hasMore: false }),
    } as unknown as TaskActionContext;
    const listed = async (showOtherToolSessions: boolean) =>
      (await listArchived(ctx, "pip", { showOtherToolSessions })).tasks.map((task) => task.key);
    expect(await listed(false)).not.toContain(API);
    expect(await listed(false)).not.toContain(SCHEDULED);
    expect(await listed(false)).toContain(CLAWTRATE);
    expect(await listed(true)).toEqual(expect.arrayContaining([API, SCHEDULED, CLAWTRATE]));
  });

  it("F-563: the bridge takes the setting only as true or false", () => {
    expect(parseBridgeCommand({ type: "setShowOtherToolSessions", on: true })).toEqual({
      type: "setShowOtherToolSessions",
      on: true,
    });
    expect(() => parseBridgeCommand({ type: "setShowOtherToolSessions", on: "yes" })).toThrow(
      "invalid other tools setting",
    );
  });
});
