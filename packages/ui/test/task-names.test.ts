// What a task's name says about how its latest run ended (F-057): a stopped
// task is never named idle.

import { describe, expect, it } from "vitest";
import { restingWords } from "../src/Rail.tsx";

describe("F-057: task names", () => {
  it("a task with no mark says done, stopped or idle as its status is", () => {
    expect(restingWords({ status: "done" })).toBe(", done");
    expect(restingWords({ status: "done-with-failures" })).toBe(", done");
    expect(restingWords({ status: "stopped" })).toBe(", stopped");
    expect(restingWords({ status: "idle" })).toBe(", idle");
  });
});
