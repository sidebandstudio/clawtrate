// What a bot hands over (work-pane.md, Part 2) against this run's own
// development gateway. A paired test client sends the `#hand-*` scenarios
// with `chat.send`, the gateway's own path for attaching what a reply names;
// the interface watches on a preview host of this spec's own, whose device is
// paired read-only and stays so. Every kind is checked live, again after a
// reload from history, saved with identical bytes, and an item the gateway
// lost says so and offers Try again. Nothing is fetched by the page from any
// address but its host's.
//
// With CLAWTRATE_ARTIFACT_SHOTS=<folder outside the repository>, it also
// saves screenshots of what it checked there.
import { expect, test, type Browser, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInstance, openOperator } from "../tools/dev-gateway/src/cli.ts";
import {
  forgetHandover,
  HANDOVER,
  HANDOVER_BOT,
  handoverFiles,
  REPORT_TEXT,
} from "../tools/dev-gateway/src/handover.ts";
import type { OperatorSession } from "../tools/dev-gateway/src/operator.ts";
import { devGateway, startHost, stopChild } from "./global-setup.ts";
import { leaveIdle } from "./teardown.ts";

const INSTANCE = process.env.CLAWTRATE_DEV_INSTANCE!;
const STATIC = process.env.CLAWTRATE_E2E_STATIC!;
const SHOTS = process.env.CLAWTRATE_ARTIFACT_SHOTS ?? null;
const STAMP = Date.now().toString(36);

type Host = { child: ChildProcess; url: string; data: string };
let host: Host | null = null;
let op: OperatorSession;
let page: Page;
/** Requests the page made to anything but its own host. */
const away: string[] = [];
const files = handoverFiles();

async function pairedPage(browser: Browser, url: string): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  const next = await context.newPage();
  const own = new URL(url).host;
  next.on("request", (request) => {
    const target = new URL(request.url());
    if (!["data:", "blob:"].includes(target.protocol) && target.host !== own)
      away.push(request.url());
  });
  await next.goto(url);
  await next.getByRole("button", { name: "Use the development gateway" }).click();
  await expect(next.getByRole("heading", { name: "Approve this device" })).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(() => devGateway(INSTANCE, "approve"), { timeout: 30_000, intervals: [1000] })
    .toMatch(/^Approved /m);
  await expect(next.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
  return next;
}

/** A task of Marlow's with this label, a handover sent in it, and the run's end. */
async function handOver(label: string, message: string): Promise<string> {
  const created = await op.request<{ key: string }>("sessions.create", {
    agentId: HANDOVER_BOT,
    label: `${label} ${STAMP}`,
  });
  const sent = await op.send(created.key, message);
  await op.terminal(String(sent.runId), 120_000);
  return created.key;
}

async function openTask(label: string) {
  const name = `${label} ${STAMP}`;
  const row = page.getByTestId("bot-list").getByRole("button", { name: /^Marlow\b/ });
  if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
  const list = page.getByRole("list", { name: "Marlow's tasks" });
  const all = list.getByRole("button", { name: /^Show all/ });
  if (await all.isVisible()) await all.click();
  await list.getByTestId("task").filter({ hasText: name }).click();
  await expect(page.getByRole("button", { name: new RegExp(`^Marlow, ${name}\\.`) })).toBeVisible();
}

const card = (name: string) => page.getByTestId("artifact-card").filter({ hasText: name }).first();
const cell = (name: string) => page.locator(`.media-cell[aria-label^="${name}"]`).first();

async function shoot(
  name: string,
  widths: Array<[number, "light" | "dark"]> = [
    [1440, "light"],
    [1440, "dark"],
    [390, "light"],
  ],
) {
  if (!SHOTS) return;
  for (const [width, theme] of widths) {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 900 });
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, `${name}-${width}-${theme}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: null });
}

async function closePane() {
  if ((await page.locator(".shell").getAttribute("data-panel")) === "open")
    await page.getByRole("button", { name: "Close work panel" }).first().click();
}

const since = Date.now();

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  const inst = openInstance(INSTANCE);
  op = await openOperator(
    inst,
    "Clawtrate artifact check",
    ["operator.read", "operator.write"],
    ["tool-events"],
  );
  const data = mkdtempSync(join(tmpdir(), "clawtrate-artifacts-"));
  const started = startHost(INSTANCE, STATIC, data);
  started.gated.release();
  host = { child: started.host, url: await started.url, data };
  page = await pairedPage(browser, host.url);
});

test.afterAll(async () => {
  if (op) await leaveIdle((method, params) => op.request(method, params), since).catch(() => {});
  await op?.close();
  await page?.context().close();
  if (host) {
    await stopChild(host.child);
    rmSync(host.data, { recursive: true, force: true });
  }
});

test("F-115 F-118: a file Marlow hands over is a card that opens in the pane, on a read-only connection, and saves byte for byte", async () => {
  await handOver("Trail report", "#hand-file");
  await openTask("Trail report");
  // This device holds operator.read only.
  await expect(page.getByText(/^Read-only\./)).toBeVisible();
  const report = card("trail-report.md");
  await expect(report).toBeVisible({ timeout: 30_000 });
  await expect(
    report.getByRole("button", {
      name: "trail-report.md, Markdown, 149 B. Open in the Work pane.",
    }),
  ).toBeVisible();
  await shoot("card-file");
  await report.getByRole("button", { name: /^trail-report\.md/ }).click();
  const reader = page.getByTestId("artifact-reader");
  await expect(reader.getByRole("heading", { name: "trail-report.md" })).toBeVisible();
  await expect(reader.locator(".reader-preview")).toContainText(
    "Ridge path: muddy below the saddle.",
    {
      timeout: 30_000,
    },
  );
  await expect(reader.locator(".reader-source")).toContainText("Sent by Marlow at");
  await shoot("pane-file");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    reader.getByRole("button", { name: "Download trail-report.md" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("trail-report.md");
  expect(readFileSync((await download.path())!, "utf8")).toBe(REPORT_TEXT);
  // Raw: the gateway's own record, without data or address.
  await reader.getByRole("button", { name: "Raw" }).click();
  const raw = page.getByTestId("artifact-raw");
  await expect(raw).toContainText('"id": "artifact_managed_media_', { timeout: 30_000 });
  await expect(raw).not.toContainText("mediaTicket");
  await closePane();
  // After a reload, from history alone.
  await page.reload();
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
  await expect(card("trail-report.md")).toBeVisible({ timeout: 30_000 });
});

test("F-117 F-305 F-306: a picture and a recording, live and after a reload; the viewer opens the picture and saves its bytes", async () => {
  await handOver("Ridge profile", "#hand-picture");
  await handOver("Trailhead chime", "#hand-audio");
  await openTask("Ridge profile");
  const picture = cell("ridge-profile.png");
  await expect(picture.locator("img")).toBeVisible({ timeout: 30_000 });
  await shoot("card-picture");
  await picture.click();
  const viewer = page.getByTestId("media-viewer");
  await expect(viewer).toHaveAccessibleName("ridge-profile.png");
  await expect(page.getByTestId("viewer-image")).toBeVisible();
  await shoot("viewer-picture");
  const [saved] = await Promise.all([
    page.waitForEvent("download"),
    page.keyboard.press("ControlOrMeta+s"),
  ]);
  expect(saved.suggestedFilename()).toBe("ridge-profile.png");
  expect(readFileSync((await saved.path())!).equals(files[HANDOVER.picture]!)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(picture).toBeFocused();

  await openTask("Trailhead chime");
  const chime = card("trail-chime.wav");
  await expect(chime).toBeVisible({ timeout: 30_000 });
  await expect(chime).toContainText("WAV audio · 31 KB");
  await shoot("card-audio");
  await chime.getByRole("button", { name: "Play trail-chime.wav" }).click();
  await expect(chime.getByRole("button", { name: "Pause trail-chime.wav" })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("bot")).toHaveCount(4, { timeout: 30_000 });
  await expect(card("trail-chime.wav")).toBeVisible({ timeout: 30_000 });
});

test("F-116 F-304: a link card and a page, and four items at once with Download all", async () => {
  await handOver("Trail conditions", "#hand-link");
  await openTask("Trail conditions");
  const link = page.getByTestId("link-card");
  await expect(
    link.getByRole("button", {
      name: "trails.example/conditions, trails.example. Opens in your browser.",
    }),
  ).toBeVisible({ timeout: 30_000 });
  await shoot("card-link");

  await handOver("Trail page", "#hand-page");
  await openTask("Trail page");
  const pageCard = page.getByTestId("page-card");
  await expect(pageCard).toBeVisible({ timeout: 30_000 });
  await shoot("card-page");
  await pageCard.getByRole("button", { name: "Trail guide, page. Open" }).click();
  await expect(
    page.frameLocator("[data-testid=viewer-page]").getByRole("heading", { name: "Trail guide" }),
  ).toBeVisible({ timeout: 30_000 });
  await shoot("viewer-page");
  await page.keyboard.press("Escape");

  await handOver("Everything Saturday", "#hand-several");
  await openTask("Everything Saturday");
  await expect(cell("trail-photo.png").locator("img")).toBeVisible({ timeout: 30_000 });
  await expect(cell("ridge-profile.png").locator("img")).toBeVisible();
  await shoot("cards-several");
  await cell("ridge-profile.png").click({ button: "right" });
  const names: string[] = [];
  page.on("download", (download) => names.push(download.suggestedFilename()));
  await page
    .getByRole("menu", { name: "ridge-profile.png" })
    .getByRole("menuitem", { name: "Download all 4" })
    .click();
  await expect(page.getByTestId("artifact-announcer")).toHaveText("Downloaded 4 items", {
    timeout: 30_000,
  });
  expect(names.sort()).toEqual([
    "ridge-profile.png",
    "trail-chime.wav",
    "trail-photo.png",
    "trail-report.md",
  ]);
  // Sent in chat lists the task's items newest first, from the same list.
  await page.getByRole("button", { name: "Show work panel" }).click();
  await page.getByRole("tab", { name: "Files" }).click();
  await expect(page.getByTestId("sent-in-chat").locator(".file-row")).toHaveCount(4, {
    timeout: 30_000,
  });
  await shoot("sent-in-chat");
  await closePane();
});

test("F-307: a file too large to attach says so; an item the gateway lost says so and offers Try again", async () => {
  await handOver("Elevation log", "#hand-large");
  await openTask("Elevation log");
  await expect(page.getByTestId("refused-card").getByRole("group")).toHaveAccessibleName(
    "elevation-log.csv, not attached. The gateway couldn't attach it.",
    { timeout: 30_000 },
  );
  await shoot("card-refused");

  await handOver("Old route", "#hand-gone");
  await openTask("Old route");
  const note = card("old-route.md");
  await expect(note).toBeVisible({ timeout: 30_000 });
  expect(forgetHandover(openInstance(INSTANCE).stateDir)).toBe(1);
  await note.getByRole("button", { name: /^old-route\.md/ }).click();
  const failed = page.getByTestId("artifact-failed");
  await expect(failed).toContainText(
    "Couldn't open old-route.md. The gateway no longer has this item.",
    { timeout: 30_000 },
  );
  await shoot("pane-gone");
  await failed.getByRole("button", { name: "Try again" }).click();
  await expect(failed).toContainText("Couldn't open old-route.md.", { timeout: 30_000 });
  await closePane();
});

test("F-116 F-117: the page fetched nothing from any address but its own host", () => {
  expect(away).toEqual([]);
});
