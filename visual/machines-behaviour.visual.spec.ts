// How "Where a bot runs" and Settings, Machines behave (docs/design/controls.md
// sections 2, 14, 15 and 19) in the fixture: a save announced only once the
// engine's answer comes back, a refused save that changes nothing, the
// defaults as one radio group with one tab stop, device access asked for by
// name, the read-only connection, and Back returning to the row that opened it.
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, SIZES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PANE = `scene=main&${OTTO_DISK}&panel=open&tab=settings`;

test.use(contextFor(WIDE, "light"));

const sent = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { clawtrateFixture: { sent: Array<Record<string, unknown>> } }
    ).clawtrateFixture.sent.map((each) => ({ ...each })),
  );
/** The Work pane's live region, or Settings' when Settings is open. */
const announcer = (page: Page) => page.getByTestId("work-announcer");
const settingsAnnouncer = (page: Page) =>
  page.getByRole("dialog", { name: "Settings" }).getByTestId("b-announcer");

async function openRunsOn(page: Page) {
  await page.getByRole("button", { name: /^Where Otto runs: / }).click();
  await expect(page.getByTestId("runs-on-workspace")).toBeVisible();
}

async function openMachines(page: Page) {
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Machines", exact: true }).click();
  await expect(page.getByTestId("machine-list")).toBeVisible();
}

test("F-046: choosing where Otto's commands run is announced only once the answer comes back, and the page reads again", async ({
  page,
}) => {
  await openFixture(page, `${PANE}&access=admin`, "light");
  await expect(page.getByTestId("runs-on-value")).toHaveText("Commands on media-box");
  await openRunsOn(page);
  const select = page.getByTestId("runs-on-machine");
  await expect(select).toHaveAccessibleName("Where Otto's commands run: media-box · Connected");
  await select.click();
  await page.getByRole("menuitemradio", { name: "The gateway's machine" }).click();
  // The fixture answers after 300 ms; nothing is announced before.
  await expect(announcer(page)).not.toHaveText(/Saved/);
  await expect(announcer(page)).toHaveText("Saved. Otto's commands: the gateway's machine");
  await expect(select).toHaveAccessibleName("Where Otto's commands run: The gateway's machine");
  expect((await sent(page)).filter((c) => c.type === "readPlacement").length).toBeGreaterThan(1);
  // Back returns to the row that opened the page, which reads the new value.
  await page.getByRole("button", { name: "Back to settings" }).click();
  await expect(page.getByRole("button", { name: /^Where Otto runs: / })).toBeFocused();
  await expect(page.getByTestId("runs-on-value")).toHaveText("Commands on the gateway's machine");
});

test("F-046: a refused save says what the gateway answered, and the setting shown stays as it was", async ({
  page,
}) => {
  await openFixture(page, `${PANE}&access=admin&mwrite=refused`, "light");
  await openRunsOn(page);
  await page.getByTestId("runs-on-machine").click();
  await page.getByRole("menuitemradio", { name: "The gateway's machine" }).click();
  await expect(page.getByTestId("runs-on-error-line")).toHaveText(
    /The gateway answered: invalid config/,
  );
  await expect(announcer(page)).toHaveText("Couldn't save");
  await expect(page.getByTestId("runs-on-machine")).toHaveAccessibleName(
    "Where Otto's commands run: media-box · Connected",
  );
});

test("F-046 F-047: below admin every value shows, nothing can be changed, and the bar asks for admin by an explicit request", async ({
  page,
}) => {
  await openFixture(page, `${PANE}&access=write`, "light");
  await openRunsOn(page);
  await expect(page.getByTestId("runs-on-machine")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Change…" })).toHaveCount(0);
  await expect(page.getByTestId("inventory-secrets")).toHaveText("Needs admin access");
  await expect(page.getByTestId("inventory-servers")).toContainText("t3code (denied for Otto)");
  expect((await sent(page)).some((c) => c.type === "requestAccess")).toBe(false);
  const bar = page.getByTestId("admin-bar");
  await expect(bar).toContainText("Changing where Otto runs needs admin access.");
  await bar.getByRole("button", { name: "Request admin access" }).click();
  await expect(bar).toContainText("Waiting for the gateway's owner.");
  expect((await sent(page)).filter((c) => c.type === "requestAccess")).toEqual([
    { type: "requestAccess", tier: "admin" },
  ]);
});

test("F-046: a host that only reads offers no change and no request", async ({ page }) => {
  await openFixture(page, `scene=access-pinned&${OTTO_DISK}&panel=open&tab=settings`, "light");
  await openRunsOn(page);
  await expect(page.getByTestId("runs-on-machine")).toBeDisabled();
  await expect(page.getByTestId("admin-bar")).toContainText("This connection only reads.");
  await expect(page.getByRole("button", { name: "Request admin access" })).toHaveCount(0);
});

test("F-274: a workspace path is checked before anything is sent, and a saved one is announced and shown", async ({
  page,
}) => {
  await openFixture(page, `${PANE}&access=admin&machine=gatewayhost`, "light");
  await openRunsOn(page);
  await page.getByRole("button", { name: "Change…" }).click();
  const field = page.getByRole("textbox", { name: /folder on the gateway's machine/ });
  await expect(field).toBeFocused();
  await field.fill("workspaces/otto-2");
  await page.getByRole("button", { name: "Save folder" }).click();
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(field).toBeFocused();
  expect((await sent(page)).some((c) => c.type === "setBotWorkspace")).toBe(false);
  await field.fill("/srv/clawtrate/workspaces/otto-2");
  await page.getByRole("button", { name: "Save folder" }).click();
  await expect(announcer(page)).toHaveText(
    "Saved. Otto's workspace: /srv/clawtrate/workspaces/otto-2",
  );
  await expect(page.getByTestId("runs-on-workspace")).toContainText(
    "/srv/clawtrate/workspaces/otto-2",
  );
});

test("F-156: a machine's defaults are one radio group: one tab stop, arrows move and choose, saved only once read back", async ({
  page,
}) => {
  await openFixture(page, `${PANE}&access=admin`, "light");
  await openMachines(page);
  const file = page.locator('[data-testid="approvals-file"][data-machine="media-box"]');
  const group = file.getByRole("radiogroup");
  await expect(group.getByRole("radio", { checked: true })).toHaveAccessibleName(
    "Ask for commands not on the allowlist",
  );
  await expect(group.locator('[tabindex="0"]')).toHaveCount(1);
  await group.getByRole("radio", { checked: true }).focus();
  await page.keyboard.press("ArrowUp");
  await expect(group.getByRole("radio", { name: "Ask every time" })).toBeFocused();
  await expect(settingsAnnouncer(page)).toHaveText("Saved. media-box: Ask every time");
  await expect(group.getByRole("radio", { checked: true })).toHaveAccessibleName("Ask every time");
  expect((await sent(page)).filter((c) => c.type === "setMachineDefaults")).toEqual([
    {
      type: "setMachineDefaults",
      machineId: expect.any(String),
      choice: "always",
      expectedHash: "m1",
    },
  ]);
  await expect(file.getByTestId("approvals-effective")).toContainText(
    "Every command asks: media-box's file asks more than Otto's policy (Review first), so the gateway skips Otto's reviewer.",
  );
});

test("F-156: an approvals file is shown only with admin, and a machine not connected says so", async ({
  page,
}) => {
  await openFixture(page, `${PANE}&access=write&machine=offline`, "light");
  await openMachines(page);
  await expect(page.getByTestId("approvals-unavailable").first()).toHaveText(
    "Seeing a machine's approvals needs admin access.",
  );
  await expect(page.getByRole("radiogroup")).toHaveCount(0);
  await page.goto(page.url().replace("access=write", "access=admin"));
  await openMachines(page);
  await expect(page.locator('[data-machine="media-box"]').first()).toContainText(
    "Not connected · Last seen",
  );
  await expect(
    page.locator('[data-testid="approvals-file"][data-machine="media-box"]'),
  ).toContainText("media-box isn't connected, so its file can't be read now.");
});

test("F-157: device access is asked for by name only; with it, a device is renamed and a machine not connected removed after a confirmation", async ({
  page,
}) => {
  await openFixture(page, `${PANE}&access=write&devices=noscope&pairing=grant`, "light");
  await openMachines(page);
  await expect(page.getByTestId("devices-unavailable")).toHaveText(
    "Seeing paired devices needs device access.",
  );
  await page.getByTestId("device-bar").getByRole("button", { name: "Request access" }).click();
  expect((await sent(page)).filter((c) => c.type === "requestAccess")).toEqual([
    { type: "requestAccess", tier: "pairing" },
  ]);
  await expect(page.getByTestId("device-list")).toBeVisible();
  await expect(page.getByTestId("device-list")).toContainText("This device");
  await page.getByTestId("device-list").getByRole("button", { name: "Rename" }).nth(1).click();
  const name = page.getByRole("textbox", { name: /New name for Clawtrate on iPhone/ });
  await name.fill("Phone");
  await page.keyboard.press("Enter");
  await expect(settingsAnnouncer(page)).toHaveText("Renamed");
  await expect(page.getByTestId("device-list")).toContainText("Phone");
  await page.getByRole("button", { name: "Remove studio-mac…" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("button", { name: "Remove" }).click();
  await expect(settingsAnnouncer(page)).toHaveText("Removed");
  await expect(page.getByTestId("machine-list")).not.toContainText("studio-mac");
});
