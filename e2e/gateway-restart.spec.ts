// #592: the gateway restarts with the app connected (as it does after an OpenClaw update).
// The app reconnects and loads bots and tasks again by itself, and once the connection is
// back nothing says it is offline: a message sends and the bot answers.
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { approve as approveDevices, openInstance } from "../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../tools/dev-gateway/src/env.ts";

/** This run's own development gateway instance, created by global setup. */
const INSTANCE = process.env.CLAWTRATE_DEV_INSTANCE!;

// What each stage of the check may take, from what #914 measured on a Mac. A stage that fails or
// runs out of time says which stage it was.
/**
 * Open the app, pair it, make and open the task. Two plain runs measured 1.3 to 41.0 s over
 * six repeats. The 120 s budget leaves room for the browser and device approvals under load.
 */
const SETUP_MS = 120_000;
/**
 * From the restart request to the app reading the gateway as gone and then the gateway ready
 * again, one deadline for both. Without the skills watcher the gateway was away up to 43 s on a
 * Mac under heavy load. The socket closes only after the config reloader's watch does, one more
 * native close, which a busy file-event daemon can hold too. This allows the 43 s nearly 3 times.
 */
const RESTART_MS = 120_000;
/**
 * From the gateway's readiness to the app connected and loaded again, with no strip, what the app
 * promises once the gateway can take it: its next try within 30 s (its reconnect backoff's cap),
 * the try itself within the gateway's 15 s handshake window, then its bots and tasks within
 * 15 s. The six plain repeats took 3.8 to 4.3 s from observed reconnect through reload and
 * strip clearance. That includes the 4 s the UI shows Synced.
 */
const RECOVERY_MS = 60_000;
/** Keep the original 60 s limit for the scripted reply, including the send. */
const REPLY_MS = 60_000;
/** Give a delayed gateway another minute to accept the cleanup calls after restart times out. */
const CLEANUP_MS = 60_000;
// Give a timed-out assertion 5 s to report its own error before aborting any pending CLI call.
const STAGE_REPORT_MS = 5_000;
// The loopback probe normally answers immediately. A 2 s limit keeps a stalled server from
// consuming the restart budget, and a 500 ms poll keeps the recovery clock close to readiness.
const PROBE_MS = 2_000;
const PROBE_INTERVAL_MS = 500;
// A 2 s pause avoids spawning CLI processes back to back while the gateway is away.
const CLEANUP_RETRY_MS = 2_000;
// The seeded instance shows four bots. Cap setup polling and visibility assertions at 30 s
// where they wait for the gateway. The 1 s approval interval gives a pending request time to land.
const SEEDED_BOTS = 4;
const SETUP_STEP_MS = 30_000;
const APPROVAL_INTERVAL_MS = 1_000;

/** Ready again: the gateway's own readiness probe answers 200, asked with a short limit. */
async function gatewayReady(remainingMs: number): Promise<boolean> {
  const port = openInstance(INSTANCE).runner.gatewayPort();
  return fetch(`http://127.0.0.1:${port}/readyz`, {
    signal: AbortSignal.timeout(Math.min(PROBE_MS, remainingMs)),
  }).then(
    (response) => response.status === 200,
    () => false,
  );
}

/** `error` with its message, and the first line of its stack, starting with `name: `. */
function named(name: string, error: unknown): Error {
  const failure = error instanceof Error ? error : new Error(String(error));
  const old = failure.message;
  if (old.startsWith(`${name}: `)) return failure;
  failure.message = `${name}: ${old}`;
  if (failure.stack?.includes(old))
    failure.stack = failure.stack.replace(old, () => failure.message);
  return failure;
}

/** A named deadline shared by all the waits in a stage. */
async function stage<T>(
  name: string,
  ms: number,
  run: (left: () => number, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const until = performance.now() + ms;
  const expired = new Error(`not done within ${ms / 1000} s`);
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(expired);
      abort.abort(expired);
    }, ms + STAGE_REPORT_MS);
  });
  const left = () => {
    const remaining = Math.ceil(until - performance.now());
    if (remaining <= 0) throw expired;
    return remaining;
  };
  try {
    const result = await Promise.race([run(left, abort.signal), late]);
    left();
    return result;
  } catch (error) {
    throw named(name, error);
  } finally {
    clearTimeout(timer);
  }
}

/** A gateway method, called with the instance's own operator credentials. */
async function gatewayCall<T>(method: string, params: unknown, signal: AbortSignal): Promise<T> {
  const result = await openInstance(INSTANCE).runner.run(
    ["gateway", "call", method, "--params", JSON.stringify(params), "--json"],
    { signal },
  );
  if (result.status !== 0) throw new Error(`${method} failed:\n${result.stdout}${result.stderr}`);
  return parseJsonOutput<T>(result.stdout);
}

async function approve(left: () => number) {
  await expect
    .poll(async () => (await approveDevices(openInstance(INSTANCE))).length, {
      timeout: Math.min(SETUP_STEP_MS, left()),
      intervals: [APPROVAL_INTERVAL_MS],
    })
    .toBeGreaterThan(0);
}

/** The shared preview host, paired, with the access to send. */
async function openShell(page: Page, left: () => number) {
  await page.goto(process.env.CLAWTRATE_E2E_URL!, { timeout: left() });
  const connect = page.getByRole("button", { name: "Use the development gateway" });
  const bots = page.getByTestId("bot");
  await expect
    .poll(async () => (await connect.isVisible()) || (await bots.count()) >= SEEDED_BOTS, {
      timeout: Math.min(SETUP_STEP_MS, left()),
    })
    .toBe(true);
  if (await connect.isVisible()) {
    await connect.click({ timeout: left() });
    await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible({
      timeout: Math.min(SETUP_STEP_MS, left()),
    });
    await approve(left);
  }
  await expect(bots).toHaveCount(SEEDED_BOTS, { timeout: Math.min(SETUP_STEP_MS, left()) });
}

/** A key and title for this check's own task: new on every run. */
function newTask(): { key: string; title: string } {
  // Four random bytes keep a repeat from colliding with a task left by an interrupted run.
  const suffix = randomBytes(4).toString("hex");
  return {
    key: `agent:otto:check-after-a-restart-${suffix}`,
    title: `After a restart ${suffix}`,
  };
}

/** Make the task on the gateway and open it, with the composer there to send from. */
async function ownTask(
  page: Page,
  { key, title }: { key: string; title: string },
  left: () => number,
  signal: AbortSignal,
) {
  left();
  await gatewayCall("sessions.create", { key, agentId: "otto", label: title }, signal);
  const list = page.getByRole("list", { name: "Otto's tasks" });
  await expect
    .poll(
      async () => {
        const row = page.getByTestId("bot-list").getByRole("button", { name: /^Otto\b/ });
        if ((await row.getAttribute("aria-expanded", { timeout: left() })) !== "true")
          await row.click({ timeout: left() });
        const showAll = list.getByRole("button", { name: /^Show all/ });
        if ((await showAll.count()) > 0) await showAll.click({ timeout: left() });
        return list.getByTestId("task").filter({ hasText: title }).count();
      },
      { timeout: Math.min(SETUP_STEP_MS, left()) },
    )
    .toBeGreaterThan(0);
  await list.getByTestId("task").filter({ hasText: title }).first().click({ timeout: left() });
  // A task with no message yet has no title heading; its title pill names it.
  await expect(page.getByRole("button", { name: `Otto, ${title}. Show details.` })).toBeVisible({
    timeout: left(),
  });
  const bar = page.getByRole("region", { name: "Access" });
  const asking = bar.getByRole("button", { name: /^Request (access|again)$/ });
  if ((await asking.count()) > 0) {
    await asking.click({ timeout: left() });
    await approve(left);
  }
  await expect(page.getByTestId("composer-input")).toBeVisible({
    timeout: Math.min(SETUP_STEP_MS, left()),
  });
}

/** Archive, then delete the check's task with its transcript, so Otto keeps his seeded tasks. */
async function removeTaskOnce(key: string, signal: AbortSignal): Promise<void> {
  const { session } = await gatewayCall<{ session: { sessionId: string } | null }>(
    "sessions.describe",
    { key },
    signal,
  );
  if (session === null) return;
  if (!session?.sessionId) throw new Error("sessions.describe did not confirm a task ID");
  await gatewayCall("chat.abort", { sessionKey: key }, signal).catch(() => {});
  await gatewayCall(
    "sessions.patch",
    { key, archived: true, expectedSessionId: session.sessionId },
    signal,
  );
  const result = await gatewayCall<{ deleted: boolean }>(
    "sessions.delete",
    { key, archivedOnly: true, deleteTranscript: true, expectedSessionId: session.sessionId },
    signal,
  );
  if (!result.deleted) throw new Error("sessions.delete did not confirm deletion");
}

/** Retry cleanup while the gateway is still coming back from the restart. */
async function removeTask(key: string): Promise<void> {
  await stage(`cleanup: could not confirm removal of ${key}`, CLEANUP_MS, async (left, signal) => {
    for (;;) {
      try {
        return await removeTaskOnce(key, signal);
      } catch (error) {
        if (signal.aborted || left() <= CLEANUP_RETRY_MS) throw error;
        await delay(CLEANUP_RETRY_MS, undefined, { signal });
        left();
      }
    }
  });
}

test("#592: the gateway restarted with the app connected: the app recovers by itself, and nothing says offline once it is back", async ({
  page,
}) => {
  // 15 s for the page fixture and reporting, beyond the five stage budgets and report windows.
  test.setTimeout(
    SETUP_MS + RESTART_MS + RECOVERY_MS + REPLY_MS + CLEANUP_MS + 5 * STAGE_REPORT_MS + 15_000,
  );
  // The task is removed however the check ends, its setup included.
  const task = newTask();
  // Report each stage mark to the nearest tenth of a second from the start of the check.
  const at: Record<string, number> = { started: Date.now() };
  let failed = false;
  try {
    const seen = await stage("setup", SETUP_MS, async (left, signal) => {
      await openShell(page, left);
      await ownTask(page, task, left, signal);
      // From now on: whether the window ever read as lost, every strip seen, and anything that
      // said offline or reconnecting while the connection was up.
      await page.evaluate(() => {
        const seen = { lost: false, strips: [] as string[], offlineWhileUp: [] as string[] };
        (window as unknown as { seen: typeof seen }).seen = seen;
        const look = () => {
          const lost = !!document.querySelector('.app[data-connection="lost"]');
          if (lost) seen.lost = true;
          const strip = document.querySelector('[data-testid="status-strip"]')?.textContent;
          if (strip && seen.strips.at(-1) !== strip) seen.strips.push(strip);
          if (lost) return;
          const placeholder = document
            .querySelector('[data-testid="composer-input"]')
            ?.getAttribute("placeholder");
          const phrase = document.querySelector('[data-testid="status-phrase"]')?.textContent;
          for (const words of [placeholder, phrase])
            if (words && /^(Offline|Reconnecting)/.test(words)) seen.offlineWhileUp.push(words);
        };
        new MutationObserver(look).observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      });
      type Seen = { lost: boolean; strips: string[]; offlineWhileUp: string[] };
      return () => page.evaluate(() => (window as unknown as { seen: Seen }).seen);
    });

    // The gateway restarts in its own process, with its state, as an update restarts it. The app
    // reads it as gone first; only then does the gateway's readiness count as its return.
    await stage("restart", RESTART_MS, async (left, signal) => {
      at.requested = Date.now();
      await gatewayCall(
        "gateway.restart.request",
        { reason: "clawtrate-e2e", skipDeferral: true },
        signal,
      );
      await expect
        .poll(async () => (await seen()).lost, {
          message: "the app never read the gateway as gone",
          timeout: left(),
        })
        .toBe(true);
      at.gone = Date.now();
      await expect
        .poll(() => gatewayReady(left()), {
          message: "the gateway was not ready again",
          timeout: left(),
          intervals: [PROBE_INTERVAL_MS],
        })
        .toBe(true);
      at.ready = Date.now();
    });

    // Back, and loaded again with nothing pressed: no strip is left, nothing reads as lost.
    const app = page.locator(".app");
    const input = page.getByTestId("composer-input");
    await stage("recovery", RECOVERY_MS, async (left) => {
      await expect(app, "the app still read as lost").not.toHaveAttribute(
        "data-connection",
        "lost",
        { timeout: left() },
      );
      at.connected = Date.now();
      await expect(page.getByTestId("status-strip")).toHaveCount(0, { timeout: left() });
      await expect(page.getByTestId("bot")).toHaveCount(SEEDED_BOTS, { timeout: left() });
      await expect(
        page.getByRole("button", { name: `Otto, ${task.title}. Show details.` }),
      ).toBeVisible({ timeout: left() });
      const strips = (await seen()).strips;
      expect(
        strips.some((text) => /Couldn't load/.test(text)),
        strips.join(" | "),
      ).toBe(false);
      await expect(input).not.toHaveAttribute("placeholder", /Offline/, { timeout: left() });
      await expect(page.getByText(/Offline\. Messages send|Reconnecting\. Last seen/)).toHaveCount(
        0,
        { timeout: left() },
      );
      at.loaded = Date.now();
    });

    // A message sends, and the bot answers.
    await stage("reply", REPLY_MS, async (left) => {
      await input.fill("Are you back?", { timeout: left() });
      await input.press("Enter", { timeout: left() });
      await expect(page.locator('.msg[data-role="assistant"] .bubble').first()).toBeVisible({
        timeout: left(),
      });
      await expect(page.getByText("Sends when reconnected")).toHaveCount(0, { timeout: left() });
      await expect(app).not.toHaveAttribute("data-connection", "lost", { timeout: left() });
      // At no moment while the connection was up did anything say it was offline.
      expect((await seen()).offlineWhileUp).toEqual([]);
      at.replied = Date.now();
    });
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    test.info().annotations.push({
      type: "stages",
      description: Object.entries(at)
        .map(([mark, time]) => `${mark} ${((time - at.started!) / 1000).toFixed(1)} s`)
        .join(", "),
    });
    // The check's own failure stays the failure; a cleanup that fails after it is reported too.
    await removeTask(task.key).catch((error: unknown) => {
      if (!failed) throw error;
      console.error(error instanceof Error ? error.message : error);
    });
  }
});
