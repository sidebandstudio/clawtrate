// Read by the standalone update check's runner. What the host showed when a
// test failed, read once for both its console line and its attached
// host-state.json, so the two describe the same moment (#207).
import type { DesktopUpdateSnapshot } from "@clawtrate/core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { readSteps, type Step } from "./screen-test-steps.ts";

/** The parts of Playwright's test info the reading is written to. */
interface FailedTest {
  readonly outputDir: string;
  readonly annotations: unknown;
  attach(name: string, options: { path: string; contentType: string }): Promise<void>;
}

export interface HostState {
  /** The host's own reading; null when it gave none in time, or why it couldn't be asked. */
  readonly reading: DesktopUpdateSnapshot | null | { error: "page closed" | "host read failed" };
  readonly steps: Step[] | null;
  readonly requests: readonly string[];
  readonly rendererRequests: readonly string[];
}

/**
 * Reads the host's state on the first call and writes it beside the test's
 * results. Later calls get that same state.
 */
export function hostStateAtFailure(
  test: FailedTest,
  profile: string,
  requests: readonly string[],
  rendererRequests: readonly string[],
  ask: () => Promise<DesktopUpdateSnapshot>,
  timeoutMs = 10_000,
): () => Promise<HostState> {
  let taken: Promise<HostState> | undefined;
  return () => (taken ??= capture());
  async function capture(): Promise<HostState> {
    // Before asking the host, which can take seconds: long enough for the step
    // a download stalled in to end.
    const seen = {
      steps: readSteps(profile),
      requests: [...requests],
      rendererRequests: [...rendererRequests],
    };
    let reading: HostState["reading"];
    try {
      reading = await Promise.race([ask(), pause(timeoutMs, null, { ref: false })]);
    } catch (cause) {
      reading = {
        error:
          cause instanceof Error &&
          cause.message.includes("Target page, context or browser has been closed")
            ? "page closed"
            : "host read failed",
      };
    }
    const state = { reading, ...seen };
    try {
      const file = join(test.outputDir, "host-state.json");
      mkdirSync(test.outputDir, { recursive: true });
      writeFileSync(file, JSON.stringify({ ...state, notes: test.annotations }, null, 2));
      await test.attach("host-state", { path: file, contentType: "application/json" });
    } catch {
      // The failure under diagnosis still outranks the diagnostics.
    }
    return state;
  }
}

/** The console's line: the host's state and settings problem as it gave them, or why it gave none. */
export function statusLine({ reading, steps, requests }: HostState): string {
  const shown =
    reading && !("error" in reading)
      ? { state: reading.state, preferenceIssue: reading.preferenceIssue }
      : { reading };
  return JSON.stringify({ requests, ...shown, steps });
}
