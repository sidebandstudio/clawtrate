// F-471: the connect, pairing and main views (Work pane closed and open) match
// the approved baselines in light and dark, at 1440, 1100 and 800 px wide and
// at phone width.
import { test, type Page } from "@playwright/test";
import { contextFor, expect, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

type View = { name: string; query: string; ready: (page: Page) => Promise<void> };

const atEnd = async (page: Page) => {
  await expect(page.getByTestId("transcript-turn").first()).toBeVisible();
  await settle(page);
};

const VIEWS: View[] = [
  {
    name: "connect",
    query: "scene=connect",
    ready: (page) => expect(page.getByRole("button", { name: "Connect a gateway" })).toBeVisible(),
  },
  {
    name: "pairing",
    query: "scene=pairing",
    ready: (page) =>
      expect(page.getByRole("heading", { name: "Approve this device" })).toBeVisible(),
  },
  { name: "main", query: `scene=main&${OTTO_DISK}&panel=closed`, ready: atEnd },
  {
    name: "main-work-open",
    query: `scene=main&${OTTO_DISK}&panel=open`,
    ready: async (page) => {
      await atEnd(page);
      await expect(page.getByTestId("work-panel")).toBeVisible();
    },
  },
];

for (const size of SIZES) {
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));

      for (const view of VIEWS) {
        test(`F-471: ${view.name}`, async ({ page }) => {
          await openFixture(page, view.query, theme);
          await view.ready(page);
          await settle(page);
          await expect(page).toHaveScreenshot(`${view.name}-${theme}-${size.name}.png`);
        });
      }

      if (size.phone) {
        test("F-471: bot list", async ({ page }) => {
          await openFixture(page, `scene=main&${OTTO_DISK}&panel=closed`, theme);
          await page.getByRole("button", { name: "Back to bots" }).click();
          await expect(page.getByTestId("bot-list")).toBeVisible();
          await settle(page);
          await expect(page).toHaveScreenshot(`bot-list-${theme}-${size.name}.png`);
        });
      }
    });
  }
}
