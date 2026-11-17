import type { Bot, Task } from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { botLabel, summarize, visibleTasks } from "../src/selection.ts";

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
    expect(botLabel(bot, 0, summarize([], {}, null))).toBe("Otto, 0 tasks");
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
    expect(botLabel(bot, 3, summary)).toBe("Otto, 3 tasks, working, unread");
  });

  it("does not count the task on screen as unread, and ranks failed before working", () => {
    const tasks = [
      task("a", 2, { unread: true, status: "running" }),
      task("b", 1, { status: "failed" }),
    ];
    const summary = summarize(tasks, {}, "a");
    expect(summary.unread).toBe(false);
    expect(summary.state).toBe("failed");
    expect(botLabel(bot, 2, summary)).toBe("Otto, 2 tasks, a run failed");
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
