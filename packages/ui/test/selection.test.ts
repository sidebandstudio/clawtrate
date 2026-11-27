import type { Bot, Task } from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import {
  botLabel,
  botOpening,
  botRowLabel,
  canUnfold,
  linkTarget,
  shownConversation,
  summarize,
  taskState,
  visibleTasks,
} from "../src/selection.ts";

const bot: Bot = {
  id: "otto",
  name: "Otto",
  emoji: null,
  avatarUrl: null,
  theme: null,
  model: null,
  isDefault: false,
};

function task(key: string, updatedAt: number, extra: Partial<Task> = {}): Task {
  return {
    key,
    botId: "otto",
    sessionId: null,
    title: key,
    preview: `${key} preview`,
    updatedAt,
    status: "done",
    unread: false,
    ...extra,
  };
}

describe("a bot's summary of all its tasks", () => {
  it("is empty for a bot with no tasks", () => {
    expect(summarize([], {}, null)).toEqual({ latest: null, unread: false, state: null });
    expect(botLabel(bot, 0, summarize([], {}, null))).toBe("Otto");
    // #790: the row has no words for it, so its name says its tasks are still being read.
    expect(botLabel(bot, 0, summarize([], {}, null), { loading: true })).toBe(
      "Otto, loading tasks",
    );
    expect(botLabel(bot, 1, summarize([], {}, null), { loading: true })).toBe("Otto, 1 task");
  });

  it("keeps preview, unread and run state independent", () => {
    const tasks = [
      task("newest", 300),
      task("running", 200, { status: "running" }),
      task("old-unread", 100, { unread: true }),
    ];
    const summary = summarize(tasks, {}, "newest");
    expect(summary.latest?.key).toBe("newest");
    expect(summary.unread).toBe(true);
    expect(summary.state).toBe("working");
    expect(botLabel(bot, 3, summary)).toBe("Otto, working, 3 tasks, unread");
  });

  it("does not count the task on screen as unread, and ranks failed before working", () => {
    const tasks = [
      task("a", 2, { unread: true, status: "running" }),
      task("b", 1, { status: "failed" }),
    ];
    const summary = summarize(tasks, {}, "a");
    expect(summary.unread).toBe(false);
    expect(summary.state).toBe("failed");
    expect(botLabel(bot, 2, summary)).toBe("Otto, a run failed, 2 tasks");
  });

  it("forgets unread once the viewer has seen the latest activity", () => {
    const tasks = [task("a", 5, { unread: true })];
    expect(summarize(tasks, { a: 5 }, null).unread).toBe(false);
    expect(summarize(tasks, { a: 4 }, null).unread).toBe(true);
  });
});

describe("the rows under an unfolded bot", () => {
  const fourteen = Array.from({ length: 14 }, (_, i) => task(`t${i}`, 100 - i));

  it("shows six, always including the current task", () => {
    expect(visibleTasks(fourteen, null, false).map((t) => t.key)).toEqual([
      "t0",
      "t1",
      "t2",
      "t3",
      "t4",
      "t5",
    ]);
    expect(visibleTasks(fourteen, "t11", false).map((t) => t.key)).toEqual([
      "t0",
      "t1",
      "t2",
      "t3",
      "t4",
      "t11",
    ]);
  });

  it("shows all when asked", () => {
    expect(visibleTasks(fourteen, null, true)).toHaveLength(14);
  });
});

describe("F-020 F-426: a bot row's state", () => {
  it("F-020: names a working bot first by its state, as assistive tools read it", () => {
    const summary = summarize([task("a", 1, { status: "running" })], {}, null);
    expect(botLabel(bot, 1, summary)).toMatch(/^Otto, working\b/);
    expect(botLabel(bot, 1, summary, { primary: true, label: "operations" })).toBe(
      "Otto, working, 1 task, operations, primary bot",
    );
  });

  it("F-426: one waiting and one working task shows waiting", () => {
    const tasks = [task("w", 2, { status: "waiting" }), task("r", 1, { status: "running" })];
    expect(summarize(tasks, {}, null).state).toBe("waiting");
  });

  it("F-426: follows waiting, failed or blocked, done with failures, working, then the unread dot", () => {
    const order: Array<[Task["status"], string | null]> = [
      ["waiting", "waiting"],
      ["failed", "failed"],
      ["blocked", "blocked"],
      ["done-with-failures", "done-with-failures"],
      ["running", "working"],
    ];
    for (let i = 0; i < order.length; i += 1) {
      const tasks = order.slice(i).map(([status], j) => task(`t${j}`, 10 - j, { status }));
      expect(summarize(tasks, {}, null).state).toBe(order[i]![1]);
    }
    // Failed and blocked share a place: whichever is present shows.
    expect(summarize([task("b", 2, { status: "blocked" })], {}, null).state).toBe("blocked");
    const done = summarize([task("d", 1, { unread: true })], {}, null);
    expect([done.state, done.unread]).toEqual([null, true]);
    expect(summarize([task("i", 1)], {}, null)).toMatchObject({ state: null, unread: false });
  });

  it("F-426: opening the done-with-failures task clears it, and the row shows working", () => {
    const tasks = [
      task("dwf", 5, { status: "done-with-failures" }),
      task("run", 4, { status: "running" }),
    ];
    expect(summarize(tasks, {}, null).state).toBe("done-with-failures");
    // On screen, it is cleared at once; after it is left, the seen map keeps it cleared.
    expect(summarize(tasks, {}, "dwf").state).toBe("working");
    expect(summarize(tasks, { dwf: 5 }, "run").state).toBe("working");
    expect(taskState(tasks[0]!, { dwf: 5 }, null)).toBe(null);
    // New activity in that task after it was seen brings the marker back.
    const later = [{ ...tasks[0]!, updatedAt: 9 }, tasks[1]!];
    expect(summarize(later, { dwf: 5 }, null).state).toBe("done-with-failures");
  });
});

describe("F-563: a link to a task", () => {
  it("F-563: opens a session the list hides, by its key, rather than the bot's newest task", () => {
    const listed = [task("agent:otto:dashboard:a", 300)];
    const hidden = "agent:otto:openai-user:client";
    expect(linkTarget(listed, "otto", hidden, null)).toMatchObject({ key: hidden, botId: "otto" });
    expect(linkTarget(undefined, "otto", hidden, null)).toMatchObject({ key: hidden });
    // One the list holds opens from the list; one given with the link is kept.
    expect(linkTarget(listed, "otto", "agent:otto:dashboard:a", null)).toBeNull();
    const given = task(hidden, 5, { title: "From the routine" });
    expect(linkTarget(listed, "otto", hidden, given)).toBe(given);
  });
});

describe("a bot's row opens its main conversation (docs/design/bot-opens-main.md)", () => {
  const main = task("agent:otto:main", 50, { isMain: true });
  const disk = task("agent:otto:disk", 300);
  const logs = task("agent:otto:logs", 200);

  it("opens the main conversation of another bot, not the task it last had open", () => {
    expect(botOpening("otto", [disk, main], { botId: "pip", key: "agent:pip:main" })).toEqual({
      key: "agent:otto:main",
      otherBot: true,
    });
  });

  it("opens the main conversation of the open bot from one of its tasks", () => {
    expect(botOpening("otto", [disk, main], { botId: "otto", key: disk.key })).toEqual({
      key: "agent:otto:main",
      otherBot: false,
    });
  });

  it("changes nothing when that main conversation is on screen", () => {
    expect(botOpening("otto", [disk, main], { botId: "otto", key: main.key })).toBeNull();
  });

  it("opens a bot with no main conversation yet at its own key", () => {
    expect(botOpening("otto", [disk], { botId: null, key: null })).toEqual({
      key: "agent:otto:main",
      otherBot: true,
    });
  });

  it("shows what the bot last had open while its list holds it, else its main conversation", () => {
    expect(shownConversation([disk, main], disk.key, null, main)).toBe(disk);
    expect(shownConversation([disk, main], "agent:otto:archived", null, main)).toBe(main);
    expect(shownConversation([disk, main], undefined, null, main)).toBe(main);
    // A linked task the list doesn't hold, while it is the one remembered.
    const linked = task("agent:otto:hidden", 10);
    expect(shownConversation([disk, main], linked.key, linked, main)).toBe(linked);
    expect(shownConversation([disk, main], disk.key, linked, main)).toBe(disk);
  });

  it("counts the tasks under the bot without its main conversation, and keeps its unread", () => {
    const unreadMain = { ...main, unread: true };
    const all = [disk, logs, unreadMain];
    expect(botRowLabel(bot, all, summarize(all, {}, null))).toBe("Otto, 2 tasks, unread");
    expect(botRowLabel(bot, [main], summarize([main], {}, null))).toBe("Otto");
  });

  it("unfolds a bot with one task under it, but not a bot with only its main conversation", () => {
    expect(canUnfold([disk, main])).toBe(true);
    expect(canUnfold([disk])).toBe(true);
    expect(canUnfold([main])).toBe(false);
    expect(canUnfold([])).toBe(false);
    expect(canUnfold([main], true)).toBe(true);
  });
});
