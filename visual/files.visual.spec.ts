// The Work pane's Files tab (work-pane.md, Part 1) against approved baselines,
// in light and dark at 1440, 1100 and 800 px and at phone width: the two
// lists, an opened text file, markdown, a picture, a file over the limit with
// its reason, one no reader sends, the comparison, loading and failure, and
// the tab bar where its tabs scroll.
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, settle, SIZES, THEMES } from "./fixture.ts";
import { FILES, filesPanel, listed, openRow } from "./files-helpers.ts";

type Scene = { name: string; query: string; ready: (page: Page) => Promise<void> };

const SCENES: Scene[] = [
  { name: "files-list", query: `${FILES}&files=loaded`, ready: listed },
  {
    name: "files-markdown",
    query: `${FILES}&files=loaded`,
    ready: async (page) => {
      await listed(page);
      await openRow(page, "disk-2026-11-16.md");
      await expect(page.locator(".reader-preview")).toBeVisible();
    },
  },
  {
    name: "files-source",
    query: `${FILES}&files=loaded`,
    ready: async (page) => {
      await listed(page);
      await openRow(page, "media-box.md");
      await page.getByRole("tab", { name: "Source" }).click();
      await expect(page.locator(".code-view")).toBeVisible();
    },
  },
  {
    name: "files-picture",
    query: `${FILES}&files=loaded`,
    ready: async (page) => {
      await listed(page);
      await openRow(page, "usage.png");
      await expect(page.locator(".reader-image img")).toBeVisible();
      await page.locator(".reader-image img").evaluate((img: HTMLImageElement) => img.decode());
    },
  },
  {
    name: "files-too-large",
    query: `${FILES}&files=loaded`,
    ready: async (page) => {
      await listed(page);
      await openRow(page, "transcode.log");
      await expect(page.getByTestId("reader-cannot")).toBeVisible();
    },
  },
  {
    name: "files-cannot-show",
    query: `${FILES}&files=loaded`,
    ready: async (page) => {
      await listed(page);
      await openRow(page, "receipts.pdf");
      await expect(page.getByTestId("reader-cannot")).toBeVisible();
    },
  },
  {
    name: "files-changes",
    query: `${FILES}&files=loaded&checkout=1`,
    ready: async (page) => {
      await listed(page);
      await openRow(page, "disk-2026-11-16.md");
      await page.getByRole("tab", { name: "Changes" }).click();
      await expect(page.getByTestId("checkout-label")).toBeVisible();
      await expect(page.locator(".change .diff").first()).toBeVisible();
    },
  },
  {
    name: "files-loading",
    query: `${FILES}&files=loading`,
    ready: (page) => expect(filesPanel(page).locator(".skeleton-row").first()).toBeVisible(),
  },
  {
    name: "files-failed",
    query: `${FILES}&files=error`,
    ready: (page) => expect(page.getByTestId("files-failed")).toBeVisible(),
  },
  {
    name: "files-writing",
    query: `${FILES}&files=writing`,
    ready: async (page) => {
      await expect(filesPanel(page).getByText("Writing…").first()).toBeVisible();
    },
  },
  {
    name: "files-tabs-scroll",
    query: `${FILES}&files=loaded`,
    ready: async (page) => {
      await listed(page);
      // A larger text size than the bar was drawn for: its tabs no longer fit.
      await page.addStyleTag({ content: ".work-panel .tab { font-size: 22px; }" });
      await expect(page.getByTestId("work-tabs")).toHaveAttribute("data-fit", "scroll");
    },
  },
];

for (const size of SIZES) {
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      for (const scene of SCENES) {
        test(`F-152: ${scene.name}`, async ({ page }) => {
          await openFixture(page, scene.query, theme);
          await scene.ready(page);
          await settle(page);
          await expect(page).toHaveScreenshot(`${scene.name}-${theme}-${size.name}.png`);
        });
      }
    });
  }
}
