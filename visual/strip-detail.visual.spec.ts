// #592: when bots and tasks couldn't be loaded, the strip says so in plain words and keeps the
// gateway's own message behind its "Gateway's message" disclosure. Pictured closed and open, in
// both themes, at 1440 and on a phone, where the disclosure is its chevron alone so the state
// stays whole. The scene is the shape the app writes (apps/desktop/src/fixture/bridge-fixture.ts).
import { test } from "@playwright/test";
import { contextFor, expect, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.phone)!;

for (const size of [WIDE, PHONE]) {
  for (const theme of THEMES) {
    test.describe(`the strip's gateway message ${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));

      test("#592: closed, then open, matches its baselines", async ({ page }) => {
        await openFixture(page, `scene=discovery-error&${OTTO_DISK}`, theme);
        const strip = page.getByTestId("status-strip");
        await expect(strip.locator("strong")).toContainText("Couldn't load bots");
        const toggle = strip.getByRole("button", { name: "Gateway's message" });
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        // The state reads in full beside both buttons.
        expect(
          await strip.locator("strong").evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
        await settle(page);
        await expect(page).toHaveScreenshot(`strip-detail-closed-${theme}-${size.name}.png`);

        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        const panel = page.getByRole("region", { name: "Gateway's message" });
        await expect(panel).toContainText("agents.list unavailable during gateway startup");
        // Outside the strip's live region.
        expect(await panel.evaluate((el) => el.closest('[role="status"]'))).toBeNull();
        await settle(page);
        await expect(page).toHaveScreenshot(`strip-detail-open-${theme}-${size.name}.png`);
      });
    });
  }
}
