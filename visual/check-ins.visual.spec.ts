// A bot's check-ins (docs/design/automation.md section 13) against approved
// baselines, in light and dark at 1440, 1100 and 800 px and at phone width:
// Settings → Check-ins with and without admin, with the scheduler off, and
// the dialog in each choice, with the default bot's note, a custom prompt's
// note, and a save refused, in conflict or not confirmed. The fixture's check-ins are made
// up (apps/desktop/src/fixture/check-ins.ts).
import { expect, test, type Page } from "@playwright/test";
import { checkIns } from "./check-ins-helpers.ts";
import { contextFor, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

type Scene = { name: string; query: string; ready: (page: Page) => Promise<void> };

const ADMIN = `scene=main&${OTTO_DISK}&access=admin`;

/** A bot's check-ins dialog, from its Change button. */
const dialog = (bot: string, then?: (page: Page) => Promise<void>) => async (page: Page) => {
  await checkIns(page);
  await page.getByRole("button", { name: `Change ${bot}'s check-ins` }).click();
  await expect(page.getByRole("dialog", { name: `${bot}'s check-ins` })).toBeVisible();
  await then?.(page);
};

const save = async (page: Page) => {
  await page.getByRole("button", { name: "Save", exact: true }).click();
};

const SCENES: Scene[] = [
  { name: "checkins-list", query: ADMIN, ready: checkIns },
  { name: "checkins-read", query: `scene=main&${OTTO_DISK}&access=read`, ready: checkIns },
  { name: "checkins-scheduler-off", query: `${ADMIN}&scheduler=off`, ready: checkIns },
  { name: "checkins-mixed", query: `${ADMIN}&checkins=every`, ready: checkIns },
  { name: "checkins-dialog-asneeded", query: ADMIN, ready: dialog("Juniper") },
  {
    name: "checkins-dialog-daily",
    query: ADMIN,
    ready: dialog("Marlow", async (page) => {
      await page.getByRole("radio", { name: /^Daily/ }).click();
      await expect(page.getByTestId("catch-note")).toBeVisible();
    }),
  },
  { name: "checkins-dialog-off", query: `${ADMIN}&checkins=off`, ready: dialog("Juniper") },
  {
    name: "checkins-dialog-every",
    query: `${ADMIN}&checkins=every`,
    ready: dialog("Otto", async (page) => {
      await expect(page.getByTestId("prompt-note")).toBeVisible();
    }),
  },
  {
    name: "checkins-dialog-failed",
    query: `${ADMIN}&cisave=fail`,
    ready: dialog("Marlow", async (page) => {
      await page.getByRole("radio", { name: /^Daily/ }).click();
      await save(page);
      await expect(page.getByTestId("save-failed")).toBeVisible();
    }),
  },
  {
    name: "checkins-dialog-conflict",
    query: `${ADMIN}&checkins=daily&cisave=conflict`,
    ready: dialog("Juniper", async (page) => {
      await page.getByRole("radio", { name: /^Off/ }).click();
      await save(page);
      await expect(page.getByTestId("save-conflict")).toBeVisible();
    }),
  },
  {
    name: "checkins-dialog-unknown",
    query: `${ADMIN}&cisave=unknown`,
    ready: dialog("Marlow", async (page) => {
      await page.getByRole("radio", { name: /^Daily/ }).click();
      await save(page);
      await expect(page.getByTestId("save-unknown")).toBeVisible();
    }),
  },
];

for (const size of SIZES) {
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      for (const scene of SCENES) {
        test(`check-ins: ${scene.name}`, async ({ page }) => {
          await openFixture(page, scene.query, theme);
          await scene.ready(page);
          await settle(page);
          await expect(page).toHaveScreenshot(`${scene.name}-${theme}-${size.name}.png`);
        });
      }
    });
  }
}
