// Settings › Models (docs/design/gateway-settings.md section 4.1) against the accounts instance's
// real gateway: changing the default model writes `agents.defaults.model.primary`, reads it back
// as written and offers Put back with the earlier value; once another device has written the
// setting, Put back writes nothing and says what is there now. No real provider is involved.
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
const CHOSEN = "acme/dev-2@acme:home";

test.describe.configure({ mode: "serial" });

let host: { child: ChildProcess; url: string; data: string } | null = null;
let page: Page;
let admin: OperatorSession;
let before: string | null = null;

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

type ConfigRead = { hash: string; config: { agents?: { defaults?: { model?: unknown } } } };

async function primary(): Promise<string | null> {
  const read = await admin.request<ConfigRead>("config.get", {});
  const model = read.config.agents?.defaults?.model;
  if (typeof model === "string") return model;
  return (model as { primary?: string } | undefined)?.primary ?? null;
}

/** Another device writes the default model, as an admin client of its own. */
async function otherDeviceWrites(ref: string): Promise<void> {
  const read = await admin.request<ConfigRead>("config.get", {});
  await admin.request("config.patch", {
    raw: JSON.stringify({ agents: { defaults: { model: { primary: ref } } } }),
    baseHash: read.hash,
  });
  await expect.poll(primary, { timeout: 20_000 }).toBe(ref);
}

test.beforeAll(async ({ accountsInstance, browser }) => {
  expect(accountsInstance).toBe(INSTANCE);
  test.setTimeout(240_000);
  expect(listInstances().find((each) => each.name === INSTANCE)?.gatewayRunning).toBe(true);
  admin = await openOperator(
    openInstance(INSTANCE),
    "Clawtrate settings models check",
    [...ACCOUNT_CLIENTS.admin.scopes],
    [...ACCOUNT_CLIENTS.admin.caps],
  );
  before = await primary();
  const data = mkdtempSync(join(tmpdir(), "clawtrate-models-"));
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
  await expect(page.getByTestId("bot").first()).toBeVisible({ timeout: 30_000 });
  // Changing the models takes admin access.
  await hostCommand({ type: "requestAccess", tier: "admin" });
  await approve();
  await expect(page.getByTestId("plus")).toBeVisible({ timeout: 30_000 });
});

test.afterAll(async () => {
  // The instance is shared with the other accounts specs: its default model goes back.
  if (admin && before !== null) await otherDeviceWrites(before).catch(() => {});
  await admin?.close();
  if (host) {
    await stopChild(host.child);
    rmSync(host.data, { recursive: true, force: true });
  }
});

test("the default model changes, is read back as written, and Put back restores it", async () => {
  test.setTimeout(120_000);
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Models" }).click();
  const choice = settings.getByRole("combobox", { name: /Default model/ });
  await expect(choice).toBeEnabled({ timeout: 30_000 });
  await choice.selectOption(CHOSEN);
  await expect(
    settings.getByRole("status").filter({ hasText: "Default model is now" }),
  ).toBeVisible({
    timeout: 30_000,
  });
  expect(await primary()).toBe(CHOSEN);
  await settings.getByRole("button", { name: /^Put back / }).click();
  await expect.poll(primary, { timeout: 30_000 }).toBe(before);
});

test("after another device writes it, Put back writes nothing and says what is there", async () => {
  test.setTimeout(120_000);
  const settings = page.getByRole("dialog", { name: "Settings" });
  const choice = settings.getByRole("combobox", { name: /Default model/ });
  await choice.selectOption(CHOSEN);
  await expect(settings.getByRole("button", { name: /^Put back / })).toBeVisible({
    timeout: 30_000,
  });
  await otherDeviceWrites("acme/dev-1@acme:work");
  await settings.getByRole("button", { name: /^Put back / }).click();
  await expect(
    settings.getByText(/^Changed on another device since: default model is now /),
  ).toBeVisible({ timeout: 30_000 });
  expect(await primary()).toBe("acme/dev-1@acme:work");
});
