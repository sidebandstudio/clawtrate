// Parity rows for the shell's frame: the welcome screen, the title pill, the
// rail's search and the keyboard shortcuts that move between bots.
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, SIZES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.phone)!;

const box = async (page: Page, selector: string) => (await page.locator(selector).boundingBox())!;

for (const size of [WIDE, PHONE]) {
  test.describe(`at ${size.name}`, () => {
    test.use(contextFor(size, "light"));

    test("F-001: first launch is a welcome screen with the mark, a tagline and one action, Connect a gateway", async ({
      page,
    }) => {
      // A fresh viewer: no gateway saved, nothing stored.
      await openFixture(page, "scene=connect", "light");
      const screen = page.getByRole("main");
      const mark = screen.locator(".connect-brand img");
      await expect(mark).toBeVisible();
      expect(await mark.getAttribute("src")).toMatch(/logo-mark/);
      expect((await mark.boundingBox())!.width).toBe(56);
      await expect(screen.getByRole("heading", { level: 1, name: "Clawtrate" })).toBeVisible();
      const tagline = screen.locator(".connect-brand p");
      await expect(tagline).toHaveText("Your OpenClaw agents, orchestrated.");
      const lineHeight = await tagline.evaluate((el) =>
        parseFloat(getComputedStyle(el).lineHeight),
      );
      expect((await tagline.boundingBox())!.height).toBeLessThan(lineHeight * 1.5);
      // One primary action, and it connects a gateway: no vendor account anywhere.
      const primary = screen.locator('.button[data-variant="primary"]');
      await expect(primary).toHaveCount(1);
      await expect(primary).toHaveAccessibleName("Connect a gateway");
      await expect(screen).not.toContainText(/sign in|log in|sign up|account/i);
    });
  });
}

test.describe("the title pill", () => {
  test.use(contextFor(WIDE, "light"));

  test("F-062: floats at the top centre with the bot's small avatar and name, and opens the details", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}&panel=closed`, "light");
    const pill = page.locator(".title-pill");
    await expect(pill).toBeVisible();
    // No bar: the header has no fill of its own, and the pill floats in it.
    expect(
      await page
        .locator(".conversation-header")
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe("rgba(0, 0, 0, 0)");
    const conversation = await box(page, ".conversation");
    const rect = await box(page, ".title-pill");
    expect(
      Math.abs(rect.x + rect.width / 2 - (conversation.x + conversation.width / 2)),
    ).toBeLessThanOrEqual(1);
    expect(rect.y - conversation.y).toBeLessThan(56 - rect.height);
    expect(await pill.evaluate((el) => getComputedStyle(el).borderRadius)).toBe("999px");
    const avatar = await box(page, ".title-pill .avatar");
    expect(avatar.width).toBe(22);
    await expect(pill.locator(".title-pill-name")).toHaveText("Otto");
    await expect(page.getByTestId("work-panel")).toHaveCount(0);
    await pill.click();
    const panel = page.getByTestId("work-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Otto" })).toBeVisible();
  });
});
