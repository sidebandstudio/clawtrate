// The "Turn time limit" setting in the fixture mode (parity F-100): where it is,
// its default, and that a change reaches the host. The engine's half is
// packages/core/test/turn-limit.test.ts; the card it leads to is checked in
// live.behaviour.visual.spec.ts.
import type { ClawtrateState } from "../packages/core/src/index.ts";
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;

async function openPane(page: Page, theme: "light" | "dark" = "light") {
  await openFixture(page, `scene=composer&${OTTO_DISK}&panel=closed`, theme);
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "Conversation", level: 3 })).toBeVisible();
  return settings;
}

type VoiceFixture = {
  voiceReaches(reaches: boolean): void;
  setState(change: (state: ClawtrateState) => ClawtrateState): void;
};

test.describe("the plain voice", () => {
  test.use(contextFor(WIDE, "light"));

  test("F-519: a gateway that keeps the voice plugin's hook from running shows Plain voice off, and says how to allow it", async ({
    page,
  }) => {
    await openFixture(page, `scene=composer&${OTTO_DISK}&panel=closed`, "light");
    await page.evaluate(() =>
      (window as unknown as { clawtrateFixture: VoiceFixture }).clawtrateFixture.voiceReaches(
        false,
      ),
    );
    await page.keyboard.press("ControlOrMeta+,");
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("button", { name: "Conversation", exact: true }).click();
    const toggle = settings.getByRole("switch", { name: "Plain voice" });
    await expect(settings.getByTestId("plain-voice-note")).toContainText("allowConversationAccess");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(toggle).toBeDisabled();
  });

  test("F-519: after the connection drops, Plain voice shows nothing until the gateway answers again", async ({
    page,
  }) => {
    const settings = await openPane(page);
    const toggle = settings.getByRole("switch", { name: "Plain voice" });
    const note = settings.getByTestId("plain-voice-note");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await page.evaluate(() =>
      (window as unknown as { clawtrateFixture: VoiceFixture }).clawtrateFixture.setState((s) => ({
        ...s,
        connection: { ...s.connection, status: "disconnected" },
      })),
    );
    await expect(note).toHaveText("Shown once Clawtrate is connected to the gateway.");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(toggle).toBeDisabled();
    await page.evaluate(() =>
      (window as unknown as { clawtrateFixture: VoiceFixture }).clawtrateFixture.setState((s) => ({
        ...s,
        connection: { ...s.connection, status: "connected" },
      })),
    );
    await expect(toggle).toHaveAttribute("aria-checked", "true");
  });
});

test.describe("the turn time limit", () => {
  test.use(contextFor(WIDE, "light"));

  test("F-100: Settings has a Turn time limit, 50 minutes by default, and a change reaches the host", async ({
    page,
  }) => {
    const settings = await openPane(page);
    const limit = settings.getByLabel("Turn time limit");
    await expect(limit).toHaveValue("50");
    await expect(limit).toHaveAccessibleDescription(/50 by default/);
    // A stop at the limit is asked of the gateway, and the note names the limit once it confirms.
    await expect(limit).toHaveAccessibleDescription(/asks the gateway to stop/);
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
      page.getByRole("dialog", { name: "Settings" }).getByLabel("Turn time limit"),
    ).toHaveValue("20");
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
