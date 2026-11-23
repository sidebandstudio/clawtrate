// The launch check's quit deadline (e2e-packaged/quit.ts): it starts when the
// app is asked to quit, and a slow debugger disconnect does not extend it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { quitWithin } from "../e2e-packaged/quit.ts";

const after = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const never = () => new Promise(() => undefined);

afterEach(() => {
  vi.useRealTimers();
});

describe("a quit's deadline", () => {
  it("passes a process gone within the deadline", async () => {
    vi.useFakeTimers();
    const quit = quitWithin(
      () => undefined,
      () => after(20),
      () => after(10),
      100,
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(await quit).toBe(true);
  });

  it("fails a process gone after the deadline, though the disconnect ran longer than it", async () => {
    vi.useFakeTimers();
    // The process exits 150 ms after it is asked, whenever anyone starts watching it;
    // the deadline is 100 ms after asking, and the disconnect takes 120 ms.
    let exit: Promise<unknown> = Promise.resolve();
    const quit = quitWithin(
      () => void (exit = after(150)),
      () => exit,
      () => after(120),
      100,
    );
    await vi.advanceTimersByTimeAsync(150);
    expect(await quit).toBe(false);
  });

  it("starts the deadline when it asks: pending at 59 ms, failed at 60 ms", async () => {
    vi.useFakeTimers();
    const ask = vi.fn();
    let result: boolean | undefined;
    void quitWithin(ask, never, async () => undefined, 60).then((quit) => (result = quit));
    expect(ask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("returns at the deadline though the disconnect never settles, so a forced quit can follow", async () => {
    vi.useFakeTimers();
    let result: boolean | undefined;
    void quitWithin(() => undefined, never, never, 60).then((quit) => (result = quit));
    await vi.advanceTimersByTimeAsync(60);
    expect(result).toBe(false);
  });

  it("fails an exit seen only after the deadline, though seen before the deadline's timer runs", async () => {
    // Real timers: a synchronous poll that starts at 50 ms and blocks until 80 ms
    // sees the exit while the 60 ms timer waits behind it.
    const gone = () =>
      new Promise<void>((resolve) =>
        setTimeout(() => {
          const until = performance.now() + 30;
          while (performance.now() < until);
          resolve();
        }, 50),
      );
    expect(
      await quitWithin(
        () => undefined,
        gone,
        async () => undefined,
        60,
      ),
    ).toBe(false);
  });

  it("clears its deadline timer when the exit probe fails, and passes the failure on", async () => {
    vi.useFakeTimers();
    const failure = new Error("ps could not run");
    await expect(
      quitWithin(
        () => undefined,
        () => Promise.reject(failure),
        never,
        15_000,
      ),
    ).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });
});
