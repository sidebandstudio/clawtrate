// How "Where a bot runs" and Settings, Machines behave (docs/design/controls.md
// sections 2, 14, 15 and 19) in the fixture: a save announced only once the
// engine's answer comes back, as saved and as applied only when it is, a
// refused save that changes nothing, a read never drawn for another bot, the
// defaults as one radio group with one tab stop, device access asked for by
// name, another record changed only with admin, the read-only connection, and
// Back returning to the row that opened it.
import { expect, test, type Page } from "@playwright/test";
import type { ClawtrateState } from "../packages/core/src/types.ts";
import { contextFor, hold, NOW, openFixture, OTTO_DISK, release, SIZES } from "./fixture.ts";

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
  // The workspace and browser lines claim nothing about the machine named for commands.
  await expect(page.getByTestId("runs-on-page")).not.toContainText("Not supported on this machine");
  await expect(
    page.getByText("This control sets the bot's workspace in the gateway's settings."),
  ).toBeVisible();
  await expect(page.getByTestId("runs-on-browser-choice")).toContainText(
    "Choosing or creating a browser profile isn't offered here.",
  );
  await select.click();
  await hold(page);
  await page.getByRole("menuitemradio", { name: "The gateway's machine" }).click();
  // Nothing is announced before the answer.
  await expect(announcer(page)).not.toHaveText(/Saved/);
  await release(page);
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

test("F-046: a save that completes after Back still brings the Runs on row up to date", async ({
  page,
}) => {
  await openFixture(page, `${PANE}&access=admin`, "light");
  await openRunsOn(page);
  await page.getByTestId("runs-on-machine").click();
  await hold(page);
  await page.getByRole("menuitemradio", { name: "The gateway's machine" }).click();
  // Back before the fixture answers.
  await page.getByRole("button", { name: "Back to settings" }).click();
  await release(page);
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
  await hold(page);
  await page.getByRole("menuitemradio", { name: "The gateway's machine" }).click();
  await release(page);
  await expect(announcer(page)).toHaveText(
    "Saved. The gateway doesn't report it applied yet. Otto's command machine setting: the gateway's machine",
  );
  await expect(page.getByTestId("runs-on-not-applied")).toBeVisible();
  await openFixture(page, `${PANE}&access=admin&mwrite=notapplied`, "light");
  await openRunsOn(page);
  await page.getByTestId("runs-on-machine").click();
  await hold(page);
  await page.getByRole("menuitemradio", { name: "The gateway's machine" }).click();
  await release(page);
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

type Fixture = {
  invoke: (command: { type: string }) => Promise<unknown>;
  getState: () => ClawtrateState;
  setState: (change: (state: ClawtrateState) => ClawtrateState) => void;
};
/** The connection again, with other scopes: a reconnect at another tier. */
const reconnect = (page: Page, admin: boolean) =>
  page.evaluate((admin) => {
    const fixture = (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture;
    fixture.setState((state) => ({
      ...state,
      connection: {
        ...state.connection,
        scopes: admin ? ["operator.read", "operator.admin"] : ["operator.read"],
        canAdmin: admin,
        canWrite: admin,
        connectedAt: (state.connection.connectedAt ?? 0) + 1,
      },
    }));
  }, admin);

test("F-274: a workspace form stays while its save is pending", async ({ page }) => {
  await openFixture(page, `${PANE}&access=admin&machine=gatewayhost`, "light");
  await openRunsOn(page);
  await page.getByRole("button", { name: "Change…" }).click();
  const field = page.getByRole("textbox", { name: /path on the gateway's machine/ });
  await field.fill("/srv/clawtrate/workspaces/otto-3");
  await hold(page);
  await page.getByRole("button", { name: "Save folder" }).click();
  // Neither Escape nor Cancel ends the form before the answer.
  await expect(page.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await field.press("Escape");
  await expect(field).toBeVisible();
  await release(page);
  await expect(announcer(page)).toHaveText(
    "Saved. Otto's workspace: /srv/clawtrate/workspaces/otto-3",
  );
});

test("F-157: a removal that completes after the connection's access changed leaves nothing behind", async ({
  page,
}) => {
  await openFixture(page, `${PANE}&access=admin`, "light");
  await openMachines(page);
  await page.evaluate(() => {
    const fixture = (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture;
    const original = fixture.invoke.bind(fixture);
    fixture.invoke = (command) =>
      command.type === "removeMachine"
        ? new Promise((_resolve, reject) => {
            (window as unknown as { finishRemove: () => void }).finishRemove = () =>
              reject(new Error("Details from the old admin connection"));
          })
        : original(command);
  });
  await page.getByRole("button", { name: "Remove media-box…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove", exact: true }).click();
  await reconnect(page, false);
  await expect(page.getByTestId("devices-unavailable")).toBeVisible();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { finishRemove: () => void }).finishRemove());
  await page.waitForTimeout(300);
  await expect(page.getByText("Details from the old admin connection")).toHaveCount(0);
});

test("F-274: after the connection's access changes, the workspace page shows no old form", async ({
  page,
}) => {
  await openFixture(page, `${PANE}&access=admin`, "light");
  await openRunsOn(page);
  await page.getByRole("button", { name: "Change…" }).click();
  await expect(page.getByRole("button", { name: "Save folder" })).toBeVisible();
  await reconnect(page, false);
  await expect(page.getByTestId("inventory-secrets")).toHaveText("Needs admin access");
  await expect(page.getByRole("button", { name: "Save folder" })).toHaveCount(0);
  await page.evaluate(() => {
    const fixture = (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture;
    const original = fixture.invoke.bind(fixture);
    fixture.invoke = async (command) => {
      const result = await original(command);
      return command.type === "readPlacement"
        ? { ...(result as object), workspace: "/workspace-of-other-gateway" }
        : result;
    };
  });
  await reconnect(page, true);
  await expect(page.getByTestId("runs-on-workspace")).toContainText("/workspace-of-other-gateway");
  await expect(page.getByRole("button", { name: "Change…" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /path on the gateway's machine/ })).toHaveCount(0);
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

test("F-046: a refused save says nothing was saved and what the gateway answered, and the setting shown stays as it was", async ({
  page,
}) => {
  await openFixture(page, `${PANE}&access=admin&mwrite=refused`, "light");
  await openRunsOn(page);
  await page.getByTestId("runs-on-machine").click();
  await hold(page);
  await page.getByRole("menuitemradio", { name: "The gateway's machine" }).click();
  await release(page);
  await expect(page.getByTestId("runs-on-error-line")).toHaveText(
    "Nothing was saved. The gateway answered: invalid config: agents.entries.otto.tools.exec.node",
  );
  await expect(announcer(page)).toHaveText("Couldn't save");
  await expect(page.getByTestId("runs-on-machine")).toHaveAccessibleName(
    "Otto's command machine: media-box · Connected",
  );
});

test("F-046: a save whose answer never came says it couldn't be confirmed and what reading it back shows, never saved", async ({
  page,
}) => {
  await openFixture(page, `${PANE}&access=admin&mwrite=unanswered`, "light");
  await openRunsOn(page);
  await page.getByTestId("runs-on-machine").click();
  await hold(page);
  await page.getByRole("menuitemradio", { name: "The gateway's machine" }).click();
  await release(page);
  await expect(page.getByTestId("runs-on-error-line")).toHaveText(
    "The save couldn't be confirmed: gateway request timed out after 30000ms: config.patch",
  );
  await expect(page.getByTestId("runs-on-save-note")).toHaveText(
    "Read back afterwards, Otto's command machine setting is the gateway's machine.",
  );
  await expect(announcer(page)).toHaveText("Save not confirmed");
  // The page reads again and shows the stored setting, still without saying it was saved.
  await expect(page.getByTestId("runs-on-machine")).toHaveAccessibleName(
    "Otto's command machine: The gateway's machine",
  );
  await expect(announcer(page)).toHaveText("Save not confirmed");
});

test("F-046: a save whose answer never came, on a gateway that can't read its settings file, says the setting couldn't be read, and still does once the page reads again", async ({
  page,
}) => {
  await openFixture(page, `${PANE}&access=admin&mwrite=unreadable`, "light");
  await openRunsOn(page);
  await page.getByTestId("runs-on-machine").click();
  await hold(page);
  await page.getByRole("menuitemradio", { name: "The gateway's machine" }).click();
  await release(page);
  // The read after the save fails too: the page says so, and the save's outcome stays with it.
  const failed = page.getByTestId("runs-on-error");
  await expect(failed.getByRole("heading")).toHaveText("Couldn't load where Otto runs");
  await expect(failed).toContainText(
    "The gateway reports that its settings file isn't valid, so it can't be read.",
  );
  await expect(page.getByTestId("runs-on-error-line")).toHaveText(
    "The save couldn't be confirmed: gateway request timed out after 30000ms: config.patch",
  );
  await expect(page.getByTestId("runs-on-save-note")).toHaveText(
    "The setting couldn't be read back either.",
  );
  await expect(page.getByTestId("runs-on-machine")).toHaveCount(0);
  await expect(announcer(page)).toHaveText("Save not confirmed");
  // The workspace's own read doesn't need the settings file, and still answers; the parts that
  // do say they couldn't be read.
  await expect(page.getByTestId("runs-on-workspace")).toHaveText("/srv/clawtrate/workspaces/otto");
  await expect(page.getByTestId("inventory-signins")).toHaveText(
    "Couldn't read: The gateway reports that its settings file isn't valid, so it can't be read.",
  );
  await reconnect(page, false);
  await expect(page.getByTestId("inventory-signins")).toHaveText("Needs admin access");
});

test("F-046 F-047: a plugin credential read that never answers leaves the rest of the page shown and usable, and the inventory says it is still reading", async ({
  page,
}) => {
  await openFixture(page, `${PANE}&access=admin&plugins=hang`, "light");
  await expect(page.getByTestId("runs-on-value")).toHaveText("Command setting: media-box");
  await openRunsOn(page);
  const select = page.getByTestId("runs-on-machine");
  await expect(select).toHaveAccessibleName("Otto's command machine: media-box · Connected");
  await expect(page.getByTestId("runs-on-workspace")).toHaveText("/srv/clawtrate/workspaces/otto");
  await expect(page.getByTestId("runs-on-browser")).toHaveText("Allow: not set · Deny: browser");
  await expect(page.getByTestId("inventory-secrets")).toHaveText(
    "Names in the gateway's secret store: router-admin, nas-backup, camera-feed",
  );
  const signins = page.getByTestId("inventory-signins");
  await expect(signins).toHaveText("Reading…");
  await expect(signins.locator('[aria-busy="true"]')).toHaveCount(1);
  // Meanwhile a save is answered and the page reads again, and the workspace form opens.
  await select.click();
  await hold(page);
  await page.getByRole("menuitemradio", { name: "The gateway's machine" }).click();
  await release(page);
  await expect(announcer(page)).toHaveText(
    "Saved and applied. Otto's command machine setting: the gateway's machine",
  );
  await expect(select).toHaveAccessibleName("Otto's command machine: The gateway's machine");
  await page.getByRole("button", { name: "Change…" }).click();
  await expect(page.getByRole("textbox", { name: /path on the gateway's machine/ })).toBeFocused();
  await expect(signins).toHaveText("Reading…");
  // Below admin nothing is inspected, so nothing hangs: the page says which access it needs.
  await reconnect(page, false);
  await expect(signins).toHaveText("Needs admin access");
});

/** Answers every `readPlacement` of `part` with `change` applied, from now on. */
const changePart = (page: Page, part: string, change: "fail-once" | "later") =>
  page.evaluate(
    ([part, change]) => {
      const fixture = (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture;
      const original = fixture.invoke.bind(fixture);
      let failures = 1;
      fixture.invoke = async (command) => {
        if (command.type !== "readPlacement" || (command as { part?: string }).part !== part)
          return original(command);
        if (change === "fail-once" && failures-- > 0)
          throw new Error("The gateway did not answer.");
        const result = (await original(command)) as { readAt: number };
        return change === "later" ? { ...result, readAt: result.readAt + 120_000 } : result;
      };
    },
    [part, change] as const,
  );

test("F-046 F-273: a browser read that fails says so and offers Try again once, and the other parts stay shown", async ({
  page,
}) => {
  await openFixture(page, `${PANE}&access=admin`, "light");
  await changePart(page, "browser", "fail-once");
  await openRunsOn(page);
  await expect(page.getByTestId("runs-on-browser")).toHaveText(
    "Couldn't read: The gateway did not answer.",
  );
  await expect(page.getByTestId("runs-on-machine")).toHaveAccessibleName(
    "Otto's command machine: media-box · Connected",
  );
  await expect(page.getByTestId("runs-on-workspace")).toHaveText("/srv/clawtrate/workspaces/otto");
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(1);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("runs-on-browser")).toHaveText("Allow: not set · Deny: browser");
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
});

test("F-046 F-047: parts read at different times say so", async ({ page }) => {
  await openFixture(page, `${PANE}&access=admin`, "light");
  await changePart(page, "credentials", "later");
  await openRunsOn(page);
  await expect(page.getByTestId("runs-on-read-at")).toContainText(
    /, read from \d{1,2}:\d{2}\s[AP]M to \d{1,2}:\d{2}\s[AP]M\./,
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

test("F-047: the inventory says only what the gateway listed: store names, and no plugin entries to inspect", async ({
  page,
}) => {
  await openFixture(page, `${PANE}&access=admin&plugins=none`, "light");
  await openRunsOn(page);
  await expect(page.getByTestId("inventory-secrets")).toHaveText(
    "Names in the gateway's secret store: router-admin, nas-backup, camera-feed",
  );
  await expect(page.getByTestId("runs-on-inventory")).not.toContainText("shared by every bot");
  await expect(page.getByTestId("inventory-signins")).toHaveText(
    "No plugin entries to inspect in the gateway's settings",
  );
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
  await expect(group).toHaveAccessibleName("File defaults");
  // The `*` entry is counted as what it is: another entry of the file.
  await expect(file).toContainText("Other file entries: 1.");
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

test("F-156: a second choice waits until the file the first one wrote is shown", async ({
  page,
}) => {
  await openFixture(page, `${PANE}&access=admin`, "light");
  await openMachines(page);
  const group = page
    .locator('[data-testid="approvals-file"][data-machine="media-box"]')
    .getByRole("radiogroup");
  await group.getByRole("radio", { checked: true }).focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowDown");
  await expect(settingsAnnouncer(page)).toHaveText("Saved. media-box: Ask every time");
  await expect(group.getByRole("radio", { checked: true })).toHaveAccessibleName("Ask every time");
  expect((await sent(page)).filter((c) => c.type === "setMachineDefaults")).toHaveLength(1);
  await expect(page.getByTestId("approvals-error")).toHaveCount(0);
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
  await hold(page);
  await page.getByTestId("device-bar").getByRole("button", { name: "Request access" }).click();
  expect((await sent(page)).filter((c) => c.type === "requestAccess")).toEqual([
    { type: "requestAccess", tier: "pairing" },
  ]);
  await release(page);
  const list = page.getByTestId("device-list");
  await expect(list).toBeVisible();
  await expect(list.locator("dt").first()).toHaveText("This device");
  // Below admin the gateway lists only this device, and the page says so.
  await expect(list.locator("dt")).toHaveCount(1);
  await expect(page.getByTestId("devices-own-only")).toHaveText(
    "Without admin access, the gateway lists only this device.",
  );
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
});

test("F-157: a paired-device list cut to its bound says how many it leaves out", async ({
  page,
}) => {
  await openFixture(page, `${PANE}&access=admin`, "light");
  await page.evaluate(() => {
    const fixture = (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture;
    const original = fixture.invoke.bind(fixture);
    fixture.invoke = async (command) => {
      const result = await original(command);
      return command.type === "readMachines"
        ? { ...(result as object), devicesOmitted: 3 }
        : result;
    };
  });
  await openMachines(page);
  await expect(page.getByTestId("devices-omitted")).toHaveText(
    "3 more paired devices aren't listed.",
  );
});

test("F-157: a rename that completes after its form was cancelled leaves another form open", async ({
  page,
}) => {
  await openFixture(page, `${PANE}&access=admin`, "light");
  await openMachines(page);
  await page.evaluate(() => {
    const fixture = (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture;
    const original = fixture.invoke.bind(fixture);
    fixture.invoke = (command) =>
      command.type === "renameDevice"
        ? new Promise((resolve) => {
            (window as unknown as { finishRename: () => void }).finishRename = () =>
              resolve(undefined);
          })
        : original(command);
  });
  const list = page.getByTestId("device-list");
  await list.getByRole("button", { name: "Rename" }).nth(1).click();
  await page.getByRole("textbox", { name: /New name for Clawtrate on iPhone/ }).fill("Phone");
  await page.keyboard.press("Enter");
  await list.getByRole("button", { name: "Cancel" }).click();
  await list.getByRole("button", { name: "Rename" }).first().click();
  const other = page.getByRole("textbox", { name: /New name for Clawtrate on this Mac/ });
  await other.fill("Desk");
  await page.evaluate(() => (window as unknown as { finishRename: () => void }).finishRename());
  await expect(settingsAnnouncer(page)).toHaveText("Renamed");
  await expect(other).toHaveValue("Desk");
});

test("F-157: with admin, another device is renamed and a machine removed after a confirmation that promises nothing more", async ({
  page,
}) => {
  await openFixture(page, `${PANE}&access=admin`, "light");
  // media-box as the gateway can list a machine that is connected but not paired.
  await page.evaluate(() => {
    const fixture = (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture;
    const original = fixture.invoke.bind(fixture);
    fixture.invoke = async (command) => {
      const result = await original(command);
      if (command.type !== "readMachines") return result;
      const view = result as { machines: Array<{ name: string; node: object | null }> };
      return {
        ...view,
        machines: view.machines.map((row) =>
          row.name === "media-box" ? { ...row, node: { ...row.node, paired: false } } : row,
        ),
      };
    };
  });
  await openMachines(page);
  // The gateway removes only a paired record: no Remove for the unpaired one.
  await expect(page.getByRole("button", { name: "Remove media-box…" })).toHaveCount(0);
  const list = page.getByTestId("device-list");
  // A paired client's last-seen reason, as the gateway gives it.
  await expect(list).toContainText(/Last seen .+ \(connect\)/);
  await expect(page.getByTestId("devices-own-only")).toHaveCount(0);
  await list.getByRole("button", { name: "Rename" }).nth(1).click();
  await page.getByRole("textbox", { name: /New name for Clawtrate on iPhone/ }).fill("Phone");
  await page.keyboard.press("Enter");
  await expect(settingsAnnouncer(page)).toHaveText("Renamed");
  await expect(list).toContainText("Phone");
  await page.getByRole("button", { name: "Remove studio-mac…" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("Asks the gateway to remove studio-mac's pairing.");
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("button", { name: "Remove" }).click();
  await expect(settingsAnnouncer(page)).toHaveText("Removed");
  await expect(page.getByTestId("machine-list")).not.toContainText("studio-mac");
});

const patchConnection = (page: Page, change: Partial<ClawtrateState["connection"]>) =>
  page.evaluate((change) => {
    const fixture = (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture;
    fixture.setState((state) => ({
      ...state,
      connection: { ...state.connection, ...change },
    }));
  }, change);

/**
 * On a read-only connection, asks for admin on the Runs on page and replays the client's order on
 * the grant. Returns the connection as it was before the grant.
 */
async function grantOnRunsOn(page: Page) {
  await page.clock.install({ time: NOW });
  await openFixture(page, `${PANE}&access=read`, "light");
  // Paused, so the granted bar cannot time out before the check reads it, however slow the page.
  await page.clock.pauseAt(new Date(NOW.getTime() + 60_000));
  await openRunsOn(page);
  const bar = page.getByTestId("admin-bar");
  await bar.getByRole("button", { name: "Request admin access" }).click();
  await expect(bar).toContainText("Asking the gateway");
  const connection = await page.evaluate(
    () =>
      (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture.getState().connection,
  );
  const { gatewayId, upgrade } = connection;
  // The approval, then the reconnect's hello with the admin scope while the gateway's id is
  // cleared and the connect time is fresh, then the identity read, each its own snapshot. The
  // connect time and the scopes both change, so the page is keyed anew.
  await patchConnection(page, { upgrade: { ...upgrade, status: "approved" } });
  await expect(bar).toContainText("Approved.");
  await patchConnection(page, {
    scopes: upgrade.scopes,
    canAdmin: true,
    canWrite: true,
    gatewayId: null,
    connectedAt: (connection.connectedAt ?? 0) + 1,
  });
  await patchConnection(page, { gatewayId });
  await expect(bar).toContainText("Admin access granted.");
  return connection;
}

test("F-046: the Runs on page says admin access was granted after an explicit admin request", async ({
  page,
}) => {
  await grantOnRunsOn(page);
});

test("F-046: admin taken away soon after the grant brings back the admin bar, not the granted one", async ({
  page,
}) => {
  const before = await grantOnRunsOn(page);
  await patchConnection(page, {
    scopes: before.scopes,
    canAdmin: false,
    canWrite: before.canWrite,
    connectedAt: (before.connectedAt ?? 0) + 2,
  });
  // The admin bar, with the request's own state, in place of the granted bar.
  const bar = page.getByTestId("admin-bar");
  await expect(bar).toHaveAttribute("data-status", "approved");
  await expect(bar).not.toContainText("Admin access granted.");
});

test("F-046: a connection lost soon after the grant no longer says admin access was granted", async ({
  page,
}) => {
  await grantOnRunsOn(page);
  await patchConnection(page, { status: "connecting" });
  await expect(page.getByTestId("runs-on-page")).not.toContainText("Admin access granted.");
  // Back on the same gateway with admin, the grant is not announced again.
  await patchConnection(page, { status: "connected" });
  await expect(page.getByTestId("runs-on-page")).not.toContainText("Admin access granted.");
});

test("F-046: after a save, the command picker waits for the read that brings the new revision", async ({
  page,
}) => {
  await openFixture(page, `${PANE}&access=admin`, "light");
  await openRunsOn(page);
  // Once the save has answered, the commands read is held until the test lets it go, or fails it.
  await page.evaluate(() => {
    const fixture = (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture;
    const original = fixture.invoke.bind(fixture);
    const held = window as unknown as { saved?: boolean; finishRead?: (fail: boolean) => void };
    fixture.invoke = (command) => {
      if (command.type === "setCommandMachine")
        return original(command).then((answer) => {
          held.saved = true;
          return answer;
        });
      if (
        held.saved &&
        command.type === "readPlacement" &&
        (command as { part?: string }).part === "commands"
      )
        return new Promise((resolve, reject) => {
          held.finishRead = (fail) =>
            fail ? reject(new Error("The gateway did not answer.")) : resolve(original(command));
        });
      return original(command);
    };
  });
  const select = page.getByTestId("runs-on-machine");
  await select.click();
  await page.getByRole("menuitemradio", { name: "The gateway's machine" }).click();
  await expect(announcer(page)).toHaveText(
    "Saved and applied. Otto's command machine setting: the gateway's machine",
  );
  // The page still shows the revision the save was made over: a second choice would be refused.
  await expect(select).toBeDisabled();
  await page.evaluate(() =>
    (window as unknown as { finishRead: (fail: boolean) => void }).finishRead(false),
  );
  await expect(select).toHaveAccessibleName("Otto's command machine: The gateway's machine");
  await expect(select).toBeEnabled();
  // A read after the save that fails offers Try again instead of the old revision's picker.
  await select.click();
  await page.getByRole("menuitemradio", { name: /^media-box/ }).click();
  await expect(announcer(page)).toHaveText(/^Saved and applied\. .*media-box$/);
  await page.evaluate(() =>
    (window as unknown as { finishRead: (fail: boolean) => void }).finishRead(true),
  );
  await expect(page.getByTestId("runs-on-error")).toContainText("The gateway did not answer.");
  await expect(
    page.getByTestId("runs-on-error").getByRole("button", { name: "Try again" }),
  ).toBeVisible();
});

test("F-156: one machine's pending save keeps its choices waiting while another machine's is saved", async ({
  page,
}) => {
  await openFixture(page, `${PANE}&access=admin`, "light");
  await openMachines(page);
  // media-box's write is held until the test lets it go.
  await page.evaluate(() => {
    const fixture = (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture;
    const original = fixture.invoke.bind(fixture);
    fixture.invoke = (command) =>
      command.type === "setMachineDefaults" &&
      (command as { machineId?: string }).machineId !== "gateway"
        ? new Promise((resolve) => {
            (window as unknown as { finishWrite: () => void }).finishWrite = () =>
              resolve(original(command));
          })
        : original(command);
  });
  const mediaGroup = page
    .locator('[data-testid="approvals-file"][data-machine="media-box"]')
    .getByRole("radiogroup");
  const gatewayGroup = page
    .locator('[data-testid="approvals-file"]:not([data-machine="media-box"])')
    .getByRole("radiogroup");
  await mediaGroup.getByRole("radio", { name: "Ask every time" }).click();
  await expect(mediaGroup.getByRole("radio", { name: "Ask every time" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await gatewayGroup.getByRole("radio", { name: "Ask every time" }).click();
  await expect(settingsAnnouncer(page)).toHaveText(/^Saved\. .*: Ask every time$/);
  await expect(gatewayGroup.getByRole("radio", { checked: true })).toHaveAccessibleName(
    "Ask every time",
  );
  // media-box's file is still the one its pending write was made over.
  await expect(mediaGroup.getByRole("radio", { name: "Ask every time" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.evaluate(() => (window as unknown as { finishWrite: () => void }).finishWrite());
  await expect(mediaGroup.getByRole("radio", { checked: true })).toHaveAccessibleName(
    "Ask every time",
  );
  await expect(mediaGroup.getByRole("radio", { name: "Ask every time" })).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

test("F-157: a removal that completes after its confirmation was cancelled leaves another confirmation open", async ({
  page,
}) => {
  await openFixture(page, `${PANE}&access=admin`, "light");
  await openMachines(page);
  await page.evaluate(() => {
    const fixture = (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture;
    const original = fixture.invoke.bind(fixture);
    fixture.invoke = (command) =>
      command.type === "removeMachine"
        ? new Promise((resolve) => {
            (window as unknown as { finishRemove: () => void }).finishRemove = () =>
              resolve(original(command));
          })
        : original(command);
  });
  await page.getByRole("button", { name: "Remove studio-mac…" }).click();
  const confirm = page.getByRole("alertdialog");
  await confirm.getByRole("button", { name: "Remove" }).click();
  await expect(confirm.getByRole("button", { name: "Remove…" })).toBeDisabled();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await page
    .getByTestId("device-list")
    .getByRole("button", { name: "Remove", exact: true })
    .first()
    .click();
  await expect(confirm).toContainText("Asks the gateway to remove");
  await expect(confirm).not.toContainText("studio-mac");
  // The other confirmation's removal isn't this one's.
  await expect(confirm.getByRole("button", { name: "Remove", exact: true })).toBeEnabled();
  await page.evaluate(() => (window as unknown as { finishRemove: () => void }).finishRemove());
  await expect(settingsAnnouncer(page)).toHaveText("Removed");
  await expect(page.getByTestId("machine-list")).not.toContainText("studio-mac");
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole("button", { name: "Remove", exact: true })).toBeEnabled();
});
