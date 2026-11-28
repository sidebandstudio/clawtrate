// What a failed taskbar overlay check keeps (#448). CI uploads test-results/,
// which held only Playwright's error context: the check's own report was a
// body-only attachment, which the list reporter writes nowhere.
import type { FullConfig, TestInfo } from "@playwright/test";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import type * as ChildProcesses from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
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
import { clearTimeout as realClearTimeout, setTimeout as realSetTimeout } from "node:timers";
import { performance } from "node:perf_hooks";
import { inspect } from "node:util";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
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
  overlayEvidence,
  overlayReport,
  recordTeardownExit,
  reportedExit,
  writeOverlayReport,
  type OverlayStep,
} from "../e2e-packaged/overlay-diagnostics.ts";
import type * as Diagnostics from "../e2e-packaged/overlay-diagnostics.ts";
import {
  askToClose,
  forceEnd,
  windowsProcesses,
  type OverlayRead,
  type WindowsProcess,
} from "../e2e-packaged/windows.ts";

// Stand-ins for the Windows run's app, its process list, its close request,
// its debugging port and its temporary folder, for a write that fails and a
// read that is refused, and a watch on the teardown's record of the app's
// exit, which goes on to the real one; every other call is the real one.
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof ChildProcesses>();
  return {
    ...real,
    spawn: vi.fn(real.spawn),
    // Nothing here runs a command through it, `ps` or `tasklist` least of all: the
    // process list and the signals are stand-ins, and work a run left behind
    // that still reaches for them finds this instead.
    execFileSync: vi.fn((file: string) => {
      throw new Error(`stand-in: ${String(file).split(/[\\/]/).pop()} is not run in this test`);
    }),
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof Fs>();
  return {
    ...real,
    existsSync: vi.fn(real.existsSync),
    readFileSync: vi.fn(real.readFileSync),
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
vi.mock(import("../e2e-packaged/overlay-diagnostics.ts"), async (actual) => {
  const real = await actual();
  return { ...real, recordTeardownExit: vi.fn(real.recordTeardownExit) };
});
const realChildProcess = await vi.importActual<typeof ChildProcesses>("node:child_process");
const realFs = await vi.importActual<typeof Fs>("node:fs");
const realOs = await vi.importActual<typeof Os>("node:os");
const realDiagnostics = await vi.importActual<typeof Diagnostics>(
  "../e2e-packaged/overlay-diagnostics.ts",
);

/**
 * What stands in for the packaged app's world in one Windows run: the spawn
 * of its executable, its temporary folder, the close request, the forced end,
 * the process list, the debugging port and the teardown's record.
 */
type StandIns = {
  spawn: (file: string, args: readonly string[], options: object) => ChildProcess;
  tmpdir: () => string;
  askToClose: (pid: number) => string | null;
  forceEnd: (pid: number) => void;
  windowsProcesses: () => WindowsProcess[];
  debuggingPort: typeof debuggingPort;
  recordTeardownExit: typeof recordTeardownExit;
};

/**
 * The run the calling code belongs to, carried through its awaits and
 * timers: a teardown a run left behind keeps answering to that run's
 * stand-ins whatever run is open when it goes on, and never to another's.
 */
const runOf = new AsyncLocalStorage<StandIns>();
const standIns = () => runOf.getStore();
// Fixed once: each call goes to its own run's stand-in, and outside any run to the real one or an inert answer.
vi.mocked(spawn).mockImplementation(((file: string, args: readonly string[], options: object) =>
  (standIns()?.spawn ?? realChildProcess.spawn)(file, args, options)) as unknown as typeof spawn);
vi.mocked(tmpdir).mockImplementation(() => standIns()?.tmpdir() ?? realOs.tmpdir());
vi.mocked(askToClose).mockImplementation((pid) => standIns()?.askToClose(pid) ?? null);
vi.mocked(forceEnd).mockImplementation((pid) => standIns()?.forceEnd(pid));
vi.mocked(windowsProcesses).mockImplementation(() => standIns()?.windowsProcesses() ?? []);
vi.mocked(debuggingPort).mockImplementation(
  (...args) => standIns()?.debuggingPort(...args) ?? Promise.resolve(1),
);
vi.mocked(recordTeardownExit).mockImplementation((...args) =>
  (standIns()?.recordTeardownExit ?? realDiagnostics.recordTeardownExit)(...args),
);

/** What process.platform reads outside a run: this machine's, or one a test names, as for a Linux host. */
let hostPlatform: NodeJS.Platform = process.platform;
const platformProperty = Object.getOwnPropertyDescriptor(process, "platform")!;
// Code of a run, a teardown it left behind included, reads Windows, as the launch check does; the rest, the host.
Object.defineProperty(process, "platform", {
  configurable: true,
  enumerable: true,
  get: () => (standIns() ? "win32" : hostPlatform),
});
afterAll(() => Object.defineProperty(process, "platform", platformProperty));

const ROOT = join(import.meta.dirname, "..");
const AT = "2026-11-25T00:00:00.000Z";

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(existsSync).mockImplementation(realFs.existsSync);
  vi.mocked(readFileSync).mockImplementation(realFs.readFileSync);
  vi.mocked(rmSync).mockImplementation(realFs.rmSync);
  vi.mocked(writeFileSync).mockImplementation(realFs.writeFileSync);
  vi.mocked(execFileSync).mockClear();
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
  const real = ownedPath(dir);
  if (real) rmSync(real, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  owned.delete(dir);
}

/** `dir` while it is still there and still the folder `ownedTemp` made where it made it; throws if not. */
function ownedPath(dir: string): string | undefined {
  const made = owned.get(dir);
  if (!made) throw new Error("refusing to remove a folder this test did not make");
  if (!existsSync(dir)) return undefined;
  const real = realpathSync.native(dir);
  if (real !== dir || dirname(real) !== made.parent || !basename(real).startsWith(made.prefix))
    throw new Error("refusing to remove a folder that no longer resolves where it was made");
  return real;
}

/** How long a removal waits before it tries again. */
const RETRY_MS = 100;

/**
 * Removes a folder `ownedTemp` made, with the same checks as `removeOwned`,
 * one try at a time, each only while `left()` still gives time, the first
 * included. A folder still there then stays this test's, and the failure
 * says so.
 */
async function removeOwnedWithin(dir: string, left: () => number): Promise<void> {
  let failed: unknown;
  for (;;) {
    const real = ownedPath(dir);
    if (!real) return void owned.delete(dir);
    const budget = left();
    if (budget <= 0)
      throw new Error("the run's folder stays: it could not be removed in the time left", {
        cause: failed,
      });
    try {
      rmSync(real, { recursive: true, force: true });
    } catch (error) {
      failed = error;
    }
    if (!existsSync(real)) return void owned.delete(dir);
    await new Promise((resolve) => realSetTimeout(resolve, Math.min(RETRY_MS, budget)));
  }
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

/**
 * How long, in real time, which fake timers leave alone, a step that takes
 * moments may go unsettled before its test gives up on it and unwinds.
 */
const STALL_MS = 5_000;

/** `promise`, or a rejection naming `step` once it has gone `ms` unsettled. */
function bounded<T>(promise: Promise<T>, step: string, ms = STALL_MS): Promise<T> {
  let timer: ReturnType<typeof realSetTimeout> | undefined;
  const stalled = new Promise<never>((_resolve, reject) => {
    timer = realSetTimeout(() => reject(new Error(`${step} did not settle within ${ms} ms`)), ms);
  });
  return Promise.race([promise, stalled]).finally(() => realClearTimeout(timer));
}

/** The first error each child this test started reported, kept from its start so none goes unhandled. */
const childErrors = new WeakMap<ChildProcess, unknown>();

/** `child`, its errors kept from the moment it starts. */
function watched(child: ChildProcess): ChildProcess {
  child.on("error", (error) => {
    if (!childErrors.has(child)) childErrors.set(child, error);
  });
  return child;
}

/**
 * Resolves once Node reports that `child` exited, within `ms` of real time,
 * and on nothing else. Rejects if the child never started, if it reports an
 * error instead (as for a kill that failed) or if `failed` rejects first,
 * saying it is still running, and if no exit comes in time. The listeners it
 * adds go again whatever the outcome.
 */
function exitWithin(child: ChildProcess, ms: number, failed?: Promise<never>): Promise<void> {
  // Node gives a child that could not start a negative exit code: checked first, it is no exit.
  if (child.pid === undefined)
    return Promise.reject(
      new Error("the child never started, so it has no exit", { cause: childErrors.get(child) }),
    );
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const running = `the child (pid ${child.pid}) is still running`;
  let onExit = () => {};
  let onError = (_error: unknown) => {};
  const exit = new Promise<void>((resolve, reject) => {
    onExit = () => resolve();
    onError = (error) => reject(new Error(`${running}: it reported an error`, { cause: error }));
    child.once("exit", onExit);
    child.once("error", onError);
  });
  return bounded(
    Promise.race(failed ? [exit, failed] : [exit]),
    `${running}: its exit`,
    ms,
  ).finally(() => {
    child.off("exit", onExit);
    child.off("error", onError);
  });
}

/**
 * Ends a child this test started, by its handle alone, and resolves only
 * once Node reports its exit, within `ms` of real time. A child that never
 * started, a kill that throws or reports an error, and no exit in time each
 * reject: none of them is an exit.
 */
async function reap(child: ChildProcess, ms = STALL_MS): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null)
    return exitWithin(child, ms);
  let killFailed = (_error: Error) => {};
  const failed = new Promise<never>((_resolve, reject) => (killFailed = reject));
  const exit = exitWithin(child, ms, failed);
  try {
    child.kill();
  } catch (error) {
    killFailed(
      new Error(`the child (pid ${child.pid}) is still running: its kill threw`, { cause: error }),
    );
  }
  await exit;
}

/**
 * Runs each of `cleanups` in turn, whatever threw before, then throws the
 * first failure intact: the test's own in `failed`, if it had one. Each
 * cleanup that failed comes after it, as Vitest lists every error of an
 * AggregateError, or alone when nothing failed before.
 */
async function cleanUp(
  failed: { error: unknown } | undefined,
  ...cleanups: (() => unknown)[]
): Promise<void> {
  const failures = failed ? [failed.error] : [];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 1)
    throw new AggregateError(failures, "the first failure, then each cleanup that failed after it");
  if (failures.length === 1) throw failures[0];
}

/**
 * Throws, naming the keys that differ and never a value, unless the
 * CLAWTRATE_PACKAGED_ variables are `expected`: all of them, or with
 * `among`, just its keys. Inherited values may be a person's own paths.
 */
function expectPackagedEnv(
  expected: Record<string, string | undefined>,
  what: string,
  among?: string[],
): void {
  const now = packagedEnv();
  const keys = among ?? [...new Set([...Object.keys(now), ...Object.keys(expected)])];
  const differing = keys.filter((key) => now[key] !== expected[key]).sort();
  if (differing.length > 0)
    throw new Error(`${what}: the CLAWTRATE_PACKAGED_ variables differ at ${differing.join(", ")}`);
}

/** A synthetic filesystem error, as Node throws one, naming a path no warning may print. */
function fakeError(code: string) {
  const path = `C:\\fake-${randomBytes(6).toString("hex")}\\secret.json`;
  return {
    path,
    error: Object.assign(new Error(`${code}: failed, open '${path}'`), { code, path }),
  };
}

/** Makes every write to `file`, that one file and no other of the same name, throw `error`. */
function failWrites(file: string, error: Error): void {
  vi.mocked(writeFileSync).mockImplementation((path, ...rest) => {
    if (String(path) === file) throw error;
    return realFs.writeFileSync(path, ...rest);
  });
}

/**
 * Makes `file` one this process may not read, as Node sees it on Windows
 * without any real permissions: existsSync says it is not there, and a read
 * throws `error`.
 */
function denyReads(file: string, error: Error): void {
  vi.mocked(existsSync).mockImplementation((path) => path !== file && realFs.existsSync(path));
  const read = realFs.readFileSync as (path: Fs.PathOrFileDescriptor, options?: unknown) => unknown;
  vi.mocked(readFileSync).mockImplementation(((
    path: Fs.PathOrFileDescriptor,
    options?: unknown,
  ) => {
    if (path === file) throw error;
    return read(path, options);
  }) as typeof readFileSync);
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
      appExitWhenKept: "not reported",
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

  it("gives the exit the runner reported, says when none was only for a named record that is not there, and says when its record can't be read", async () => {
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
      const child = watched(
        spawn(process.execPath, ["-e", "process.exit(3)"], { stdio: "ignore" }),
      );
      reportExit(child, file);
      await exitWithin(child, STALL_MS);
      expect(reportedExit(file)).toEqual({ code: 3, signal: null });
      // The same record, once this process may not read it: not "not reported".
      denyReads(file, fakeError("EACCES").error);
      expect(reportedExit(file), "a record it may not read").toBe("unavailable");
    } finally {
      removeOwned(dir);
    }
  });

  it("keeps the reads when the exit record is torn, and nothing of the record", async () => {
    const dir = ownedTemp("clawtrate-overlay-torn-");
    try {
      const exitFile = join(dir, "app-exit.json");
      writeFileSync(exitFile, '{"code": 0, "signal": "C:\\\\Users\\\\someone');
      const info = { outputPath: (name: string) => join(dir, name) };
      const reads: OverlayRead[] = [{ at: AT, ms: 5_001, error: "timed out" }];
      writeOverlayReport(
        info as unknown as TestInfo,
        [step("set", "3 unread", 0, reads)],
        "catch",
        exitFile,
      );
      const text = readFileSync(join(dir, OVERLAY_REPORT), "utf8");
      expect(JSON.parse(text)).toMatchObject({
        phases: [{ outcomes: { "timed out": 1 } }],
        appExitWhenKept: "unavailable",
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
        failWrites(join(dir, OVERLAY_REPORT), error);
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

  /** A failed test's info, writing to `dir`, with its attachments. */
  const failedInfo = (dir: string, attach = vi.fn(async () => {})) => ({
    info: {
      outputPath: (name: string) => join(dir, name),
      attach,
      status: "failed",
      expectedStatus: "passed",
    } as unknown as TestInfo,
    attach,
  });

  it("keeps the steps a failed write left for afterEach, which writes and attaches them once", async () => {
    const dir = ownedTemp("clawtrate-overlay-retry-");
    try {
      const { info, attach } = failedInfo(dir);
      const printed = vi.spyOn(console, "error").mockImplementation(() => {});
      // The first write fails, as a file held for a moment does; the next is the real one.
      const { path, error } = fakeError("EBUSY");
      let writes = 0;
      vi.mocked(writeFileSync).mockImplementation((file, ...rest) => {
        if (String(file).endsWith(OVERLAY_REPORT) && ++writes === 1) throw error;
        return realFs.writeFileSync(file, ...rest);
      });
      const overlay = overlayEvidence("");
      overlay.begin().push(step("set", "3 unread", 0, []));
      await expect(overlay.failed(info)).resolves.toBeUndefined();
      expect(existsSync(join(dir, OVERLAY_REPORT))).toBe(false);
      expect(attach).not.toHaveBeenCalled();
      await expect(overlay.after(info)).resolves.toBeUndefined();
      expect(writes).toBe(2);
      expect(JSON.parse(readFileSync(join(dir, OVERLAY_REPORT), "utf8"))).toMatchObject({
        endedIn: "set",
        keptBy: "afterEach",
      });
      expect(attach.mock.calls).toEqual([
        ["taskbar-overlay", { path: join(dir, OVERLAY_REPORT), contentType: "application/json" }],
      ]);
      expect(printed.mock.calls).toEqual([
        ["the taskbar overlay report could not be kept (EBUSY)"],
      ]);
      expect(JSON.stringify(printed.mock.calls)).not.toContain(path);
    } finally {
      removeOwned(dir);
    }
  });

  it("leaves a report it wrote but could not attach on disk, and writes, attaches or warns no more", async () => {
    const dir = ownedTemp("clawtrate-overlay-attach-");
    try {
      const { path, error } = fakeError("EPERM");
      const { info, attach } = failedInfo(
        dir,
        vi.fn(async () => {
          throw error;
        }),
      );
      const printed = vi.spyOn(console, "error").mockImplementation(() => {});
      let writes = 0;
      vi.mocked(writeFileSync).mockImplementation((file, ...rest) => {
        if (String(file).endsWith(OVERLAY_REPORT)) writes += 1;
        return realFs.writeFileSync(file, ...rest);
      });
      const overlay = overlayEvidence("");
      overlay.begin().push(step("set", "3 unread", 0, []));
      await expect(overlay.failed(info)).resolves.toBeUndefined();
      await expect(overlay.after(info)).resolves.toBeUndefined();
      expect(writes).toBe(1);
      expect(attach).toHaveBeenCalledOnce();
      expect(JSON.parse(readFileSync(join(dir, OVERLAY_REPORT), "utf8"))).toMatchObject({
        keptBy: "catch",
      });
      expect(printed.mock.calls).toEqual([
        ["the taskbar overlay report was kept but not attached (EPERM)"],
      ]);
      expect(JSON.stringify(printed.mock.calls)).not.toContain(path);
    } finally {
      removeOwned(dir);
    }
  });

  it("names the app's exit by when the report was kept, which for afterEach can be after the failure", async () => {
    const dir = ownedTemp("clawtrate-overlay-kept-");
    try {
      const exitFile = join(dir, "app-exit.json");
      const { info } = failedInfo(dir);
      const overlay = overlayEvidence(exitFile);
      overlay.begin().push({ ...step("set", "3 unread", 0, []), badgeCallReturned: false });
      // The test timed out with no exit reported; the app ended before afterEach ran.
      expect(reportedExit(exitFile)).toBe("not reported");
      writeFileSync(exitFile, JSON.stringify({ code: 0, signal: null }));
      await overlay.after(info);
      const report = JSON.parse(readFileSync(join(dir, OVERLAY_REPORT), "utf8"));
      expect(report).toMatchObject({
        keptBy: "afterEach",
        appExitWhenKept: { code: 0, signal: null },
      });
      expect(report).not.toHaveProperty("appExitAtFailure");
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

  it("writes the teardown's exit beside the next report when one can't take it, asking for the last exit once", async () => {
    const dir = ownedTemp("clawtrate-overlay-sidecars-");
    try {
      // Two projects' output folders, in this order, each with a report.
      const outputDirs = [join(dir, "first"), join(dir, "second")];
      const [bad, good] = outputDirs.map((out) => join(out, "launch-shows-unread-tasks"));
      for (const folder of [bad!, good!]) {
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, OVERLAY_REPORT), "{}");
      }
      // A folder where the first record goes: a real EISDIR, no permissions needed.
      mkdirSync(join(bad!, TEARDOWN_EXIT));
      const printed = vi.spyOn(console, "error").mockImplementation(() => {});
      const exit = { beforeClose: "not reported", afterClose: "not asked" } as const;
      const last = vi.fn(async () => ({ code: 0, signal: null }));
      await expect(recordTeardownExit(outputDirs, exit, last)).resolves.toBeUndefined();
      expect(last).toHaveBeenCalledOnce();
      expect(JSON.parse(readFileSync(join(good!, TEARDOWN_EXIT), "utf8"))).toEqual({
        ...exit,
        lastReported: { code: 0, signal: null },
      });
      expect(printed.mock.calls).toEqual([
        ["how the app quit could not be recorded beside the overlay report (EISDIR)"],
      ]);
      expect(JSON.stringify(printed.mock.calls)).not.toContain(basename(dir));
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
    let failed: { error: unknown } | undefined;
    try {
      app = recordExit(
        watched(
          spawn(
            process.execPath,
            ["-e", "process.stdin.on('end', () => process.exit(0)).resume()"],
            {
              stdio: ["pipe", "ignore", "ignore"],
            },
          ),
        ),
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
      // Playwright compiles the config and the spec into a cache in the temporary
      // folder, or wherever this process's environment points it. This run keeps it
      // in the test's folder, which the finally below removes, pass or fail.
      const cache = join(dir, "transform-cache");
      const run = spawnSync(
        process.execPath,
        [join(ROOT, "node_modules/@playwright/test/cli.js"), "test", "-c", "overlay.config.mjs"],
        {
          cwd: dir,
          encoding: "utf8",
          timeout: 90_000,
          env: { ...runnerEnv(exitFile), PLAYWRIGHT_TRANSFORM_CACHE_DIR: cache },
        },
      );
      const output = run.stdout + run.stderr;
      expect(run.status, output).toBe(1);
      expect(existsSync(cache), "the runner's cache is in the test's folder").toBe(true);
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
        appExitWhenKept: "not reported",
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
        appExitWhenKept: "not reported",
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
        report("reads-only-time-out").appExitWhenKept,
        "what the report read when it was kept stays as it was",
      ).toBe("not reported");
    } catch (error) {
      failed = { error };
    }
    await cleanUp(
      failed,
      () => app && reap(app),
      () => removeOwned(dir),
    );
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
      expectPackagedEnv(seeds, "the seeds alone");
      const seen = spawnSync(
        process.execPath,
        [
          "-e",
          "console.log(JSON.stringify(Object.entries(process.env).filter(([key]) => key.toUpperCase().startsWith('CLAWTRATE_PACKAGED_'))))",
        ],
        { env: runnerEnv(exitFile), encoding: "utf8" },
      );
      const handed = JSON.parse(seen.stdout) as [string, string][];
      expect(
        handed.map(([key]) => key),
        "what the runner was handed, by key",
      ).toEqual(["CLAWTRATE_PACKAGED_EXIT"]);
      expect(handed[0]?.[1] === exitFile, "the exit file this run named").toBe(true);
    } finally {
      restorePackagedEnv(outer);
    }
    expectPackagedEnv(outer, "after the test");
  });
});

// The Windows global setup itself, as the launch check starts it, with a
// stand-in app and stand-ins for the process list and the close request.
// Each test gets STALL_MS for its own steps, a run as long again to clean
// up after them, and as long again to spare, so a stall fails inside the
// test and its run unwinds there.
describe("the Windows teardown", { timeout: 3 * STALL_MS }, () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

  type Stand = {
    /** What the close request answers; it lets the app quit either way. */
    refusal?: string | null;
    /** When the app quits: once asked to close (the default), once the teardown asks for its last exit, or never. */
    quits?: "when asked to close" | "when its exit is asked for" | "never";
    /** The process list; by default the app, while Node has not reported its exit. */
    listing?: (app: WindowsProcess | null) => WindowsProcess[];
    /** Whether a failed overlay check left its report. */
    report?: boolean;
    /** Whether the packaged executable is there. */
    exe?: boolean;
    /** The debugging port the setup waits for, given what the setup passes it. */
    port?: typeof debuggingPort;
    /** How long the test's own steps may take, in real time: STALL_MS but in tests of the run itself. */
    steps?: number;
    /** How long the run's cleanup may take in all, in real time: STALL_MS but in tests of the run itself. */
    cleanup?: number;
  };
  type Run = {
    /** The setup, once, while the run is open; it resolves to the teardown, which the same holds for. */
    setup: () => Promise<() => Promise<void>>;
    root: string;
    sidecar: string;
    /** The arguments the setup launched its app with, and the stand-in this run started for it. */
    launched: () => { args: string[]; app: ChildProcess } | undefined;
    /** How often the teardown asked for the app's last exit: the only call that waits for it. */
    exitAsks: () => number;
    /**
     * Settles once the teardown asks for the app's last exit and that wait has
     * begun. Rejects if the teardown settles first, with its own verdict as
     * the cause.
     */
    exitAsked: () => Promise<void>;
  };

  /**
   * The stand-in app: it quits when its input ends, which this test does at
   * the moment it chooses, however late the app started; or it never quits.
   */
  const standIn = (quits: boolean) =>
    quits
      ? "process.stdin.on('end', () => process.exit(0)).resume()"
      : "setInterval(() => {}, 1000)";

  /**
   * Runs the Windows global setup, and `use` with it, in a folder of this
   * test's own that the setup's temporary folder is made in.
   *
   * The run is open while `use` runs, for STALL_MS of real time at most. It
   * closes before anything else when `use` ends or runs out of time: from then
   * on no setup, teardown or request starts, a setup still waiting on its
   * debugging port never resumes, and every promise the test was given that
   * is still pending rejects. Then, within one cleanup budget of STALL_MS, the
   * stand-in app is ended by its handle, and the setup and teardown the test
   * started are let end: one that rejected without the test ever looking is a
   * failure, one still running is too. Each stand-in, the exit listeners, the
   * platform and the CLAWTRATE_PACKAGED_ variables are then put back, each on
   * its own; the folder is removed unless the app may still be running; and
   * the variables are checked, by key alone, against a canary planted first.
   * The test's own failure stays the first one thrown, any later ones after
   * it. Returns the stand-in app, if the setup started one.
   */
  async function windowsRun(
    stand: Stand,
    use: (run: Run) => Promise<void>,
  ): Promise<ChildProcess | undefined> {
    const failures: unknown[] = [];
    const attempt = async (step: () => unknown) => {
      try {
        await step();
      } catch (error) {
        failures.push(error);
      }
    };
    // Put back last first, each whatever the others did.
    const undo: (() => unknown)[] = [];
    const listeners = process.listeners("exit");
    const canary = `CLAWTRATE_PACKAGED_CANARY_${randomBytes(4).toString("hex").toUpperCase()}`;
    process.env[canary] = `canary-${randomBytes(8).toString("hex")}`;
    const saved = packagedEnv();
    undo.push(() => restorePackagedEnv(saved));
    let root: string | undefined;
    let app: ChildProcess | undefined;

    let open = true;
    let closeWith = (_reason: Error) => {};
    const closed = new Promise<never>((_resolve, reject) => (closeWith = reject));
    closed.catch(() => {});
    /** Closes the run, before anything else happens: once only, for the first reason. */
    const close = (reason: string) => {
      if (!open) return;
      open = false;
      closeWith(new Error(reason));
    };
    /** A step the run will not take: a rejection, no work done, handled should the test never look. */
    const refuse = (message: string) => {
      const refused = Promise.reject(new Error(message));
      refused.catch(() => {});
      return refused;
    };
    const over = (what: string) => refuse(`${what} was asked for after the run ended`);

    /**
     * The setup, the teardown, the requests and the refusals the test was
     * given; whether it ever looked at each, and whether each settled while
     * the run was open, so that what it looked at was that outcome itself.
     */
    const given: {
      what: string;
      work: Promise<unknown>;
      settled: boolean;
      settledOpen: boolean;
      looked: boolean;
      parked: () => boolean;
    }[] = [];
    /** `work`'s outcome, for the test until the run closes; the run notes whether the test looks at it. */
    const give = <T>(what: string, work: Promise<T>, parked = () => false): Promise<T> => {
      const entry = { what, work, settled: false, settledOpen: false, looked: false, parked };
      given.push(entry);
      const settle = () => {
        entry.settled = true;
        entry.settledOpen = open;
      };
      work.then(settle, settle);
      const result = Promise.race([work, closed]);
      result.catch(() => {});
      return new Proxy(result, {
        get(target, key) {
          if (key === "then" || key === "catch") entry.looked = true;
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };

    // The port answers only while the run is open: a setup still waiting on it
    // then waits for good, so nothing of it changes anything once the run is over.
    let portsWaiting = 0;
    const whileOpen = <T>(answer: Promise<T>) =>
      new Promise<T>((resolve, reject) => {
        portsWaiting += 1;
        answer.then(
          (value) => {
            if (!open) return;
            portsWaiting -= 1;
            resolve(value);
          },
          (error: unknown) => {
            if (!open) return;
            portsWaiting -= 1;
            reject(error);
          },
        );
      });

    let timer: ReturnType<typeof realSetTimeout> | undefined;
    try {
      root = ownedTemp("clawtrate-windows-teardown-");
      const report = join(root, "out", "launch-shows-unread-tasks");
      mkdirSync(report, { recursive: true });
      if (stand.report !== false) writeFileSync(join(report, OVERLAY_REPORT), "{}");
      mkdirSync(join(root, "app"));
      if (stand.exe !== false) writeFileSync(join(root, "app", "Clawtrate.exe"), "");
      process.env.CLAWTRATE_PACKAGED_APP = join(root, "app");
      const quits = stand.quits ?? "when asked to close";
      let listed: WindowsProcess | null = null;
      let launched: { args: string[]; app: ChildProcess } | undefined;
      // The real record, told each time the teardown asks for the app's last exit.
      let exitAsks = 0;
      let firstAsk = () => {};
      const exitAsked = new Promise<void>((resolve) => (firstAsk = resolve));
      let spawned = false;
      const own: StandIns = {
        // In place of the packaged executable only, started by the real spawn, never the stand-in's;
        // outside the run's own folder, which Windows would not remove while it is a running app's.
        spawn: (file, args, options) => {
          if (spawned) return realChildProcess.spawn(file, args, options);
          spawned = true;
          app = watched(
            realChildProcess.spawn(process.execPath, ["-e", standIn(quits !== "never")], {
              cwd: root,
              stdio: [quits === "never" ? "ignore" : "pipe", "ignore", "ignore"],
            }),
          );
          listed = { pid: app.pid!, ppid: process.pid, command: args.join(" ") };
          launched = { args: [...args], app };
          return app;
        },
        tmpdir: () => root!,
        askToClose: () => {
          if (quits === "when asked to close") app?.stdin?.end();
          return stand.refusal ?? null;
        },
        forceEnd: () => {},
        // Once the run closes the list names nothing: a teardown still polling it stops at its
        // next look, before anything is put back, and keeps its own verdict. Whether the app
        // ended is the run's to report, as it reaps it.
        windowsProcesses: () => {
          if (!open) return [];
          const running = app && exitOf(app) === "not reported" ? listed : null;
          return stand.listing ? stand.listing(running) : running ? [running] : [];
        },
        debuggingPort: (...args) =>
          whileOpen(stand.port ? stand.port(...args) : Promise.resolve(1)),
        recordTeardownExit: (dirs, exit, lastReported) =>
          realDiagnostics.recordTeardownExit(dirs, exit, () => {
            exitAsks += 1;
            const reported = lastReported();
            if (quits === "when its exit is asked for") app?.stdin?.end();
            firstAsk();
            return reported;
          }),
      };
      // No calls, nor the children and paths in them, kept once the run is over.
      for (const stand of [spawn, tmpdir, askToClose, forceEnd, windowsProcesses, debuggingPort])
        undo.push(() => vi.mocked(stand).mockClear());
      undo.push(() => vi.mocked(recordTeardownExit).mockClear());
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      undo.push(() => log.mockRestore());
      undo.push(() => {
        for (const listener of process.listeners("exit"))
          if (!listeners.includes(listener)) process.off("exit", listener);
      });
      const config = { projects: [{ outputDir: join(root, "out") }] } as unknown as FullConfig;
      let setUp = false;
      let teardown: Promise<void> | undefined;
      const run: Run = {
        setup: () => {
          if (!open) return over("the setup");
          if (setUp) return give("a second setup", refuse("the setup was already started"));
          setUp = true;
          const settingUp = globalSetup(config).then((done) => () => {
            if (!open) return over("the teardown");
            if (teardown)
              return give("a second teardown", refuse("the teardown was already started"));
            teardown = (done as () => Promise<void>)();
            return give("the teardown", teardown);
          });
          return give("the setup", settingUp, () => portsWaiting > 0);
        },
        root,
        sidecar: join(report, TEARDOWN_EXIT),
        launched: () => launched,
        exitAsks: () => exitAsks,
        exitAsked: () => {
          if (!open) return over("the teardown's request for the app's last exit");
          if (!teardown)
            return give("a request with no teardown", refuse("no teardown was started"));
          const first = teardown.then(
            () =>
              Promise.reject(
                new Error("the teardown ended before it asked for the app's last exit"),
              ),
            (verdict: unknown) =>
              Promise.reject(
                new Error("the teardown failed before it asked for the app's last exit", {
                  cause: verdict,
                }),
              ),
          );
          return give(
            "the teardown's request for the app's last exit",
            Promise.race([exitAsked, first]),
          );
        },
      };
      const steps = stand.steps ?? STALL_MS;
      timer = realSetTimeout(() => {
        const waiting = given.filter((entry) => !entry.settled).map((entry) => entry.what);
        close(
          `the test's steps did not finish within ${steps} ms${waiting.length ? `, waiting on ${waiting.join(", ")}` : ""}`,
        );
      }, steps);
      await Promise.race([runOf.run(own, () => use(run)), closed]);
    } catch (error) {
      failures.push(error);
    } finally {
      realClearTimeout(timer);
      close("the test's steps ended");
    }

    await attempt(() => vi.useRealTimers());
    const deadline = performance.now() + (stand.cleanup ?? STALL_MS);
    const left = () => Math.max(0, Math.floor(deadline - performance.now()));
    await attempt(() => app && reap(app, left()));
    // Once the app is gone, what the test started ends; a setup parked at its port never will.
    for (const entry of given) {
      if (entry.parked()) continue;
      await attempt(async () => {
        const outcome = await bounded(
          entry.work.then(
            () => ({ rejected: false, reason: undefined as unknown }),
            (reason: unknown) => ({ rejected: true, reason }),
          ),
          `${entry.what}, once the run ended,`,
          left(),
        );
        if (outcome.rejected && !entry.looked)
          throw new Error(`the test never checked how ${entry.what} ended`, {
            cause: outcome.reason,
          });
        if (outcome.rejected && !entry.settledOpen)
          throw new Error(
            `${entry.what} ended only after the run closed, so the test never had that`,
            {
              cause: outcome.reason,
            },
          );
      });
    }
    for (const step of undo.reverse()) await attempt(step);
    const mayRun = app && app.pid !== undefined && app.exitCode === null && app.signalCode === null;
    await attempt(() => {
      if (mayRun) throw new Error("the run's folder stays: its app may still be running");
      if (root) return removeOwnedWithin(root, left);
    });
    await attempt(() => expectPackagedEnv(saved, "after the run"));
    await attempt(() => delete process.env[canary]);
    if (failures.length > 1)
      throw new AggregateError(failures, "the first failure, then each that came after it");
    if (failures.length === 1) throw failures[0];
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
    let failed: { error: unknown } | undefined;
    try {
      // Only these, under these spellings: what was inherited is cleared first.
      restorePackagedEnv(names);
      expectPackagedEnv(names, "the inherited ones alone");
      // No packaged executable: the setup fails before it makes a folder or sets a variable.
      const none = await windowsRun({ exe: false }, async ({ setup }) => {
        await expect(setup()).rejects.toThrow("does not exist");
        expectPackagedEnv(names, "while the setup failed", Object.keys(names));
      });
      expect(none, "no app started").toBeUndefined();
      // No debugging port: the setup fails after naming its folder and starting the app,
      // its own, with its own user-data folder and arguments.
      const started = await windowsRun(
        { port: async () => Promise.reject(new Error("stand-in: no debugging port")) },
        async ({ setup, root, launched }) => {
          await expect(setup()).rejects.toThrow("stand-in: no debugging port");
          expect(
            dirname(process.env.CLAWTRATE_PACKAGED_PLACE ?? "") === root,
            "its place, in this run's folder",
          ).toBe(true);
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
      expect(
        process.env.Clawtrate_Packaged_Place === inherited,
        "the inherited place, under its own spelling",
      ).toBe(true);
      expectPackagedEnv(names, "after the runs");

      // The test fails while its stand-in app runs: that app alone is ended, and
      // the test's own error is the one thrown.
      const bystander = watched(
        realChildProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          stdio: "ignore",
        }),
      );
      let failedWhileRunning: { error: unknown } | undefined;
      try {
        let own: ChildProcess | undefined;
        await expect(
          windowsRun({ quits: "never" }, async ({ setup, launched }) => {
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
      } catch (error) {
        failedWhileRunning = { error };
      }
      await cleanUp(failedWhileRunning, () => reap(bystander));
    } catch (error) {
      failed = { error };
    }
    await cleanUp(
      failed,
      () => restorePackagedEnv(outer),
      () => removeOwned(inherited),
    );
    expectPackagedEnv(outer, "after the test");
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
        { refusal: "ERROR: stand-in refusal", quits: "when its exit is asked for", listing },
        async ({ setup, sidecar, exitAsks, exitAsked }) => {
          const teardown = await setup();
          // The wait's own timer stands still, so only the app's exit can end it.
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          const running = teardown();
          await exitAsked();
          expect(vi.getTimerCount(), "the record waits, bounded by a timer").toBe(1);
          // The checks' own verdict, as before.
          await expect(running).rejects.toThrow(failure);
          expect(exitAsks()).toBe(1);
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
    const app = await windowsRun(
      { refusal: "ERROR: stand-in refusal", quits: "never", listing: () => [] },
      async ({ setup, sidecar, exitAsks, exitAsked }) => {
        const teardown = await setup();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const running = teardown();
        await exitAsked();
        expect(vi.getTimerCount(), "the record waits, bounded by a timer").toBe(1);
        await vi.advanceTimersByTimeAsync(949);
        expect(vi.getTimerCount(), "still waiting after 949 ms").toBe(1);
        await vi.advanceTimersByTimeAsync(5_000 - 1 - 949);
        expect(vi.getTimerCount(), "done waiting before 5 s").toBe(0);
        await expect(running).rejects.toThrow("asking the app to close failed");
        expect(exitAsks()).toBe(1);
        expect(JSON.parse(readFileSync(sidecar, "utf8")).lastReported).toBe("not reported");
      },
    );
    expect(app && exitOf(app), "ended by the test, by its handle").not.toBe("not reported");
  });

  it("asks for no exit, and so waits for none, when there is no report to write it beside", async () => {
    await windowsRun(
      { refusal: "ERROR: stand-in refusal", quits: "never", listing: () => [], report: false },
      async ({ setup, sidecar, exitAsks }) => {
        const teardown = await setup();
        await expect(teardown()).rejects.toThrow("asking the app to close failed");
        expect(exitAsks(), "the app's last exit is never asked for").toBe(0);
        expect(existsSync(sidecar)).toBe(false);
      },
    );
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
        async ({ setup, sidecar }) => {
          const teardown = await setup();
          const { path, error } = fakeError(code);
          failWrites(sidecar, error);
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

  it.each([
    [
      "while the run cleans up, as it reaps the app",
      () => ({
        port: ((_userData, app) =>
          new Promise((resolve) => app.once("exit", () => resolve(1)))) as typeof debuggingPort,
        answerLate: () => {},
      }),
    ],
    [
      "once the run is over, however that went",
      () => {
        let answer = (_port: number) => {};
        return {
          port: (() => new Promise((resolve) => (answer = resolve))) as typeof debuggingPort,
          answerLate: () => answer(1),
        };
      },
    ],
  ])(
    "lets a setup whose debugging port answers late change no variable, when it answers %s",
    async (_when, late) => {
      const outer = packagedEnv();
      const { port, answerLate } = late();
      const run = windowsRun({ port }, async ({ setup }) => {
        void setup();
      });
      await run.then(
        () => {},
        () => {},
      );
      answerLate();
      await new Promise((resolve) => setImmediate(resolve));
      expectPackagedEnv(outer, "after the late answer");
      const app = await run;
      expect(app && exitOf(app), "ended by its handle").not.toBe("not reported");
    },
  );

  it("closes the run before anything else once the test's steps run out of time: a port answering after that changes nothing, and the run says what it was waiting on", async () => {
    const outer = packagedEnv();
    let app: ChildProcess | undefined;
    await expect(
      windowsRun(
        {
          steps: 100,
          port: (_userData, child) =>
            new Promise((resolve) => child.once("exit", () => resolve(1))),
        },
        async ({ setup, launched }) => {
          void setup();
          app = launched()?.app;
          await new Promise(() => {});
        },
      ),
    ).rejects.toThrow("the test's steps did not finish within 100 ms, waiting on the setup");
    expectPackagedEnv(outer, "after the run");
    expect(app && exitOf(app), "ended by its handle").not.toBe("not reported");
  });

  it("does no work for a setup or teardown asked for twice, or once the run is over, and spawns nothing for it", async () => {
    const outer = packagedEnv();
    let setup: (() => Promise<() => Promise<void>>) | undefined;
    let teardown: (() => Promise<void>) | undefined;
    await windowsRun({}, async (run) => {
      ({ setup } = run);
      teardown = await run.setup();
      await expect(run.setup()).rejects.toThrow("the setup was already started");
      await expect(teardown()).resolves.toBeUndefined();
      await expect(teardown()).rejects.toThrow("the teardown was already started");
    });
    await expect(setup!()).rejects.toThrow("the setup was asked for after the run ended");
    await expect(teardown!()).rejects.toThrow("the teardown was asked for after the run ended");
    expect(vi.mocked(spawn), "nothing spawned once the run was over").not.toHaveBeenCalled();
    expectPackagedEnv(outer, "after the late calls");
  });

  it("fails a run whose test never checked how its teardown ended, with that verdict as the cause", async () => {
    await expect(
      windowsRun({ refusal: "ERROR: stand-in refusal", listing: () => [] }, async ({ setup }) => {
        const teardown = await setup();
        void teardown();
      }),
    ).rejects.toMatchObject({
      message: "the test never checked how the teardown ended",
      cause: { message: expect.stringContaining("asking the app to close failed") },
    });
  });

  it("puts back the variables, the platform and every stand-in though one step of putting back fails, and reports that failure", async () => {
    const outer = packagedEnv();
    const before = process.listeners("exit");
    const planted = new Error("stand-in: a listener could not be removed");
    const off = process.off.bind(process);
    const refusing = vi.spyOn(process, "off").mockImplementation(((
      event: string | symbol,
      listener: (...args: unknown[]) => void,
    ) => {
      if (event === "exit") throw planted;
      return off(event, listener);
    }) as typeof process.off);
    let failure: unknown;
    try {
      failure = await windowsRun({}, async ({ setup }) => {
        await (
          await setup()
        )();
      }).catch((error: unknown) => error);
    } finally {
      refusing.mockRestore();
      for (const listener of process.listeners("exit"))
        if (!before.includes(listener)) process.off("exit", listener);
    }
    expect(failure).toBe(planted);
    expectPackagedEnv(outer, "after the run");
    expect(Object.getOwnPropertyDescriptor(process, "platform"), "as it was").toEqual(platform);
    expect(process.platform).toBe(hostPlatform);
    expect(tmpdir() === realOs.tmpdir(), "the real temporary folder").toBe(true);
    for (const stand of [askToClose, forceEnd, windowsProcesses, recordTeardownExit, spawn])
      expect(vi.mocked(stand).mock.calls.length, "no calls, nor the children in them, kept").toBe(
        0,
      );
  });

  it("names only which CLAWTRATE_PACKAGED_ variables differ, never a value", () => {
    const outer = packagedEnv();
    const key = `CLAWTRATE_PACKAGED_CANARY_${randomBytes(4).toString("hex").toUpperCase()}`;
    const sentinel = `sentinel-${randomBytes(8).toString("hex")}`;
    let thrown: unknown;
    process.env[key] = sentinel;
    try {
      expectPackagedEnv(outer, "a stand-in check");
    } catch (error) {
      thrown = error;
    } finally {
      delete process.env[key];
    }
    expect(thrown).toBeInstanceOf(Error);
    const shown = [String(thrown), (thrown as Error).stack, inspect(thrown, { depth: null })].join(
      "\n",
    );
    expect(shown.includes(sentinel), "the value is never shown").toBe(false);
    expect(shown.includes(key), "the key is").toBe(true);
  });

  /** A child whose kill is its own, so nothing is signalled. */
  const fakeChild = (kill: (child: EventEmitter) => boolean) => {
    const child = Object.assign(new EventEmitter(), { pid: -1, exitCode: null, signalCode: null });
    return Object.assign(child, { kill: () => kill(child) }) as unknown as ChildProcess;
  };
  const thrown = new Error("stand-in: the kill threw");
  // As Node reports a kill it could not deliver: false, then an error event.
  const refused = Object.assign(new Error("stand-in: the kill was refused"), { code: "EPERM" });
  /** A child that could not start, its error kept. */
  const missing = async () => {
    const child = watched(
      realChildProcess.spawn(
        join(realOs.tmpdir(), `clawtrate-missing-${randomBytes(4).toString("hex")}.exe`),
      ),
    );
    await new Promise((resolve) => child.once("error", resolve));
    return child;
  };
  it.each([
    [
      "rejects, with its start's error, when it never started",
      missing,
      (reaped: Promise<void>) =>
        expect(reaped).rejects.toMatchObject({
          message: "the child never started, so it has no exit",
          cause: { code: "ENOENT" },
        }),
    ],
    [
      "rejects, saying it still runs, when its kill throws",
      async () =>
        fakeChild(() => {
          throw thrown;
        }),
      (reaped: Promise<void>) =>
        expect(reaped).rejects.toMatchObject({
          message: "the child (pid -1) is still running: its kill threw",
          cause: thrown,
        }),
    ],
    [
      "rejects, saying it still runs, when its kill is refused",
      async () => fakeChild((child) => (queueMicrotask(() => child.emit("error", refused)), false)),
      (reaped: Promise<void>) =>
        expect(reaped).rejects.toMatchObject({
          message: "the child (pid -1) is still running: it reported an error",
          cause: refused,
        }),
    ],
    [
      "rejects, saying it still runs, once its bound passes with no exit",
      async () => fakeChild(() => true),
      (reaped: Promise<void>) =>
        expect(reaped).rejects.toThrow(
          "the child (pid -1) is still running: its exit did not settle within 50 ms",
        ),
    ],
    [
      "resolves on an exit reported after a kill that found the child gone",
      async () => fakeChild((child) => (queueMicrotask(() => child.emit("exit", 0, null)), false)),
      (reaped: Promise<void>) => expect(reaped).resolves.toBeUndefined(),
    ],
  ])(
    "reaps a child by its handle alone, under a real bound: it %s, and keeps no listener of its own",
    async (_case, child, outcome) => {
      const started = await child();
      const before = { exit: started.listenerCount("exit"), error: started.listenerCount("error") };
      // Three times over, as a run's cleanup and a test's own may each ask.
      for (let time = 0; time < 3; time += 1) {
        await outcome(reap(started, 50));
        expect({
          exit: started.listenerCount("exit"),
          error: started.listenerCount("error"),
        }).toEqual(before);
      }
    },
  );

  it("never waits on a report child that could not start, and writes no exit for it", async () => {
    const dir = ownedTemp("clawtrate-report-child-");
    try {
      const file = join(dir, "app-exit.json");
      const child = await missing();
      reportExit(child, file);
      await expect(exitWithin(child, STALL_MS)).rejects.toThrow(
        "the child never started, so it has no exit",
      );
      expect(child.listenerCount("error"), "only the one that keeps its error").toBe(1);
      expect(existsSync(file)).toBe(false);
    } finally {
      removeOwned(dir);
    }
  });

  it("keeps the test's own failure first and intact when a cleanup fails after it, and still runs every cleanup", async () => {
    const planted = new Error("stand-in: the test failed");
    const later = new Error("stand-in: a cleanup failed");
    const ran: string[] = [];
    await expect(cleanUp({ error: planted }, () => ran.push("a"))).rejects.toBe(planted);
    const both = (await cleanUp(
      { error: planted },
      () => {
        ran.push("b");
        throw later;
      },
      () => ran.push("c"),
    ).catch((error: unknown) => error)) as AggregateError;
    expect(both).toBeInstanceOf(AggregateError);
    expect(both.errors[0]).toBe(planted);
    expect(both.errors[1]).toBe(later);
    expect(both.errors).toHaveLength(2);
    await expect(cleanUp(undefined, () => Promise.reject(later))).rejects.toBe(later);
    expect(ran).toEqual(["a", "b", "c"]);

    // In a run, whose app's kill throws, once it has signalled the app, as the
    // run cleans up after the test's failure: the app counts as still running.
    const outer = packagedEnv();
    let app: ChildProcess | undefined;
    let root = "";
    let failedHere: { error: unknown } | undefined;
    try {
      const failure = (await windowsRun({ quits: "never" }, async (run) => {
        await run.setup();
        ({ root } = run);
        app = run.launched()?.app;
        const kill = app!.kill.bind(app);
        app!.kill = (signal) => {
          kill(signal);
          throw later;
        };
        throw planted;
      }).catch((error: unknown) => error)) as AggregateError;
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.errors[0], "the test's own failure, first and intact").toBe(planted);
      expect(failure.errors.map((error) => (error as Error).message)).toEqual([
        planted.message,
        `the child (pid ${app!.pid}) is still running: its kill threw`,
        "the run's folder stays: its app may still be running",
      ]);
      expectPackagedEnv(outer, "put back all the same");
    } catch (error) {
      failedHere = { error };
    }
    // Its app, signalled before the kill threw, is reaped by the same handle; then its folder goes.
    await cleanUp(failedHere, ...endLeft(() => app && { app, root }));
  });

  /** Runs `use` with the platform reading `host` outside a run, as on a machine of that kind, and puts it back. */
  async function onHost<T>(host: NodeJS.Platform, use: () => Promise<T>): Promise<T> {
    const real = hostPlatform;
    hostPlatform = host;
    try {
      return await use();
    } finally {
      hostPlatform = real;
    }
  }

  it.each(["win32", "linux"] as const)(
    "stops a teardown polling a stale process list as the run closes, so nothing of it polls once things are put back (on %s)",
    async (host) => {
      let polls = 0;
      let polled = () => {};
      const polling = new Promise<void>((resolve) => (polled = resolve));
      // The app's own row, kept after it quit: the teardown would poll it for ten seconds.
      let stale: WindowsProcess | undefined;
      const run = onHost(host, () =>
        windowsRun(
          {
            listing: () => {
              polls += 1;
              if (stale) polled();
              return stale ? [stale] : [];
            },
          },
          async ({ setup, launched }) => {
            const teardown = await setup();
            const { app, args } = launched()!;
            stale = { pid: app.pid!, ppid: process.pid, command: args.join(" ") };
            void teardown();
            await polling;
          },
        ),
      );
      const app = await run;
      expect(app && exitOf(app), "ended by its handle").not.toBe("not reported");
      const after = polls;
      // Two polls' time: a teardown still polling would have asked again.
      await new Promise((resolve) => realSetTimeout(resolve, 450));
      expect(polls, "no poll once the run was over").toBe(after);
      expect(vi.mocked(execFileSync), "no command, on any platform").not.toHaveBeenCalled();
    },
  );

  /** A run whose app outlived it, and what the test knows of that run. */
  type Left = {
    app: ChildProcess;
    root: string;
    sidecar?: string;
    /** How often its teardown asked for the app's last exit, where it has one. */
    asks?: () => number;
    failure?: unknown;
  };

  /**
   * A run whose app outlives it: the app's kill throws and signals nothing,
   * so the run cannot end it, and its teardown is left waiting on that app.
   */
  async function leaveRun(): Promise<Left | undefined> {
    let left: Left | undefined;
    const failure = await windowsRun({ quits: "never", cleanup: 300 }, async (run) => {
      const teardown = await run.setup();
      const { app } = run.launched()!;
      left = { app, root: run.root, sidecar: run.sidecar, asks: run.exitAsks };
      app.kill = () => {
        throw new Error("stand-in: the kill failed");
      };
      void teardown().then(
        () => {},
        () => {},
      );
    }).catch((error: unknown) => error);
    return left && { ...left, failure };
  }

  /**
   * The cleanup of a run left behind, each step whatever came before: its
   * app's own kill put back, its exit seen by its handle and recorded by its
   * teardown, and only then its folder removed. A folder whose app was not
   * seen to exit stays, and the failure says so.
   */
  const endLeft = (left: () => Left | undefined) => [
    () => {
      const kept = left();
      if (kept) delete (kept.app as { kill?: unknown }).kill;
    },
    async () => {
      const kept = left();
      if (!kept) return;
      await reap(kept.app);
      const asks = kept.asks;
      if (asks)
        await vi.waitFor(() => expect(asks(), "its teardown's record").toBe(1), {
          timeout: STALL_MS,
        });
    },
    () => {
      const kept = left();
      if (!kept) return;
      if (exitOf(kept.app) === "not reported")
        throw new Error("the left run's folder stays: its app was not seen to exit");
      removeOwned(kept.root);
    },
  ];

  it.each(["win32", "linux"] as const)(
    "binds what a teardown does after the run to that run: it reads Windows and its own stand-ins, and reaches no command (on %s)",
    async (host) => {
      let left: Left | undefined;
      let failed: { error: unknown } | undefined;
      try {
        await onHost(host, async () => {
          left = await leaveRun();
          // Its app ends now, by its own handle, and the teardown goes on, the run over and all put back.
          delete (left!.app as { kill?: unknown }).kill;
          await reap(left!.app);
          await vi.waitFor(
            () => expect(left!.asks!(), "its own run's record, asked at last").toBe(1),
            {
              timeout: STALL_MS,
            },
          );
        });
        expect(
          (left!.failure as AggregateError).errors.map((error) => (error as Error).message),
        ).toEqual([
          `the child (pid ${left!.app.pid}) is still running: its kill threw`,
          expect.stringMatching(/^the teardown, once the run ended, did not settle within \d+ ms$/),
          "the run's folder stays: its app may still be running",
        ]);
        expect(vi.mocked(windowsProcesses), "its own run's process list").toHaveBeenCalled();
        expect(vi.mocked(execFileSync), "no command, on any platform").not.toHaveBeenCalled();
      } catch (error) {
        failed = { error };
      }
      await cleanUp(failed, ...endLeft(() => left));
    },
  );

  it("keeps the timeout first, then the teardown's own verdict, which came only after the run closed", async () => {
    const failure = (await windowsRun({ quits: "never", steps: 300 }, async ({ setup }) => {
      const teardown = await setup();
      await teardown();
    }).catch((error: unknown) => error)) as AggregateError;
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors.map((error) => (error as Error).message)).toEqual([
      "the test's steps did not finish within 300 ms, waiting on the teardown",
      "the teardown ended only after the run closed, so the test never had that",
    ]);
    expect(String((failure.errors[1] as Error).cause)).toContain("the app exited with SIGTERM");
  });

  it("fails a run whose test ignored a refusal: a setup asked for twice", async () => {
    await expect(
      windowsRun({}, async (run) => {
        const teardown = await run.setup();
        void run.setup();
        await teardown();
      }),
    ).rejects.toMatchObject({
      message: "the test never checked how a second setup ended",
      cause: { message: "the setup was already started" },
    });
  });

  it("removes the run's folder only within the time its cleanup has left, and says the folder stays when it could not, after the test's own failure", async () => {
    const planted = new Error("stand-in: the test failed");
    let root = "";
    // A folder that stays locked: each try fails as Windows fails one in use,
    // and one asked to retry blocks for its retries first, as Node's does.
    vi.mocked(rmSync).mockImplementation((path, options) => {
      if (String(path) !== root) return realFs.rmSync(path, options);
      const { maxRetries = 0, retryDelay = 100 } = options ?? {};
      const blocked = (retryDelay * maxRetries * (maxRetries + 1)) / 2;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, blocked);
      throw Object.assign(new Error("EBUSY: resource busy or locked, rmdir"), { code: "EBUSY" });
    });
    const failure = (await windowsRun({ cleanup: 300 }, async (run) => {
      ({ root } = run);
      await (
        await run.setup()
      )();
      throw planted;
    }).catch((error: unknown) => error)) as AggregateError;
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors[0], "the test's own failure, first and intact").toBe(planted);
    expect(failure.errors.map((error) => (error as Error).message).slice(1)).toEqual([
      "the run's folder stays: it could not be removed in the time left",
    ]);
    expect(existsSync(root), "still there, and still this test's").toBe(true);
    vi.mocked(rmSync).mockImplementation(realFs.rmSync);
    removeOwned(root);
  });

  it.each(["win32", "linux"] as const)(
    "leaves a second run alone when a first run's teardown goes on during it: its close, process list, record, app, the one write meant to fail and putting back (on %s)",
    async (host) => {
      let left: Left | undefined;
      let secondPolls = 0;
      let failed: { error: unknown } | undefined;
      try {
        await onHost(host, async () => {
          left = await leaveRun();
          await windowsRun(
            {
              refusal: "ERROR: stand-in refusal",
              quits: "when its exit is asked for",
              listing: () => {
                secondPolls += 1;
                return [];
              },
            },
            async (run) => {
              const teardown = await run.setup();
              const secondApp = run.launched()!.app;
              // This run's own record is the one write that fails; the first run's still goes through.
              failWrites(run.sidecar, fakeError("EACCES").error);
              const printed = vi.spyOn(console, "error").mockImplementation(() => {});
              // The first app ends now, by its own handle: its teardown goes on, inside this run.
              delete (left!.app as { kill?: unknown }).kill;
              await reap(left!.app);
              // Until that teardown asks for an exit, of either run's record, well inside this run's steps.
              await vi.waitFor(() => expect(left!.asks!() + run.exitAsks()).toBe(1), {
                timeout: STALL_MS / 2,
              });
              expect(left!.asks!(), "the first run's own record").toBe(1);
              expect(
                JSON.parse(readFileSync(left!.sidecar!, "utf8")),
                "the first run's record, written where it belongs",
              ).toEqual({
                beforeClose: "not reported",
                afterClose: { code: null, signal: "SIGTERM" },
                lastReported: { code: null, signal: "SIGTERM" },
              });
              expect(printed, "no write of the first run's failed").not.toHaveBeenCalled();
              expect(secondPolls, "this run's process list, never polled").toBe(0);
              expect(run.exitAsks(), "this run's record, never asked").toBe(0);
              expect(
                vi.mocked(askToClose),
                "this run's app, never asked to close",
              ).not.toHaveBeenCalled();
              expect(exitOf(secondApp), "this run's app, still running").toBe("not reported");
              // Then this run's own teardown, whose record alone can't be written.
              await expect(teardown()).rejects.toThrow(
                "asking the app to close failed: ERROR: stand-in refusal",
              );
              expect(printed.mock.calls).toEqual([
                ["how the app quit could not be recorded beside the overlay report (EACCES)"],
              ]);
              expect(existsSync(run.sidecar), "this run's record, not written").toBe(false);
            },
          );
        });
        expect(vi.mocked(execFileSync), "no command, on any platform").not.toHaveBeenCalled();
      } catch (error) {
        failed = { error };
      }
      await cleanUp(failed, ...endLeft(() => left));
      expect(Object.hasOwn(left!.app, "kill"), "its own kill, back").toBe(false);
      expect(existsSync(left!.root), "its folder, removed once its app was seen to exit").toBe(
        false,
      );
    },
  );

  it.each(["win32", "linux"] as const)(
    "ends a first run's app and folder though a second run's setup is refused, keeping that refusal first and leaving a bystander alone (on %s)",
    async (host) => {
      const bystander = watched(
        realChildProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          stdio: "ignore",
        }),
      );
      let left: Left | undefined;
      let failed: { error: unknown } | undefined;
      try {
        await onHost(host, async () => {
          left = await leaveRun();
          await windowsRun({ exe: false }, async ({ setup }) => {
            await setup();
          });
        });
      } catch (error) {
        failed = { error };
      }
      const outcome = await cleanUp(failed, ...endLeft(() => left)).then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        expect(outcome, "the refused setup, first and alone").toBeInstanceOf(Error);
        expect((outcome as Error).message).toContain("does not exist");
        expect(exitOf(left!.app), "the first app, seen to exit").not.toBe("not reported");
        expect(Object.hasOwn(left!.app, "kill"), "its own kill, back").toBe(false);
        expect(existsSync(left!.root), "its folder, removed once its app was seen to exit").toBe(
          false,
        );
        expect(exitOf(bystander), "the bystander, never signalled").toBe("not reported");
      } finally {
        await reap(bystander);
      }
    },
  );

  it("counts a refusal the test caught and checked as checked, and one it ignored as not", async () => {
    await expect(
      windowsRun({}, async (run) => {
        const teardown = await run.setup();
        await run
          .setup()
          .catch((error: unknown) =>
            expect((error as Error).message).toBe("the setup was already started"),
          );
        await teardown();
      }),
    ).resolves.toBeDefined();
    await expect(
      windowsRun({}, async (run) => {
        const teardown = await run.setup();
        void run.setup();
        await teardown();
      }),
    ).rejects.toThrow("the test never checked how a second setup ended");
  });

  it("makes no try at removing a folder once its budget is spent, the first try included, and keeps it this test's", async () => {
    const dir = ownedTemp("clawtrate-removal-budget-");
    let tries = 0;
    vi.mocked(rmSync).mockImplementation((path, options) => {
      if (String(path) !== dir) return realFs.rmSync(path, options);
      tries += 1;
      throw Object.assign(new Error("EBUSY: resource busy or locked, rmdir"), { code: "EBUSY" });
    });
    try {
      // None from the start: no try at all.
      await expect(removeOwnedWithin(dir, () => 0)).rejects.toThrow(
        "the run's folder stays: it could not be removed in the time left",
      );
      expect(tries).toBe(0);
      // Time for one try, then none once it has slept: that one try alone.
      const budgets = [100];
      await expect(removeOwnedWithin(dir, () => budgets.shift() ?? 0)).rejects.toThrow(
        "the run's folder stays",
      );
      expect(tries).toBe(1);
      // Time for two tries, then none: a try each time while time remains, and no more.
      const twice = [100, 100];
      await expect(removeOwnedWithin(dir, () => twice.shift() ?? 0)).rejects.toThrow(
        "the run's folder stays",
      );
      expect(tries).toBe(3);
      expect(existsSync(dir), "still there").toBe(true);
    } finally {
      vi.mocked(rmSync).mockImplementation(realFs.rmSync);
    }
    // Still this test's to remove.
    removeOwned(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it("makes no removal try in a run whose cleanup has no time left, and says the folder stays, after the test's own failure", async () => {
    const planted = new Error("stand-in: the test failed");
    let root = "";
    let tries = 0;
    vi.mocked(rmSync).mockImplementation((path, options) => {
      if (String(path) === root) tries += 1;
      return realFs.rmSync(path, options);
    });
    const failure = (await windowsRun({ cleanup: 0 }, async (run) => {
      ({ root } = run);
      await (
        await run.setup()
      )();
      throw planted;
    }).catch((error: unknown) => error)) as AggregateError;
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors[0], "the test's own failure, first and intact").toBe(planted);
    expect(failure.errors.map((error) => (error as Error).message).slice(1)).toEqual([
      "the run's folder stays: it could not be removed in the time left",
    ]);
    expect(tries, "no try").toBe(0);
    vi.mocked(rmSync).mockImplementation(realFs.rmSync);
    removeOwned(root);
  });
});
