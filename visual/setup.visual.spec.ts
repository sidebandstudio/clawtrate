// F-491 F-492 F-515 F-516 F-602: every state of setting up on this computer
// (docs/design/setup.md §3 to §7, setup-effortless.md §3) matches its approved
// baseline, in light and dark, at 1440 px and the phone; the first screen, a
// found gateway, Connect's steps and the first screen of a person's Mac app
// with its gateway found and matched to its profile at 1100 and 800 px too.
import { test } from "@playwright/test";
import { contextFor, expect, openFixture, settle, SIZES, THEMES } from "./fixture.ts";

const STATES = [
  "first",
  "looking",
  "looking-slow",
  "found",
  "found-others",
  "untested",
  "too-old",
  "stopped",
  "stopped-by-hand",
  "program-missing",
  "cant-tell",
  "cant-tell-shape",
  "cant-tell-read-only",
  "not-token",
  "not-found",
  "windows",
  "connecting",
  "code-failed",
  "code-refused",
  "grant",
  "unreachable",
  "changed",
  "refused",
  "refused-home",
  "found-paired",
  "found-not-reported",
  "cant-run",
  "endpoint",
  "bots",
  // A person's Mac app, with local connect: the first screen with its gateway matched, a gateway
  // it couldn't match, a profile with TLS on, and a Connect whose socket didn't pass the check.
  "local-first",
  "local-waiting",
  "local-unverified",
  "local-tls",
  "local-failed",
  "local-not-found",
  "local-named-profile",
  "local-running-two-profiles",
  "local-stopped-two-profiles",
  "local-stopped",
  "local-stopped-without-service",
  "local-starting",
  "local-start-refused",
  "local-start-unanswered",
  "local-token-refused",
  "local-unanswered",
  "local-protocol-older",
  "local-protocol-newer",
  "local-unreadable",
  "local-unfinished",
];
const EVERY_WIDTH = new Set(["first", "found", "connecting", "local-first"]);

for (const size of SIZES) {
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      const shown =
        size.name === "1440" || size.phone
          ? STATES
          : STATES.filter((state) => EVERY_WIDTH.has(state));
      for (const state of shown) {
        const rows = state.startsWith("local-") ? "F-602" : "F-491 F-492 F-515 F-516";
        test(`${rows}: setup ${state}`, async ({ page }) => {
          await openFixture(page, `setup=${state}`, theme);
          await expect(page.getByTestId("setup")).toBeVisible();
          await settle(page);
          await expect(page).toHaveScreenshot(`this-computer-${state}-${theme}-${size.name}.png`);
        });
      }
    });
  }
}
