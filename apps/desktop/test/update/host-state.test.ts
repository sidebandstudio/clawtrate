// What the standalone update check prints and attaches when a test fails (#207):
// one reading, taken before asking the host, which can take seconds or never answer.
import type { DesktopUpdateSnapshot } from "@clawtrate/core";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { tempDir } from "./harness.ts";
import { hostStateAtFailure, statusLine } from "./host-state.ts";
import { stepLog } from "./screen-test-steps.ts";

let dir: ReturnType<typeof tempDir>;
beforeEach(() => (dir = tempDir()));
afterEach(() => dir.remove());

const snapshot: DesktopUpdateSnapshot = {
  revision: 7,
  runningVersion: "0.1.0",
  runningTrack: "stable",
  tracks: [],
  selectedTrack: "stable",
  pendingTrack: null,
  lastCheck: null,
  preferenceIssue: null,
  state: { kind: "verified", offerId: "o", version: "1.1.0", size: 4_000_000 },
  install: { kind: "unavailable-in-this-build", reason: "build-not-signed" },
  lastAttempt: null,
};

/** A failed test's results folder, and what was attached to it. */
function failedTest(outputDir = join(dir.path, "results")) {
  const attached: string[] = [];
  return {
    attached,
    outputDir,
    annotations: [{ type: "note", description: "fixture note" }],
    attach: async (name: string) => void attached.push(name),
  };
}
const written = (test: { outputDir: string }) =>
  JSON.parse(readFileSync(join(test.outputDir, "host-state.json"), "utf8")) as unknown;

it("reads the step log before asking the host, and prints and attaches that one reading", async () => {
  let clock = 1_000;
  const steps = stepLog(dir.path, () => clock);
  steps.state({ kind: "checking" });
  steps.state({
    kind: "downloading",
    version: "1.1.0",
    received: 4_000_000,
    expected: 4_000_000,
    step: "verifying",
  });
  clock = 1_005;
  const work = Promise.withResolvers<void>();
  const readBack = steps.time(
    "read-back",
    () => work.promise,
    () => "read",
  );
  const requests = ["/stable", "/file.exe"];
  const host = Promise.withResolvers<DesktopUpdateSnapshot>();
  let asked = 0;
  const test = failedTest();
  const capture = hostStateAtFailure(test, dir.path, requests, ["/renderer-request"], () => {
    asked++;
    return host.promise;
  });

  const taken = capture();
  // While the host is asked, the stalled read-back ends and the app moves on.
  clock = 9_000;
  work.resolve();
  await readBack;
  steps.state(snapshot.state);
  requests.push("/stable");
  host.resolve(snapshot);
  const state = await taken;

  const atFailure = [
    { state: "checking", atMs: 0, ms: 0 },
    { state: "verifying", atMs: 0, ms: expect.any(Number), current: true },
    { step: "read-back", atMs: 5, ms: expect.any(Number), running: true },
  ];
  expect(state).toEqual({
    reading: snapshot,
    steps: atFailure,
    requests: ["/stable", "/file.exe"],
    rendererRequests: ["/renderer-request"],
  });
  expect(written(test)).toEqual({ ...state, notes: test.annotations });
  expect(test.attached).toEqual(["host-state"]);

  // The console's line, later, from the same reading and in the same shape as before.
  expect(capture()).toBe(taken);
  const line = JSON.parse(statusLine(await capture())) as Record<string, unknown>;
  expect(Object.keys(line)).toEqual(["requests", "state", "preferenceIssue", "steps"]);
  expect(line).toEqual({
    requests: ["/stable", "/file.exe"],
    state: snapshot.state,
    preferenceIssue: null,
    steps: state.steps,
  });
  expect(asked).toBe(1);
  expect(test.attached).toEqual(["host-state"]);
});

it("stops waiting for a host that never answers, and keeps what it read without a step log", async () => {
  const test = failedTest();
  const capture = hostStateAtFailure(
    test,
    dir.path,
    ["/stable"],
    [],
    () => new Promise(() => {}),
    0,
  );
  const state = await capture();
  expect(state).toEqual({
    reading: null,
    steps: null,
    requests: ["/stable"],
    rendererRequests: [],
  });
  expect(written(test)).toEqual({ ...state, notes: test.annotations });
  expect(JSON.parse(statusLine(state))).toEqual({
    requests: ["/stable"],
    reading: null,
    steps: null,
  });
});

it.each([
  ["page.evaluate: Target page, context or browser has been closed", "page closed"],
  ["Unexpected host read failure", "host read failed"],
])("F-231: keeps local paths out of both outputs for %s", async (message, reason) => {
  const test = failedTest();
  const error = new Error(`${message}\nD:\\fixture-private-path\\updates`);
  const capture = hostStateAtFailure(test, dir.path, [], [], async () => {
    throw error;
  });
  const state = await capture();
  const line = statusLine(state);
  const attachment = written(test);
  expect(JSON.parse(line).reading).toEqual({ error: reason });
  expect(attachment).toMatchObject({ reading: { error: reason } });
  expect(line).not.toContain("fixture-private-path");
  expect(JSON.stringify(attachment)).not.toContain("fixture-private-path");
});

it("resolves when the results folder can't be written", async () => {
  const blocked = join(dir.path, "a-file");
  writeFileSync(blocked, "");
  const test = failedTest(join(blocked, "results"));
  const closed = new Error("Target page, context or browser has been closed");
  const capture = hostStateAtFailure(test, dir.path, [], [], () => Promise.reject(closed));
  const state = await capture();
  expect(state.reading).toEqual({ error: "page closed" });
  expect(test.attached).toEqual([]);
  expect(JSON.parse(statusLine(state))).toEqual({
    requests: [],
    reading: { error: "page closed" },
    steps: null,
  });
});
