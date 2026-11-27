// A task a bot starts when the gateway's model allowlist doesn't allow the bot's own model (#799),
// against this run's accounts instance (tools/dev-gateway/README.md), on whichever OpenClaw it
// runs. The bot has a list of its own (`agents.entries.<bot>.modelPolicy.allow`), so no other bot
// of the instance is touched. The interface runs on a preview host of its own and is driven as a
// person drives it; nothing here reaches a real provider.
import { expect, type Locator, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCOUNT_CLIENTS } from "../tools/dev-gateway/src/account-checks.ts";
import { openInstance, openOperator } from "../tools/dev-gateway/src/cli.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import { CREATE_TASK, HAND_OFF } from "../tools/dev-gateway/src/scenarios.ts";
import { ACCOUNTS, test } from "./accounts-instance.ts";
import { devGateway, listInstances, startHost, stopChild } from "./global-setup.ts";

const INSTANCE = ACCOUNTS;
const STATIC = process.env.CLAWTRATE_E2E_STATIC!;
const BOT = "linnet";
/** The bot's own model, which its list doesn't name. */
const MODEL = "acme/dev-1";
const REFUSED = "This gateway doesn't allow tasks on Acme's dev-1.";

test.describe.configure({ mode: "serial" });

let host: { child: ChildProcess; url: string; data: string } | null = null;
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

/** The bot's own model list, replaced whole. */
const allow = (models: string[]) =>
  patchConfig({ agents: { entries: { [BOT]: { modelPolicy: { allow: models } } } } });

const botRow = () => page.getByTestId("bot-list").getByRole("button", { name: /^Linnet\b/ });

/** A new task for the bot, open, with the cursor in its composer. */
async function newTask(): Promise<Locator> {
  await botRow().click();
  await page.locator(".rail-top").getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "New task for Linnet" }).click();
  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeFocused({ timeout: 20_000 });
  return composer;
}

/** Send a message, and the card of the start it asks for, once it has settled. */
async function startCard(composer: Locator, message: string, title: string): Promise<Locator> {
  const before = await page.getByTestId("started-task-card").count();
  await composer.fill(message);
  await composer.press("Enter");
  const cards = page.getByTestId("started-task-card").filter({ hasText: title });
  await expect(page.getByTestId("started-task-card")).toHaveCount(before + 1, { timeout: 60_000 });
  const card = cards.last();
  await expect(card).not.toHaveAttribute("data-state", "starting", { timeout: 60_000 });
  return card;
}

/** A refused start says why in plain words, never the gateway's own, and opens nothing. */
async function expectRefused(card: Locator): Promise<void> {
  await expect(card).toHaveAttribute("data-state", "couldnt-start");
  await expect(card).toContainText("Couldn't start a task");
  await expect(card).toContainText(REFUSED);
  await expect(card).not.toContainText("model not allowed");
  await expect(card).not.toContainText("The gateway says");
  await expect(card.getByRole("button", { name: /^Open / })).toHaveCount(0);
}

test.beforeAll(async ({ accountsInstance, browser }) => {
  expect(accountsInstance).toBe(INSTANCE);
  test.setTimeout(240_000);
  const row = listInstances().find((each) => each.name === INSTANCE);
  expect(row?.gatewayRunning, "the accounts instance runs").toBe(true);
  const inst = openInstance(INSTANCE);
  admin = await openOperator(
    inst,
    "Clawtrate task model check",
    [...ACCOUNT_CLIENTS.admin.scopes],
    [...ACCOUNT_CLIENTS.admin.caps],
  );
  const created = await admin.request<{ ok: boolean; agentId: string }>("agents.create", {
    name: "Linnet",
    workspace: join(inst.stateDir, "workspaces", BOT),
    model: `${MODEL}@acme:work`,
  });
  expect(created).toMatchObject({ ok: true, agentId: BOT });
  await patchConfig({
    agents: { entries: { [BOT]: { model: { primary: `${MODEL}@acme:work`, fallbacks: [] } } } },
  });
  // A list of the bot's own that names another model: the bot's own still runs its conversations.
  await allow(["acme/dev-2"]);

  const data = mkdtempSync(join(tmpdir(), "clawtrate-task-model-"));
  const started = startHost(INSTANCE, STATIC, data);
  started.gated.release();
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
});

test.afterAll(async () => {
  await admin?.request("agents.delete", { agentId: BOT, deleteFiles: true }).catch(() => {});
  await admin?.close();
  if (host) {
    await stopChild(host.child);
    rmSync(host.data, { recursive: true, force: true });
  }
});

test("#799: a task a bot starts on a model its list doesn't allow says why in plain words; allowed, it starts", async () => {
  test.setTimeout(300_000);
  const composer = await newTask();
  await expectRefused(await startCard(composer, "#hand-off", HAND_OFF.label));

  // The model allowed, the same start starts, and the card opens the task.
  await allow(["acme/dev-2", MODEL]);
  const card = await startCard(composer, "#hand-off", HAND_OFF.label);
  await expect(card).toContainText("Started a task");
  await expect(card).not.toContainText(REFUSED);
  await expect(card.getByRole("button", { name: `Open ${HAND_OFF.label}` })).toBeVisible({
    timeout: 30_000,
  });
  await allow(["acme/dev-2"]);
});

test("#799: on OpenClaw 2026.11.10 a task made with sessions_create is the same card, refused and started", async () => {
  test.skip(admin.serverVersion !== "2026.11.10", "2026.10.6 has no sessions_create");
  test.setTimeout(300_000);
  const composer = await newTask();
  await expectRefused(await startCard(composer, "#create-task", CREATE_TASK.label));

  await allow(["acme/dev-2", MODEL]);
  const card = await startCard(composer, "#create-task", CREATE_TASK.label);
  await expect(card).toContainText("Started a task");
  const open = card.getByRole("button", { name: `Open ${CREATE_TASK.label}` });
  await expect(open).toBeVisible({ timeout: 30_000 });
  await open.click();
  await expect(page.locator(".task-line")).toHaveText(CREATE_TASK.label, { timeout: 20_000 });
  await allow(["acme/dev-2"]);
});
