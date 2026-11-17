// The packaged app launches, shows its window and connect screen, and pairs
// with a development gateway instance of this run's own.
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { devGateway } from "../e2e/global-setup.ts";
import { provenEndpoint } from "../tools/dev-gateway/src/endpoint.ts";
import { runDirFor } from "../tools/dev-gateway/src/instance.ts";

const ROOT = join(import.meta.dirname, "..");
const INSTANCE = process.env.CLAWTRATE_DEV_INSTANCE!;
const APP = process.env.CLAWTRATE_PACKAGED_APP!;
const USER_DATA = process.env.CLAWTRATE_PACKAGED_USER_DATA!;

let browser: Browser;
let page: Page;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  browser = await chromium.connectOverCDP(process.env.CLAWTRATE_PACKAGED_CDP!);
  await expect
    .poll(() => browser.contexts().flatMap((context) => context.pages()).length)
    .toBeGreaterThan(0);
  page = browser.contexts().flatMap((context) => context.pages())[0]!;
});

test.afterAll(async () => {
  // Disconnects; the teardown quits the app.
  await browser?.close();
});

test("opens its window from the packaged app on the connect screen", async () => {
  // The renderer is the one inside the app bundle's archive, not the source tree.
  const bundled = `file://${realpathSync(APP)}/Contents/Resources/app.asar/out/renderer/index.html`;
  expect(decodeURI(page.url())).toBe(bundled);
  await expect(page).toHaveTitle("Clawtrate");
  await expect(page.getByRole("heading", { name: "Clawtrate" })).toBeVisible();
  await expect(page.getByPlaceholder("Gateway address")).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect" })).toBeVisible();
  // A packaged app does not look for the development gateway.
  await expect(page.getByRole("button", { name: "Use the development gateway" })).toHaveCount(0);

  // No Node in the page, only the preload's narrow bridge, and the page's policy is in force.
  const page_ = await page.evaluate(() => ({
    require: typeof (globalThis as { require?: unknown }).require,
    process: typeof (globalThis as { process?: unknown }).process,
    host: Object.keys((window as unknown as { clawtrateHost: object }).clawtrateHost).sort(),
    csp:
      document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute("content") ?? "",
  }));
  expect(page_.require).toBe("undefined");
  expect(page_.process).toBe("undefined");
  expect(page_.host).toEqual(["hello", "onState", "platform", "send"]);
  expect(page_.csp).toContain("default-src 'self'");
  expect(page_.csp).toContain("script-src 'self'");
});

test("pairs with its own development gateway instance and shows the seeded bots", async () => {
  expect(INSTANCE).toMatch(/^e2e-[0-9a-f]{8}$/);
  const endpoint = provenEndpoint({
    instance: INSTANCE,
    home: homedir(),
    runDir: runDirFor(INSTANCE, join(ROOT, "tools/dev-gateway/.run")),
    checkout: realpathSync(ROOT),
  });
  if ("refusal" in endpoint) throw new Error(endpoint.refusal);
  expect(endpoint.url).toMatch(/^ws:\/\/127\.0\.0\.1:(19[2-9]\d\d)$/);

  await page.getByPlaceholder("Gateway address").fill(endpoint.url);
  await page.getByPlaceholder("Token, for the first pairing only").fill(endpoint.token);
  await page.getByRole("button", { name: "Connect" }).click();

  // A fresh device identity must be approved on the gateway, over the real protocol.
  await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible({
    timeout: 20_000,
  });
  devGateway(INSTANCE, "approve");

  const bots = page.getByTestId("bot");
  await expect(bots).toHaveCount(4, { timeout: 20_000 });
  await expect(bots).toContainText(["Juniper", "Marlow", "Otto", "Pip"]);
  await page.getByRole("button", { name: /^Otto, \d+ tasks?/ }).click();
  await page
    .getByRole("list", { name: "Otto's tasks" })
    .getByTestId("task")
    .filter({ hasText: "Disk almost full on the media box" })
    .click();
  await expect(page.getByTestId("transcript-turn")).toHaveCount(4);
});

test("keeps the device key and tokens in its own data folder, readable by the user only", () => {
  const dir = join(USER_DATA, "gateway");
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  const files = readdirSync(dir);
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    expect(statSync(join(dir, file)).mode & 0o077, file).toBe(0);
  }
});

test("stays on its own content", async () => {
  // A navigation the page starts is refused, and so is a window for anything
  // but the web. Checked from inside the page: the refused navigation leaves
  // Playwright waiting for one to finish.
  const result = await page.evaluate(async () => {
    const before = location.href;
    const win = window.open("file:///etc/hosts");
    location.href = "https://example.invalid/";
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return {
      windowRefused: win === null,
      stayed: location.href === before,
      bots: document.querySelectorAll('[data-testid="bot"]').length,
    };
  });
  expect(result).toEqual({ windowRefused: true, stayed: true, bots: 4 });
  expect(browser.contexts().flatMap((context) => context.pages())).toHaveLength(1);
});
