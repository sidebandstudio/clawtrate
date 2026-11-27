import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { captureHostState } from "./host-state.ts";
import { timeStep } from "./screen-test-steps.ts";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A profile with a read-back still under way, and a failed test writing beside its results. */
function failedTest() {
  const profile = mkdtempSync(join(tmpdir(), "clawtrate-host-state-"));
  dirs.push(profile);
  const work = Promise.withResolvers<boolean>();
  const readBack = timeStep(
    profile,
    "read-back",
    () => work.promise,
    (proof) => (proof ? "read" : "wrong size"),
  );
  const annotations: { type: string; description?: string }[] = [
    { type: "focus after Enter", description: "div[role=group] Update status" },
  ];
  const test = {
    outputDir: join(profile, "results"),
    annotations,
    attach: vi.fn(async () => {}),
  };
  const written = () => JSON.parse(readFileSync(join(test.outputDir, "host-state.json"), "utf8"));
  return { profile, test, written, endReadBack: () => (work.resolve(true), readBack) };
}

const steps = [{ step: "read-back", at: expect.any(String), endUnknown: true }];
/** Each printed line's label and what it printed. */
const printed = (log: { mock: { calls: unknown[][] } }): [unknown, unknown][] =>
  log.mock.calls.map(([label, line]) => [label, JSON.parse(String(line))]);

it("prints and keeps what it first saw, whatever changes while the host answers", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const { profile, test, written, endReadBack } = failedTest();
  const requests = ["/stable", "/whats-new.json", "/file.exe"];
  const rendererRequests: string[] = [];
  const host = Promise.withResolvers<unknown>();
  const ask = vi.fn(() => host.promise);
  const first = captureHostState(test, profile, requests, rendererRequests, ask, 60_000);
  // Printed and on disk before Electron is asked, in case the test runs out of time meanwhile.
  expect(ask).not.toHaveBeenCalled();
  const seen = ["/stable", "/whats-new.json", "/file.exe"];
  expect(printed(log)).toEqual([["Update steps at failure", { steps, requests: seen }]]);
  const pending = written();
  expect(pending).toEqual({
    reading: "pending",
    capturedAt: expect.any(String),
    steps,
    requests: seen,
    rendererRequests: [],
    notes: [{ type: "focus after Enter", description: "div[role=group] Update status" }],
  });

  await endReadBack();
  requests.push("/file.exe");
  rendererRequests.push("https://example.invalid/");
  test.annotations[0]!.description = "changed";
  test.annotations.push({ type: "later" });
  // The test timed out while the host was asked: its afterEach captures again.
  const later = vi.fn(async () => ({}));
  const second = captureHostState(test, profile, requests, rendererRequests, later, 60_000);
  const answer = {
    revision: 2,
    state: { kind: "downloading", step: "verifying" },
    preferenceIssue: null,
  };
  host.resolve(answer);
  await Promise.all([first, second]);

  expect(ask).toHaveBeenCalledTimes(1);
  expect(later).not.toHaveBeenCalled();
  expect(test.attach).toHaveBeenCalledTimes(1);
  expect(written()).toEqual({ ...pending, reading: answer });
  expect(printed(log)).toEqual([
    ["Update steps at failure", { steps, requests: seen }],
    ["Update status at failure", { requests: seen, state: answer.state, preferenceIssue: null }],
  ]);
});

it("keeps what it first saw when the host never answers or fails, with no error text", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const silent = failedTest();
  await captureHostState(silent.test, silent.profile, [], [], () => new Promise(() => {}), 20);
  await silent.endReadBack();
  expect(silent.written()).toMatchObject({ reading: null, steps });

  const closed = failedTest();
  await captureHostState(closed.test, closed.profile, [], [], () =>
    Promise.reject(new Error("page.evaluate: Target page, context or browser has been closed")),
  );
  expect(closed.written()).toMatchObject({ reading: { error: "page closed" }, steps });

  const failed = failedTest();
  await captureHostState(failed.test, failed.profile, [], [], () =>
    Promise.reject(new Error("C:\\Users\\someone\\profile")),
  );
  expect(failed.written()).toMatchObject({ reading: { error: "host read failed" }, steps });
  expect(JSON.stringify(failed.written())).not.toContain("someone");
  expect(printed(log).filter(([label]) => label === "Update status at failure")).toEqual([
    ["Update status at failure", { requests: [], reading: null }],
    ["Update status at failure", { requests: [], reading: { error: "page closed" } }],
    ["Update status at failure", { requests: [], reading: { error: "host read failed" } }],
  ]);
  expect(JSON.stringify(log.mock.calls)).not.toContain("someone");
});
