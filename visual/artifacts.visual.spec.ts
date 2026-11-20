// What a bot hands over (work-pane.md, Part 2) against approved baselines, in
// light and dark at 1440, 1100 and 800 px and at phone width: the cards of
// every kind and their menu, an item open in the pane in each of its states,
// "Sent in chat", the media viewer with a picture, a video and a page, a
// thumbnail that failed and a link's preview.
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, settle, SIZES, THEMES } from "./fixture.ts";
import {
  ARTIFACTS,
  card,
  cardsDrawn,
  cell,
  openCard,
  picturesDecoded,
} from "./artifacts-helpers.ts";

type Scene = { name: string; rows: string; query: string; ready: (page: Page) => Promise<void> };

/**
 * Scroll the conversation to its top with the wheel, as a reader does, once the
 * pictures below have arrived (they change its height), and let it rest there.
 */
const toTop = async (page: Page) => {
  await expect(cell(page, "apps-compared.png").locator("img")).toBeVisible();
  await picturesDecoded(page);
  await settle(page);
  const transcript = page.locator(".transcript");
  await transcript.hover();
  await expect
    .poll(async () => {
      await page.mouse.wheel(0, -4000);
      await settle(page);
      return transcript.evaluate((element) => element.scrollTop);
    })
    .toBe(0);
  await settle(page);
  await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBe(0);
};

const openViewer = async (page: Page, name: string) => {
  await cardsDrawn(page);
  await cell(page, name).click();
  await expect(page.getByTestId("media-viewer")).toBeVisible();
};

const SCENES: Scene[] = [
  {
    name: "artifacts-cards",
    rows: "F-115 F-117",
    query: ARTIFACTS,
    ready: async (page) => {
      await cardsDrawn(page);
      await expect(cell(page, "apps-compared.png").locator("img")).toBeVisible();
      await expect(cell(page, "cache-growth.png").locator("img")).toBeVisible();
      await picturesDecoded(page);
    },
  },
  {
    name: "artifacts-cards-top",
    rows: "F-115 F-116",
    query: ARTIFACTS,
    ready: async (page) => {
      await cardsDrawn(page);
      await toTop(page);
      await expect(page.getByTestId("page-card").first()).toBeVisible();
      await expect(page.getByTestId("link-card")).toBeVisible();
    },
  },
  {
    name: "artifacts-menu",
    rows: "F-118 F-304",
    query: ARTIFACTS,
    ready: async (page) => {
      await cardsDrawn(page);
      const report = card(page, "borrowing-report.md");
      await report.scrollIntoViewIfNeeded();
      await report.hover();
      await report.getByRole("button", { name: /^More for/ }).click();
      await expect(page.getByRole("menu", { name: "borrowing-report.md" })).toBeVisible();
    },
  },
  {
    name: "artifacts-thumbs-failed",
    rows: "F-117",
    query: `${ARTIFACTS}&thumbs=failed`,
    ready: async (page) => {
      await cardsDrawn(page);
      await expect(cell(page, "cache-growth.png")).toContainText("No preview");
      await picturesDecoded(page);
    },
  },
  {
    name: "artifacts-link-preview",
    rows: "F-116",
    query: ARTIFACTS,
    ready: async (page) => {
      await cardsDrawn(page);
      await toTop(page);
      await expect(page.getByTestId("link-card")).toBeInViewport();
      // The pictures below arrive first, so nothing moves under the pointer while it rests.
      await picturesDecoded(page);
      await settle(page);
      // The preview is fetched only from its own control, never on hover.
      await page.getByTestId("link-preview-button").click();
      await expect(page.getByTestId("link-preview")).toContainText("Library e-books");
    },
  },
  {
    name: "artifacts-pane-markdown",
    rows: "F-115",
    query: ARTIFACTS,
    ready: async (page) => {
      await openCard(page, "borrowing-report.md");
      await expect(page.locator(".reader-preview")).toBeVisible();
    },
  },
  {
    name: "artifacts-pane-elsewhere",
    rows: "F-307",
    query: ARTIFACTS,
    ready: async (page) => {
      await openCard(page, "lending-faq.pdf");
      await expect(page.getByTestId("artifact-why")).toBeVisible();
    },
  },
  {
    name: "artifacts-pane-unsupported",
    rows: "F-307",
    query: ARTIFACTS,
    ready: async (page) => {
      await openCard(page, "library-card.pkpass");
      await expect(page.getByTestId("artifact-why")).toBeVisible();
    },
  },
  {
    name: "artifacts-pane-too-large",
    rows: "F-307",
    query: ARTIFACTS,
    ready: async (page) => {
      await openCard(page, "app-screens.zip");
      await expect(page.getByTestId("artifact-why")).toContainText("Clawtrate's limit");
    },
  },
  {
    name: "artifacts-pane-no-preview",
    rows: "F-307",
    query: ARTIFACTS,
    ready: async (page) => {
      await openCard(page, "lending-terms.pdf");
      await expect(page.getByTestId("artifact-why")).toContainText("not its pages");
    },
  },
  {
    name: "artifacts-pane-failed",
    rows: "F-307",
    query: `${ARTIFACTS}&artifactload=failed`,
    ready: async (page) => {
      await openCard(page, "borrowing-report.md");
      await expect(page.getByTestId("artifact-failed")).toBeVisible();
    },
  },
  {
    name: "artifacts-pane-audio",
    rows: "F-117",
    query: ARTIFACTS,
    ready: async (page) => {
      await openCard(page, "voice-note.wav");
      await expect(page.locator(".audio-player")).toBeVisible();
    },
  },
  {
    name: "artifacts-sent-in-chat",
    rows: "F-115",
    query: `${ARTIFACTS}&panel=open&tab=files`,
    ready: async (page) => {
      await expect(page.getByTestId("sent-in-chat")).toBeVisible();
      await page.getByTestId("sent-in-chat").scrollIntoViewIfNeeded();
      await picturesDecoded(page);
    },
  },
  {
    name: "artifacts-viewer-picture",
    rows: "F-117",
    query: ARTIFACTS,
    ready: async (page) => {
      await openViewer(page, "apps-compared.png");
      await expect(page.getByTestId("viewer-image")).toBeVisible();
      await picturesDecoded(page);
    },
  },
  {
    name: "artifacts-viewer-video",
    rows: "F-117",
    query: ARTIFACTS,
    ready: async (page) => {
      await openViewer(page, "usage.png");
      await page.keyboard.press("ArrowRight");
      await expect(page.getByTestId("viewer-video")).toBeVisible();
      await page
        .getByTestId("viewer-video")
        .evaluate((video: HTMLVideoElement) =>
          video.readyState >= 2
            ? undefined
            : new Promise((resolve) =>
                video.addEventListener("loadeddata", resolve, { once: true }),
              ),
        );
      await picturesDecoded(page);
    },
  },
  {
    // No platform draws a Page yet: the view says so, and nothing of it is read.
    name: "artifacts-page-unavailable",
    rows: "F-115",
    query: ARTIFACTS,
    ready: async (page) => {
      await cardsDrawn(page);
      await toTop(page);
      await page.getByTestId("page-card").first().getByRole("button").click();
      await expect(page.getByTestId("page-unavailable")).toBeVisible();
      await expect(page.locator("iframe")).toHaveCount(0);
    },
  },
];

for (const size of SIZES) {
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      for (const scene of SCENES) {
        test(`${scene.rows}: ${scene.name}`, async ({ page }) => {
          await openFixture(page, scene.query, theme);
          await scene.ready(page);
          await settle(page);
          await expect(page).toHaveScreenshot(`${scene.name}-${theme}-${size.name}.png`);
        });
      }
    });
  }
}
