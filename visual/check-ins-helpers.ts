import { expect, type Page } from "@playwright/test";

/** Settings, on Check-ins. */
export async function checkIns(page: Page) {
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Check-ins", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "Check-ins", level: 3 })).toBeVisible();
  await expect(page.getByTestId("check-in")).toHaveCount(5);
}
