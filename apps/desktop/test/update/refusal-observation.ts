// Read by the standalone update check's runner. Times the installer-refusal
// loop's wait for the host to report each reason, which polls for Playwright's
// default five seconds, so a passing run's log says how long each reason took to
// show and a failing one says which wait ended without it (#577). It keeps the
// reason, the wait's wall time and whether it matched, never what the host said.
import type { UpdateInstallRefusal } from "@clawtrate/core";

/**
 * Runs one refusal assertion, then logs its reason, whether it matched and how long it
 * ran by a monotonic clock. A rejection is rethrown as the assertion gave it.
 */
export async function observeRefusal(
  reason: UpdateInstallRefusal,
  assertion: () => Promise<unknown>,
  now: () => number = () => performance.now(),
  log: (...line: string[]) => void = console.log,
): Promise<void> {
  const start = now();
  let outcome: "matched" | "unmatched" = "unmatched";
  try {
    await assertion();
    outcome = "matched";
  } finally {
    try {
      log("Refusal assertion", JSON.stringify({ reason, outcome, ms: Math.round(now() - start) }));
    } catch {
      // The assertion's own result outranks its timing.
    }
  }
}
