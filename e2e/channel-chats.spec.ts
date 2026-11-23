// Chats from external channels (F-519) against this run's own development gateway: a
// preview host of its own paired at the read tier, and a paired admin operator that makes
// a bot of this spec's own and gives it chats as Discord and Slack would. An admin
// `chat.send` may name the channel a turn came from (`originatingChannel`) without that
// channel being set up; with `deliver: false` nothing is sent anywhere, and the session
// gets the external route a real channel gives it (docs/research/gateway-capabilities.md,
// "Channel sessions"). The bot's main session gets a Telegram turn too, so its channel
// sticks, as with the gateway's default `dmScope: "main"`. The bot is removed afterwards.
import { expect, test, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plainPreview } from "../packages/core/src/mapping.ts";
import { openInstance, openOperator } from "../tools/dev-gateway/src/cli.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import { devGateway, startHost, stopChild } from "./global-setup.ts";

const INSTANCE = process.env.CLAWTRATE_DEV_INSTANCE!;
const STATIC = process.env.CLAWTRATE_E2E_STATIC!;
const STAMP = Date.now().toString(36);
const NAME = `Courier${STAMP}`;

let host: { child: ChildProcess; data: string } | null = null;
let page: Page;
let admin: OperatorSession;
let botId: string | null = null;

type Row = {
  key: string;
  lastMessagePreview?: string;
  channel?: string;
  isMain?: boolean;
  hasActiveRun?: boolean;
};
const keys = (bot: string) => ({
  main: `agent:${bot}:main`,
  native: `agent:${bot}:e2e-native`,
  discord: `agent:${bot}:discord:channel:1234567890`,
  slack: `agent:${bot}:slack:direct:u0123`,
});

async function rows(bot: string): Promise<Row[]> {
  const listed = (await admin.request("sessions.list", {
    agentId: bot,
    limit: 50,
    includeLastMessage: true,
  })) as { sessions?: Row[] };
  return listed.sessions ?? [];
}

/** A turn on `key`, and the row once its run has ended. A channel's turn sends no `chat` final here. */
async function turn(key: string, text: string, channel?: { id: string; to: string }) {
  await admin.send(key, text, {
    deliver: false,
    ...(channel ? { originatingChannel: channel.id, originatingTo: channel.to } : {}),
  });
  await expect
    .poll(
      async () => {
        const row = (await rows(botId!)).find((each) => each.key === key);
        return Boolean(row?.lastMessagePreview) && row?.hasActiveRun !== true;
      },
      { timeout: 90_000, intervals: [1_000, 2_000] },
    )
    .toBe(true);
}

const botRow = () =>
  page.getByTestId("bot-list").getByRole("button", { name: new RegExp(`^${NAME}\\b`) });
const tasks = () => page.getByRole("list", { name: `${NAME}'s tasks` }).getByTestId("task");
const botNames = () => page.getByTestId("bot-list").locator(".bot-name").allTextContents();

/** Ask the host to read bots and tasks again, as the rail spec does, until the rail shows this bot. */
async function railShowsBot(): Promise<void> {
  await expect
    .poll(
      async () => {
        await page
          .evaluate(
            () =>
              new Promise<void>((resolve, reject) => {
                const socket = new WebSocket(`ws://${location.host}/bridge`);
                socket.onmessage = (event) => {
                  const message = JSON.parse(String(event.data)) as { type: string; id?: string };
                  if (message.type === "hello")
                    socket.send(
                      JSON.stringify({ type: "command", id: "reread", command: { type: "retry" } }),
                    );
                  else if (message.id === "reread") {
                    socket.close();
                    resolve();
                  }
                };
                socket.onerror = () => reject(new Error("bridge socket error"));
              }),
          )
          .catch(() => {});
        return (await botRow().count()) > 0;
      },
      { timeout: 90_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBe(true);
}

/** Show the bot's tasks. */
async function unfold(): Promise<void> {
  const row = botRow().first();
  if ((await row.getAttribute("aria-expanded")) === "false") {
    await row.focus();
    await page.keyboard.press("ArrowRight");
  }
}

async function setShown(on: boolean): Promise<void> {
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Advanced", exact: true }).click();
  const toggle = settings.getByRole("switch", { name: "Show external channel chats" });
  await expect(toggle).toHaveAccessibleDescription(/main conversation always shows/);
  if ((await toggle.getAttribute("aria-checked")) !== String(on)) await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", String(on));
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(420_000);
  expect(INSTANCE, "a named instance").toMatch(/^[a-z0-9-]+$/);
  admin = await openOperator(
    openInstance(INSTANCE),
    "Clawtrate channel chats check",
    ["operator.read", "operator.write", "operator.admin"],
    [],
  );
  const created = (await admin.request("agents.create", {
    name: NAME,
    workspace: join(openInstance(INSTANCE).stateDir, "workspaces", NAME.toLowerCase()),
    model: "scripted/dev-1",
  })) as { agentId: string };
  botId = created.agentId;
  const key = keys(botId);
  // Oldest first: the main session with a Telegram turn, then the bot's own task.
  await turn(key.main, `Hello from Telegram ${STAMP}`, { id: "telegram", to: "telegram:555000" });
  await turn(key.native, "Please reply in plain text");

  const data = mkdtempSync(join(tmpdir(), "clawtrate-channels-"));
  const started = startHost(INSTANCE, STATIC, data, { readOnly: true });
  started.gated.release();
  host = { child: started.host, data };
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    timezoneId: "America/New_York",
    locale: "en-US",
  });
  page = await context.newPage();
  await page.goto(await started.url);
  await page.getByRole("button", { name: "Use the development gateway" }).click();
  await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
  await railShowsBot();
});

test.afterAll(async () => {
  test.setTimeout(180_000);
  if (botId)
    await admin?.request("agents.delete", { agentId: botId, deleteFiles: true }).catch(() => {});
  await admin?.close();
  await page?.context().close();
  if (host) {
    await stopChild(host.child).catch(() => host?.child.kill("SIGKILL"));
    rmSync(host.data, { recursive: true, force: true });
  }
});
process.once("exit", () => host?.child.kill("SIGKILL"));

test("F-519: on a read-only connection, chats from Discord and Slack stay out of the list, its preview, unread and order until shown, and the main conversation stays", async () => {
  test.setTimeout(420_000);
  const key = keys(botId!);
  await unfold();
  await expect(tasks()).toHaveCount(2, { timeout: 30_000 });
  const native = (await rows(botId!)).find((row) => row.key === key.native)!;
  const preview = botRow().first().locator(".bot-preview");
  await expect(preview).toHaveText(plainPreview(native.lastMessagePreview ?? null)!);
  // Both of the bot's own tasks read, so an unread mark can only come from a channel chat.
  for (const each of [key.main, key.native])
    await admin.request("sessions.patch", { key: each, unread: false });
  await expect(botRow().first().locator(".unread-dot")).toHaveCount(0, { timeout: 20_000 });
  const order = await botNames();

  // Newer than both: a Discord channel and a Slack direct message, one of them unread.
  await turn(key.discord, `Status in the server ${STAMP}`, {
    id: "discord",
    to: "channel:1234567890",
  });
  await turn(key.slack, `Quick question ${STAMP}`, { id: "slack", to: "user:U0123" });
  await admin.request("sessions.patch", { key: key.discord, unread: true });
  // Still off: the chats have arrived and nothing shows them.
  await expect(tasks()).toHaveCount(2);
  await expect(botRow().first().locator(".unread-dot")).toHaveCount(0);
  const listed = await rows(botId!);
  expect(listed.find((row) => row.key === key.discord)?.channel).toBe("discord");
  expect(listed.find((row) => row.key === key.main)).toMatchObject({
    isMain: true,
    channel: "telegram",
  });

  // Shown: the rows the host already holds come back, with no reconnect.
  await setShown(true);
  await expect(tasks()).toHaveCount(4, { timeout: 30_000 });
  await expect(tasks().filter({ hasText: "Discord chat" })).toHaveCount(1);
  await expect(botRow().first().locator(".unread-dot")).toHaveCount(1, { timeout: 20_000 });
  await expect(preview).not.toHaveText(plainPreview(native.lastMessagePreview ?? null)!);

  // Hidden again, the default: the list, the preview, unread and the order are as before.
  await setShown(false);
  await expect(tasks()).toHaveCount(2);
  await expect(tasks().filter({ hasText: "Discord chat" })).toHaveCount(0);
  await expect(tasks().filter({ hasText: "Main" })).toHaveCount(1);
  await expect(preview).toHaveText(plainPreview(native.lastMessagePreview ?? null)!);
  await expect(botRow().first().locator(".unread-dot")).toHaveCount(0);
  expect(await botNames()).toEqual(order);

  // The host's choice, not the page's: a reload shows what the host keeps.
  await setShown(true);
  await page.reload();
  await railShowsBot();
  await unfold();
  await expect(tasks()).toHaveCount(4, { timeout: 30_000 });
  await setShown(false);
  await expect(tasks()).toHaveCount(2);
});
