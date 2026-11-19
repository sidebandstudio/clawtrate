// Starting `ssh`: an argument array, never a shell, the world's environment
// (without the agent when it is "none"), output read in memory within limits,
// a time limit, and an end by PID that waits for the process to be gone.

import { type ChildProcess, spawn } from "node:child_process";

import { MAX_SSH_PROCESSES } from "@clawtrate/core";

import { childEnv, type SshWorld } from "./world.ts";

export type Spawn = (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => ChildProcess;

/** The children whose "close" has been seen. */
const closed = new WeakSet<ChildProcess>();

export const defaultSpawn: Spawn = (file, args, env) =>
  spawn(file, args, { env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });

/** The processes this module started and has not yet seen end, at most `MAX_SSH_PROCESSES`. */
export class ProcessTable {
  readonly running = new Set<ChildProcess>();
  readonly spawnProcess: Spawn;

  constructor(spawnProcess: Spawn = defaultSpawn) {
    this.spawnProcess = spawnProcess;
  }

  start(world: SshWorld, args: readonly string[]): ChildProcess {
    if (this.running.size >= MAX_SSH_PROCESSES) throw new Error("Too many ssh processes at once.");
    const child = this.spawnProcess(world.ssh, args, childEnv(world));
    child.once("close", () => closed.add(child));
    if (child.pid !== undefined) {
      this.running.add(child);
      child.once("close", () => this.running.delete(child));
    }
    return child;
  }

  /** Ends every process still running, by PID, and resolves once each is gone. */
  async endAll(): Promise<void> {
    await Promise.all([...this.running].map((child) => endProcess(child)));
  }
}

/** Ends `child` by its PID: TERM, then KILL after `graceMs`; resolves once it has closed. */
export function endProcess(child: ChildProcess, graceMs = 2000): Promise<void> {
  return new Promise((resolve) => {
    if (closed.has(child)) {
      resolve();
      return;
    }
    const hard = setTimeout(() => child.kill("SIGKILL"), graceMs);
    child.once("close", () => {
      clearTimeout(hard);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

export type RunResult = {
  exit: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Standard output went past `maxStdout`; what was read is dropped. */
  overflow: boolean;
  /** `stopWhen` said enough, and the process was ended. */
  stopped: boolean;
  cancelled: boolean;
  /** `ssh` could not be started at all. */
  spawnFailed: boolean;
};

export type RunOptions = {
  stdin?: string;
  timeoutMs: number;
  maxStdout: number;
  maxStderr?: number;
  /** Called as error output arrives; true ends the process. */
  stopWhen?: (stderr: string) => boolean;
  signal?: AbortSignal;
};

/** Runs `ssh` once with `args`, and reads what it says within the limits. */
export function runSsh(
  table: ProcessTable,
  world: SshWorld,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  const maxStderr = options.maxStderr ?? 64 * 1024;
  return new Promise((resolve) => {
    const none = { exit: null, stdout: "", stderr: "", timedOut: false, overflow: false };
    let child: ChildProcess;
    try {
      child = table.start(world, args);
    } catch {
      // The program could not be started, or the table is full: a result, never an exception.
      resolve({ ...none, stopped: false, cancelled: false, spawnFailed: true });
      return;
    }
    let settled = false;
    let stdout = "";
    let stderr = "";
    let overflow = false;
    let timedOut = false;
    let stopped = false;
    let cancelled = false;
    const finish = () => endProcess(child);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (overflow) return;
      stdout += chunk;
      if (stdout.length > options.maxStdout) {
        overflow = true;
        stdout = "";
        void finish();
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < maxStderr) stderr = (stderr + chunk).slice(0, maxStderr);
      if (!stopped && options.stopWhen?.(stderr)) {
        stopped = true;
        void finish();
      }
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.stdin ?? "");
    const timer = setTimeout(() => {
      timedOut = true;
      void finish();
    }, options.timeoutMs);
    const abort = () => {
      cancelled = true;
      void finish();
    };
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    const done = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    child.once("error", () => {
      // A spawn that failed may never close.
      if (child.pid === undefined) {
        done({ ...none, stopped, cancelled, spawnFailed: true });
      }
    });
    child.once("close", (code) => {
      done({
        exit: code,
        stdout,
        stderr,
        timedOut,
        overflow,
        stopped,
        cancelled,
        spawnFailed: false,
      });
    });
  });
}
