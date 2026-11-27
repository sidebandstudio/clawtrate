// A new task's first message says it comes from Clawtrate (#743), as every later one does (#666).
// `sessions.create` takes no `workContext` on OpenClaw 2026.10.6 or 2026.11.10 (both answer
// "invalid sessions.create params: at root: unexpected property 'workContext'"), so the task is
// created without the message and the message follows by `chat.send`, marked, under the
// creation's key. A failure anywhere leaves no task, or the task with its message Not sent and
// its Try again: never a task that silently lacks it, and never the message twice. What a routine,
// a check-in or another bot sends is not a person's message and never carries the mark.
import { describe, expect, it } from "vitest";
import { createBridgeSession } from "../src/bridge.ts";
import { WithdrawnError } from "../src/client.ts";
import { fieldsOf, parseRoutine } from "../src/routines.ts";
import { ADMIN_SCOPES, INTERACTIVE_SCOPES, READ_SCOPES } from "../src/scopes.ts";
import { grantingGateway, openTask, stampOn, URL_A } from "./client-harness.ts";
import {
  deferred,
  GatewayError,
  helloOk,
  memoryStorage,
  sleep,
  tokenKey,
  until,
} from "./fake-gateway.ts";

const MARK = { page: "Clawtrate" };
const NEW_KEY = "agent:otto:dashboard:3a8acb00-128b-4a62-a74b-e6d84841cff1";
type Frame = Record<string, unknown>;

/** A gateway that reports `version` in its hello, as both supported versions do. */
function gatewayOf(version: string) {
  const gateway = grantingGateway();
  gateway.connectReply = (params) => {
    const { scopes, auth } = params as { scopes: string[]; auth?: { deviceToken?: string } };
    const hello = helloOk(scopes, auth?.deviceToken ?? "device-token");
    return { ok: true, payload: { ...hello, server: { ...hello.server, version } } };
  };
  // `sessions.create` with no message, as both versions answer it (read and run on each).
  gateway.handlers["sessions.create"] = () => ({
    ok: true,
    key: NEW_KEY,
    sessionId: "117d0ea4-3792-489d-ae25-c603c455ad8f",
    entry: { sessionId: "117d0ea4-3792-489d-ae25-c603c455ad8f", updatedAt: 1, createdAt: 1 },
    runStarted: false,
    publicRead: false,
    resolved: { modelProvider: "scripted", model: "dev-1" },
  });
  // `chat.send` as both answer it: the run is the send's own key, and history keeps the person's
  // words under that key with ":user" after it.
  const kept: Array<{ sessionKey: string; row: Frame }> = [];
  gateway.handlers["chat.send"] = (params) => {
    const { sessionKey, message, idempotencyKey } = params as Record<string, string>;
    const seq = kept.length + 1;
    kept.push({
      sessionKey: sessionKey!,
      row: {
        role: "user",
        content: message,
        __openclaw: { id: `u${seq}`, seq, idempotencyKey: `${idempotencyKey}:user` },
      },
    });
    return { runId: idempotencyKey, status: "started", messageSeq: seq };
  };
  gateway.handlers["chat.history"] = (params) => ({
    messages: kept
      .filter((each) => each.sessionKey === (params as { sessionKey: string }).sessionKey)
      .map((each) => each.row),
    hasMore: false,
  });
  return gateway;
}

const frames = (gateway: { requests: Array<{ method: string; params: unknown }> }) =>
  gateway.requests
    .filter((r) => r.method === "sessions.create" || r.method === "chat.send")
    .map((r) => [r.method, r.params as Frame] as const);
/** The new task shows the person's words once, from the gateway's history, and holds nothing unsent. */
const deliveredOnce = (
  client: { state: { transcripts: Record<string, { outbox: unknown[]; items: unknown[] }> } },
  text: string,
) => {
  const task = client.state.transcripts[NEW_KEY];
  const shown = (task?.items ?? []).filter(
    (item) =>
      (item as { role: string }).role === "user" &&
      JSON.stringify(item).includes(JSON.stringify(text).slice(1, -1)),
  );
  return task?.outbox.length === 0 && shown.length === 1;
};
const outboxOf = (client: { state: { transcripts: Record<string, { outbox: unknown[] }> } }) =>
  (client.state.transcripts[NEW_KEY]?.outbox ?? []) as Array<{
    id: string;
    text: string;
    status: string;
  }>;

describe.each(["2026.10.6", "2026.11.10"])(
  "a new task's first message on OpenClaw %s",
  (version) => {
    it("Start as new task: created without the message, which follows by chat.send, marked, under the creation's key", async () => {
      const gateway = gatewayOf(version);
      const { client } = await openTask({ gateway });
      const viewer = createBridgeSession(client);
      // As the composer asks it.
      const { key } = await viewer.apply({
        type: "createTask",
        botId: "otto",
        text: "Hello, where are you?",
        label: null,
      });
      expect(key).toBe(NEW_KEY);
      await until(() => deliveredOnce(client, "Hello, where are you?"));
      const [create, send, ...rest] = frames(gateway).map(([, params]) => params);
      expect(rest).toEqual([]);
      expect(create).toEqual({ agentId: "otto", idempotencyKey: expect.any(String) });
      expect(send).toEqual({
        sessionKey: NEW_KEY,
        message: "Hello, where are you?",
        idempotencyKey: create!.idempotencyKey,
        queueMode: "followup",
        workContext: MARK,
      });
      // Its run is the gateway's run for that key.
      expect(client.state.transcripts[NEW_KEY]!.runs[0]).toMatchObject({
        id: create!.idempotencyKey,
        state: "running",
      });
      // The composer lets the new task go; its message is the task's now.
      viewer.dispose();
      client.stop();
    });

    it("New task, then typing: created empty, the first message marked as any other", async () => {
      const gateway = gatewayOf(version);
      const { client } = await openTask({ gateway });
      const viewer = createBridgeSession(client);
      const { key } = await viewer.apply({ type: "newTask", botId: "otto", label: null });
      await viewer.apply({ type: "openSession", key });
      await until(() => client.state.transcripts[key]?.status === "ready");
      await viewer.apply({ type: "sendMessage", key, text: "Hi", mode: "auto", attachmentIds: [] });
      await until(() => gateway.calls("chat.send").length === 1);
      const [create, send] = frames(gateway).map(([, params]) => params);
      expect(create).toEqual({ agentId: "otto" });
      expect(send).toMatchObject({ sessionKey: key, message: "Hi", workContext: MARK });
      viewer.dispose();
      client.stop();
    });

    it("a command or a stop word that starts a task goes without the mark, as it would in any task", async () => {
      const gateway = gatewayOf(version);
      gateway.handlers["chat.send"] = () => ({ ok: true, aborted: false, runIds: [] });
      const { client } = await openTask({ gateway });
      await client.createTask("otto", "/status");
      await until(() => gateway.calls("chat.send").length === 1);
      expect(gateway.calls("chat.send")[0]).not.toHaveProperty("workContext");
      client.stop();
    });

    it("a refused creation leaves no task and sends nothing; its retry, with its own key, sends the message once, marked", async () => {
      const gateway = gatewayOf(version);
      const created = gateway.handlers["sessions.create"]!;
      gateway.handlers["sessions.create"] = () => {
        throw new GatewayError({ code: "UNAVAILABLE", message: "capacity is full" });
      };
      const { client } = await openTask({ gateway });
      await expect(client.createTask("otto", "Hello")).rejects.toThrow("capacity is full");
      expect(gateway.calls("chat.send")).toEqual([]);
      expect(client.state.transcripts[NEW_KEY]).toBeUndefined();
      const [creation] = client.state.creations;
      expect(creation).toMatchObject({ text: "Hello", status: "failed" });
      gateway.handlers["sessions.create"] = created;
      await client.retryCreation(creation!.id);
      await until(() => deliveredOnce(client, "Hello"));
      expect(frames(gateway).map(([method, params]) => [method, params.idempotencyKey])).toEqual([
        ["sessions.create", creation!.id],
        ["sessions.create", creation!.id],
        ["chat.send", creation!.id],
      ]);
      expect(gateway.calls("chat.send")[0]).toMatchObject({ workContext: MARK });
      client.stop();
    });

    it("a creation whose answer was lost, asked again with its key, sends its message once, marked", async () => {
      const gateway = gatewayOf(version);
      const created = gateway.handlers["sessions.create"]!;
      let asks = 0;
      gateway.handlers["sessions.create"] = (params) =>
        (asks += 1) === 1 ? new Promise(() => {}) : created(params);
      const { client } = await openTask({
        gateway,
        client: { requestTimeoutMs: 120, creationCheckMs: 40 },
      });
      await expect(client.createTask("otto", "Hello")).rejects.toThrow("being checked");
      await until(() => client.state.creations[0]?.status === "created");
      await until(() => deliveredOnce(client, "Hello"));
      expect(gateway.calls("chat.send")).toMatchObject([
        { sessionKey: NEW_KEY, message: "Hello", workContext: MARK },
      ]);
      client.stop();
    });

    it("the send refused: the task holds its message Not sent, with Try again, which sends it once more, marked", async () => {
      const gateway = gatewayOf(version);
      const accept = gateway.handlers["chat.send"]!;
      gateway.handlers["chat.send"] = () => {
        throw new GatewayError({ code: "UNAVAILABLE", message: "budget exhausted" });
      };
      const { client } = await openTask({ gateway });
      const viewer = createBridgeSession(client);
      await viewer.apply({ type: "createTask", botId: "otto", text: "Hello", label: null });
      await until(() => outboxOf(client)[0]?.status === "failed");
      // The composer let it go: the task is kept for its message.
      viewer.dispose();
      expect(client.state.transcripts[NEW_KEY]).toBeDefined();
      expect(outboxOf(client)).toMatchObject([{ text: "Hello", status: "failed" }]);
      gateway.handlers["chat.send"] = accept;
      client.openSession(NEW_KEY);
      client.retryMessage(NEW_KEY, outboxOf(client)[0]!.id);
      await until(() => deliveredOnce(client, "Hello"));
      const sent = gateway.calls("chat.send") as Frame[];
      expect(sent).toHaveLength(2);
      expect(new Set(sent.map((p) => p.idempotencyKey)).size).toBe(1);
      for (const params of sent) expect(params.workContext).toEqual(MARK);
      client.stop();
    });

    it("the send's answer lost: never sent again by itself, and kept, unknown, to retry or delete", async () => {
      const gateway = gatewayOf(version);
      gateway.handlers["chat.send"] = () => new Promise(() => {});
      const { client } = await openTask({ gateway, client: { requestTimeoutMs: 120 } });
      await client.createTask("otto", "Hello");
      // History doesn't hold it: whether it arrived isn't known, and the person decides.
      await until(() => outboxOf(client)[0]?.status === "unknown", 3_000);
      expect(gateway.calls("chat.send")).toHaveLength(1);
      expect(gateway.calls("chat.send")[0]).toMatchObject({ workContext: MARK });
      client.stop();
    });

    it("the connection drops between the two: the message waits for the connection and goes once, marked", async () => {
      const gateway = gatewayOf(version);
      const created = gateway.handlers["sessions.create"]!;
      // The answer goes out, and the connection drops before anything else can.
      gateway.handlers["sessions.create"] = (params) => {
        void Promise.resolve().then(() => Promise.resolve().then(() => gateway.dropAll()));
        return created(params);
      };
      const { client } = await openTask({ gateway });
      const connects = gateway.connects.length;
      await client.createTask("otto", "Hello");
      await until(() => deliveredOnce(client, "Hello"), 3_000);
      expect(gateway.connects.length).toBeGreaterThan(connects);
      expect(gateway.calls("chat.send")).toMatchObject([{ message: "Hello", workContext: MARK }]);
      // It left on the new connection, after the drop.
      const methods = gateway.requests.map((r) => r.method);
      expect(methods.lastIndexOf("sessions.create")).toBeLessThan(methods.indexOf("chat.send"));
      client.stop();
    });

    it("the connection drops between the two and another gateway answers at the same address: the message isn't sent there, and stays Not sent", async () => {
      const gateway = gatewayOf(version);
      const created = gateway.handlers["sessions.create"]!;
      gateway.handlers["sessions.create"] = (params) => {
        gateway.handlers["gateway.identity.get"] = () => ({ deviceId: "gateway-x" });
        void Promise.resolve().then(() => Promise.resolve().then(() => gateway.dropAll()));
        return created(params);
      };
      const { client } = await openTask({ gateway });
      await until(() => client.state.connection.gatewayId === "gateway-test");
      const connects = gateway.connects.length;
      await client.createTask("otto", "Hello");
      await until(() => outboxOf(client)[0]?.status === "failed", 3_000);
      expect(gateway.connects.length).toBeGreaterThan(connects);
      expect(outboxOf(client)).toMatchObject([{ text: "Hello", gatewayId: "gateway-test" }]);
      expect(gateway.calls("chat.send")).toEqual([]);
      client.stop();
    });

    it.each([
      ["another gateway", "gateway-x", false],
      ["the same gateway", "gateway-test", true],
    ])(
      "the connection drops while write access is approved and %s answers: the task is asked of it only if it is the one it was written for",
      async (_name, answering, created) => {
        const gateway = gatewayOf(version);
        const approved = deferred<void>();
        let asks = 0;
        gateway.handlers["device.scopes.requestUpgrade"] = () => ({
          requestId: `up-${(asks += 1)}`,
        });
        gateway.handlers["device.scopes.waitUpgrade"] = () =>
          approved.promise.then(() => ({
            status: "approved",
            requestId: `up-${asks}`,
            deviceToken: "rotated",
            scopes: [...INTERACTIVE_SCOPES],
          }));
        const { client } = await openTask({ gateway, held: READ_SCOPES });
        await until(() => client.state.connection.gatewayId === "gateway-test");
        const creation = client.createTask("otto", "Hello");
        creation.catch(() => {});
        await until(() => asks === 1);
        gateway.handlers["gateway.identity.get"] = () => ({ deviceId: answering });
        gateway.dropAll();
        await until(() => client.state.connection.gatewayId === answering, 3_000);
        approved.resolve();
        if (created) {
          await creation;
          expect(gateway.calls("sessions.create")).toHaveLength(1);
        } else {
          await expect(creation).rejects.toThrow("written for another gateway");
          expect(gateway.calls("sessions.create")).toEqual([]);
          expect(client.state.creations).toEqual([]);
        }
        client.stop();
      },
    );

    it("a viewer closed while the gateway is named: no access is asked for its task", async () => {
      const gateway = gatewayOf(version);
      gateway.handlers["device.scopes.requestUpgrade"] = () => ({ requestId: "up-1" });
      const { client } = await openTask({ gateway, held: READ_SCOPES });
      await until(() => client.state.connection.gatewayId === "gateway-test");
      const named = deferred<unknown>();
      gateway.handlers["gateway.identity.get"] = () => named.promise;
      const reads = gateway.calls("gateway.identity.get").length;
      gateway.dropAll();
      await until(
        () =>
          client.state.connection.status === "connected" &&
          gateway.calls("gateway.identity.get").length > reads,
      );
      const viewer = {};
      const creation = client.createTask("otto", "Hello", { owner: viewer });
      creation.catch(() => {});
      client.withdraw(viewer);
      named.resolve({ deviceId: "gateway-test" });
      await expect(creation).rejects.toThrow(WithdrawnError);
      expect(gateway.calls("device.scopes.requestUpgrade")).toEqual([]);
      expect(client.pendingAccessWaiters).toBe(0);
      client.stop();
    });

    it("listed before its first message reaches the gateway: New task until the creation's answer, then named from the words, with no preview", async () => {
      const gateway = gatewayOf(version);
      const created = gateway.handlers["sessions.create"]!;
      const sent = gateway.handlers["chat.send"]!;
      const answer = deferred<void>();
      const delivered = deferred<void>();
      gateway.handlers["sessions.create"] = async (params) => {
        await answer.promise;
        return created(params);
      };
      gateway.handlers["chat.send"] = async (params) => {
        await delivered.promise;
        return sent(params);
      };
      const { client } = await openTask({ gateway });
      // The new session's row, as a list reads it before any message has reached it.
      const listed = { key: NEW_KEY, sessionId: "117d0ea4", updatedAt: 1, createdAt: 1 };
      gateway.handlers["sessions.list"] = () => ({ sessions: [listed], hasMore: false });
      const row = () => client.state.tasksByBot.otto?.[0];
      const creating = client.createTask("otto", "Hello, where are you?");
      await until(() => gateway.calls("sessions.create").length === 1);
      gateway.emit("sessions.changed", { sessionKey: NEW_KEY, reason: "create" });
      await until(() => row() !== undefined);
      // Nothing yet ties the row to the words: it reads as an empty task for one round trip.
      expect(row()).toMatchObject({ title: "New task", preview: null });
      answer.resolve();
      await creating;
      await until(() => gateway.calls("chat.send").length === 1);
      expect(row()).toMatchObject({
        title: "Hello, where are you?",
        preview: null,
        status: "idle",
      });
      delivered.resolve();
      await until(() => deliveredOnce(client, "Hello, where are you?"));
      client.stop();
    });

    it("a creation the gateway made but whose setup failed: the message waits Not sent, for the person's Try again", async () => {
      const gateway = gatewayOf(version);
      const created = gateway.handlers["sessions.create"]!;
      gateway.handlers["sessions.create"] = (params) => ({
        ...(created(params) as Frame),
        runError: { code: "UNAVAILABLE", message: "worktree lifecycle failed" },
      });
      const { client } = await openTask({ gateway });
      await client.createTask("otto", "Hello");
      expect(outboxOf(client)).toMatchObject([
        { text: "Hello", status: "failed", error: "worktree lifecycle failed" },
      ]);
      await sleep(50);
      expect(gateway.calls("chat.send")).toEqual([]);
      client.stop();
    });
  },
);

describe("what isn't a person's message never carries the mark", () => {
  it("a routine's instruction, saved and run now, goes without it", async () => {
    const JOB = "b848f781-dd42-4069-ba05-d104990bec2c";
    const job = {
      id: JOB,
      agentId: "main",
      name: "Morning digest",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 2,
      schedule: { kind: "cron", expr: "0 8 * * *", tz: "America/New_York" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Summarise yesterday." },
      delivery: { mode: "none" },
      state: {},
    };
    const gateway = grantingGateway();
    gateway.handlers["gateway.identity.get"] = () => ({ deviceId: "gateway-1" });
    gateway.handlers["cron.status"] = () => ({ enabled: true });
    gateway.handlers["cron.list"] = () => ({ jobs: [job], hasMore: false });
    gateway.handlers["cron.add"] = () => job;
    gateway.handlers["cron.run"] = () => ({ ok: true, ran: true });
    const storage = memoryStorage({
      connection: JSON.stringify({ url: URL_A, token: null }),
      [tokenKey(URL_A)]: JSON.stringify({
        token: "device-token",
        grantedScopes: ADMIN_SCOPES,
        heldScopes: INTERACTIVE_SCOPES,
        adminHeld: true,
      }),
    });
    const { client } = await openTask({ gateway, storage });
    await until(() => client.state.connection.canAdmin);
    await client.refreshRoutines();
    const stamp = stampOn("gateway-1", client);
    const input = { ...fieldsOf(parseRoutine(job)!), botId: "main" };
    expect(await client.createRoutine(input, "draft-1", null, stamp)).toMatchObject({
      status: "saved",
    });
    await client.runRoutineNow(JOB, null, client.state.routines.listedOn, stamp);
    expect(gateway.calls("cron.add")).toHaveLength(1);
    expect(gateway.calls("cron.run")).toHaveLength(1);
    for (const method of ["cron.add", "cron.run"]) {
      for (const params of gateway.calls(method)) {
        expect(JSON.stringify(params)).not.toMatch(/workContext|Working context|Clawtrate/);
      }
    }
    client.stop();
  });
});
