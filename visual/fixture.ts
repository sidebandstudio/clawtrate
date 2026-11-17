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

/** On a phone the conversation covers the list; show the list. */
export async function showList(page: Page): Promise<void> {
  const back = page.getByRole("button", { name: "Back to bots" });
  if (await back.isVisible()) await back.click();
}

const railButton = (page: Page, name: string) =>
  page.getByTestId("bot-list").getByRole("button", { name: new RegExp(`^${name}\\b`) });

export type StateScene = { name: string; query: string; prepare?: (page: Page) => Promise<void> };

/** The states this branch added, for screenshots and the legibility audit. */
export const STATE_SCENES: StateScene[] = [
  { name: "rail-pinned", query: `scene=main&${OTTO_DISK}&pins=main,otto,pip`, prepare: showList },
  { name: "task-states", query: `scene=task-states&${OTTO_DISK}`, prepare: showList },
  {
    name: "hidden-bots",
    query: `scene=main&${OTTO_DISK}&hidden=marlow,quartermaster`,
    prepare: async (page) => {
      await showList(page);
      await page.getByRole("button", { name: /^Hidden bots/ }).click();
    },
  },
  {
    name: "sort-menu",
    query: `scene=main&${OTTO_DISK}&sort=manual`,
    prepare: async (page) => {
      await showList(page);
      await page.getByRole("button", { name: /^Sort bots/ }).click();
      await expect(page.getByRole("menu", { name: "Sort bots" })).toBeVisible();
    },
  },
  {
    name: "bot-menu",
    query: `scene=main&${OTTO_DISK}&sort=manual`,
    prepare: async (page) => {
      await showList(page);
      await railButton(page, "Juniper").focus();
      await page.keyboard.press("Shift+F10");
      await expect(page.getByRole("menu", { name: "Juniper" })).toBeVisible();
    },
  },
  { name: "narrated-week", query: "scene=main&bot=pip&task=agent:pip:week" },
  { name: "neutral-bubbles", query: `scene=main&${OTTO_DISK}&bubbles=neutral` },
  { name: "context-unavailable", query: "scene=main&bot=marlow" },
  {
    name: "find",
    query: `scene=main&${OTTO_DISK}`,
    prepare: async (page) => {
      await page.locator(".transcript").focus();
      await page.keyboard.press("ControlOrMeta+F");
      await page.getByRole("textbox", { name: "Find in conversation" }).fill("disk");
      await page.keyboard.press("Enter");
    },
  },
  {
    name: "bot-search",
    query: `scene=main&${OTTO_DISK}`,
    prepare: async (page) => {
      await showList(page);
      await page.getByRole("button", { name: "Search bots" }).click();
      await page.getByRole("textbox", { name: "Search bots" }).fill("p");
    },
  },
];
