// How a bot's check-ins behave in the fixture (docs/design/automation.md
// section 13): the dialog's choices and what each save sends, the default
// bot's note, what Off does not stop, the admin guard on every way in, and a
// save's outcome kept with its own draft. The gateway's side of the same rows
// is checked in e2e/check-ins.spec.ts.
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, SIZES } from "./fixture.ts";
import { checkIns } from "./check-ins-helpers.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const ADMIN = `scene=main&${OTTO_DISK}&access=admin`;

test.use(contextFor(WIDE, "light"));

const sent = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { clawtrateFixture: { sent: Array<Record<string, unknown>> } }
    ).clawtrateFixture.sent.map((each) => ({ ...each })),
  );
const saves = async (page: Page) =>
  (await sent(page))
    .filter((each) => each.type === "saveCheckIn")
    .map(({ botId, every, prompt }) => ({ botId, every, prompt }));
const block = (page: Page, bot: string) =>
  page.locator(`[data-testid="check-in"][data-bot="${bot}"]`);
const dialog = (page: Page, name: string) =>
  page.getByRole("dialog", { name: `${name}'s check-ins` });
const change = (page: Page, run: string) =>
  page.evaluate((body) => {
    const fixture = (
      window as unknown as {
        clawtrateFixture: { setState: (change: (state: unknown) => unknown) => void };
      }
    ).clawtrateFixture;
    fixture.setState(new Function("state", body) as (state: unknown) => unknown);
  }, run);

test("F-201: Daily for one bot keeps the default bot checking in, by writing it in the same save, and says so first", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await checkIns(page);
  await expect(block(page, "main")).toContainText("Checks in every 30 minutes");
  await expect(block(page, "marlow")).toContainText("No check-ins");
  await page.getByRole("button", { name: "Change Marlow's check-ins" }).click();
  const marlow = dialog(page, "Marlow");
  await expect(marlow.getByRole("radio")).toHaveText([
    /^Off/,
    /^Daily/,
    /^As needed.*stay quiet when nothing does\.$/,
    /^Every…/,
  ]);
  await expect(marlow.getByRole("radio", { name: /^Off/ })).toHaveAttribute("aria-checked", "true");
  await expect(marlow.getByRole("radio", { name: /^Off/ })).toBeFocused();
  // One tab stop; arrows move and choose.
  await page.keyboard.press("ArrowDown");
  await expect(marlow.getByRole("radio", { name: /^Daily/ })).toBeFocused();
  await expect(marlow.getByRole("radio", { name: /^Daily/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(marlow.getByTestId("catch-note")).toContainText(
    "Juniper checks in now through the gateway's default.",
  );
  await marlow.getByRole("button", { name: "Save", exact: true }).click();
  await expect(marlow).toHaveCount(0);
  expect(await saves(page)).toEqual([{ botId: "marlow", every: "24h", prompt: null }]);
  await expect(page.getByTestId("b-announcer")).toHaveText("Check-ins saved");
  await expect(block(page, "marlow")).toContainText("Checks in daily");
  await expect(block(page, "marlow")).toContainText("Once a day, Marlow looks for anything");
  await expect(block(page, "main")).toContainText("Checks in every 30 minutes");
});

test("F-201: Every… writes the cadence chosen, and a prompt is written only when it was edited", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await checkIns(page);
  await page.getByRole("button", { name: "Change Pip's check-ins" }).click();
  const pip = dialog(page, "Pip");
  await pip.getByRole("radio", { name: /^Every…/ }).click();
  await pip.getByTestId("ci-every").click();
  await page.getByRole("menuitemradio", { name: "4 hours" }).click();
  await pip.getByText("What to check").click();
  await pip.getByRole("textbox", { name: "Prompt" }).fill("Look at the calendar for tomorrow.");
  await expect(pip.getByTestId("prompt-note")).toContainText("may post a message");
  await pip
    .getByRole("textbox", { name: "Prompt" })
    .fill("Look at the calendar. If nothing needs attention, reply NO_REPLY.");
  await expect(pip.getByTestId("prompt-note")).toHaveCount(0);
  await pip.getByRole("button", { name: "Save", exact: true }).click();
  await expect(pip).toHaveCount(0);
  expect(await saves(page)).toEqual([
    {
      botId: "pip",
      every: "4h",
      prompt: "Look at the calendar. If nothing needs attention, reply NO_REPLY.",
    },
  ]);
  await expect(block(page, "pip")).toContainText("Checks in every 4 hours");
});

test("F-366: Off says what it does not stop, writes every 0m, and the bot then has no scheduled check-ins", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await checkIns(page);
  await page.getByRole("button", { name: "Change Juniper's check-ins" }).click();
  const juniper = dialog(page, "Juniper");
  await expect(juniper.getByRole("radio", { name: /^As needed/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(juniper.getByTestId("catch-self")).toBeVisible();
  await juniper.getByRole("radio", { name: /^Off/ }).click();
  await expect(juniper.getByTestId("off-note")).toHaveText(
    "Juniper still reports when a command it started in the background finishes: the gateway starts that turn, not the schedule.",
  );
  await juniper.getByRole("button", { name: "Save", exact: true }).click();
  await expect(juniper).toHaveCount(0);
  expect(await saves(page)).toEqual([{ botId: "main", every: "0m", prompt: null }]);
  await expect(block(page, "main")).toContainText("No check-ins");
  await expect(block(page, "main")).toContainText("Juniper doesn't check in on a schedule.");
  await expect(block(page, "main")).not.toContainText("Next check-in");
});

test("F-201: below admin nothing can change check-ins, on any way in, and admin is asked for only by the bar's button", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}&access=read`, "light");
  await checkIns(page);
  await expect(page.getByRole("button", { name: /^Change .*'s check-ins$/ })).toHaveCount(0);
  await expect(page.getByTestId("admin-bar")).toContainText(
    "Read-only. Changing check-ins needs admin access.",
  );
  expect((await sent(page)).map((each) => each.type)).not.toContain("requestAccess");
  await page.getByRole("button", { name: "Request admin access" }).click();
  expect((await sent(page)).filter((each) => each.type === "requestAccess")).toEqual([
    { type: "requestAccess", tier: "admin" },
  ]);
  await expect(page.getByTestId("check-ins-dialog")).toHaveCount(0);
});

test("F-201: the dialog closes when admin access goes, and its controls never act without it", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await checkIns(page);
  await page.getByRole("button", { name: "Change Marlow's check-ins" }).click();
  await expect(dialog(page, "Marlow")).toBeVisible();
  await change(page, "return { ...state, connection: { ...state.connection, canAdmin: false } };");
  await expect(page.getByTestId("check-ins-dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Change .*'s check-ins$/ })).toHaveCount(0);
  expect(await saves(page)).toEqual([]);
});

test("F-201: a save that could not be confirmed says so in its own dialog only, and is not shown as saved", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&cisave=unknown`, "light");
  await checkIns(page);
  await page.getByRole("button", { name: "Change Marlow's check-ins" }).click();
  const marlow = dialog(page, "Marlow");
  await marlow.getByRole("radio", { name: /^Daily/ }).click();
  await marlow.getByRole("button", { name: "Save", exact: true }).click();
  await expect(marlow.getByTestId("save-unknown")).toContainText("Not confirmed.");
  await expect(page.getByTestId("b-announcer")).not.toHaveText("Check-ins saved");
  await expect(block(page, "marlow")).toContainText("No check-ins");
  await marlow.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Change Marlow's check-ins" }).click();
  await expect(dialog(page, "Marlow").getByTestId("save-unknown")).toHaveCount(0);
});
