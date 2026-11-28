// What an end-to-end run created, saved as it goes so the run itself, or the
// next run in the same checkout after a crash, can remove exactly that.
//
// Every process is judged alive, exited or unknown (state-guard.ts). Unknown
// never authorises anything: the record and the temporary folders stay, and
// the reason is reported.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  processIdentity,
  processVerdict,
  validPid,
  type Identify,
} from "../tools/dev-gateway/src/state-guard.ts";

export const TEMP_PREFIX = "clawtrate-e2e-";

export type Proc = { pid: number; identity: string };

export type RunRecord = {
  run: string;
  runner: Proc;
  /** Each instance with the run id this run gave it, written before its start. */
  instances: { name: string; runId: string }[];
  /** Written before the preview host is spawned; it is gated until `host` is written. */
  hostPending?: true;
  host: Proc | null;
  /** A newer build a test starts on the host's data folder, written before it runs. */
  successor?: Proc;
  dirs: string[];
};

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export const recordPath = (dir: string, run: string) => join(dir, `${run}.json`);

export function saveRecord(dir: string, record: RunRecord): void {
  mkdirSync(dir, { recursive: true });
  const temp = `${recordPath(dir, record.run)}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(temp, recordPath(dir, record.run));
}

const isProc = (p: unknown): p is Proc =>
  p !== null &&
  typeof p === "object" &&
  validPid((p as Proc).pid) &&
  typeof (p as Proc).identity === "string" &&
  (p as Proc).identity !== "";

export function readRecord(path: string): RunRecord | null {
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as RunRecord;
    if (
      /^[0-9a-f]{8}$/.test(record.run) &&
      isProc(record.runner) &&
      (record.host === null || isProc(record.host)) &&
      (record.successor === undefined || isProc(record.successor)) &&
      (record.hostPending === undefined || record.hostPending === true) &&
      Array.isArray(record.instances) &&
      // Only this run's own instances, each with a run id of the tool's format.
      record.instances.every(
        (entry) =>
          (entry?.name === `e2e-${record.run}` ||
            entry?.name === `e2e-${record.run}-other` ||
            entry?.name === `e2e-${record.run}-acct` ||
            entry?.name === `e2e-${record.run}-computer` ||
            // The bot voice check's own instance (e2e/bot-voice.spec.ts).
            entry?.name === `e2e-${record.run}-voice` ||
            // The setup checks' own instance, recorded by e2e/setup.spec.ts.
            entry?.name === `e2e-${record.run}-setup` ||
            // The skill-review instance, recorded by e2e/skill-notes.spec.ts.
            entry?.name === `e2e-${record.run}-skills`) &&
          typeof entry.runId === "string" &&
          /^[0-9a-f]{48}$/.test(entry.runId),
      ) &&
      Array.isArray(record.dirs)
    ) {
      return record;
    }
  } catch {
    // unreadable: left alone
  }
  return null;
}

/**
 * Present once the run's cleanup has started: no newer build may start after it.
 * It outlives the record, since a test that read the record before the cleanup
 * can save it again after the cleanup removed it. It names the run's runner, and
 * a later run removes it once that runner, and so its tests, are proven gone.
 */
const closingPath = (path: string) => `${path}.closing`;

/**
 * Records a newer build started on the run's data folder, so the run's cleanup
 * stops it too. The test that starts it runs in a worker and the cleanup in the
 * runner, so each writes its mark before reading the other's
 * (`successorAtCleanUp`): either this call sees that cleanup has started and
 * throws, and the caller never releases the build, or the cleanup reads the
 * build in the record and stops it.
 */
export function recordSuccessor(
  path: string,
  successor: Proc,
  identify: Identify = processIdentity,
): void {
  const record = readRecord(path);
  if (!record) throw new Error(`${path} is not a run record`);
  saveRecord(dirname(path), { ...record, successor });
  // A later run removes the mark only once the runner is dead, so with no mark a live runner
  // means the cleanup has yet to start and will read the build.
  if (
    existsSync(closingPath(path)) ||
    processVerdict(record.runner.pid, record.runner.identity, identify).state === "dead"
  )
    throw new Error("the run's cleanup has started, so the newer build may not start");
}

/**
 * Starts the run's cleanup for newer builds, then returns the one a test recorded, if any.
 * The runner calls it with itself, so the mark names it even when the record is already gone.
 */
export function successorAtCleanUp(path: string, runner: Proc): Proc | undefined {
  writeFileSync(closingPath(path), JSON.stringify(runner));
  return readRecord(path)?.successor;
}

/** A temporary folder a run may have created: directly in the system temp folder, with our prefix. */
export const isRunTempDir = (dir: unknown): dir is string =>
  typeof dir === "string" && dirname(dir) === tmpdir() && basename(dir).startsWith(TEMP_PREFIX);

/**
 * Remove everything a record lists, synchronously, so it also works from a
 * signal or exit handler. The preview host is signalled only while it is
 * still the recorded process, and its folders are removed only once it is
 * proven gone; if that cannot be determined, nothing of it is touched. Each
 * instance goes through `reset` by name and run id, which proves
 * its processes itself. Returns what could not be cleaned up; the record is
 * removed only when nothing is left.
 */
export function cleanUp(
  dir: string,
  record: RunRecord,
  reset: (name: string, runId: string) => void,
  identify: Identify = processIdentity,
  hostStopMs = 10_000,
): string[] {
  const problems: string[] = [];
  // A pending host without a record never ran: its gate opens only after the record.
  let hostGone = true;
  const hosts = [
    ...(record.host ? [{ proc: record.host, label: "the preview host" }] : []),
    ...(record.successor ? [{ proc: record.successor, label: "the newer build" }] : []),
  ];
  for (const { proc, label } of hosts) {
    const { pid, identity } = proc;
    let verdict = processVerdict(pid, identity, identify);
    if (verdict.state === "alive") {
      process.kill(pid, "SIGTERM");
      const deadline = Date.now() + hostStopMs;
      // Through "unknown" too: a lookup can fail for a moment while a process exits.
      while (verdict.state !== "dead" && Date.now() < deadline) {
        sleepSync(100);
        verdict = processVerdict(pid, identity, identify);
      }
    }
    if (verdict.state !== "dead") {
      hostGone = false;
      problems.push(
        verdict.state === "alive"
          ? `${label} (pid ${pid}) did not exit after SIGTERM; its folders are kept`
          : `could not determine whether ${label} (pid ${pid}) is running: ${verdict.reason}; its folders are kept`,
      );
    }
  }
  if (hostGone) {
    for (const path of record.dirs) {
      if (isRunTempDir(path)) rmSync(path, { recursive: true, force: true });
    }
  }
  for (const { name, runId } of [...record.instances].reverse()) {
    try {
      reset(name, runId);
    } catch (error) {
      problems.push(`reset ${name}: ${String(error)}`);
    }
  }
  if (problems.length === 0) rmSync(recordPath(dir, record.run), { force: true });
  return problems;
}

/**
 * Clean up this checkout's earlier runs that were killed and could not clean
 * up themselves: only those whose runner is proven gone. A run whose runner is
 * running, or cannot be checked, is left alone with its record.
 */
export function recoverDeadRuns(
  dir: string,
  reset: (name: string, runId: string) => void,
  log: (line: string) => void = console.log,
  identify: Identify = processIdentity,
): void {
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => /^[0-9a-f]{8}\.json$/.test(file));
  } catch {
    return;
  }
  for (const file of files) {
    const record = readRecord(join(dir, file));
    if (!record) {
      log(`Left ${file} alone: it is not a run record this version wrote`);
      continue;
    }
    const runner = processVerdict(record.runner.pid, record.runner.identity, identify);
    if (runner.state === "alive") continue;
    if (runner.state === "unknown") {
      log(
        `Left end-to-end run ${record.run} alone: could not determine whether it is still running (${runner.reason})`,
      );
      continue;
    }
    log(`Cleaning up interrupted end-to-end run ${record.run}`);
    const problems = cleanUp(dir, record, reset, identify);
    for (const problem of problems) log(problem);
  }
  forgetFinishedCleanUps(dir, identify);
}

/** Removes the cleanup marks of runs whose record is gone and whose runner is proven gone. */
function forgetFinishedCleanUps(dir: string, identify: Identify): void {
  for (const file of readdirSync(dir).filter((name) => /^[0-9a-f]{8}\.json\.closing$/.test(name))) {
    const mark = join(dir, file);
    if (existsSync(mark.slice(0, -".closing".length))) continue;
    let runner: unknown;
    try {
      runner = JSON.parse(readFileSync(mark, "utf8"));
    } catch {
      continue;
    }
    if (isProc(runner) && processVerdict(runner.pid, runner.identity, identify).state === "dead")
      rmSync(mark, { force: true });
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Removes what earlier runs left in Playwright's output folder (`results`), where each run
 * writes its traces and failure screenshots to `<results>/<run>/`. A run that passed leaves
 * nothing to read, so its folder goes. A run that did not pass (failed, interrupted, timed
 * out) stays for a day, and the newest run that failed stays whatever its age, so a rerun
 * that is stopped never takes the failure a person is reading. A run with no
 * `.last-run.json`, still going or killed, goes once its folder is a day old.
 */
export function pruneRunOutputs(results: string, own: string, now = Date.now()): void {
  if (!existsSync(results)) return;
  const runs = readdirSync(results).flatMap((run) => {
    if (!/^[0-9a-f]{8}$/.test(run) || run === own) return [];
    const dir = join(results, run);
    const last = join(dir, ".last-run.json");
    try {
      const { status } = JSON.parse(readFileSync(last, "utf8")) as { status?: unknown };
      return [{ dir, status, at: statSync(last).mtimeMs }];
    } catch {
      // Another run starting in this checkout may have removed the folder since it was listed.
      const stat = statSync(dir, { throwIfNoEntry: false });
      return stat ? [{ dir, status: undefined, at: stat.mtimeMs }] : [];
    }
  });
  const newestFailed = runs.filter((run) => run.status === "failed").sort((a, b) => b.at - a.at)[0];
  for (const run of runs) {
    const old = now - run.at > DAY_MS;
    const goes = run.status === "passed" || (old && run !== newestFailed);
    if (goes) rmSync(run.dir, { recursive: true, force: true });
  }
}
