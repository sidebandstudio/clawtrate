// The one way the host starts a program for setup (docs/design/setup.md
// §2 rules 2, 4 and 6): a fixed program, an argument array whose every value
// was validated, an environment the caller names in full, never a shell.
// Standard output is read in memory up to a limit; standard error is read
// and dropped, so no free-form message of a program is ever kept.

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";

export type ProgramResult = {
  /** The exit code, or null when the program was ended or did not start. */
  exitCode: number | null;
  stdout: string;
  timedOut: boolean;
  tooLarge: boolean;
  /** The program could not be started at all. */
  failed: boolean;
};

export type ProgramRequest = {
  program: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxBytes: number;
};

export type RunProgram = (request: ProgramRequest) => Promise<ProgramResult>;

/** No spaces, quotes, shell characters or control characters, and never a leading `-` but a fixed option's. */
const SAFE_ARG = /^(?:--?[a-z][a-z-]*|[A-Za-z0-9][A-Za-z0-9._:/@-]*)$/;
const SAFE_ENV_VALUE = /^[A-Za-z0-9._:/@+=, -]*$/;
const SAFE_ENV_KEY = /^[A-Z][A-Z0-9_]*$/;

/** Throws before anything starts when a program, argument or variable is not one the host may pass. */
export function checkRequest(request: ProgramRequest): void {
  // A fixed path from the look's list, which may hold a space ("Application Support").
  if (!isAbsolute(request.program) || /[\t\n\r'"`$;&|<>\\*?(){}[\]!#~]/.test(request.program))
    throw new Error("refusing a program that is not a fixed absolute path");
  for (const arg of request.args) {
    if (!SAFE_ARG.test(arg) || arg.length > 512) throw new Error("refusing an unsafe argument");
  }
  for (const [key, value] of Object.entries(request.env)) {
    if (!SAFE_ENV_KEY.test(key) || !SAFE_ENV_VALUE.test(value) || value.length > 4096)
      throw new Error("refusing an unsafe environment variable");
  }
}

/**
 * Starts programs and remembers each by its PID until it exits, so that
 * `stopAll` ends exactly the ones it started.
 */
export class ProgramRunner {
  private readonly children = new Set<ChildProcess>();
  private readonly spawnImpl: typeof nodeSpawn;

  constructor(spawnImpl: typeof nodeSpawn = nodeSpawn) {
    this.spawnImpl = spawnImpl;
  }

  readonly run: RunProgram = (request) => {
    checkRequest(request);
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = this.spawnImpl(request.program, [...request.args], {
          env: { ...request.env },
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch {
        resolve({ exitCode: null, stdout: "", timedOut: false, tooLarge: false, failed: true });
        return;
      }
      this.children.add(child);
      const chunks: Buffer[] = [];
      let size = 0;
      let timedOut = false;
      let tooLarge = false;
      const end = () => {
        if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
          try {
            process.kill(child.pid, "SIGTERM");
          } catch {
            // already gone
          }
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        end();
      }, request.timeoutMs);
      child.stdout!.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > request.maxBytes) {
          tooLarge = true;
          end();
          return;
        }
        chunks.push(chunk);
      });
      // Read and dropped: a program's own messages are never kept or shown.
      child.stderr!.on("data", () => {});
      child.once("error", () => {
        clearTimeout(timer);
        this.children.delete(child);
        resolve({ exitCode: null, stdout: "", timedOut, tooLarge, failed: true });
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        this.children.delete(child);
        resolve({
          exitCode: code,
          stdout: tooLarge ? "" : Buffer.concat(chunks).toString("utf8"),
          timedOut,
          tooLarge,
          failed: false,
        });
      });
    });
  };

  /** The PIDs of the programs running now. */
  running(): number[] {
    return [...this.children].flatMap((child) => (child.pid === undefined ? [] : [child.pid]));
  }

  /** Ends every program this runner started that still runs, by its PID. */
  stopAll(): void {
    for (const pid of this.running()) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  }
}
