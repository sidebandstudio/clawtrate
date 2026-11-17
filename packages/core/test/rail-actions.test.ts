// The rail's task actions and arrangement through the client and the bridge:
// what reaches the gateway, at which tier, and what the state shows.

import { describe, expect, it } from "vitest";
import { createBridgeSession, parseBridgeCommand } from "../src/bridge.ts";
import { ClawtrateClient } from "../src/client.ts";
import { INTERACTIVE_SCOPES, READ_SCOPES } from "../src/scopes.ts";
import { SIDEBAR_PREF_KEY } from "../src/sidebar.ts";
import { MAX_LISTED_TASKS } from "../src/state-bounds.ts";
import { FAST, grantingGateway, URL_A } from "./client-harness.ts";
import { memoryStorage, testHost, tokenKey, until } from "./fake-gateway.ts";

const PIP_TASK = "agent:pip:dashboard:2cc23cbf-30e2-4416-837a-56d92c983588";

async function connected(held: readonly string[], options: { readOnly?: boolean } = {}) {
  const gateway = grantingGateway();
  gateway.handlers["agents.list"] = () => ({
    defaultId: "main",
    agents: [
      { id: "main", identity: { name: "Juniper" } },
      { id: "pip", identity: { name: "Pip" } },
    ],
  });
  const rows = [
    {
      key: "agent:pip:main",
      agentId: "pip",
      sessionId: "s-main",
      updatedAt: 10,
      unread: true,
      markedUnreadAt: 9,
    },
  ];
  gateway.handlers["sessions.subscribe"] = () => ({
    subscribed: true,
    list: { sessions: rows, hasMore: false },
  });
  gateway.handlers["sessions.list"] = () => ({ sessions: rows, hasMore: false });
  let prefs: unknown = undefined;
  gateway.handlers["users.prefs.get"] = () => ({
    status: "ok",
    entries: prefs === undefined ? {} : { [SIDEBAR_PREF_KEY]: prefs },
  });
  gateway.handlers["users.prefs.set"] = (params) => {
    prefs = (params as { entries: Record<string, unknown> }).entries[SIDEBAR_PREF_KEY];
    return { status: "ok" };
  };
  gateway.handlers["sessions.create"] = () => ({
    ok: true,
    key: PIP_TASK,
    sessionId: "s-new",
    entry: { sessionId: "s-new", updatedAt: 20, createdAt: 20 },
    runStarted: false,
  });
  gateway.handlers["sessions.patch"] = () => ({ ok: true });
  gateway.handlers["device.scopes.requestUpgrade"] = () => ({
    requestId: "req-1",
    status: "pending",
  });
  const storage = memoryStorage({
    connection: JSON.stringify({ url: URL_A, token: null }),
    [tokenKey(URL_A)]: JSON.stringify({
      token: "device-token",
      grantedScopes: held,
      heldScopes: held,
    }),
  });
  const client = new ClawtrateClient(testHost(gateway, storage), { ...FAST, ...options });
  await client.start();
  await until(
    () => client.state.discovery.status === "ready" && client.state.sidebar?.status === "ok",
  );
  return { client, gateway, setPrefs: (value: unknown) => (prefs = value) };
}

describe("the rail's actions through the client", () => {
  it("F-054: a new task is created empty and listed at once, before sessions.changed brings its row", async () => {
    const { client, gateway } = await connected(INTERACTIVE_SCOPES);
    const key = await client.newTask("pip");
    expect(key).toBe(PIP_TASK);
    expect(gateway.calls("sessions.create")).toEqual([{ agentId: "pip" }]);
    expect(client.state.tasksByBot.pip!.map((task) => [task.key, task.title])).toContainEqual([
      PIP_TASK,
      "New task",
    ]);
    client.stop();
  });

  it("F-022: opening a task marks it read on the gateway only while the connection writes, naming the marker it saw", async () => {
    const reader = await connected(READ_SCOPES);
    await reader.client.markTask("agent:pip:main", false, { opened: true });
    expect(reader.gateway.calls("sessions.patch")).toEqual([]);
    expect(reader.gateway.calls("device.scopes.requestUpgrade")).toEqual([]);
    reader.client.stop();

    const writer = await connected(INTERACTIVE_SCOPES);
    await writer.client.markTask("agent:pip:main", false, { opened: true });
    expect(writer.gateway.calls("sessions.patch")).toEqual([
      { key: "agent:pip:main", unread: false, expectedMarkedUnreadAt: 9 },
    ]);
    writer.client.stop();
  });

  it("F-022: two reads on opening at once make one clear on the gateway", async () => {
    const { client, gateway } = await connected(INTERACTIVE_SCOPES);
    let release: () => void = () => {};
    gateway.handlers["sessions.patch"] = () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: true });
      });
    const first = client.markTask("agent:pip:main", false, { opened: true });
    const second = client.markTask("agent:pip:main", false, { opened: true });
    await until(() => gateway.calls("sessions.patch").length === 1);
    release();
    await Promise.all([first, second]);
    expect(gateway.calls("sessions.patch")).toHaveLength(1);
    client.stop();
  });

  it("a created task never takes the task cache past its bound", async () => {
    const gateway = grantingGateway();
    const rows = Array.from({ length: MAX_LISTED_TASKS }, (_, index) => ({
      key: `agent:pip:t${index}`,
      agentId: "pip",
      updatedAt: 1000 + index,
    }));
    gateway.handlers["agents.list"] = () => ({ defaultId: "pip", agents: [{ id: "pip" }] });
    gateway.handlers["sessions.subscribe"] = () => ({
      subscribed: true,
      list: { sessions: rows, hasMore: false },
    });
    gateway.handlers["users.prefs.get"] = () => ({ status: "no_durable_identity" });
    let made = 0;
    gateway.handlers["sessions.create"] = () => ({
      ok: true,
      key: `agent:pip:dashboard:${String((made += 1)).padStart(8, "0")}-new`,
      entry: { sessionId: `s-${made}`, updatedAt: 9_000 + made, createdAt: 9_000 + made },
    });
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: JSON.stringify({
        token: "device-token",
        grantedScopes: INTERACTIVE_SCOPES,
        heldScopes: INTERACTIVE_SCOPES,
      }),
    });
    const client = new ClawtrateClient(testHost(gateway, storage), FAST);
    await client.start();
    await until(() => client.state.tasksByBot.pip?.length === MAX_LISTED_TASKS);
    const first = await client.newTask("pip");
    await client.newTask("pip");
    const kept = (client as unknown as { rows: Map<string, unknown> }).rows;
    expect(kept.size).toBe(MAX_LISTED_TASKS);
    expect(client.state.tasksByBot.pip).toHaveLength(MAX_LISTED_TASKS);
    expect(client.state.tasksByBot.pip!.some((task) => task.key === first)).toBe(true);
    client.stop();
  });

  it("F-014: the arrangement is read at connect and changed with a compare-and-set; users.prefs.changed reads it again", async () => {
    const { client, gateway, setPrefs } = await connected(INTERACTIVE_SCOPES);
    expect(client.state.sidebar).toEqual({ status: "ok", prefs: null });
    await client.changeSidebar({ op: "pin", botId: "pip", pinned: true }, null);
    expect(client.state.sidebar?.prefs?.pins).toEqual(["pip"]);
    expect(gateway.calls("users.prefs.set")).toHaveLength(1);
    setPrefs({
      pins: ["main"],
      sections: [{ name: "Work", bots: ["pip"] }],
      hidden: [],
      order: [],
    });
    gateway.emit("users.prefs.changed", { profileId: "owner", keys: [SIDEBAR_PREF_KEY] });
    await until(() => client.state.sidebar?.prefs?.pins[0] === "main");
    expect(client.state.sidebar?.prefs?.sections).toEqual([{ name: "Work", bots: ["pip"] }]);
    client.stop();
  });

  it("F-014: an answer older than what is shown never replaces it", async () => {
    const { client, gateway, setPrefs } = await connected(INTERACTIVE_SCOPES);
    // A read asked on users.prefs.changed answers late, after a newer write was shown.
    let answerLate: () => void = () => {};
    const stale = {
      status: "ok",
      entries: { [SIDEBAR_PREF_KEY]: { pins: ["main"], sections: [], hidden: [], order: [] } },
    };
    gateway.handlers["users.prefs.get"] = () =>
      new Promise((resolve) => {
        answerLate = () => resolve(stale);
      });
    gateway.emit("users.prefs.changed", { profileId: "owner", keys: [SIDEBAR_PREF_KEY] });
    await until(() => gateway.calls("users.prefs.get").length >= 2);
    const pending = answerLate;
    setPrefs(undefined);
    gateway.handlers["users.prefs.get"] = () => ({ status: "ok", entries: {} });
    await client.changeSidebar({ op: "pin", botId: "pip", pinned: true }, null);
    expect(client.state.sidebar?.prefs?.pins).toEqual(["pip"]);
    pending();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.state.sidebar?.prefs?.pins).toEqual(["pip"]);
    client.stop();
  });

  it("F-021: a task whose run waits for an approval is waiting until the approval resolves", async () => {
    const { client, gateway } = await connected(INTERACTIVE_SCOPES);
    gateway.emit("sessions.changed", {
      sessionKey: "agent:pip:main",
      agentId: "pip",
      hasActiveRun: true,
    });
    await until(() => client.state.tasksByBot.pip?.[0]?.status === "running");
    gateway.emit("agent", {
      runId: "r1",
      sessionKey: "agent:pip:main",
      stream: "lifecycle",
      data: { phase: "waiting-approval" },
    });
    await until(() => client.state.tasksByBot.pip?.[0]?.status === "waiting");
    expect(client.state.tasksByBot.pip![0]!.waitingFor).toBe("approval");
    gateway.emit("agent", {
      runId: "r1",
      sessionKey: "agent:pip:main",
      stream: "lifecycle",
      data: { phase: "approval-resolved" },
    });
    await until(() => client.state.tasksByBot.pip?.[0]?.status === "running");
    client.stop();
  });

  it("a host pinned read-only changes nothing and asks for nothing", async () => {
    const { client, gateway } = await connected(INTERACTIVE_SCOPES, { readOnly: true });
    await expect(client.newTask("pip")).rejects.toThrow(/only reads/);
    await expect(client.renameTask("agent:pip:main", "x")).rejects.toThrow(/only reads/);
    await expect(client.archiveTask("agent:pip:main")).rejects.toThrow(/only reads/);
    await expect(client.deleteTask("agent:pip:main")).rejects.toThrow(/only reads/);
    await expect(
      client.changeSidebar({ op: "pin", botId: "pip", pinned: true }, null),
    ).rejects.toThrow(/only reads/);
    for (const method of [
      "sessions.create",
      "sessions.patch",
      "sessions.delete",
      "users.prefs.set",
    ])
      expect(gateway.calls(method)).toEqual([]);
    expect(gateway.calls("device.scopes.requestUpgrade")).toEqual([]);
    client.stop();
  });

  it("an action on a read-tier connection asks for the interactive scopes, and waits for them", async () => {
    const { client, gateway } = await connected(READ_SCOPES);
    gateway.handlers["device.scopes.waitUpgrade"] = () => new Promise(() => {});
    const renaming = client.renameTask("agent:pip:main", "Weekly");
    const outcome = renaming.then(
      () => "renamed",
      () => "refused",
    );
    await until(() => client.state.connection.upgrade.status === "pending");
    expect(gateway.calls("device.scopes.requestUpgrade")).toHaveLength(1);
    expect(gateway.calls("sessions.patch")).toEqual([]);
    // Disconnecting withdraws the request; the rename never reached the gateway.
    await client.disconnect();
    expect(await outcome).toBe("refused");
    expect(gateway.calls("sessions.patch")).toEqual([]);
  });

  it("the bridge checks each command's fields and answers a new task's key", async () => {
    expect(parseBridgeCommand({ type: "newTask", botId: "pip", label: null })).toEqual({
      type: "newTask",
      botId: "pip",
      label: null,
    });
    expect(() =>
      parseBridgeCommand({ type: "pinTask", key: "agent:pip:main", pinned: "yes" }),
    ).toThrow("invalid flag");
    expect(() => parseBridgeCommand({ type: "renameTask", key: "bad key!", label: "x" })).toThrow(
      "invalid session key",
    );
    expect(() =>
      parseBridgeCommand({
        type: "changeSidebar",
        change: { op: "section", botId: "pip", section: " " },
        base: null,
      }),
    ).toThrow("A section needs a name.");
    expect(
      parseBridgeCommand({
        type: "changeSidebar",
        change: { op: "move", botId: "pip", before: "main", shown: ["main", "pip"] },
        base: { pins: ["pip"], junk: 1 },
      }),
    ).toEqual({
      type: "changeSidebar",
      change: { op: "move", botId: "pip", before: "main", shown: ["main", "pip"] },
      base: { pins: ["pip"], sections: [], hidden: [], order: [] },
    });
    expect(parseBridgeCommand({ type: "markTask", key: "agent:pip:main", unread: true })).toEqual({
      type: "markTask",
      key: "agent:pip:main",
      unread: true,
      opened: false,
    });

    const { client } = await connected(INTERACTIVE_SCOPES);
    const viewer = createBridgeSession(client);
    expect(await viewer.apply({ type: "newTask", botId: "pip", label: null })).toEqual({
      key: PIP_TASK,
    });
    viewer.dispose();
    client.stop();
  });
});
