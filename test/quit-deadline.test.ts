// The launch check's quit deadline (e2e-packaged/quit.ts): it starts when the
// app is asked to quit, and a slow debugger disconnect does not extend it.
import { describe, expect, it } from "vitest";
import { quitWithin } from "../e2e-packaged/quit.ts";

const after = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a quit's deadline", () => {
  it("passes a process gone within the deadline", async () => {
    expect(
      await quitWithin(
        () => undefined,
        () => after(20),
        () => after(10),
        100,
      ),
    ).toBe(true);
  });

  it("fails a process gone after the deadline, though the disconnect ran longer than it", async () => {
    // The process exits 150 ms after it is asked, whenever anyone starts watching it;
    // the deadline is 100 ms after asking, and the disconnect takes 120 ms.
    let exit: Promise<unknown> = Promise.resolve();
    expect(
      await quitWithin(
        () => void (exit = after(150)),
        () => exit,
        () => after(120),
        100,
      ),
    ).toBe(false);
  });

  it("starts the deadline when it asks, not before or after", async () => {
    const asked: number[] = [];
    const start = Date.now();
    const quit = await quitWithin(
      () => void asked.push(Date.now() - start),
      () => new Promise(() => undefined),
      async () => undefined,
      60,
    );
    expect(quit).toBe(false);
    expect(asked).toHaveLength(1);
    expect(Date.now() - start).toBeLessThan(200);
  });

  it("returns at the deadline though the disconnect never settles, so a forced quit can follow", async () => {
    const start = Date.now();
    const quit = await quitWithin(
      () => undefined,
      () => new Promise(() => undefined),
      () => new Promise(() => undefined),
      60,
    );
    expect(quit).toBe(false);
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
