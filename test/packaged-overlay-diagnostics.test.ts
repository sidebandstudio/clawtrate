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
import type * as Driver from "../e2e-packaged/desktop-driver.ts";
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
  forceEnd,
  windowsProcesses,
  type OverlayRead,
  type WindowsProcess,
} from "../e2e-packaged/windows.ts";

// Stand-ins for the Windows run's app, its process list, its close request,
// its debugging port and its temporary folder, and for a write, a removal or
// a look at a folder that fails; every other call is the real one.
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof ChildProcesses>();
  return { ...real, spawn: vi.fn(real.spawn) };
});
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof Fs>();
  return {
    ...real,
    existsSync: vi.fn(real.existsSync),
    rmSync: vi.fn(real.rmSync),
    writeFileSync: vi.fn(real.writeFileSync),
  };
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
const realDriver = await vi.importActual<typeof Driver>("../e2e-packaged/desktop-driver.ts");
const realFs = await vi.importActual<typeof Fs>("node:fs");
const realOs = await vi.importActual<typeof Os>("node:os");

const ROOT = join(import.meta.dirname, "..");
const AT = "2026-11-25T00:00:00.000Z";

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(writeFileSync).mockImplementation(realFs.writeFileSync);
  vi.mocked(rmSync).mockImplementation(realFs.rmSync);
  vi.mocked(existsSync).mockImplementation(realFs.existsSync);
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
    port?: typeof debuggingPort;
    /**
     * Whether Windows has ended the app before Node reports it (#326): its
     * handle then ends nothing, as Node's kill of a process already gone, and
     * the stand-in's own exit is the one reported, late.
     */
    lateExit?: boolean;
    /**
     * Whether the executable is one that never exists, so that the real spawn
     * fails: Node reports ENOENT by an error event a tick later, never an exit,
     * and no process starts.
     */
    unstarted?: boolean;
  };
  type Run = {
    setup: () => Promise<() => Promise<void>>;
    root: string;
    sidecar: string;
    /** The arguments the setup launched its app with, and the stand-in this run started for it. */
    launched: () => { args: string[]; app: ChildProcess } | undefined;
    /** Runs the exit handlers the setup added, as the runner's own exit would. */
    exit: () => void;
  };

  /**
   * Rows for processes the list says name the run's data folder, made up for
   * the list alone: no process is behind any of these PIDs, and forceEnd is a
   * stand-in that ends nothing. Each command line names its program first, as
   * Windows lists one.
   */
  const claims = (userData: string): WindowsProcess[] => {
    const exe = `"${join(process.env.CLAWTRATE_PACKAGED_APP!, "Clawtrate.exe")}"`;
    return [
      // A helper as Chromium starts one, and another program given the same profile.
      {
        pid: 0xfffffffc,
        ppid: 4,
        command: `${exe} --type=renderer --user-data-dir="${userData}" /prefetch:1`,
      },
      {
        pid: 0xfffffff8,
        ppid: 4,
        command: `"C:\\Program Files\\Other\\Other.exe" --user-data-dir="${userData}"`,
      },
      // One that only names a file in the folder, and a helper of a folder beside it.
      {
        pid: 0xfffffff4,
        ppid: 4,
        command: `"C:\\Windows\\System32\\findstr.exe" error "${userData}\\debug.log"`,
      },
      {
        pid: 0xfffffff0,
        ppid: 4,
        command: `${exe} --type=renderer --user-data-dir="${userData}2" /prefetch:1`,
      },
    ];
  };
  /** What the run says of processes still naming its data folder: their PIDs alone. */
  const leftover = (pids: number[]) =>
    `processes whose command line names the run's data folder are still running and were not ended: pid ${pids.join(", ")}; check them by hand`;

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
        if (stand.unstarted) {
          // A name no file has, in this test's folder. No process, so nothing to list or reap.
          const missing = join(root, `missing-${randomBytes(6).toString("hex")}.exe`);
          const failed = realChildProcess.spawn(missing, [], { cwd: root, stdio: "ignore" });
          // Node 24's kill of such a handle throws EINVAL, and Node 26's returns false.
          vi.spyOn(failed, "kill").mockImplementation(() => {
            throw Object.assign(new Error("kill EINVAL"), { code: "EINVAL", syscall: "kill" });
          });
          launched = { args, app: failed };
          return failed;
        }
        const after = stand.quitsAfter === undefined ? 0 : stand.quitsAfter;
        app = realChildProcess.spawn(process.execPath, ["-e", standIn(quit, after)], {
          cwd: root,
          stdio: "ignore",
        });
        listed = { pid: app.pid!, ppid: process.pid, command: args.join(" ") };
        launched = { args, app };
        if (stand.lateExit) vi.spyOn(app, "kill").mockReturnValue(false);
        return app;
      }) as unknown as typeof spawn);
      vi.mocked(forceEnd).mockClear();
      vi.mocked(askToClose).mockClear();
      vi.mocked(debuggingPort).mockClear();
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
        exit: () => {
          for (const listener of process.listeners("exit"))
            if (!listeners.includes(listener)) listener(0);
        },
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
        if (app && vi.isMockFunction(app.kill)) vi.mocked(app.kill).mockRestore();
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
      [
        "asking the app to close failed: ERROR: stand-in refusal",
        "the wait for the app's helpers to quit stopped early: the process list could not be read",
        "whether any process still names the run's data folder is unknown: the process list could not be read",
      ].join("\n"),
    ],
    ["is already empty", () => [], "asking the app to close failed: ERROR: stand-in refusal"],
  ])(
    "after a refused close, when the process list %s before Node reports the exit, gives the exit a short chance for the record alone",
    async (_listing, listing, failure) => {
      await windowsRun(
        { refusal: "ERROR: stand-in refusal", quitsAfter: 300, listing, lateExit: true },
        async ({ setup, sidecar }) => {
          const teardown = await setup();
          // The checks' own verdict, as before.
          await expect(teardown()).rejects.toThrow(failure);
          expect(JSON.parse(readFileSync(sidecar, "utf8"))).toEqual({
            beforeClose: "not reported",
            afterClose: "not asked",
            lastReported: { code: 0, signal: null },
          });
          expect(forceEnd, "the app, unreported, is never ended by PID").not.toHaveBeenCalled();
        },
      );
    },
  );

  it("keeps the exit unknown when Node reports none within the bound, and its stand-in app is reaped after the teardown rejects", async () => {
    let elapsed = 0;
    const app = await windowsRun(
      { refusal: "ERROR: stand-in refusal", quitsAfter: null, listing: () => [], lateExit: true },
      async ({ setup, sidecar }) => {
        const teardown = await setup();
        const started = Date.now();
        await expect(teardown()).rejects.toThrow("asking the app to close failed");
        elapsed = Date.now() - started;
        expect(JSON.parse(readFileSync(sidecar, "utf8")).lastReported).toBe("not reported");
        expect(forceEnd).not.toHaveBeenCalled();
      },
    );
    expect(elapsed).toBeGreaterThanOrEqual(950);
    expect(elapsed).toBeLessThan(5_000);
    expect(app && exitOf(app), "ended by the test, by its handle").not.toBe("not reported");
  });

  it("never ends by PID an app Node saw end by a signal, though another process now has its PID, and keeps how it ended", async () => {
    let reused = 0;
    await windowsRun(
      {
        // Once the app is gone, a row for another program Windows gave its PID; no process is behind it.
        listing: (running) =>
          running ? [running] : [{ pid: reused, ppid: 4, command: "C:\\stand-in\\other.exe" }],
      },
      async ({ setup, sidecar, launched }) => {
        const teardown = await setup();
        const app = launched()!.app;
        reused = app.pid!;
        // Ended by its handle, by the test, before the teardown comes to ask it to close.
        app.kill();
        expect(await exitedWithin(app, 10_000)).toBe(true);
        await expect(teardown()).rejects.toThrow(
          "the app exited before it was asked to close, with SIGTERM",
        );
        expect(forceEnd).not.toHaveBeenCalled();
        expect(JSON.parse(readFileSync(sidecar, "utf8"))).toEqual({
          beforeClose: { code: null, signal: "SIGTERM" },
          afterClose: "not asked",
          lastReported: { code: null, signal: "SIGTERM" },
        });
      },
    );
  });

  it.each([
    ["Node still holds it", false, undefined, 1],
    ["Node saw it end by a signal and the list shows its PID again", true, 3, 3],
  ])(
    "at the runner's exit, when %s, ends the app by its handle alone and nothing by PID, whatever a listed command line claims, and fails the run naming each process still listed by PID alone",
    async (_case, endedFirst, before, after) => {
      const printed = vi.spyOn(console, "error").mockImplementation(() => {});
      const exitCode = process.exitCode;
      let rows: WindowsProcess[] = [];
      try {
        await windowsRun(
          { quitsAfter: null, listing: () => rows },
          async ({ setup, launched, exit }) => {
            await setup();
            const { app, args } = launched()!;
            expect(app.listenerCount("spawn") + app.listenerCount("error"), "none left").toBe(0);
            const userData = vi.mocked(debuggingPort).mock.lastCall![0];
            const place = process.env.CLAWTRATE_PACKAGED_PLACE!;
            const kill = vi.spyOn(app, "kill");
            if (endedFirst) {
              app.kill();
              expect(await exitedWithin(app, 10_000)).toBe(true);
            }
            const exe = join(process.env.CLAWTRATE_PACKAGED_APP!, "Clawtrate.exe");
            const others = claims(userData);
            rows = [
              // The app's own row by its PID; once Node has seen the app end, another process's.
              { pid: app.pid!, ppid: process.pid, command: `"${exe}" ${args.join(" ")}` },
              // The runner itself, as if given the same profile.
              { pid: process.pid, ppid: 4, command: `node.exe --user-data-dir="${userData}"` },
              ...others,
            ];
            process.exitCode = before;
            exit();
            expect(forceEnd, "nothing is ended by PID").not.toHaveBeenCalled();
            expect(askToClose).not.toHaveBeenCalled();
            expect(
              kill,
              endedFirst ? "the test's own kill alone" : "by its handle",
            ).toHaveBeenCalledOnce();
            expect(await exitedWithin(app, 10_000)).toBe(true);
            expect(exitOf(app)).toEqual({ code: null, signal: "SIGTERM" });
            const listed = [...(endedFirst ? [app.pid!] : []), ...others.map(({ pid }) => pid)];
            expect(printed.mock.calls).toEqual([[leftover(listed)]]);
            const said = printed.mock.calls.flat().join("\n");
            for (const text of [userData, "--user-data-dir", "Other.exe", "findstr"])
              expect(said, "no command line in the report").not.toContain(text);
            expect(process.exitCode, "an exit code already set is kept").toBe(after);
            expect(existsSync(place), "the run's folder").toBe(false);
          },
        );
      } finally {
        process.exitCode = exitCode;
      }
    },
  );

  it("when the app quits as asked but processes naming its data folder stay listed, waits 50 times 200 ms for its helpers, then looks once more, ends none of them, fails the run naming what that last look lists by PID alone, once, and keeps how the app quit", async () => {
    const printed = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitCode = process.exitCode;
    const realSetTimeout = setTimeout;
    let waits: { mockRestore: () => void } | undefined;
    // Each look at the list and each 200 ms wait scheduled, in order.
    const steps: string[] = [];
    let rows: WindowsProcess[] = [];
    let looks = 0;
    try {
      await windowsRun(
        {
          // The app's exit is reported before the first look, which starts the
          // helpers' wait: from then on a 200 ms timer is counted and fires at
          // once, and any other runs as asked. Each look lists the first helper
          // again under a new PID, so the report shows which look it came from.
          listing: () => {
            waits ??= vi.spyOn(globalThis, "setTimeout").mockImplementation(((
              callback: (...args: unknown[]) => void,
              ms?: number,
              ...args: unknown[]
            ) => {
              if (ms !== 200) return realSetTimeout(callback, ms, ...args);
              steps.push("wait 200");
              return realSetTimeout(callback, 0, ...args);
            }) as unknown as typeof setTimeout);
            steps.push("look");
            looks += 1;
            return [...rows, { ...rows[0]!, pid: 0xffff0000 + looks }];
          },
        },
        async ({ setup, sidecar, exit }) => {
          const teardown = await setup();
          const place = process.env.CLAWTRATE_PACKAGED_PLACE!;
          rows = claims(vi.mocked(debuggingPort).mock.lastCall![0]);
          const verdict = await teardown().then(
            () => undefined,
            (error: unknown) => error,
          );
          waits?.mockRestore();
          expect(steps).toEqual([
            ...Array.from({ length: 50 }, () => ["look", "wait 200"]).flat(),
            "look",
          ]);
          expect(String(verdict)).toBe(
            `Error: ${leftover([...rows.map(({ pid }) => pid), 0xffff0000 + looks])}`,
          );
          expect(forceEnd).not.toHaveBeenCalled();
          expect(JSON.parse(readFileSync(sidecar, "utf8"))).toEqual({
            beforeClose: "not reported",
            afterClose: { code: 0, signal: null },
            lastReported: { code: 0, signal: null },
          });
          expect(existsSync(place), "the run's folder").toBe(false);
          expect(console.log, "no claim the run cleaned up").not.toHaveBeenCalledWith(
            expect.stringContaining("Closed the packaged app"),
          );
          // The runner's exit after the teardown adds nothing.
          exit();
          expect(printed).not.toHaveBeenCalled();
          expect(process.exitCode).toBe(exitCode);
        },
      );
    } finally {
      waits?.mockRestore();
      process.exitCode = exitCode;
    }
  });

  it("when the process list fails at the wait's first look after a refused close, keeps the refusal first, says the wait stopped by fixed words and an allowed code alone, ends the app by its handle, looks once more and has removed the run's folder when the teardown rejects, though the app never exits", async () => {
    const printed = vi.spyOn(console, "error").mockImplementation(() => {});
    const { path, error } = fakeError("ETIMEDOUT");
    let looks = 0;
    await windowsRun(
      {
        refusal: "ERROR: stand-in refusal",
        quitsAfter: null,
        lateExit: true,
        // Failing once, at the wait's first look; the last look lists the app Node still holds.
        listing: (running) => {
          looks += 1;
          if (looks === 1) throw error;
          return running ? [running] : [];
        },
      },
      async ({ setup, sidecar, launched }) => {
        const teardown = await setup();
        const { app } = launched()!;
        const place = process.env.CLAWTRATE_PACKAGED_PLACE!;
        const verdict = String(await teardown().catch((caught: unknown) => caught));
        expect(verdict).toBe(
          [
            "Error: asking the app to close failed: ERROR: stand-in refusal",
            "the wait for the app's helpers to quit stopped early: the process list could not be read (ETIMEDOUT)",
          ].join("\n"),
        );
        expect(verdict).not.toContain(path);
        expect(looks, "the failed look, then the last").toBe(2);
        expect(app.kill, "by its handle, once").toHaveBeenCalledOnce();
        expect(exitOf(app), "the app still runs").toBe("not reported");
        expect(existsSync(place), "removed before the runner's exit").toBe(false);
        expect(forceEnd).not.toHaveBeenCalled();
        expect(JSON.parse(readFileSync(sidecar, "utf8"))).toEqual({
          beforeClose: "not reported",
          afterClose: "not asked",
          lastReported: "not reported",
        });
        expect(printed).not.toHaveBeenCalled();
      },
    );
  });

  it.each([
    ["the teardown, after an otherwise clean quit", false],
    ["the runner's exit, after the app's handle was refused, with an exit code already set", true],
  ])(
    "when the process list fails at the last look, in %s, says so by fixed words and an allowed code alone after the earlier failures, still removes the run's folder and claims nothing of what runs",
    async (_case, atExit) => {
      const printed = vi.spyOn(console, "error").mockImplementation(() => {});
      const exitCode = process.exitCode;
      // A code that is a system name, and one that is none.
      const { path, error } = fakeError(atExit ? "C:\\fake-code" : "ETIMEDOUT");
      const unknown =
        "whether any process still names the run's data folder is unknown: the process list could not be read";
      let looks = 0;
      try {
        await windowsRun(
          {
            quitsAfter: atExit ? null : 0,
            // Empty at the wait's look, then failing once, at the last look; at the exit there is no wait.
            listing: () => {
              looks += 1;
              if (looks === (atExit ? 1 : 2)) throw error;
              return [];
            },
          },
          async ({ setup, launched, exit }) => {
            const teardown = await setup();
            const { app } = launched()!;
            const place = process.env.CLAWTRATE_PACKAGED_PLACE!;
            let said: string;
            if (atExit) {
              refuseKill(app, "EPERM");
              process.exitCode = 3;
              exit();
              said = printed.mock.calls.flat().join("\n");
              expect(said).toBe(
                [`the app (pid ${app.pid}) could not be ended by its handle (EPERM)`, unknown].join(
                  "\n",
                ),
              );
              expect(process.exitCode, "the exit code already set").toBe(3);
            } else {
              said = String(await teardown().catch((caught: unknown) => caught));
              expect(said).toBe(`Error: ${unknown} (ETIMEDOUT)`);
              exit();
              expect(printed, "nothing more at the runner's exit").not.toHaveBeenCalled();
            }
            expect(looks, "the last look is the one that failed").toBe(atExit ? 1 : 2);
            expect(said).not.toContain(path);
            expect(rmSync).toHaveBeenCalledWith(place, expect.anything());
            expect(existsSync(place), "the run's folder").toBe(false);
            expect(console.log).not.toHaveBeenCalledWith(
              expect.stringContaining("Closed the packaged app"),
            );
            expect(forceEnd).not.toHaveBeenCalled();
          },
        );
      } finally {
        process.exitCode = exitCode;
      }
    },
  );

  it("for an executable that cannot start, at the runner's exit, ends nothing by handle or PID though processes with its profile are listed, names them by PID alone, once, and the setup still rejects with Node's own error", async () => {
    const printed = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitCode = process.exitCode;
    let rows: WindowsProcess[] = [];
    try {
      await windowsRun(
        { unstarted: true, port: realDriver.debuggingPort, listing: () => rows },
        async ({ setup, launched, exit }) => {
          // Spawned, with its error not yet reported, once this returns.
          const failed = setup();
          const place = process.env.CLAWTRATE_PACKAGED_PLACE!;
          const { app: child, args } = launched()!;
          expect(child.pid).toBeUndefined();
          rows = claims(args[0]!.slice("--user-data-dir=".length));
          exit();
          expect(existsSync(place), "removed at the runner's exit").toBe(false);
          const error = await failed.then(
            () => undefined,
            (caught: unknown) => caught,
          );
          expect(error).toMatchObject({ code: "ENOENT", path: child.spawnfile });
          expect(child.kill).not.toHaveBeenCalled();
          expect(forceEnd).not.toHaveBeenCalled();
          expect(printed.mock.calls).toEqual([
            [leftover(rows.map(({ pid }) => pid))],
            [`Error: the app exited before it was asked to close, with ${child.exitCode}`],
          ]);
          expect(process.exitCode).toBe(1);
        },
      );
    } finally {
      process.exitCode = exitCode;
    }
  }, 40_000);

  it.each([
    ["its setup fails", false],
    ["the runner exits first", true],
  ])(
    "for an executable that cannot start, when %s, rejects the setup with Node's own error, waits for no debugging port, ends nothing by handle or PID and removes the run's folder",
    async (_case, exitsFirst) => {
      const printed = vi.spyOn(console, "error").mockImplementation(() => {});
      const app = await windowsRun(
        // The real wait, which would read only this run's own profile.
        { unstarted: true, port: realDriver.debuggingPort },
        async ({ setup, root, sidecar, launched, exit }) => {
          // Spawned, with its error not yet reported, once this returns.
          const failed = setup();
          const place = process.env.CLAWTRATE_PACKAGED_PLACE!;
          const child = launched()!.app;
          expect([child.pid, exitOf(child)]).toEqual([undefined, "not reported"]);
          if (exitsFirst) {
            exit();
            expect(existsSync(place), "removed at the runner's exit").toBe(false);
          }
          const error = await failed.then(
            () => undefined,
            (caught: unknown) => caught,
          );
          expect(error).toMatchObject({
            code: "ENOENT",
            errno: child.exitCode,
            path: child.spawnfile,
          });
          expect(child.listenerCount("spawn") + child.listenerCount("error")).toBe(0);
          expect(existsSync(place), place).toBe(false);
          expect(debuggingPort).not.toHaveBeenCalled();
          expect(child.kill).not.toHaveBeenCalled();
          expect(askToClose).not.toHaveBeenCalled();
          expect(forceEnd).not.toHaveBeenCalled();
          const ended = { code: child.exitCode, signal: null };
          expect(printed.mock.calls).toEqual([
            [`Error: the app exited before it was asked to close, with ${child.exitCode}`],
          ]);
          const kept = readFileSync(sidecar, "utf8");
          expect(JSON.parse(kept)).toEqual({
            beforeClose: ended,
            afterClose: "not asked",
            lastReported: ended,
          });
          for (const name of [basename(root), basename(child.spawnfile)])
            expect(kept, "no path in the uploaded record").not.toContain(name);
        },
      );
      expect(app, "no process started").toBeUndefined();
    },
  );

  /**
   * Makes the kill of this test's own app throw, as Node's does when Windows
   * refuses to end a process, with a made-up path in its text. Returns that path.
   */
  const refuseKill = (app: ChildProcess, code: string) => {
    const { path, error } = fakeError(code);
    vi.spyOn(app, "kill").mockImplementation(() => {
      throw error;
    });
    return path;
  };

  it.each([
    ["its setup fails", true, false],
    ["its teardown runs, with the busy folder reading as absent", false, true],
  ])(
    "when %s and ending the app by its handle throws, keeps the earlier verdict, tries to remove the run's folder and counts that it threw, and names each failure once by its code alone, never ending the app by PID",
    async (_case, setupFails, hidden) => {
      const printed = vi.spyOn(console, "error").mockImplementation(() => {});
      const synthetic: string[] = [];
      // The run's folder stays busy, as one a running app holds would.
      vi.mocked(rmSync).mockImplementation((path, options) => {
        if (path !== process.env.CLAWTRATE_PACKAGED_PLACE) return realFs.rmSync(path, options);
        const busy = fakeError("EBUSY");
        synthetic.push(busy.path);
        throw busy.error;
      });
      // As a folder Windows denies a look at, which reads as absent.
      if (hidden)
        vi.mocked(existsSync).mockImplementation(
          (path) => path !== process.env.CLAWTRATE_PACKAGED_PLACE && realFs.existsSync(path),
        );
      await windowsRun(
        {
          refusal: "ERROR: stand-in refusal",
          quitsAfter: null,
          listing: () => [],
          port: async (_userData, app) => {
            synthetic.push(refuseKill(app, "EPERM"));
            if (setupFails) throw new Error("stand-in: no debugging port");
            return 1;
          },
        },
        async ({ setup, sidecar, launched }) => {
          let verdict: string;
          if (setupFails) {
            await expect(setup()).rejects.toThrow("stand-in: no debugging port");
            expect(printed).toHaveBeenCalledOnce();
            verdict = String(printed.mock.calls[0]![0]);
          } else {
            const teardown = await setup();
            verdict = String(await teardown().catch((error: unknown) => error));
            expect(printed).not.toHaveBeenCalled();
          }
          const { app } = launched()!;
          const place = process.env.CLAWTRATE_PACKAGED_PLACE!;
          expect(verdict).toBe(
            [
              "Error: asking the app to close failed: ERROR: stand-in refusal",
              `the app (pid ${app.pid}) could not be ended by its handle (EPERM)`,
              "the run's folder could not be removed (EBUSY)",
            ].join("\n"),
          );
          expect(synthetic).toHaveLength(2);
          for (const path of [...synthetic, place]) expect(verdict).not.toContain(path);
          expect(app.kill).toHaveBeenCalledOnce();
          expect(rmSync).toHaveBeenCalledWith(place, expect.anything());
          expect(forceEnd).not.toHaveBeenCalled();
          expect(JSON.parse(readFileSync(sidecar, "utf8"))).toEqual({
            beforeClose: "not reported",
            afterClose: "not asked",
            lastReported: "not reported",
          });
        },
      );
    },
  );

  it("at the runner's exit, when ending the app by its handle throws, prints the refusal without its text, still removes the run's folder and fails the run, never ending the app by PID", async () => {
    const printed = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitCode = process.exitCode;
    try {
      await windowsRun({ quitsAfter: null }, async ({ setup, launched, exit }) => {
        await setup();
        const { app } = launched()!;
        // A code that is no system name: none is printed.
        const synthetic = refuseKill(app, "C:\\fake-code");
        const place = process.env.CLAWTRATE_PACKAGED_PLACE!;
        expect(() => exit()).not.toThrow();
        expect(printed.mock.calls).toEqual([
          [`the app (pid ${app.pid}) could not be ended by its handle`],
        ]);
        expect(printed.mock.calls.flat().join("\n")).not.toContain(synthetic);
        expect(app.kill).toHaveBeenCalledOnce();
        expect(existsSync(place)).toBe(false);
        expect(forceEnd, "the process list names the app's PID").not.toHaveBeenCalled();
        expect(process.exitCode).toBe(1);
      });
    } finally {
      process.exitCode = exitCode;
    }
  });

  it.each([
    ["Windows refuses by an error event", true],
    ["the kill only returns false", false],
  ])(
    "at the runner's exit before the app's start is reported, when %s, sees what the kill raises though the wait for the start listens too, and keeps an exit code already set",
    async (_case, refused) => {
      const printed = vi.spyOn(console, "error").mockImplementation(() => {});
      const exitCode = process.exitCode;
      try {
        await windowsRun({}, async ({ setup, launched, exit }) => {
          // Spawned with a PID, its start not yet reported, once this returns.
          const started = setup().then(
            () => "started",
            (error: unknown) => error,
          );
          const { app } = launched()!;
          const { path, error } = fakeError("EPERM");
          // Node's kill on a refusal other than "no such process": an error event, then false.
          vi.spyOn(app, "kill").mockImplementation(() => {
            if (refused) app.emit("error", error);
            return false;
          });
          const waiting = app.listeners("error");
          expect(waiting, "the wait for the start").toHaveLength(1);
          process.exitCode = 3;
          exit();
          expect(app.kill).toHaveBeenCalledOnce();
          expect(app.listeners("error"), "no listener of the cleanup's").toEqual(
            refused ? [] : waiting,
          );
          expect(process.exitCode).toBe(3);
          expect(printed.mock.calls).toEqual(
            refused ? [[`the app (pid ${app.pid}) could not be ended by its handle (EPERM)`]] : [],
          );
          expect(printed.mock.calls.flat().join("\n")).not.toContain(path);
          expect(await started, "the wait for the start, as before").toBe(
            refused ? error : "started",
          );
        });
      } finally {
        process.exitCode = exitCode;
      }
    },
  );

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
