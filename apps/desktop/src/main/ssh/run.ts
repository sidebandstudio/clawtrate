// Starting `ssh`: an argument array, never a shell, the world's environment
// (without the agent when it is "none"), output read in memory within limits,
// a time limit, and an end by PID that waits for the process to be gone.

import { type ChildProcess, spawn } from "node:child_process";

import { childEnv, type SshWorld } from "./world.ts";

export type Spawn = (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => ChildProcess;

/** The children whose "close" has been seen. */
const closed = new WeakSet<ChildProcess>();

export const defaultSpawn: Spawn = (file, args, env) =>
  spawn(file, args, { env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });

/** The processes this module started and has not yet seen end. */
export class ProcessTable {
  readonly running = new Set<number>();
  /** Every PID ever started, for a check that each has ended. */
  readonly started: number[] = [];
  readonly spawnProcess: Spawn;

  constructor(spawnProcess: Spawn = defaultSpawn) {
    this.spawnProcess = spawnProcess;
  }

  start(world: SshWorld, args: readonly string[]): ChildProcess {
    const child = this.spawnProcess(world.ssh, args, childEnv(world));
    const pid = child.pid;
    child.once("close", () => closed.add(child));
    if (pid !== undefined) {
      this.running.add(pid);
      this.started.push(pid);
      child.once("close", () => this.running.delete(pid));
    }
    return child;
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
    const child = table.start(world, args);
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
    options.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", () => {});
    child.once("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve({ exit: code, stdout, stderr, timedOut, overflow, stopped, cancelled });
    });
  });
}
