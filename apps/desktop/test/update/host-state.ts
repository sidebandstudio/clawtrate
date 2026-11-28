// Read by the standalone update check's runner. What the host showed when a
// test failed, beside the test's results. Everything but the host's reading is
// fixed, printed and written when the capture starts, before the host is asked,
// and a second capture for the same test gets that one (#577).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { readSteps } from "./screen-test-steps.ts";

/** The parts of Playwright's test info the reading is written to. */
interface FailedTest {
  readonly outputDir: string;
  readonly annotations: unknown;
  attach(name: string, options: { path: string; contentType: string }): Promise<void>;
}

/** Each test's one capture. Playwright hands a test's body and its afterEach the same test info. */
const captures = new WeakMap<FailedTest, Promise<void>>();

/**
 * A failure may be visible only in the host's state, which teardown closes away.
 * A test that captured before its own cleanup gets that capture again. Never rejects,
 * so the failure under diagnosis keeps its own error.
 */
export function captureHostState(
  test: FailedTest,
  profile: string,
  requests: readonly string[],
  rendererRequests: readonly string[],
  ask: () => Promise<unknown>,
  timeoutMs = 10_000,
): Promise<void> {
  let capture = captures.get(test);
  if (!capture) captures.set(test, (capture = take().catch(() => {})));
  return capture;

  async function take() {
    // The step a download stopped in may end, and requests and notes may change, while the host answers.
    const seen = {
      capturedAt: new Date().toISOString(),
      steps: readSteps(profile),
      requests: [...requests],
      rendererRequests: [...rendererRequests],
      notes: structuredClone(test.annotations),
    };
    console.log(
      "Update steps at failure",
      JSON.stringify({ steps: seen.steps, requests: seen.requests }),
    );
    const file = join(test.outputDir, "host-state.json");
    const write = (reading: unknown) => {
      mkdirSync(test.outputDir, { recursive: true });
      writeFileSync(file, JSON.stringify({ reading, ...seen }, null, 2));
    };
    try {
      // On disk while the host is asked, in case the test runs out of time meanwhile.
      write("pending");
    } catch {
      // The failure under diagnosis still outranks the diagnostics.
    }
    const reading = await Promise.race([
      Promise.resolve().then(ask),
      pause(timeoutMs).then(() => null),
    ]).catch((cause: unknown) => ({
      // Never the error's text, which can name a path.
      error: String(cause).includes("Target page, context or browser has been closed")
        ? "page closed"
        : "host read failed",
    }));
    const answer =
      reading && typeof reading === "object" && "state" in reading
        ? (reading as { state: unknown; preferenceIssue?: unknown })
        : null;
    console.log(
      "Update status at failure",
      JSON.stringify({
        requests: seen.requests,
        ...(answer
          ? { state: answer.state, preferenceIssue: answer.preferenceIssue }
          : { reading }),
      }),
    );
    try {
      write(reading);
      await test.attach("host-state", { path: file, contentType: "application/json" });
    } catch {
      // The failure under diagnosis still outranks the diagnostics.
    }
  }
}
