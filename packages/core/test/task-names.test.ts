// A task's name, written by a small model (#750). The gateway's frames here are each version's as a
// development gateway sent them (`sessions.title.prepare`'s answer, `sessions.patch {autoLabel}`'s
// `sessions.changed`), with made-up keys and names.

import { describe, expect, it } from "vitest";
import type { CatalogModel } from "../src/accounts.ts";
import { MAX_NAMED_TASKS, MAX_TEXTLESS_SENDS } from "../src/client.ts";
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
import { deferred, GatewayError, sleep, until, type FakeGateway } from "./fake-gateway.ts";

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
  it("for a bot on OpenAI or Anthropic: OpenAI's small model, then Anthropic's, the bot's own among them", () => {
    // The `model` named is a model of that provider other than its small one: the gateway then
    // writes the title with the small one. None (null) is the bot's own provider.
    expect(namingCalls("anthropic/claude-sonnet-5-5", CATALOGUE)).toEqual([
      "openai/gpt-6-sol",
      null,
    ]);
    expect(namingCalls("openai/gpt-6-sol@openai:work", CATALOGUE)).toEqual([
      null,
      "anthropic/claude-sonnet-5-5",
    ]);
  });

  it("for a bot on any other provider: its own provider's alone, naming no OpenAI or Anthropic model", () => {
    // Clawtrate names neither for that task, though both are connected (a utility model set on the
    // gateway would still be used instead of any model named: the person's own setting).
    for (const bot of ["google/gemini-3-pro", "ollama/llama-4", "scripted/dev-1"])
      expect(namingCalls(bot, CATALOGUE)).toEqual([null]);
  });

  it("for a bot whose provider isn't known: as for any other provider", () => {
    for (const bot of [null, "", "no-slash", "/gpt-6-sol", "openai-codex/gpt-6-sol"])
      expect(namingCalls(bot, CATALOGUE)).toEqual([null]);
  });

  it("skips a provider the person hasn't connected, and one whose only model is the small one", () => {
    const unconnected = CATALOGUE.map((each) =>
      each.provider === "openai" ? { ...each, available: false } : each,
    );
    expect(namingCalls("anthropic/claude-sonnet-5-5", unconnected)).toEqual([null]);
    expect(namingCalls("anthropic/x", [model("openai", "gpt-5.6-luna")])).toEqual([null]);
    expect(namingCalls("openai/gpt-6-sol", [])).toEqual([null]);
  });

  it("is one list, keyed by provider, and its length bounds the calls", () => {
    expect(NAMING_MODELS.map((each) => each.provider)).toEqual(["openai", "anthropic"]);
    expect(MAX_NAMING_CALLS).toBe(2);
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
  const state = {
    row: { key: KEY, ...row } as Record<string, unknown>,
    botModel: "anthropic/claude-sonnet-5-5" as string | null,
  };
  let call = 0;
  const ctx = {
    row: () => state.row,
    botModel: () => state.botModel,
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

  it("is bound to the session the creation gave; without one, nothing is asked or kept", async () => {
    // A patch by key alone made a deleted task again (2026.10.6); with the session the
    // gateway refuses it ("changed before patch"). The row's session isn't taken instead: by the
    // time the name is made, the row can be a task made again under the same key.
    const g = namingGateway([{ title: "Lisbon" }], { sessionId: "replacing-session" });
    expect(await nameTask(g.ctx, { ...TASK, sessionId: null })).toBeNull();
    expect(g.titleCalls()).toEqual([]);
    expect(g.patches()).toEqual([]);
  });

  it("names no other provider once the bot has moved to one outside the list", async () => {
    // To Ollama while the person's models are read (from Anthropic: OpenAI is no longer asked),
    // or during the bot's own call that gave no title (from OpenAI: Anthropic is not asked next).
    for (const [from, during, answers] of [
      ["anthropic/claude-sonnet-5-5", "models.list", [{ title: "Lisbon" }]],
      ["openai/gpt-6-sol", "sessions.title.prepare", [{ title: null }, { title: "Lisbon" }]],
    ] as const) {
      const g = namingGateway([...answers]);
      g.state.botModel = from;
      const ctx = {
        ...g.ctx,
        request: async (method: string, params: unknown) => {
          const answer = await g.ctx.request(method, params);
          if (method === during) g.state.botModel = "ollama/llama-4";
          return answer;
        },
      };
      await nameTask(ctx, TASK);
      expect(g.titleCalls()).toEqual([{ agentId: "main", message: MESSAGE }]);
    }
  });

  it("keeps no name for a task whose session changed while the name was made", async () => {
    // A reset, or a delete and a new task under the same key, during the title call: the key's
    // new session S2 is not the task the first message was sent to (S1).
    const g = namingGateway([{ title: "Lisbon" }], { sessionId: "s1" });
    const ctx = {
      ...g.ctx,
      request: async (method: string, params: unknown) => {
        const answer = await g.ctx.request(method, params);
        if (method === "sessions.title.prepare") g.state.row = { key: KEY, sessionId: "s2" };
        return answer;
      },
    };
    expect(await nameTask(ctx, { ...TASK, sessionId: "s1" })).toBeNull();
    expect(g.titleCalls()).toHaveLength(1);
    expect(g.patches()).toEqual([]);
  });

  it("goes on past a refusal, an empty answer or a timeout, to the bot's own provider", async () => {
    // 2026.11.10 refuses a model the person's policy doesn't allow; any version answers a failed or
    // empty call, or one whose account is out of allowance, with no title; a call can time out.
    for (const first of [
      new GatewayError({ code: "INVALID_REQUEST", message: "model not allowed: openai/gpt-6-sol" }),
      { title: null },
      { title: "  " },
      new Error("request timed out"),
    ]) {
      const g = namingGateway([first, { title: "Lisbon on a budget" }]);
      expect(await nameTask(g.ctx, TASK)).toBe("Lisbon on a budget");
      expect(g.titleCalls().map((each) => each.model ?? null)).toEqual(["openai/gpt-6-sol", null]);
    }
  });

  it("asks a bot on another provider, or an unknown one, its own small model alone, and reads no other provider", async () => {
    // OpenAI and Anthropic are both connected (`models.list` would list them): no call names either.
    for (const botModel of ["ollama/llama-4", null]) {
      const g = namingGateway([{ title: null }, { title: "z" }]);
      g.state.botModel = botModel;
      expect(await nameTask(g.ctx, TASK)).toBeNull();
      expect(g.titleCalls()).toEqual([{ agentId: "main", message: MESSAGE }]);
      expect(g.asked.some((each) => each.method === "models.list")).toBe(false);
    }
  });

  it("keeps nothing when every call fails, and asks at most once per model", async () => {
    const g = namingGateway([{ title: null }, new Error("closed"), { title: "z" }]);
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
    // OpenAI's wasn't known to be connected: only the bot's own.
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

/** A one-pixel picture. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
/** A person's row with a picture and no text, as both versions store one sent as `id`. */
const ownPicture = (id: string) => ({
  role: "user",
  content: "",
  timestamp: 1,
  __openclaw: {
    id: `row-${id}`,
    idempotencyKey: `${id}:user`,
    media: [{ kind: "image", fileName: "dot.png", contentType: "image/png" }],
  },
});
const botReply = { role: "assistant", content: [{ type: "text", text: "A dot." }], timestamp: 2 };
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

  it("names a task only once the gateway accepts its first message, and once after a retry", async () => {
    // Refused by the gateway, or no answer at all: the words go to no model. A retry the gateway
    // takes names the task, once. For a task created with its message and for an empty one.
    for (const empty of [false, true]) {
      for (const failure of [
        new GatewayError({ code: "UNAVAILABLE", message: "the bot is busy" }),
        new Error("closed"),
      ]) {
        const { gateway } = creatingGateway(["Garden plan"]);
        const { client } = await openTask({ gateway });
        try {
          const accept = gateway.handlers["chat.send"]!;
          let refuse = true;
          gateway.handlers["chat.send"] = (params) => {
            if (refuse) throw failure;
            return accept(params);
          };
          let key = KEY;
          if (empty) {
            key = await client.newTask("main");
            client.openSession(key);
            await until(() => client.state.transcripts[key]?.status === "ready");
            client.sendMessage(key, MESSAGE);
          } else {
            await client.createTask("main", MESSAGE);
          }
          const failed = () =>
            client.state.transcripts[key]?.outbox.find(
              (each) => each.status === "failed" || each.status === "unconfirmed",
            );
          // Refused: failed at once; no answer: unconfirmed once history doesn't hold it.
          await until(() => failed() !== undefined);
          await sleep(50);
          expect(titleCalls(gateway)).toEqual([]);
          refuse = false;
          client.retryMessage(key, failed()!.id);
          await until(() => patches(gateway).length === 1);
          expect(titleCalls(gateway)).toEqual([{ agentId: "main", message: MESSAGE }]);
          client.sendMessage(key, "and a day in Sintra");
          await sleep(50);
          expect(titleCalls(gateway)).toHaveLength(1);
        } finally {
          client.stop();
        }
      }
    }
  });

  it("names a task from the next message when its refused first message is deleted", async () => {
    // A refused, A deleted, B sent and accepted: named from B. For a task created with A and for
    // an empty one.
    for (const empty of [false, true]) {
      const { gateway } = creatingGateway(["Garden plan"]);
      const { client } = await openTask({ gateway });
      try {
        const accept = gateway.handlers["chat.send"]!;
        let refuse = true;
        gateway.handlers["chat.send"] = (params) => {
          if (refuse) throw new GatewayError({ code: "UNAVAILABLE", message: "the bot is busy" });
          return accept(params);
        };
        let key = KEY;
        if (empty) {
          key = await client.newTask("main");
          client.openSession(key);
          await until(() => client.state.transcripts[key]?.status === "ready");
          client.sendMessage(key, "Plan the spring beds");
        } else {
          await client.createTask("main", "Plan the spring beds");
        }
        const failed = () =>
          client.state.transcripts[key]?.outbox.find((each) => each.status === "failed");
        await until(() => failed() !== undefined);
        client.deleteMessage(key, failed()!.id);
        refuse = false;
        client.sendMessage(key, MESSAGE);
        await until(() => patches(gateway).length === 1);
        expect(titleCalls(gateway)).toEqual([{ agentId: "main", message: MESSAGE }]);
      } finally {
        client.stop();
      }
    }
  });

  it("names a task from the next message when its refused first message is deleted while that one is on its way", async () => {
    // A refused, B sent, A deleted before the gateway answers B, then B accepted: named from B.
    const { gateway } = creatingGateway(["Garden plan"]);
    const { client } = await openTask({ gateway });
    try {
      const accept = gateway.handlers["chat.send"]!;
      const answer = deferred<void>();
      let sends = 0;
      gateway.handlers["chat.send"] = async (params) => {
        sends += 1;
        if (sends === 1)
          throw new GatewayError({ code: "UNAVAILABLE", message: "the bot is busy" });
        await answer.promise;
        return accept(params);
      };
      await client.createTask("main", "Plan the spring beds");
      const failed = () =>
        client.state.transcripts[KEY]?.outbox.find((each) => each.status === "failed");
      await until(() => failed() !== undefined);
      const first = failed()!.id;
      client.sendMessage(KEY, MESSAGE);
      await until(() => sends === 2);
      client.deleteMessage(KEY, first);
      answer.resolve();
      await until(() => patches(gateway).length === 1);
      expect(titleCalls(gateway)).toEqual([{ agentId: "main", message: MESSAGE }]);
    } finally {
      client.stop();
    }
  });

  it("names a task from the next message with text when a picture alone took its refused first message's place", async () => {
    // A refused, a picture B sent, A deleted before the gateway answers B, then B accepted: B
    // names nothing and is one of this client's own, so C, with text, names the task.
    const picture = { type: "image", fileName: "dot.png", mimeType: "image/png", content: PNG };
    const { gateway } = creatingGateway(["Garden plan"]);
    const { client } = await openTask({ gateway });
    try {
      const accept = gateway.handlers["chat.send"]!;
      const answer = deferred<void>();
      let sends = 0;
      gateway.handlers["chat.send"] = async (params) => {
        sends += 1;
        if (sends === 1)
          throw new GatewayError({ code: "UNAVAILABLE", message: "the bot is busy" });
        if (sends === 2) await answer.promise;
        return accept(params);
      };
      await client.createTask("main", "Plan the spring beds");
      const failed = () =>
        client.state.transcripts[KEY]?.outbox.find((each) => each.status === "failed");
      await until(() => failed() !== undefined);
      const first = failed()!.id;
      const pictureId = client.sendMessage(KEY, "", { attachments: [picture] });
      await until(() => sends === 2);
      client.deleteMessage(KEY, first);
      gateway.handlers["chat.history"] = () => ({
        messages: [ownPicture(pictureId)],
        hasMore: false,
      });
      answer.resolve();
      const sent = () =>
        client.state.transcripts[KEY]?.outbox.find((each) => each.id === pictureId);
      await until(() => sent()?.status !== "sending");
      client.sendMessage(KEY, MESSAGE);
      await until(() => patches(gateway).length === 1);
      expect(titleCalls(gateway)).toEqual([{ agentId: "main", message: MESSAGE }]);
    } finally {
      client.stop();
    }
  });

  it("doesn't name a task made again under its key from a message the one before sent", async () => {
    // S1's first message is on its way; the key is made again as S2, whose first message, queued
    // behind it, is cancelled; then the gateway accepts S1's message.
    const { gateway } = creatingGateway(["Garden plan"]);
    const accept = gateway.handlers["chat.send"]!;
    const answer = deferred<void>();
    gateway.handlers["chat.send"] = async (params) => {
      await answer.promise;
      return accept(params);
    };
    const { client } = await openTask({ gateway });
    try {
      await client.createTask("main", "Plan the spring beds");
      await until(() => gateway.calls("chat.send").length === 1);
      const create = gateway.handlers["sessions.create"]!;
      gateway.handlers["sessions.create"] = (params) => ({
        ...(create(params) as Record<string, unknown>),
        sessionId: "session-2",
      });
      expect(await client.newTask("main")).toBe(KEY);
      const queued = client.sendMessage(KEY, MESSAGE, { mode: "queue" });
      client.cancelQueued(KEY, queued);
      answer.resolve();
      await until(
        () =>
          client.state.transcripts[KEY]?.outbox.every((each) => each.status !== "sending") === true,
      );
      await sleep(50);
      expect(titleCalls(gateway)).toEqual([]);
      expect(patches(gateway)).toEqual([]);
    } finally {
      client.stop();
    }
  });

  it("names a task from its first message when history confirms it before the gateway answers its send", async () => {
    // A on its way; history holds A, so it leaves the outbox; B sent; then A accepted: named from A.
    const { gateway } = creatingGateway(["Garden plan"]);
    const accept = gateway.handlers["chat.send"]!;
    const answer = deferred<void>();
    gateway.handlers["chat.send"] = async (params) => {
      if (gateway.calls("chat.send").length === 1) await answer.promise;
      return accept(params);
    };
    const { client } = await openTask({ gateway });
    try {
      await client.createTask("main", MESSAGE);
      await until(() => gateway.calls("chat.send").length === 1);
      const first = client.state.transcripts[KEY]!.outbox[0]!.id;
      gateway.handlers["chat.history"] = () => ({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: MESSAGE }],
            timestamp: 1,
            __openclaw: { id: "row-a", idempotencyKey: `${first}:user` },
          },
        ],
        hasMore: false,
      });
      client.closeSession(KEY);
      client.openSession(KEY);
      await until(
        () => client.state.transcripts[KEY]?.outbox.some((each) => each.id === first) === false,
      );
      client.sendMessage(KEY, "and a day in Sintra");
      answer.resolve();
      await until(() => patches(gateway).length === 1);
      expect(titleCalls(gateway)).toEqual([{ agentId: "main", message: MESSAGE }]);
    } finally {
      client.stop();
    }
  });

  it("names a task when another device's message came after its first one", async () => {
    const { gateway } = creatingGateway(["Lisbon"]);
    const { client } = await openTask({ gateway });
    try {
      const key = await client.newTask("main");
      client.openSession(key);
      await until(() => client.state.transcripts[key]?.status === "ready");
      const id = client.sendMessage(key, MESSAGE);
      const own = {
        role: "user",
        content: [{ type: "text", text: MESSAGE }],
        timestamp: 1,
        __openclaw: { id: "row-a", idempotencyKey: `${id}:user` },
      };
      const fromB = {
        role: "user",
        content: "and a day in Sintra",
        timestamp: 2,
        __openclaw: { id: "row-b", idempotencyKey: "device-b:user" },
      };
      gateway.handlers["chat.history"] = () => ({ messages: [own, fromB], hasMore: false });
      await until(() => patches(gateway).length === 1);
      expect(titleCalls(gateway)).toEqual([{ agentId: "main", message: MESSAGE }]);
    } finally {
      client.stop();
    }
  });

  it("doesn't name a task it created when another device sent in it first", async () => {
    // Between `sessions.create` and this client's `chat.send`, another device's message reached
    // the new task: the gateway's history holds it before this client's.
    const { gateway } = creatingGateway();
    const fromB = {
      role: "user",
      content: "Plan the spring beds",
      timestamp: 1,
      __openclaw: { id: "row-b", idempotencyKey: "device-b:user" },
    };
    gateway.handlers["chat.history"] = () => ({ messages: [fromB], hasMore: false });
    const { client } = await openTask({ gateway });
    try {
      const reads = gateway.calls("chat.history").length;
      await client.createTask("main", MESSAGE);
      await until(() => gateway.calls("chat.history").length > reads);
      await sleep(50);
      expect(titleCalls(gateway)).toEqual([]);
      expect(patches(gateway)).toEqual([]);
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

  /**
   * An empty task this client made, a picture with no text sent in it, then a message with text:
   * with the picture still on its way (`delivered` false) or already in the task's history and row.
   */
  async function pictureThenText(delivered: boolean) {
    const picture = { type: "image", fileName: "dot.png", mimeType: "image/png", content: PNG };
    const { gateway } = creatingGateway(["Garden plan"]);
    const { client } = await openTask({ gateway });
    try {
      const key = await client.newTask("main");
      client.openSession(key);
      await until(() => client.state.transcripts[key]?.status === "ready");
      const id = client.sendMessage(key, "", { attachments: [picture] });
      if (delivered) {
        // The picture is in the task's history, as both versions store it (`<id>:user`, no
        // text), with the bot's reply, and the row's preview is that reply.
        gateway.handlers["chat.history"] = (params) =>
          (params as { sessionKey: string }).sessionKey === key
            ? { messages: [ownPicture(id), botReply], hasMore: false }
            : { messages: [], hasMore: false };
        const row = { key, sessionId: SESSION, lastMessagePreview: "A dot.", updatedAt: 3 };
        gateway.emit("sessions.changed", { sessionKey: key, ...row, session: row });
        client.closeSession(key);
        client.openSession(key);
        await until(() => (client.state.transcripts[key]?.items.length ?? 0) === 2);
      } else {
        expect(client.state.transcripts[key]?.outbox.some((each) => each.id === id)).toBe(true);
      }
      client.sendMessage(key, MESSAGE);
      await until(() => patches(gateway).length === 1);
      expect(titleCalls(gateway)).toEqual([{ agentId: "main", message: MESSAGE }]);
      expect(patches(gateway)).toEqual([
        { key, autoLabel: "Garden plan", expectedSessionId: SESSION },
      ]);
      // Tried once: a later message names nothing.
      client.sendMessage(key, "and a day in Sintra");
      await sleep(50);
      expect(titleCalls(gateway)).toHaveLength(1);
    } finally {
      client.stop();
    }
  }

  it("names a task that began with a picture from its first message with text, the picture still on its way", async () => {
    await pictureThenText(false);
  });

  it("names a task that began with a picture from its first message with text, the picture in its history", async () => {
    await pictureThenText(true);
  });

  it("gives up on a task with more than MAX_TEXTLESS_SENDS messages with no text before one with text", async () => {
    const picture = { type: "image", fileName: "dot.png", mimeType: "image/png", content: PNG };
    for (const sends of [MAX_TEXTLESS_SENDS, MAX_TEXTLESS_SENDS + 1]) {
      const { gateway } = creatingGateway(["Garden plan"]);
      const { client } = await openTask({ gateway });
      try {
        const key = await client.newTask("main");
        client.openSession(key);
        await until(() => client.state.transcripts[key]?.status === "ready");
        for (let i = 0; i < sends; i += 1) client.sendMessage(key, "", { attachments: [picture] });
        client.sendMessage(key, MESSAGE);
        await sleep(50);
        expect(titleCalls(gateway)).toHaveLength(sends === MAX_TEXTLESS_SENDS ? 1 : 0);
      } finally {
        client.stop();
      }
    }
  });

  it("doesn't name a task whose first message from another device reached its row before its history", async () => {
    // Device B sends the first message; this client sends a picture before it sees it; B's row
    // preview arrives, its history row doesn't. The gateway's history holds B's message.
    const picture = { type: "image", fileName: "dot.png", mimeType: "image/png", content: PNG };
    const { gateway } = creatingGateway(["Garden plan"]);
    const { client } = await openTask({ gateway });
    try {
      const key = await client.newTask("main");
      client.openSession(key);
      await until(() => client.state.transcripts[key]?.status === "ready");
      const id = client.sendMessage(key, "", { attachments: [picture] });
      const fromB = {
        role: "user",
        content: "Plan the spring beds",
        timestamp: 1,
        __openclaw: { id: "row-b", idempotencyKey: "device-b:user" },
      };
      gateway.handlers["chat.history"] = (params) =>
        (params as { sessionKey: string }).sessionKey === key
          ? { messages: [fromB, ownPicture(id)], hasMore: false }
          : { messages: [], hasMore: false };
      const row = {
        key,
        sessionId: SESSION,
        lastMessagePreview: "Plan the spring beds",
        updatedAt: 3,
      };
      gateway.emit("sessions.changed", { sessionKey: key, ...row, session: row });
      await until(() => client.state.tasksByBot.main?.some((task) => task.key === key) === true);
      expect(client.state.transcripts[key]?.items.some((item) => item.role === "user")).toBe(false);
      client.sendMessage(key, MESSAGE);
      await until(() => gateway.calls("chat.history").length > 1);
      await sleep(50);
      expect(titleCalls(gateway)).toEqual([]);
      expect(patches(gateway)).toEqual([]);
    } finally {
      client.stop();
    }
  });

  it("doesn't name an empty task when the gateway's history can't be read, or is cut short", async () => {
    for (const answer of [new Error("closed"), { messages: [], hasMore: true }]) {
      const { gateway } = creatingGateway(["Garden plan"]);
      const { client } = await openTask({ gateway });
      try {
        const key = await client.newTask("main");
        client.openSession(key);
        await until(() => client.state.transcripts[key]?.status === "ready");
        const reads = gateway.calls("chat.history").length;
        gateway.handlers["chat.history"] = () => {
          if (answer instanceof Error) throw answer;
          return answer;
        };
        client.sendMessage(key, MESSAGE);
        await until(() => gateway.calls("chat.history").length > reads);
        await sleep(50);
        expect(titleCalls(gateway)).toEqual([]);
      } finally {
        client.stop();
      }
    }
  });

  it("doesn't name a task whose picture before it came from another device", async () => {
    const { gateway } = creatingGateway();
    const { client } = await openTask({ gateway });
    try {
      const key = await client.newTask("main");
      gateway.handlers["chat.history"] = (params) =>
        (params as { sessionKey: string }).sessionKey === key
          ? { messages: [ownPicture("another-device")], hasMore: false }
          : { messages: [], hasMore: false };
      client.openSession(key);
      await until(() => (client.state.transcripts[key]?.items.length ?? 0) === 1);
      client.sendMessage(key, MESSAGE);
      await sleep(50);
      expect(titleCalls(gateway)).toEqual([]);
    } finally {
      client.stop();
    }
  });

  it("names an empty task with the session it was created as, when its row has gone", async () => {
    const { gateway } = creatingGateway(["Lisbon"]);
    const { client } = await openTask({ gateway });
    try {
      const key = await client.newTask("main");
      client.openSession(key);
      await until(() => client.state.transcripts[key]?.status === "ready");
      // The list no longer holds the task's row when the title comes back.
      gateway.emit("sessions.changed", { sessionKey: key, reason: "delete", deleted: true });
      await until(() => client.state.tasksByBot.main?.some((task) => task.key === key) !== true);
      client.sendMessage(key, MESSAGE);
      await until(() => patches(gateway).length === 1);
      expect(patches(gateway)).toEqual([{ key, autoLabel: "Lisbon", expectedSessionId: SESSION }]);
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
    // As both versions answer it: each task's key and its session.
    gateway.handlers["sessions.create"] = () => ({
      key: `agent:main:dashboard:task-${(made += 1)}`,
      sessionId: `session-${made}`,
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
