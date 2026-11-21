import { afterEach, describe, expect, it, vi } from "vitest";
import { holdableTimers } from "../src/fixture/timers.ts";

describe("the fixture's holdable answers", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("a release runs held answers in the order they were due, not the order they were held", () => {
    vi.useFakeTimers();
    // The visual checks fix the wall clock for the whole page; due times must not depend on it.
    vi.spyOn(Date, "now").mockReturnValue(0);
    const order: string[] = [];
    const timers = holdableTimers();
    // Due at 1,000 ms, asked for before the hold: its timer fires while held.
    timers.deferred(() => order.push("pairing"), 1_000);
    vi.advanceTimersByTime(900);
    timers.hold();
    // Due at 1,300 ms, asked for while held. Its delay is shorter, so only elapsed time orders it.
    timers.deferred(() => order.push("admin"), 400);
    vi.advanceTimersByTime(200);
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
