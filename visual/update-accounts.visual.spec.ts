import { expect, test } from "@playwright/test";
import { openFixture } from "./fixture.ts";
test("F-030: opening Updates reads no accounts until another section opens", async ({ page }) => {
  await openFixture(page, "scene=main&updates=offered", "light");
  const counts = () =>
    page.evaluate(() => {
      const fixture = (window as unknown as { clawtrateFixture: { sent: { type: string }[] } })
        .clawtrateFixture;
      return fixture.sent.filter((c) => c.type === "refreshAccounts").length;
    });
  const initial = await counts();
  await page.getByRole("button", { name: "Open Updates" }).click();
  await expect(page.getByRole("radio", { name: "Stable" })).toBeVisible();
  expect(await counts()).toBe(initial);
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await expect.poll(counts).toBe(initial + 1);
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+,");
  await expect.poll(counts).toBe(initial + 2);
  await page.getByRole("button", { name: "Updates", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+,");
  await expect(page.getByRole("heading", { name: "Updates", exact: true })).toBeFocused();
  expect(await counts()).toBe(initial + 2);
});
