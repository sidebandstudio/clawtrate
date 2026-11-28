// #592: the gateway restarts with the app connected (as it does after an OpenClaw update).
// The app reconnects and loads bots and tasks again by itself, and once the connection is
// back nothing says it is offline: a message sends and the bot answers.
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { openInstance } from "../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../tools/dev-gateway/src/env.ts";
import { devGateway } from "./global-setup.ts";

/** This run's own development gateway instance, created by global setup. */
const INSTANCE = process.env.CLAWTRATE_DEV_INSTANCE!;

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

/** A key and title for this check's own task: new on every run. */
function newTask(): { key: string; title: string } {
  const suffix = randomBytes(4).toString("hex");
  return {
    key: `agent:otto:check-after-a-restart-${suffix}`,
    title: `After a restart ${suffix}`,
  };
}

/** Make the task on the gateway and open it, with the composer there to send from. */
async function ownTask(page: Page, { key, title }: { key: string; title: string }) {
  await gatewayCall("sessions.create", { key, agentId: "otto", label: title });
  const list = page.getByRole("list", { name: "Otto's tasks" });
  await expect
    .poll(
      async () => {
        const row = page.getByTestId("bot-list").getByRole("button", { name: /^Otto\b/ });
        if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
        const showAll = list.getByRole("button", { name: /^Show all/ });
        if ((await showAll.count()) > 0) await showAll.click();
        return list.getByTestId("task").filter({ hasText: title }).count();
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  await list.getByTestId("task").filter({ hasText: title }).first().click();
  // A task with no message yet has no title heading; its title pill names it.
  await expect(page.getByRole("button", { name: `Otto, ${title}. Show details.` })).toBeVisible();
  const bar = page.getByRole("region", { name: "Access" });
  const asking = bar.getByRole("button", { name: /^Request (access|again)$/ });
  if ((await asking.count()) > 0) {
    await asking.click();
    await approve();
  }
  await expect(page.getByTestId("composer-input")).toBeVisible({ timeout: 30_000 });
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

test("#592: the gateway restarted with the app connected: the app recovers by itself, and nothing says offline once it is back", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openShell(page);
  // The task is removed however the check ends, its setup included.
  const task = newTask();
  try {
    await ownTask(page, task);
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
    const seen = () => page.evaluate(() => (window as unknown as { seen: Seen }).seen);

    // The gateway restarts in its own process, with its state, as an update restarts it.
    await gatewayCall("gateway.restart.request", { reason: "clawtrate-e2e", skipDeferral: true });
    await expect.poll(async () => (await seen()).lost, { timeout: 30_000 }).toBe(true);

    // Back, and loaded again with nothing pressed: no strip is left, nothing reads as lost.
    const app = page.locator(".app");
    await expect(app).not.toHaveAttribute("data-connection", "lost", { timeout: 60_000 });
    await expect(page.getByTestId("status-strip")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId("bot")).toHaveCount(4);
    const strips = (await seen()).strips;
    expect(
      strips.some((text) => /Couldn't load/.test(text)),
      strips.join(" | "),
    ).toBe(false);
    // The gateway said it was restarting, so the strip said that, not "Reconnecting" (#913).
    expect(
      strips.some((text) => text.includes("Restarting OpenClaw")),
      strips.join(" | "),
    ).toBe(true);
    expect(
      strips.some((text) => text.includes("Reconnecting")),
      strips.join(" | "),
    ).toBe(false);
    const input = page.getByTestId("composer-input");
    await expect(input).not.toHaveAttribute("placeholder", /Offline/);
    await expect(page.getByText(/Offline\. Messages send|Reconnecting\. Last seen/)).toHaveCount(0);

    // A message sends, and the bot answers.
    await input.fill("Are you back?");
    await page.keyboard.press("Enter");
    await expect(page.locator('.msg[data-role="assistant"] .bubble').first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText("Sends when reconnected")).toHaveCount(0);
    await expect(app).not.toHaveAttribute("data-connection", "lost");
    // At no moment while the connection was up did anything say it was offline.
    expect((await seen()).offlineWhileUp).toEqual([]);
  } finally {
    await removeTask(task.key);
  }
});
