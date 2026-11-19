// Usage and warning budgets (docs/design/controls.md, sections 16 to 19)
// against approved baselines, in light and dark at 1440, 1100 and 800 px and
// at phone width: a bot's Usage row and page in each state, the budget form,
// Settings → Usage, and the budget's line and notes in the conversation. The
// fixture's figures are made up (apps/desktop/src/fixture/usage.ts).
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

type Scene = { name: string; query: string; ready: (page: Page) => Promise<void> };

const PANE = `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=write`;
const PAGE = `${PANE}&uview=usage`;

const usagePage = async (page: Page) => {
  await expect(page.getByTestId("usage-page")).toBeVisible();
  await expect(page.getByTestId("usage-total")).toBeVisible();
};

async function settingsUsage(page: Page) {
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Usage", exact: true }).click();
  await expect(settings.getByTestId("usage-all")).toBeVisible();
}

const SCENES: Scene[] = [
  {
    name: "usage-row",
    query: PANE,
    ready: (page) => expect(page.getByTestId("usage-row")).toContainText("This week: 1.64M tokens"),
  },
  { name: "usage-page", query: PAGE, ready: usagePage },
  { name: "usage-page-warned", query: `${PAGE}&budget=warn`, ready: usagePage },
  { name: "usage-page-reached", query: `${PAGE}&budget=reached`, ready: usagePage },
  { name: "usage-page-daily", query: `${PAGE}&budget=daily`, ready: usagePage },
  { name: "usage-page-none", query: `${PAGE}&budget=none`, ready: usagePage },
  {
    name: "usage-form-invalid",
    query: `${PAGE}&budget=invalid`,
    ready: async (page) => {
      await page.getByTestId("budget-tokens").fill("900");
      await expect(page.getByText("Enter a whole number of 1,000 or more.")).toBeVisible();
    },
  },
  {
    name: "usage-page-loading",
    query: `${PAGE}&usage=loading`,
    ready: (page) => expect(page.getByTestId("usage-loading")).toBeVisible(),
  },
  {
    name: "usage-page-error",
    query: `${PAGE}&usage=error`,
    ready: (page) => expect(page.getByTestId("usage-error")).toBeVisible(),
  },
  { name: "usage-page-computing", query: `${PAGE}&usage=computing`, ready: usagePage },
  { name: "usage-page-nocost", query: `${PAGE}&usage=nocost`, ready: usagePage },
  { name: "usage-page-partial", query: `${PAGE}&usage=partial`, ready: usagePage },
  {
    name: "usage-page-read-only",
    query: `scene=access-pinned&${OTTO_DISK}&panel=open&tab=settings&uview=usage&budget=warn`,
    ready: usagePage,
  },
  { name: "usage-settings", query: `scene=main&${OTTO_DISK}&access=write`, ready: settingsUsage },
  {
    name: "usage-settings-nolimits",
    query: `scene=main&${OTTO_DISK}&access=write&usage=nolimits`,
    ready: settingsUsage,
  },
  {
    name: "usage-line-warned",
    query: `scene=main&${OTTO_DISK}&access=write&budget=warn`,
    ready: (page) => expect(page.getByTestId("budget-line")).toBeVisible(),
  },
  {
    name: "usage-composer-reached",
    query: `scene=main&${OTTO_DISK}&access=write&budget=reached&plimit=near`,
    ready: async (page) => {
      await expect(page.getByTestId("budget-reached-note")).toBeVisible();
      await expect(page.getByTestId("limit-note")).toBeVisible();
    },
  },
];

for (const size of SIZES) {
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      for (const scene of SCENES) {
        test(`usage: ${scene.name}`, async ({ page }) => {
          await openFixture(page, scene.query, theme);
          await scene.ready(page);
          await settle(page);
          await expect(page).toHaveScreenshot(`${scene.name}-${theme}-${size.name}.png`);
        });
      }
    });
  }
}
