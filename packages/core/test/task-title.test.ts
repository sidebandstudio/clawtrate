// A task the gateway could not title gets a placeholder name of its own making (#741): one
// adjective and one crustacean, in `displayName`, which the gateway's derived title then repeats.
// Rows and events here are each version's, as a development gateway sent them, with made-up keys.

import { describe, expect, it } from "vitest";
import { MAX_FIRST_MESSAGE_TITLES } from "../src/client.ts";
import { groupTasks, isPlaceholderName, mapSessionRow } from "../src/mapping.ts";
import { readMessageSearch } from "../src/search.ts";
import { mapArchivedRow } from "../src/task-actions.ts";
import { grantingGateway, openTask, URL_B } from "./client-harness.ts";
import { sleep, until } from "./fake-gateway.ts";

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

const title = (row: Record<string, unknown>, first: string | null = null) =>
  mapSessionRow(row, first)?.title;

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
    expect(title({ key: KEY }, "Plan")).toBe("New task");
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

  it("leaves every other task's title as it was", () => {
    const grouped = groupTasks(
      [
        { key: "agent:main:main" },
        { key: "agent:main:dashboard:2cc23cbf-30e2-4416-837a-56d92c983588" },
        { key: "agent:main:dashboard:abc", derivedTitle: "From the message", displayName: "x" },
        { key: "agent:main:dashboard:def", displayName: "A model's title" },
      ],
      { firstMessageTitle: () => "Never used" },
    );
    expect(grouped.main!.map((task) => task.title).sort()).toEqual([
      "A model's title",
      "From the message",
      "Main",
      "New task",
    ]);
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
      await until(() => client.state.transcripts[KEY]?.status === "ready");
      expect(shown()).toBe("New task");
      gateway.emit("sessions.changed", {
        sessionKey: KEY,
        reason: "chat.title",
        ...ROW_1110,
        session: ROW_1110,
      });
      await until(() => shown() === "Sort the photos by trip");
    } finally {
      client.stop();
    }
  });

  it("keeps at most its bound, the oldest let go", async () => {
    const { client } = await openTask();
    const note = (key: string, text: string) =>
      (client as unknown as { noteFirstMessage(key: string, text: string): void }).noteFirstMessage(
        key,
        text,
      );
    const kept = (client as unknown as { firstMessageTitles: Map<string, string> })
      .firstMessageTitles;
    try {
      for (let n = 0; n <= MAX_FIRST_MESSAGE_TITLES; n += 1)
        note(`agent:main:dashboard:${n}`, `Message ${n}`);
      expect(kept.size).toBe(MAX_FIRST_MESSAGE_TITLES);
      expect(kept.has("agent:main:dashboard:0")).toBe(false);
      expect(kept.get(`agent:main:dashboard:${MAX_FIRST_MESSAGE_TITLES}`)).toBe(
        `Message ${MAX_FIRST_MESSAGE_TITLES}`,
      );
      // A task's first message is kept once: a later one doesn't replace it.
      note(`agent:main:dashboard:${MAX_FIRST_MESSAGE_TITLES}`, "Another");
      expect(kept.get(`agent:main:dashboard:${MAX_FIRST_MESSAGE_TITLES}`)).toBe(
        `Message ${MAX_FIRST_MESSAGE_TITLES}`,
      );
      // Cut to a title's length, as one line.
      note("agent:main:dashboard:long", `Plan\n${"x".repeat(400)}`);
      expect([...kept.get("agent:main:dashboard:long")!]).toHaveLength(256);
    } finally {
      client.stop();
    }
  });
});
