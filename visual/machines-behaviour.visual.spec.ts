// How "Where a bot runs" and Settings, Machines behave (docs/design/controls.md
// sections 2, 14, 15 and 19) in the fixture: a save announced only once the
// engine's answer comes back, as saved and as applied only when it is, a
// refused save that changes nothing, a read never drawn for another bot, the
// defaults as one radio group with one tab stop, device access asked for by
// name, another record changed only with admin, the read-only connection, and
// Back returning to the row that opened it.
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
  await expect(page.getByTestId("runs-on-value")).toHaveText("Command setting: media-box");
  await openRunsOn(page);
  const select = page.getByTestId("runs-on-machine");
  await expect(select).toHaveAccessibleName("Otto's command machine: media-box · Connected");
  await expect(page.getByTestId("runs-on-page")).not.toContainText("enforces");
  await select.click();
  await page.getByRole("menuitemradio", { name: "The gateway's machine" }).click();
  // The fixture answers after 300 ms; nothing is announced before.
  await expect(announcer(page)).not.toHaveText(/Saved/);
  await expect(announcer(page)).toHaveText(
    "Saved and applied. Otto's command machine setting: the gateway's machine",
  );
  await expect(select).toHaveAccessibleName("Otto's command machine: The gateway's machine");
  // The save sends the revision the page showed.
  expect((await sent(page)).find((c) => c.type === "setCommandMachine")).toMatchObject({
    baseHash: "c1",
  });
  expect((await sent(page)).filter((c) => c.type === "readPlacement").length).toBeGreaterThan(1);
  // Back returns to the row that opened the page, which reads the new value.
  await page.getByRole("button", { name: "Back to settings" }).click();
  await expect(page.getByRole("button", { name: /^Where Otto runs: / })).toBeFocused();
  await expect(page.getByTestId("runs-on-value")).toHaveText(
    "Command setting: the gateway's machine",
  );
});

test("F-046: a save the gateway hasn't applied is said as saved, not applied, and one it couldn't apply in its words", async ({
  page,
}) => {
  await openFixture(page, `${PANE}&access=admin&mwrite=pending`, "light");
  await openRunsOn(page);
  await page.getByTestId("runs-on-machine").click();
  await page.getByRole("menuitemradio", { name: "The gateway's machine" }).click();
  await expect(announcer(page)).toHaveText(
    "Saved. The gateway doesn't report it applied yet. Otto's command machine setting: the gateway's machine",
  );
  await expect(page.getByTestId("runs-on-not-applied")).toBeVisible();
  await openFixture(page, `${PANE}&access=admin&mwrite=notapplied`, "light");
  await openRunsOn(page);
  await page.getByTestId("runs-on-machine").click();
  await page.getByRole("menuitemradio", { name: "The gateway's machine" }).click();
  await expect(page.getByTestId("runs-on-error-line")).toHaveText(
    "Saved, but not applied. The gateway answered: config.patch persisted but was not applied to the active Gateway (failed)",
  );
  await expect(announcer(page)).toHaveText("Saved, not applied");
});

test("F-046: a stored host the app doesn't know is shown as stored and marked, never as another", async ({
  page,
}) => {
  await openFixture(page, `${PANE}&access=admin&machine=unsupported`, "light");
  await expect(page.getByTestId("runs-on-value")).toHaveText(
    "Command setting: “cluster” (not supported here)",
  );
  await openRunsOn(page);
  await expect(page.getByTestId("runs-on-machine")).toHaveAccessibleName(
    "Otto's command machine: “cluster” · Not supported here",
  );
  await expect(page.getByTestId("runs-on-unsupported")).toBeVisible();
});

test("F-046: switching bots never draws the previous bot's place while the new one is read", async ({
  page,
}) => {
  await openFixture(page, `${PANE}&access=admin&mslow=pip`, "light");
  await expect(page.getByTestId("runs-on-value")).toHaveText("Command setting: media-box");
  await page
    .getByTestId("bot-list")
    .getByRole("button", { name: /^Pip\b/ })
    .click();
  await page.getByRole("tab", { name: "Settings" }).click();
  await expect(page.getByRole("button", { name: /^Where Pip runs: / })).toBeVisible();
  await expect(page.getByTestId("runs-on-value")).toHaveText("Reading…");
});

test("F-046: the Runs on row is drawn from its own read while the account read has failed", async ({
  page,
}) => {
  await openFixture(page, `${PANE}&access=admin&accounts=error`, "light");
  await expect(page.getByText("Couldn't load Otto's settings")).toBeVisible();
  await expect(page.getByTestId("runs-on-value")).toHaveText("Command setting: media-box");
  await openRunsOn(page);
  await expect(page.getByTestId("runs-on-machine")).toHaveAccessibleName(
    "Otto's command machine: media-box · Connected",
  );
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
    "Otto's command machine: media-box · Connected",
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
  await expect(page.getByTestId("inventory-servers")).toContainText(
    "t3code (Otto's deny list: t3code__*)",
  );
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

test("F-274: a path is sent as typed for the gateway to judge, beside the bot's folder as it is now", async ({
  page,
}) => {
  await openFixture(page, `${PANE}&access=admin&machine=gatewayhost`, "light");
  await openRunsOn(page);
  // Nothing stored: the Commands group says "Not set" and draws no set mark.
  await expect(page.getByTestId("runs-on-machine")).toHaveAccessibleName(
    "Otto's command machine: Not set",
  );
  await expect(page.getByTestId("runs-on-page")).not.toContainText("Set on the gateway");
  await page.getByRole("button", { name: "Change…" }).click();
  const field = page.getByRole("textbox", { name: /path on the gateway's machine/ });
  await expect(field).toBeFocused();
  await expect(page.locator('label[for="m-workspace"]')).toContainText(
    "Now: /srv/clawtrate/workspaces/otto",
  );
  await field.fill("");
  await page.getByRole("button", { name: "Save folder" }).click();
  await expect(field).toHaveAttribute("aria-invalid", "true");
  expect((await sent(page)).some((c) => c.type === "setBotWorkspace")).toBe(false);
  await field.fill("C:\\Workspaces\\Otto");
  await page.getByRole("button", { name: "Save folder" }).click();
  await expect(announcer(page)).toHaveText("Saved. Otto's workspace: C:\\Workspaces\\Otto");
  expect((await sent(page)).filter((c) => c.type === "setBotWorkspace")).toEqual([
    { type: "setBotWorkspace", botId: "otto", path: "C:\\Workspaces\\Otto" },
  ]);
  await expect(page.getByTestId("runs-on-workspace")).toContainText("C:\\Workspaces\\Otto");
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
  // The file's settings, and no outcome of a command worked out from them.
  await expect(page.getByTestId("machines")).not.toContainText("Effective");
  await expect(page.getByTestId("machines")).not.toContainText("Every command asks");
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

test("F-157: device access is asked for by name only; with it alone, only this device's own name changes", async ({
  page,
}) => {
  await openFixture(page, `${PANE}&access=write&devices=noscope&pairing=grant`, "light");
  await openMachines(page);
  await expect(page.getByTestId("devices-unavailable")).toHaveText(
    "Seeing paired devices needs device access.",
  );
  // One explanation: the bar asks, the section says why.
  await expect(page.getByTestId("device-bar")).not.toContainText("needs device access");
  await page.getByTestId("device-bar").getByRole("button", { name: "Request access" }).click();
  expect((await sent(page)).filter((c) => c.type === "requestAccess")).toEqual([
    { type: "requestAccess", tier: "pairing" },
  ]);
  const list = page.getByTestId("device-list");
  await expect(list).toBeVisible();
  await expect(list.locator("dt").first()).toHaveText("This device");
  // The gateway lets a device token below admin change only its own record.
  await expect(list.getByRole("button", { name: "Rename" })).toHaveCount(1);
  await expect(list.getByRole("button", { name: "Remove" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(0);
  await expect(
    page.getByTestId("machine-list").getByRole("button", { name: "Rename" }),
  ).toHaveCount(0);
  await list.getByRole("button", { name: "Rename" }).click();
  await page.getByRole("textbox", { name: /New name for Clawtrate on this Mac/ }).fill("Desk");
  await page.keyboard.press("Enter");
  await expect(settingsAnnouncer(page)).toHaveText("Renamed");
  await expect(list).toContainText("Desk");
  // A paired client's last-seen reason, as the gateway gives it.
  await expect(list).toContainText(/Last seen .+ \(connect\)/);
});

test("F-157: with admin, another device is renamed and a machine removed after a confirmation that promises nothing more", async ({
  page,
}) => {
  await openFixture(page, `${PANE}&access=admin`, "light");
  await openMachines(page);
  const list = page.getByTestId("device-list");
  await list.getByRole("button", { name: "Rename" }).nth(1).click();
  await page.getByRole("textbox", { name: /New name for Clawtrate on iPhone/ }).fill("Phone");
  await page.keyboard.press("Enter");
  await expect(settingsAnnouncer(page)).toHaveText("Renamed");
  await expect(list).toContainText("Phone");
  // Connected or not, as the gateway allows.
  await expect(page.getByRole("button", { name: "Remove media-box…" })).toBeVisible();
  await page.getByRole("button", { name: "Remove studio-mac…" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("Asks the gateway to remove studio-mac's pairing.");
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("button", { name: "Remove" }).click();
  await expect(settingsAnnouncer(page)).toHaveText("Removed");
  await expect(page.getByTestId("machine-list")).not.toContainText("studio-mac");
});
