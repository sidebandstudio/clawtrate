import { expect, type Page } from "@playwright/test";

/** Every fixture page sees the same moment, so row times and stamps are stable. */
export const NOW = new Date("2026-11-16T17:40:00-05:00");

export const OTTO_DISK = "bot=otto&task=agent:otto:disk-space";

export type Size = {
  name: string;
  width: number;
  height: number;
  /** A phone: a coarse pointer, so the app uses its touch sizes. */
  phone?: boolean;
};

export const SIZES: Size[] = [
  { name: "1440", width: 1440, height: 900 },
  { name: "1100", width: 1100, height: 800 },
  { name: "800", width: 800, height: 700 },
  { name: "phone", width: 390, height: 844, phone: true },
];

export const THEMES = ["light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export function contextFor(size: Size, theme: Theme) {
  return {
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: 1,
    isMobile: size.phone === true,
    hasTouch: size.phone === true,
    colorScheme: theme,
  } as const;
}

/** Open the fixture on a scene, with the clock fixed and the fonts loaded. */
export async function openFixture(page: Page, query: string, theme: Theme): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await page.goto(`/?${query}&theme=${theme}`);
  await page.locator(".app").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(() => page.evaluate(() => document.fonts.check('15px "Figtree Variable"')))
    .toBe(true);
}

/** Let layout, ResizeObservers and the follow-to-end logic settle. */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
