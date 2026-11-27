// A task's name, written by a small model (#750). The gateway's frames here are each version's as a
// development gateway sent them (`sessions.title.prepare`'s answer, `sessions.patch {autoLabel}`'s
// `sessions.changed`), with made-up keys and names.

import { describe, expect, it } from "vitest";
import type { CatalogModel } from "../src/accounts.ts";
import { MAX_NAMED_TASKS } from "../src/client.ts";
import { groupTasks, mapSessionRow } from "../src/mapping.ts";
import { readMessageSearch } from "../src/search.ts";
import { mapArchivedRow } from "../src/task-actions.ts";
import {
  MAX_NAMING_CALLS,
  MAX_NAMING_SOURCE_CHARS,
  MAX_TASK_NAME_CHARS,
  NAMING_MODELS,
  nameTask,
  namingCalls,
  namingSource,
} from "../src/task-names.ts";
import { grantingGateway, openTask } from "./client-harness.ts";
import { GatewayError, sleep, until, type FakeGateway } from "./fake-gateway.ts";

const KEY = "agent:main:dashboard:3f2a9c1e-6b7d-4e8f-a0b1-c2d3e4f5a6b7";
const MESSAGE = "Help me plan a four-day trip to Lisbon in May with a small budget";

/** `sessions.list` rows of a task the app named: OpenClaw 2026.10.6, then 2026.11.10. */
const NAMED_1006 = {
  key: KEY,
  sessionId: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",
  label: null,
  autoLabel: "Lisbon trip on a budget",
  displayName: "Four-day Lisbon trip",
  derivedTitle: null,
  updatedAt: 1_700_000_000_000,
};
const NAMED_1110 = { ...NAMED_1006, titlePending: false, derivedTitle: "Four-day Lisbon trip" };

const model = (provider: string, id: string, available = true): CatalogModel => ({
  provider,
  id,
  name: null,
  available,
  levels: ["off", "low"],
  defaultLevel: "low",
});
const CATALOGUE = [
  model("openai", "gpt-6-luna"),
  model("openai", "gpt-6-sol"),
  model("anthropic", "claude-haiku-5-5"),
  model("anthropic", "claude-sonnet-5-5"),
  model("google", "gemini-3-pro"),
];

describe("which model writes a name", () => {
  it("prefers OpenAI, then Anthropic, then the bot's own provider's small model", () => {
    // The `model` named is a model of that provider other than its small one: the gateway then
    // writes the title with the small one. None (null) is the bot's own provider.
    expect(namingCalls("google/gemini-3-pro", CATALOGUE)).toEqual([
      "openai/gpt-6-sol",
      "anthropic/claude-sonnet-5-5",
      null,
    ]);
    expect(namingCalls("anthropic/claude-sonnet-5-5", CATALOGUE)).toEqual([
      "openai/gpt-6-sol",
      null,
    ]);
    expect(namingCalls("openai/gpt-6-sol@openai:work", CATALOGUE)).toEqual([
      null,
      "anthropic/claude-sonnet-5-5",
    ]);
    // A bot on the gateway's default model: the providers in order, then its own.
    expect(namingCalls(null, CATALOGUE)).toEqual([
      "openai/gpt-6-sol",
      "anthropic/claude-sonnet-5-5",
      null,
    ]);
  });

  it("skips a provider the person hasn't connected, and one whose only model is the small one", () => {
    const unconnected = CATALOGUE.map((each) =>
      each.provider === "openai" ? { ...each, available: false } : each,
    );
    expect(namingCalls("google/gemini-3-pro", unconnected)).toEqual([
      "anthropic/claude-sonnet-5-5",
      null,
    ]);
    expect(namingCalls("google/gemini-3-pro", [model("openai", "gpt-5.6-luna")])).toEqual([null]);
    expect(namingCalls("scripted/dev-1", [])).toEqual([null]);
  });

  it("is one list, keyed by provider, and its length bounds the calls", () => {
    expect(NAMING_MODELS.map((each) => each.provider)).toEqual(["openai", "anthropic"]);
    expect(MAX_NAMING_CALLS).toBe(3);
    for (const bot of [null, "google/gemini-3-pro", "openai/gpt-6-sol", "anthropic/x"])
      expect(namingCalls(bot, CATALOGUE).length).toBeLessThanOrEqual(MAX_NAMING_CALLS);
  });

  it("is given the person's own words only, cut to what the gateway takes", () => {
    expect(namingSource(`  ${MESSAGE}\n`)).toBe(MESSAGE);
    const long = "🌿".repeat(MAX_NAMING_SOURCE_CHARS);
    const cut = namingSource(long);
    expect(cut.length).toBeLessThanOrEqual(MAX_NAMING_SOURCE_CHARS);
    expect(cut).toBe("🌿".repeat(MAX_NAMING_SOURCE_CHARS / 2));
  });
});

/** A gateway for `nameTask`: answers each title call in turn, records every request. */
function namingGateway(answers: Array<unknown | Error>, row: Record<string, unknown> = {}) {
  const asked: Array<{ method: string; params: Record<string, unknown> }> = [];
  const state = { row: { key: KEY, ...row } as Record<string, unknown> };
  let call = 0;
  const ctx = {
    row: () => state.row,
    request: async (method: string, params: unknown) => {
      asked.push({ method, params: params as Record<string, unknown> });
      if (method === "models.list")
        return { models: CATALOGUE.map(({ provider, id }) => ({ provider, id })) };
      if (method === "sessions.patch") return { ok: true };
      const answer = answers[call++];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  const titleCalls = () =>
    asked.filter((each) => each.method === "sessions.title.prepare").map((each) => each.params);
  const patches = () =>
    asked.filter((each) => each.method === "sessions.patch").map((each) => each.params);
  return { ctx, state, asked, titleCalls, patches };
}

const SESSION = NAMED_1006.sessionId;
const TASK = {
  key: KEY,
  sessionId: SESSION,
  botId: "main",
  botModel: "google/gemini-3-pro",
  text: MESSAGE,
};

describe("making a name", () => {
  it("keeps the first title in the task's autoLabel, with the gateway's exact request", async () => {
    const g = namingGateway([{ title: "Lisbon trip on a budget" }]);
    expect(await nameTask(g.ctx, TASK)).toBe("Lisbon trip on a budget");
    expect(g.titleCalls()).toEqual([
      { agentId: "main", message: MESSAGE, model: "openai/gpt-6-sol" },
    ]);
    expect(g.patches()).toEqual([
      { key: KEY, autoLabel: "Lisbon trip on a budget", expectedSessionId: SESSION },
    ]);
  });

  it("is bound to the task's session: from its row when the creation gave none, else not kept", async () => {
    // A patch by key alone makes a deleted task again (both versions); with the session the
    // gateway refuses it ("changed before patch").
    const fromRow = namingGateway([{ title: "Lisbon" }], { sessionId: "row-session" });
    expect(await nameTask(fromRow.ctx, { ...TASK, sessionId: null })).toBe("Lisbon");
    expect(fromRow.patches()).toEqual([
      { key: KEY, autoLabel: "Lisbon", expectedSessionId: "row-session" },
    ]);
    const gone = namingGateway([{ title: "Lisbon" }]);
    gone.state.row = null as unknown as Record<string, unknown>;
    expect(await nameTask(gone.ctx, { ...TASK, sessionId: null })).toBeNull();
    expect(gone.patches()).toEqual([]);
  });

  it("goes on past a refusal, an empty answer and a timeout, to the bot's own provider", async () => {
    // 2026.11.10 refuses a model the person's policy doesn't allow; any version answers a failed or
    // empty call, or one whose account is out of allowance, with no title; a call can time out.
    const g = namingGateway([
      new GatewayError({ code: "INVALID_REQUEST", message: "model not allowed: openai/gpt-6-sol" }),
      { title: null },
      { title: "Lisbon on a budget" },
    ]);
    expect(await nameTask(g.ctx, TASK)).toBe("Lisbon on a budget");
    expect(g.titleCalls().map((each) => each.model ?? null)).toEqual([
      "openai/gpt-6-sol",
      "anthropic/claude-sonnet-5-5",
      null,
    ]);
    const timedOut = namingGateway([
      new Error("request timed out"),
      { title: "  " },
      { title: "x" },
    ]);
    expect(await nameTask(timedOut.ctx, TASK)).toBe("x");
  });

  it("keeps nothing when every call fails, and asks at most once per model", async () => {
    const g = namingGateway([
      { title: null },
      new Error("closed"),
      { title: null },
      { title: "z" },
    ]);
    expect(await nameTask(g.ctx, TASK)).toBeNull();
    expect(g.titleCalls()).toHaveLength(MAX_NAMING_CALLS);
    expect(g.patches()).toEqual([]);
  });

  it("names the bot's own provider when the person's models can't be read", async () => {
    const g = namingGateway([{ title: "Lisbon" }]);
    const failing = {
      ...g.ctx,
      request: async (method: string, params: unknown) => {
        if (method === "models.list") throw new Error("Chat metadata access changed");
        return g.ctx.request(method, params);
      },
    };
    expect(await nameTask(failing, TASK)).toBe("Lisbon");
    expect(g.titleCalls()).toEqual([{ agentId: "main", message: MESSAGE }]);
  });

  it("cuts a name to the gateway's title length", async () => {
    const g = namingGateway([{ title: "A".repeat(80) }]);
    expect(await nameTask(g.ctx, TASK)).toBe("A".repeat(MAX_TASK_NAME_CHARS));
  });
});

describe("a name someone chose", () => {
  it("is never replaced: a task with a label is not named at all", async () => {
    const g = namingGateway([{ title: "Lisbon" }], { label: "Our May trip" });
    expect(await nameTask(g.ctx, TASK)).toBeNull();
    expect(g.asked).toEqual([]);
  });

  it("given while the name is made, wins: nothing is kept", async () => {
    const g = namingGateway([]);
    g.ctx.request = (async (method: string, params: unknown) => {
      g.asked.push({ method, params: params as Record<string, unknown> });
      if (method === "models.list") return { models: [] };
      if (method === "sessions.title.prepare") {
        // The person renames the task while its name is made.
        g.state.row = { ...g.state.row, label: "Our May trip" };
        return { title: "Lisbon" };
      }
      return { ok: true };
    }) as typeof g.ctx.request;
    expect(await nameTask(g.ctx, TASK)).toBeNull();
    expect(g.patches()).toEqual([]);
  });

  it("comes first in every title; the generated name before the gateway's own (both versions)", () => {
    for (const row of [NAMED_1006, NAMED_1110]) {
      expect(mapSessionRow(row)?.title).toBe("Lisbon trip on a budget");
      expect(mapSessionRow({ ...row, label: "Our May trip" })?.title).toBe("Our May trip");
      expect(mapSessionRow({ ...row, autoLabel: null })?.title).toBe("Four-day Lisbon trip");
      expect(mapArchivedRow({ ...row, archived: true }, "main")?.title).toBe(
        "Lisbon trip on a budget",
      );
    }
    // Elsewhere `autoLabel` is a device's name, below the gateway's title: not a task's name.
    const device = { key: "agent:main:node-7c1d", autoLabel: "Pixel", displayName: "Garden plan" };
    expect(mapSessionRow(device)?.title).toBe("Garden plan");
    const search = readMessageSearch({
      results: [{ sessionKey: KEY, messageId: "m1", role: "user", snippet: "Lisbon" }],
      sessions: [NAMED_1110],
    });
    expect(search.titles).toEqual({ [KEY]: "Lisbon trip on a budget" });
  });
});

/** A gateway whose `sessions.create` makes the task and whose title calls answer from `titles`. */
function creatingGateway(titles: Array<string | null> = ["Lisbon trip on a budget"]) {
  const gateway = grantingGateway();
  let created = false;
  // The task's row as the gateway keeps it: its label from the creation, a patch's fields.
  let stored: Record<string, unknown> = {};
  gateway.handlers["sessions.create"] = (params) => {
    created = true;
    stored = { label: (params as { label?: string }).label ?? null };
    // As both versions answer it: the task's key and its session.
    return { ok: true, key: KEY, sessionId: NAMED_1006.sessionId, runId: "run-create" };
  };
  const row = () => ({ key: KEY, sessionId: NAMED_1006.sessionId, updatedAt: 1, ...stored });
  gateway.handlers["sessions.list"] = () => ({ sessions: created ? [row()] : [], hasMore: false });
  gateway.handlers["models.list"] = () => ({ models: [] });
  let asked = 0;
  gateway.handlers["sessions.title.prepare"] = () => ({ title: titles[asked++] ?? null });
  gateway.handlers["sessions.patch"] = (params) => {
    const { key: _key, ...fields } = params as Record<string, unknown>;
    stored = { ...stored, ...fields };
    return { ok: true, key: KEY };
  };
  return { gateway, row };
}

const titleCalls = (gateway: FakeGateway) => gateway.calls("sessions.title.prepare");
const patches = (gateway: FakeGateway) => gateway.calls("sessions.patch");

describe("the device that sends the first message", () => {
  it("names the task it creates, and nothing it does shows as a task, a message or a failure", async () => {
    const { gateway } = creatingGateway();
    const { client } = await openTask({ gateway });
    try {
      await client.createTask("main", MESSAGE);
      await until(() => patches(gateway).length === 1);
      expect(titleCalls(gateway)).toEqual([{ agentId: "main", message: MESSAGE }]);
      expect(patches(gateway)).toEqual([
        { key: KEY, autoLabel: "Lisbon trip on a budget", expectedSessionId: SESSION },
      ]);
      // The 2026.10.6 event the patch brings: the name every device shows.
      gateway.emit("sessions.changed", {
        sessionKey: KEY,
        reason: "patch",
        ...NAMED_1006,
        session: NAMED_1006,
      });
      await until(
        () =>
          client.state.tasksByBot.main?.find((task) => task.key === KEY)?.title ===
          "Lisbon trip on a budget",
      );
      // The task list holds the task alone; its outbox holds the person's message alone, not failed.
      expect(client.state.tasksByBot.main!.map((task) => task.key)).toEqual([KEY]);
      const outbox = client.state.transcripts[KEY]?.outbox ?? [];
      expect(outbox.map((each) => each.text)).toEqual([MESSAGE]);
      expect(outbox.some((each) => each.status === "failed")).toBe(false);
      expect(gateway.calls("chat.send")).toHaveLength(1);
      expect(client.state.creations.every((each) => each.status === "created")).toBe(true);
    } finally {
      client.stop();
    }
  });

  it("names nothing it was given a name for, and nothing when every call fails", async () => {
    const named = creatingGateway();
    const first = await openTask({ gateway: named.gateway });
    try {
      await first.client.createTask("main", MESSAGE, { label: "Our May trip" });
      await sleep(50);
      expect(titleCalls(named.gateway)).toEqual([]);
      expect(patches(named.gateway)).toEqual([]);
    } finally {
      first.client.stop();
    }
    const failing = creatingGateway([]);
    failing.gateway.handlers["sessions.title.prepare"] = () => {
      throw new GatewayError({ code: "UNAVAILABLE", message: "rate limit exceeded" });
    };
    const second = await openTask({ gateway: failing.gateway });
    try {
      await second.client.createTask("main", MESSAGE);
      await until(() => titleCalls(failing.gateway).length === 1);
      await sleep(50);
      expect(patches(failing.gateway)).toEqual([]);
      const outbox = second.client.state.transcripts[KEY]?.outbox ?? [];
      expect(outbox.map((each) => each.text)).toEqual([MESSAGE]);
      expect(outbox.some((each) => each.status === "failed")).toBe(false);
      expect(second.client.state.connection.error ?? null).toBeNull();
    } finally {
      second.client.stop();
    }
  });

  it("is the only one: another device that sees the new task makes no name", async () => {
    const { gateway, row } = creatingGateway();
    const mine = await openTask({ gateway });
    const other = await openTask({ gateway });
    try {
      await mine.client.createTask("main", MESSAGE);
      gateway.emit("sessions.changed", { sessionKey: KEY, reason: "create", session: row() });
      await until(
        () => other.client.state.tasksByBot.main?.some((task) => task.key === KEY) === true,
      );
      await until(() => patches(gateway).length === 1);
      await sleep(50);
      expect(titleCalls(gateway)).toHaveLength(1);
      expect(patches(gateway)).toHaveLength(1);
    } finally {
      mine.client.stop();
      other.client.stop();
    }
  });

  it("names an empty task from the first message sent in it, once", async () => {
    const { gateway } = creatingGateway(["Lisbon trip", "Second"]);
    const { client } = await openTask({ gateway });
    try {
      const key = await client.newTask("main");
      client.openSession(key);
      await until(() => client.state.transcripts[key]?.status === "ready");
      client.sendMessage(key, MESSAGE);
      await until(() => patches(gateway).length === 1);
      client.sendMessage(key, "and a day in Sintra");
      await sleep(50);
      expect(titleCalls(gateway)).toEqual([{ agentId: "main", message: MESSAGE }]);
      expect(patches(gateway)).toEqual([
        { key, autoLabel: "Lisbon trip", expectedSessionId: SESSION },
      ]);
    } finally {
      client.stop();
    }
  });

  it("doesn't name an empty task the person named, nor one another device made", async () => {
    const { gateway } = creatingGateway();
    const { client } = await openTask({ gateway });
    try {
      const key = await client.newTask("main", { label: "Our May trip" });
      client.openSession(key);
      await until(() => client.state.transcripts[key]?.status === "ready");
      client.sendMessage(key, MESSAGE);
      // A task this device didn't make: its first message here is not its first message.
      const other = "agent:main:dashboard:0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
      client.openSession(other);
      await until(() => client.state.transcripts[other]?.status === "ready");
      client.sendMessage(other, MESSAGE);
      await sleep(50);
      expect(titleCalls(gateway)).toEqual([]);
    } finally {
      client.stop();
    }
  });

  it("doesn't name an empty task it made whose first message came from another device", async () => {
    const { gateway } = creatingGateway();
    const { client } = await openTask({ gateway });
    try {
      const key = await client.newTask("main");
      // The other device's message, in the task's history when this one opens it.
      gateway.handlers["chat.history"] = (params) =>
        (params as { sessionKey: string }).sessionKey === key
          ? {
              messages: [
                { role: "user", content: [{ type: "text", text: MESSAGE }], timestamp: 1 },
              ],
              hasMore: false,
            }
          : { messages: [], hasMore: false };
      client.openSession(key);
      await until(() => (client.state.transcripts[key]?.items.length ?? 0) > 0);
      client.sendMessage(key, "and a day in Sintra");
      await sleep(50);
      expect(titleCalls(gateway)).toEqual([]);
    } finally {
      client.stop();
    }
  });

  it("doesn't name it either when only the task's row says it has a message", async () => {
    const { gateway } = creatingGateway();
    const { client } = await openTask({ gateway });
    try {
      const key = await client.newTask("main");
      client.openSession(key);
      await until(() => client.state.transcripts[key]?.status === "ready");
      // 2026.11.10's event for the other device's message, before this one reads the history.
      const row = { key, sessionId: SESSION, lastMessagePreview: MESSAGE, updatedAt: 2 };
      gateway.emit("sessions.changed", { sessionKey: key, reason: "send", ...row, session: row });
      await sleep(30);
      client.sendMessage(key, "and a day in Sintra");
      await sleep(50);
      expect(titleCalls(gateway)).toEqual([]);
    } finally {
      client.stop();
    }
  });

  it("keeps no empty task whose key is too long to open: it takes no place of another's", async () => {
    const { gateway } = creatingGateway(["Lisbon"]);
    let made = 0;
    gateway.handlers["sessions.create"] = () => {
      made += 1;
      const key = made === 1 ? KEY : `agent:main:dashboard:${String(made).padStart(1100, "a")}`;
      return { ok: true, key, sessionId: SESSION };
    };
    const { client } = await openTask({ gateway });
    try {
      const key = await client.newTask("main");
      for (let i = 0; i < MAX_NAMED_TASKS; i += 1) await client.newTask("main");
      client.openSession(key);
      await until(() => client.state.transcripts[key]?.status === "ready");
      client.sendMessage(key, MESSAGE);
      await until(() => titleCalls(gateway).length === 1);
    } finally {
      client.stop();
    }
  });

  it("keeps at most MAX_NAMED_TASKS empty tasks waiting for their first message", async () => {
    const { gateway } = creatingGateway();
    let made = 0;
    gateway.handlers["sessions.create"] = () => ({
      key: `agent:main:dashboard:task-${(made += 1)}`,
    });
    const { client } = await openTask({ gateway });
    try {
      const keys: string[] = [];
      for (let i = 0; i <= MAX_NAMED_TASKS; i += 1) keys.push(await client.newTask("main"));
      // The oldest gave way: its first message names nothing; the newest's does.
      for (const key of [keys[0]!, keys.at(-1)!]) {
        client.openSession(key);
        await until(() => client.state.transcripts[key]?.status === "ready");
        client.sendMessage(key, MESSAGE);
      }
      await until(() => titleCalls(gateway).length === 1);
      await sleep(50);
      expect(titleCalls(gateway)).toHaveLength(1);
    } finally {
      client.stop();
    }
  });
});

describe("the task list", () => {
  it("shows a named task by its name, and a task named by someone by theirs", () => {
    const grouped = groupTasks([
      NAMED_1110,
      { ...NAMED_1006, key: `${KEY}-2`, label: "Our May trip" },
      { key: "agent:main:main" },
    ]);
    expect(grouped.main!.map((task) => task.title).sort()).toEqual([
      "Lisbon trip on a budget",
      "Main",
      "Our May trip",
    ]);
  });
});
