// What a failed taskbar overlay check keeps (#448). CI uploads test-results/,
// which held only Playwright's error context: the check's own report was a
// body-only attachment, which the list reporter writes nowhere.
import type { FullConfig, TestInfo } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type * as ChildProcesses from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type * as Fs from "node:fs";
import { tmpdir } from "node:os";
import type * as Os from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { debuggingPort } from "../e2e-packaged/desktop-driver.ts";
import globalSetup, {
  CHECKOUT,
  exitedWithin,
  launchArgs,
  recordExit,
  reportExit,
} from "../e2e-packaged/global-setup.ts";
import {
  OVERLAY_REPORT,
  TEARDOWN_EXIT,
  exitOf,
  keepOverlayReport,
  overlayEvidence,
  overlayReport,
  recordTeardownExit,
  reportedExit,
  type OverlayStep,
} from "../e2e-packaged/overlay-diagnostics.ts";
import {
  askToClose,
  windowsProcesses,
  type OverlayRead,
  type WindowsProcess,
} from "../e2e-packaged/windows.ts";

// Stand-ins for the Windows run's app, its process list, its close request,
// its debugging port and its temporary folder, and for a write that fails;
// every other call is the real one.
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof ChildProcesses>();
  return { ...real, spawn: vi.fn(real.spawn) };
});
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof Fs>();
  return { ...real, writeFileSync: vi.fn(real.writeFileSync) };
});
vi.mock("node:os", async (importOriginal) => {
  const real = await importOriginal<typeof Os>();
  return { ...real, tmpdir: vi.fn(real.tmpdir) };
});
vi.mock(import("../e2e-packaged/windows.ts"), async (actual) => ({
  ...(await actual()),
  askToClose: vi.fn(),
  forceEnd: vi.fn(),
  windowsProcesses: vi.fn(),
}));
vi.mock(import("../e2e-packaged/desktop-driver.ts"), async (actual) => ({
  ...(await actual()),
  debuggingPort: vi.fn(async () => 1),
}));
const realChildProcess = await vi.importActual<typeof ChildProcesses>("node:child_process");
const realFs = await vi.importActual<typeof Fs>("node:fs");
const realOs = await vi.importActual<typeof Os>("node:os");

const ROOT = join(import.meta.dirname, "..");
const AT = "2026-11-25T00:00:00.000Z";

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(writeFileSync).mockImplementation(realFs.writeFileSync);
});

/** Folders this file made with mkdtemp, by real path, with where each was made: the only ones it removes. */
const owned = new Map<string, { parent: string; prefix: string }>();

/** A new folder of this test's own, made with mkdtemp under the system's temporary folder or `parent`. */
function ownedTemp(prefix: string, parent = realOs.tmpdir()): string {
  const dir = realpathSync.native(mkdtempSync(join(parent, prefix)));
  owned.set(dir, { parent: realpathSync.native(parent), prefix });
  return dir;
}

/**
 * Removes a folder `ownedTemp` made, and only while its real path is still
 * that folder, directly in the parent it was made in: never a path from the
 * environment, and never anything a link inside would lead to.
 */
function removeOwned(dir: string): void {
  const made = owned.get(dir);
  if (!made) throw new Error("refusing to remove a folder this test did not make");
  if (existsSync(dir)) {
    const real = realpathSync.native(dir);
    if (real !== dir || dirname(real) !== made.parent || !basename(real).startsWith(made.prefix))
      throw new Error("refusing to remove a folder that no longer resolves where it was made");
    rmSync(real, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  owned.delete(dir);
}

/**
 * Whether a variable is one of the launch check's CLAWTRATE_PACKAGED_ ones,
 * in any case: Windows takes keys that differ only in case for one variable,
 * and keeps the spelling it was first set with.
 */
const isPackaged = (key: string) => key.toUpperCase().startsWith("CLAWTRATE_PACKAGED_");

/** The CLAWTRATE_PACKAGED_ variables as they are now. */
function packagedEnv(): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => isPackaged(key)));
}

/** Puts the CLAWTRATE_PACKAGED_ variables back as `saved` had them, and no others. */
function restorePackagedEnv(saved: Record<string, string | undefined>): void {
  for (const key of Object.keys(process.env)) if (isPackaged(key)) delete process.env[key];
  Object.assign(process.env, saved);
}

/** The nested runner's environment: none of this process's CLAWTRATE_PACKAGED_ variables, only `exitFile`. */
function runnerEnv(exitFile: string): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST") && !isPackaged(key)),
    ),
    CLAWTRATE_PACKAGED_EXIT: exitFile,
    FORCE_COLOR: "0",
  };
}

/** Ends a child this test started, by its handle, and waits until Node has reaped it. */
async function reap(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await exited;
}

/** A synthetic filesystem error, as Node throws one, naming a path no warning may print. */
function fakeError(code: string) {
  const path = `C:\\fake-${randomBytes(6).toString("hex")}\\secret.json`;
  return {
    path,
    error: Object.assign(new Error(`${code}: failed, open '${path}'`), { code, path }),
  };
}

/** Makes every write to a file named `name` throw `error`. */
function failWrites(name: string, error: Error): void {
  vi.mocked(writeFileSync).mockImplementation((file, ...rest) => {
    if (String(file).endsWith(name)) throw error;
    return realFs.writeFileSync(file, ...rest);
  });
}

/** A step as the check records it. */
function step(
  phase: OverlayStep["phase"],
  expected: string,
  started: number,
  reads: OverlayRead[],
) {
  return { phase, expected, started, badgeCallReturned: true, reads };
}

describe("the taskbar overlay report", () => {
  it("tells each kind of read apart, the app's own text whole and any other by its length", () => {
    const other = "Another window, C:\\Users\\someone";
    const reads: OverlayRead[] = [
      { at: AT, ms: 5_003, error: "timed out" },
      { at: AT, ms: 900, error: "failed with exit 1" },
      { at: AT, ms: 800, error: "no output" },
      { at: AT, ms: 700, value: null },
      { at: AT, ms: 650, value: "" },
      { at: AT, ms: 640, value: "2 unread" },
      { at: AT, ms: 630, value: other },
      { at: AT, ms: 620, value: "3 unread" },
    ];
    expect(
      overlayReport([step("set", "3 unread", 1_000, reads)], "catch", "not reported", 16_000),
    ).toEqual({
      endedIn: "set",
      phases: [
        {
          phase: "set",
          expected: "3 unread",
          ms: 15_000,
          badgeCallReturned: true,
          outcomes: {
            "timed out": 1,
            "failed with exit 1": 1,
            "no output": 1,
            "no button": 1,
            empty: 1,
            "other text": 2,
            expected: 1,
          },
          lastReads: [
            { at: AT, ms: 5_003, outcome: "timed out" },
            { at: AT, ms: 900, outcome: "failed with exit 1" },
            { at: AT, ms: 800, outcome: "no output" },
            { at: AT, ms: 700, outcome: "no button" },
            { at: AT, ms: 650, outcome: "empty" },
            { at: AT, ms: 640, outcome: "other text", text: "2 unread" },
            { at: AT, ms: 630, outcome: "other text", length: other.length },
            { at: AT, ms: 620, outcome: "expected" },
          ],
        },
      ],
      keptBy: "catch",
      appExitAtFailure: "not reported",
    });
  });

  it("keeps the set phase that passed beside a clear phase that failed before any read", () => {
    const reads: OverlayRead[] = Array.from({ length: 12 }, (_, index) => ({
      at: AT,
      ms: index,
      value: index < 11 ? "2 unread" : "3 unread",
    }));
    const clear = { ...step("clear", "", 4_000, []), badgeCallReturned: false };
    const report = overlayReport(
      [step("set", "3 unread", 1_000, reads), clear],
      "catch",
      "unavailable",
      5_000,
    );
    expect(report.endedIn).toBe("clear");
    expect(
      report.phases.map(({ phase, ms, badgeCallReturned, outcomes }) => ({
        phase,
        ms,
        badgeCallReturned,
        outcomes,
      })),
    ).toEqual([
      {
        phase: "set",
        ms: 3_000,
        badgeCallReturned: true,
        outcomes: { "other text": 11, expected: 1 },
      },
      { phase: "clear", ms: 1_000, badgeCallReturned: false, outcomes: {} },
    ]);
    expect(report.phases[0]!.lastReads.map(({ ms }) => ms)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    expect(report.phases[1]!.lastReads).toEqual([]);
  });

  it("gives the exit the runner reported by the failure, says when none was, and says when its record can't be read", async () => {
    const dir = ownedTemp("clawtrate-overlay-exit-");
    try {
      const file = join(dir, "app-exit.json");
      expect(reportedExit(file), "none written yet").toBe("not reported");
      expect(reportedExit(""), "no exit file named").toBe("unavailable");
      for (const text of [
        '{"code": 0, "sig',
        "",
        '{"code": "C:\\\\Users\\\\someone", "signal": null}',
        '{"code": null, "signal": null}',
        '{"code": null, "signal": "rm -rf"}',
        "[0]",
      ]) {
        writeFileSync(file, text);
        expect(reportedExit(file), text).toBe("unavailable");
      }
      rmSync(file);
      mkdirSync(file);
      expect(reportedExit(file), "a folder in its place").toBe("unavailable");
      rmSync(file, { recursive: true });
      const child = spawn(process.execPath, ["-e", "process.exit(3)"], { stdio: "ignore" });
      reportExit(child, file);
      await new Promise((resolve) => child.once("exit", resolve));
      expect(reportedExit(file)).toEqual({ code: 3, signal: null });
    } finally {
      removeOwned(dir);
    }
  });

  it("keeps the reads when the exit record is torn, and nothing of the record", async () => {
    const dir = ownedTemp("clawtrate-overlay-torn-");
    try {
      const exitFile = join(dir, "app-exit.json");
      writeFileSync(exitFile, '{"code": 0, "signal": "C:\\\\Users\\\\someone');
      const info = { outputPath: (name: string) => join(dir, name), attach: vi.fn(async () => {}) };
      const reads: OverlayRead[] = [{ at: AT, ms: 5_001, error: "timed out" }];
      await keepOverlayReport(
        info as unknown as TestInfo,
        [step("set", "3 unread", 0, reads)],
        "catch",
        exitFile,
      );
      const text = readFileSync(join(dir, OVERLAY_REPORT), "utf8");
      expect(JSON.parse(text)).toMatchObject({
        phases: [{ outcomes: { "timed out": 1 } }],
        appExitAtFailure: "unavailable",
      });
      expect(text).not.toMatch(/Users|app-exit|clawtrate-overlay-torn/);
    } finally {
      removeOwned(dir);
    }
  });

  it("warns that a report could not be kept by fixed words and an allowed error code, never the error's paths", async () => {
    const dir = ownedTemp("clawtrate-overlay-warning-");
    try {
      const info = { outputPath: (name: string) => join(dir, name), attach: vi.fn(async () => {}) };
      const printed = vi.spyOn(console, "error").mockImplementation(() => {});
      for (const [code, warning] of [
        ["EACCES", "the taskbar overlay report could not be kept (EACCES)"],
        ["C:\\fake-code", "the taskbar overlay report could not be kept"],
      ] as const) {
        const { path, error } = fakeError(code);
        failWrites(OVERLAY_REPORT, error);
        const overlay = overlayEvidence("");
        overlay.begin().push(step("set", "3 unread", 0, []));
        await expect(overlay.failed(info as unknown as TestInfo)).resolves.toBeUndefined();
        expect(printed).toHaveBeenLastCalledWith(warning);
        expect(JSON.stringify(printed.mock.calls)).not.toContain(path);
      }
    } finally {
      removeOwned(dir);
    }
  });

  it("writes the teardown's exit beside each report, asking for the last exit only then", async () => {
    const dir = ownedTemp("clawtrate-overlay-teardown-");
    try {
      const failed = join(dir, "launch-shows-unread-tasks");
      const other = join(dir, "launch-names-its-window");
      for (const folder of [join(failed, "attachments"), other])
        mkdirSync(folder, { recursive: true });
      writeFileSync(join(other, "error-context.md"), "");
      const exit = { beforeClose: "not reported", afterClose: { code: 0, signal: null } } as const;
      const last = vi.fn(async () => ({ code: 0, signal: null }));
      await recordTeardownExit([dir], exit, last);
      expect(last, "no report to write it beside").not.toHaveBeenCalled();
      writeFileSync(join(failed, OVERLAY_REPORT), "{}");
      writeFileSync(join(failed, "attachments", "taskbar-overlay-0123abcd.json"), "{}");
      await recordTeardownExit([dir, join(dir, "absent")], exit, last);
      expect(last).toHaveBeenCalledOnce();
      const written = readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.name === TEARDOWN_EXIT)
        .map((entry) => entry.parentPath);
      expect(written).toEqual([failed]);
      expect(JSON.parse(readFileSync(join(failed, TEARDOWN_EXIT), "utf8"))).toEqual({
        ...exit,
        lastReported: { code: 0, signal: null },
      });
    } finally {
      removeOwned(dir);
    }
  });

  it("is kept in the failed test's own output folder under the list reporter: at the failure, after a badge call that never returns, and never for a test that passed", async () => {
    // The launch check's own reporter, in a Playwright run of the overlay
    // check with stand-ins for the badge call and the taskbar read, while a
    // stand-in app keeps running.
    const packaged = (await import(join(ROOT, "playwright.packaged.config.ts"))).default as {
      reporter: unknown;
    };
    expect(packaged.reporter).toEqual([["list"]]);
    // Under the checkout, so the spec finds its packages; test-results/ is ignored by git.
    const results = join(ROOT, "test-results");
    mkdirSync(results, { recursive: true });
    const dir = ownedTemp("overlay-diagnostics-", results);
    let app: ChildProcess | undefined;
    try {
      app = recordExit(
        spawn(process.execPath, ["-e", "process.stdin.on('end', () => process.exit(0)).resume()"], {
          stdio: ["pipe", "ignore", "ignore"],
        }),
      );
      const exitFile = join(dir, "app-exit.json");
      reportExit(app, exitFile);
      writeFileSync(
        join(dir, "overlay.config.mjs"),
        `export default ${JSON.stringify({
          testDir: ".",
          testMatch: "overlay.spec.ts",
          outputDir: "out",
          reporter: packaged.reporter,
          workers: 1,
        })};\n`,
      );
      writeFileSync(
        join(dir, "overlay.spec.ts"),
        `import { expect, test } from "@playwright/test";
import { overlayEvidence, type OverlayStep } from "../../e2e-packaged/overlay-diagnostics.ts";
import type { OverlayRead } from "../../e2e-packaged/windows.ts";

// As e2e-packaged/launch.spec.ts runs its overlay check, with stand-ins for its badge call and taskbar read.
const overlay = overlayEvidence(process.env.CLAWTRATE_PACKAGED_EXIT ?? "");
test.afterEach(() => overlay.after(test.info()));

type Read = (reads: OverlayRead[], expected: string) => string | null | undefined;
async function check(setBadge: (count: number) => Promise<void>, read: Read) {
  const steps = overlay.begin();
  const phase = async (name: OverlayStep["phase"], count: number, expected: string) => {
    const step: OverlayStep = { phase: name, expected, started: Date.now(), badgeCallReturned: false, reads: [] };
    steps.push(step);
    await setBadge(count);
    step.badgeCallReturned = true;
    await expect.poll(() => read(step.reads, expected), { timeout: 1_000 }).toBe(expected);
  };
  try {
    await phase("set", 3, "3 unread");
    await phase("clear", 0, "");
  } catch (error) {
    await overlay.failed(test.info());
    throw error;
  }
}
const at = () => new Date().toISOString();
const answers: Read = (reads, expected) => (reads.push({ at: at(), ms: 1, value: expected }), expected);
const timesOut: Read = (reads) => (reads.push({ at: at(), ms: 5000, error: "timed out" }), undefined);

test("passes", () => check(async () => {}, answers));

test("waits on a badge call that never returns", async () => {
  test.setTimeout(1_500);
  await check(() => new Promise(() => {}), answers);
});

test("fails to clear before any clear read", () =>
  check(async (count) => {
    if (count === 0) throw new Error("stand-in: the page closed");
  }, answers));

test("reads only time out", () => check(async () => {}, timesOut));

test("attaches a report by its body alone", async () => {
  // Joined here: the error context quotes this source.
  const body = ["kept", "in", "memory", "only"].join("-");
  await test.info().attach("body-only", { body, contentType: "application/json" });
  expect("received").toBe("expected");
});
`,
      );
      const run = spawnSync(
        process.execPath,
        [join(ROOT, "node_modules/@playwright/test/cli.js"), "test", "-c", "overlay.config.mjs"],
        {
          cwd: dir,
          encoding: "utf8",
          timeout: 90_000,
          env: runnerEnv(exitFile),
        },
      );
      const output = run.stdout + run.stderr;
      expect(run.status, output).toBe(1);
      // The tests' own failures, as before.
      expect(output).toContain('Expected: "3 unread"');
      expect(output).toContain("Received: undefined");
      expect(output).toContain("Test timeout of 1500ms exceeded");
      expect(output).toContain("stand-in: the page closed");
      expect(output).toContain("1 passed");

      const out = join(dir, "out");
      const folder = (title: string) => {
        const name = readdirSync(out).find((each) => each.includes(title));
        return name ? join(out, name) : "";
      };
      const report = (title: string) =>
        JSON.parse(readFileSync(join(folder(title), OVERLAY_REPORT), "utf8"));
      const kept = readdirSync(out, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.name === OVERLAY_REPORT)
        .map((entry) => entry.parentPath)
        .sort();
      expect(kept).toEqual(
        ["waits-on-a-badge", "fails-to-clear", "reads-only-time-out"].map(folder).sort(),
      );
      // Beside Playwright's own error context, which is all CI's artifact held.
      for (const each of kept) expect(existsSync(join(each, "error-context.md")), each).toBe(true);

      // Kept after the test timed out, with the call it was waiting on.
      expect(report("waits-on-a-badge")).toMatchObject({
        endedIn: "set",
        phases: [{ phase: "set", badgeCallReturned: false, outcomes: {}, lastReads: [] }],
        keptBy: "afterEach",
        appExitAtFailure: "not reported",
      });
      // The set phase that passed, beside a clear phase that failed before any read.
      expect(report("fails-to-clear")).toMatchObject({
        endedIn: "clear",
        phases: [
          { phase: "set", badgeCallReturned: true, outcomes: { expected: 1 } },
          { phase: "clear", badgeCallReturned: false, outcomes: {}, lastReads: [] },
        ],
        keptBy: "catch",
      });
      const timedOut = report("reads-only-time-out");
      expect(timedOut).toMatchObject({
        endedIn: "set",
        phases: [
          { phase: "set", badgeCallReturned: true, outcomes: { "timed out": expect.any(Number) } },
        ],
        keptBy: "catch",
        appExitAtFailure: "not reported",
      });
      expect(timedOut.phases[0].lastReads.length).toBe(timedOut.phases[0].outcomes["timed out"]);

      // A body-only attachment leaves no file: why the report was missing before.
      const files = readdirSync(out, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"));
      expect(files.some((text) => text.includes("kept-in-memory-only"))).toBe(false);

      // The runner sees the app end after the worker that failed is gone.
      const beforeClose = exitOf(app);
      app.stdin!.end();
      expect(await exitedWithin(app, 10_000)).toBe(true);
      const ended = app;
      await recordTeardownExit([out], { beforeClose, afterClose: exitOf(ended) }, async () =>
        exitOf(ended),
      );
      for (const each of kept)
        expect(JSON.parse(readFileSync(join(each, TEARDOWN_EXIT), "utf8")), each).toEqual({
          beforeClose: "not reported",
          afterClose: { code: 0, signal: null },
          lastReported: { code: 0, signal: null },
        });
      expect(
        report("reads-only-time-out").appExitAtFailure,
        "what the test saw at its failure is kept as it was",
      ).toBe("not reported");
    } finally {
      try {
        if (app) await reap(app);
      } finally {
        removeOwned(dir);
      }
    }
  }, 120_000);

  it("hands the nested runner none of this process's CLAWTRATE_PACKAGED_ variables, whatever their case", () => {
    // Synthetic values under keys Windows takes for the same variables, which keep their spelling.
    const outer = packagedEnv();
    const exitFile = `synthetic-exit-${randomBytes(4).toString("hex")}`;
    const seeds = {
      clawtrate_Packaged_Exit: `synthetic-inherited-${randomBytes(4).toString("hex")}`,
      Clawtrate_Packaged_Place: `synthetic-inherited-${randomBytes(4).toString("hex")}`,
    };
    try {
      // Only these, under these spellings: what was inherited is cleared first.
      restorePackagedEnv(seeds);
      expect(packagedEnv()).toEqual(seeds);
      const seen = spawnSync(
        process.execPath,
        [
          "-e",
          "console.log(JSON.stringify(Object.entries(process.env).filter(([key]) => key.toUpperCase().startsWith('CLAWTRATE_PACKAGED_'))))",
        ],
        { env: runnerEnv(exitFile), encoding: "utf8" },
      );
      expect(JSON.parse(seen.stdout)).toEqual([["CLAWTRATE_PACKAGED_EXIT", exitFile]]);
    } finally {
      restorePackagedEnv(outer);
    }
    expect(packagedEnv()).toEqual(outer);
  });
});

// The Windows global setup itself, as the launch check starts it, with a
// stand-in app and stand-ins for the process list and the close request.
describe("the Windows teardown", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

  type Stand = {
    /** What the close request answers; it lets the app quit either way. */
    refusal?: string | null;
    /** How long after the close request the app quits by itself, or null if it never does. */
    quitsAfter?: number | null;
    /** The process list; by default the app, while Node has not reported its exit. */
    listing?: (app: WindowsProcess | null) => WindowsProcess[];
    /** Whether a failed overlay check left its report. */
    report?: boolean;
    /** Whether the packaged executable is there. */
    exe?: boolean;
    /** The debugging port the setup waits for. */
    port?: () => Promise<number>;
  };
  type Run = {
    setup: () => Promise<() => Promise<void>>;
    root: string;
    sidecar: string;
    /** The arguments the setup launched its app with, and the stand-in this run started for it. */
    launched: () => { args: string[]; app: ChildProcess } | undefined;
  };

  /** The stand-in app: it quits `after` ms once `quit` exists, or never if `after` is null. */
  const standIn = (quit: string, after: number | null) =>
    after === null
      ? "setInterval(() => {}, 1000)"
      : `const fs = process.getBuiltinModule("node:fs");
const wait = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(quit)})) return;
  clearInterval(wait);
  setTimeout(() => process.exit(0), ${after});
}, 20);`;

  /**
   * Runs the Windows global setup, and `use` with it, in a folder of this
   * test's own that the setup's temporary folder is made in. Whatever either
   * throws, the stand-in app is ended by its handle and reaped, the platform,
   * the CLAWTRATE_PACKAGED_ variables and the stand-ins are put back, and that
   * folder alone is removed. Returns the stand-in app, if the setup started one.
   */
  async function windowsRun(
    stand: Stand,
    use: (run: Run) => Promise<void>,
  ): Promise<ChildProcess | undefined> {
    const saved = packagedEnv();
    const listeners = process.listeners("exit");
    const root = ownedTemp("clawtrate-windows-teardown-");
    let app: ChildProcess | undefined;
    try {
      const report = join(root, "out", "launch-shows-unread-tasks");
      mkdirSync(report, { recursive: true });
      if (stand.report !== false) writeFileSync(join(report, OVERLAY_REPORT), "{}");
      mkdirSync(join(root, "app"));
      if (stand.exe !== false) writeFileSync(join(root, "app", "Clawtrate.exe"), "");
      process.env.CLAWTRATE_PACKAGED_APP = join(root, "app");
      const quit = join(root, "quit");
      let listed: WindowsProcess | null = null;
      let launched: { args: string[]; app: ChildProcess } | undefined;
      vi.mocked(tmpdir).mockReturnValue(root);
      // In place of the packaged executable only, started by the real spawn, never the stand-in's;
      // outside the run's own folder, which Windows would not remove while it is a running app's.
      vi.mocked(spawn).mockImplementationOnce(((_exe: string, args: string[]) => {
        const after = stand.quitsAfter === undefined ? 0 : stand.quitsAfter;
        app = realChildProcess.spawn(process.execPath, ["-e", standIn(quit, after)], {
          cwd: root,
          stdio: "ignore",
        });
        listed = { pid: app.pid!, ppid: process.pid, command: args.join(" ") };
        launched = { args, app };
        return app;
      }) as unknown as typeof spawn);
      vi.mocked(askToClose).mockImplementation(
        () => (writeFileSync(quit, ""), stand.refusal ?? null),
      );
      vi.mocked(windowsProcesses).mockImplementation(() => {
        const running = app && exitOf(app) === "not reported" ? listed : null;
        return stand.listing ? stand.listing(running) : running ? [running] : [];
      });
      vi.mocked(debuggingPort).mockImplementation(stand.port ?? (async () => 1));
      vi.spyOn(console, "log").mockImplementation(() => {});
      Object.defineProperty(process, "platform", { ...platform, value: "win32" });
      const config = { projects: [{ outputDir: join(root, "out") }] } as unknown as FullConfig;
      await use({
        setup: async () => (await globalSetup(config)) as () => Promise<void>,
        root,
        sidecar: join(report, TEARDOWN_EXIT),
        launched: () => launched,
      });
    } finally {
      // What cannot fail first, so a failure below leaves none of it behind.
      Object.defineProperty(process, "platform", platform);
      vi.mocked(tmpdir).mockImplementation(realOs.tmpdir);
      // A setup that failed before its launch leaves the stand-in queued for the next run's.
      vi.mocked(spawn).mockReset().mockImplementation(realChildProcess.spawn);
      for (const listener of process.listeners("exit"))
        if (!listeners.includes(listener)) process.off("exit", listener);
      restorePackagedEnv(saved);
      try {
        if (app) await reap(app);
      } finally {
        removeOwned(root);
      }
    }
    return app;
  }

  it("keeps each run to its own: never removes what an inherited CLAWTRATE_PACKAGED_ variable names, launches its own app after an early failure, and ends only that app", async () => {
    // A harmless folder of this test's own, standing in for an inherited value,
    // one of them under a key Windows takes for the one the setup sets.
    const outer = packagedEnv();
    const inherited = ownedTemp("clawtrate-inherited-sentinel-");
    const sentinel = join(inherited, "sentinel.txt");
    writeFileSync(sentinel, "inherited");
    const names = {
      Clawtrate_Packaged_Place: inherited,
      CLAWTRATE_PACKAGED_USER_DATA: inherited,
      CLAWTRATE_PACKAGED_EXIT: sentinel,
    };
    try {
      // Only these, under these spellings: what was inherited is cleared first.
      restorePackagedEnv(names);
      expect(packagedEnv()).toEqual(names);
      // No packaged executable: the setup fails before it makes a folder or sets a variable.
      const none = await windowsRun({ exe: false }, async ({ setup }) => {
        await expect(setup()).rejects.toThrow("does not exist");
        expect(packagedEnv()).toMatchObject(names);
      });
      expect(none, "no app started").toBeUndefined();
      // No debugging port: the setup fails after naming its folder and starting the app,
      // its own, with its own user-data folder and arguments.
      const started = await windowsRun(
        { port: async () => Promise.reject(new Error("stand-in: no debugging port")) },
        async ({ setup, root, launched }) => {
          await expect(setup()).rejects.toThrow("stand-in: no debugging port");
          expect(dirname(process.env.CLAWTRATE_PACKAGED_PLACE!)).toBe(root);
          const [userData, waitedOn] = vi.mocked(debuggingPort).mock.lastCall!;
          expect(userData.startsWith(`${root}${sep}`), userData).toBe(true);
          expect(launched()?.args).toEqual(
            launchArgs(userData, process.env.CLAWTRATE_PACKAGED_SANDBOX!, CHECKOUT),
          );
          expect(waitedOn).toBe(launched()?.app);
        },
      );
      expect(started && exitOf(started), "the stand-in app is reaped").toEqual({
        code: 0,
        signal: null,
      });
      expect(readFileSync(sentinel, "utf8")).toBe("inherited");
      expect(process.env.Clawtrate_Packaged_Place).toBe(inherited);
      expect(packagedEnv()).toEqual(names);

      // The test fails while its stand-in app runs: that app alone is ended, and
      // the test's own error is the one thrown.
      const bystander = realChildProcess.spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        {
          stdio: "ignore",
        },
      );
      try {
        let own: ChildProcess | undefined;
        await expect(
          windowsRun({ quitsAfter: null }, async ({ setup, launched }) => {
            await setup();
            own = launched()?.app;
            throw new Error("stand-in: the test failed");
          }),
        ).rejects.toThrow("stand-in: the test failed");
        expect(own && exitOf(own), "its own app, ended by its handle").toEqual({
          code: null,
          signal: "SIGTERM",
        });
        expect(exitOf(bystander), "another child, left running").toBe("not reported");
      } finally {
        await reap(bystander);
      }
    } finally {
      restorePackagedEnv(outer);
      removeOwned(inherited);
    }
    expect(packagedEnv()).toEqual(outer);
  });

  it.each([
    [
      "throws",
      () => {
        throw new Error("stand-in: the process list failed");
      },
      "stand-in: the process list failed",
    ],
    ["is already empty", () => [], "asking the app to close failed: ERROR: stand-in refusal"],
  ])(
    "after a refused close, when the process list %s before Node reports the exit, gives the exit a short chance for the record alone",
    async (_listing, listing, failure) => {
      await windowsRun(
        { refusal: "ERROR: stand-in refusal", quitsAfter: 300, listing },
        async ({ setup, sidecar }) => {
          const teardown = await setup();
          // The checks' own verdict, as before.
          await expect(teardown()).rejects.toThrow(failure);
          expect(JSON.parse(readFileSync(sidecar, "utf8"))).toEqual({
            beforeClose: "not reported",
            afterClose: "not asked",
            lastReported: { code: 0, signal: null },
          });
        },
      );
    },
  );

  it("keeps the exit unknown when Node reports none within the bound, and its stand-in app is reaped after the teardown rejects", async () => {
    let elapsed = 0;
    const app = await windowsRun(
      { refusal: "ERROR: stand-in refusal", quitsAfter: null, listing: () => [] },
      async ({ setup, sidecar }) => {
        const teardown = await setup();
        const started = Date.now();
        await expect(teardown()).rejects.toThrow("asking the app to close failed");
        elapsed = Date.now() - started;
        expect(JSON.parse(readFileSync(sidecar, "utf8")).lastReported).toBe("not reported");
      },
    );
    expect(elapsed).toBeGreaterThanOrEqual(950);
    expect(elapsed).toBeLessThan(5_000);
    expect(app && exitOf(app), "ended by the test, by its handle").not.toBe("not reported");
  });

  it("waits for no exit when there is no report to write it beside", async () => {
    let elapsed = 0;
    await windowsRun(
      { refusal: "ERROR: stand-in refusal", quitsAfter: null, listing: () => [], report: false },
      async ({ setup, sidecar }) => {
        const teardown = await setup();
        const started = Date.now();
        await expect(teardown()).rejects.toThrow("asking the app to close failed");
        elapsed = Date.now() - started;
        expect(existsSync(sidecar)).toBe(false);
      },
    );
    expect(elapsed).toBeLessThan(500);
  });

  it.each([
    [null, "EISDIR", "how the app quit could not be recorded beside the overlay report (EISDIR)"],
    [
      "ERROR: stand-in refusal",
      "C:\\fake-code",
      "how the app quit could not be recorded beside the overlay report",
    ],
  ])(
    "a record that can't be written fails no clean quit and hides no failure (refusal %s), with a warning of fixed words and an allowed code",
    async (refusal, code, warning) => {
      await windowsRun(
        { refusal, ...(refusal ? { listing: () => [] } : {}) },
        async ({ setup }) => {
          const teardown = await setup();
          const { path, error } = fakeError(code);
          failWrites(TEARDOWN_EXIT, error);
          const printed = vi.spyOn(console, "error").mockImplementation(() => {});
          if (refusal)
            await expect(teardown()).rejects.toThrow(`asking the app to close failed: ${refusal}`);
          else await expect(teardown()).resolves.toBeUndefined();
          expect(printed.mock.calls).toEqual([[warning]]);
          expect(JSON.stringify(printed.mock.calls)).not.toContain(path);
        },
      );
    },
  );
});
