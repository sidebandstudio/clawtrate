// A task's model and effort (conversation.md section 25): the engine's rules,
// and the client's send path around them, against a fake gateway.

import { describe, expect, it } from "vitest";
import {
  emptyTaskModel,
  followingEffort,
  shownChoice,
  TaskModelAccessError,
  TaskModelsEngine,
  taskModelLine,
  type TaskModelsContext,
  type TaskModelView,
} from "../src/task-models.ts";
import type { CatalogModel } from "../src/accounts.ts";
import type { Task } from "../src/types.ts";
import { agentEvent, grantingGateway, KEY, openTask } from "./client-harness.ts";
import { GatewayError, memoryStorage, until } from "./fake-gateway.ts";

const LEVELS = ["off", "minimal", "low", "medium", "high", "ultra"];
const MODELS: CatalogModel[] = [
  {
    provider: "acme",
    id: "dev-1",
    name: null,
    available: true,
    levels: LEVELS,
    defaultLevel: "low",
  },
  {
    provider: "acme",
    id: "dev-2",
    name: null,
    available: true,
    levels: LEVELS,
    defaultLevel: "low",
  },
  {
    provider: "acme",
    id: "dev-lite",
    name: null,
    available: true,
    levels: ["off", "ultra"],
    defaultLevel: "off",
  },
  {
    provider: "globex",
    id: "dev-1",
    name: null,
    available: true,
    levels: LEVELS,
    defaultLevel: "low",
  },
];
const listAnswer = (selected: string | null = null) => ({
  models: MODELS.map((m) => ({
    id: m.id,
    provider: m.provider,
    available: m.available,
    thinkingLevels: m.levels.map((id) => ({ id, label: id })),
    thinkingDefault: m.defaultLevel,
  })),
  accountSelection: selected
    ? { kind: "shared", authProfileId: selected, source: "user" }
    : { kind: "automatic" },
});
const word = (level: string) => level[0]!.toUpperCase() + level.slice(1);

/** An engine over a plain context: what it asks the gateway, and what it changes. */
function rig(options: { task?: Partial<Task>; active?: boolean; write?: boolean } = {}) {
  let views: Record<string, TaskModelView> = {};
  let task: Task = {
    key: KEY,
    botId: "otto",
    sessionId: "session-1",
    title: "Disk",
    preview: null,
    updatedAt: 1,
    status: "done",
    unread: false,
    model: "acme/dev-1",
    effortDefault: "low",
    ...options.task,
  };
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const state = {
    active: options.active ?? false,
    refreshed: 0,
    released: [] as string[],
    refuse: null as string | null,
  };
  const storage = memoryStorage();
  let id = 0;
  const ctx: TaskModelsContext = {
    request: async (method, params) => {
      requests.push({ method, params: params as Record<string, unknown> });
      if (method === "models.list") return listAnswer();
      if (method === "sessions.patch") {
        if (state.refuse) throw new Error(state.refuse);
        const p = params as { model?: string; thinkingLevel?: string };
        const ref = p.model?.split("@")[0];
        return {
          ok: true,
          entry: {
            sessionId: "session-1",
            ...(p.thinkingLevel ? { thinkingLevel: p.thinkingLevel } : {}),
          },
          resolved: ref
            ? { modelProvider: ref.split("/")[0], model: ref.split("/")[1] }
            : { modelProvider: "acme", model: task.model!.split("/")[1] },
        };
      }
      return {};
    },
    get: () => views,
    update: (change) => {
      views = change(views);
    },
    task: () => task,
    botAccount: () => "acme:home",
    active: () => state.active,
    lastTurnEnd: () => 5_000,
    connected: () => true,
    canWrite: () => options.write ?? true,
    ensureWrite: async () => {},
    applyRow: (_key, fields) => {
      task = {
        ...task,
        ...(typeof fields.model === "string"
          ? { model: `${String(fields.modelProvider)}/${fields.model}` }
          : {}),
        ...(typeof fields.thinkingLevel === "string" ? { effort: fields.thinkingLevel } : {}),
      };
    },
    refreshTasks: () => {
      state.refreshed += 1;
    },
    released: (key) => state.released.push(key),
    storage,
    storageKey: () => "clawtrate.task-models:gateway-1",
    now: () => 9_000,
    randomId: () => `id-${(id += 1)}`,
    log: () => {},
  };
  const engine = new TaskModelsEngine(ctx);
  return {
    engine,
    ctx,
    storage,
    state,
    requests,
    view: () => views[KEY]!,
    task: () => task,
    patches: () => requests.filter((r) => r.method === "sessions.patch").map((r) => r.params),
  };
}

async function opened(r: ReturnType<typeof rig>) {
  r.engine.open(KEY);
  await until(() => r.view().catalog === "ready");
}

describe("a task's model and effort", () => {
  it("F-042: lists only the models of the task's provider, from models.list {sessionKey}", async () => {
    const r = rig();
    await opened(r);
    expect(r.requests.find((q) => q.method === "models.list")?.params).toEqual({ sessionKey: KEY });
    expect(r.view().models.map((m) => `${m.provider}/${m.id}`)).toEqual([
      "acme/dev-1",
      "acme/dev-2",
      "acme/dev-lite",
    ]);
  });

  it("F-042 F-045: a change with no turn running is saved at once, with the bot's account and the task's session, and leaves a line", async () => {
    const r = rig();
    await opened(r);
    await expect(r.engine.choose(KEY, { model: "acme/dev-2", effort: null })).resolves.toBe(
      "saved",
    );
    expect(r.patches()).toEqual([
      { key: KEY, model: "acme/dev-2@acme:home", expectedSessionId: "session-1" },
    ]);
    expect(r.task().model).toBe("acme/dev-2");
    const [line] = r.view().events;
    expect(line).toMatchObject({
      outcome: "changed",
      model: "acme/dev-2",
      effort: null,
      after: 5_000,
    });
    expect(taskModelLine(line!, word)).toBe("Model changed to acme/dev-2 · from the next turn");
  });

  it("F-043: an effort alone writes thinkingLevel, and choosing what the task has writes nothing", async () => {
    const r = rig();
    await opened(r);
    await r.engine.choose(KEY, { model: null, effort: "high" });
    expect(r.patches()).toEqual([
      { key: KEY, thinkingLevel: "high", expectedSessionId: "session-1" },
    ]);
    expect(taskModelLine(r.view().events[0]!, word)).toBe(
      "Effort changed to High · from the next turn",
    );
    await expect(r.engine.choose(KEY, { model: null, effort: "high" })).resolves.toBe("unchanged");
    expect(r.patches()).toHaveLength(1);
  });

  it("F-043: a model that lacks the task's effort takes its own default, and the line says so", async () => {
    const r = rig({ task: { effort: "high" } });
    await opened(r);
    await r.engine.choose(KEY, { model: "acme/dev-lite", effort: null });
    expect(r.patches()[0]).toMatchObject({
      model: "acme/dev-lite@acme:home",
      thinkingLevel: "off",
    });
    const line = r.view().events[0]!;
    expect(line.followed).toBe(true);
    expect(taskModelLine(line, word)).toBe(
      "Model changed to acme/dev-lite, effort to Off · from the next turn",
    );
    expect(followingEffort(MODELS[1], "high")).toBe("high");
  });

  it("F-045: a change during a turn is held, sent once the turn settles, and nothing is sent while it is held", async () => {
    const r = rig({ active: true });
    await opened(r);
    await expect(r.engine.choose(KEY, { model: "acme/dev-2", effort: null })).resolves.toBe("held");
    expect(r.patches()).toEqual([]);
    expect(r.view().held).toMatchObject({ model: "acme/dev-2", sessionId: "session-1" });
    expect(shownChoice(r.task(), r.view())).toEqual({
      model: "acme/dev-2",
      effort: "low",
      held: true,
    });
    // Choosing an effort too joins the held change.
    await r.engine.choose(KEY, { model: null, effort: "high" });
    expect(r.view().held).toMatchObject({ model: "acme/dev-2", effort: "high" });
    expect(r.engine.release(KEY)).toBe(false);
    expect(r.engine.hasWork(KEY)).toBe(true);
    r.state.active = false;
    expect(r.engine.release(KEY)).toBe(true);
    // While the save is on its way nothing queued may start.
    expect(r.engine.release(KEY)).toBe(true);
    await r.engine.settled(KEY);
    expect(r.patches()).toEqual([
      {
        key: KEY,
        model: "acme/dev-2@acme:home",
        thinkingLevel: "high",
        expectedSessionId: "session-1",
      },
    ]);
    expect(r.view().held).toBeNull();
    expect(r.state.released).toContain(KEY);
    expect(r.engine.hasWork(KEY)).toBe(false);
  });

  it("F-045: Keep lets go of a held change", async () => {
    const r = rig({ active: true });
    await opened(r);
    await r.engine.choose(KEY, { model: "acme/dev-2", effort: null });
    r.engine.keep(KEY);
    r.state.active = false;
    expect(r.engine.release(KEY)).toBe(false);
    expect(r.patches()).toEqual([]);
  });

  it("F-045: a change the gateway refuses says so with its reason, keeps what the gateway has and reads the task again", async () => {
    const r = rig();
    await opened(r);
    r.state.refuse = 'thinkingLevel "high" is not supported for acme/dev-lite (use off|ultra)';
    await r.engine.choose(KEY, { model: null, effort: "high" });
    expect(r.task().effort).toBeUndefined();
    expect(r.view().refused?.error).toContain("is not supported for acme/dev-lite");
    const line = r.view().events[0]!;
    expect(line.outcome).toBe("refused");
    expect(taskModelLine(line, word)).toBe(
      `Couldn't change the effort to High: thinkingLevel "high" is not supported for acme/dev-lite (use off|ultra)`,
    );
    expect(r.state.refreshed).toBe(1);
  });

  it("F-042: the account the task's conversation selected is written before the bot's", async () => {
    const r = rig();
    r.ctx.request = async (method, params) => {
      r.requests.push({ method, params: params as Record<string, unknown> });
      return method === "models.list" ? listAnswer("acme:work") : { ok: true };
    };
    await opened(r);
    expect(r.view().account).toBe("acme:work");
    await r.engine.choose(KEY, { model: "acme/dev-2", effort: null });
    expect(r.patches()[0]?.model).toBe("acme/dev-2@acme:work");
  });

  it("F-042: a connection that may only read cannot change it, and nothing is asked of the gateway", async () => {
    const r = rig({ write: false });
    await opened(r);
    await expect(
      r.engine.choose(KEY, { model: "acme/dev-2", effort: null }),
    ).rejects.toBeInstanceOf(TaskModelAccessError);
    expect(r.patches()).toEqual([]);
  });

  it("F-044 F-045: the lines and the requested efforts outlive the engine, read back from this device's record", async () => {
    const r = rig();
    await opened(r);
    await r.engine.choose(KEY, { model: "acme/dev-2", effort: null });
    expect(r.engine.effortToSend(KEY)).toBe("low");
    r.engine.recordRequested(KEY, "run-1", "low");
    await until(() =>
      (r.storage.data.get("clawtrate.task-models:gateway-1") ?? "").includes("run-1"),
    );
    // A new engine, as after a restart, on the same storage.
    const again = rig();
    for (const [key, value] of r.storage.data) await again.storage.set(key, value);
    await opened(again);
    await until(() => again.view().events.length === 1);
    expect(again.view().requested).toEqual([{ runId: "run-1", effort: "low" }]);
    expect(again.view().events[0]?.model).toBe("acme/dev-2");
  });

  it("F-044: a record that is not one is ignored", async () => {
    const r = rig();
    await r.storage.set("clawtrate.task-models:gateway-1", "{not json");
    await opened(r);
    expect(r.view()).toMatchObject({ events: [], requested: [] });
    expect(emptyTaskModel.events).toEqual([]);
  });
});

describe("the client around a task's model", () => {
  const row = {
    key: KEY,
    agentId: "otto",
    sessionId: "session-1",
    label: "Disk",
    updatedAt: 1,
    modelProvider: "acme",
    model: "dev-1",
    thinkingDefault: "low",
  };
  function gatewayWithTask() {
    const gateway = grantingGateway();
    gateway.handlers["sessions.subscribe"] = () => ({
      subscribed: true,
      list: { sessions: [row], hasMore: false },
    });
    gateway.handlers["sessions.list"] = () => ({ sessions: [row], hasMore: false });
    gateway.handlers["models.list"] = () => listAnswer();
    gateway.handlers["sessions.patch"] = (params) => {
      const p = params as { model?: string; thinkingLevel?: string };
      if (p.thinkingLevel === "ultra")
        throw new GatewayError({ code: "INVALID_REQUEST", message: "not this one" });
      const ref = (p.model ?? "acme/dev-1").split("@")[0]!;
      return {
        ok: true,
        entry: {
          sessionId: "session-1",
          ...(p.thinkingLevel ? { thinkingLevel: p.thinkingLevel } : {}),
        },
        resolved: { modelProvider: ref.split("/")[0], model: ref.split("/")[1] },
      };
    };
    return gateway;
  }

  it("F-044: a message that starts a turn asks for the effort the chip shows, and the turn records it as requested", async () => {
    const { client, gateway } = await openTask({ gateway: gatewayWithTask() });
    await until(() => client.state.taskModels[KEY]?.catalog === "ready");
    client.sendMessage(KEY, "hello");
    await until(() => gateway.calls("chat.send").length === 1);
    expect(gateway.calls("chat.send")[0]).toMatchObject({ message: "hello", thinking: "low" });
    await until(() => client.state.taskModels[KEY]?.requested.length === 1);
    expect(client.state.taskModels[KEY]?.requested).toEqual([{ runId: "run-1", effort: "low" }]);
    client.stop();
  });

  it("F-045: a change made during a turn is saved when the turn ends, before the message queued behind it starts", async () => {
    const { client, gateway } = await openTask({ gateway: gatewayWithTask() });
    await until(() => client.state.taskModels[KEY]?.catalog === "ready");
    client.sendMessage(KEY, "first");
    await until(() => gateway.calls("chat.send").length === 1);
    gateway.emit("agent", agentEvent("run-1", 1, "lifecycle", { phase: "start" }));
    await until(() => client.state.transcripts[KEY]!.runs.some((run) => run.state === "running"));
    await expect(client.setTaskModel(KEY, "acme/dev-2", null)).resolves.toBe("held");
    // The gateway answers the patch slowly: the queued message must still wait for it.
    const answer = gateway.handlers["sessions.patch"]!;
    let answered = false;
    gateway.handlers["sessions.patch"] = (params) =>
      new Promise((resolve) =>
        setTimeout(() => {
          answered = true;
          resolve(answer(params));
        }, 300),
      );
    const savedFirst: boolean[] = [];
    gateway.handlers["chat.send"] = () => {
      savedFirst.push(answered);
      return { runId: "run-2", status: "started" };
    };
    client.sendMessage(KEY, "second", { mode: "queue" });
    expect(gateway.calls("sessions.patch")).toEqual([]);
    gateway.emit("agent", agentEvent("run-1", 2, "lifecycle", { phase: "end" }));
    await until(() => gateway.calls("chat.send").length === 2);
    const order = gateway.requests
      .filter((r) => r.method === "sessions.patch" || r.method === "chat.send")
      .map((r) => r.method);
    expect(order).toEqual(["chat.send", "sessions.patch", "chat.send"]);
    expect(savedFirst).toEqual([true]);
    expect(gateway.calls("sessions.patch")[0]).toMatchObject({
      key: KEY,
      model: "acme/dev-2",
      expectedSessionId: "session-1",
    });
    await until(() => client.state.taskModels[KEY]?.events.length === 1);
    expect(client.state.tasksByBot.otto?.[0]?.model).toBe("acme/dev-2");
    client.stop();
  });

  it("F-045: a refused change leaves a line with the gateway's reason", async () => {
    const { client, gateway } = await openTask({ gateway: gatewayWithTask() });
    await until(() => client.state.taskModels[KEY]?.catalog === "ready");
    await client.setTaskModel(KEY, null, "ultra");
    expect(gateway.calls("sessions.patch")).toHaveLength(1);
    expect(client.state.taskModels[KEY]?.events[0]).toMatchObject({
      outcome: "refused",
      effort: "ultra",
      error: "not this one",
    });
    client.stop();
  });
});

describe("a bot's model and effort", () => {
  it("F-042 F-043: an effort saved right after a model keeps that model, also when the read after the model's save fails", async () => {
    const { AccountsGateway, accountsClient } = await import("./accounts-fake.ts");
    const fake = new AccountsGateway();
    const { client, accounts } = await accountsClient({ gateway: fake });
    await client.setBotModel("otto", "dev-2", null);
    expect(accounts().bindings.find((b) => b.botId === "otto")?.model).toBe("dev-2");
    // The gateway reloads after a write to a bot's entry: the read after the next save fails.
    const authStatus = fake.gateway.handlers["models.authStatus"]!;
    fake.gateway.handlers["models.authStatus"] = () => {
      throw new GatewayError({ code: "UNAVAILABLE", message: "reloading" });
    };
    await client.setBotModel("otto", "dev-1", null);
    fake.gateway.handlers["models.authStatus"] = authStatus;
    // The person chooses an effort next, from what the settings show.
    const shown = accounts().bindings.find((b) => b.botId === "otto")!;
    expect(shown.model).toBe("dev-1");
    await client.setBotModel("otto", shown.model!, "high");
    const otto = (fake.config.agents as { entries: Record<string, Record<string, unknown>> })
      .entries.otto!;
    expect(otto.model).toEqual({ primary: "acme/dev-1@acme:work", fallbacks: [] });
    expect(otto.thinkingDefault).toBe("high");
    client.stop();
  });
});
