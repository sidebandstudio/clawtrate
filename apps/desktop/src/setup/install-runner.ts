// How the install starts its programs (docs/design/setup.md §2 rules 2, 4
// and 6, §19): an absolute program and an argument array, never a shell the
// host chooses for a value; an environment the caller names in full; output
// read line by line in memory up to a limit, standard error read and
// dropped. Each request is checked against the exact commands the install
// builds for its place before anything starts. Programs are remembered by
// PID so that the host ends exactly the ones it started.

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";

export type InstallRequest = {
  program: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd: string;
  timeoutMs: number;
  /** The most standard output kept; past it the program is ended. */
  maxBytes: number;
  /** Each whole line of standard output as it arrives; `"stop"` ends the program. */
  onLine?: (line: string) => "stop" | void;
};

export type InstallResult = {
  exitCode: number | null;
  stdout: string;
  timedOut: boolean;
  tooLarge: boolean;
  /** Ended because `onLine` asked. */
  stopped: boolean;
  /** Could not be started at all. */
  failed: boolean;
};

export type RunInstallProgram = (request: InstallRequest) => Promise<InstallResult>;

const STOP_GRACE_MS = 3_000;
const SAFE_ENV_VALUE = /^[A-Za-z0-9._:/@+=, -]*$/;

/** Throws when a value could be read as more than one thing by the program or the system. */
export function checkShape(request: InstallRequest): void {
  if (!isAbsolute(request.program) || /[\t\n\r'"`$;&|<>\\*?(){}[\]!#~]/.test(request.program))
    throw new Error("refusing a program that is not a fixed absolute path");
  if (!isAbsolute(request.cwd)) throw new Error("refusing a program without a working folder");
  for (const [key, value] of Object.entries(request.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !SAFE_ENV_VALUE.test(value) || value.length > 4096)
      throw new Error("refusing an environment variable the install doesn't pass");
  }
}

export class InstallRunner {
  private readonly children = new Set<ChildProcess>();
  private readonly spawnImpl: typeof nodeSpawn;

  constructor(options: { spawn?: typeof nodeSpawn } = {}) {
    this.spawnImpl = options.spawn ?? nodeSpawn;
  }

  private end(child: ChildProcess): void {
    const pid = child.pid;
    if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }, STOP_GRACE_MS);
    timer.unref?.();
    child.once("exit", () => clearTimeout(timer));
  }

  /** Runs one request that `check` has accepted; `check` throws for any other. */
  run(request: InstallRequest, check: (request: InstallRequest) => void): Promise<InstallResult> {
    checkShape(request);
    check(request);
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = this.spawnImpl(request.program, [...request.args], {
          env: { ...request.env },
          cwd: request.cwd,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        resolve({
          exitCode: null,
          stdout: "",
          timedOut: false,
          tooLarge: false,
          stopped: false,
          failed: true,
        });
        return;
      }
      this.children.add(child);
      const kept: string[] = [];
      let size = 0;
      let partial = "";
      let timedOut = false;
      let tooLarge = false;
      let stopped = false;
      let settled = false;
      const line = (text: string) => {
        if (stopped || tooLarge) return;
        kept.push(text);
        if (request.onLine?.(text) === "stop") {
          stopped = true;
          this.end(child);
        }
      };
      const finish = (code: number | null, failed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (partial) line(partial);
        partial = "";
        this.children.delete(child);
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolve({
          exitCode: code,
          stdout: tooLarge ? "" : kept.join("\n"),
          timedOut,
          tooLarge,
          stopped,
          failed,
        });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        this.end(child);
      }, request.timeoutMs);
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        size += Buffer.byteLength(chunk);
        if (size > request.maxBytes) {
          if (!tooLarge) {
            tooLarge = true;
            this.end(child);
          }
          return;
        }
        const lines = (partial + chunk).split("\n");
        partial = lines.pop() ?? "";
        for (const text of lines) line(text.replace(/\r$/, ""));
      });
      // Read and dropped: a program's own messages are never kept or shown.
      child.stderr!.on("data", () => {});
      child.once("error", () => finish(null, true));
      child.once("close", (code) => finish(code, false));
      child.once("exit", (code) => {
        // A descendant that keeps the pipes open doesn't keep the install waiting.
        const drain = setTimeout(() => finish(code, false), 1_000);
        drain.unref?.();
      });
    });
  }

  running(): number[] {
    return [...this.children].flatMap((child) => (child.pid === undefined ? [] : [child.pid]));
  }

  /** Ends every program this runner started that still runs, by PID. */
  stopAll(): void {
    for (const child of this.children) this.end(child);
  }
}
