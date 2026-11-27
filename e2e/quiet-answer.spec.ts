// #680: a turn the gateway starts by itself (a wake, as a command that finished after its turn
// ended does) that the bot answers quietly, against a real development gateway. On OpenClaw
// 2026.10.6 the wake is the gateway's own heartbeat turn, answered with its "nothing to say", and
// ends as a `final` with no message. On 2026.11.10 the wake is an ordinary turn, and the gateway
// ends the quiet answer with an error it marks not to show, its row `failed` beside the mark. Either
// way the conversation shows no failure, and the task and its bot are not marked failed, whether
// the task is open or not. A look-alike: on 2026.11.10 a wake the bot answers with reasoning only
// gets the very same end and row from the gateway; it is a failure, and shows as one.
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { instanceForm, openInstance } from "../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../tools/dev-gateway/src/env.ts";
import { devGateway } from "./global-setup.ts";

/** This run's own development gateway instance, created by global setup. */
const INSTANCE = process.env.CLAWTRATE_DEV_INSTANCE!;

/** A prompt the gateway writes itself for a command that completed, which the bot answers quietly. */
const QUIET_EVENT = "An async command you ran earlier has completed.";

/** A gateway method, called with the instance's own operator credentials. */
async function gatewayCall<T>(method: string, params: unknown): Promise<T> {
  const result = await openInstance(INSTANCE).runner.run([
    ...["gateway", "call", method, "--params", JSON.stringify(params), "--json"],
  ]);
  if (result.status !== 0) throw new Error(`${method} failed:\n${result.stdout}${result.stderr}`);
  return parseJsonOutput<T>(result.stdout);
}

async function approve() {
  await expect
    .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
}

/** The shared preview host, paired, with the access to send. */
async function openShell(page: Page) {
  await page.goto(process.env.CLAWTRATE_E2E_URL!);
  const connect = page.getByRole("button", { name: "Use the development gateway" });
  const bots = page.getByTestId("bot");
  await expect
    .poll(async () => (await connect.isVisible()) || (await bots.count()) >= 4, { timeout: 30_000 })
    .toBe(true);
  if (await connect.isVisible()) {
    await connect.click();
    await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible({
      timeout: 20_000,
    });
    await approve();
  }
  await expect(bots).toHaveCount(4, { timeout: 30_000 });
}

/** Otto's row in the rail, expanded, every task of his shown. 2026.11.10 names him by his id. */
async function ottoTasks(page: Page) {
  const list = page.getByRole("list", { name: /^otto's tasks$/i });
  const row = page.getByTestId("bot-list").getByRole("button", { name: /^otto\b/i });
  if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
  const showAll = list.getByRole("button", { name: /^Show all/ });
  if ((await showAll.count()) > 0) await showAll.click();
  return list;
}

const taskRow = async (page: Page, title: string) =>
  (await ottoTasks(page)).getByTestId("task").filter({ hasText: title }).first();

/** Make the task on the gateway; open it, with the composer there to send from, when asked. */
async function makeTask(page: Page, key: string, title: string, open: boolean) {
  await gatewayCall("sessions.create", { key, agentId: "otto", label: title });
  await expect
    .poll(
      async () => (await ottoTasks(page)).getByTestId("task").filter({ hasText: title }).count(),
      {
        timeout: 30_000,
      },
    )
    .toBeGreaterThan(0);
  if (!open) return;
  await (await taskRow(page, title)).click();
  await expect(
    page.getByRole("button", { name: new RegExp(`^otto, ${title}\\. Show details\\.$`, "i") }),
  ).toBeVisible();
  const asking = page
    .getByRole("region", { name: "Access" })
    .getByRole("button", { name: /^Request (access|again)$/ });
  if ((await asking.count()) > 0) {
    await asking.click();
    await approve();
  }
  await expect(page.getByTestId("composer-input")).toBeVisible({ timeout: 30_000 });
}

type Row = { status?: string; suppressErrorNotice?: boolean; hasActiveRun?: boolean };

/** Wake the task, and wait for the gateway's row to say its turn ended. */
async function wakeAndWait(key: string, text: string, before: number): Promise<Row> {
  expect(await gatewayCall("wake", { mode: "now", text, sessionKey: key })).toMatchObject({
    ok: true,
  });
  let row: Row = {};
  await expect
    .poll(
      async () => {
        const described = await gatewayCall<{ session?: Row & { updatedAt?: number } }>(
          "sessions.describe",
          { key },
        );
        row = described.session ?? {};
        const ended = row.hasActiveRun !== true && row.status !== "running";
        return ended && (described.session?.updatedAt ?? 0) > before;
      },
      { timeout: 120_000, intervals: [1000] },
    )
    .toBe(true);
  return row;
}

/** Archive, then delete the check's task with its transcript, so Otto keeps his seeded tasks. */
async function removeTask(key: string): Promise<void> {
  const row = await gatewayCall<{ session?: { sessionId?: string } }>("sessions.describe", { key })
    .then((result) => result.session)
    .catch(() => undefined);
  if (!row?.sessionId) return;
  await gatewayCall("chat.abort", { sessionKey: key }).catch(() => {});
  await gatewayCall("sessions.patch", { key, archived: true, expectedSessionId: row.sessionId });
  await gatewayCall("sessions.delete", {
    key,
    archivedOnly: true,
    deleteTranscript: true,
    expectedSessionId: row.sessionId,
  });
}

test("#680: a quiet answer to a turn the gateway started is no failure; a turn that ended with reasoning only still is", async ({
  page,
}) => {
  test.setTimeout(420_000);
  const suffix = randomBytes(4).toString("hex");
  const openKey = `agent:otto:check-quiet-${suffix}`;
  const openTitle = `Quiet ${suffix}`;
  const closedKey = `agent:otto:check-quiet-closed-${suffix}`;
  const closedTitle = `Quiet closed ${suffix}`;
  const form = instanceForm(openInstance(INSTANCE));
  test.info().annotations.push({ type: "openclaw", description: form.version });
  await openShell(page);
  try {
    await makeTask(page, closedKey, closedTitle, false);
    await makeTask(page, openKey, openTitle, true);
    const transcript = page.getByTestId("transcript");
    await page.getByTestId("composer-input").fill("#text");
    await page.keyboard.press("Enter");
    await expect(transcript.locator('.msg[data-role="assistant"] .bubble')).toHaveCount(1, {
      timeout: 60_000,
    });
    const failure = transcript.locator(
      '[data-testid="turn-error"], [data-testid="turn-error-line"]',
    );
    const ottoRow = page.getByTestId("bot-list").getByRole("button", { name: /^otto\b/i });

    // The open task, woken, answers quietly.
    const quiet = await wakeAndWait(openKey, QUIET_EVENT, Date.now() - 1_000);
    // What the gateway said of it: on 2026.11.10 a failure it marks not to show; on 2026.10.6, done.
    if (form.heartbeat) expect(quiet.status).not.toBe("failed");
    else expect(quiet).toMatchObject({ status: "failed", suppressErrorNotice: true });
    await page.waitForTimeout(3_000);
    await expect(failure).toHaveCount(0);
    await expect(await taskRow(page, openTitle)).not.toHaveAccessibleName(/last run failed/);
    // The task not open, woken, answers quietly: its row is no failure either.
    await wakeAndWait(closedKey, QUIET_EVENT, Date.now() - 1_000);
    await page.waitForTimeout(3_000);
    await expect(await taskRow(page, closedTitle)).not.toHaveAccessibleName(/last run failed/);
    await expect(ottoRow).not.toHaveAccessibleName(/a run failed/);
    // A reload rebuilds both from the gateway alone: still nothing failed.
    await page.reload();
    await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
    await expect(await taskRow(page, closedTitle)).not.toHaveAccessibleName(/last run failed/, {
      timeout: 20_000,
    });
    await (await taskRow(page, openTitle)).click();
    await expect(transcript.locator('.msg[data-role="assistant"] .bubble')).toHaveCount(1, {
      timeout: 30_000,
    });
    await page.waitForTimeout(2_000);
    await expect(failure).toHaveCount(0);
    await expect(await taskRow(page, openTitle)).not.toHaveAccessibleName(/last run failed/);

    // The look-alike: woken with a turn the bot answers with reasoning only. 2026.10.6's heartbeat
    // turn doesn't take the event's words as its prompt, and answers quietly; on 2026.11.10 the
    // gateway's end and row are those of the quiet answer, and it is the failure it is.
    const thought = await wakeAndWait(openKey, "#think-only", Date.now() - 1_000);
    if (form.heartbeat) {
      await page.waitForTimeout(3_000);
      await expect(failure).toHaveCount(0);
    } else {
      expect(thought).toMatchObject({ status: "failed", suppressErrorNotice: true });
      const card = transcript.getByTestId("turn-error");
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(card).toContainText(/otto couldn't finish an earlier turn/i);
      await expect(card).toContainText("No answer was returned.");
      await expect(await taskRow(page, openTitle)).toHaveAccessibleName(/last run failed/, {
        timeout: 20_000,
      });
    }
  } finally {
    await removeTask(openKey);
    await removeTask(closedKey);
  }
});
