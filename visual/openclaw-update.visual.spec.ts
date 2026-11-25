// Updating OpenClaw from Clawtrate (F-589, F-591): Settings › Updates' OpenClaw
// section offers the update, and its confirmation, at 1440 and phone width in
// both themes; the run's line, its bar and its outcomes at 1440 dark. While a
// run is under way and the gateway is away, the connection strip and the
// footer say OpenClaw is updating, and past the usual time that it is taking
// longer; the card's bar waits at the restart step. A bot's settings keep one
// line with a link to Settings › Updates. The button, the confirmation and
// Update are reached by keyboard, Update sends one stamped command and Not now
// none. The scenes are the engine's state for each step and outcome
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

/** Settings, on its Updates pane. */
async function updatesPane(page: Page) {
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: /^Updates/ }).click();
  return dialog;
}

/** The gateway restarts during the run: the connection is down and coming back. */
const dropConnection = (page: Page, patch: Record<string, unknown> = {}) =>
  page.evaluate((runPatch) => {
    const fixture = (
      window as unknown as {
        clawtrateFixture: { setState(f: (s: ClawtrateState) => ClawtrateState): void };
      }
    ).clawtrateFixture;
    fixture.setState((state) => ({
      ...state,
      connection: { ...state.connection, status: "reconnecting", retryAt: null },
      openclawUpdating: {
        ...state.openclawUpdating!,
        run: { ...state.openclawUpdating!.run!, phase: "restarting", ...runPatch },
      },
    }));
  }, patch);

for (const size of [WIDE, PHONE]) {
  for (const theme of THEMES) {
    test.describe(`update openclaw ${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));

      test("F-589: Settings › Updates offers the update, and its confirmation, match their baselines", async ({
        page,
      }) => {
        await openFixture(page, ADMIN, theme);
        const dialog = await updatesPane(page);
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
  for (const scene of ["running", "updated", "failed", "late", "away", "blocked", "elsewhere"]) {
    test(`F-589: ${scene} in Settings › Updates matches its baseline`, async ({ page }) => {
      await openFixture(page, `${ADMIN}&openclawRun=${scene}`, "dark");
      const dialog = await updatesPane(page);
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
    const dialog = await updatesPane(page);
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
    await expect(line).toContainText("Updating OpenClaw to 2026.11.6.");
    await expect(line.getByRole("progressbar", { name: "OpenClaw update" })).toHaveAttribute(
      "aria-valuetext",
      "Step 1 of 8, requested",
    );
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
    const dialog = await updatesPane(page);
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
    const dialog = await updatesPane(page);
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
    const dialog = await updatesPane(page);
    const held = dialog.getByTestId("update-looking-settings");
    await expect(held).toContainText("couldn't ask it whether the update started");
    await expect(dialog.getByRole("button", { name: /^Update OpenClaw/ })).toHaveCount(0);
    await held.getByRole("button", { name: "Stop waiting" }).click();
    expect(await sent(page)).toEqual([{ type: "releaseOpenClawUpdateHold" }]);
    await expect(
      dialog.getByRole("button", { name: "Update OpenClaw to 2026.11.6" }),
    ).toBeVisible();
  });

  test("F-589 F-591: near the Model menu, one line says OpenClaw is updating, and its link opens Settings › Updates at the OpenClaw section", async ({
    page,
  }) => {
    await openFixture(page, `${ADMIN}&openclawRun=running&panel=open&tab=settings`, "dark");
    const note = page.getByTestId("openclaw-update");
    await expect(note.getByTestId("update-link-notice")).toHaveText(
      "OpenClaw is updating to 2026.11.6. Settings › Updates",
    );
    await expect(note.getByRole("button", { name: /^Update OpenClaw/ })).toHaveCount(0);
    await note.getByRole("button", { name: "Settings › Updates" }).click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(
      dialog.getByRole("heading", { name: "OpenClaw on 127.0.0.1:18789" }),
    ).toBeFocused();
    await expect(dialog.getByTestId("update-run-settings")).toContainText(
      "Updating OpenClaw to 2026.11.6.",
    );
    expect(await sent(page)).toEqual([]);
  });

  test("F-589 F-591: Settings › Gateway keeps the line and a link to Settings › Updates, and offers no Update itself", async ({
    page,
  }) => {
    await openFixture(page, ADMIN, "dark");
    await page.keyboard.press("ControlOrMeta+,");
    const dialog = page.getByRole("dialog", { name: "Settings" });
    const line = dialog.getByTestId("update-link-gateway");
    await expect(line).toContainText("Your gateway runs OpenClaw 2026.10.6, and 2026.11.6 is out.");
    await expect(dialog.getByRole("button", { name: /^Update OpenClaw/ })).toHaveCount(0);
    await line.getByRole("button", { name: "Settings › Updates" }).click();
    await expect(
      dialog.getByRole("heading", { name: "OpenClaw on 127.0.0.1:18789" }),
    ).toBeFocused();
    await expect(
      dialog.getByRole("button", { name: "Update OpenClaw to 2026.11.6" }),
    ).toBeVisible();
  });

  test("F-591: while the gateway restarts, the strip, the footer and the announcement say OpenClaw is updating; past the usual time, that it is taking longer, with Retry; settled, as ever", async ({
    page,
  }) => {
    await openFixture(page, `${ADMIN}&openclawRun=running`, "dark");
    await dropConnection(page);
    const strip = page.getByTestId("status-strip");
    await expect(strip.locator(".strip-long")).toHaveText("Updating OpenClaw to 2026.11.6");
    await expect(strip).toContainText("· showing saved messages");
    await expect(strip).not.toContainText("Reconnecting");
    await expect(strip.getByRole("button")).toHaveCount(0);
    await expect(page.locator(".rail-footer")).toContainText("Updating OpenClaw…");
    await expect(page.getByTestId("announcer")).toHaveText("Updating OpenClaw to 2026.11.6");
    // Focus is not moved by it.
    await expect(strip).not.toBeFocused();
    await dropConnection(page, { outcome: "late" });
    await expect(strip).toContainText("OpenClaw's update is taking longer than usual");
    await expect(strip.getByRole("button", { name: "Retry now" })).toBeVisible();
    await expect(page.locator(".rail-footer")).toContainText("Update taking longer than usual");
    // Settled: the ordinary state at once.
    await dropConnection(page, { outcome: "updated", phase: "finished" });
    await expect(strip).toContainText("Reconnecting");
    await expect(page.locator(".rail-footer")).toContainText("Reconnecting…");
  });

  test("F-591: another lost connection reads as today, and nothing is said on another gateway", async ({
    page,
  }) => {
    await openFixture(page, ADMIN, "dark");
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: { setState(f: (s: ClawtrateState) => ClawtrateState): void };
        }
      ).clawtrateFixture;
      fixture.setState((state) => ({
        ...state,
        connection: { ...state.connection, status: "reconnecting", retryAt: null },
      }));
    });
    const strip = page.getByTestId("status-strip");
    await expect(strip).toContainText("Reconnecting");
    await expect(strip.getByRole("button", { name: "Retry now" })).toBeVisible();
    await openFixture(page, `${ADMIN}&openclawRun=running`, "dark");
    await dropConnection(page, { gatewayId: "another-gateway" });
    await expect(strip).toContainText("Reconnecting");
    await expect(strip).not.toContainText("OpenClaw");
  });
});

for (const [size, theme] of [
  [WIDE, "dark"],
  [WIDE, "light"],
  [PHONE, "dark"],
  [PHONE, "light"],
] as const) {
  test.describe(`update openclaw strip ${size.name} ${theme}`, () => {
    test.use(contextFor(size, theme));

    test("F-591: the strip and the footer while OpenClaw updates match their baselines", async ({
      page,
    }) => {
      await openFixture(page, `${ADMIN}&openclawRun=running`, theme);
      await dropConnection(page);
      await expect(page.getByTestId("status-strip")).toContainText("Updating OpenClaw");
      await settle(page);
      await expect(page).toHaveScreenshot(`update-openclaw-strip-${theme}-${size.name}.png`);
    });
  });
}

for (const [size, theme] of [
  [WIDE, "dark"],
  [PHONE, "light"],
] as const) {
  test.describe(`update openclaw waiting ${size.name} ${theme}`, () => {
    test.use(contextFor(size, theme));

    test("F-591: away longer than usual, the strip says so with Retry, and matches its baseline", async ({
      page,
    }) => {
      await openFixture(page, `${ADMIN}&openclawRun=running`, theme);
      await dropConnection(page, { outcome: "late" });
      await expect(page.getByTestId("status-strip")).toContainText("taking longer than usual");
      await settle(page);
      await expect(page).toHaveScreenshot(`update-openclaw-strip-late-${theme}-${size.name}.png`);
    });

    test("F-591: the card's bar waits at the restart step while the gateway is away, and matches its baseline", async ({
      page,
    }) => {
      await openFixture(page, `${ADMIN}&openclawRun=running`, theme);
      await dropConnection(page);
      const dialog = await updatesPane(page);
      await expect(dialog.getByRole("progressbar", { name: "OpenClaw update" })).toHaveAttribute(
        "aria-valuetext",
        "Step 6 of 8, restarting: waiting for the gateway to come back",
      );
      await settle(page);
      await expect(page).toHaveScreenshot(`update-openclaw-restarting-${theme}-${size.name}.png`);
    });

    test("F-591: a bot's settings keep one line with a link to Settings › Updates, and match their baseline", async ({
      page,
    }) => {
      await openFixture(page, `${ADMIN}&openclaw=behind&panel=open&tab=settings`, theme);
      const line = page.getByTestId("update-link-notice");
      await expect(line).toContainText("2026.11.6 is out");
      await line.scrollIntoViewIfNeeded();
      await settle(page);
      await expect(page).toHaveScreenshot(`update-openclaw-link-${theme}-${size.name}.png`);
    });
  });
}
