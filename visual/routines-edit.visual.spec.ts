// Changing routines (docs/design/automation.md sections 9 to 11) against
// approved baselines, in light and dark at 1440, 1100 and 800 px and at phone
// width: the list and a page with admin access, the editor empty, filled, with
// a validation error, refused, in doubt, changed elsewhere and with a
// schedule it doesn't write, Run now, the delete confirmation and the row's
// menu. The read-only list and page are in routines.visual.spec.ts. The
// fixture's routines are made up (apps/desktop/src/fixture/routines.ts).
import { test, type Page } from "@playwright/test";
import { contextFor, expect, openFixture, settle, SIZES, THEMES } from "./fixture.ts";

type Scene = { name: string; query?: string; ready: (page: Page, phone: boolean) => Promise<void> };

// "Show sessions from other tools" on, so a routine's latest run is a row under its bot (F-193).
const ADMIN = "scene=main&routines=on&access=admin&others=show";
const view = (page: Page) => page.getByTestId("routines-view");
const editor = (page: Page) => page.getByTestId("routine-editor");
const row = (page: Page, name: string) =>
  view(page).getByTestId("routine-row").filter({ hasText: name });

async function routines(page: Page, phone: boolean) {
  if (phone) await page.getByRole("button", { name: "Back to bots" }).click();
  await page.getByRole("button", { name: "Routines", exact: true }).click();
  await expect(row(page, "Morning digest")).toBeVisible();
}

async function newRoutine(page: Page, phone: boolean) {
  await routines(page, phone);
  await view(page).getByTestId("new-routine").click();
  await expect(editor(page).getByRole("heading", { name: "New routine" })).toBeVisible();
}

async function fill(page: Page) {
  await editor(page).getByLabel("Name").fill("Weekly reading list");
  await editor(page)
    .getByLabel("Instruction")
    .fill("Collect the articles I saved this week and list the three worth reading first.");
  await editor(page).getByRole("radio", { name: "Some days of the week" }).click();
  await editor(page).getByRole("button", { name: "Fri" }).click();
}

async function routinePage(page: Page, phone: boolean, name = "Morning digest") {
  await routines(page, phone);
  await row(page, name).locator(".r-row-main").click();
  await expect(view(page).getByRole("heading", { name })).toBeVisible();
  await expect(view(page).getByTestId("run-row").first()).toBeVisible();
}

async function editDigest(page: Page, phone: boolean) {
  await routinePage(page, phone);
  if (phone) {
    await view(page).getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Edit…" }).click();
  } else await view(page).getByRole("button", { name: "Edit", exact: true }).click();
  await expect(editor(page).getByRole("heading", { name: "Edit routine" })).toBeVisible();
}

const save = (page: Page) =>
  editor(page).getByRole("button", { name: "Save", exact: true }).click();

const SCENES: Scene[] = [
  { name: "admin-list", ready: routines },
  { name: "admin-page", ready: (page, phone) => routinePage(page, phone) },
  { name: "editor-new", ready: newRoutine },
  {
    name: "editor-filled",
    ready: async (page, phone) => {
      await newRoutine(page, phone);
      await fill(page);
      await expect(editor(page).getByTestId("preview")).toContainText("Fridays");
    },
  },
  {
    name: "editor-invalid",
    ready: async (page, phone) => {
      await newRoutine(page, phone);
      await fill(page);
      await editor(page).getByRole("radio", { name: "Every few hours or minutes" }).click();
      await editor(page).getByLabel("Every").fill("2");
      await save(page);
      await expect(editor(page)).toContainText("Routines run at least 5 minutes apart.");
    },
  },
  {
    name: "editor-refused",
    query: `${ADMIN}&save=refused`,
    ready: async (page, phone) => {
      await newRoutine(page, phone);
      await fill(page);
      await save(page);
      await expect(editor(page).getByTestId("editor-refused")).toBeVisible();
    },
  },
  {
    name: "editor-noanswer",
    query: `${ADMIN}&save=noanswer`,
    ready: async (page, phone) => {
      await newRoutine(page, phone);
      await fill(page);
      await save(page);
      await expect(editor(page).getByTestId("editor-unknown")).toBeVisible();
    },
  },
  {
    name: "editor-conflict",
    query: `${ADMIN}&save=conflict`,
    ready: async (page, phone) => {
      await editDigest(page, phone);
      await editor(page).getByLabel("Name").fill("Morning digest, short");
      await save(page);
      await expect(editor(page).getByTestId("editor-changed")).toBeVisible();
    },
  },
  {
    name: "editor-locked",
    ready: async (page, phone) => {
      await routinePage(page, phone, "Certificate renewal");
      if (phone) {
        await view(page).getByRole("button", { name: "More" }).click();
        await page.getByRole("menuitem", { name: "Edit…" }).click();
      } else await view(page).getByRole("button", { name: "Edit", exact: true }).click();
      await expect(editor(page).getByTestId("locked")).toBeVisible();
    },
  },
  {
    name: "run-now",
    ready: async (page, phone) => {
      await routinePage(page, phone);
      await view(page).getByRole("button", { name: "Run now" }).click();
      await expect(view(page).getByTestId("routine-state")).toContainText("Running since");
    },
  },
  {
    name: "delete",
    ready: async (page, phone) => {
      await routinePage(page, phone);
      await view(page).getByRole("button", { name: "More" }).click();
      await page.getByRole("menuitem", { name: "Delete…" }).click();
      await expect(page.getByTestId("routine-delete")).toBeVisible();
    },
  },
  {
    name: "paused",
    ready: async (page, phone) => {
      await routines(page, phone);
      await row(page, "Morning digest").getByRole("switch").click();
      await expect(row(page, "Morning digest")).toContainText("Paused ·");
    },
  },
];

for (const size of SIZES) {
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      for (const scene of SCENES) {
        test(`routines: ${scene.name}`, async ({ page }) => {
          await openFixture(page, scene.query ?? ADMIN, theme);
          await scene.ready(page, size.phone === true);
          await settle(page);
          await expect(page).toHaveScreenshot(`routines-${scene.name}-${theme}-${size.name}.png`);
        });
      }
    });
  }
  if (!size.phone)
    test.describe(`${size.name} light menu`, () => {
      test.use(contextFor(size, "light"));
      test("routines: row-menu", async ({ page }) => {
        await openFixture(page, ADMIN, "light");
        await routines(page, false);
        await row(page, "Morning digest").locator(".r-row-main").click({ button: "right" });
        await expect(page.getByRole("menu")).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(`routines-row-menu-light-${size.name}.png`);
      });
    });
}
