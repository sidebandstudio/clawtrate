// Updating OpenClaw from Clawtrate (F-589): Settings › Gateway's offer and
// the confirmation match their baselines at 1440 and phone width in both
// themes; the run's line and its outcomes at 1440 dark. The button, the
// confirmation and Update are reached by keyboard, Update sends one stamped
// command and Not now none, and the line takes the notice's place under the
// Model menu. The scenes are the engine's state for each step and outcome
// (apps/desktop/src/fixture/openclaw-update.ts), built from the gateway's run
// record; no real update was run.
import { test, type Page } from "@playwright/test";
import type { ClawtrateState } from "../packages/core/src/types.ts";
import { contextFor, expect, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.phone)!;
const ADMIN = `scene=main&${OTTO_DISK}&access=admin&openclaw=behind`;

type Fixture = {
  clawtrateFixture: {
    sent: Array<{ type: string }>;
    getState(): ClawtrateState;
  };
};
const sent = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as Fixture).clawtrateFixture.sent.filter(
      (command) =>
        command.type === "startOpenClawUpdate" ||
        command.type === "dismissOpenClawUpdate" ||
        command.type === "releaseOpenClawUpdateHold",
    ),
  );

/** Settings, on its Gateway pane. */
async function gatewayPane(page: Page, phone: boolean) {
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  if (phone) await dialog.getByRole("button", { name: /^Gateway/ }).click();
  return dialog;
}

for (const size of [WIDE, PHONE]) {
  for (const theme of THEMES) {
    test.describe(`update openclaw ${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));

      test("F-589: Settings › Gateway offers the update, and its confirmation, match their baselines", async ({
        page,
      }) => {
        await openFixture(page, ADMIN, theme);
        const dialog = await gatewayPane(page, size.phone === true);
        const button = dialog.getByRole("button", { name: "Update OpenClaw to 2026.11.6" });
        await expect(button).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(`update-openclaw-offer-${theme}-${size.name}.png`);
        await button.click();
        const confirm = page.getByRole("alertdialog", { name: "Update OpenClaw?" });
        await expect(confirm.getByRole("button", { name: "Not now" })).toBeFocused();
        await settle(page);
        await expect(page).toHaveScreenshot(`update-openclaw-confirm-${theme}-${size.name}.png`);
      });
    });
  }
}

test.describe("update openclaw outcomes 1440 dark", () => {
  test.use(contextFor(WIDE, "dark"));
  for (const scene of ["running", "updated", "failed", "away", "blocked", "elsewhere"]) {
    test(`F-589: ${scene} in Settings › Gateway matches its baseline`, async ({ page }) => {
      await openFixture(page, `${ADMIN}&openclawRun=${scene}`, "dark");
      const dialog = await gatewayPane(page, false);
      await expect(
        dialog.getByTestId(scene === "blocked" ? "update-blocked-settings" : "update-run-settings"),
      ).toBeVisible();
      await settle(page);
      await expect(page).toHaveScreenshot(`update-openclaw-${scene}-dark-1440.png`);
    });
  }
});

test.describe("update openclaw behaviour", () => {
  test.use(contextFor(WIDE, "dark"));

  test("F-589: the button, the confirmation and Update are reached by keyboard; Update sends one command stamped with the gateway shown, and its line follows", async ({
    page,
  }) => {
    await openFixture(page, ADMIN, "dark");
    const dialog = await gatewayPane(page, false);
    const button = dialog.getByRole("button", { name: "Update OpenClaw to 2026.11.6" });
    await button.focus();
    await page.keyboard.press("Enter");
    const confirm = page.getByRole("alertdialog", { name: "Update OpenClaw?" });
    await expect(confirm).toContainText("Your gateway goes from OpenClaw 2026.10.6 to 2026.11.6.");
    await expect(confirm).toContainText("Clawtrate reconnects by itself.");
    await expect(confirm.getByTestId("update-work")).toContainText("working now");
    expect(await sent(page)).toEqual([]);
    await expect(confirm.getByRole("button", { name: "Not now" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(confirm.getByRole("button", { name: "Update", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    const { gatewayId, target } = await page.evaluate(
      () => (window as unknown as Fixture).clawtrateFixture.getState().connection,
    );
    expect(await sent(page)).toEqual([
      { type: "startOpenClawUpdate", stamp: { gatewayId, target } },
    ]);
    await expect(confirm).toHaveCount(0);
    const line = dialog.getByTestId("update-run-settings");
    await expect(line).toContainText("Updating OpenClaw to 2026.11.6: step 1 of 8, requested.");
    await expect(line.getByRole("status")).toHaveText(
      "Updating OpenClaw to 2026.11.6: step 1 of 8, requested.",
    );
    // No second update is offered while it runs.
    await expect(dialog.getByRole("button", { name: /^Update OpenClaw/ })).toHaveCount(0);
    // Focus lands where the button was, on the update's place, never on the page itself.
    await expect(dialog.locator(".b-update-place")).toBeFocused();
  });

  test("F-589: Not now and Escape send nothing", async ({ page }) => {
    await openFixture(page, ADMIN, "dark");
    const dialog = await gatewayPane(page, false);
    const button = dialog.getByRole("button", { name: "Update OpenClaw to 2026.11.6" });
    await button.click();
    await page.getByRole("button", { name: "Not now" }).click();
    await expect(page.getByRole("alertdialog", { name: "Update OpenClaw?" })).toHaveCount(0);
    await button.click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("alertdialog", { name: "Update OpenClaw?" })).toHaveCount(0);
    expect(await sent(page)).toEqual([]);
  });

  test("F-589: without admin access the confirmation asks for it, and Update waits", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}&openclaw=behind`, "dark");
    const dialog = await gatewayPane(page, false);
    await dialog.getByRole("button", { name: "Update OpenClaw to 2026.11.6" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Update OpenClaw?" });
    await expect(confirm).toContainText("Updating OpenClaw needs admin access.");
    await expect(confirm.getByRole("button", { name: "Update", exact: true })).toBeDisabled();
    expect(await sent(page)).toEqual([]);
  });

  test("F-589: a held press offers Check again and Stop waiting, and Stop waiting is the only thing sent", async ({
    page,
  }) => {
    await openFixture(page, `${ADMIN}&openclawRun=held`, "dark");
    const dialog = await gatewayPane(page, false);
    const held = dialog.getByTestId("update-looking-settings");
    await expect(held).toContainText("couldn't ask it whether the update started");
    await expect(dialog.getByRole("button", { name: /^Update OpenClaw/ })).toHaveCount(0);
    await held.getByRole("button", { name: "Stop waiting" }).click();
    expect(await sent(page)).toEqual([{ type: "releaseOpenClawUpdateHold" }]);
    await expect(
      dialog.getByRole("button", { name: "Update OpenClaw to 2026.11.6" }),
    ).toBeVisible();
  });

  test("F-589: under the Model menu, a run's line takes the notice's place", async ({ page }) => {
    await openFixture(page, `${ADMIN}&openclawRun=running&panel=open&tab=settings`, "dark");
    const note = page.getByTestId("openclaw-update");
    await expect(note.getByTestId("update-run-notice")).toContainText(
      "Updating OpenClaw to 2026.11.6: step 2 of 8, staging.",
    );
    await expect(note).not.toContainText("is out");
    await openFixture(page, `${ADMIN}&openclawRun=updated&panel=open&tab=settings`, "dark");
    await expect(page.getByTestId("update-run-notice")).toContainText(
      "Updated to OpenClaw 2026.11.6.",
    );
    await page.getByTestId("update-run-notice").getByRole("button", { name: "Dismiss" }).click();
    expect(await sent(page)).toEqual([{ type: "dismissOpenClawUpdate" }]);
  });
});
