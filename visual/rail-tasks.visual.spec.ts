// The rail's task actions and arrangement, as baselines at every width in both
// themes: the task menu, rename in place, the Archived group, the delete and
// Stop and archive confirmations, pins and sections, unread, the waiting rows,
// the "+" menu and Re-pair in Settings.
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, settle, showList, SIZES, THEMES } from "./fixture.ts";

const OTTO = "bot=otto&task=agent:otto:disk-space";

/** A task row in the rail, by its title. */
const taskRow = (page: Page, title: string) =>
  page.getByTestId("task").filter({ hasText: title }).first();

/** In one pane an unfolded bot shows three tasks: show them all to reach the one named. */
async function reach(page: Page, title: string) {
  if (await taskRow(page, title).isVisible()) return;
  await page
    .getByRole("button", { name: /^Show all/ })
    .first()
    .click();
}

/** Open a task's menu from the keyboard, as on every width. */
async function taskMenu(page: Page, title: string) {
  await reach(page, title);
  await taskRow(page, title).focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menu")).toBeVisible();
}

type Scene = { name: string; rows: string; query: string; prepare: (page: Page) => Promise<void> };

export const RAIL_TASK_SCENES: Scene[] = [
  {
    name: "rail-task-menu",
    rows: "F-025 F-056 F-277 F-278",
    query: `scene=rail-synced&${OTTO}`,
    prepare: async (page) => {
      await showList(page);
      await taskMenu(page, "Certificate renewal");
    },
  },
  {
    name: "rail-rename",
    rows: "F-056",
    query: `scene=rail-synced&${OTTO}`,
    prepare: async (page) => {
      await showList(page);
      await reach(page, "Certificate renewal");
      await taskRow(page, "Certificate renewal").focus();
      await page.keyboard.press("F2");
      await expect(page.getByTestId("task-rename")).toBeVisible();
    },
  },
  {
    name: "rail-archived",
    rows: "F-277",
    query: `scene=rail-synced&${OTTO}`,
    prepare: async (page) => {
      await showList(page);
      await page.getByRole("button", { name: "Archived" }).first().click();
      await expect(page.getByTestId("archived-task")).toHaveCount(2);
    },
  },
  {
    name: "rail-delete-confirm",
    rows: "F-278",
    query: `scene=rail-synced&${OTTO}`,
    prepare: async (page) => {
      await showList(page);
      await taskMenu(page, "Certificate renewal");
      await page.getByRole("menuitem", { name: "Delete…" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
    },
  },
  {
    name: "rail-stop-archive",
    rows: "F-277",
    query: `scene=rail-synced&${OTTO}`,
    prepare: async (page) => {
      await showList(page);
      await taskMenu(page, "Rotate the logs");
      await page.getByRole("menuitem", { name: "Stop and archive…" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
    },
  },
  {
    name: "rail-pins-sections",
    rows: "F-014 F-016",
    query: `scene=rail-synced&${OTTO}`,
    prepare: showList,
  },
  {
    name: "rail-unread",
    rows: "F-022",
    query: `scene=rail-write&${OTTO}`,
    prepare: async (page) => {
      await showList(page);
      await taskMenu(page, "Certificate renewal");
      await page.getByRole("menuitem", { name: "Mark as unread" }).click();
      await expect(taskRow(page, "Certificate renewal").locator(".unread-dot")).toHaveCount(1);
    },
  },
  {
    name: "rail-waiting",
    rows: "F-021 F-057",
    query: `scene=rail-waiting&${OTTO}`,
    prepare: showList,
  },
  {
    name: "rail-plus-menu",
    rows: "F-012 F-054",
    query: `scene=rail-write&${OTTO}`,
    prepare: async (page) => {
      await showList(page);
      await page.getByRole("button", { name: "New", exact: true }).click();
      await expect(page.getByRole("menu", { name: "New" })).toBeVisible();
    },
  },
  {
    name: "settings-repair",
    rows: "F-456",
    query: `scene=main&${OTTO}`,
    prepare: async (page) => {
      await page.keyboard.press("ControlOrMeta+,");
      await page.getByRole("button", { name: "Re-pair" }).click();
      await expect(page.getByTestId("repair-pending")).toContainText("Request 7c41d09e");
    },
  },
];

for (const size of SIZES) {
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      for (const scene of RAIL_TASK_SCENES) {
        test(`${scene.rows}: ${scene.name}`, async ({ page }) => {
          await openFixture(page, scene.query, theme);
          await settle(page);
          await scene.prepare(page);
          await settle(page);
          await expect(page).toHaveScreenshot(`${scene.name}-${theme}-${size.name}.png`);
        });
      }
    });
  }
}
