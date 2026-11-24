// The standalone update check's step log (#207): a held step plays a slow
// PowerShell run after the last byte, and a set clock gives exact times.
import type { DesktopUpdateState } from "@clawtrate/core";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { tempDir } from "./harness.ts";
import { readSteps, stepLog } from "./screen-test-steps.ts";

let dir: ReturnType<typeof tempDir>;
let clock: number;
beforeEach(() => {
  dir = tempDir();
  clock = 0;
});
afterEach(() => dir.remove());

const log = () => stepLog(dir.path, () => clock);
const downloading = (received: number, step?: "moving" | "verifying"): DesktopUpdateState => ({
  kind: "downloading",
  version: "1.1.0",
  received,
  expected: 4_000_000,
  ...(step && { step }),
});

/** Starts `step` now and returns a function that ends it at `at` with `value`. */
function held<T>(steps: ReturnType<typeof log>, step: string, outcome: (value: T) => string) {
  const work = Promise.withResolvers<T>();
  const timed = steps.time(step, () => work.promise, outcome);
  return async (at: number, value: T) => {
    clock = at;
    work.resolve(value);
    return timed;
  };
}

/** A Windows download that has made its folders and stopped in its second read-back. */
async function stalledDownload(steps: ReturnType<typeof log>) {
  clock = 1_000;
  steps.state({ kind: "offered", version: "1.1.0", releaseDate: "", offerId: "o" });
  clock = 2_000;
  steps.state(downloading(0));
  await held(steps, "folders", () => "made")(4_500, undefined);
  clock = 4_600;
  steps.state(downloading(1_048_576));
  clock = 5_000;
  steps.state(downloading(4_000_000, "moving"));
  clock = 5_002;
  steps.state(downloading(4_000_000, "verifying"));
  await held(steps, "read-back", () => "read")(7_900, undefined);
  clock = 7_905;
  return held(steps, "read-back", () => "read");
}

it("names the step a download stopped in after its last byte, and how long it has run", async () => {
  const steps = log();
  await stalledDownload(steps);
  expect(readSteps(dir.path, () => 10_000)).toEqual([
    { state: "downloading", atMs: 0, ms: 3_000 },
    { step: "folders", atMs: 0, ms: 2_500, outcome: "made" },
    { state: "moving", atMs: 3_000, ms: 2 },
    { state: "verifying", atMs: 3_002, ms: 4_998, current: true },
    { step: "read-back", atMs: 3_002, ms: 2_898, outcome: "read" },
    { step: "read-back", atMs: 5_905, ms: 2_095, running: true },
  ]);
});

it("reads the clock after the log, so a row the app writes meanwhile never runs backwards", async () => {
  const steps = log();
  await stalledDownload(steps);
  // The app writes its next state 5 ms after the reader's clock reading.
  const movingOn = (at: number) => () => {
    clock = at + 5;
    steps.state({ kind: "verified", offerId: "o", version: "1.1.0", size: 4_000_000 });
    return at;
  };
  const rows = readSteps(dir.path, movingOn(10_000));
  expect(rows?.map((row) => row.ms)).toEqual([3_000, 2_500, 2, 4_998, 2_898, 2_095]);
});

it("writes one row per state change rather than one per downloaded chunk", () => {
  const steps = log();
  steps.state(downloading(0));
  steps.state(downloading(1_000));
  steps.state(downloading(4_000_000, "moving"));
  steps.state(downloading(4_000_000, "moving"));
  steps.state({ kind: "checking" });
  steps.state(downloading(0));
  const rows = readFileSync(join(dir.path, "update-steps.jsonl"), "utf8").trim().split("\n");
  expect(rows.map((row) => JSON.parse(row).state)).toEqual([
    "downloading",
    "moving",
    "checking",
    "downloading",
  ]);
});

it("ends every step of a download that completes, and passes each step's result on", async () => {
  const steps = log();
  const readBack = await stalledDownload(steps);
  expect(await readBack(10_500, { sha512: "kept" })).toEqual({ sha512: "kept" });
  const inspect = held(steps, "installer-inspect", (reason: string | null) => reason ?? "accepted");
  expect(await inspect(10_600, null)).toBeNull();
  steps.state({ kind: "verified", offerId: "o", version: "1.1.0", size: 4_000_000 });
  expect(readSteps(dir.path, () => 11_000)).toEqual([
    { state: "downloading", atMs: 0, ms: 3_000 },
    { step: "folders", atMs: 0, ms: 2_500, outcome: "made" },
    { state: "moving", atMs: 3_000, ms: 2 },
    { state: "verifying", atMs: 3_002, ms: 5_598 },
    { step: "read-back", atMs: 3_002, ms: 2_898, outcome: "read" },
    { step: "read-back", atMs: 5_905, ms: 2_595, outcome: "read" },
    { step: "installer-inspect", atMs: 8_500, ms: 100, outcome: "accepted" },
    { state: "verified", atMs: 8_600, ms: 400, current: true },
  ]);
});

it("keeps only the last check or download, and an error's code, never its message", async () => {
  const steps = log();
  await stalledDownload(steps);
  clock = 20_000;
  steps.state({ kind: "checking" });
  clock = 20_100;
  steps.state(downloading(0));
  const refused = Object.assign(new Error("D:\\profile\\updates\\offer refused"), {
    code: "EPERM",
  });
  const folders = steps.time(
    "folders",
    () => Promise.reject(refused),
    () => "made",
  );
  await expect(folders).rejects.toBe(refused);
  clock = 20_300;
  steps.state({ kind: "failed", stage: "download", reason: "write-failed" });
  expect(readSteps(dir.path, () => 20_400)).toEqual([
    { state: "downloading", atMs: 0, ms: 200 },
    { step: "folders", atMs: 0, ms: 0, outcome: "threw EPERM" },
    { state: "failed write-failed", atMs: 200, ms: 100, current: true },
  ]);
  expect(readFileSync(join(dir.path, "update-steps.jsonl"), "utf8")).not.toContain("profile");
});

it("keeps unknown error codes, signals and outcomes out of the timing log", async () => {
  const steps = log();
  const detail = "fixture-private-value";
  for (const error of [{ code: detail }, { signal: detail }]) {
    await expect(
      steps.time(
        "folders",
        () => Promise.reject(error),
        () => "made",
      ),
    ).rejects.toBe(error);
  }
  const value = await steps.time(
    "installer-inspect",
    async () => detail,
    (result) => result,
  );
  expect(value).toBe(detail);
  expect(readFileSync(join(dir.path, "update-steps.jsonl"), "utf8")).not.toContain(detail);
  expect(readSteps(dir.path)?.map((row) => row.outcome)).toEqual([
    "threw an error",
    "threw an error",
    "other",
  ]);
});

it("never fails the step it times, and leaves out a line still being written", async () => {
  const missing = stepLog(join(dir.path, "missing"), () => clock);
  expect(
    await missing.time(
      "read-back",
      async () => "proof",
      () => "read",
    ),
  ).toBe("proof");
  expect(readSteps(join(dir.path, "missing"))).toBeNull();

  const file = join(dir.path, "update-steps.jsonl");
  writeFileSync(file, JSON.stringify({ at: 0, state: "verifying" }) + "\n");
  appendFileSync(file, '{"at":5,"st');
  expect(readSteps(dir.path, () => 10)).toEqual([
    { state: "verifying", atMs: 0, ms: 10, current: true },
  ]);
});
