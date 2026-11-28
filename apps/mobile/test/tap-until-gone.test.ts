// How F-115's Simulator check closes the share sheet (#1025): a tap outside it, and another while
// it is still up, as a person taps again when a tap doesn't take. On the Simulator the first tap
// almost always closes it, so the taps after it are proven here, against a stand-in for the
// Maestro commands the steps use.

import { describe, expect, it } from "vitest";
import { tapUntilGone, type Step } from "../simulator/harness.ts";

const OUTSIDE = { point: "75%,11%" };
const SHEET = "Save to Files";

/**
 * Run `steps` as Maestro does against a sheet that closes on its `closesOn`th tap (never, for
 * Infinity): a tap is counted, a wait for the sheet to go passes once it has gone and fails the
 * steps otherwise unless it is optional, and a flow `when` the sheet is visible runs only then.
 */
function run(steps: Step[], closesOn: number) {
  let taps = 0;
  let waits = 0;
  const up = () => taps < closesOn;
  const each = (commands: Step[]): void => {
    for (const command of commands) {
      if (typeof command === "string") throw new Error(`Unexpected command ${command}`);
      const [name, args] = Object.entries(command)[0] as [string, Record<string, unknown>];
      if (name === "tapOn") {
        expect(args).toEqual(OUTSIDE);
        taps += 1;
      } else if (name === "extendedWaitUntil") {
        expect(args.notVisible).toBe(SHEET);
        expect(args.timeout).toBeLessThanOrEqual(10_000);
        waits += 1;
        if (up() && !args.optional) throw new Error(`"${SHEET}" is still visible`);
      } else if (name === "runFlow") {
        const flow = args as { when: { visible: string }; commands: Step[] };
        expect(flow.when).toEqual({ visible: SHEET });
        if (up()) each(flow.commands);
      } else throw new Error(`Unexpected command ${name}`);
    }
  };
  try {
    each(steps);
    return { passed: true, taps, waits };
  } catch {
    return { passed: false, taps, waits };
  }
}

describe("F-115: the check closes the share sheet as a person does", () => {
  const close = tapUntilGone(OUTSIDE, SHEET);

  it("F-115: a tap that closes it is the only tap", () => {
    expect(run(close, 1)).toEqual({ passed: true, taps: 1, waits: 1 });
  });

  it("F-115: a tap that doesn't take is followed by another, each with its wait for the sheet to go", () => {
    expect(run(close, 2)).toEqual({ passed: true, taps: 2, waits: 2 });
    expect(run(close, 3)).toEqual({ passed: true, taps: 3, waits: 3 });
  });

  it("F-115: a sheet that never closes fails the steps after three taps, with no swipe", () => {
    expect(run(close, Infinity)).toEqual({ passed: false, taps: 3, waits: 3 });
    expect(JSON.stringify(close)).not.toMatch(/swipe|scroll/i);
  });

  it("F-115: with one try it is the one tap and the check's own wait", () => {
    const once = tapUntilGone(OUTSIDE, SHEET, { tries: 1, ms: 30_000 });
    expect(once).toEqual([
      { tapOn: OUTSIDE },
      { extendedWaitUntil: { notVisible: SHEET, timeout: 30_000 } },
    ]);
  });
});
