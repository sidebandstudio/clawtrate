import { describe, expect, it } from "vitest";
import { removeUntilGone, type Presence } from "../src/cleanup.ts";

/** A gateway's items by key, and a clock the passes move along. */
function world(initial: string[]) {
  const items = new Set(initial);
  let clock = 0;
  const removed: string[] = [];
  return {
    items,
    removed,
    options: {
      present: async (key: string): Promise<Presence> => items.has(key),
      remove: async (key: string) => {
        items.delete(key);
        removed.push(key);
      },
      deadlineMs: 10_000,
      pauseMs: 1000,
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
    },
  };
}

describe("removing what a check made", () => {
  it("removes a create that lands after a pass found nothing", async () => {
    const gateway = world([]);
    let passes = 0;
    const present = gateway.options.present;
    const result = await removeUntilGone(["agent:otto:late"], {
      ...gateway.options,
      present: async (key) => {
        // The create timed out on the client, then landed after the first look.
        if ((passes += 1) === 2) gateway.items.add(key);
        return present(key);
      },
    });
    expect(result).toEqual({ gone: true, left: [] });
    expect(gateway.removed).toEqual(["agent:otto:late"]);
    expect(gateway.items.size).toBe(0);
  });

  it("asks for each key itself, and an answer it couldn't get is not gone", async () => {
    const gateway = world(["agent:main:a", "agent:pip:b"]);
    let failures = 2;
    const present = gateway.options.present;
    const result = await removeUntilGone(["agent:main:a", "agent:pip:b"], {
      ...gateway.options,
      present: async (key) => {
        if (key === "agent:pip:b" && failures > 0) {
          failures -= 1;
          return "unknown";
        }
        return present(key);
      },
    });
    expect(result).toEqual({ gone: true, left: [] });
    expect(gateway.items.size).toBe(0);
  });

  it("never says gone on one empty pass: a deadline before the second is a failure", async () => {
    const gateway = world([]);
    const result = await removeUntilGone(["agent:otto:maybe"], {
      ...gateway.options,
      deadlineMs: 1000,
    });
    expect(result).toEqual({ gone: false, left: ["agent:otto:maybe"] });
  });

  it("never says gone on a second pass that ends after the deadline", async () => {
    const gateway = world([]);
    let clock = 0;
    const result = await removeUntilGone(["agent:otto:slow"], {
      ...gateway.options,
      deadlineMs: 1500,
      pauseMs: 400,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      // Each look takes 600 ms: the second starts at 1,000, in time, and ends at 1,600, late.
      present: async () => {
        clock += 600;
        return false;
      },
    });
    expect(result).toEqual({ gone: false, left: ["agent:otto:slow"] });
  });

  it("never says gone on a second pass that ends exactly at the deadline", async () => {
    const gateway = world([]);
    let clock = 0;
    const result = await removeUntilGone(["agent:otto:edge"], {
      ...gateway.options,
      deadlineMs: 1600,
      pauseMs: 400,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      // The second look starts at 1,000 and ends at 1,600: the deadline itself.
      present: async () => {
        clock += 600;
        return false;
      },
    });
    expect(result).toEqual({ gone: false, left: ["agent:otto:edge"] });
  });

  it("stops waiting at the deadline for a look that never answers", async () => {
    const result = await removeUntilGone(["agent:otto:hung"], {
      present: () => new Promise<Presence>(() => {}),
      remove: async () => {},
      deadlineMs: 50,
    });
    expect(result).toEqual({ gone: false, left: ["agent:otto:hung"] });
  });

  it("stops waiting at the deadline for a removal that never finishes", async () => {
    const result = await removeUntilGone(["agent:otto:hung"], {
      present: async () => true,
      remove: () => new Promise<void>(() => {}),
      deadlineMs: 50,
      pauseMs: 10,
    });
    expect(result).toEqual({ gone: false, left: ["agent:otto:hung"] });
  });

  it("ends the pause between passes at the deadline", async () => {
    const started = Date.now();
    const result = await removeUntilGone(["agent:otto:stuck"], {
      present: async () => true,
      remove: async () => {},
      deadlineMs: 100,
      // A pause that would never end, and one far longer than the time left.
      sleep: () => new Promise<void>(() => {}),
    });
    expect(result).toEqual({ gone: false, left: ["agent:otto:stuck"] });
    const second = await removeUntilGone(["agent:otto:stuck"], {
      present: async () => true,
      remove: async () => {},
      deadlineMs: 100,
      pauseMs: 60_000,
    });
    expect(second).toEqual({ gone: false, left: ["agent:otto:stuck"] });
    // Both returned at their deadlines, not after their pauses.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("returns what it couldn't remove by the deadline", async () => {
    const gateway = world(["agent:otto:stuck"]);
    const result = await removeUntilGone(["agent:otto:stuck"], {
      ...gateway.options,
      remove: async () => {},
    });
    expect(result).toEqual({ gone: false, left: ["agent:otto:stuck"] });
  });
});
