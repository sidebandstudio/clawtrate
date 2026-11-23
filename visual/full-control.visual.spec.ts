// F-519: the packaged Mac app's address form shows the consent line directly above
// Connect for a secure address, with "What this means" (docs/design/setup-effortless.md §2),
// and a full pairing the gateway granted less says so and asks for nothing (§2, §8). In light
// and dark, at 1440 px and the phone; reached by keyboard and named for a screen reader.
import { expect, test } from "@playwright/test";
import { COMPUTER } from "./computer-helpers.ts";
import { contextFor, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

const CONSENT =
  "Full control lets Clawtrate change gateway settings, approve devices and, when the gateway allows it, open a terminal on the computer running OpenClaw.";

for (const size of SIZES.filter((each) => each.name === "1440" || each.phone)) {
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));

      test("F-519: the consent line, closed and open", async ({ page }) => {
        await openFixture(page, "scene=connect-full", theme);
        await expect(page.getByTestId("full-control-consent")).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(`full-control-consent-${theme}-${size.name}.png`);
        await page.getByRole("button", { name: "What this means" }).click();
        await expect(page.locator(".consent-points")).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(`full-control-what-${theme}-${size.name}.png`);
      });

      test("F-519: a narrower grant, in Settings", async ({ page }) => {
        await openFixture(page, `scene=access-narrowed&${OTTO_DISK}`, theme);
        await page.keyboard.press("ControlOrMeta+,");
        const dialog = page.getByRole("dialog", { name: "Settings" });
        if (size.phone) await dialog.getByRole("button", { name: /^Gateway/ }).click();
        await expect(dialog.getByTestId("narrower-grant")).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(`full-control-narrowed-${theme}-${size.name}.png`);
      });
    });
  }
}

test("F-519: the consent line sits directly above Connect, and only for a secure address", async ({
  page,
}) => {
  await openFixture(page, "scene=connect-full", "dark");
  const consent = page.getByTestId("full-control-consent");
  await expect(consent.locator(".consent-line")).toHaveText(`${CONSENT} What this means`);
  // Nothing between it and the button.
  const next = await consent.evaluate((el) => el.nextElementSibling?.className);
  expect(next).toBe("actions");
  const address = page.getByPlaceholder("Gateway address");
  for (const url of ["ws://gateway.example", "wss://127.0.0.1:18789", "wss://localhost"]) {
    await address.fill(url);
    await expect(consent).toHaveCount(0);
  }
  await address.fill("wss://gateway.example.net");
  await expect(page.getByTestId("full-control-consent")).toBeVisible();
});

test("F-519: What this means opens and closes from the keyboard, and says whether it is open", async ({
  page,
}) => {
  await openFixture(page, "scene=connect-full", "dark");
  const more = page.getByRole("button", { name: "What this means" });
  const points = page.locator(".consent-points");
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(points).toBeHidden();
  await expect(more).toHaveAttribute("aria-controls", (await points.getAttribute("id"))!);
  // From the token field, the next stop is the link, then Connect.
  await page.getByPlaceholder("Gateway token, for pairing").focus();
  await page.keyboard.press("Tab");
  await expect(more).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(points.getByRole("listitem")).toHaveCount(5);
  await expect(points).toContainText(
    "If this device is lost, remove it from another admin connection.",
  );
  await page.keyboard.press("Space");
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(points).toBeHidden();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Connect a gateway" })).toBeFocused();
});

test("F-519: a full pairing the gateway granted less keeps it, says so, and offers no request for more", async ({
  page,
}) => {
  await openFixture(page, `scene=access-narrowed&${OTTO_DISK}`, "dark");
  const bar = page.getByTestId("access-bar");
  await expect(bar).toContainText("OpenClaw granted less than full control.");
  await expect(bar.getByRole("button")).toHaveCount(0);
  // Nor does anything else on the page: the transcript, the step panel or a card.
  await expect(page.getByRole("button", { name: /Request/ })).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog.getByTestId("gateway-access")).toHaveText("Less than full control");
  await expect(dialog.getByTestId("narrower-grant")).toHaveText(
    "OpenClaw granted less than full control. Not granted: sending and stopping, deciding approvals, answering questions, changing gateway settings, approving devices. This device keeps what was granted.",
  );
  await expect(dialog.getByRole("button", { name: "Re-pair" })).toHaveCount(0);
});

test("F-519: a full pairing granted read, write, approvals and questions is offered admin and device access nowhere", async ({
  page,
}) => {
  await openFixture(
    page,
    `scene=access-narrowed&${OTTO_DISK}&access=write&panel=open&tab=settings`,
    "dark",
  );
  // Bot settings' admin bar says so and asks for nothing.
  const admin = page.getByTestId("admin-bar");
  await expect(admin).toContainText("OpenClaw granted less than full control.");
  await expect(admin.getByRole("button", { name: /Request/ })).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  // Nor do Accounts' admin bar and Machines' device bar.
  await settings.getByRole("button", { name: "Accounts", exact: true }).click();
  await expect(settings.getByTestId("admin-bar")).toContainText(
    "OpenClaw granted less than full control.",
  );
  await expect(settings.getByRole("button", { name: /Request/ })).toHaveCount(0);
  await settings.getByRole("button", { name: "Machines", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "Machines", level: 3 })).toBeVisible();
  await expect(settings.getByTestId("device-bar")).toHaveText(
    "OpenClaw granted less than full control.",
  );
  await expect(settings.getByRole("button", { name: /Request/ })).toHaveCount(0);
});

// Each place a read-only connection is offered "Request access", opened as a full pairing (`full=1`).
const ASKS: Array<[string, string, string]> = [
  ["an approval card", "scene=approval-readonly", "approval-card"],
  ["a question card", "scene=question-readonly", "question-card"],
  ["the transcript's waiting note", `scene=read-wait&${OTTO_DISK}&panel=closed`, "read-only-wait"],
  ["the Computer tab", `${COMPUTER}&computer=watching&access=read`, "computer-readonly"],
];
for (const [where, query, testId] of ASKS) {
  test(`F-519: a full pairing the gateway granted less is offered no request for more in ${where}`, async ({
    page,
  }) => {
    await openFixture(page, `${query}&full=1`, "light");
    await expect(page.getByTestId(testId)).toBeVisible();
    await expect(page.getByRole("button", { name: "Request access" })).toHaveCount(0);
  });
}

test("F-519: Settings doesn't tell a full pairing holding admin that it asked for admin", async ({
  page,
}) => {
  await openFixture(page, `scene=access-narrowed&${OTTO_DISK}&access=admin`, "light");
  await page.keyboard.press("ControlOrMeta+,");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog.getByTestId("gateway-access")).toHaveText("Less than full control");
  await expect(dialog).not.toContainText("which it asked for");
});
