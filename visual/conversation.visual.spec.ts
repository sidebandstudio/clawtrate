// The live conversation's states (docs/design/conversation.md) match their
// approved baselines in light and dark, at desktop width and at phone width:
// the access bar on the read tier, and a run in each of its states.
import { expect, test } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";
import { LIVE_VIEWS } from "./live-scenes.ts";

const SHOWN = SIZES.filter((size) => size.name === "1440" || size.phone);

for (const size of SHOWN) {
  for (const theme of THEMES) {
    test.describe(`live ${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      for (const view of LIVE_VIEWS.filter((each) => each.scene !== "main")) {
        test(`${view.rows ? `${view.rows}: ` : ""}${view.scene}`, async ({ page }) => {
          await openFixture(page, `scene=${view.scene}&${OTTO_DISK}&panel=closed`, theme);
          await view.ready(page);
          await settle(page);
          await expect(page).toHaveScreenshot(`live-${view.scene}-${theme}-${size.name}.png`);
        });
      }
    });
  }
}
