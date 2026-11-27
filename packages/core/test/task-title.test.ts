// A task the gateway could not title gets a placeholder name of its own making (#741): one
// adjective and one crustacean, in `displayName`, which the gateway's derived title then repeats.
// Rows and events here are each version's, as a development gateway sent them, with made-up keys.

import { describe, expect, it } from "vitest";
import { MAX_FIRST_MESSAGE_TITLES } from "../src/client.ts";
import { groupTasks, isPlaceholderName, mapSessionRow, taskTitle } from "../src/mapping.ts";
import { readMessageSearch } from "../src/search.ts";
import { mapArchivedRow } from "../src/task-actions.ts";
import { grantingGateway, openTask, URL_B } from "./client-harness.ts";
import { GatewayError, sleep, until } from "./fake-gateway.ts";

const KEY = "agent:main:dashboard:5b0e4c1a-8d2f-4e3b-9a61-7c2d9e0f1a2b";

/** OpenClaw 2026.10.6: the `sessions.list` row once the gateway gave up on a title. */
const ROW_1006 = {
  key: KEY,
  sessionId: "0c1d2e3f-4a5b-4c6d-8e7f-901a2b3c4d5e",
  displayName: "marine-crayfish",
  derivedTitle: "marine-crayfish",
  updatedAt: 1_700_000_000_000,
};

/** OpenClaw 2026.11.10: the `sessions.changed` (`reason: "chat.title"`) row with the placeholder. */
const ROW_1110 = {
  key: KEY,
  sessionId: "0c1d2e3f-4a5b-4c6d-8e7f-901a2b3c4d5e",
  label: null,
  autoLabel: null,
  displayName: "nova-shrimp",
  derivedTitle: "nova-shrimp",
  titlePending: false,
  updatedAt: 1_700_000_000_000,
};

/** 2026.11.10's event when the placeholder lands (`reason: "chat.title"`). */
const placeholderLands = (gateway: { emit(event: string, payload: unknown): void }) =>
  gateway.emit("sessions.changed", {
    sessionKey: KEY,
    reason: "chat.title",
    ...ROW_1110,
    session: ROW_1110,
  });
const shownIn = (client: {
  state: { tasksByBot: Record<string, { key: string; title: string }[]> };
}) => client.state.tasksByBot.main?.find((task) => task.key === KEY)?.title;

/** Note a first-message title as the client does (`keepFirstMessage`). */
const keep = (client: object, key: string, text: string, session: string | null) =>
  (
    client as {
      keepFirstMessage(key: string, text: string, from: string | null, s: string | null): boolean;
    }
  ).keepFirstMessage(key, text, null, session);

const title = (row: Record<string, unknown>, first: string | null = null) =>
  mapSessionRow(row, { firstMessage: first })?.title;

describe("the gateway's placeholder name", () => {
  it("counts as no title on both versions: the first message's title, else New task", () => {
    for (const row of [ROW_1006, ROW_1110]) {
      expect(isPlaceholderName(row, KEY)).toBe(true);
      expect(title(row)).toBe("New task");
      expect(title(row, "Plan the spring garden beds")).toBe("Plan the spring garden beds");
    }
  });

  it("is recognised on every key the gateway titles itself", () => {
    for (const key of ["agent:juniper:ios-7f3a", "agent:juniper:node-2b1c"]) {
      expect(isPlaceholderName({ key, displayName: "calm-crab" }, key)).toBe(true);
      // The key's own fallback stands for it.
      expect(title({ key, displayName: "calm-crab" })).toBe(key.split(":")[2]);
    }
  });

  it("gives way to a name anyone chose, and to a title the gateway made otherwise", () => {
    // A rename, a bot's name for the task, a label given at creation: always the title.
    expect(title({ ...ROW_1110, label: "quiet-lobster" }, "Plan")).toBe("quiet-lobster");
    expect(title({ ...ROW_1006, label: "Garden plan" }, "Plan")).toBe("Garden plan");
    // A derived title that isn't the placeholder again comes first.
    expect(title({ ...ROW_1006, derivedTitle: "Plan the beds" }, "Plan")).toBe("Plan the beds");
  });

  it("is only the gateway's own form: look-alikes stay the titles they are", () => {
    const alike = [
      "quiet-harbor", // the gateway's other word list, never a task's
      "Quiet-lobster",
      "quiet-lobster-2",
      "quiet-lobster-krill",
      " quiet-lobster",
      "quiet lobster",
      "lobster-quiet",
      "Plan the spring garden beds",
    ];
    for (const displayName of alike) {
      const row = { key: KEY, displayName, derivedTitle: displayName };
      expect(isPlaceholderName(row, KEY)).toBe(false);
      expect(title(row, "Plan")).toBe(displayName);
    }
    // On a key the gateway never titles itself, the same name was given by someone.
    for (const key of ["agent:main:main", "agent:main:garden", "agent:main:subtask:dashboard:x"]) {
      expect(isPlaceholderName({ key, displayName: "calm-crab" }, key)).toBe(false);
      expect(title({ key, displayName: "calm-crab" }, "Plan")).toBe("calm-crab");
    }
  });

  it("is no placeholder when the name is missing or not text", () => {
    for (const displayName of [undefined, null, 7, ["calm-crab"], { name: "calm-crab" }]) {
      expect(isPlaceholderName({ key: KEY, displayName }, KEY)).toBe(false);
    }
    expect(title({ key: KEY, derivedTitle: "Plan the beds" }, "Plan")).toBe("Plan the beds");
    expect(title({ key: KEY }, "Plan")).toBe("Plan");
    expect(title({ key: KEY })).toBe("New task");
  });

  it("is no title in the archived list or in search's titles either", () => {
    expect(mapArchivedRow({ ...ROW_1006, archived: true }, "main")?.title).toBe("New task");
    const search = readMessageSearch({
      results: [
        { sessionKey: KEY, messageId: "m1", role: "user", snippet: "spring garden" },
        { sessionKey: "agent:main:garden", messageId: "m2", role: "user", snippet: "garden" },
      ],
      sessions: [ROW_1110, { key: "agent:main:garden", displayName: "calm-crab" }],
    });
    expect(search.titles).toEqual({ [KEY]: "New task", "agent:main:garden": "calm-crab" });
  });

  it("leaves every titled task's title as it was; the first message names one with none", () => {
    const grouped = groupTasks(
      [
        { key: "agent:main:main" },
        { key: "agent:main:garden" },
        { key: "agent:main:dashboard:2cc23cbf-30e2-4416-837a-56d92c983588" },
        { key: "agent:main:dashboard:abc", derivedTitle: "From the message", displayName: "x" },
        { key: "agent:main:dashboard:def", displayName: "A model's title" },
      ],
      { firstMessageTitle: (key) => (key.includes("2cc23cbf") ? "What I asked" : "Not shown") },
    );
    expect(grouped.main!.map((task) => task.title).sort()).toEqual([
      "A model's title",
      "From the message",
      "Main",
      "What I asked",
      "garden",
    ]);
  });
});

describe("the order of a task's names", () => {
  it("is a label, a generated name, the gateway's real title, the first message, the key's", () => {
    const names = { generated: "Generated", firstMessage: "First message" };
    const row = { key: KEY, label: "Typed", derivedTitle: "Derived", displayName: "Shown" };
    expect(taskTitle(row, KEY, names)).toBe("Typed");
    expect(taskTitle({ ...row, label: undefined }, KEY, names)).toBe("Generated");
    expect(taskTitle({ ...row, label: undefined }, KEY, { firstMessage: "First" })).toBe("Derived");
    expect(taskTitle({ key: KEY, displayName: "Shown" }, KEY, { firstMessage: "First" })).toBe(
      "Shown",
    );
    expect(taskTitle(ROW_1110, KEY, { firstMessage: "First" })).toBe("First");
    expect(taskTitle(ROW_1110, KEY, names)).toBe("Generated");
    expect(taskTitle(ROW_1110, KEY)).toBe("New task");
  });
});

describe("a small model's name in the order (#750)", () => {
  // The task list, the archived list and search, each from the same row as 2026.11.10 sends it.
  const first = (key: string) => (key === KEY ? "What I asked" : null);
  const searched = (row: Record<string, unknown>) =>
    readMessageSearch({
      results: [{ sessionKey: KEY, messageId: "m1", role: "assistant", snippet: "A plan." }],
      sessions: [row],
    }).titles[KEY];
  const titles = (row: Record<string, unknown>) => [
    mapSessionRow(row, { firstMessage: first(KEY) })?.title,
    mapArchivedRow({ ...row, archived: true }, "main", first)?.title,
    searched(row),
  ];

  it("a typed name over the small model's, and the small model's over the gateway's title and the first message's", () => {
    const named = { ...ROW_1110, autoLabel: "Garden plan" };
    expect(titles({ ...named, label: "Typed" })).toEqual(["Typed", "Typed", "Typed"]);
    // Over the gateway's placeholder, and over the title the first message makes.
    expect(titles(named)).toEqual(["Garden plan", "Garden plan", "Garden plan"]);
    // Over a real title the gateway supplied.
    const titled = { ...named, displayName: "A model's title", derivedTitle: "A model's title" };
    expect(titles(titled)).toEqual(["Garden plan", "Garden plan", "Garden plan"]);
    // Until it arrives, the first message's title (search has none of its own: the key's).
    expect(titles(ROW_1110)).toEqual(["What I asked", "What I asked", "New task"]);
  });

  it("an archived row that carries only `sessionKey` is read as the task list reads it", () => {
    const { key: _key, ...row } = ROW_1110;
    const archived = mapArchivedRow({ ...row, sessionKey: KEY, archived: true }, "main", first);
    const listed = mapSessionRow({ ...row, sessionKey: KEY }, { firstMessage: first(KEY) });
    expect(archived?.key).toBe(KEY);
    expect(archived?.key).toBe(listed?.key);
    expect(archived?.title).toBe("What I asked");
    expect(archived?.title).toBe(listed?.title);
  });
});

describe("a task titled from its first message", () => {
  it("made here: its message titles it once the placeholder lands (2026.11.10's event)", async () => {
    const gateway = grantingGateway();
    let created = false;
    gateway.handlers["sessions.create"] = () => {
      created = true;
      return { key: KEY, runId: "run-create" };
    };
    gateway.handlers["sessions.list"] = () => ({
      sessions: created ? [ROW_1110] : [],
      hasMore: false,
    });
    const { client } = await openTask({ gateway });
    try {
      await client.createTask("main", "Plan the **spring** garden beds\nwith raised boxes");
      gateway.emit("sessions.changed", {
        sessionKey: KEY,
        reason: "chat.title",
        ...ROW_1110,
        session: ROW_1110,
      });
      await until(() => client.state.tasksByBot.main?.some((task) => task.key === KEY) === true);
      await sleep(30);
      const task = client.state.tasksByBot.main!.find((each) => each.key === KEY)!;
      expect(task.title).toBe("Plan the spring garden beds with raised boxes");
      // Another gateway's task under the same key is not this one: its placeholder is no title.
      gateway.handlers["sessions.subscribe"] = () => ({
        subscribed: true,
        list: { sessions: [ROW_1110], hasMore: false },
      });
      await client.connect({ url: URL_B, token: "t" });
      await until(
        () =>
          client.state.connection.gatewayUrl === URL_B &&
          client.state.tasksByBot.main?.some((each) => each.key === KEY) === true,
      );
      expect(client.state.tasksByBot.main!.find((each) => each.key === KEY)!.title).toBe(
        "New task",
      );
    } finally {
      client.stop();
    }
  });

  it("listed with the placeholder: a history read that reaches its first row titles it (2026.10.6's row)", async () => {
    const gateway = grantingGateway();
    gateway.handlers["sessions.subscribe"] = () => ({
      subscribed: true,
      list: { sessions: [ROW_1006], hasMore: false },
    });
    let hasMore = true;
    gateway.handlers["chat.history"] = (params) =>
      (params as { sessionKey: string }).sessionKey === KEY
        ? {
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: "Find a quiet café near the office" }],
                timestamp: 1,
              },
              {
                role: "assistant",
                content: [{ type: "text", text: "Here are three." }],
                timestamp: 2,
              },
            ],
            hasMore,
          }
        : { messages: [], hasMore: false };
    const { client } = await openTask({ gateway });
    const shown = () => client.state.tasksByBot.main?.find((task) => task.key === KEY)?.title;
    try {
      expect(shown()).toBe("New task");
      // A read that doesn't reach the first row doesn't know the first message.
      client.openSession(KEY);
      await until(() => client.state.transcripts[KEY]?.status === "ready");
      await sleep(20);
      expect(shown()).toBe("New task");
      client.closeSession(KEY);
      hasMore = false;
      client.openSession(KEY);
      await until(() => shown() === "Find a quiet café near the office");
      // Kept once the task is closed.
      client.closeSession(KEY);
      await sleep(20);
      expect(shown()).toBe("Find a quiet café near the office");
    } finally {
      client.stop();
    }
  });

  it("read before the placeholder came: its open history titles it when the name lands", async () => {
    const gateway = grantingGateway();
    const pending = { key: KEY, sessionId: ROW_1110.sessionId, titlePending: true, updatedAt: 1 };
    gateway.handlers["sessions.subscribe"] = () => ({
      subscribed: true,
      list: { sessions: [pending], hasMore: false },
    });
    gateway.handlers["chat.history"] = (params) =>
      (params as { sessionKey: string }).sessionKey === KEY
        ? {
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: "Sort the photos by trip" }],
                timestamp: 1,
              },
            ],
            hasMore: false,
          }
        : { messages: [], hasMore: false };
    const { client } = await openTask({ gateway });
    const shown = () => client.state.tasksByBot.main?.find((task) => task.key === KEY)?.title;
    try {
      client.openSession(KEY);
      // Named from its first message at once, before the gateway names it anything.
      await until(() => shown() === "Sort the photos by trip");
      gateway.emit("sessions.changed", {
        sessionKey: KEY,
        reason: "chat.title",
        ...ROW_1110,
        session: ROW_1110,
      });
      await sleep(20);
      expect(shown()).toBe("Sort the photos by trip");
    } finally {
      client.stop();
    }
  });

  it("F-054: is the same in the archived list as in the rail", async () => {
    const gateway = grantingGateway();
    let created = false;
    gateway.handlers["sessions.create"] = () => {
      created = true;
      return { key: KEY, runId: "run-create" };
    };
    gateway.handlers["sessions.list"] = (params) =>
      (params as { archived?: unknown }).archived === true
        ? { sessions: [{ ...ROW_1110, archived: true, archivedAt: 5 }], hasMore: false }
        : { sessions: created ? [ROW_1110] : [], hasMore: false };
    const { client } = await openTask({ gateway });
    const words = "Plan the spring garden beds";
    try {
      await client.createTask("main", words);
      placeholderLands(gateway);
      await until(() => shownIn(client) === words);
      expect((await client.listArchived("main")).tasks.map((task) => task.title)).toEqual([words]);
    } finally {
      client.stop();
    }
  });

  it("follows the first message: A refused and deleted, then B sent, is titled from B", async () => {
    const gateway = grantingGateway();
    gateway.handlers["sessions.create"] = () => ({ key: KEY });
    gateway.handlers["sessions.list"] = () => ({ sessions: [ROW_1110], hasMore: false });
    gateway.handlers["chat.send"] = (params) => {
      if ((params as { message: string }).message.startsWith("Plan the garden"))
        throw new GatewayError({ code: "INVALID_REQUEST", message: "no" });
      return { runId: "run-b", status: "started" };
    };
    const { client } = await openTask({ gateway });
    const shown = () => client.state.tasksByBot.main?.find((task) => task.key === KEY)?.title;
    try {
      await client.createTask("main", "Plan the garden");
      placeholderLands(gateway);
      await until(() => client.state.transcripts[KEY]?.outbox[0]?.status === "failed");
      await until(() => shown() !== undefined);
      expect(shown()).toBe("Plan the garden");
      client.deleteMessage(KEY, client.state.transcripts[KEY]!.outbox[0]!.id);
      await until(() => shown() === "New task");
      client.sendMessage(KEY, "Sort the photos by trip");
      await until(() => shown() === "Sort the photos by trip");
    } finally {
      client.stop();
    }
  });

  it("follows the first message: history that shows another first message wins", async () => {
    const gateway = grantingGateway();
    gateway.handlers["sessions.create"] = () => ({ key: KEY, runId: "run-create" });
    gateway.handlers["sessions.list"] = () => ({ sessions: [ROW_1110], hasMore: false });
    gateway.handlers["chat.history"] = (params) =>
      (params as { sessionKey: string }).sessionKey === KEY
        ? {
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: "From the other device" }],
                timestamp: 1,
              },
            ],
            hasMore: false,
          }
        : { messages: [], hasMore: false };
    const { client } = await openTask({ gateway });
    const shown = () => client.state.tasksByBot.main?.find((task) => task.key === KEY)?.title;
    try {
      await client.createTask("main", "Plan the garden");
      placeholderLands(gateway);
      await until(() => shown() === "From the other device");
      await sleep(20);
      expect(shown()).toBe("From the other device");
    } finally {
      client.stop();
    }
  });

  it("goes with its task: a task deleted on the gateway takes its title with it", async () => {
    const gateway = grantingGateway();
    gateway.handlers["sessions.subscribe"] = () => ({
      subscribed: true,
      list: { sessions: [ROW_1110], hasMore: false },
    });
    const { client } = await openTask({ gateway });
    const kept = (client as unknown as { firstMessageTitles: Map<string, unknown> })
      .firstMessageTitles;
    try {
      (
        client as unknown as {
          keepFirstMessage(key: string, text: string, from: string | null): boolean;
        }
      ).keepFirstMessage(KEY, "Plan the garden", null);
      expect(kept.has(KEY)).toBe(true);
      gateway.emit("sessions.changed", { sessionKey: KEY, reason: "delete" });
      await until(() => !kept.has(KEY));
      expect(shownIn(client)).toBeUndefined();
    } finally {
      client.stop();
    }
  });

  /** The key's task deleted and made again while this client didn't see it: another session. */
  const madeAgain = (gateway: { emit(event: string, payload: unknown): void }) => {
    const again = { ...ROW_1110, sessionId: "7e6d5c4b-3a29-4180-9f7e-6d5c4b3a2918" };
    gateway.emit("sessions.changed", {
      sessionKey: KEY,
      reason: "chat.title",
      ...again,
      session: again,
    });
  };

  it("is the session's it was made in: made at creation, a task made again under its key has none", async () => {
    const gateway = grantingGateway();
    let created = false;
    gateway.handlers["sessions.create"] = () => {
      created = true;
      return { key: KEY, sessionId: ROW_1110.sessionId, runId: "run-create" };
    };
    gateway.handlers["sessions.list"] = () => ({
      sessions: created ? [ROW_1110] : [],
      hasMore: false,
    });
    const { client } = await openTask({ gateway });
    // Its history unread, so only the creation knows the session.
    gateway.handlers["chat.history"] = () => {
      throw new GatewayError({ code: "UNAVAILABLE", message: "not now" });
    };
    try {
      await client.createTask("main", "Plan the garden");
      placeholderLands(gateway);
      await until(() => shownIn(client) === "Plan the garden");
      madeAgain(gateway);
      await until(() => shownIn(client) === "New task");
    } finally {
      client.stop();
    }
  });

  it("is the session's it was made in: made from history, a task made again under its key has none", async () => {
    const gateway = grantingGateway();
    gateway.handlers["sessions.subscribe"] = () => ({
      subscribed: true,
      list: { sessions: [ROW_1006], hasMore: false },
    });
    gateway.handlers["chat.history"] = (params) =>
      (params as { sessionKey: string }).sessionKey === KEY
        ? {
            messages: [
              { role: "user", content: [{ type: "text", text: "Sort the photos" }], timestamp: 1 },
            ],
            hasMore: false,
          }
        : { messages: [], hasMore: false };
    const { client } = await openTask({ gateway });
    try {
      client.openSession(KEY);
      await until(() => shownIn(client) === "Sort the photos");
      client.closeSession(KEY);
      madeAgain(gateway);
      await until(() => shownIn(client) === "New task");
    } finally {
      client.stop();
    }
  });

  it("is the gateway's it was made on: another answering at the same address has none", async () => {
    const gateway = grantingGateway();
    let identity = "gateway-a";
    gateway.handlers["gateway.identity.get"] = () => ({ deviceId: identity });
    gateway.handlers["sessions.subscribe"] = () => ({
      subscribed: true,
      list: { sessions: [ROW_1110], hasMore: false },
    });
    const { client } = await openTask({ gateway });
    try {
      await until(() => client.state.connection.gatewayId === "gateway-a");
      keep(client, KEY, "Plan the garden", ROW_1110.sessionId);
      placeholderLands(gateway);
      await until(() => shownIn(client) === "Plan the garden");
      const was = client.state.connection.connectedAt;
      identity = "gateway-b";
      gateway.dropAll();
      await until(
        () =>
          client.state.connection.connectedAt !== was &&
          client.state.connection.gatewayId === "gateway-b" &&
          client.state.discovery.status === "ready",
      );
      await sleep(20);
      expect(shownIn(client)).toBe("New task");
    } finally {
      client.stop();
    }
  });

  it("keeps at most its bound, the oldest let go", async () => {
    const { client } = await openTask();
    const note = (key: string, text: string) =>
      (
        client as unknown as {
          keepFirstMessage(key: string, text: string, from: string | null): boolean;
        }
      ).keepFirstMessage(key, text, null);
    const kept = (client as unknown as { firstMessageTitles: Map<string, { title: string }> })
      .firstMessageTitles;
    try {
      for (let n = 0; n <= MAX_FIRST_MESSAGE_TITLES; n += 1)
        note(`agent:main:dashboard:${n}`, `Message ${n}`);
      expect(kept.size).toBe(MAX_FIRST_MESSAGE_TITLES);
      expect(kept.has("agent:main:dashboard:0")).toBe(false);
      expect(kept.get(`agent:main:dashboard:${MAX_FIRST_MESSAGE_TITLES}`)?.title).toBe(
        `Message ${MAX_FIRST_MESSAGE_TITLES}`,
      );
      // Cut to a title's length, as one line.
      note("agent:main:dashboard:long", `Plan\n${"x".repeat(400)}`);
      expect([...kept.get("agent:main:dashboard:long")!.title]).toHaveLength(256);
      expect(kept.size).toBe(MAX_FIRST_MESSAGE_TITLES);
    } finally {
      client.stop();
    }
  });
});
