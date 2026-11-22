// What an end-to-end run created, saved as it goes so the run itself, or the
// next run in the same checkout after a crash, can remove exactly that.
//
// Every process is judged alive, exited or unknown (state-guard.ts). Unknown
// never authorises anything: the record and the temporary folders stay, and
// the reason is reported.

import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
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
  /** Written by cleanup before it reads the copies tests started: no copy may start after it. */
  teardown?: true;
  dirs: string[];
};

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export const recordPath = (dir: string, run: string) => join(dir, `${run}.json`);

/**
 * The copies of the app a run's tests started, such as a newer build on the
 * host's data folder, one per line beside the record. Tests only append to it
 * and never write the record, so no write replaces another.
 */
const copiesPath = (recordFile: string) => recordFile.replace(/\.json$/, ".copies");

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
      (record.teardown === undefined || record.teardown === true) &&
      (record.hostPending === undefined || record.hostPending === true) &&
      Array.isArray(record.instances) &&
      // Only this run's own instances, each with a run id of the tool's format.
      record.instances.every(
        (entry) =>
          (entry?.name === `e2e-${record.run}` ||
            entry?.name === `e2e-${record.run}-other` ||
            entry?.name === `e2e-${record.run}-acct`) &&
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
 * Records a copy of the app a test started, before it runs, so the run's
 * cleanup stops it too. Throws once cleanup has begun, and the caller then
 * never lets the copy run: cleanup marks the record before it reads the
 * copies, and this reads the record after it appends, so a copy cleanup has
 * not seen always sees the mark.
 */
export function recordSuccessor(path: string, successor: Proc): void {
  if (!readRecord(path)) throw new Error(`${path} is not a run record`);
  appendFileSync(copiesPath(path), `${JSON.stringify(successor)}\n`);
  if (readRecord(path)?.teardown !== undefined) throw new Error("the run's teardown has begun");
}

/** The copies a run's tests recorded. A line cut short is a copy whose gate never opened. */
function recordedCopies(path: string): Proc[] {
  let lines: string[];
  try {
    lines = readFileSync(copiesPath(path), "utf8").split("\n");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return lines.flatMap((line) => {
    try {
      const copy: unknown = JSON.parse(line);
      return isProc(copy) ? [copy] : [];
    } catch {
      return [];
    }
  });
}

/** A temporary folder a run may have created: directly in the system temp folder, with our prefix. */
export const isRunTempDir = (dir: unknown): dir is string =>
  typeof dir === "string" && dirname(dir) === tmpdir() && basename(dir).startsWith(TEMP_PREFIX);

/**
 * Remove everything a record lists, synchronously, so it also works from a
 * signal or exit handler. The record is first marked so that no test starts
 * another copy of the app. The preview host and each copy are signalled only
 * while still the recorded process, and the folders are removed only once
 * they are proven gone; if that cannot be determined, nothing of it is touched. Each
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
  saveRecord(dir, { ...record, teardown: true });
  // A pending host without a record never ran: its gate opens only after the record.
  let hostGone = true;
  const hosts = [
    ...(record.host ? [{ proc: record.host, label: "the preview host" }] : []),
    ...recordedCopies(recordPath(dir, record.run)).map((proc) => ({
      proc,
      label: "the copy a test started",
    })),
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
  if (problems.length === 0) {
    rmSync(copiesPath(recordPath(dir, record.run)), { force: true });
    rmSync(recordPath(dir, record.run), { force: true });
  }
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
}
