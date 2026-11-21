import { afterEach, describe, expect, it, vi } from "vitest";
import { holdableTimers } from "../src/fixture/timers.ts";

describe("the fixture's holdable answers", () => {
  afterEach(() => vi.useRealTimers());

  it("a release runs held answers in the order they were due, not the order they were held", () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const timers = holdableTimers();
    // Due at 400 ms, asked for before the hold: its timer fires while held.
    timers.deferred(() => order.push("pairing"), 400);
    timers.hold();
    // Due at 1,000 ms, asked for while held: held at once, ahead of the earlier one.
    timers.deferred(() => order.push("admin"), 1_000);
    vi.advanceTimersByTime(500);
    expect(order).toEqual([]);
    timers.release();
    expect(order).toEqual(["pairing", "admin"]);
  });

  it("an answer asked for while held comes on release without waiting for its timer", () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const timers = holdableTimers();
    timers.hold();
    timers.deferred(() => order.push("grant"), 1_000);
    timers.release();
    expect(order).toEqual(["grant"]);
  });
});
