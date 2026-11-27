// A task a bot starts when the gateway's model allowlist doesn't allow the bot's own model (#799),
// against this run's accounts instance (tools/dev-gateway/README.md), on whichever OpenClaw it
// runs. The bot has a list of its own (`agents.entries.<bot>.modelPolicy.allow`), so no other bot
// of the instance is touched. Then (#799 B) a model chosen in the bot's settings goes on that list
// with its line and Undo, and "Allow <model>" on a refused start's card. The interface runs on a
// preview host of its own and is driven as a person drives it; nothing here reaches a real provider.
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

/** Whether `config` holds every value `patch` sets, arrays whole. */
function holds(config: unknown, patch: unknown): boolean {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch))
    return JSON.stringify(config) === JSON.stringify(patch);
  const record = (config ?? {}) as Json;
  return Object.entries(patch as Json).every(([key, value]) => holds(record[key], value));
}

/**
 * A merge patch, once the gateway runs with it. Read back by its content: on a machine under
 * load the gateway's process can be frozen for a minute (its log: "host timing gap detected"),
 * and a patch it took may answer too late. Then it is read again, and sent again if it isn't in.
 */
async function patchConfig(patch: Json, replacePaths: string[] = []): Promise<void> {
  type Revision = {
    hash: string;
    config?: Json;
    configRevisionHash?: string;
    appliedConfigHash?: string;
  };
  const applied = async () => {
    const now = await admin.request<Revision>("config.get", {});
    return holds(now.config, patch) && now.appliedConfigHash === now.configRevisionHash;
  };
  for (let attempt = 1; ; attempt += 1) {
    const before = await admin.request<Revision>("config.get", {});
    if (holds(before.config, patch) && before.appliedConfigHash === before.configRevisionHash)
      return;
    try {
      await admin.request("config.patch", {
        raw: JSON.stringify(patch),
        baseHash: before.hash,
        ...(replacePaths.length > 0 ? { replacePaths } : {}),
      });
      await expect.poll(applied, { timeout: 20_000 }).toBe(true);
      return;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
}

/** The bot's own model list, replaced whole (a shorter one needs `replacePaths`). */
const allow = (models: string[]) =>
  patchConfig({ agents: { entries: { [BOT]: { modelPolicy: { allow: models } } } } }, [
    `agents.entries.${BOT}.modelPolicy.allow`,
  ]);

const botRow = () => page.getByTestId("bot-list").getByRole("button", { name: /^Linnet\b/ });

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

/**
 * The page connected, with its "+". A gateway whose process the loaded machine froze for a while
 * can drop the host's connection, and this development host then waits for a Retry (as after a
 * restart in accounts.spec.ts): one is sent if the "+" isn't back after 30 seconds.
 */
async function connected(): Promise<void> {
  const plus = page.locator(".rail-top").getByRole("button", { name: "New", exact: true });
  try {
    await expect(plus).toBeVisible({ timeout: 30_000 });
  } catch {
    await hostCommand({ type: "retry" });
    await expect(plus).toBeVisible({ timeout: 60_000 });
  }
}

/** A new task for the bot, open, with the cursor in its composer. */
async function newTask(): Promise<Locator> {
  await botRow().click();
  await connected();
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
  // The pairing reads; writing (New task) takes the access a person asks for, as not-run.spec.ts.
  await hostCommand({ type: "requestAccess" });
  await approve();
  await expect(page.getByTestId("plus")).toBeVisible({ timeout: 30_000 });
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

/** The bot's settings, in the Work pane's Settings tab. */
async function botSettings(): Promise<Locator> {
  await botRow().click();
  await connected();
  if (!(await page.getByTestId("work-panel").isVisible()))
    await page.keyboard.press("ControlOrMeta+\\");
  await page.getByRole("tab", { name: "Settings" }).click();
  const settings = page.getByTestId("bot-settings");
  await expect(settings).toBeVisible();
  return settings;
}

/** The bot's model, chosen in its Model menu. */
async function chooseModel(settings: Locator, model: string): Promise<void> {
  await settings.getByTestId("model-select").click();
  await page
    .getByRole("menu", { name: "Model" })
    .getByRole("menuitemradio", { name: new RegExp(`^${model}\\b`) })
    .click();
}

/** The bot's own list as the gateway has it. */
async function ownList(): Promise<unknown> {
  const read = await admin.request<{ config?: Json }>("config.get", {});
  const entries = ((read.config?.agents as Json | undefined)?.entries ?? {}) as Json;
  return ((entries[BOT] as Json | undefined)?.modelPolicy as Json | undefined)?.allow;
}

/** The task a start made, deleted, so its label can be used again. */
async function deleteStarted(label: string): Promise<void> {
  const listed = await admin.request<{ sessions: Json[] }>("sessions.list", {
    agentId: BOT,
    limit: 100,
  });
  for (const row of listed.sessions.filter((each) => each.label === label))
    await admin.request("sessions.delete", { key: row.key, deleteTranscript: true });
}

test("#799 B: a model chosen for the bot goes on its list and its tasks start; Undo, refused again; Allow on the card, started", async () => {
  test.setTimeout(480_000);
  await deleteStarted(HAND_OFF.label);
  // Setting a bot's model, and the one press, take admin access.
  await hostCommand({ type: "requestAccess", tier: "admin" });
  await approve();
  // The bot on dev-2, which its list names: nothing to say.
  await allow(["acme/dev-2"]);
  const settings = await botSettings();
  await expect(settings.getByTestId("model-select")).toBeEnabled({ timeout: 30_000 });
  await chooseModel(settings, "dev-2");
  await expect(settings.getByTestId("model-refused")).toHaveCount(0, { timeout: 30_000 });
  await expect(settings.getByTestId("model-allowed")).toHaveCount(0);
  expect(await ownList()).toEqual(["acme/dev-2"]);

  // dev-1, which it doesn't: the same write puts it on the list, and the line says so.
  await chooseModel(settings, "dev-1");
  const line = settings.getByTestId("model-allowed");
  await expect(line).toHaveText("Added Acme's dev-1 to the models Linnet may use. · Undo", {
    timeout: 30_000,
  });
  expect(await ownList()).toEqual(["acme/dev-2", "acme/dev-1"]);
  const composer = await newTask();
  const started = await startCard(composer, "#hand-off", HAND_OFF.label);
  await expect(started).toContainText("Started a task");
  await deleteStarted(HAND_OFF.label);

  // Undo: that entry alone goes, and the start is refused again with the card's plain words.
  const again = await botSettings();
  await again.getByRole("button", { name: /^Undo: take Acme's dev-1 out/ }).click();
  await expect(again.getByTestId("model-refused")).toContainText(
    "Linnet can't start tasks on Acme's dev-1: this gateway's model list doesn't include it.",
    { timeout: 30_000 },
  );
  expect(await ownList()).toEqual(["acme/dev-2"]);
  const refused = await startCard(await newTask(), "#hand-off", HAND_OFF.label);
  await expectRefused(refused);

  // The press on the card: the same entry and the same line; the start then starts.
  await refused.getByRole("button", { name: "Allow Acme's dev-1 for Linnet's tasks" }).click();
  await expect(refused.getByTestId("model-allowed")).toHaveText(
    "Added Acme's dev-1 to the models Linnet may use. · Undo",
    { timeout: 30_000 },
  );
  expect(await ownList()).toEqual(["acme/dev-2", "acme/dev-1"]);
  const composer2 = page.getByTestId("composer-input");
  await expect(await startCard(composer2, "#hand-off", HAND_OFF.label)).toContainText(
    "Started a task",
  );
  await deleteStarted(HAND_OFF.label);
  await allow(["acme/dev-2"]);
});
