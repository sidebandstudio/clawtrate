// What a failed taskbar overlay check keeps (#448), as files in the test's own
// output folder, which CI uploads with the rest of test-results/. A body-only
// attachment lives in the reporters' memory and the list reporter writes no
// file of it, and Playwright's error context says only what the poll last
// returned: `undefined` for a read that failed or timed out.
import type { TestInfo } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OverlayRead } from "./windows.ts";

/** The report's name in the test's output folder. */
export const OVERLAY_REPORT = "taskbar-overlay.json";
/** How the app quit at teardown, written beside each report after the test's worker is gone. */
export const TEARDOWN_EXIT = "app-exit-at-teardown.json";

/**
 * How the app ended, as Node reported it to the runner that started it;
 * "not reported" if no exit has been seen yet, which does not show the app
 * still runs; "unavailable" if the runner's record of it could not be read.
 */
export type AppExit =
  { code: number | null; signal: string | null } | "not reported" | "unavailable";

/** One step of the check: the overlay it waits for, since when, whether the badge call returned, and its reads. */
export type OverlayStep = {
  phase: "set" | "clear";
  expected: string;
  started: number;
  badgeCallReturned: boolean;
  reads: OverlayRead[];
};

/**
 * How the app had ended when the teardown came to ask it to close, once
 * asked ("not asked" if it had already ended or the request could not be
 * sent), and as last reported when the teardown finished.
 */
export type TeardownExit = {
  beforeClose: AppExit;
  afterClose: AppExit | "not asked";
  lastReported: AppExit;
};

/** The app's exit as far as Node has reported it. */
export function exitOf(child: ChildProcess): AppExit {
  return child.exitCode !== null || child.signalCode !== null
    ? { code: child.exitCode, signal: child.signalCode }
    : "not reported";
}

/**
 * The exit the runner wrote to `file` (`reportExit`): "not reported" while it
 * has written none, and "unavailable", with nothing of the file kept, if no
 * file is named, it can't be read or it holds no exit status. The file is
 * read, not checked for first: on Windows a check says "not there" also for a
 * file it may not read.
 */
export function reportedExit(file: string): AppExit {
  try {
    const { code, signal } = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const validCode = code === null || Number.isInteger(code);
    const validSignal =
      signal === null || (typeof signal === "string" && /^SIG[A-Z0-9]+$/.test(signal));
    if (validCode && validSignal && (code !== null || signal !== null))
      return { code: code as number | null, signal: signal as string | null };
  } catch (problem) {
    if (file && (problem as { code?: unknown } | null)?.code === "ENOENT") return "not reported";
    // unreadable, torn or not JSON
  }
  return "unavailable";
}

/** The description the app gives its overlay (apps/desktop/src/main/badge.ts). */
const APP_DESCRIPTION = /^\d{1,6} unread$/;

/** A read as the report gives it: other text than the app's own description by its length alone. */
function described(read: OverlayRead, expected: string) {
  const { at, ms } = read;
  if ("error" in read) return { at, ms, outcome: read.error };
  if (read.value === null) return { at, ms, outcome: "no button" };
  if (read.value === expected) return { at, ms, outcome: "expected" };
  if (read.value === "") return { at, ms, outcome: "empty" };
  return APP_DESCRIPTION.test(read.value)
    ? { at, ms, outcome: "other text", text: read.value }
    : { at, ms, outcome: "other text", length: read.value.length };
}

/**
 * What the check saw, phase by phase, the one it ended in last: how long
 * each ran, whether its badge call returned, how often each outcome came and
 * its last ten reads; then who kept the report and the app's exit when it
 * was kept. An afterEach hook keeps it after the test's timeout, so that exit
 * may be one that came after the failure.
 */
export function overlayReport(
  steps: OverlayStep[],
  keptBy: "catch" | "afterEach",
  appExitWhenKept: AppExit,
  now = Date.now(),
) {
  const phases = steps.map((step, index) => {
    const reads = step.reads.map((read) => described(read, step.expected));
    const outcomes: Record<string, number> = {};
    for (const { outcome } of reads) outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    return {
      phase: step.phase,
      expected: step.expected,
      ms: (steps[index + 1]?.started ?? now) - step.started,
      badgeCallReturned: step.badgeCallReturned,
      outcomes,
      lastReads: reads.slice(-10),
    };
  });
  return { endedIn: steps.at(-1)?.phase ?? null, phases, keptBy, appExitWhenKept };
}

/** Writes the report into the test's output folder, and returns where. */
export function writeOverlayReport(
  info: TestInfo,
  steps: OverlayStep[],
  keptBy: "catch" | "afterEach",
  exitFile: string,
): string {
  const file = info.outputPath(OVERLAY_REPORT);
  const report = overlayReport(steps, keptBy, reportedExit(exitFile));
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

/**
 * The check's steps, written as a report once and attached from there: by the
 * check's catch at its failure, or by an afterEach hook if the test timed out
 * before reaching it, as when a badge call never returns, or if the catch
 * could not write it. Nothing is kept for a test that passed. Keeping it
 * never throws, so the test fails with its own error.
 */
export function overlayEvidence(exitFile: string) {
  let pending: OverlayStep[] | null = null;
  const keep = async (info: TestInfo, keptBy: "catch" | "afterEach") => {
    if (!pending) return;
    let file: string;
    try {
      file = writeOverlayReport(info, pending, keptBy, exitFile);
    } catch (problem) {
      // Still pending, so afterEach tries again.
      console.error(`the taskbar overlay report could not be kept${codeOf(problem)}`);
      return;
    }
    // On disk now: nothing writes or attaches it again, whatever the attachment does.
    pending = null;
    try {
      await info.attach("taskbar-overlay", { path: file, contentType: "application/json" });
    } catch (problem) {
      console.error(`the taskbar overlay report was kept but not attached${codeOf(problem)}`);
    }
  };
  return {
    /** The steps of a check starting now. */
    begin: (): OverlayStep[] => (pending = []),
    /** From the check's catch. */
    failed: (info: TestInfo) => keep(info, "catch"),
    /** From afterEach: keeps what is left only of a test that did not pass. */
    after: async (info: TestInfo) => {
      if (info.status !== info.expectedStatus) await keep(info, "afterEach");
      pending = null;
    },
  };
}

/**
 * Writes `exit` beside every overlay report under the run's output folders,
 * apart from the exit the report read when it was kept: the runner may see the
 * app end only after the test's worker is gone. `lastReported` is asked once,
 * and only when there is a report to write it beside. Never throws; a write
 * that fails is printed, so it neither fails a clean run nor hides another
 * failure, and the next report still gets its record.
 */
export async function recordTeardownExit(
  outputDirs: string[],
  exit: Omit<TeardownExit, "lastReported">,
  lastReported: () => Promise<AppExit>,
): Promise<void> {
  const warn = (problem: unknown) =>
    console.error(
      `how the app quit could not be recorded beside the overlay report${codeOf(problem)}`,
    );
  try {
    const folders = outputDirs
      .filter((dir) => existsSync(dir))
      .flatMap((dir) => readdirSync(dir, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name === OVERLAY_REPORT)
      .map((entry) => entry.parentPath);
    if (folders.length === 0) return;
    const record: TeardownExit = { ...exit, lastReported: await lastReported() };
    for (const folder of folders) {
      try {
        writeFileSync(join(folder, TEARDOWN_EXIT), `${JSON.stringify(record, null, 2)}\n`);
      } catch (problem) {
        warn(problem);
      }
    }
  } catch (problem) {
    warn(problem);
  }
}

/** The filesystem error codes a warning may name: an error's message names paths. */
const PRINTABLE_CODES = new Set([
  "EACCES",
  "EBUSY",
  "EEXIST",
  "EISDIR",
  "EMFILE",
  "ENAMETOOLONG",
  "ENOENT",
  "ENOSPC",
  "ENOTDIR",
  "EPERM",
  "EROFS",
]);

/** " (CODE)" for an error with one of those codes, else nothing. */
function codeOf(problem: unknown): string {
  const code = (problem as { code?: unknown } | null)?.code;
  return typeof code === "string" && PRINTABLE_CODES.has(code) ? ` (${code})` : "";
}
