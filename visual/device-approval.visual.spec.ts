// F-550: approving a waiting device from inside Clawtrate (docs/design/setup-effortless.md §5).
// The sheet an admin connection opens by itself for the only waiting request, the waiting
// device's own code, the requests in Settings, Gateway, and the notice without admin; in light
// and dark, at 1440 px and the phone. Then, once, what a keyboard and a screen reader meet: the
// two refusals first, the codes read as codes, focus on the title, Escape as "Not now".
import { test, type Page } from "@playwright/test";
import { contextFor, expect, openFixture, settle, SIZES, THEMES } from "./fixture.ts";

const CODE = "K7QF-2MXA";

type Sent = Array<Record<string, unknown>>;
const sent = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { clawtrateFixture: { sent: Sent } }).clawtrateFixture.sent
      .filter((each) => /Device$/.test(String(each.type)))
      .map(({ type, code, why }) => ({ type, ...(code ? { code } : {}), ...(why ? { why } : {}) })),
  );

const sheetOf = (page: Page) =>
  page.getByRole("dialog", { name: "A device is asking to use this gateway" });

async function openGatewaySettings(page: Page, phone: boolean) {
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  if (phone) await dialog.getByRole("button", { name: /^Gateway/ }).click();
  await expect(dialog.getByRole("heading", { name: "Devices asking" })).toBeVisible();
  return dialog;
}

for (const size of SIZES.filter((each) => each.name === "1440" || each.phone)) {
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));

      test("F-550: the sheet for the only waiting request", async ({ page }) => {
        await openFixture(page, "scene=device-request", theme);
        await expect(sheetOf(page)).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(`device-request-${theme}-${size.name}.png`);
      });

      test("F-550: the waiting device's code", async ({ page }) => {
        await openFixture(page, "scene=pairing", theme);
        const code = page.getByTestId("pairing-code");
        await expect(code).toContainText(CODE);
        await settle(page);
        await expect(code).toHaveScreenshot(`device-waiting-code-${theme}-${size.name}.png`);
      });

      test("F-550: requests waiting in Settings, Gateway", async ({ page }) => {
        await openFixture(page, "scene=devices-asking", theme);
        const dialog = await openGatewaySettings(page, size.phone === true);
        await settle(page);
        await expect(dialog).toHaveScreenshot(`devices-asking-settings-${theme}-${size.name}.png`);
      });
    });
  }
}

test("F-550: the two refusals come first, the codes are read as codes, and focus starts on the title", async ({
  page,
}) => {
  await openFixture(page, "scene=device-request", "dark");
  const sheet = sheetOf(page);
  await expect(
    sheet.getByRole("heading", { name: "A device is asking to use this gateway" }),
  ).toBeFocused();
  const names = await sheet
    .getByRole("group", { name: "Which code does the waiting device show?" })
    .getByRole("button")
    .evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-label") ?? b.textContent));
  expect(names).toEqual([
    "I didn't start this",
    "None of these match",
    "Code 4 C 7 R, M Z 2 D",
    "Code 9 H 3 K, T Q 8 B",
    "Code K 7 Q F, 2 M X A",
    "Code W X 5 N, 0 P J 6",
  ]);
  // Tab reaches the refusals before any code.
  await page.keyboard.press("Tab");
  await expect(sheet.getByRole("button", { name: "I didn't start this" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(sheet.getByRole("button", { name: "None of these match" })).toBeFocused();
  await expect(sheet.getByText("Clawtrate Desktop (reported)")).toBeVisible();
  await expect(sheet.getByText("From 203.0.113.7")).toBeVisible();
  // Escape is Not now: nothing is decided.
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  expect(await sent(page)).toEqual([]);
});

for (const [pick, decision, words] of [
  [
    `Code ${"K 7 Q F, 2 M X A"}`,
    { type: "approveDevice", code: CODE },
    "Approved. The device connects in a moment.",
  ],
  [
    "Code 9 H 3 K, T Q 8 B",
    { type: "approveDevice", code: "9H3K-TQ8B" },
    "That isn't this request's code, so nothing was approved.",
  ],
  ["None of these match", { type: "refuseDevice", why: "none-match" }, "Nothing was approved."],
  [
    "I didn't start this",
    { type: "refuseDevice", why: "not-mine" },
    "Denied. The device can ask again.",
  ],
] as const) {
  test(`F-550: ${pick} says what it did`, async ({ page }) => {
    await openFixture(page, "scene=device-request", "dark");
    const sheet = sheetOf(page);
    await sheet.getByRole("button", { name: pick, exact: true }).click();
    await expect(sheet.getByTestId("device-outcome")).toContainText(words);
    await expect(sheet.getByRole("button", { name: "Close" })).toBeFocused();
    expect(await sent(page)).toEqual([decision]);
    // A pick that approved nothing offers a Deny, so the device can ask again.
    await expect(sheet.getByRole("button", { name: "Deny it" })).toHaveCount(
      decision.type === "approveDevice"
        ? decision.code === CODE
          ? 0
          : 1
        : decision.why === "none-match"
          ? 1
          : 0,
    );
  });
}

test("F-550: more than one waiting request is one quiet line, and each opens the same sheet", async ({
  page,
}) => {
  await openFixture(page, "scene=devices-asking", "dark");
  await expect(sheetOf(page)).toHaveCount(0);
  const line = page.getByTestId("devices-asking");
  await expect(line).toContainText("3 devices are asking to use this gateway.");
  await line.getByRole("button", { name: "Review" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: /^Work laptop \(reported\)/ }).click();
  await expect(sheetOf(page).getByText("Work laptop (reported)")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheetOf(page)).toHaveCount(0);
  await expect(settings).toBeVisible();
});

test("F-550: a connection without admin shows only where to approve", async ({ page }) => {
  await openFixture(page, "scene=device-notice", "dark");
  await expect(page.getByTestId("devices-notice")).toHaveText(
    "A device is asking to connect. Approve it in Clawtrate on a device with full control.",
  );
  await expect(sheetOf(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Code / })).toHaveCount(0);
});
