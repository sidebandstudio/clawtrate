// The "Turn time limit" setting in the fixture mode (parity F-100): where it is,
// its default, and that a change reaches the host. The engine's half is
// packages/core/test/turn-limit.test.ts; the card it leads to is checked in
// live.behaviour.visual.spec.ts.
import { test, type Page } from "@playwright/test";
import { contextFor, expect, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;

async function openPane(
  page: Page,
  theme: "light" | "dark" = "light",
  section: "Conversation" | "Advanced" = "Conversation",
) {
  await openFixture(page, `scene=composer&${OTTO_DISK}&panel=closed`, theme);
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: section, exact: true }).click();
  await expect(settings.getByRole("heading", { name: section, level: 3 })).toBeVisible();
  return settings;
}

test.describe("the turn time limit", () => {
  test.use(contextFor(WIDE, "light"));

  test("F-100: Settings has a Turn time limit, 50 minutes by default, and a change reaches the host", async ({
    page,
  }) => {
    const settings = await openPane(page);
    const limit = settings.getByRole("spinbutton", { name: "Turn time limit" });
    // 50 by default: the field shows it, and its explanation (behind its "i", #798) doesn't repeat it.
    await expect(limit).toHaveValue("50");
    // A stop at the limit is asked of the gateway, and the turn ends with a note naming the limit.
    await expect(limit).toHaveAccessibleDescription(
      "At the limit Clawtrate asks the gateway to stop the turn, so it doesn't hang. Once the gateway confirms, the turn ends with a note naming the limit. Send a message to pick up where it left off. It applies to turns this device starts.",
    );
    await expect(limit).not.toHaveAccessibleDescription(/is stopped so it does not hang/);
    await limit.fill("0");
    await page.keyboard.press("Enter");
    await expect(settings.getByRole("alert")).toHaveText(
      "A turn time limit is a whole number of minutes from 1 to 1440.",
    );
    await limit.fill("20");
    await page.keyboard.press("Enter");
    await expect(settings.getByRole("alert")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                clawtrateFixture: { getState(): { turnLimitMinutes?: number } };
              }
            ).clawtrateFixture.getState().turnLimitMinutes,
        ),
      )
      .toBe(20);
    await expect(limit).toHaveValue("20");
    // Kept on reopening.
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+,");
    await expect(
      page
        .getByRole("dialog", { name: "Settings" })
        .getByRole("spinbutton", { name: "Turn time limit" }),
    ).toHaveValue("20");
  });

  test("F-519: Settings → Advanced has Show external channel chats, off by default, and a change reaches the host", async ({
    page,
  }) => {
    const settings = await openPane(page, "light", "Advanced");
    // Not in Conversation any more.
    await settings.getByRole("button", { name: "Conversation", exact: true }).click();
    await expect(settings.getByRole("switch", { name: "Show external channel chats" })).toHaveCount(
      0,
    );
    await settings.getByRole("button", { name: "Advanced", exact: true }).click();
    const toggle = settings.getByRole("switch", { name: "Show external channel chats" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(toggle).toHaveAccessibleDescription(/main conversation always shows/);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                clawtrateFixture: { getState(): { showChannelChats?: boolean } };
              }
            ).clawtrateFixture.getState().showChannelChats,
        ),
      )
      .toBe(true);
  });
});

for (const size of SIZES) {
  for (const theme of THEMES) {
    test.describe(`turn limit ${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      test("F-100: the Conversation settings", async ({ page }) => {
        await openPane(page, theme);
        await settle(page);
        await expect(page).toHaveScreenshot(`settings-turn-limit-${theme}-${size.name}.png`);
      });
    });
  }
}
