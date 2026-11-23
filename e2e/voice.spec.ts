import { expect, test, type Page } from "@playwright/test";
import { openInstance, openOperator } from "../tools/dev-gateway/src/cli.ts";
import {
  messageText,
  NO_PLUGIN_CONTEXT,
  PLUGIN_CONTEXT_PROMPT,
  type ChatMessage,
} from "../tools/dev-gateway/src/scripts.ts";
import { SEED_BOTS } from "../tools/dev-gateway/src/seed-data.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import { GUIDE } from "../plugins/clawtrate-voice/index.js";
import { devGateway } from "./global-setup.ts";

const INSTANCE = process.env.CLAWTRATE_DEV_INSTANCE!;
let gateway: OperatorSession;

async function approve() {
  await expect
    .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000 })
    .toMatch(/^Approved /m);
}

async function openConversationSettings(page: Page) {
  await page.goto(process.env.CLAWTRATE_E2E_URL!);
  const connect = page.getByRole("button", { name: "Use the development gateway" });
  const bots = page.getByTestId("bot");
  await expect
    .poll(async () => (await connect.isVisible()) || (await bots.count()) >= 4, { timeout: 20_000 })
    .toBe(true);
  if (await connect.isVisible()) {
    await connect.click();
    await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible();
    await approve();
  }
  await expect(bots.first()).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Conversation", exact: true }).click();
  return settings;
}

/**
 * What each seeded bot says plugins added to its system prompt, asked in a
 * new task of its own that is removed afterwards.
 */
async function addedToEveryBot(): Promise<string[]> {
  return Promise.all(
    SEED_BOTS.map(async (bot) => {
      const { key } = await gateway.request<{ key: string }>("sessions.create", {
        agentId: bot.id,
      });
      try {
        const run = await gateway.send(key, PLUGIN_CONTEXT_PROMPT);
        expect((await gateway.terminal(String(run.runId))).state).toBe("final");
        const history = await gateway.request<{ messages: ChatMessage[] }>("chat.history", {
          sessionKey: key,
          limit: 4,
        });
        const reply = history.messages.findLast((message) => message.role === "assistant");
        return reply ? messageText(reply) : "";
      } finally {
        await gateway.request("sessions.delete", { key, deleteTranscript: true }).catch(() => {});
      }
    }),
  );
}

const plainOnGateway = async () =>
  (await gateway.request<{ plain: boolean }>("clawtrate-voice.get", {})).plain;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  gateway = await openOperator(
    openInstance(INSTANCE),
    "Voice checks",
    ["operator.admin", "operator.read", "operator.write"],
    [],
  );
});

test.afterAll(async () => {
  // Every other check expects the gateway's default.
  await gateway?.request("clawtrate-voice.set", { plain: true }).catch(() => {});
  await gateway?.close();
});

test("F-523: the plain voice is on by default, reaches every bot's prompt, and turning it off in Settings removes it", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const settings = await openConversationSettings(page);
  const toggle = settings.getByRole("switch", { name: "Plain voice" });
  await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: 15_000 });
  await expect(settings.getByTestId("plain-voice-note")).toContainText(
    "Every bot on this gateway is told to write to you plainly",
  );
  expect(await addedToEveryBot()).toEqual(SEED_BOTS.map(() => GUIDE));

  // Below admin the switch shows the gateway's state and offers no change. (A check that ran
  // earlier on this instance may already have given this device admin.)
  if (await toggle.isDisabled()) {
    const bar = settings.getByTestId("admin-bar");
    await expect(bar).toContainText("Changing the plain voice needs admin access.");
    await bar.getByRole("button", { name: "Request admin access" }).click();
    await approve();
    await expect(settings.getByTestId("admin-bar")).toContainText("Admin access granted.", {
      timeout: 30_000,
    });
  }
  await expect(toggle).toBeEnabled();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false", { timeout: 15_000 });
  expect(await plainOnGateway()).toBe(false);
  expect(await addedToEveryBot()).toEqual(SEED_BOTS.map(() => NO_PLUGIN_CONTEXT));

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: 15_000 });
  expect(await plainOnGateway()).toBe(true);
  expect(await addedToEveryBot()).toEqual(SEED_BOTS.map(() => GUIDE));
});
