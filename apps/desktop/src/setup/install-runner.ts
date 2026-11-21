// How the install starts its programs (docs/design/setup.md §2 rules 2, 4
// and 6, §19): an absolute program and an argument array, never a shell the
// host chooses for a value; an environment the caller names in full; output
// read line by line in memory up to a limit, standard error read and
// dropped. Each request is checked against the exact commands the install
// builds for its place before anything starts. Each program leads a process
// group of its own, so that the host ends and waits for exactly what it
// started, descendants too, before an attempt's files are removed or the app
// quits. A gateway a service manager starts is that manager's, never in it.

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
/** How long a finished program's group gets to end on its own before it is ended. */
const DRAIN_MS = 1_000;
const POLL_MS = 50;
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

/** Whether any process of the group `pgid` is still there. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    // EPERM: a process of the group lives under another account.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // already gone
  }
}

const pause = (ms: number) =>
  new Promise<void>((done) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
  });

/**
 * Ends the group `pgid` and waits until none of it is left: SIGTERM, then
 * SIGKILL after the grace period.
 */
async function endGroup(pgid: number): Promise<void> {
  if (!groupAlive(pgid)) return;
  signalGroup(pgid, "SIGTERM");
  const until = Date.now() + STOP_GRACE_MS;
  while (groupAlive(pgid) && Date.now() < until) await pause(POLL_MS);
  if (!groupAlive(pgid)) return;
  signalGroup(pgid, "SIGKILL");
  while (groupAlive(pgid)) await pause(POLL_MS);
}

export class InstallRunner {
  /** The process groups of programs still running or still draining, by group id. */
  private readonly groups = new Map<number, Promise<void>>();
  /** Each group's one end: asked once, by its step or by the quit, and waited for by both. */
  private readonly ends = new Map<number, () => Promise<void>>();
  private readonly spawnImpl: typeof nodeSpawn;
  private closed = false;

  constructor(options: { spawn?: typeof nodeSpawn } = {}) {
    this.spawnImpl = options.spawn ?? nodeSpawn;
  }

  /** Runs one request that `check` has accepted; `check` throws for any other. */
  run(request: InstallRequest, check: (request: InstallRequest) => void): Promise<InstallResult> {
    checkShape(request);
    check(request);
    const notStarted: InstallResult = {
      exitCode: null,
      stdout: "",
      timedOut: false,
      tooLarge: false,
      stopped: false,
      failed: true,
    };
    // Once the app quits, nothing more starts.
    if (this.closed) return Promise.resolve(notStarted);
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = this.spawnImpl(request.program, [...request.args], {
          env: { ...request.env },
          cwd: request.cwd,
          shell: false,
          // Its own process group: the group id is its PID.
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        resolve(notStarted);
        return;
      }
      const pgid = child.pid;
      if (pgid === undefined) {
        child.once("error", () => resolve(notStarted));
        return;
      }
      let ended: Promise<void> | null = null;
      /** Ends the whole group once, and remembers the wait. */
      const end = () => (ended ??= endGroup(pgid));
      this.ends.set(pgid, end);
      let exited = false;
      let markExited: () => void = () => {};
      const exitedOnce = new Promise<void>((done) => (markExited = done));
      const drained = (async () => {
        await exitedOnce;
        // What it started gets a moment to end with it, then is ended: nothing outlives the step.
        const until = Date.now() + DRAIN_MS;
        while (groupAlive(pgid) && Date.now() < until) await pause(POLL_MS);
        await end();
      })();
      this.groups.set(pgid, drained);
      void drained.then(() => {
        this.groups.delete(pgid);
        this.ends.delete(pgid);
      });
      const kept: string[] = [];
      let size = 0;
      let partial = "";
      let timedOut = false;
      let tooLarge = false;
      let stopped = false;
      let settled = false;
      let code: number | null = null;
      const line = (text: string) => {
        if (stopped || tooLarge) return;
        kept.push(text);
        if (request.onLine?.(text) === "stop") {
          stopped = true;
          void end();
        }
      };
      const finish = (failed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (partial) line(partial);
        partial = "";
        child.stdout?.destroy();
        child.stderr?.destroy();
        // Resolved only once nothing of the group is left.
        void drained.then(() =>
          resolve({
            exitCode: code,
            stdout: tooLarge ? "" : kept.join("\n"),
            timedOut,
            tooLarge,
            stopped,
            failed,
          }),
        );
      };
      const timer = setTimeout(() => {
        timedOut = true;
        void end();
      }, request.timeoutMs);
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        size += Buffer.byteLength(chunk);
        if (size > request.maxBytes) {
          if (!tooLarge) {
            tooLarge = true;
            void end();
          }
          return;
        }
        const lines = (partial + chunk).split("\n");
        partial = lines.pop() ?? "";
        for (const text of lines) line(text.replace(/\r$/, ""));
      });
      // Read and dropped: a program's own messages are never kept or shown.
      child.stderr!.on("data", () => {});
      child.once("error", () => {
        exited = true;
        markExited();
        finish(true);
      });
      child.once("exit", (exitCode) => {
        exited = true;
        code = exitCode;
        markExited();
        // A descendant that keeps the pipes open doesn't keep the install waiting: the group's end does.
        void drained.then(() => finish(false));
      });
      child.once("close", (exitCode) => {
        if (!exited) code = exitCode;
        finish(false);
      });
    });
  }

  /** The process groups still running or draining. */
  running(): number[] {
    return [...this.groups.keys()];
  }

  /** Ends every group this runner started that still runs. */
  stopAll(): void {
    for (const end of this.ends.values()) void end();
  }

  /**
   * For the app's quit: nothing more starts, every group is ended, and this
   * resolves once none is left or `withinMs` has passed.
   */
  async close(withinMs: number): Promise<void> {
    this.closed = true;
    this.stopAll();
    await Promise.race([Promise.all(this.groups.values()), pause(withinMs)]);
  }
}
