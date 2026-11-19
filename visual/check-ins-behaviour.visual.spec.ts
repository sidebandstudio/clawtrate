// How a bot's check-ins behave in the fixture (docs/design/automation.md
// section 13): the dialog's choices and the one command each save sends, the
// default bot's note, what Off does not stop, the admin guard on every way
// in, a draft kept across admin and a conflict and bound to its gateway's
// identity, a save's outcome kept with its own draft, and a check after an
// outcome that is not known. The fixture plans each save with the core's own
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
/** The prompt another client writes in the fixture's conflict. */
const THEIRS = "Theirs. If nothing needs attention, reply NO_REPLY.";
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
  await expect(pip.getByTestId("prompt-note")).toContainText("may answer every check-in");
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

test("F-201: the dialog closes when admin access goes, and no control to change check-ins is left", async ({
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
  // While it saves, Escape waits for the answer.
  const saving = marlow.getByRole("button", { name: "Saving…" });
  await expect(saving).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(saving).toBeVisible();
  await expect(marlow).toBeVisible();
  await expect(marlow.getByTestId("save-unknown")).toContainText("Not confirmed.");
  await expect(marlow.getByTestId("save-unknown")).toContainText("Check reads what it has now");
  await expect(page.getByTestId("b-announcer")).not.toHaveText("Check-ins saved");
  await expect(block(page, "marlow")).toContainText("No check-ins");
  // Check only reads; saving again stays the person's own act.
  const refreshes = async () =>
    (await sent(page)).filter((each) => each.type === "refreshCheckIns").length;
  const before = await refreshes();
  await marlow.getByRole("button", { name: "Check", exact: true }).click();
  await expect(marlow.getByTestId("save-checked")).toContainText("Checked.");
  expect(await refreshes()).toBe(before + 1);
  expect(await saves(page)).toHaveLength(1);
  await expect(marlow.getByRole("radio", { name: /^Daily/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
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
  expect(second).toMatchObject({
    every: "0m",
    prompt: "Mine. NO_REPLY",
    was: { every: "24h", prompt: THEIRS },
  });
  await expect(block(page, "main")).toContainText("No check-ins");
});

test("F-201: after a conflict on the cadence alone, saving again never sends the prompt the person left, and the dialog shows the gateway's", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&checkins=daily&cisave=conflict`, "light");
  await checkIns(page);
  await page.getByRole("button", { name: "Change Juniper's check-ins" }).click();
  const juniper = dialog(page, "Juniper");
  await juniper.getByRole("radio", { name: /^Off/ }).click();
  await juniper.getByRole("button", { name: "Save", exact: true }).click();
  await expect(juniper.getByTestId("save-conflict")).toContainText("Its cadence was changed.");
  await expect(juniper.getByRole("textbox", { name: "Prompt" })).toHaveValue(THEIRS);
  await juniper.getByRole("button", { name: "Save", exact: true }).click();
  await expect(juniper).toHaveCount(0);
  const [, second] = await saves(page);
  expect(second).toEqual({
    botId: "main",
    every: "0m",
    prompt: null,
    was: { every: "24h", prompt: THEIRS },
    kept: [],
  });
});

test("F-201: the bots a dialog named are what its save sends, though the list behind it changed", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await checkIns(page);
  await page.getByRole("button", { name: "Change Marlow's check-ins" }).click();
  const marlow = dialog(page, "Marlow");
  await expect(marlow.getByTestId("catch-note")).toContainText("Juniper checks in now");
  await change(
    page,
    "return { ...state, checkIns: { ...state.checkIns, defaults: { ...state.checkIns.defaults, inherited: ['main', 'otto'] } } };",
  );
  await expect(marlow.getByTestId("catch-note")).toContainText("Juniper checks in now");
  await marlow.getByRole("radio", { name: /^Daily/ }).click();
  await marlow.getByRole("button", { name: "Save", exact: true }).click();
  expect((await saves(page))[0]!.kept).toEqual([{ botId: "main", every: "30m" }]);
});

test("F-201: when the bots to keep are more than one change can write, the dialog says so before Save, and Save is off", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await checkIns(page);
  await change(
    page,
    "return { ...state, checkIns: { ...state.checkIns, defaults: { ...state.checkIns.defaults, inherited: Array.from({ length: 33 }, (_, i) => 'b' + i), inheritedCut: true } } };",
  );
  await page.getByRole("button", { name: "Change Marlow's check-ins" }).click();
  const marlow = dialog(page, "Marlow");
  await expect(marlow.getByTestId("catch-blocked")).toContainText("at most 32");
  await expect(marlow.getByTestId("save-conflict")).toHaveCount(0);
  await expect(marlow.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  expect(await saves(page)).toEqual([]);
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
  // Another gateway now answers at the same address: its identity is not the draft's.
  await change(
    page,
    "return { ...state, connection: { ...state.connection, gatewayId: 'another' }, checkIns: { ...state.checkIns, gatewayId: 'another' } };",
  );
  await expect(page.getByTestId("check-ins-dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Change Marlow's check-ins" }).click();
  // A new draft, from what this gateway has.
  await expect(dialog(page, "Marlow").getByRole("radio", { name: /^Off/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
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
  // The bots arrive after the connection does: their arrival reads again.
  await change(page, "return { ...state, bots: state.bots.slice(1) };");
  await expect.poll(refreshes).toBe(before + 3);
  // A read that failed keeps the way to read again.
  await change(
    page,
    "return { ...state, checkIns: { ...state.checkIns, status: 'error', error: 'timeout' } };",
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(refreshes).toBe(before + 4);
});

test("F-201: a cadence that is not whole minutes is shown exactly", async ({ page }) => {
  await openFixture(page, ADMIN, "light");
  await checkIns(page);
  await change(
    page,
    "return { ...state, checkIns: { ...state.checkIns, jobs: state.checkIns.jobs.map((job) => ({ ...job, everyMs: 90000 })) } };",
  );
  await expect(block(page, "main")).toContainText("Checks in every 90 seconds");
  await expect(block(page, "main")).toContainText("Every 90 seconds, Juniper looks");
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
  await expect(juniper.getByTestId("prompt-note")).toContainText("may answer every check-in");
});

test("F-201: As needed says the prompt asks for quiet only for the gateway's own prompt, not for a custom one that names NO_REPLY", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await checkIns(page);
  await page.getByRole("button", { name: "Change Pip's check-ins" }).click();
  const pip = dialog(page, "Pip");
  const asNeeded = pip.getByRole("radio", { name: /^As needed/ });
  await expect(asNeeded).toContainText("stay quiet");
  await pip.getByText("What to check").click();
  await pip.getByRole("textbox", { name: "Prompt" }).fill("Always answer; never reply NO_REPLY.");
  await expect(asNeeded).not.toContainText("quiet");
});
