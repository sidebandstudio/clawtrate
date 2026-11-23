// F-471: every state this branch added matches its approved baseline, in light
// and dark, at 1440 px and at phone width.
import { test } from "@playwright/test";
import { contextFor, expect, openFixture, settle, SIZES, STATE_SCENES, THEMES } from "./fixture.ts";

const SHOWN = SIZES.filter((size) => size.name === "1440" || size.phone);

for (const size of SHOWN) {
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      for (const scene of STATE_SCENES) {
        test(`F-471: ${scene.name}`, async ({ page }) => {
          await openFixture(page, scene.query, theme);
          await settle(page);
          await scene.prepare?.(page);
          await settle(page);
          await expect(page).toHaveScreenshot(`${scene.name}-${theme}-${size.name}.png`);
        });
      }
    });
  }
}
