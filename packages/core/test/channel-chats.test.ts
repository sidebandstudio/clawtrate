// "Show external channel chats" (F-519) through the client: off by default, kept by the host,
// applied to rows already held without reading the list again, and to rows a `sessions.changed`
// event classifies. The row shapes are the ones OpenClaw 2026.10.6 reported (channels.test.ts).

import { describe, expect, it } from "vitest";
import { parseBridgeCommand } from "../src/bridge.ts";
import { ClawtrateClient } from "../src/client.ts";
import { MAX_LISTED_TASKS } from "../src/state-bounds.ts";
import { listArchived, MAX_ARCHIVED_LISTED, type TaskActionContext } from "../src/task-actions.ts";
import { INTERACTIVE_SCOPES } from "../src/scopes.ts";
import { FAST, grantingGateway, questionRecord, URL_A } from "./client-harness.ts";
import { FakeGateway, memoryStorage, sleep, testHost, tokenKey, until } from "./fake-gateway.ts";

const DISCORD = "agent:pip:discord:channel:1234567890";
const NATIVE = "agent:pip:dashboard:0f6c2a9e-1111";
const MAIN = "agent:pip:main";

const rows = () => [
  {
    key: DISCORD,
    agentId: "pip",
    channel: "discord",
    classification: "channel",
    displayName: "discord:g-1234567890",
    lastMessagePreview: "From the server",
    updatedAt: 300,
    unread: true,
  },
  {
    key: NATIVE,
    agentId: "pip",
    label: "Disk space",
    lastMessagePreview: "Freed 4 GB",
    updatedAt: 200,
  },
  // The main session after a Telegram direct message: its channel sticks.
  {
    key: MAIN,
    agentId: "pip",
    channel: "telegram",
    lastChannel: "telegram",
    classification: "main",
    isMain: true,
    updatedAt: 100,
  },
];

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

describe("F-519: Show external channel chats", () => {
  it("F-519: off by default: channel chats are not listed, and the bot's preview and unread are its own tasks'", async () => {
    const { client, keys } = await connected();
    expect(client.state.showChannelChats).toBe(false);
    expect(keys()).toEqual([NATIVE, MAIN]);
    const [latest] = client.state.tasksByBot.pip!;
    expect(latest!.preview).toBe("Freed 4 GB");
    expect(client.state.tasksByBot.pip!.some((task) => task.unread)).toBe(false);
    client.stop();
  });

  it("F-519: turning it on lists them at once, without reading the list again, and the choice is kept", async () => {
    const { client, gateway, storage, keys } = await connected();
    const reads =
      gateway.calls("sessions.list").length + gateway.calls("sessions.subscribe").length;
    await client.setShowChannelChats(true);
    expect(client.state.showChannelChats).toBe(true);
    expect(keys()).toEqual([DISCORD, NATIVE, MAIN]);
    expect(client.state.tasksByBot.pip![0]).toMatchObject({ title: "Discord chat", unread: true });
    expect(storage.data.get("show-channel-chats")).toBe("true");
    await client.setShowChannelChats(false);
    expect(keys()).toEqual([NATIVE, MAIN]);
    await sleep(300);
    expect(gateway.calls("sessions.list").length + gateway.calls("sessions.subscribe").length).toBe(
      reads,
    );
    client.stop();

    const again = await connected({ "show-channel-chats": "true" });
    expect(again.client.state.showChannelChats).toBe(true);
    expect(again.keys()).toEqual([DISCORD, NATIVE, MAIN]);
    again.client.stop();
  });

  it("F-519: a choice the host could not keep is not taken", async () => {
    const { client, storage, keys } = await connected();
    storage.set = () => Promise.reject(new Error("The disk is full."));
    await expect(client.setShowChannelChats(true)).rejects.toThrow("The disk is full.");
    expect(client.state.showChannelChats).toBe(false);
    expect(keys()).toEqual([NATIVE, MAIN]);
    client.stop();
  });

  it("F-519: a sessions.changed event that names a channel moves a task out of the list, and back when shown", async () => {
    const peer = { key: "agent:pip:direct:u1", agentId: "pip", label: "Ada", updatedAt: 250 };
    const { client, gateway, keys } = await connected({}, [...rows(), peer]);
    expect(keys()).toEqual([peer.key, NATIVE, MAIN]);
    // Flat, as the gateway sends it: the delivery fields beside `sessionKey`, no classification.
    gateway.emit("sessions.changed", {
      sessionKey: peer.key,
      agentId: "pip",
      channel: "whatsapp",
      lastChannel: "whatsapp",
      lastMessagePreview: "On my way",
      updatedAt: 400,
    });
    await until(() => !keys().includes(peer.key));
    expect(client.state.tasksByBot.pip![0]!.preview).toBe("Freed 4 GB");
    await client.setShowChannelChats(true);
    expect(client.state.tasksByBot.pip![0]).toMatchObject({
      key: peer.key,
      channel: "whatsapp",
      preview: "On my way",
    });
    client.stop();
  });

  it("F-519: the main session stays listed when a change names the channel that reached it", async () => {
    const { client, gateway, keys } = await connected();
    gateway.emit("sessions.changed", {
      sessionKey: MAIN,
      agentId: "pip",
      channel: "telegram",
      lastMessagePreview: "Hi from Telegram",
      updatedAt: 500,
      unread: true,
    });
    await until(() => client.state.tasksByBot.pip?.[0]?.key === MAIN);
    expect(client.state.tasksByBot.pip![0]).toMatchObject({
      title: "Main",
      isMain: true,
      preview: "Hi from Telegram",
    });
    expect(client.state.tasksByBot.pip![0]).not.toHaveProperty("channel");
    expect(keys()).toEqual([MAIN, NATIVE]);
    client.stop();
  });

  it("F-519: an unknown channel session is read with the list, so turning it on can show it", async () => {
    const { client, gateway } = await connected();
    const before = gateway.calls("sessions.list").length;
    gateway.emit("sessions.changed", {
      sessionKey: "agent:pip:telegram:group:-100200",
      agentId: "pip",
      channel: "telegram",
    });
    await until(() => gateway.calls("sessions.list").length > before);
    client.stop();
  });

  it("F-519: a busy channel never pushes the bot's own tasks out of the list", async () => {
    const busy = Array.from({ length: MAX_LISTED_TASKS }, (_, index) => ({
      key: `agent:pip:discord:channel:${index}`,
      agentId: "pip",
      channel: "discord",
      updatedAt: 10_000 + index,
    }));
    const { client, keys } = await connected({ "show-channel-chats": "true" }, [
      ...busy,
      ...rows(),
    ]);
    expect(keys()).toHaveLength(MAX_LISTED_TASKS);
    expect(keys()).toContain(NATIVE);
    expect(keys()).toContain(MAIN);
    client.stop();
  });

  it("F-519: the client keeps each row field that says what a session is and what to call it", async () => {
    const listed = [
      // A main key configured otherwise, which the gateway names main by its classification.
      { key: "agent:pip:home", agentId: "pip", classification: "main", channel: "telegram" },
      // Per-peer direct messages: the key names no channel; only the row's channel fields do.
      { key: "agent:pip:direct:u1", agentId: "pip", channel: "whatsapp", updatedAt: 60 },
      { key: "agent:pip:direct:u2", agentId: "pip", lastChannel: "signal", updatedAt: 50 },
      { key: "agent:pip:t:group:1", agentId: "pip", channel: "t", subject: "Ops", updatedAt: 40 },
      { key: "agent:pip:d:channel:2", agentId: "pip", channel: "d", groupChannel: "#builds" },
    ];
    const { client, keys } = await connected({}, listed);
    expect(keys()).toEqual(["agent:pip:home"]);
    await client.setShowChannelChats(true);
    expect(Object.fromEntries(client.state.tasksByBot.pip!.map((t) => [t.key, t.title]))).toEqual({
      "agent:pip:home": "home",
      "agent:pip:direct:u1": "WhatsApp chat",
      "agent:pip:direct:u2": "Signal chat",
      "agent:pip:t:group:1": "Ops",
      "agent:pip:d:channel:2": "#builds",
    });
    client.stop();
  });

  it("F-519: message search leaves out a hidden channel chat's messages, and shows them when on", async () => {
    const { client, gateway } = await connected();
    const hit = (sessionKey: string) => ({
      sessionKey,
      sessionId: "s",
      messageId: `m-${sessionKey}`,
      role: "user",
      timestamp: 1,
      snippet: "disk",
    });
    gateway.handlers["sessions.search"] = () => ({
      results: [hit(DISCORD), hit(NATIVE), hit("agent:pip:slack:direct:u9")],
    });
    const keys = async () =>
      (await client.searchMessages("disk", null)).hits.map((each) => each.sessionKey);
    expect(await keys()).toEqual([NATIVE]);
    await client.setShowChannelChats(true);
    expect(await keys()).toEqual([DISCORD, NATIVE, "agent:pip:slack:direct:u9"]);
    client.stop();
  });

  it("F-519: a change in a channel chat the cap could not keep does not read the whole list again", async () => {
    const native = Array.from({ length: MAX_LISTED_TASKS }, (_, index) => ({
      key: `agent:pip:dashboard:${String(index).padStart(8, "0")}-0000`,
      agentId: "pip",
      updatedAt: 1_000 + index,
    }));
    const { client, gateway } = await connected({}, native);
    const reads = () => gateway.calls("sessions.list").length;
    const before = reads();
    gateway.emit("sessions.changed", {
      sessionKey: "agent:pip:discord:channel:77",
      agentId: "pip",
      channel: "discord",
      updatedAt: 99_999,
    });
    await sleep(400);
    expect(reads()).toBe(before);
    // A task of the bot's own still is.
    gateway.emit("sessions.changed", { sessionKey: "agent:pip:dashboard:new-one", agentId: "pip" });
    await until(() => reads() > before);
    client.stop();
  });

  it("F-519: at the cap with a channel chat among the rows held, a change in another channel chat reads the list again", async () => {
    const native = Array.from({ length: MAX_LISTED_TASKS - 1 }, (_, index) => ({
      key: `agent:pip:dashboard:${String(index).padStart(8, "0")}-0000`,
      agentId: "pip",
      updatedAt: 1_000 + index,
    }));
    const { client, gateway } = await connected({}, [
      ...native,
      { key: "agent:pip:discord:channel:1", agentId: "pip", channel: "discord", updatedAt: 1 },
    ]);
    const before = gateway.calls("sessions.list").length;
    gateway.emit("sessions.changed", {
      sessionKey: "agent:pip:discord:channel:2",
      agentId: "pip",
      channel: "discord",
      updatedAt: 99_999,
    });
    await until(() => gateway.calls("sessions.list").length > before);
    client.stop();
  });

  it("F-519: a hidden channel chat that asks the person something is listed while it waits", async () => {
    const { client, gateway, keys } = await connected({}, rows(), true);
    expect(keys()).toEqual([NATIVE, MAIN]);
    gateway.emit("question.requested", {
      id: "q1",
      sessionKey: DISCORD,
      runId: "r1",
      createdAtMs: 400,
    });
    await until(() => keys().includes(DISCORD));
    expect(client.state.tasksByBot.pip!.find((task) => task.key === DISCORD)?.status).toBe(
      "waiting",
    );
    // Opened from the list, it shows the question to answer.
    gateway.handlers["chat.history"] = () => ({ messages: [], inFlightRun: { runId: "r1" } });
    gateway.handlers["question.list"] = () => ({
      questions: [questionRecord("q1", "r1", DISCORD)],
    });
    for (const method of ["exec.approval.list", "plugin.approval.list", "openclaw.approval.list"])
      gateway.handlers[method] = () => [];
    client.openSession(DISCORD);
    await until(() => client.state.transcripts[DISCORD]?.questions.length === 1);
    client.closeSession(DISCORD);
    gateway.handlers["question.list"] = () => ({ questions: [] });
    gateway.emit("question.resolved", { id: "q1" });
    await until(() => !keys().includes(DISCORD));
    gateway.emit("agent", {
      sessionKey: DISCORD,
      runId: "r2",
      stream: "lifecycle",
      ts: 500,
      data: { phase: "waiting-approval", approvalId: "ap1" },
    });
    await until(() => keys().includes(DISCORD));
    // Opened, it shows the approval to decide.
    gateway.handlers["chat.history"] = () => ({ messages: [], inFlightRun: { runId: "r2" } });
    gateway.handlers["exec.approval.list"] = () => [
      {
        id: "ap1",
        request: {
          command: "uname -s",
          host: "gateway",
          agentId: "pip",
          sessionKey: DISCORD,
          runId: "r2",
          allowedDecisions: ["allow-once", "deny"],
        },
        createdAtMs: 500,
        expiresAtMs: 9_000_000_000_000,
      },
    ];
    client.openSession(DISCORD);
    await until(() => client.state.transcripts[DISCORD]?.approvals.length === 1);
    client.closeSession(DISCORD);
    gateway.handlers["exec.approval.list"] = () => [];
    gateway.emit("agent", {
      sessionKey: DISCORD,
      runId: "r2",
      stream: "lifecycle",
      ts: 600,
      data: { phase: "approval-resolved", approvalId: "ap1" },
    });
    await until(() => !keys().includes(DISCORD));
    client.stop();
  });

  it("F-519: the Archived group leaves channel chats out unless they are shown", async () => {
    const archived = rows().map((row) => ({ ...row, archived: true, sessionId: row.key }));
    const ctx = {
      request: async () => ({ sessions: archived, hasMore: false }),
    } as unknown as TaskActionContext;
    expect((await listArchived(ctx, "pip")).tasks.map((task) => task.key)).toEqual([NATIVE, MAIN]);
    expect(
      (await listArchived(ctx, "pip", { showChannelChats: true })).tasks.map((task) => task.key),
    ).toEqual([DISCORD, NATIVE, MAIN]);
  });

  it("F-519: the Archived group reads on past a page of channel chats it leaves out", async () => {
    const page = Array.from({ length: MAX_ARCHIVED_LISTED + 1 }, (_, index) => ({
      key: `agent:pip:discord:channel:${index}`,
      agentId: "pip",
      sessionId: `d-${index}`,
      channel: "discord",
      archived: true,
      archivedAt: 2000 + index,
    }));
    const native = { key: NATIVE, agentId: "pip", sessionId: "n", archived: true, archivedAt: 100 };
    const offsets: unknown[] = [];
    const ctx = {
      request: async (_method: string, params: Record<string, unknown>) => {
        offsets.push(params.offset);
        return params.offset === page.length
          ? { sessions: [native], hasMore: false }
          : { sessions: page, hasMore: true, nextOffset: page.length };
      },
    } as unknown as TaskActionContext;
    const listed = await listArchived(ctx, "pip");
    expect(listed.tasks.map((task) => task.key)).toEqual([NATIVE]);
    expect(listed.more).toBe(false);
    expect(offsets).toEqual([undefined, page.length]);
  });

  it("F-519: the bridge takes the setting only as true or false", () => {
    expect(parseBridgeCommand({ type: "setShowChannelChats", on: true })).toEqual({
      type: "setShowChannelChats",
      on: true,
    });
    expect(() => parseBridgeCommand({ type: "setShowChannelChats", on: "yes" })).toThrow(
      "invalid channel chats setting",
    );
  });
});
