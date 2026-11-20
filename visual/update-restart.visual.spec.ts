import { expect, test } from "@playwright/test";
import { contextFor, openFixture, settle, showList, SIZES, OTTO_DISK } from "./fixture.ts";

for (const size of SIZES.filter((s) => s.name === "1440" || s.phone)) {
  test.describe(size.name, () => {
    test.use(contextFor(size, "light"));
    for (const state of [
      "ready",
      "confirmation",
      "preparing",
      "handing-off",
      "handed-to-system",
      "quit-blocked",
      "handoff-unconfirmed",
      "installer-failed",
      "target-running",
      "old-version-running",
      "unconfirmed",
    ]) {
      test(`F-231 F-030: Restart ${state} fits ${size.name}`, async ({ page }) => {
        const after = ["target-running", "old-version-running", "unconfirmed"].includes(state);
        await openFixture(
          page,
          `scene=main&updates=${after ? "not-checked&after=" + state : state === "confirmation" ? "ready" : state}`,
          "light",
        );
        await showList(page);
        if (after) {
          await page.keyboard.press("ControlOrMeta+,");
          await page.getByRole("button", { name: "Updates", exact: true }).click();
        } else {
          await page.getByRole("button", { name: "Open Updates" }).click();
        }
        if (state === "confirmation")
          await page.getByRole("button", { name: "Restart to Update", exact: true }).click();
        const panel = page.getByRole(state === "confirmation" ? "alertdialog" : "dialog");
        await expect(panel).toBeVisible();
        await settle(page);
        expect(
          await panel.evaluate(
            (el) =>
              el.scrollWidth <= el.clientWidth &&
              [...el.querySelectorAll("p,dd")].every(
                (row) => row.scrollWidth <= row.clientWidth + 1,
              ),
          ),
        ).toBe(true);
        await expect(panel).toHaveScreenshot(`restart-${state}-${size.name}.png`);
      });
    }
  });
}

for (const [scene, warning] of [
  [
    "stopped-not-sent",
    "1 message to Otto hasn't been sent yet. Restarting discards it: it isn't kept as a draft. Runs on the gateway keep going.",
  ],
  [
    "send-unknown",
    "1 message to Otto was sent to the gateway and isn't confirmed yet. Restarting stops following it. The gateway may still have it.",
  ],
] as const) {
  test(`F-231: confirmation describes the outbox in ${scene}`, async ({ page }) => {
    await openFixture(page, `scene=${scene}&${OTTO_DISK}&updates=ready`, "light");
    await page.getByRole("button", { name: "Open Updates" }).click();
    await page.getByRole("button", { name: "Restart to Update" }).click();
    await expect(page.getByRole("alertdialog")).toContainText(warning);
  });
}
