// Approving a request on OpenClaw 2026.10.6 (docs/design/setup.md §9): the
// waiting state with the host's words for where the request waits and its
// profile-qualified command, and what an approval came to, each in the
// design's fixed words. Dark first, light after, at 1440 and at phone width.
// There is no "Approve from here" on this version: no state draws one.
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, paintedFinal, SIZES, type Theme } from "./fixture.ts";

const SHOWN = SIZES.filter((size) => size.name === "1440" || size.phone);
const THEMES: Theme[] = ["dark", "light"];
const REQUEST = "7c41d09e-52b3-4e8a-9f10-3d6b2a7e9c41";

const UNCONFIRMED =
  "Clawtrate disconnected. It couldn't confirm what this request granted. Review this device's access on the gateway before reconnecting.";

const bar = (page: Page) => page.getByTestId("access-bar");

/** Each state: its scene, and what the bar must say and offer. */
const STATES: Array<{ scene: string; check: (page: Page) => Promise<void> }> = [
  {
    scene: "access-waiting-ssh",
    check: async (page) => {
      await expect(bar(page)).toContainText(
        "Waiting for approval on devbox. On you@devbox.example (SSH port 22), run this for the default profile:",
      );
      await expect(bar(page).locator(".command code")).toHaveText(
        `openclaw devices approve ${REQUEST}`,
      );
      await expect(bar(page).getByRole("button", { name: "Copy approve command" })).toBeVisible();
      await expect(bar(page)).toContainText("Request 7c41d09e");
      await expect(bar(page).getByRole("button", { name: "Check now" })).toBeVisible();
      await expect(bar(page).getByRole("button", { name: "Stop waiting" })).toBeVisible();
      await expect(bar(page).getByRole("button", { name: /Cancel request/ })).toHaveCount(0);
    },
  },
  {
    scene: "access-waiting-here",
    check: async (page) => {
      await expect(bar(page)).toContainText(
        "Waiting for approval on this computer. In Terminal on this computer, run this for Clawtrate's profile:",
      );
      await expect(bar(page).locator(".command code")).toHaveText(
        `openclaw --profile clawtrate devices approve ${REQUEST}`,
      );
    },
  },
  {
    scene: "access-confirming",
    check: (page) =>
      expect(bar(page)).toContainText("Approved. Checking what the gateway granted…"),
  },
  {
    scene: "access-unconfirmed",
    check: async (page) => {
      await expect(bar(page)).toContainText(UNCONFIRMED);
      await expect(bar(page).getByRole("button", { name: "Look again" })).toBeVisible();
      // The gateway answered; Clawtrate disconnected: never "Can't reach".
      await expect(page.getByTestId("status-strip")).toContainText("Disconnected");
      await expect(page.getByTestId("status-strip")).not.toContainText("Can't reach");
      await expect(bar(page).locator(".command code")).toHaveCount(0);
    },
  },
  {
    scene: "access-stale",
    check: async (page) => {
      await expect(bar(page)).toContainText(
        "Clawtrate couldn't find this request in the gateway's pending list.",
      );
      await expect(bar(page).getByRole("button", { name: "Check again" })).toBeVisible();
      await expect(bar(page).getByRole("button", { name: "Request again" })).toBeVisible();
    },
  },
  {
    scene: "access-other-request",
    check: async (page) => {
      await expect(bar(page)).toContainText(
        "The gateway's pending request for this device isn't the one Clawtrate asked for.",
      );
      await expect(bar(page).locator(".command code")).toHaveCount(0);
    },
  },
  {
    scene: "access-identity-changed",
    check: (page) =>
      expect(bar(page)).toContainText("This route now leads to a different gateway."),
  },
  {
    scene: "access-list-unread",
    check: (page) =>
      expect(bar(page)).toContainText(
        "Couldn't read the gateway's requests on devbox. OpenClaw exited with code 2.",
      ),
  },
];

for (const size of SHOWN) {
  for (const theme of THEMES) {
    test.describe(`approving a request ${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      for (const state of STATES) {
        test(`F-500: ${state.scene}`, async ({ page }) => {
          await openFixture(page, `scene=${state.scene}&${OTTO_DISK}&panel=closed`, theme);
          await state.check(page);
          await expect(page.getByRole("button", { name: /Approve from here/ })).toHaveCount(0);
          await paintedFinal(page);
          await expect(page).toHaveScreenshot(`approve-${state.scene}-${theme}-${size.name}.png`);
        });
      }

      test("F-500: the pairing screen over SSH", async ({ page }) => {
        await openFixture(page, "scene=pairing-ssh", theme);
        const note = page.locator(".approve-note");
        await expect(note).toHaveText(
          "Waiting for approval on devbox. On you@devbox.example (SSH port 22), run this for the default profile:",
        );
        await expect(page.locator(".command code")).toHaveText(
          "openclaw devices approve 5d2a90c4-1b7e-4f0a-9c3d-2e8f6a1b0c55",
        );
        await expect(page.getByText("Request 5d2a90c4", { exact: false })).toBeVisible();
        await expect(page.getByRole("button", { name: /Approve from here/ })).toHaveCount(0);
        await paintedFinal(page);
        await expect(page).toHaveScreenshot(`approve-pairing-ssh-${theme}-${size.name}.png`);
      });
    });
  }
}
