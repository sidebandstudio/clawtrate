// Refresh in the Model menu (#565) against the accounts instance's real gateway: a refresh that
// finds nothing says why, from what the gateway reported, and one after the provider's entry
// gained a model (`LATER_MODELS`, written by the admin client as a config change) names it and
// puts it in the menu. The scripted providers are declared in the gateway's config, so a
// refresh asks none of them; no real provider is involved.
import { expect, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCOUNT_CLIENTS } from "../tools/dev-gateway/src/account-checks.ts";
import { grownModels, LATER_MODELS } from "../tools/dev-gateway/src/accounts.ts";
import { openInstance, openOperator } from "../tools/dev-gateway/src/cli.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import { ACCOUNTS, test } from "./accounts-instance.ts";
import { devGateway, listInstances, startHost, stopChild } from "./global-setup.ts";

const INSTANCE = ACCOUNTS;
const STATIC = process.env.CLAWTRATE_E2E_STATIC!;
const LATER = LATER_MODELS.acme!;
const ACME_MODELS = "models.providers.acme.models";

test.describe.configure({ mode: "serial" });

let host: { child: ChildProcess; url: string; data: string } | null = null;
let page: Page;
let admin: OperatorSession;

async function approve(): Promise<void> {
  await expect
    .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
}

/** One bridge command, over the host's own bridge socket. */
async function hostCommand(command: Record<string, unknown>): Promise<void> {
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

/** Acme's model list in the gateway's config, replaced whole, once the gateway runs with it. */
async function acmeModels(models: unknown[]): Promise<void> {
  const before = await admin.request<{ hash: string; configRevisionHash?: string }>(
    "config.get",
    {},
  );
  await admin.request("config.patch", {
    raw: JSON.stringify({ models: { providers: { acme: { models } } } }),
    baseHash: before.hash,
    replacePaths: [ACME_MODELS],
  });
  await expect
    .poll(
      async () => {
        const now = await admin.request<{
          configRevisionHash?: string;
          appliedConfigHash?: string;
        }>("config.get", {});
        return (
          now.configRevisionHash !== before.configRevisionHash &&
          now.appliedConfigHash === now.configRevisionHash
        );
      },
      { timeout: 20_000 },
    )
    .toBe(true);
}

/** New bot's Model menu for Acme · Work, open. */
async function acmeMenu() {
  await page.keyboard.press("ControlOrMeta+n");
  // New bot opens on its first step, or on the Account step it was left on.
  const next = page.getByRole("dialog", { name: "New bot" }).getByRole("button", { name: "Next" });
  const account = page.getByRole("dialog", { name: "Account" });
  await expect(next.or(account)).toBeVisible();
  if (await next.isVisible()) await next.click();
  await account.getByRole("radio", { name: /^Acme · Work/ }).click();
  await account.getByTestId("model-select").click();
  const menu = page.getByRole("menu", { name: "Model" });
  await expect(menu.getByRole("menuitem", { name: "Refresh" })).toBeVisible();
  return menu;
}

async function closeNewBot() {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

test.beforeAll(async ({ accountsInstance, browser }) => {
  // Started by the first of the accounts instance's specs this worker runs (accounts-instance.ts).
  expect(accountsInstance).toBe(INSTANCE);
  test.setTimeout(240_000);
  expect(listInstances().find((each) => each.name === INSTANCE)?.gatewayRunning).toBe(true);
  admin = await openOperator(
    openInstance(INSTANCE),
    "Clawtrate model refresh check",
    [...ACCOUNT_CLIENTS.admin.scopes],
    [...ACCOUNT_CLIENTS.admin.caps],
  );
  const data = mkdtempSync(join(tmpdir(), "clawtrate-refresh-"));
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
  await expect(page.getByTestId("bot").first()).toBeVisible({ timeout: 30_000 });
  // The Model menu is New bot's, which takes admin access.
  await hostCommand({ type: "requestAccess", tier: "admin" });
  await approve();
  await expect(page.getByTestId("plus")).toBeVisible({ timeout: 30_000 });
});

test.afterAll(async () => {
  await admin?.close();
  if (host) {
    await stopChild(host.child);
    rmSync(host.data, { recursive: true, force: true });
  }
});

test("F-588: a refresh that finds nothing says why: the gateway's config lists the provider's models", async () => {
  const menu = await acmeMenu();
  await menu.getByRole("menuitem", { name: "Refresh" }).click();
  await expect(
    menu.getByText("Nothing new. Acme's models are the ones the gateway's config lists.", {
      exact: true,
    }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(menu.getByRole("menuitem", { name: "Refresh" })).toBeFocused();
  await closeNewBot();
});

test("F-588: a refresh after the provider gained a model names it and lists it; one after it went says so", async () => {
  test.setTimeout(120_000);
  const menu = await acmeMenu();
  await expect(menu.getByRole("menuitemradio", { name: LATER })).toHaveCount(0);
  await acmeModels(grownModels("acme"));
  try {
    // Nothing reads the list again until the press.
    await expect(menu.getByRole("menuitemradio", { name: LATER })).toHaveCount(0);
    await menu.getByRole("menuitem", { name: "Refresh" }).click();
    await expect(menu.getByText(`New: ${LATER}.`, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(menu.getByRole("menuitemradio", { name: LATER })).toBeVisible();
  } finally {
    await acmeModels(grownModels("acme").slice(0, -1));
  }
  await menu.getByRole("menuitem", { name: "Refresh" }).click();
  await expect(menu.getByText(`No longer listed: ${LATER}.`, { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(menu.getByRole("menuitemradio", { name: LATER })).toHaveCount(0);
  await closeNewBot();
});
