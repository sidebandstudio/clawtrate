// The real update check's decisions (e2e-packaged/real-update/verdict.ts) and its summary job
// (summary.ts). The check itself runs only on GitHub-hosted Macs.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  offerVerdict,
  remaining,
  summarize,
  summaryMarkdown,
  withinLimit,
} from "../e2e-packaged/real-update/verdict.ts";

const system = "ProductName:\tmacOS\nProductVersion:\t26.7.2\n";
const passed = {
  verdict: "passed",
  outcome: "updated in place",
  system,
  offeredVersion: "0.1.1-beta.20261123.7",
  installedVersion: "0.1.1-beta.20261123.7",
  downloaded: { install: { kind: "restart-available", offerId: "x" } },
} as const;
const inconclusive = {
  verdict: "inconclusive",
  outcome: "not this candidate: offered 0.1.1-beta.20261123.7, expected 0.1.1-beta.20261123.6",
  system,
  offeredVersion: "0.1.1-beta.20261123.7",
} as const;
const failed = {
  verdict: "failed",
  outcome: "not offered a restart: inspection-failed",
  system,
  offeredVersion: "0.1.1-beta.20261123.7",
  downloaded: { install: { kind: "unavailable-in-this-build", reason: "inspection-failed" } },
} as const;

it.each([
  ["the expected version", "1.2.0", "1.2.0", { verdict: "proceed" }],
  ["any version when none is expected", "1.2.0", undefined, { verdict: "proceed" }],
  [
    "a newer version than expected (published mid-run)",
    "1.3.0",
    "1.2.0",
    { verdict: "inconclusive", reason: "offered 1.3.0, expected 1.2.0" },
  ],
  [
    "a newer version than an explicit candidate the feed has moved past",
    "1.3.0",
    "1.1.0",
    { verdict: "inconclusive", reason: "offered 1.3.0, expected 1.1.0" },
  ],
  [
    "a later run of the same day (numeric, not text, order)",
    "0.1.1-beta.20261123.11",
    "0.1.1-beta.20261123.7",
    {
      verdict: "inconclusive",
      reason: "offered 0.1.1-beta.20261123.11, expected 0.1.1-beta.20261123.7",
    },
  ],
  [
    "the stable release after its betas",
    "0.1.1",
    "0.1.1-beta.20261123.7",
    { verdict: "inconclusive", reason: "offered 0.1.1, expected 0.1.1-beta.20261123.7" },
  ],
  [
    "an older version than expected (an explicit candidate the feed never reached)",
    "1.1.0",
    "1.2.0",
    { verdict: "failed", reason: "offered 1.1.0, expected 1.2.0" },
  ],
  [
    "the version already installed",
    "0.1.1-beta.20261123.6",
    "0.1.1-beta.20261123.7",
    { verdict: "failed", reason: "offered 0.1.1-beta.20261123.6, expected 0.1.1-beta.20261123.7" },
  ],
  ["an empty version", "", "1.2.0", { verdict: "failed", reason: "offered , expected 1.2.0" }],
  [
    "no version",
    undefined,
    "1.2.0",
    { verdict: "failed", reason: "offered undefined, expected 1.2.0" },
  ],
  [
    "no version when none is expected",
    undefined,
    undefined,
    { verdict: "failed", reason: "offered undefined, expected a version" },
  ],
  [
    "a malformed version",
    "1.3.0 ",
    "1.2.0",
    { verdict: "failed", reason: "offered 1.3.0 , expected 1.2.0" },
  ],
] as const)("an offer of %s", (_, offered, expected, verdict) => {
  expect(offerVerdict(offered, expected)).toEqual(verdict);
});

it("counts the time left to a deadline, never below zero", () => {
  expect(remaining(10_000, 4_000)).toBe(6_000);
  expect(remaining(10_000, 12_000)).toBe(0);
});

it("a call within its limit settles with its answer, and one past it is abandoned", async () => {
  expect(await withinLimit("a quick call", 1_000, Promise.resolve(42))).toBe(42);
  let abandoned = false;
  await expect(
    withinLimit("a call with no answer", 20, new Promise(() => {}), () => (abandoned = true)),
  ).rejects.toThrow("no answer within 20 ms to a call with no answer");
  expect(abandoned).toBe(true);
});

it("a failure anywhere fails the run; an inconclusive image makes it inconclusive, not failed", () => {
  const all = (each: object | null) => ({
    "macos-15": passed,
    "macos-26": passed,
    "xcode-27": each,
  });
  expect(summarize("a", "b", all(passed))).toMatchObject({ verdict: "passed", passed: true });
  expect(summarize("a", "b", all(inconclusive))).toMatchObject({
    verdict: "inconclusive",
    passed: false,
  });
  expect(summarize("a", "b", all(failed))).toMatchObject({ verdict: "failed", passed: false });
  expect(
    summarize("a", "b", { "macos-15": inconclusive, "macos-26": failed, "xcode-27": passed })
      .verdict,
  ).toBe("failed");
  // An image with no result, or one from before verdicts, failed.
  expect(summarize("a", "b", all(null)).images["xcode-27"]).toMatchObject({
    verdict: "failed",
    outcome: "no result",
  });
  expect(summarize("a", "b", all({ outcome: "updated in place" })).verdict).toBe("failed");
  expect(summarize("a", "b", {}).verdict).toBe("failed");
});

it("summarizes each image apart, with its macOS version, offer and install", () => {
  const summary = summarize("0.1.1-beta.20261123.6", "0.1.1-beta.20261123.6", {
    "macos-15": failed,
    "xcode-27": inconclusive,
  });
  expect(summary).toEqual({
    previous: "0.1.1-beta.20261123.6",
    candidate: "0.1.1-beta.20261123.6",
    verdict: "failed",
    passed: false,
    images: {
      "macos-15": {
        verdict: "failed",
        passed: false,
        outcome: "not offered a restart: inspection-failed",
        system: "26.7.2",
        offered: "0.1.1-beta.20261123.7",
        installed: null,
        install: { kind: "unavailable-in-this-build", reason: "inspection-failed" },
      },
      "xcode-27": {
        verdict: "inconclusive",
        passed: false,
        outcome:
          "not this candidate: offered 0.1.1-beta.20261123.7, expected 0.1.1-beta.20261123.6",
        system: "26.7.2",
        offered: "0.1.1-beta.20261123.7",
        installed: null,
        install: {},
      },
    },
  });
  expect(summaryMarkdown(summary)).toBe(
    [
      "Real update 0.1.1-beta.20261123.6 to 0.1.1-beta.20261123.6: FAILED",
      "",
      "- macos-15 (26.7.2): failed, not offered a restart: inspection-failed",
      "- xcode-27 (26.7.2): inconclusive, not this candidate: offered 0.1.1-beta.20261123.7, expected 0.1.1-beta.20261123.6",
      "",
    ].join("\n"),
  );
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it.each([
  ["passed", 0, passed],
  ["inconclusive", 0, inconclusive],
  ["failed", 1, failed],
] as const)("the summary job exits %s with %i", (verdict, status, result) => {
  const dir = mkdtempSync(join(tmpdir(), "clawtrate-real-update-summary-"));
  dirs.push(dir);
  for (const [image, each] of [
    ["macos-15", passed],
    ["macos-26", result],
  ] as const) {
    mkdirSync(join(dir, "results", `real-update-${image}`), { recursive: true });
    writeFileSync(
      join(dir, "results", `real-update-${image}`, "result.json"),
      JSON.stringify(each),
    );
  }
  const ran = spawnSync(
    process.execPath,
    [
      resolve(import.meta.dirname, "../e2e-packaged/real-update/summary.ts"),
      "results",
      "macos-15",
      "macos-26",
    ],
    {
      cwd: dir,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        PREVIOUS: "1.0.0",
        CANDIDATE: "1.1.0",
        GITHUB_STEP_SUMMARY: join(dir, "step-summary.md"),
      },
    },
  );
  expect(ran.status, ran.stderr).toBe(status);
  const summary = JSON.parse(readFileSync(join(dir, "real-update-summary.json"), "utf8"));
  expect(summary).toMatchObject({ previous: "1.0.0", candidate: "1.1.0", verdict });
  // A green run that isn't a pass says so on the run's page.
  expect(ran.stdout.includes("::warning title=Real update inconclusive::")).toBe(
    verdict === "inconclusive",
  );
  expect(readFileSync(join(dir, "step-summary.md"), "utf8")).toContain(
    `Real update 1.0.0 to 1.1.0: ${verdict === "failed" ? "FAILED" : verdict}`,
  );
});
