// What a task's name and its bot's line say about how its latest run ended
// (F-057, F-295): a stopped task is never named idle, and the bot's line
// counts failed actions as the task says them, or says nothing of them.

import type { Task } from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { failureWords, restingWords } from "../src/Rail.tsx";

const task = (key: string, change: Partial<Task>): Task =>
  ({ key, botId: "otto", title: key, status: "idle", updatedAt: 10, ...change }) as Task;

describe("F-057 F-295: task names and the bot's failure line", () => {
  it("a task with no mark says done, stopped or idle as its status is", () => {
    expect(restingWords({ status: "done" })).toBe(", done");
    expect(restingWords({ status: "done-with-failures" })).toBe(", done");
    expect(restingWords({ status: "stopped" })).toBe(", stopped");
    expect(restingWords({ status: "idle" })).toBe(", idle");
  });

  it("the bot's line counts what the task's own count says, and is absent without one", () => {
    const failing = task("a", { status: "done-with-failures", failedActions: 2, updatedAt: 20 });
    expect(failureWords([failing], {}, null)).toBe("Finished with 2 failed actions");
    expect(failureWords([{ ...failing, failedActions: 1 }], {}, null)).toBe(
      "Finished with 1 failed action",
    );
    // Opened since: the line goes.
    expect(failureWords([failing], { a: 30 }, null)).toBeNull();
    // A task with no count of its own gets no invented one.
    expect(failureWords([{ ...failing, failedActions: undefined }], {}, null)).toBeNull();
  });
});
