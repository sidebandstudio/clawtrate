// The iPhone checks' reads through simctl (#1039). On a loaded runner CoreSimulator can time out
// before it answers, which says nothing about the app, so a read is asked again. The Simulator
// checks meet a timeout only by chance, so the rule's cases are proven here with a stand-in for
// `xcrun simctl`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { appLog, simctlRead, type SimctlResult } from "../simulator/harness.ts";

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
    [
      "NSPOSIXErrorDomain code 60 with no words",
      "An error was encountered (domain=NSPOSIXErrorDomain, code=60):\n",
    ],
    ["the words alone, when simctl names no domain or code", "Operation timed out\n"],
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

  it("fails at once when the timeout's words are only in the partial output, beside another error", () => {
    const simctl = pbpaste(
      { status: 1, stdout: "Operation timed out\n", stderr: "No devices are booted.\n" },
      answer("never read"),
    );
    expect(simctl.read).toThrow(new Error("simctl pbpaste booted: No devices are booted.\n"));
    expect(simctl.runs).toHaveLength(1);
    expect(simctl.pauses).toEqual([]);
  });

  it.each([
    [
      "another code",
      "An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=61):\n" +
        "Operation timed out\n",
    ],
    [
      "another domain",
      "An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=60):\n" +
        "Operation timed out\n",
    ],
    [
      "an underlying error of another kind",
      `${TIMED_OUT}Underlying error (domain=com.apple.CoreSimulator.SimError, code=405):\n` +
        "Unable to lookup in current state: Shutdown\n",
    ],
  ])("fails at once when the timeout's words come with %s", (_, stderr) => {
    const simctl = pbpaste(failure(stderr), answer("never read"));
    expect(simctl.read).toThrow(new Error(`simctl pbpaste booted: ${stderr}`));
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

describe("appLog", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reads from the same start on every attempt, far enough back to hold the time asked for", () => {
    vi.stubEnv("CLAWTRATE_IOS_DEVICE", "booted");
    // 45 seconds before 12:00:00.250 UTC is 11:59:15.250, so the window opens at 11:59:15.
    let clock = Date.UTC(2026, 10, 28, 12, 0, 0, 250);
    const results = [failure(TIMED_OUT), failure(TIMED_OUT), answer("the app's lines\n")];
    const runs: string[][] = [];
    const log = appLog(
      45,
      (args) => {
        runs.push(args);
        // Each `log show` takes time of its own, and so does each pause after one.
        clock += 20_000;
        return results[runs.length - 1]!;
      },
      (ms) => {
        clock += ms;
      },
      () => clock,
    );
    expect(log).toBe("the app's lines\n");
    expect(runs).toHaveLength(3);
    expect(runs.map((args) => args[args.indexOf("--start") + 1])).toEqual([
      "2026-11-28 11:59:15+0000",
      "2026-11-28 11:59:15+0000",
      "2026-11-28 11:59:15+0000",
    ]);
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
  });
});
