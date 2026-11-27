// The rail's task actions and arrangement through the client and the bridge:
// what reaches the gateway, at which tier, and what the state shows.

import { describe, expect, it } from "vitest";
import { createBridgeSession, parseBridgeCommand } from "../src/bridge.ts";
import {
  ClawtrateClient,
  CONNECTION_CHANGED,
  CONNECTION_CHANGED_AFTER_SEND,
  MAX_DEFERRED_STOPS,
} from "../src/client.ts";
import { gatewayStamp, type GatewayStamp } from "../src/types.ts";
import { INTERACTIVE_SCOPES, READ_SCOPES } from "../src/scopes.ts";
import { SIDEBAR_PREF_KEY } from "../src/sidebar.ts";
import { MAX_LISTED_TASKS } from "../src/state-bounds.ts";
import { agentEvent, FAST, grantingGateway, KEY, openTask, URL_A } from "./client-harness.ts";
import {
  deferred,
  helloOk,
  memoryStorage,
  sleep,
  testHost,
  tokenKey,
  until,
} from "./fake-gateway.ts";

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
      // Another device's write, after this device's: a later revision.
      rev: 2,
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
    await new Promise((resolve) => setTimeout(() => resolve(undefined), 50));
    expect(client.state.sidebar?.prefs?.pins).toEqual(["pip"]);
    client.stop();
  });

  it("F-014 F-016: an old write's acknowledgement arriving after another device's later change is shown leaves that change in view", async () => {
    const { client, gateway } = await connected(INTERACTIVE_SCOPES);
    let stored: unknown = undefined;
    gateway.handlers["users.prefs.get"] = () => ({
      status: "ok",
      entries: stored === undefined ? {} : { [SIDEBAR_PREF_KEY]: stored },
    });
    let acknowledge: (value: unknown) => void = () => {};
    gateway.handlers["users.prefs.set"] = (params) => {
      // This device's pin is committed at once; its acknowledgement is held.
      stored = (params as { entries: Record<string, unknown> }).entries[SIDEBAR_PREF_KEY];
      return new Promise((resolve) => {
        acknowledge = resolve;
      });
    };
    const pinning = client.changeSidebar({ op: "pin", botId: "pip", pinned: true }, null);
    await until(() => stored !== undefined);
    // Another device then adds a section on top of it, and this device shows that.
    const mine = stored as { rev: number };
    stored = {
      pins: ["pip"],
      sections: [{ name: "Later section", bots: ["main"] }],
      hidden: [],
      order: [],
      rev: mine.rev + 1,
    };
    gateway.emit("users.prefs.changed", { profileId: "owner", keys: [SIDEBAR_PREF_KEY] });
    await until(() => client.state.sidebar?.prefs?.sections.length === 1);
    acknowledge({ status: "ok" });
    await pinning;
    expect(client.state.sidebar?.prefs?.sections).toEqual([
      { name: "Later section", bots: ["main"] },
    ]);
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

  it("F-021: a device that connects while its own run waits for an approval sees the task waiting", async () => {
    const gateway = grantingGateway();
    gateway.handlers["agents.list"] = () => ({ defaultId: "pip", agents: [{ id: "pip" }] });
    const row = { key: "agent:pip:main", agentId: "pip", hasActiveRun: true, updatedAt: 10 };
    gateway.handlers["sessions.subscribe"] = () => ({
      subscribed: true,
      list: { sessions: [row], hasMore: false },
    });
    gateway.handlers["users.prefs.get"] = () => ({ status: "no_durable_identity" });
    gateway.handlers["exec.approval.list"] = () => [
      {
        id: "a1",
        request: { command: "ls", sessionKey: "agent:pip:main", runId: "r1" },
        createdAtMs: 20,
        expiresAtMs: 9_999_999_999_999,
      },
    ];
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
    await until(() => client.state.tasksByBot.pip?.[0]?.status === "waiting");
    expect(client.state.tasksByBot.pip![0]).toMatchObject({
      waitingFor: "approval",
      waitingSince: 20,
    });
    // Resolved on another device: the approval's own event clears it.
    gateway.emit("exec.approval.resolved", { id: "a1", decision: "deny", ts: 30 });
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
    const stamp = { gatewayId: "gateway-a", target: 4 };
    expect(
      parseBridgeCommand({ type: "markTask", key: "agent:pip:main", unread: true, stamp }),
    ).toEqual({ type: "markTask", key: "agent:pip:main", unread: true, opened: false, stamp });
    expect(
      parseBridgeCommand({ type: "markTask", key: "agent:pip:main", unread: false, opened: true }),
    ).toEqual({ type: "markTask", key: "agent:pip:main", unread: false, opened: true });

    const { client } = await connected(INTERACTIVE_SCOPES);
    const viewer = createBridgeSession(client);
    expect(await viewer.apply({ type: "newTask", botId: "pip", label: null })).toEqual({
      key: PIP_TASK,
    });
    viewer.dispose();
    client.stop();
  });
});

describe("Stop and archive, and delete, through the engine's own Stop", () => {
  it("F-277 F-278: a run stopped before the gateway named it is stopped by its id once named, its follow-up stays not sent, and only then is the task archived", async () => {
    const gateway = grantingGateway();
    const answer = deferred<unknown>();
    gateway.handlers["chat.send"] = () => answer.promise;
    gateway.handlers["chat.history"] = () => ({ messages: [] });
    let active = true;
    gateway.handlers["sessions.describe"] = () => ({
      session: { key: KEY, sessionId: "s-1", hasActiveRun: active },
    });
    // What the engine shows of the run and its follow-up when the archive reaches the gateway.
    let atArchive: unknown = null;
    gateway.handlers["sessions.patch"] = () => {
      atArchive = {
        run: transcript().runs.find((run) => run.id === id)?.state,
        followUp: transcript().outbox.find((m) => m.id === later)?.status,
      };
      return { ok: true };
    };
    const { client, transcript } = await openTask({ gateway });
    const id = client.sendMessage(KEY, "Take your time");
    await until(() => gateway.calls("chat.send").length === 1);
    const later = client.sendMessage(KEY, "Then this", { mode: "queue" });
    const archived = client.archiveTask(KEY, { stop: true });
    await until(() => transcript().runs.find((run) => run.id === id)?.state === "stopping");
    await sleep(600);
    // An abort before the gateway has taken the send stops nothing: none is sent yet,
    // and nothing is archived while the run may still start.
    expect(gateway.calls("chat.abort")).toEqual([]);
    expect(gateway.calls("sessions.patch")).toEqual([]);
    answer.resolve({ runId: id, status: "started" });
    await until(() => gateway.calls("chat.abort").length === 1);
    expect(gateway.calls("chat.abort")).toEqual([{ sessionKey: KEY, runId: id }]);
    active = false;
    await expect(archived).resolves.toEqual({ stoppedRun: false });
    expect(gateway.calls("sessions.patch")).toEqual([
      { key: KEY, archived: true, expectedSessionId: "s-1" },
    ]);
    // Archived only once the engine's Stop had settled: the run stopped, its follow-up parked.
    expect(atArchive).toEqual({ run: "stopped", followUp: "not-sent" });
    expect(gateway.calls("chat.send")).toHaveLength(1);
    client.stop();
  });

  it("F-277 F-278: with two runs active and nothing naming the current one, Stop and archive still stops them, then archives", async () => {
    const gateway = grantingGateway();
    let current = true;
    // A reconnect missed the original run's end: its rows stop at a tool call, and the gateway
    // has another run in flight. Stop alone is withheld here; archiving the task is not.
    gateway.handlers["chat.history"] = () => ({
      messages: [
        {
          role: "user",
          content: "First",
          __openclaw: { id: "u1", idempotencyKey: "original:user" },
        },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "exec", arguments: { command: "ls" } }],
          stopReason: "toolUse",
          __openclaw: { id: "a1", runId: "original" },
        },
      ],
      hasMore: false,
      ...(current ? { inFlightRun: { runId: "current" } } : {}),
    });
    gateway.handlers["sessions.describe"] = () => ({
      session: { key: KEY, sessionId: "s-1", hasActiveRun: current },
    });
    gateway.handlers["chat.abort"] = (params) => {
      const { runId } = params as { runId?: string };
      if (runId !== "current") return { ok: true, aborted: false, runIds: [] };
      current = false;
      setTimeout(() => {
        gateway.emit(
          "agent",
          agentEvent("current", 9, "lifecycle", { phase: "end", aborted: true }),
        );
      }, 0);
      return { ok: true, aborted: true, runIds: ["current"] };
    };
    gateway.handlers["sessions.patch"] = () => ({ ok: true });
    const { client, transcript } = await openTask({ gateway });
    gateway.emit("agent", agentEvent("original", 1, "lifecycle", { phase: "start" }));
    gateway.emit("agent", agentEvent("current", 1, "lifecycle", { phase: "start" }));
    await until(() => transcript().runs.filter((each) => each.state === "running").length === 2);
    const started = Date.now();
    await expect(client.archiveTask(KEY, { stop: true })).resolves.toBeDefined();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(gateway.calls("chat.abort")).toContainEqual({ sessionKey: KEY, runId: "current" });
    expect(gateway.calls("sessions.patch")).toEqual([
      { key: KEY, archived: true, expectedSessionId: "s-1" },
    ]);
    client.stop();
  }, 20_000);
});

// #450: an archive's own Stop of a run this host follows, and the access grant an archive waits
// for, as the action's connection sees them.
describe("an archive or a delete bound to the connection it began on", () => {
  /** A host following a run in KEY on a gateway that names itself `id()`; the task stays active. */
  async function following(id: { value: string }) {
    const gateway = grantingGateway();
    gateway.handlers["gateway.identity.get"] = () => ({ deviceId: id.value });
    gateway.handlers["sessions.describe"] = () => ({
      session: { key: KEY, sessionId: "s-1", hasActiveRun: true },
    });
    gateway.handlers["sessions.patch"] = () => ({ ok: true });
    gateway.handlers["sessions.delete"] = () => ({ ok: true });
    // The gateway names the run by the send's own id, so the host follows it as that run.
    gateway.handlers["chat.send"] = (params) => ({
      runId: (params as { idempotencyKey: string }).idempotencyKey,
      status: "started",
    });
    const { client, transcript } = await openTask({ gateway });
    await until(() => client.state.connection.gatewayId === id.value);
    const run = client.sendMessage(KEY, "Take your time");
    await until(() => transcript().runs.find((each) => each.id === run)?.bound === true);
    return { client, gateway, stamp: gatewayStamp(client.state.connection) };
  }
  const outcome = (pending: Promise<unknown>) =>
    pending.then(
      () => "done",
      (error: Error) => error.message,
    );

  it("a Stop and archive whose connection drops after this host stopped the run says the change is unconfirmed", async () => {
    const id = { value: "gateway-a" };
    const { client, gateway, stamp } = await following(id);
    gateway.handlers["chat.abort"] = () => {
      // The same gateway drops just after taking the Stop, and comes back.
      setTimeout(() => gateway.dropAll(), 0);
      return { ok: true, aborted: true, runIds: [] };
    };
    const archived = outcome(client.archiveTask(KEY, { stop: true, stamp }));
    expect(await archived).toBe(CONNECTION_CHANGED_AFTER_SEND);
    expect(gateway.calls("chat.abort")).toHaveLength(1);
    expect(gateway.calls("sessions.patch")).toEqual([]);
    client.stop();
  });

  it("a Stop whose answer the drop lost is not sent again to another gateway answering at the same address", async () => {
    const id = { value: "gateway-a" };
    const { client, gateway, stamp } = await following(id);
    gateway.handlers["chat.abort"] = () => {
      // The abort's answer never comes: the connection drops, and gateway-x answers the reconnect.
      id.value = "gateway-x";
      setTimeout(() => gateway.dropAll(), 0);
      return new Promise(() => {});
    };
    const archived = outcome(client.archiveTask(KEY, { stop: true, stamp }));
    await until(() => client.state.connection.gatewayId === "gateway-x", 6_000);
    await sleep(600);
    expect(gateway.calls("chat.abort")).toHaveLength(1);
    expect(await archived).not.toBe("done");
    expect(gateway.calls("sessions.patch")).toEqual([]);
    client.stop();
  });

  /** Host internals the deferred Stop's tests reach: what a history read and later Stops do. */
  type Deferred = {
    deferredStop(key: string, ...ids: string[]): (() => boolean) | undefined;
    keepDeferredStop(key: string, runId: string, bound: () => boolean): boolean;
    historyStopCheck(
      key: string,
      run: { id: string; messageId: string | null },
    ): (() => boolean) | undefined;
  };

  /**
   * An archive that stops a run the gateway hasn't named; `meanwhile` runs before the send's
   * answer names it. That abort's answer is lost, and gateway-x answers the reconnect.
   */
  async function deferredStop(
    meanwhile: (client: ClawtrateClient, run: string) => void,
    before: (client: ClawtrateClient) => void = () => {},
    afterReplaced: () => void = () => {},
  ) {
    const id = { value: "gateway-a" };
    const gateway = grantingGateway();
    gateway.handlers["gateway.identity.get"] = () => ({ deviceId: id.value });
    gateway.handlers["sessions.describe"] = () => ({
      session: { key: KEY, sessionId: "s-1", hasActiveRun: true },
    });
    gateway.handlers["sessions.patch"] = () => ({ ok: true });
    const named = deferred<unknown>();
    gateway.handlers["chat.send"] = () => named.promise;
    gateway.handlers["chat.abort"] = () => {
      id.value = "gateway-x";
      setTimeout(() => gateway.dropAll(), 0);
      return new Promise(() => {});
    };
    const { client, transcript } = await openTask({ gateway });
    await until(() => client.state.connection.gatewayId === "gateway-a");
    await openOthers(client);
    const run = client.sendMessage(KEY, "Take your time");
    await until(() => gateway.calls("chat.send").length === 1);
    before(client);
    const stamp = gatewayStamp(client.state.connection);
    const archived = outcome(client.archiveTask(KEY, { stop: true, stamp }));
    await until(() => transcript().runs.find((each) => each.id === run)?.state === "stopping");
    expect(gateway.calls("chat.abort")).toEqual([]);
    meanwhile(client, run);
    named.resolve({ runId: run, status: "started" });
    await until(() => gateway.calls("chat.abort").length === 1);
    await until(() => client.state.connection.gatewayId === "gateway-x", 6_000);
    afterReplaced();
    await sleep(600);
    expect(gateway.calls("chat.abort")).toHaveLength(1);
    expect(await archived).not.toBe("done");
    expect(gateway.calls("sessions.patch")).toEqual([]);
    client.stop();
  }

  it("a Stop asked before the gateway named the run, whose abort the drop lost, is not sent again to another gateway at the same address", async () => {
    await deferredStop(() => {});
  });

  it("a deferred Stop's check stays for the send's answer after a history read used it first", async () => {
    await deferredStop((client, run) => {
      // A history read names the run first and aborts it with the check, as `readTranscript` does.
      expect((client as unknown as Deferred).deferredStop(KEY, run)).toBeTypeOf("function");
    });
  });

  /** Tasks besides KEY that hold waiting Stops: a task keeps at most 16 runs. */
  const OTHERS = ["agent:main:waiting-a", "agent:main:waiting-b"];
  const openOthers = async (client: ClawtrateClient) => {
    for (const key of OTHERS) {
      client.openSession(key);
      await until(() => client.state.transcripts[key]?.status === "ready");
    }
  };

  /**
   * `count` more deferred Stops, each for a run still waiting to be named, 14 to a task: copies
   * of `run`, stopping, as the host would hold them. Answers how many the host kept.
   */
  const waitingStops = (client: ClawtrateClient, run: string, count: number) => {
    const live = client.state.transcripts[KEY]!.runs.find((each) => each.id === run)!;
    let kept = 0;
    for (let n = 0; n < count; n += 1) {
      const key = [KEY, ...OTHERS][Math.floor(n / 14)]!;
      const id = `waiting-${n}`;
      client.store.update((state) => {
        const transcript = state.transcripts[key]!;
        return {
          ...state,
          transcripts: {
            ...state.transcripts,
            [key]: {
              ...transcript,
              runs: [...transcript.runs, { ...live, id, messageId: id, state: "stopping" }],
            },
          },
        };
      });
      expect(client.state.transcripts[key]!.runs.some((each) => each.id === id)).toBe(true);
      if ((client as unknown as Deferred).keepDeferredStop(key, id, () => true)) kept += 1;
    }
    return kept;
  };

  it("a deferred Stop still waiting is not let go when the registry fills behind it", async () => {
    await deferredStop((client, run) => {
      // The archive's Stop is kept; every later one finds the registry full of Stops still
      // waiting, and is refused rather than letting the archive's go.
      expect(waitingStops(client, run, 40)).toBe(MAX_DEFERRED_STOPS - 1);
      // The registry is full of Stops still waiting: none was let go for the later ones.
    });
  });

  it("Stops whose runs are over make room: an archive's Stop is kept after the registry filled with them", async () => {
    await deferredStop(
      () => {},
      (client) => {
        // The registry fills with Stops for runs already over, as sends that failed leave them.
        const host = client as unknown as Deferred;
        for (let n = 0; n < MAX_DEFERRED_STOPS; n += 1)
          expect(host.keepDeferredStop(KEY, `ended-${n}`, () => true)).toBe(true);
      },
    );
  });

  it("an archive whose Stop finds the registry full sends no abort, here or to a gateway that replaces this one", async () => {
    const id = { value: "gateway-a" };
    const gateway = grantingGateway();
    gateway.handlers["gateway.identity.get"] = () => ({ deviceId: id.value });
    gateway.handlers["sessions.describe"] = () => ({
      session: { key: KEY, sessionId: "s-1", hasActiveRun: true },
    });
    gateway.handlers["sessions.patch"] = () => ({ ok: true });
    const named = deferred<unknown>();
    gateway.handlers["chat.send"] = () => named.promise;
    gateway.handlers["chat.abort"] = () => ({ ok: true, aborted: true, runIds: [] });
    const { client, transcript } = await openTask({ gateway });
    await until(() => client.state.connection.gatewayId === "gateway-a");
    await openOthers(client);
    const run = client.sendMessage(KEY, "Take your time");
    await until(() => gateway.calls("chat.send").length === 1);
    expect(waitingStops(client, run, MAX_DEFERRED_STOPS)).toBe(MAX_DEFERRED_STOPS);
    const stamp = gatewayStamp(client.state.connection);
    const started = Date.now();
    const archived = outcome(client.archiveTask(KEY, { stop: true, stamp }));
    // The archive says so at once, not after the wait for its run to stop.
    expect(await archived).toContain("nothing was sent for this one");
    expect(Date.now() - started).toBeLessThan(2_000);
    // The archive's Stop is given up at once, and says nothing was sent for it.
    await until(
      () =>
        transcript()
          .runs.find((each) => each.id === run)
          ?.stopError?.includes("nothing was sent for this one") === true,
    );
    named.resolve({ runId: run, status: "started" });
    // Another gateway answers the reconnect at the same address.
    id.value = "gateway-x";
    gateway.dropAll();
    await until(() => client.state.connection.gatewayId === "gateway-x", 6_000);
    await sleep(600);
    expect(gateway.calls("chat.abort")).toEqual([]);
    expect(await archived).not.toBe("done");
    expect(gateway.calls("sessions.patch")).toEqual([]);
    client.stop();
  });

  it("a deferred Stop's check is kept before its wait for write access, so the send's answer meanwhile aborts on the action's connection", async () => {
    let release: () => void = () => {};
    await deferredStop(
      (client, run) => {
        // The Stop is still waiting for write access when the send's answer comes: its check is
        // already kept, so that answer's abort, and any retry of it, stays on this connection.
        expect((client as unknown as Deferred).deferredStop(KEY, run)).toBeTypeOf("function");
      },
      (client) => {
        // The Stop's own wait for write access lasts past the send's answer.
        const host = client as unknown as {
          ensureScope: (scope: string, owner: object | null) => Promise<void>;
        };
        const ensure = host.ensureScope.bind(client);
        const gate = new Promise<void>((resolve) => (release = resolve));
        host.ensureScope = async (scope, owner) => {
          const stopping = client.state.transcripts[KEY]?.runs.some(
            (each) => each.state === "stopping",
          );
          if (stopping) await gate;
          return ensure(scope, owner);
        };
      },
      () => release(),
    );
  });

  it("a deferred Stop's check stays while its run is stopped with no known outcome, for the history read that can still abort it", async () => {
    const gateway = grantingGateway();
    gateway.handlers["chat.send"] = () => new Promise(() => {});
    const { client, transcript } = await openTask({ gateway });
    const sent = client.sendMessage(KEY, "Take your time");
    await until(() => transcript().runs.some((each) => each.id === sent));
    const live = transcript().runs.find((each) => each.id === sent)!;
    // A run that settled with no known outcome after a Stop, as `readTranscript` may yet abort.
    const unsure = {
      ...live,
      id: "run-unsure",
      messageId: "run-unsure",
      state: "stopped" as const,
      outcomeKnown: false,
      stopRequestedAt: 1,
    };
    client.store.update((state) => ({
      ...state,
      transcripts: {
        ...state.transcripts,
        [KEY]: { ...state.transcripts[KEY]!, runs: [...state.transcripts[KEY]!.runs, unsure] },
      },
    }));
    const host = client as unknown as Deferred;
    expect(host.keepDeferredStop(KEY, "run-unsure", () => true)).toBe(true);
    // Another Stop is kept, which lets go of the checks no longer needed.
    expect(host.keepDeferredStop(KEY, "ended", () => true)).toBe(true);
    expect(host.deferredStop(KEY, "run-unsure")).toBeTypeOf("function");
    client.stop();
  });

  it("a history read that aborts a deferred Stop's run finds its check, though the gateway named the run with another id", async () => {
    const client = new ClawtrateClient(testHost(grantingGateway()), FAST);
    const host = client as unknown as Deferred;
    const check = () => true;
    // Kept under the run's id before it was named: its message id.
    expect(host.keepDeferredStop(KEY, "message-1", check)).toBe(true);
    // The send's answer named it "gateway-run-1", and the run now has that id.
    expect(host.historyStopCheck(KEY, { id: "gateway-run-1", messageId: "message-1" })).toBe(check);
    client.stop();
  });

  it("a deferred Stop named during its wait for write access is aborted once", async () => {
    const gateway = grantingGateway();
    gateway.handlers["gateway.identity.get"] = () => ({ deviceId: "gateway-a" });
    gateway.handlers["sessions.describe"] = () => ({
      session: { key: KEY, sessionId: "s-1", hasActiveRun: true },
    });
    const named = deferred<unknown>();
    gateway.handlers["chat.send"] = () => named.promise;
    gateway.handlers["chat.abort"] = () => ({ ok: true, aborted: true, runIds: [] });
    const { client, transcript } = await openTask({ gateway });
    await until(() => client.state.connection.gatewayId === "gateway-a");
    const run = client.sendMessage(KEY, "Take your time");
    await until(() => gateway.calls("chat.send").length === 1);
    // The Stop's wait for write access lasts past the send's answer.
    const host = client as unknown as {
      ensureScope: (scope: string, owner: object | null) => Promise<void>;
    };
    const ensure = host.ensureScope.bind(client);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    host.ensureScope = async (scope, owner) => {
      if (client.state.transcripts[KEY]?.runs.some((each) => each.state === "stopping")) await gate;
      return ensure(scope, owner);
    };
    void client
      .archiveTask(KEY, { stop: true, stamp: gatewayStamp(client.state.connection) })
      .catch(() => {});
    await until(() => transcript().runs.find((each) => each.id === run)?.state === "stopping");
    named.resolve({ runId: run, status: "started" });
    await until(() => gateway.calls("chat.abort").length === 1);
    release();
    await sleep(300);
    expect(gateway.calls("chat.abort")).toHaveLength(1);
    client.stop();
  });

  it("a deferred Stop's run, once history holds its message, is not aborted on another gateway that a later history read finds it in flight on", async () => {
    const id = { value: "gateway-a" };
    const gateway = grantingGateway();
    gateway.handlers["gateway.identity.get"] = () => ({ deviceId: id.value });
    gateway.handlers["sessions.describe"] = () => ({
      session: { key: KEY, sessionId: "s-1", hasActiveRun: true },
    });
    const named = deferred<unknown>();
    gateway.handlers["chat.send"] = () => named.promise;
    gateway.handlers["chat.abort"] = () => ({ ok: true, aborted: true, runIds: [] });
    let inFlight: unknown = undefined;
    gateway.handlers["chat.history"] = () => ({
      messages: [],
      hasMore: false,
      ...(inFlight ? { inFlightRun: inFlight } : {}),
    });
    const { client, transcript } = await openTask({ gateway });
    await until(() => client.state.connection.gatewayId === "gateway-a");
    const message = client.sendMessage(KEY, "Take your time");
    await until(() => gateway.calls("chat.send").length === 1);
    void client
      .archiveTask(KEY, { stop: true, stamp: gatewayStamp(client.state.connection) })
      .catch(() => {});
    await until(() => transcript().runs.find((each) => each.id === message)?.state === "stopping");
    // The send's answer names the run with the gateway's own id, and its abort goes on this
    // connection, with the archive's check.
    named.resolve({ runId: "gateway-run-1", status: "started" });
    await until(() => gateway.calls("chat.abort").length === 1);
    // A read that holds the message drops its id from the run; the run settles with no known
    // outcome, as a read that no longer finds it in flight leaves it.
    client.store.update((state) => ({
      ...state,
      transcripts: {
        ...state.transcripts,
        [KEY]: {
          ...state.transcripts[KEY]!,
          runs: state.transcripts[KEY]!.runs.map((run) =>
            run.id === "gateway-run-1"
              ? { ...run, messageId: null, state: "stopped" as const, outcomeKnown: false }
              : run,
          ),
        },
      },
    }));
    // Another gateway answers the reconnect at the same address, and its history read finds the
    // run in flight: that read would abort it, but the archive's connection is gone.
    inFlight = { runId: "gateway-run-1" };
    id.value = "gateway-x";
    gateway.dropAll();
    await until(() => client.state.connection.gatewayId === "gateway-x", 6_000);
    await until(() => gateway.calls("chat.history").length >= 2);
    await sleep(600);
    expect(gateway.calls("chat.abort")).toHaveLength(1);
    client.stop();
  });

  it("a deferred Stop given up during its wait for write access leaves no check for a later Stop", async () => {
    const gateway = grantingGateway();
    gateway.handlers["gateway.identity.get"] = () => ({ deviceId: "gateway-a" });
    gateway.handlers["sessions.describe"] = () => ({
      session: { key: KEY, sessionId: "s-1", hasActiveRun: true },
    });
    gateway.handlers["chat.send"] = () => new Promise(() => {});
    const { client, transcript } = await openTask({ gateway });
    await until(() => client.state.connection.gatewayId === "gateway-a");
    const run = client.sendMessage(KEY, "Take your time");
    await until(() => gateway.calls("chat.send").length === 1);
    // The Stop's wait for write access lasts until its viewer has gone.
    const host = client as unknown as {
      ensureScope: (scope: string, owner: object | null) => Promise<void>;
    };
    const ensure = host.ensureScope.bind(client);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    host.ensureScope = async (scope, owner) => {
      if (client.state.transcripts[KEY]?.runs.some((each) => each.state === "stopping")) await gate;
      return ensure(scope, owner);
    };
    const viewer = {};
    void client
      .archiveTask(KEY, {
        stop: true,
        owner: viewer,
        stamp: gatewayStamp(client.state.connection),
      })
      .catch(() => {});
    await until(() => transcript().runs.find((each) => each.id === run)?.state === "stopping");
    expect((client as unknown as Deferred).deferredStop(KEY, run)).toBeTypeOf("function");
    client.withdraw(viewer);
    release();
    await until(() => transcript().runs.find((each) => each.id === run)?.state !== "stopping");
    expect((client as unknown as Deferred).deferredStop(KEY, run)).toBeUndefined();
    client.stop();
  });

  /** A read-tier host whose task action waits for an access grant the gateway approves. */
  async function granted(after: string) {
    const { client, gateway } = await connected(READ_SCOPES);
    let id = "gateway-a";
    gateway.handlers["gateway.identity.get"] = () => ({ deviceId: id });
    gateway.handlers["sessions.describe"] = () => ({
      session: { key: "agent:pip:main", sessionId: "s-main" },
    });
    gateway.handlers["device.scopes.waitUpgrade"] = () => {
      // The grant's reconnect is answered by `after`.
      id = after;
      return {
        requestId: "req-1",
        status: "approved",
        deviceToken: "token-W",
        scopes: [...INTERACTIVE_SCOPES],
      };
    };
    await until(() => client.state.connection.gatewayId === "gateway-a");
    return { client, gateway, stamp: gatewayStamp(client.state.connection) };
  }

  for (const type of ["archive", "delete"] as const)
    it(`${type === "archive" ? "an archive" : "a delete"} that waits for an access grant goes through once the same gateway grants it`, async () => {
      const { client, gateway, stamp } = await granted("gateway-a");
      gateway.handlers["sessions.delete"] = () => ({ ok: true });
      const target = stamp.target;
      const acting =
        type === "archive"
          ? client.archiveTask("agent:pip:main", { stamp })
          : client.deleteTask("agent:pip:main", { stamp });
      expect(await outcome(acting)).toBe("done");
      expect(client.state.connection.target).toBe(target);
      expect(gateway.calls("sessions.patch")).toEqual([
        { key: "agent:pip:main", archived: true, expectedSessionId: "s-main" },
      ]);
      expect(gateway.calls("sessions.delete")).toHaveLength(type === "delete" ? 1 : 0);
      client.stop();
    });

  it("an archive that waits for an access grant is refused when another gateway answers the grant's reconnect", async () => {
    const { client, gateway, stamp } = await granted("gateway-x");
    expect(await outcome(client.archiveTask("agent:pip:main", { stamp }))).toBe(
      "This change was made for another gateway, so nothing was sent.",
    );
    expect(gateway.calls("sessions.patch")).toEqual([]);
    client.stop();
  });

  const changes = [
    {
      title: "F-056: a rename",
      act: (client: ClawtrateClient, stamp: GatewayStamp) =>
        client.renameTask("agent:pip:main", "Weekly", { stamp }),
      patch: { key: "agent:pip:main", label: "Weekly" },
    },
    {
      title: "F-014: a task's pin",
      act: (client: ClawtrateClient, stamp: GatewayStamp) =>
        client.pinTask("agent:pip:main", true, { stamp }),
      patch: { key: "agent:pip:main", pinned: true },
    },
    {
      title: "F-022: a Mark as unread",
      act: (client: ClawtrateClient, stamp: GatewayStamp) =>
        client.markTask("agent:pip:main", true, { stamp }),
      patch: { key: "agent:pip:main", unread: true },
    },
  ];
  for (const { title, act, patch } of changes) {
    it(`${title} that waits for an access grant goes through once the same gateway grants it`, async () => {
      const { client, gateway, stamp } = await granted("gateway-a");
      expect(await outcome(act(client, stamp))).toBe("done");
      expect(client.state.connection.target).toBe(stamp.target);
      expect(gateway.calls("sessions.patch")).toEqual([patch]);
      client.stop();
    });

    it(`${title} that waits for an access grant is refused when another gateway answers the grant's reconnect`, async () => {
      const { client, gateway, stamp } = await granted("gateway-x");
      expect(await outcome(act(client, stamp))).toBe(
        "This change was made for another gateway, so nothing was sent.",
      );
      expect(gateway.calls("sessions.patch")).toEqual([]);
      client.stop();
    });
  }

  const writes = [
    {
      title: "F-277: an archive",
      act: (client: ClawtrateClient, stamp: GatewayStamp) =>
        client.archiveTask("agent:pip:main", { stamp }),
    },
    {
      title: "F-278: a delete",
      act: (client: ClawtrateClient, stamp: GatewayStamp) =>
        client.deleteTask("agent:pip:main", { stamp }),
    },
    ...changes,
  ];
  for (const { title, act } of writes) {
    it(`${title} whose connection drops just after its guard passed sends nothing to another gateway answering the reconnect`, async () => {
      const { client, gateway } = await connected(INTERACTIVE_SCOPES);
      let id = "gateway-a";
      gateway.handlers["gateway.identity.get"] = () => ({ deviceId: id });
      gateway.handlers["sessions.describe"] = () => ({
        session: { key: "agent:pip:main", sessionId: "s-main" },
      });
      gateway.handlers["sessions.delete"] = () => ({ ok: true });
      await until(() => client.state.connection.gatewayId === "gateway-a");
      const host = client as unknown as {
        requireSameGateway(stamp: GatewayStamp): Promise<unknown>;
      };
      const guard = host.requireSameGateway.bind(client);
      let guards = 0;
      host.requireSameGateway = async (stamp) => {
        const passed = await guard(stamp);
        // A connected host runs the guard before it asks for access, then again for the
        // connection the action is bound to: the drop follows that second one.
        if (++guards < 2) return passed;
        id = "gateway-x";
        gateway.dropAll();
        await until(() => client.state.connection.status !== "connected");
        return passed;
      };
      const acting = outcome(act(client, gatewayStamp(client.state.connection)));
      await until(() => client.state.connection.gatewayId === "gateway-x", 6_000);
      const result = await acting;
      expect(gateway.calls("sessions.patch")).toEqual([]);
      expect(gateway.calls("sessions.delete")).toEqual([]);
      expect(result).toBe(CONNECTION_CHANGED);
      client.stop();
    });

    it(`${title} read on one gateway asks no access of a read-only gateway answering at the same address`, async () => {
      const { client, gateway, stamp } = await granted("gateway-b");
      gateway.handlers["gateway.identity.get"] = () => ({ deviceId: "gateway-b" });
      gateway.dropAll();
      await until(() => client.state.connection.gatewayId === "gateway-b", 6_000);
      expect(await outcome(act(client, stamp))).toBe(
        "This change was made for another gateway, so nothing was sent.",
      );
      expect(gateway.calls("device.scopes.requestUpgrade")).toEqual([]);
      expect(gateway.calls("sessions.patch")).toEqual([]);
      client.stop();
    });

    it(`${title} read on one gateway asks no access of a read-only gateway at the same address that hasn't named itself yet`, async () => {
      const { client, gateway, stamp } = await granted("gateway-b");
      const naming = deferred<{ deviceId: string }>();
      gateway.handlers["gateway.identity.get"] = () => naming.promise;
      const asked = gateway.calls("gateway.identity.get").length;
      gateway.dropAll();
      await until(
        () =>
          client.state.connection.status === "connected" &&
          gateway.calls("gateway.identity.get").length > asked,
        6_000,
      );
      expect(client.state.connection.gatewayId).toBeNull();
      const acting = outcome(act(client, stamp));
      naming.resolve({ deviceId: "gateway-b" });
      expect(await acting).toBe("This change was made for another gateway, so nothing was sent.");
      expect(gateway.calls("device.scopes.requestUpgrade")).toEqual([]);
      expect(gateway.calls("sessions.patch")).toEqual([]);
      client.stop();
    });

    it(`${title} made while reconnecting asks no access of another gateway that answers the reconnect`, async () => {
      const { client, gateway, stamp } = await granted("gateway-b");
      gateway.handlers["gateway.identity.get"] = () => ({ deviceId: "gateway-b" });
      gateway.dropAll();
      expect(client.state.connection.status).not.toBe("connected");
      expect(await outcome(act(client, stamp))).toBe(
        "This change was made for another gateway, so nothing was sent.",
      );
      expect(gateway.calls("device.scopes.requestUpgrade")).toEqual([]);
      expect(gateway.calls("sessions.patch")).toEqual([]);
      client.stop();
    });

    it(`${title} whose access request is pending when the connection drops asks no access of another gateway that answers`, async () => {
      const { client, gateway, stamp } = await granted("gateway-b");
      // The request waits on A; a second one, to whichever gateway gets it, is approved.
      const approve = gateway.handlers["device.scopes.waitUpgrade"]!;
      let waits = 0;
      gateway.handlers["device.scopes.waitUpgrade"] = (params) =>
        waits++ === 0 ? new Promise(() => {}) : approve(params);
      const acting = outcome(act(client, stamp));
      await until(() => gateway.calls("device.scopes.waitUpgrade").length === 1);
      gateway.handlers["gateway.identity.get"] = () => ({ deviceId: "gateway-b" });
      gateway.dropAll();
      expect(await acting).toBe("This change was made for another gateway, so nothing was sent.");
      expect(gateway.calls("device.scopes.requestUpgrade")).toHaveLength(1);
      expect(gateway.calls("sessions.patch")).toEqual([]);
      client.stop();
    });

    it(`${title} whose connection drops after its guard asks no access of the read-only connection that replaces it`, async () => {
      const { client, gateway } = await connected(INTERACTIVE_SCOPES);
      gateway.handlers["gateway.identity.get"] = () => ({ deviceId: "gateway-a" });
      gateway.handlers["sessions.describe"] = () => ({
        session: { key: "agent:pip:main", sessionId: "s-main" },
      });
      gateway.handlers["sessions.delete"] = () => ({ ok: true });
      await until(() => client.state.connection.gatewayId === "gateway-a");
      const host = client as unknown as {
        requireSameGateway(stamp: GatewayStamp): Promise<unknown>;
      };
      const guard = host.requireSameGateway.bind(client);
      let guards = 0;
      host.requireSameGateway = async (stamp) => {
        const passed = await guard(stamp);
        if (++guards < 2) return passed;
        // The same gateway answers the reconnect, now granting this device read access only.
        gateway.connectReply = () => ({
          ok: true,
          payload: helloOk([...READ_SCOPES], "device-token"),
        });
        gateway.dropAll();
        await until(
          () => client.state.connection.status === "connected" && !client.state.connection.canWrite,
          6_000,
        );
        return passed;
      };
      const result = await outcome(act(client, gatewayStamp(client.state.connection)));
      expect(gateway.calls("device.scopes.requestUpgrade")).toEqual([]);
      expect(gateway.calls("sessions.patch")).toEqual([]);
      expect(gateway.calls("sessions.delete")).toEqual([]);
      expect(result).toBe(CONNECTION_CHANGED);
      client.stop();
    });
  }

  it("a task change whose screen named no gateway, made while reconnecting, asks no gateway for access", async () => {
    const { client, gateway, stamp } = await granted("gateway-a");
    gateway.dropAll();
    expect(client.state.connection.status).not.toBe("connected");
    expect(
      await outcome(
        client.renameTask("agent:pip:main", "Weekly", { stamp: { ...stamp, gatewayId: null } }),
      ),
    ).toBe("The gateway hasn't said which gateway it is, so nothing was sent.");
    expect(gateway.calls("device.scopes.requestUpgrade")).toEqual([]);
    client.stop();
  });

  it("a task change on a gateway whose identity can't be read says so, not that it is another gateway", async () => {
    const { client, gateway } = await connected(INTERACTIVE_SCOPES);
    gateway.handlers["gateway.identity.get"] = () => ({ deviceId: "gateway-a" });
    await until(() => client.state.connection.gatewayId === "gateway-a");
    const stamp = gatewayStamp(client.state.connection);
    gateway.handlers["gateway.identity.get"] = () => {
      throw new Error("unavailable");
    };
    const asked = gateway.calls("gateway.identity.get").length;
    gateway.dropAll();
    await until(
      () =>
        client.state.connection.status === "connected" &&
        gateway.calls("gateway.identity.get").length > asked,
      6_000,
    );
    expect(await outcome(client.renameTask("agent:pip:main", "Weekly", { stamp }))).toBe(
      "Clawtrate couldn't confirm which gateway this is, so nothing was sent. Try again.",
    );
    expect(gateway.calls("sessions.patch")).toEqual([]);
    client.stop();
  });

  it("a task change whose viewer closes while it waits for the gateway's name asks nothing for it", async () => {
    const { client, gateway, stamp } = await granted("gateway-a");
    const naming = deferred<{ deviceId: string }>();
    gateway.handlers["gateway.identity.get"] = () => naming.promise;
    const asked = gateway.calls("gateway.identity.get").length;
    gateway.dropAll();
    await until(
      () =>
        client.state.connection.status === "connected" &&
        gateway.calls("gateway.identity.get").length > asked,
      6_000,
    );
    const viewer = {};
    const acting = outcome(client.archiveTask("agent:pip:main", { owner: viewer, stamp }));
    client.withdraw(viewer);
    naming.resolve({ deviceId: "gateway-a" });
    expect(await acting).toBe("The request was withdrawn.");
    expect(gateway.calls("device.scopes.requestUpgrade")).toEqual([]);
    expect(gateway.calls("sessions.patch")).toEqual([]);
    client.stop();
  });
});
