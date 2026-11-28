// A message the gateway couldn't run (#663) and the mark of a task's latest run (#664), against
// this run's accounts instance (tools/dev-gateway/README.md), on whichever OpenClaw it runs: a bot
// set to an account the gateway doesn't have fails each message before any run of it starts. The
// interface runs on a preview host of its own and is driven as a person drives it; nothing here
// reaches a real provider.
import { expect, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { solidPng } from "../packages/core/test/sent-attachments-rows.ts";
import { ACCOUNT_CLIENTS } from "../tools/dev-gateway/src/account-checks.ts";
import { openInstance, openOperator } from "../tools/dev-gateway/src/cli.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import { ACCOUNTS, test } from "./accounts-instance.ts";
import { devGateway, listInstances, startHost, stopChild } from "./global-setup.ts";

const INSTANCE = ACCOUNTS;
const STATIC = process.env.CLAWTRATE_E2E_STATIC!;
const BOT = "wren";

test.describe.configure({ mode: "serial" });

let host: { child: ChildProcess; url: string; data: string } | null = null;
/** A second device: a preview host of its own, with its own pairing. */
let second: { child: ChildProcess; url: string; data: string } | null = null;
let page: Page;
let admin: OperatorSession;

type Json = Record<string, unknown>;

async function approve(): Promise<void> {
  await expect
    .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
}

/** A merge patch, after which the gateway runs with it (as account-checks.ts waits for one). */
async function patchConfig(patch: Json): Promise<void> {
  type Revision = { hash: string; configRevisionHash?: string; appliedConfigHash?: string };
  const before = await admin.request<Revision>("config.get", {});
  await admin.request("config.patch", { raw: JSON.stringify(patch), baseHash: before.hash });
  await expect
    .poll(
      async () => {
        const now = await admin.request<Revision>("config.get", {});
        return (
          now.configRevisionHash !== before.configRevisionHash &&
          now.appliedConfigHash === now.configRevisionHash
        );
      },
      { timeout: 20_000 },
    )
    .toBe(true);
}

/** The bot's model, as New bot writes it: the reference and no fallbacks. */
const setModel = (primary: string) =>
  patchConfig({ agents: { entries: { [BOT]: { model: { primary, fallbacks: [] } } } } });

/** One bridge command, over the host's own bridge socket, as another viewer of the page sends it. */
async function hostCommand(command: Json): Promise<void> {
  await page.evaluate(
    (command) =>
      new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`ws://${location.host}/bridge`);
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as { type: string; id?: string };
          if (message.type === "hello")
            socket.send(JSON.stringify({ type: "command", id: "do", command }));
          else if (message.id === "do") {
            socket.close();
            resolve();
          }
        };
        socket.onerror = () => reject(new Error("bridge socket error"));
      }),
    command,
  );
}

const botRow = (on: Page = page) =>
  on.getByTestId("bot-list").getByRole("button", { name: /^Wren\b/ });

/**
 * What the line says once only the gateway's history has the message: 2026.10.6 keeps the reason
 * in its row for it; 2026.11.10, which fails this message at dispatch, keeps only that it failed.
 */
function afterReload(): { reason: string; changeAccount: boolean } {
  return admin.serverVersion === "2026.10.6"
    ? {
        reason:
          "The account Wren is set to isn't available on the gateway. Choose another account.",
        changeAccount: true,
      }
    : { reason: "The gateway didn't say why.", changeAccount: false };
}

/** The task's line on a page, its words as the gateway's history rebuilds them. */
async function lineFromHistory(on: Page): Promise<void> {
  await botRow(on).click();
  const line = on.getByTestId("turn-error");
  await expect(line).toContainText("The gateway couldn't run this message", { timeout: 60_000 });
  const { reason, changeAccount } = afterReload();
  await expect(line).toContainText(reason);
  await expect(line.getByRole("button", { name: "Change account" })).toHaveCount(
    changeAccount ? 1 : 0,
  );
  await expect(line.getByRole("button", { name: "Try again" })).toBeVisible();
}

test.beforeAll(async ({ accountsInstance, browser }) => {
  expect(accountsInstance).toBe(INSTANCE);
  test.setTimeout(240_000);
  const row = listInstances().find((each) => each.name === INSTANCE);
  expect(row?.gatewayRunning, "the accounts instance runs").toBe(true);
  const inst = openInstance(INSTANCE);
  admin = await openOperator(
    inst,
    "Clawtrate not-run check",
    [...ACCOUNT_CLIENTS.admin.scopes],
    [...ACCOUNT_CLIENTS.admin.caps],
  );
  // A bot set to an account the gateway doesn't have: every message fails before a run starts.
  const created = await admin.request<{ ok: boolean; agentId: string }>("agents.create", {
    name: "Wren",
    workspace: join(inst.stateDir, "workspaces", BOT),
    model: "acme/dev-1@acme:missing",
  });
  expect(created).toMatchObject({ ok: true, agentId: BOT });
  await setModel("acme/dev-1@acme:missing");

  const data = mkdtempSync(join(tmpdir(), "clawtrate-not-run-"));
  const started = startHost(INSTANCE, STATIC, data);
  started.gated.release();
  // Kept before the wait, so a start that never answers is still stopped and removed.
  host = { child: started.host, url: "", data };
  host.url = await started.url;
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(host.url);
  await page.getByRole("button", { name: "Use the development gateway" }).click();
  await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible({
    timeout: 20_000,
  });
  await approve();
  await expect(botRow()).toBeVisible({ timeout: 30_000 });
  await hostCommand({ type: "requestAccess" });
  await approve();
  await expect(page.getByTestId("plus")).toBeVisible({ timeout: 30_000 });
});

test.afterAll(async () => {
  await admin?.request("agents.delete", { agentId: BOT, deleteFiles: true }).catch(() => {});
  await admin?.close();
  for (const each of [host, second]) {
    if (!each) continue;
    await stopChild(each.child);
    rmSync(each.data, { recursive: true, force: true });
  }
});

test("F-480 #663 #664: a message the gateway couldn't run says why, after a reload and on another device too; fixed and sent again, the reply comes and the mark goes", async ({
  browser,
}) => {
  test.setTimeout(420_000);
  await botRow().click();
  await page.locator(".rail-top").getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "New task for Wren" }).click();
  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeFocused({ timeout: 20_000 });
  await composer.fill("hello");
  await composer.press("Enter");

  // The line under the message: the gateway's reason in plain words, and the ways forward.
  const line = page.getByTestId("turn-error");
  await expect(line).toContainText("The gateway couldn't run this message", { timeout: 60_000 });
  await expect(line).toContainText(
    "The account Wren is set to isn't available on the gateway. Choose another account.",
  );
  await expect(line.getByRole("button", { name: "Change account" })).toBeVisible();
  await expect(line.getByRole("button", { name: "Try again" })).toBeVisible();
  // The bot's row says its latest run failed.
  await expect(botRow()).toHaveAccessibleName(/^Wren, a run failed\b/, { timeout: 20_000 });

  // Change account opens the bot's Account page in the Work pane.
  await line.getByRole("button", { name: "Change account" }).click();
  await expect(page.getByRole("tab", { name: "Settings" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const settings = page.getByRole("tabpanel", { name: "Settings" });
  await expect(settings.getByRole("heading", { name: "Account" })).toBeVisible();
  await expect(settings).toContainText("Wren's account was disconnected");

  // Reloaded, the task opened again: the line is rebuilt from the gateway's history.
  await page.reload();
  await expect(botRow()).toBeVisible({ timeout: 30_000 });
  await lineFromHistory(page);
  await expect(botRow()).toHaveAccessibleName(/^Wren, a run failed\b/, { timeout: 20_000 });

  // Another device, paired now, reads the same task: the same line, and the bot marked.
  const data = mkdtempSync(join(tmpdir(), "clawtrate-not-run-second-"));
  const started = startHost(INSTANCE, STATIC, data);
  started.gated.release();
  second = { child: started.host, url: "", data };
  second.url = await started.url;
  const other = await (
    await browser.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  await other.goto(second.url);
  await other.getByRole("button", { name: "Use the development gateway" }).click();
  await expect(other.getByRole("heading", { name: "Approve this device" })).toBeVisible({
    timeout: 20_000,
  });
  await approve();
  await expect(botRow(other)).toBeVisible({ timeout: 30_000 });
  await lineFromHistory(other);
  await expect(botRow(other)).toHaveAccessibleName(/^Wren, a run failed\b/, { timeout: 20_000 });

  // The bot fixed on the gateway, the message sent again: a reply, and the mark gone at once.
  await setModel("acme/dev-1@acme:work");
  await line.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("message").filter({ hasText: "scripted" }).first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(botRow()).not.toHaveAccessibleName(/a run failed/, { timeout: 20_000 });
  // On the other device too, without a reload.
  await expect(botRow(other)).not.toHaveAccessibleName(/a run failed/, { timeout: 20_000 });
  // The first message keeps its line: it still wasn't run.
  await expect(line).toContainText("The gateway couldn't run this message");
});

test("F-480 #988: after the same pre-run failure, the card leads with recovery and resends the picture", async () => {
  test.setTimeout(180_000);
  await setModel("acme/dev-1@acme:missing");
  const key = `agent:${BOT}:picture-retry`;
  await admin.request("sessions.create", { key, agentId: BOT, label: "Picture retry" });
  if ((await botRow().getAttribute("aria-expanded")) !== "true") await botRow().click();
  await page.getByTestId("task").filter({ hasText: "Picture retry" }).click();
  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeEditable({ timeout: 20_000 });
  await composer.fill("Check this first.");
  await composer.press("Enter");
  const failures = page.getByTestId("turn-error");
  await expect(failures).toHaveCount(1, { timeout: 60_000 });

  const shot = Buffer.from(solidPng(48, 32, [220, 40, 40]));
  await page
    .locator('.composer input[type="file"]')
    .setInputFiles([{ name: "recovery.png", mimeType: "image/png", buffer: shot }]);
  await expect(page.locator(".attachments .chip:not([aria-busy=true])")).toHaveCount(1);
  const prompt = "Check this picture.";
  await composer.fill(prompt);
  await composer.press("Enter");
  await expect(failures).toHaveCount(2, { timeout: 60_000 });
  const failure = failures.last();
  await expect(failure).toContainText(
    "This happened on the previous attempt too. Sending again is unlikely to help.",
  );
  await expect(failure.locator(".turn-error-actions button").nth(0)).toHaveText("Change account");
  await expect(failure.locator(".turn-error-actions button").nth(1)).toHaveText("Try again");
  await expect(page.getByTestId("outgoing")).toHaveCount(0, { timeout: 30_000 });

  const pictures = async () => {
    const history = await admin.request<{ messages: Array<Record<string, unknown>> }>(
      "chat.history",
      { sessionKey: key, limit: 30 },
    );
    return history.messages
      .filter((row) => row.role === "user" && row.content === prompt)
      .map((row) =>
        (row.__openclaw as { media?: Array<{ fileName: string }> })?.media?.map(
          (file) => file.fileName,
        ),
      );
  };
  await expect.poll(pictures).toEqual([["recovery.png"]]);
  await setModel("acme/dev-1@acme:work");
  await failure.getByRole("button", { name: "Try again" }).click();
  await expect.poll(pictures, { timeout: 60_000 }).toEqual([["recovery.png"], ["recovery.png"]]);
  await expect(page.getByTestId("message").filter({ hasText: "scripted" }).first()).toBeVisible({
    timeout: 60_000,
  });
});
