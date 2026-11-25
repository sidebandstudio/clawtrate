// The keyboard shortcuts sheet (F-467) against approved baselines, in light and
// dark at 1440 and at phone width. It is in the macOS set (playwright.visual.config.ts):
// macOS draws its ⌘ ⇧ ⌥ ⌃ in a system font that the Linux image cannot carry.
import { test } from "@playwright/test";
import { contextFor, expect, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

const SHOWN = SIZES.filter((size) => size.name === "1440" || size.phone);

for (const size of SHOWN) {
  for (const theme of THEMES) {
    test.describe(`live ${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));

      test("F-467: the shortcut list", async ({ page }) => {
        await openFixture(page, `scene=composer&${OTTO_DISK}&panel=closed`, theme);
        await page.keyboard.press("ControlOrMeta+/");
        await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(`live-shortcuts-${theme}-${size.name}.png`);
      });
    });
  }
}
