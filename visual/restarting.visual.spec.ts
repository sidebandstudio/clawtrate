// While OpenClaw restarts (#913): the connection strip, the footer, the announcement, the composer
// and Settings › Gateway say "Restarting OpenClaw…" from the engine's `connection.restart`, set
// here on the fixture's state as the engine sets it when the gateway announces a restart; once
// it is gone, each says what a lost connection always said. The strip and the footer at 1440
// and phone width in both themes.
import { test, type Page } from "@playwright/test";
import type { ClawtrateState } from "../packages/core/src/types.ts";
import { contextFor, expect, openFixture, OTTO_DISK, settle, SIZES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.phone)!;
const SCENE = `scene=main&${OTTO_DISK}`;

/** The gateway said it is restarting and has closed the connection: it is coming back. */
const restarting = (page: Page, restart: boolean) =>
  page.evaluate((restart) => {
    const fixture = (
      window as unknown as {
        clawtrateFixture: { setState(f: (s: ClawtrateState) => ClawtrateState): void };
      }
    ).clawtrateFixture;
    fixture.setState((state) => ({
      ...state,
      connection: {
        ...state.connection,
        status: "reconnecting",
        retryAt: null,
        restart: restart
          ? { cause: "announced", since: Date.now(), until: Date.now() + 90_000 }
          : null,
      },
    }));
  }, restart);

test.describe("restarting openclaw", () => {
  test.use(contextFor(WIDE, "dark"));

  test("#913: the strip, the footer, the announcement, the composer and Settings › Gateway say Restarting OpenClaw…; without it, Reconnecting as before", async ({
    page,
  }) => {
    await openFixture(page, SCENE, "dark");
    await restarting(page, true);
    const strip = page.getByTestId("status-strip");
    await expect(strip.locator("strong")).toHaveText("Restarting OpenClaw…");
    await expect(strip).toContainText("· showing saved messages");
    await expect(strip.getByRole("button", { name: "Retry now" })).toBeVisible();
    await expect(page.locator(".rail-footer")).toContainText("Restarting OpenClaw…");
    await expect(page.getByTestId("announcer")).toHaveText("Restarting OpenClaw");
    await expect(page.getByTestId("composer-input")).toHaveAttribute(
      "placeholder",
      "Restarting OpenClaw. Messages send when it's back.",
    );
    await page.keyboard.press("ControlOrMeta+,");
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toContainText("Restarting OpenClaw…");
    await page.keyboard.press("Escape");
    // The wait ran out: the ordinary words, with the countdown and Retry.
    await restarting(page, false);
    await expect(strip).toContainText("Reconnecting");
    await expect(strip).not.toContainText("OpenClaw");
    await expect(page.locator(".rail-footer")).toContainText("Reconnecting…");
    await expect(page.getByTestId("composer-input")).toHaveAttribute(
      "placeholder",
      "Offline. Messages send when you reconnect.",
    );
  });
});

for (const [size, theme] of [
  [WIDE, "dark"],
  [PHONE, "dark"],
  [WIDE, "light"],
  [PHONE, "light"],
] as const) {
  test.describe(`restarting openclaw ${size.name} ${theme}`, () => {
    test.use(contextFor(size, theme));

    test("#913: the strip and the footer while OpenClaw restarts match their baselines", async ({
      page,
    }) => {
      await openFixture(page, SCENE, theme);
      await restarting(page, true);
      await expect(page.getByTestId("status-strip")).toBeVisible();
      await settle(page);
      await expect(page).toHaveScreenshot(`restarting-openclaw-${theme}-${size.name}.png`);
    });
  });
}
