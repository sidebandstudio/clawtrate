// Approving the device a test just paired, or whose access it just asked to raise, on the
// development gateway: `pnpm dev-gateway approve` tried again until it approves something or the
// helper's own deadline passes.
//
// Every try counts until the deadline, whatever it ended with: nothing pending yet, the command
// cut off by OpenClaw's time limit or by this helper's own limit on one try, or the command failing, as it does when a request it listed
// was superseded before it was approved. Each try lists the pending requests afresh. A failure
// says which of those the last try ended with, how many tries there were and for how long.

import { spawn } from "node:child_process";
import { CLI, cliEnv, ROOT } from "./global-setup.ts";

/** How one try of the command ended. */
export type ApproveTry = {
  outcome: "approved" | "nothing yet" | "timed out" | "failed";
  /** What the command printed, or why it could not run. */
  output: string;
};

export type ApproveOptions = {
  /** How long to keep trying, from the first try. */
  timeoutMs?: number;
  /** The pause between tries. */
  intervalMs?: number;
};

/** OpenClaw's own words, in its JSON and in its plain output, when a call ran past its `--timeout`. */
const OPENCLAW_TIMEOUT =
  /gateway timeout after \d+ms|gateway request timeout for |OpenClaw took too long to respond/;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `attempt` until one try approves, and returns that try's output. Throws once the deadline
 * has passed after a try that didn't, naming that try's outcome and output. A try that starts
 * before the deadline runs to its end.
 */
export async function untilApproved(
  attempt: () => Promise<ApproveTry>,
  { timeoutMs = 60_000, intervalMs = 1_000 }: ApproveOptions = {},
  now: () => number = Date.now,
  wait: (ms: number) => Promise<unknown> = sleep,
): Promise<string> {
  const started = now();
  for (let tries = 1; ; tries += 1) {
    const last = await attempt();
    if (last.outcome === "approved") return last.output;
    const elapsed = now() - started;
    if (elapsed + intervalMs >= timeoutMs) {
      throw new Error(
        `The device was not approved: ${tries} ${tries === 1 ? "try" : "tries"} in ${(elapsed / 1000).toFixed(1)} s ` +
          `(limit ${timeoutMs / 1000} s). The last one ${describe(last.outcome)}:\n${last.output.trim() || "(it printed nothing)"}`,
      );
    }
    await wait(intervalMs);
  }
}

function describe(outcome: ApproveTry["outcome"]): string {
  if (outcome === "nothing yet") return "found nothing to approve yet";
  if (outcome === "timed out") return "timed out";
  return "failed";
}

/** What one run of the command means, from its exit status and everything it printed. */
export function classify(status: number | null, output: string): ApproveTry["outcome"] {
  if (status === 0) return /^Approved /m.test(output) ? "approved" : "nothing yet";
  return OPENCLAW_TIMEOUT.test(output) ? "timed out" : "failed";
}

/**
 * The longest one try may take. The command makes two OpenClaw calls of 10 s each at most; one
 * that hangs past this is stopped with everything it started, so no try outlives the helper.
 */
export const TRY_LIMIT_MS = 30_000;

/** One run of `pnpm dev-gateway approve` against `instance`. */
function approveOnce(instance: string): Promise<ApproveTry> {
  return runTry(process.execPath, [CLI, "approve", "--instance", instance]);
}

/**
 * One try of a command, in a process group of its own. Past `limitMs` the group is stopped, the
 * command and whatever it started, and the try counts as timed out.
 */
export function runTry(
  command: string,
  args: string[],
  limitMs = TRY_LIMIT_MS,
): Promise<ApproveTry> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: cliEnv(),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    // Stops the group this try started, by its PID: the tool and the OpenClaw call under it.
    const stop = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // Already gone.
      }
    };
    let stopped = false;
    const limit = setTimeout(() => {
      stopped = true;
      stop("SIGTERM");
      setTimeout(() => stop("SIGKILL"), 2_000).unref();
    }, limitMs);
    child.on("error", (error) => {
      clearTimeout(limit);
      resolve({ outcome: "failed", output: `${output}${error.message}` });
    });
    child.on("close", (status, signal) => {
      clearTimeout(limit);
      if (stopped) {
        resolve({
          outcome: "timed out",
          output: `${output}stopped after ${limitMs / 1000} s`,
        });
      } else if (status === null) {
        resolve({ outcome: "failed", output: `${output}ended by ${signal}` });
      } else {
        resolve({ outcome: classify(status, output), output });
      }
    });
  });
}

/**
 * Approves the pending Clawtrate pairing or access request on `instance` that the test just
 * raised, as `pnpm dev-gateway approve` does, trying until it does or `timeoutMs` passes.
 */
export function approveDevice(instance: string, options: ApproveOptions = {}): Promise<string> {
  return untilApproved(() => approveOnce(instance), options);
}
