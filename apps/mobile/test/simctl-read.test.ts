// The iPhone checks' reads through simctl (#1039). On a loaded runner CoreSimulator can time out
// before it answers, which says nothing about the app, so a read is asked again. The Simulator
// checks meet a timeout only by chance, so the rule's cases are proven here with a stand-in for
// `xcrun simctl`.

import { describe, expect, it } from "vitest";
import { simctlRead, type SimctlResult } from "../simulator/harness.ts";

// What simctl printed when `pbpaste` timed out on CI (#1039).
const TIMED_OUT =
  "An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=60):\n" +
  "The operation couldn't be completed. Operation timed out\n";

const answer = (stdout: string): SimctlResult => ({ status: 0, stdout, stderr: "" });
const failure = (stderr: string): SimctlResult => ({ status: 1, stdout: "", stderr });

/**
 * `simctl pbpaste booted` against a stand-in that gives these results in turn,
 * with each run and pause it saw.
 */
function pbpaste(...results: SimctlResult[]) {
  const runs: string[][] = [];
  const pauses: number[] = [];
  const run = (args: string[]) => {
    runs.push(args);
    const result = results[runs.length - 1];
    if (!result) throw new Error(`simctl ran ${runs.length} times`);
    return result;
  };
  return {
    runs,
    pauses,
    read: () => simctlRead(["pbpaste", "booted"], run, (ms) => pauses.push(ms)),
  };
}

describe("simctlRead", () => {
  it.each([
    ["the timeout simctl printed on CI", TIMED_OUT],
    ["only its error code", "An error was encountered (domain=NSPOSIXErrorDomain, code=60):\n"],
    ["only its words", "Operation timed out\n"],
  ])("asks again after %s, a second later, and returns the answer", (_, stderr) => {
    const simctl = pbpaste(failure(stderr), answer("https://example.com/report"));
    expect(simctl.read()).toBe("https://example.com/report");
    expect(simctl.runs).toEqual([
      ["pbpaste", "booted"],
      ["pbpaste", "booted"],
    ]);
    expect(simctl.pauses).toEqual([1_000]);
  });

  it("fails with the last attempt's error, naming the command, when every attempt times out", () => {
    const simctl = pbpaste(
      failure(`${TIMED_OUT}first`),
      failure(`${TIMED_OUT}second`),
      failure(`${TIMED_OUT}third`),
    );
    expect(simctl.read).toThrow(new Error(`simctl pbpaste booted: ${TIMED_OUT}third`));
  });

  it("fails at once on any other error, with no second attempt", () => {
    const simctl = pbpaste(failure("No devices are booted.\n"), answer("never read"));
    expect(simctl.read).toThrow(new Error("simctl pbpaste booted: No devices are booted.\n"));
    expect(simctl.runs).toHaveLength(1);
    expect(simctl.pauses).toEqual([]);
  });

  it("stops after three attempts, even when a fourth would answer", () => {
    const simctl = pbpaste(
      failure(TIMED_OUT),
      failure(TIMED_OUT),
      failure(TIMED_OUT),
      answer("too late"),
    );
    expect(simctl.read).toThrow(/^simctl pbpaste booted: /);
    expect(simctl.runs).toHaveLength(3);
    expect(simctl.pauses).toEqual([1_000, 1_000]);
  });
});
