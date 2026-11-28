// #913: while the gateway says it is restarting, the app says so where it would say it is
// reconnecting; past the wait, that OpenClaw hasn't come back, with what to do and Retry.
import { test } from "@playwright/test";
import type { ClawtrateState } from "../packages/core/src/types.ts";
import { contextFor, expect, openFixture, OTTO_DISK, settle, SIZES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.phone)!;

test("F-603: while OpenClaw restarts, the strip, the footer and the announcement say so, with no countdown and no Retry; past the wait, that it hasn't come back, with Retry", async ({
  page,
}) => {
  // Connected, then the gateway says it is restarting and the connection drops.
  await openFixture(page, `scene=main&${OTTO_DISK}`, "dark");
  await page.evaluate(() => {
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
        restart: "restarting",
      },
    }));
  });
  const strip = page.getByTestId("status-strip");
  await expect(strip.locator(".strip-long")).toHaveText("Restarting OpenClaw");
  await expect(strip).toContainText("· showing saved messages");
  await expect(strip).not.toContainText("Reconnecting");
  await expect(strip.getByRole("button")).toHaveCount(0);
  await expect(page.locator(".rail-footer")).toContainText("Restarting OpenClaw…");
  await expect(page.getByTestId("announcer")).toHaveText("Restarting OpenClaw");
  await expect(strip).not.toBeFocused();

  await openFixture(page, `scene=restart-late&${OTTO_DISK}`, "dark");
  await expect(strip.locator(".strip-long")).toHaveText(
    "OpenClaw hasn't come back from its restart",
  );
  await expect(strip).toContainText("· check that OpenClaw is running");
  await expect(strip).toHaveAttribute("data-tone", "danger");
  await expect(strip.getByRole("button", { name: "Retry now" })).toBeVisible();
  await expect(page.locator(".rail-footer")).toContainText("Not back from its restart");
});

for (const [size, theme] of [
  [WIDE, "dark"],
  [WIDE, "light"],
  [PHONE, "dark"],
  [PHONE, "light"],
] as const) {
  test.describe(`gateway restart strip ${size.name} ${theme}`, () => {
    test.use(contextFor(size, theme));

    test("F-603: the strip and the footer while OpenClaw restarts match their baselines", async ({
      page,
    }) => {
      await openFixture(page, `scene=restarting&${OTTO_DISK}`, theme);
      await expect(page.getByTestId("status-strip")).toContainText("Restarting OpenClaw");
      await settle(page);
      await expect(page).toHaveScreenshot(`gateway-restart-strip-${theme}-${size.name}.png`);
    });
  });
}
