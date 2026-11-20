// Shared by the artifact checks: Juniper's task with every kind of card.
import { expect, type Page } from "@playwright/test";

export const ARTIFACTS = "scene=main&artifacts=on&bot=main&task=agent:main:library-loans";

/** A file or audio card by its name. */
export const card = (page: Page, name: string) =>
  page.getByTestId("artifact-card").filter({ hasText: name }).first();

/** A picture or video cell by its name. */
export const cell = (page: Page, name: string) =>
  page.locator(`.media-cell[aria-label^="${name}"]`).first();

/** The cards have loaded: the last message's refused file is drawn. */
export const cardsDrawn = (page: Page) => expect(page.getByTestId("refused-card")).toBeVisible();

/** Open an item in the pane from its card, and wait for its reader. */
export async function openCard(page: Page, name: string) {
  await cardsDrawn(page);
  const target = card(page, name);
  await target.scrollIntoViewIfNeeded();
  await target.getByRole("button", { name: new RegExp(`^${name.replace(/\./g, "\\.")}`) }).click();
  await expect(page.getByTestId("artifact-reader")).toBeVisible();
  await expect(page.getByTestId("artifact-reader").getByRole("heading", { name })).toBeVisible();
}

/** Every picture a cell draws has been decoded. */
export async function picturesDecoded(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const images = [
          ...document.querySelectorAll<HTMLImageElement>(
            ".media-cell img, .viewer img, .reader img",
          ),
        ];
        const done = await Promise.all(
          images.map((image) =>
            image
              .decode()
              .then(() => true)
              .catch(() => false),
          ),
        );
        return done.every(Boolean);
      }),
    )
    .toBe(true);
}

export type Sent = { type: string; [key: string]: unknown };
export const sent = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { clawtrateFixture: { sent: Sent[] } }).clawtrateFixture.sent,
  );
