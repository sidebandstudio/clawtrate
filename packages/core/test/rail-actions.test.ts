// The rail's task actions and arrangement through the client and the bridge:
// what reaches the gateway, at which tier, and what the state shows.

import { describe, expect, it } from "vitest";
import { createBridgeSession, parseBridgeCommand } from "../src/bridge.ts";
import { ClawtrateClient, CONNECTION_CHANGED_AFTER_SEND } from "../src/client.ts";
import { gatewayStamp } from "../src/types.ts";
import { INTERACTIVE_SCOPES, READ_SCOPES } from "../src/scopes.ts";
import { SIDEBAR_PREF_KEY } from "../src/sidebar.ts";
import { MAX_LISTED_TASKS } from "../src/state-bounds.ts";
import { agentEvent, FAST, grantingGateway, KEY, openTask, URL_A } from "./client-harness.ts";
import { deferred, memoryStorage, sleep, testHost, tokenKey, until } from "./fake-gateway.ts";

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

  /** A read-tier host whose archive waits for an access grant the gateway approves. */
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
});
