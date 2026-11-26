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

const botRow = () => page.getByTestId("bot-list").getByRole("button", { name: /^Wren\b/ });

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
  host = { child: started.host, url: await started.url, data };
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
  if (host) {
    await stopChild(host.child);
    rmSync(host.data, { recursive: true, force: true });
  }
});

test("F-480 #663 #664: a message the gateway couldn't run says why; fixed and sent again, the reply comes and the mark goes without a reload", async () => {
  test.setTimeout(240_000);
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
    "The account Wren is set to isn't on the gateway any more. Choose another account.",
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
  await expect(page.getByTestId("bot-settings").locator("[data-bs='change']")).toBeVisible();

  // The bot fixed on the gateway, the message sent again: a reply, and the mark gone at once.
  await setModel("acme/dev-1@acme:work");
  await line.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("message").filter({ hasText: "scripted" }).first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(botRow()).not.toHaveAccessibleName(/a run failed/, { timeout: 20_000 });
  // The first message keeps its line: it still wasn't run.
  await expect(line).toContainText("The gateway couldn't run this message");
});
