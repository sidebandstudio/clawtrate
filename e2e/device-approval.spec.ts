// F-550: approving a waiting device from inside Clawtrate, against this run's development gateway
// (docs/design/setup-effortless.md §5). A preview host, given admin through its own Request admin
// access, is the device already in. Each waiting device is Clawtrate's core client in this
// process, with a key of its own and the instance's shared token, so its request waits for an
// approval. The person's pick is a click on the sheet; nothing is typed. What landed is read from
// the gateway by an operator client of this file's own.
//
// The waiting devices' names don't start with "Clawtrate", so the tool's own `approve`, which
// approves every pending Clawtrate request, never approves one of them.
import { expect, test, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClawtrateClient } from "../packages/core/src/client.ts";
import { PAIRING_ENDED } from "../packages/core/src/connect-errors.ts";
import { createNodeHost } from "../packages/core/src/node/index.ts";
import { FULL_SCOPES } from "../packages/core/src/scopes.ts";
import { openInstance, openOperator, readDevConnection } from "../tools/dev-gateway/src/cli.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import { approveDevice } from "./approve.ts";
import { startHost, stopChild } from "./global-setup.ts";

const INSTANCE = process.env.CLAWTRATE_DEV_INSTANCE!;
const STATIC = process.env.CLAWTRATE_E2E_STATIC!;

test.describe.configure({ mode: "serial" });

type Json = Record<string, unknown>;
let admin: OperatorSession;
let host: { child: ChildProcess; data: string; page: Page } | null = null;
const dirs: string[] = [];
const waiting: ClawtrateClient[] = [];
/** The code the approved device showed while it waited. */
let approvedCode = "";

async function approveHost(): Promise<void> {
  await approveDevice(INSTANCE);
}

/** A device that asks to pair, under a name of its own, and waits. */
async function ask(name: string): Promise<ClawtrateClient> {
  const dataDir = mkdtempSync(join(tmpdir(), "clawtrate-waiting-"));
  dirs.push(dataDir);
  const client = new ClawtrateClient(
    createNodeHost({ dataDir, client: { displayName: name, version: "0.0.0", platform: "linux" } }),
  );
  waiting.push(client);
  const connection = readDevConnection(openInstance(INSTANCE).connectionFile)!;
  await client.start();
  void client.connect({ url: connection.url, token: connection.token });
  await expect
    .poll(() => client.state.connection.pairing?.code ?? null, { timeout: 30_000 })
    .toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  return client;
}

const sheetOf = (page: Page) =>
  page.getByRole("dialog", { name: "A device is asking to use this gateway" });
const deviceOf = (client: ClawtrateClient) => client.state.connection.deviceId!;
const listed = () => admin.request<{ pending: Json[]; paired: Json[] }>("device.pair.list", {});

/** The sheet that opened by itself for `client`'s request: it names that device. */
async function sheetFor(page: Page, name: string) {
  const sheet = sheetOf(page);
  await expect(sheet).toBeVisible({ timeout: 30_000 });
  await expect(sheet.getByText(`${name} (reported)`)).toBeVisible();
  return sheet;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  const inst = openInstance(INSTANCE);
  admin = await openOperator(inst, "Clawtrate approval check (admin)", [...FULL_SCOPES], []);
  const data = mkdtempSync(join(tmpdir(), "clawtrate-approver-"));
  dirs.push(data);
  const started = startHost(INSTANCE, STATIC, data);
  started.gated.release();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  host = { child: started.host, data, page };
  await page.goto(await started.url);
  await page.getByRole("button", { name: "Use the development gateway" }).click();
  await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible({
    timeout: 20_000,
  });
  await approveHost();
  await expect(page.getByTestId("bot").first()).toBeVisible({ timeout: 30_000 });
  // Admin, asked for by the person, as anywhere else in the app.
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Check-ins", exact: true }).click();
  const bar = settings.getByTestId("admin-bar");
  await bar.getByRole("button", { name: "Request admin access" }).click();
  await approveHost();
  await expect(bar).toContainText("Admin access granted.", { timeout: 30_000 });
  await page.keyboard.press("Escape");
});

test.afterAll(async () => {
  for (const client of waiting) client.stop();
  const mine = new Set(waiting.map(deviceOf));
  const { pending, paired } = await listed().catch(() => ({ pending: [], paired: [] }));
  for (const row of pending)
    if (mine.has(String(row.deviceId)))
      await admin.request("device.pair.reject", { requestId: row.requestId }).catch(() => {});
  for (const row of paired)
    if (mine.has(String(row.deviceId)))
      await admin.request("device.pair.remove", { deviceId: row.deviceId }).catch(() => {});
  if (host) {
    await host.page
      .context()
      .close()
      .catch(() => {});
    await stopChild(host.child).catch(() => {});
  }
  await admin?.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("F-550: the device already in picks the waiting device's code; it is in, and its screen moved on by itself", async () => {
  test.setTimeout(120_000);
  const page = host!.page;
  const device = await ask("Waiting laptop");
  const code = device.state.connection.pairing!.code!;
  approvedCode = code;
  const sheet = await sheetFor(page, "Waiting laptop");
  await expect(sheet.locator(`[data-code="${code}"]`)).toHaveCount(1);
  await sheet.locator(`[data-code="${code}"]`).click();
  await expect(sheet.getByTestId("device-outcome")).toHaveText(
    "Approved. The device connects in a moment.",
    { timeout: 30_000 },
  );
  // Nothing was pressed on the waiting device: its own retry connects.
  await expect.poll(() => device.state.connection.status, { timeout: 30_000 }).toBe("connected");
  expect(device.state.connection.pairing).toBeNull();
  const paired = (await listed()).paired.find((row) => row.deviceId === deviceOf(device));
  expect(paired?.scopes).toEqual(device.state.connection.requestedScopes);
  await sheet.getByRole("button", { name: "Close" }).click();
});

test("F-550: a wrong pick approves nothing, and Deny ends the request, which the waiting screen says", async () => {
  test.setTimeout(120_000);
  const page = host!.page;
  const device = await ask("Waiting tablet");
  const code = device.state.connection.pairing!.code!;
  const sheet = await sheetFor(page, "Waiting tablet");
  const wrong = sheet.locator(".device-code").filter({ hasNotText: code }).first();
  await wrong.click();
  await expect(sheet.getByTestId("device-outcome")).toContainText(
    "That isn't this request's code, so nothing was approved.",
  );
  const before = await listed();
  expect(before.paired.some((row) => row.deviceId === deviceOf(device))).toBe(false);
  const denied = before.pending.find((row) => row.deviceId === deviceOf(device))?.requestId;
  expect(denied).toBeDefined();
  await sheet.getByRole("button", { name: "Deny it" }).click();
  await expect(sheet.getByTestId("device-outcome")).toHaveText("Denied. The device can ask again.");
  expect((await listed()).pending.some((row) => row.requestId === denied)).toBe(false);
  await expect
    .poll(() => device.state.connection.error?.code ?? null, { timeout: 30_000 })
    .toBe(PAIRING_ENDED.code);
  await sheet.getByRole("button", { name: "Close" }).click();
  // The retry that learned of the denial filed one more request as it stopped (§4): it is
  // listed, and doesn't open the sheet by itself again.
  let again: unknown;
  await expect
    .poll(
      async () => {
        again = (await listed()).pending.find(
          (row) => row.deviceId === deviceOf(device),
        )?.requestId;
        return again ?? null;
      },
      { timeout: 30_000 },
    )
    .not.toBeNull();
  await expect(page.getByTestId("devices-asking")).toContainText(
    "A device is asking to use this gateway.",
  );
  await expect(sheetOf(page)).toHaveCount(0);
  await admin.request("device.pair.reject", { requestId: again });
  await expect(page.getByTestId("devices-asking")).toHaveCount(0, { timeout: 30_000 });
});

test("F-550: a request from a third key shows a code the approved device doesn't, and opens from Settings", async () => {
  test.setTimeout(120_000);
  const page = host!.page;
  const third = await ask("Waiting phone");
  const code = third.state.connection.pairing!.code!;
  // The Deny before keeps the host from opening a sheet by itself: Settings, Gateway lists it.
  await expect(page.getByTestId("devices-asking")).toContainText("A device is asking", {
    timeout: 30_000,
  });
  await expect(sheetOf(page)).toHaveCount(0);
  await page.getByTestId("devices-asking").getByRole("button", { name: "Review" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: /^Waiting phone \(reported\)/ }).click();
  const sheet = sheetOf(page);
  await expect(sheet.getByText("Waiting phone (reported)")).toBeVisible();
  const shown = await sheet
    .locator(".device-code")
    .evaluateAll((buttons) => buttons.map((b) => b.getAttribute("data-code")));
  expect(shown).toContain(code);
  // The code the approved device showed, from its key and its own request, is on none of these.
  expect(approvedCode).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  expect(code).not.toBe(approvedCode);
  expect(shown).not.toContain(approvedCode);
  await sheet.getByRole("button", { name: "I didn't start this" }).click();
  await expect(sheet.getByTestId("device-outcome")).toHaveText("Denied. The device can ask again.");
  await sheet.getByRole("button", { name: "Close" }).click();
  await page.keyboard.press("Escape");
});
