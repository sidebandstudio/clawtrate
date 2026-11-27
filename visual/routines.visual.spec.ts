// The Routines view (docs/design/automation.md) against approved baselines, in
// light and dark at 1440, 1100 and 800 px and at phone width: the list, one
// bot's routines, a routine's page with its runs, a reminder's page and its
// run, a run with its conversation and one without, the calendar, and a bot
// working while its routine runs.
// The fixture's routines are made up (apps/desktop/src/fixture/routines.ts).
import { test, type Page } from "@playwright/test";
import { contextFor, expect, openFixture, settle, SIZES, THEMES } from "./fixture.ts";

type Scene = { name: string; query: string; ready: (page: Page, phone: boolean) => Promise<void> };

const view = (page: Page) => page.getByTestId("routines-view");

async function routines(page: Page, phone: boolean) {
  if (phone) await page.getByRole("button", { name: "Back to bots" }).click();
  await page.getByRole("button", { name: "Routines", exact: true }).click();
  await expect(view(page).getByTestId("routine-row").first()).toBeVisible();
}

const routinePage = (name: string) => async (page: Page, phone: boolean) => {
  await routines(page, phone);
  await view(page).getByTestId("routine-row").filter({ hasText: name }).click();
  await expect(view(page).getByTestId("run-row").first()).toBeVisible();
};

// "Show sessions from other tools" on, so a routine's latest run is a row under its bot (F-193).
const ON = "scene=main&routines=on&others=show";

const SCENES: Scene[] = [
  { name: "list", query: ON, ready: routines },
  {
    name: "one-bot",
    query: ON,
    ready: async (page, phone) => {
      await routines(page, phone);
      await view(page).getByRole("combobox", { name: "Bots" }).selectOption({ label: "Otto" });
    },
  },
  { name: "page", query: ON, ready: routinePage("Morning digest") },
  { name: "reminder", query: ON, ready: routinePage("Stretch break") },
  {
    name: "reminder-run",
    query: ON,
    ready: async (page, phone) => {
      await routinePage("Stretch break")(page, phone);
      await view(page).getByTestId("run-row").first().click();
      await expect(view(page).getByTestId("run-summary")).toBeVisible();
    },
  },
  {
    name: "run",
    query: ON,
    ready: async (page, phone) => {
      await routinePage("Morning digest")(page, phone);
      await view(page).getByTestId("run-row").first().click();
      await expect(view(page).getByTestId("scheduled-message")).toBeVisible();
    },
  },
  {
    name: "run-not-kept",
    query: ON,
    ready: async (page, phone) => {
      await routinePage("Nightly backup check")(page, phone);
      await view(page).getByTestId("run-row").nth(1).click();
      await expect(view(page).getByTestId("run-not-kept")).toBeVisible();
    },
  },
  {
    name: "calendar",
    query: ON,
    ready: async (page, phone) => {
      await routines(page, phone);
      await view(page)
        .getByRole("radio", { name: phone ? "Day" : "Week" })
        .click();
      await expect(page.getByTestId("calendar")).toBeVisible();
    },
  },
  {
    name: "running",
    query: "scene=main&routines=running&others=show",
    ready: async (page, phone) => {
      if (phone) await page.getByRole("button", { name: "Back to bots" }).click();
      await expect(
        page.getByTestId("bot-list").getByRole("button", { name: /^Marlow\b/ }),
      ).toHaveAttribute("data-state", "working");
    },
  },
];

for (const size of SIZES) {
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      for (const scene of SCENES) {
        test(`routines: ${scene.name}`, async ({ page }) => {
          await openFixture(page, scene.query, theme);
          await scene.ready(page, size.phone === true);
          await settle(page);
          await expect(page).toHaveScreenshot(`routines-${scene.name}-${theme}-${size.name}.png`);
        });
      }
    });
  }
}
