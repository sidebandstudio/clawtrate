// The title bar, the update button, the Settings gear and the gateway's name
// (docs/design/titlebar.md).
import type { BridgeCommand } from "../packages/core/src/bridge.ts";
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, settle, showList, SIZES, THEMES } from "./fixture.ts";

const DESKTOP = SIZES.find((s) => s.name === "1440")!;
const PHONE = SIZES.find((s) => s.phone)!;

const brand = (page: Page) => page.locator('[data-testid="brand"]:visible');
const updateButton = (page: Page) => page.locator(".update-button:visible");
const card = (page: Page) => page.getByRole("button", { name: /Open the gateway menu\.$/ });
const sent = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { clawtrateFixture: { sent: BridgeCommand[] } }).clawtrateFixture.sent
      .filter((command) => command.type === "nameGateway")
      .map((command) => ({ ...command })),
  );

for (const size of [DESKTOP, PHONE])
  for (const theme of THEMES)
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));

      test("F-519: Clawtrate's mark and name, with the Beta pill on a Beta build", async ({
        page,
      }) => {
        await openFixture(page, "scene=main&updates=not-checked&buildTrack=nightly", theme);
        await showList(page);
        await expect(brand(page)).toHaveCount(1);
        await expect(brand(page).getByRole("img")).toHaveCount(0);
        await expect(brand(page)).toContainText("Clawtrate");
        await expect(brand(page).getByText("Beta", { exact: true })).toBeVisible();
        if (size.phone) {
          await expect(page.getByTestId("titlebar")).toBeHidden();
          // The name is still read in the one-pane layout, only not drawn.
          await expect(brand(page).locator(".brand-name")).toHaveCSS("position", "absolute");
        } else {
          const bar = page.getByTestId("titlebar");
          await expect(bar).toHaveCSS("-webkit-app-region", "drag");
          await expect(bar).toHaveCSS("height", "40px");
        }
        await settle(page);
        await expect(page.locator(size.phone ? ".rail-top" : ".titlebar")).toHaveScreenshot(
          `titlebar/brand-${size.name}-${theme}.png`,
        );
      });

      test("F-519: the window with the title bar, a ready update and a named gateway", async ({
        page,
      }) => {
        await openFixture(
          page,
          `scene=main&${OTTO_DISK}&panel=closed&updates=ready&buildTrack=nightly&gatewayName=Devbox`,
          theme,
        );
        await expect(page.getByTestId("transcript-turn").first()).toBeVisible();
        // The phone shows the list, where the brand is.
        await showList(page);
        await settle(page);
        await expect(page).toHaveScreenshot(`titlebar/window-${size.name}-${theme}.png`);
      });

      test("F-521: a gear named Settings opens Settings, and focus comes back to it", async ({
        page,
      }) => {
        await openFixture(page, "scene=main", theme);
        await showList(page);
        const gear = page.getByRole("button", { name: "Settings", exact: true });
        await expect(gear).toBeVisible();
        await expect(gear).toHaveAttribute("title", /^Settings \((⌘|Ctrl\+),\)$/);
        const box = await gear.boundingBox();
        expect(box?.width).toBeGreaterThanOrEqual(size.phone ? 40 : 32);
        // Reached from the card with Tab, it shows the focus ring.
        await card(page).focus();
        await page.keyboard.press("Tab");
        await expect(gear).toBeFocused();
        await expect(gear).not.toHaveCSS("outline-style", "none");
        await page.keyboard.press("Enter");
        await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(gear).toBeFocused();
      });

      test("F-522: naming the gateway from its menu shows the name over the address", async ({
        page,
      }) => {
        await openFixture(page, "scene=main", theme);
        await showList(page);
        const unnamed = await card(page).getAttribute("aria-label");
        const address = unnamed!.replace(/, connected\. Open the gateway menu\.$/, "");

        await card(page).click();
        await page.getByRole("menuitem", { name: "Name this gateway…" }).click();
        const dialog = page.getByRole("dialog", { name: "Name this gateway" });
        await expect(dialog).toHaveAccessibleDescription(
          new RegExp(
            `stays on this device and is never sent to the gateway\\.\\s*wss?://${address}`,
          ),
        );
        // The whole address the name is kept under, scheme included, not only host and port.
        await expect(dialog.locator(".rail-dialog-address")).toHaveText(
          new RegExp(`^wss?://${address.replace(/\./g, "\\.")}$`),
        );
        const field = dialog.getByRole("textbox", { name: "Name" });
        await expect(field).toBeFocused();
        await expect(field).toHaveAccessibleDescription("Leave it empty to show the address.");
        await expect(field).toHaveAttribute("maxlength", "40");
        // Escape keeps things as they were and gives focus back to the card.
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(card(page)).toBeFocused();

        await card(page).click();
        await page.getByRole("menuitem", { name: "Name this gateway…" }).click();
        await dialog.getByRole("textbox", { name: "Name" }).fill("Devbox");
        await settle(page);
        await expect(dialog).toHaveScreenshot(`titlebar/rename-${size.name}-${theme}.png`);
        await page.keyboard.press("Enter");
        await expect(dialog).toHaveCount(0);
        await expect(card(page)).toHaveAccessibleName("Devbox, connected. Open the gateway menu.");
        await expect(card(page)).toBeFocused();
        await expect(page.locator(".gateway-pill-text strong")).toHaveText("Devbox");
        await expect(page.locator(".gateway-pill-text span")).toHaveText(address);
        expect(await sent(page)).toEqual([
          { type: "nameGateway", gatewayUrl: expect.stringContaining(address), name: "Devbox" },
        ]);
        await settle(page);
        await expect(page.locator(".rail-footer")).toHaveScreenshot(
          `titlebar/named-card-${size.name}-${theme}.png`,
        );

        // Renaming starts from the name; an empty name shows the address again.
        await card(page).click();
        await expect(page.getByRole("menu").getByText(/^Devbox$/)).toBeVisible();
        await page.getByRole("menuitem", { name: "Rename gateway…" }).click();
        const rename = page.getByRole("dialog", { name: "Rename gateway" });
        await expect(rename.getByRole("textbox", { name: "Name" })).toHaveValue("Devbox");
        await rename.getByRole("textbox", { name: "Name" }).fill("");
        await rename.getByRole("button", { name: "Save" }).click();
        await expect(card(page)).toHaveAccessibleName(unnamed!);
      });
    });

// The update button: what each state says, and what pressing it does.
const STATES: Array<[fixture: string, text: string, press: "updates" | "confirm" | "none"]> = [
  ["offered", "Update available", "updates"],
  ["downloading", "Downloading 30%", "updates"],
  ["inspecting", "Checking download…", "updates"],
  ["ready", "Restart to Update", "confirm"],
  ["verified", "Update downloaded", "updates"],
  ["preparing", "Restarting…", "none"],
  ["handing-off", "Restarting…", "none"],
  ["handed-to-system", "Installs on quit", "updates"],
  ["handoff-unconfirmed", "Update unconfirmed", "updates"],
  ["installer-failed", "Couldn't install", "updates"],
  ["failcheck", "Couldn't check", "updates"],
  ["faildl", "Download failed", "updates"],
];

for (const size of [DESKTOP, PHONE])
  for (const theme of THEMES)
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      for (const [fixture, text, press] of STATES)
        test(`F-520: the update button when ${fixture}`, async ({ page }) => {
          await openFixture(page, `scene=main&updates=${fixture}`, theme);
          await showList(page);
          const button = updateButton(page);
          await expect(button).toHaveCount(1);
          // Its name starts with its words, which the phone's round form keeps in its tooltip.
          await expect(button).toHaveAccessibleName(new RegExp(`^${text}`));
          if (size.phone) await expect(button).toHaveAttribute("title", text);
          else await expect(button).toHaveText(text);
          await settle(page);
          if (!size.phone || theme === "dark")
            await expect(button).toHaveScreenshot(
              `titlebar/update-${fixture}-${size.name}-${theme}.png`,
            );
          if (press === "none") {
            await expect(button).toHaveAttribute("aria-disabled", "true");
            await button.click({ force: true });
            await expect(page.getByRole("dialog")).toHaveCount(0);
            await expect(page.getByRole("alertdialog")).toHaveCount(0);
          } else if (press === "updates") {
            await expect(button).toHaveAccessibleName(/\. Open Updates$/);
            await button.click();
            await expect(page.locator(".updates-section")).toBeVisible();
            await page.keyboard.press("Escape");
            await expect(button).toBeFocused();
          } else {
            // The same confirmation as Settings → Updates; Restart begins the restart.
            await button.click();
            const confirm = page.getByRole("alertdialog", { name: "Restart to update?" });
            await expect(confirm).toContainText("install version 0.2.0 and reopen");
            await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
            await page.keyboard.press("Escape");
            await expect(confirm).toHaveCount(0);
            await expect(button).toBeFocused();
            await button.click();
            await confirm.getByRole("button", { name: "Restart", exact: true }).click();
            await expect(updateButton(page)).toHaveAccessibleName(/^Restarting…/);
            await expect(updateButton(page)).toHaveAttribute("aria-disabled", "true");
          }
        });
    });

test.describe("1440 dark", () => {
  test.use(contextFor(DESKTOP, "dark"));

  for (const [query, why] of [
    ["updates=not-checked", "a Stable build"],
    ["updates=dev", "a development build"],
    ["updates=invalid&buildTrack=nightly", "a version that can't be read"],
    ["scene=main", "no update source at all"],
  ])
    test(`F-519: ${why} shows no Beta pill`, async ({ page }) => {
      await openFixture(page, `scene=main&${query}`, "dark");
      await expect(brand(page)).toContainText("Clawtrate");
      await expect(brand(page).getByText("Beta", { exact: true })).toHaveCount(0);
    });

  for (const state of ["not-checked", "checking", "nothing-newer", "pending", "preferences", "dev"])
    test(`F-520: no update button while the update says nothing (${state})`, async ({ page }) => {
      await openFixture(page, `scene=main&updates=${state}`, "dark");
      await expect(page.getByTestId("titlebar")).toBeVisible();
      await expect(updateButton(page)).toHaveCount(0);
    });

  test("F-520: the button's new state is said once, without Open Updates", async ({ page }) => {
    await openFixture(page, "scene=main&updates=offered", "dark");
    await expect(page.getByTestId("update-announcer")).toHaveText(
      "Update available: Clawtrate 0.2.0",
    );
  });

  for (const [refusal, said] of [
    ["busy", "Another update action is in progress."],
    ["stale", "This offer is no longer current."],
    ["invalid", "Couldn't start the restart."],
    ["silent", "Couldn't get a reply to the restart request."],
  ] as const)
    test(`F-520: a restart the host refuses (${refusal}) opens Updates, which says why`, async ({
      page,
    }) => {
      await openFixture(page, `scene=main&updates=ready&restart=${refusal}`, "dark");
      await updateButton(page).click();
      await page
        .getByRole("alertdialog", { name: "Restart to update?" })
        .getByRole("button", { name: "Restart", exact: true })
        .click();
      await expect(page.locator(".updates-section")).toBeVisible();
      await expect(page.locator(".updates-section")).toContainText(said);
    });

  test("F-520: Restarting turns, and stands still with reduced motion", async ({ page }) => {
    await openFixture(page, "scene=main&updates=preparing", "dark");
    await expect(page.locator(".update-spin:visible")).not.toHaveCSS("animation-name", "none");
    await openFixture(page, "scene=main&updates=preparing&motion=reduce", "dark");
    await expect(page.locator(".update-spin:visible")).toHaveCSS("animation-name", "none");
  });

  test("F-522: a name given before shows on the card and in the menu", async ({ page }) => {
    await openFixture(page, "scene=main&gatewayName=Devbox", "dark");
    await expect(card(page)).toHaveAccessibleName("Devbox, connected. Open the gateway menu.");
    await card(page).click();
    await expect(page.getByRole("menuitem", { name: "Rename gateway…" })).toBeVisible();
  });
});
