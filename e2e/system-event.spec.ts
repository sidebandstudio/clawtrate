// #637: a system event the gateway wakes a task with (`wake {mode: "now", text, sessionKey}`, as a
// command that finished after its turn ended or a scheduled event does) against a real development
// gateway. On OpenClaw 2026.10.6 the turn is the gateway's own heartbeat turn, answered with its
// "nothing to say", and adds nothing to the task. On 2026.11.10 it is an ordinary turn whose
// history keeps the event as a user row with `provenance.kind: "internal_system"`, then the bot's
// answer. Either way the event's words never show in the person's bubble: on 2026.11.10 the row
// is the gateway's quiet line, with the event's text one step away.
import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { instanceForm, openInstance } from "../tools/dev-gateway/src/cli.ts";
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

/** Make the task on the gateway and open it, with the composer there to send from. */
async function ownTask(page: Page, key: string, title: string) {
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
  await expect(page.getByRole("button", { name: `Otto, ${title}. Show details.` })).toBeVisible();
  const asking = page
    .getByRole("region", { name: "Access" })
    .getByRole("button", { name: /^Request (access|again)$/ });
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

test("#637: a system event the gateway wakes a task with is the gateway's line, never the person's message", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const suffix = randomBytes(4).toString("hex");
  const key = `agent:otto:check-woken-${suffix}`;
  const title = `Woken ${suffix}`;
  // A command's completion, as the gateway words one, with words a person might have typed.
  const event = `Exec completed (e2e-${suffix}, code 0) :: the command you ran finished`;
  await openShell(page);
  try {
    await ownTask(page, key, title);
    const transcript = page.getByTestId("transcript");
    const yours = transcript.locator('[data-testid="transcript-turn"][data-role="user"]');
    await page.getByTestId("composer-input").fill("#text");
    await page.keyboard.press("Enter");
    await expect(transcript.locator('.msg[data-role="assistant"] .bubble')).toHaveCount(1, {
      timeout: 60_000,
    });
    await expect(yours).toHaveCount(1);

    expect(await gatewayCall("wake", { mode: "now", text: event, sessionKey: key })).toMatchObject({
      ok: true,
    });

    const line = transcript.getByTestId("gateway-event");
    const form = instanceForm(openInstance(INSTANCE));
    test.info().annotations.push({ type: "openclaw", description: form.version });
    if (form.heartbeat) {
      // 2026.10.6: the gateway's own turn, answered with its "nothing to say", adds nothing.
      await page.waitForTimeout(8_000);
      await expect(line).toHaveCount(0);
      await expect(transcript.locator('.msg[data-role="assistant"] .bubble')).toHaveCount(1);
    } else {
      // 2026.11.10: the event row is the gateway's line, its text one step away, and the bot's
      // answer after it is the bot's.
      await expect(line).toHaveCount(1, { timeout: 60_000 });
      await expect(line.locator("p.event-line")).toHaveText("The gateway started a turn by itself");
      const text = line.getByText(event, { exact: true });
      await expect(text).toBeHidden();
      await line.getByText("Event text").click();
      await expect(text).toBeVisible();
      await expect(transcript.locator('.msg[data-role="assistant"] .bubble')).toHaveCount(2, {
        timeout: 60_000,
      });
    }
    // Never in the person's bubble, on either version: the only message of theirs is their own.
    await expect(yours).toHaveCount(1);
    await expect(yours).toHaveText(/#text/);
    await expect(yours.filter({ hasText: event })).toHaveCount(0);
  } finally {
    await removeTask(key);
  }
});
