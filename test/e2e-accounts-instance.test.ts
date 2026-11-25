// The accounts instance's fixture (e2e/accounts-instance.ts) resets the instance after the
// worker's last use of it, and also when its start, or a check after the start, throws: a failed
// start leaves nothing for a later run to recover.
import { describe, expect, it, vi } from "vitest";
import { whileStarted } from "../e2e/accounts-instance.ts";

describe("the accounts instance's start, use and reset", () => {
  it("resets after the last use and returns what the reset reported", async () => {
    const order: string[] = [];
    const problems = await whileStarted(
      () => order.push("start"),
      async () => void order.push("use"),
      () => (order.push("reset"), ["a problem"]),
    );
    expect(order).toEqual(["start", "use", "reset"]);
    expect(problems).toEqual(["a problem"]);
  });

  it("resets when a check after the start throws, never uses it, and throws that error", async () => {
    const use = vi.fn(async () => {});
    const reset = vi.fn(() => []);
    await expect(
      whileStarted(
        () => {
          throw new Error("instance e2e-00000000-acct is not running");
        },
        use,
        reset,
      ),
    ).rejects.toThrow("is not running");
    expect(use).not.toHaveBeenCalled();
    expect(reset).toHaveBeenCalledOnce();
  });

  it("resets when the use throws, and prints what the reset couldn't do", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const reset = vi.fn(() => ["the instance's folder was not removed"]);
    await expect(
      whileStarted(
        () => {},
        async () => {
          throw new Error("the worker stopped");
        },
        reset,
      ),
    ).rejects.toThrow("the worker stopped");
    expect(reset).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith("the instance's folder was not removed");
    error.mockRestore();
  });
});
