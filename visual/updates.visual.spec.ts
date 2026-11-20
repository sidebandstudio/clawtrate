import { expect, test } from "@playwright/test";
import { contextFor, openFixture, settle, showList, SIZES, THEMES } from "./fixture.ts";

const states = [
  "not-checked",
  "checking",
  "nothing-newer",
  "offered",
  "downloading",
  "verified",
  "failcheck",
  "nofile",
  "faildl",
  "preferences",
  "dev",
  "no-source",
  "no-updater",
  "refused",
  "other-current",
  "nightly-build",
];
const actionable = new Set(["offered", "downloading", "verified", "failcheck", "nofile", "faildl"]);

for (const size of SIZES.filter((s) => s.name === "1440" || s.phone))
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      for (const state of states)
        for (const tracks of ["one", "two"]) {
          if (state === "nightly-build" && tracks === "two") continue;
          if (tracks === "one" && ["refused", "other-current"].includes(state)) continue;
          if (tracks === "two" && ["dev", "no-source", "no-updater"].includes(state)) continue;
          test(`F-231 F-030 Updates ${state} ${tracks} tracks`, async ({ page }) => {
            const query =
              state === "nightly-build"
                ? "not-checked&buildTrack=nightly"
                : state === "refused"
                  ? "not-checked&save=failed"
                  : state === "other-current"
                    ? "nothing-newer&track=nightly"
                    : state;
            await openFixture(page, `scene=main&updates=${query}&tracks=${tracks}`, theme);
            await showList(page);
            const footer = page.getByRole("button", { name: "Open Updates" });
            if (actionable.has(state)) {
              await expect(footer).toBeVisible();
              if (state === "offered" && tracks === "two")
                await expect(page.locator(".rail-footer")).toHaveScreenshot(
                  `updates/footer-${size.name}-${theme}.png`,
                );
              await footer.click();
            } else {
              await expect(footer).toHaveCount(0);
              await page.keyboard.press("ControlOrMeta+,");
              await page.getByRole("button", { name: "Updates", exact: true }).click();
            }
            await expect(page.locator(".updates-section")).toBeVisible();
            if (state === "refused") {
              const stable = page.getByRole("radio", { name: "Stable" });
              await stable.focus();
              await page.keyboard.press("ArrowRight");
              await expect(stable).toBeChecked();
              await expect(page.locator("dd").last()).toHaveText(
                "Couldn't save the track. Stable is still selected.",
              );
            }
            await settle(page);
            expect(
              await page
                .locator(".updates-section dd")
                .evaluateAll((rows) => rows.every((row) => row.scrollWidth <= row.clientWidth)),
            ).toBe(true);
            await expect(page.getByRole("dialog")).toHaveScreenshot(
              `updates/${state}-${tracks}-${size.name}-${theme}.png`,
            );
          });
        }
    });
  }

test("F-030 opens Updates from the footer and keeps keyboard focus on the chosen track", async ({
  page,
}) => {
  await openFixture(page, "scene=main&updates=offered", "light");
  await page.getByRole("button", { name: "Open Updates" }).click();
  const group = page.getByRole("radiogroup", { name: "Update track" });
  await group.getByRole("radio", { name: "Stable" }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Download", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(group.getByRole("radio", { name: "Stable" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  const nightly = group.getByRole("radio", { name: "Nightly" });
  await expect(nightly).toBeChecked();
  await expect(nightly).toBeFocused();
  await expect(page.locator(".updates-section dd").last()).toHaveText("Not checked yet.");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Open Updates" })).toHaveCount(0);
});
