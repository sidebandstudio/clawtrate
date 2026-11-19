// How a bot's check-ins behave in the fixture (docs/design/automation.md
// section 13): the dialog's choices and the one command each save sends, the
// default bot's note, what Off does not stop, the admin guard on every way
// in, a draft kept across admin and a conflict, and a save's outcome kept
// with its own draft. The fixture plans each save with the core's own
// planner; that one patch is written and confirmed is checked against the
// engine in packages/core/test/check-ins.test.ts, and against a gateway in
// e2e/check-ins.spec.ts.
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
    .map(({ botId, every, prompt, was, kept }) => ({ botId, every, prompt, was, kept }));
const NOTHING = { every: null, prompt: null };
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

test("F-201: Daily for one bot sends one save that names the default bot it keeps, and says so first", async ({
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
  expect(await saves(page)).toEqual([
    {
      botId: "marlow",
      every: "24h",
      prompt: null,
      was: NOTHING,
      kept: [{ botId: "main", every: "30m" }],
    },
  ]);
  await expect(page.getByTestId("b-announcer")).toHaveText("Check-ins saved");
  await expect(block(page, "marlow")).toContainText("Checks in daily");
  await expect(block(page, "marlow")).toContainText("Once a day, Marlow looks for anything");
  await expect(block(page, "main")).toContainText("Checks in every 30 minutes");
});

test("F-201: Every… sends the cadence chosen and the prompt that was edited, in one save", async ({
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
      was: NOTHING,
      kept: [{ botId: "main", every: "30m" }],
    },
  ]);
  await expect(block(page, "pip")).toContainText("Checks in every 4 hours");
});

test("F-366: Off says what it does not stop, sends every 0m, and the bot is then shown with no scheduled check-ins", async ({
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
    "Juniper still reports when a command it started in the background finishes: Off stops only the schedule, and the gateway starts that turn.",
  );
  await juniper.getByRole("button", { name: "Save", exact: true }).click();
  await expect(juniper).toHaveCount(0);
  expect(await saves(page)).toEqual([
    { botId: "main", every: "0m", prompt: null, was: NOTHING, kept: [] },
  ]);
  await expect(block(page, "main")).toContainText("No check-ins");
  await expect(block(page, "main")).toContainText("Juniper doesn't check in on a schedule.");
  await expect(block(page, "main")).toContainText(
    "It still reports when a command it started in the background finishes.",
  );
  await expect(block(page, "main")).not.toContainText("Next scheduled attempt");
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

test("F-201: As needed sends every 30m, and the bot is then shown checking in every 30 minutes", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await checkIns(page);
  await page.getByRole("button", { name: "Change Otto's check-ins" }).click();
  const otto = dialog(page, "Otto");
  await otto.getByRole("radio", { name: /^As needed/ }).click();
  await otto.getByRole("button", { name: "Save", exact: true }).click();
  await expect(otto).toHaveCount(0);
  expect(await saves(page)).toEqual([
    {
      botId: "otto",
      every: "30m",
      prompt: null,
      was: NOTHING,
      kept: [{ botId: "main", every: "30m" }],
    },
  ]);
  await expect(block(page, "otto")).toContainText("Checks in every 30 minutes");
  await expect(block(page, "main")).toContainText("Checks in every 30 minutes");
});

test("F-201: a prompt edited alone sends the prompt and no cadence", async ({ page }) => {
  await openFixture(page, `${ADMIN}&checkins=daily`, "light");
  await checkIns(page);
  await page.getByRole("button", { name: "Change Marlow's check-ins" }).click();
  const marlow = dialog(page, "Marlow");
  await marlow.getByText("What to check").click();
  await marlow.getByRole("textbox", { name: "Prompt" }).fill("Look at the news. Else NO_REPLY.");
  await marlow.getByRole("button", { name: "Save", exact: true }).click();
  await expect(marlow).toHaveCount(0);
  expect(await saves(page)).toEqual([
    {
      botId: "marlow",
      every: null,
      prompt: "Look at the news. Else NO_REPLY.",
      was: { every: "24h", prompt: null },
      kept: [],
    },
  ]);
  await expect(block(page, "marlow")).toContainText("Checks in daily");
});

test("F-201: a cadence changed elsewhere while the dialog is open is a conflict that keeps the draft, and saving again applies it", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&checkins=daily&cisave=conflict`, "light");
  await checkIns(page);
  await page.getByRole("button", { name: "Change Juniper's check-ins" }).click();
  const juniper = dialog(page, "Juniper");
  await juniper.getByRole("radio", { name: /^Off/ }).click();
  await juniper.getByText("What to check").click();
  await juniper.getByRole("textbox", { name: "Prompt" }).fill("Mine. NO_REPLY");
  await juniper.getByRole("button", { name: "Save", exact: true }).click();
  await expect(juniper.getByTestId("save-conflict")).toContainText("Its cadence was changed.");
  await expect(page.getByTestId("b-announcer")).not.toHaveText("Check-ins saved");
  await expect(block(page, "main")).toContainText("Checks in daily");
  await expect(juniper.getByRole("radio", { name: /^Off/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(juniper.getByRole("textbox", { name: "Prompt" })).toHaveValue("Mine. NO_REPLY");
  await juniper.getByRole("button", { name: "Save", exact: true }).click();
  await expect(juniper).toHaveCount(0);
  const [first, second] = await saves(page);
  expect(first!.was).toEqual({ every: "30m", prompt: null });
  expect(second).toMatchObject({ every: "0m", was: { every: "24h", prompt: null } });
  await expect(block(page, "main")).toContainText("No check-ins");
});

test("F-201: a draft survives admin going and coming back, and is not shown for another gateway", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await checkIns(page);
  await page.getByRole("button", { name: "Change Marlow's check-ins" }).click();
  const marlow = dialog(page, "Marlow");
  await marlow.getByRole("radio", { name: /^Daily/ }).click();
  await marlow.getByText("What to check").click();
  await marlow.getByRole("textbox", { name: "Prompt" }).fill("Kept. NO_REPLY");
  await change(page, "return { ...state, connection: { ...state.connection, canAdmin: false } };");
  await expect(marlow).toHaveCount(0);
  await change(page, "return { ...state, connection: { ...state.connection, canAdmin: true } };");
  await expect(marlow.getByRole("radio", { name: /^Daily/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(marlow.getByRole("textbox", { name: "Prompt" })).toHaveValue("Kept. NO_REPLY");
  await change(
    page,
    "return { ...state, connection: { ...state.connection, gatewayUrl: 'ws://another.invalid' } };",
  );
  await expect(page.getByTestId("check-ins-dialog")).toHaveCount(0);
  expect(await saves(page)).toEqual([]);
});

test("F-201: check-ins read while disconnected are read again when the connection comes back, and on Refresh", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await change(
    page,
    "const { checkIns, ...rest } = state; return { ...rest, connection: { ...state.connection, status: 'reconnecting' } };",
  );
  await page.keyboard.press("ControlOrMeta+,");
  await page
    .getByRole("dialog", { name: "Settings" })
    .getByRole("button", { name: "Check-ins", exact: true })
    .click();
  await expect(page.getByText("Reading check-ins…")).toBeVisible();
  const refreshes = async () =>
    (await sent(page)).filter((each) => each.type === "refreshCheckIns").length;
  const before = await refreshes();
  await change(
    page,
    "return { ...state, connection: { ...state.connection, status: 'connected' } };",
  );
  await expect(page.getByTestId("check-in")).toHaveCount(5);
  expect(await refreshes()).toBe(before + 1);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(refreshes).toBe(before + 2);
});

test("F-201: an inherited custom prompt is what an empty prompt means, and no words say the bot stays quiet", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&cidefault=prompt`, "light");
  await checkIns(page);
  await page.getByRole("button", { name: "Change Juniper's check-ins" }).click();
  const juniper = dialog(page, "Juniper");
  await expect(juniper.getByRole("radio", { name: /^As needed/ })).not.toContainText("stay quiet");
  await juniper.getByText("What to check").click();
  await expect(juniper.getByRole("textbox", { name: "Prompt" })).toHaveAttribute(
    "placeholder",
    "Look over my inbox and tell me what's new.",
  );
  await expect(juniper).toContainText("Empty uses the prompt set as the gateway's default");
  await expect(juniper.getByTestId("prompt-note")).toContainText("may post a message");
});
