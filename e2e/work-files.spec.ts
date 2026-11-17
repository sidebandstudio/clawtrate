// The Work pane's Files tab against this run's own development gateway
// (work-pane.md, Part 1). Runs start on the gateway, as another client would
// start them; the page follows them as it follows any task. The file runs
// after preview.spec.ts, which pairs the preview host; on its own it pairs it.
//
// With CLAWTRATE_FILES_SHOTS=<folder outside the repository>, it also saves
// screenshots of what it checked there, at 1440 and 390 px in both themes.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openInstance } from "../tools/dev-gateway/src/cli.ts";
import { parseJsonOutput } from "../tools/dev-gateway/src/env.ts";
import { CHECKOUT_PATH, FILES_BOT } from "../tools/dev-gateway/src/seed-files.ts";
import { devGateway, listInstances } from "./global-setup.ts";

const INSTANCE = process.env.CLAWTRATE_DEV_INSTANCE!;
const SHOTS = process.env.CLAWTRATE_FILES_SHOTS ?? null;

async function openclaw(args: string[]): Promise<string> {
  const result = await openInstance(INSTANCE).runner.run(args);
  if (result.status !== 0) {
    throw new Error(`openclaw ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  }
  return result.stdout;
}

async function gatewayCall<T>(method: string, params: unknown): Promise<T> {
  return parseJsonOutput<T>(
    await openclaw(["gateway", "call", method, "--params", JSON.stringify(params), "--json"]),
  );
}

/** A task of the bot's, with a label, optionally started in a folder of its own. */
async function createTask(botId: string, slug: string, label: string, cwd?: string) {
  const key = `agent:${botId}:${slug}`;
  await gatewayCall("sessions.create", { key, agentId: botId, label, ...(cwd ? { cwd } : {}) });
  return key;
}

/** A run in the task, as the gateway's owner starts one; resolves when it has ended. */
async function runInTask(botId: string, key: string, message: string) {
  await openclaw(["agent", "--agent", botId, "--session-key", key, "--message", message, "--json"]);
}

async function openShell(page: Page) {
  await page.goto(process.env.CLAWTRATE_E2E_URL!);
  const connect = page.getByRole("button", { name: "Use the development gateway" });
  const bots = page.getByTestId("bot");
  // On a phone the list may be behind the open conversation: present, not shown.
  await expect
    .poll(async () => (await connect.isVisible()) || (await bots.count()) === 4, {
      timeout: 20_000,
    })
    .toBe(true);
  if (await connect.isVisible()) {
    await connect.click();
    await expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible();
    devGateway(INSTANCE, "approve");
  }
  await expect(bots).toHaveCount(4, { timeout: 20_000 });
}

const botRow = (page: Page, bot: string) =>
  page.getByTestId("bot-list").getByRole("button", { name: new RegExp(`^${bot}\\b`) });

async function openTask(page: Page, bot: string, task: string) {
  const back = page.getByRole("button", { name: "Back to bots" });
  if (await back.isVisible()) await back.click();
  const row = botRow(page, bot);
  if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
  const rows = page.getByRole("list", { name: `${bot}'s tasks` }).getByTestId("task");
  const all = page.getByRole("button", { name: /^Show all/ });
  if (await all.isVisible()) await all.click();
  if ((await rows.count()) > 0) await rows.filter({ hasText: task }).click();
  // The title pill names the bot and the task, whatever the transcript shows.
  await expect(page.getByRole("button", { name: new RegExp(`^${bot}, ${task}\\.`) })).toBeVisible();
}

const files = (page: Page) => page.locator("#work-tabpanel-files");
const fileRow = (page: Page, name: string) =>
  files(page).locator(".file-row", { hasText: name }).first();

async function showFiles(page: Page) {
  if ((await page.locator(".shell").getAttribute("data-panel")) !== "open")
    await page.getByRole("button", { name: "Show work panel" }).click();
  await page.getByRole("tab", { name: "Files" }).click();
}

/** Screenshots for the review, only when asked for, never into the repository. */
async function shoot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(SHOTS, `${name}-${theme}.png`) });
  }
  await page.emulateMedia({ colorScheme: null });
}

test.describe.configure({ mode: "serial" });

const WRITE_TASK = "Files from the end-to-end run";

test("F-448 F-152: a run that writes a file makes it appear in Files without a reload, and opening it shows its content", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const key = await createTask("otto", "e2e-files", WRITE_TASK);
  await openShell(page);
  await openTask(page, "Otto", WRITE_TASK);
  await showFiles(page);
  await expect(files(page).getByText("No files yet")).toBeVisible({ timeout: 20_000 });
  const loads = await page.evaluate(() => performance.getEntriesByType("navigation").length);

  await runInTask("otto", key, "#write");
  // No reload: the row arrives in the same page.
  await expect(fileRow(page, "scratch.md")).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(loads);
  await expect(files(page).getByRole("list", { name: "Changed" })).toContainText("scratch.md");
  await expect(fileRow(page, "scratch.md")).toHaveAccessibleName(/^scratch\.md, in notes, 34 B,/);
  await shoot(page, "files-run-1440");

  await fileRow(page, "scratch.md").click();
  await page.getByRole("tab", { name: "Source" }).click();
  await expect(page.locator(".code-view")).toContainText("- Check the trail map.");
  await expect(page.locator(".reader-source")).toContainText("Written by Otto");
  await shoot(page, "files-open-1440");
});

test("F-319: Download gives exactly the bytes of the file on the gateway, under its name", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openShell(page);
  await openTask(page, "Otto", WRITE_TASK);
  await showFiles(page);
  await fileRow(page, "scratch.md").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download scratch.md" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("scratch.md");
  const onGateway = await gatewayCall<{ file: { content: string } }>("agents.workspace.get", {
    agentId: "otto",
    path: "notes/scratch.md",
  });
  expect(readFileSync((await download.path())!, "utf8")).toBe(onGateway.file.content);
  expect(onGateway.file.content).toBe("# Scratch\n\n- Check the trail map.\n");
});

test("F-449: a file over the readers' limit says so with the gateway's own limit", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const task = "A long log from the end-to-end run";
  const key = await createTask("otto", "e2e-large", task);
  await runInTask("otto", key, "#write-large");
  await openShell(page);
  await openTask(page, "Otto", task);
  await showFiles(page);
  await fileRow(page, "transcode.log").click();
  const cannot = page.getByTestId("reader-cannot");
  await expect(cannot).toContainText(
    "transcode.log is 293 KB. The gateway's file readers send text up to 256 KB, so it can't be shown or downloaded here.",
  );
  await expect(cannot.locator("dd").nth(1)).toHaveText("293 KB");
  await expect(page.getByRole("button", { name: /^Download/ })).toHaveCount(0);
  await shoot(page, "files-too-large-1440");
});

test("F-446: the bot's workspace is listed one folder at a time", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openShell(page);
  await openTask(page, "Otto", WRITE_TASK);
  await showFiles(page);
  await files(page).locator(".file-row", { hasText: "Otto's workspace" }).click();
  await expect(page.getByRole("heading", { name: "Otto's workspace" })).toBeFocused();
  const root = await gatewayCall<{ entries: { name: string; kind: string }[] }>(
    "agents.workspace.list",
    { agentId: "otto" },
  );
  const names = files(page).locator(".file-list .file-name");
  const folders = root.entries
    .filter((e) => e.kind === "directory")
    .map((e) => e.name)
    .sort();
  const plain = root.entries
    .filter((e) => e.kind === "file")
    .map((e) => e.name)
    .sort();
  await expect(names).toHaveText([...folders, ...plain]);
  // Only the root's entries: nothing from inside a folder.
  await expect(names.filter({ hasText: "scratch.md" })).toHaveCount(0);
  await files(page).locator(".file-row", { hasText: "notes" }).first().click();
  await expect(page.getByRole("heading", { name: "notes" })).toBeFocused();
  await expect(names).toContainText(["scratch.md"]);
});

test("F-152: a task started in a git checkout compares its file with the last commit, labelled by that base", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = listInstances().find((row) => row.name === INSTANCE)!.stateDir;
  const cwd = join(state, "workspaces", FILES_BOT, CHECKOUT_PATH);
  const task = "A change in the trail guide";
  const key = await createTask(FILES_BOT, "e2e-checkout", task, cwd);
  await runInTask(FILES_BOT, key, "#edit");
  await openShell(page);
  await openTask(page, "Pip", task);
  await showFiles(page);
  await fileRow(page, "edit-me.md").click();
  await page.getByRole("tab", { name: "Changes" }).click();
  await expect(page.getByTestId("checkout-label")).toHaveText(
    "Compared with the last commit · +1 −0",
  );
  await expect(page.getByTestId("changes")).toContainText("2 changes in this task");
  // Each change of the task shows its lines, from the numbered diff the gateway's history keeps.
  const edited = page.locator(".change[data-step]").first();
  await expect(edited).toContainText("Edited edit-me.md");
  await expect(edited.locator('.diff-line[data-kind="del"]')).toContainText("Leave at 9:00.");
  await expect(edited.locator('.diff-line[data-kind="add"]')).toContainText("Leave at 8:30.");
  await expect(page.locator('.diff-line[data-kind="add"]').last()).toContainText("Leave at 8:30.");
  await shoot(page, "files-changes-1440");
});

test("on a phone the Files tab is the pane's sheet", async ({ page }) => {
  test.skip(!SHOTS, "screenshots only");
  await page.setViewportSize({ width: 390, height: 844 });
  await openShell(page);
  await openTask(page, "Otto", WRITE_TASK);
  await page.getByRole("button", { name: "Show work panel" }).click();
  await page.getByRole("tab", { name: "Files" }).click();
  await expect(fileRow(page, "scratch.md")).toBeVisible();
  await shoot(page, "files-run-390");
  await fileRow(page, "scratch.md").click();
  await expect(page.locator(".reader-body")).toBeVisible();
  await shoot(page, "files-open-390");
  await page.getByRole("button", { name: "Back to this task's files" }).click();
  await page.getByRole("button", { name: "Close work panel" }).last().click();
  await openTask(page, "Otto", "A long log from the end-to-end run");
  await page.getByRole("button", { name: "Show work panel" }).click();
  await fileRow(page, "transcode.log").click();
  await expect(page.getByTestId("reader-cannot")).toBeVisible();
  await shoot(page, "files-too-large-390");
  await page.getByRole("button", { name: "Close work panel" }).last().click();
  await openTask(page, "Pip", "A change in the trail guide");
  await page.getByRole("button", { name: "Show work panel" }).click();
  await fileRow(page, "edit-me.md").click();
  await page.getByRole("tab", { name: "Changes" }).click();
  await expect(page.getByTestId("checkout-label")).toBeVisible();
  await shoot(page, "files-changes-390");
});
