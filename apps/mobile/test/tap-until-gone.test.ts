// How F-115's Simulator check closes the share sheet (#1025): a tap outside it, and another while
// it is still up, as a person taps again when a tap doesn't take. On the Simulator the first tap
// almost always closes it, so the taps after it are proven here, against a stand-in for the
// Maestro commands the steps use, and so is the run's report of which tap closed it.

import { describe, expect, it } from "vitest";
import { tapsTaken, tapUntilGone, type Step } from "../simulator/harness.ts";

const OUTSIDE = { point: "75%,11%" };
const SHEET = "Save to Files";
const LABEL = "Tap outside the share sheet";
/** The steps failed: a wait that isn't optional ended with the sheet still up. */
class StillUp extends Error {}

/**
 * Run `steps` as Maestro does against a sheet that closes on its `closesOn`th tap (never, for
 * Infinity): a tap is counted, a wait for the sheet to go passes once it has gone and fails the
 * steps otherwise unless it is optional, and a flow `when` the sheet is visible runs only then.
 * The output is Maestro's plain-text log of it: each command that ran named by its label, or what
 * it does, as "<name>... <status>", and a flow's commands indented under it.
 */
function run(steps: Step[], closesOn: number) {
  let taps = 0;
  let waits = 0;
  const lines: string[] = [];
  const up = () => taps < closesOn;
  const each = (commands: Step[], pad: string): void => {
    for (const command of commands) {
      if (typeof command === "string") throw new Error(`Unexpected command ${command}`);
      const [name, args] = Object.entries(command)[0] as [string, Record<string, unknown>];
      if (name === "tapOn") {
        const { label, ...where } = args as { label?: string };
        expect(where).toEqual(OUTSIDE);
        taps += 1;
        lines.push(`${pad}${label ?? `Tap on point (${OUTSIDE.point})`}... COMPLETED`);
      } else if (name === "extendedWaitUntil") {
        expect(args.notVisible).toBe(SHEET);
        expect(args.timeout).toBeLessThanOrEqual(10_000);
        waits += 1;
        const named = `${pad}Assert that "${SHEET}" is not visible...`;
        if (up() && !args.optional) throw new StillUp(`"${SHEET}" is still visible`);
        lines.push(`${named} ${up() ? "WARNED" : "COMPLETED"}`);
      } else if (name === "runFlow") {
        const flow = args as { when: { visible: string }; commands: Step[] };
        expect(flow.when).toEqual({ visible: SHEET });
        const named = `${pad}Run flow when "${SHEET}" is visible...`;
        lines.push(named);
        if (!up()) {
          lines.push(`${named} SKIPPED`);
          continue;
        }
        each(flow.commands, `${pad}  `);
        lines.push(`${named} COMPLETED`);
      } else throw new Error(`Unexpected command ${name}`);
    }
  };
  try {
    each(steps, "");
    return { passed: true, taps, waits, output: `${lines.join("\n")}\n` };
  } catch (error) {
    if (!(error instanceof StillUp)) throw error;
    return { passed: false, taps, waits, output: `${lines.join("\n")}\n` };
  }
}

describe("F-115: the check closes the share sheet as a person does", () => {
  const close = tapUntilGone(OUTSIDE, SHEET, LABEL);

  it("F-115: a tap that closes it is the only tap", () => {
    expect(run(close, 1)).toMatchObject({ passed: true, taps: 1, waits: 1 });
  });

  it("F-115: a tap that doesn't take is followed by another, each with its wait for the sheet to go", () => {
    expect(run(close, 2)).toMatchObject({ passed: true, taps: 2, waits: 2 });
    expect(run(close, 3)).toMatchObject({ passed: true, taps: 3, waits: 3 });
  });

  it("F-115: a sheet that never closes fails the steps after three taps, with no swipe", () => {
    expect(run(close, Infinity)).toMatchObject({ passed: false, taps: 3, waits: 3 });
    expect(JSON.stringify(close)).not.toMatch(/swipe|scroll/i);
  });

  it("F-115: with one try it is the one tap and the check's own wait", () => {
    const once = tapUntilGone(OUTSIDE, SHEET, LABEL, { tries: 1, ms: 30_000 });
    expect(once).toEqual([
      { tapOn: { ...OUTSIDE, label: `${LABEL} (1 of 1)` } },
      { extendedWaitUntil: { notVisible: SHEET, timeout: 30_000 } },
    ]);
  });
});

describe("F-115: the run's report says which tap closed the share sheet", () => {
  const close = tapUntilGone(OUTSIDE, SHEET, LABEL);
  const report = (output: string) => tapsTaken(close, output, "the share sheet");

  it("F-115: a sheet the first tap closes is reported closed on tap 1", () => {
    expect(report(run(close, 1).output)).toEqual({
      message: "the share sheet closed on tap 1",
      type: "notice",
    });
  });

  it("F-115: a sheet a later tap closes is reported closed on that tap, of three", () => {
    expect(report(run(close, 2).output)).toEqual({
      message: "the share sheet closed on tap 2 of 3",
      type: "notice",
    });
    expect(report(run(close, 3).output)).toEqual({
      message: "the share sheet closed on tap 3 of 3",
      type: "notice",
    });
  });

  it("F-115: output that doesn't tell which tap took gives a warning, not a guess", () => {
    const warning = {
      message: "Maestro's output didn't say which tap closed the share sheet",
      type: "warning",
    };
    // No output, a tap with no label as #1025's run printed it, and a tap named without the one
    // before it: the second with no first, the third with no second.
    const without = (closesOn: number, tap: number) =>
      run(close, closesOn).output.replace(`${LABEL} (${tap} of 3)... COMPLETED`, "");
    const unlabelled = `Tap on point (${OUTSIDE.point})... COMPLETED\n`;
    for (const output of ["", unlabelled, without(2, 1), without(3, 2)])
      expect(report(output)).toEqual(warning);
  });
});
