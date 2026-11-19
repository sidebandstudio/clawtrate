// Usage and warning budgets in the fixture (docs/design/controls.md, sections
// 16 to 19): the states a development gateway cannot reach, proved here on
// made-up figures, and how the pages behave for the keyboard, a screen reader
// and a read-only connection. The fixture answers the bridge's usage commands
// as the engine does (apps/desktop/src/fixture/usage.ts).
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, settle } from "./fixture.ts";

const PANE = `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=write`;
const PAGE = `${PANE}&uview=usage`;

test.use(contextFor({ name: "1440", width: 1440, height: 900 }, "light"));

const usage = (page: Page) => page.getByTestId("usage-page");

async function settingsUsageWaiting(page: Page) {
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Usage", exact: true }).click();
  return settings;
}

async function settingsUsage(page: Page) {
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Usage", exact: true }).click();
  await expect(settings.getByTestId("usage-all")).toBeVisible();
  return settings;
}

test("F-232: a period with a missing price shows the cost as Partial, never a computed or zero cost (fixture)", async ({
  page,
}) => {
  await openFixture(page, `${PAGE}&usage=partial`, "light");
  await expect(page.getByTestId("usage-cost")).toHaveText("About $3.29 · Partial");
  await expect(page.getByTestId("usage-cost-hint")).toHaveText(
    "The gateway's estimate from its configured prices, in US dollars, as of 5:39 PM. Partial: 2 usage records have no price configured.",
  );
});

test("F-232: cost unavailable is a state, not a zero, on the row and the page (fixture)", async ({
  page,
}) => {
  await openFixture(page, `${PANE}&usage=nocost`, "light");
  await expect(page.getByTestId("usage-row")).toContainText("cost unavailable");
  await expect(page.getByTestId("usage-row")).not.toContainText("$");
  await page.getByTestId("usage-row").click();
  await expect(page.getByTestId("usage-cost")).toHaveText("Unavailable");
  await expect(page.getByTestId("usage-cost-hint")).toHaveText(
    /^Cost unavailable: the gateway has no price configured for what was used, as of /,
  );
});

test("F-232: a figure still being counted says so, with its total marked so far (fixture)", async ({
  page,
}) => {
  await openFixture(page, `${PAGE}&usage=computing`, "light");
  await expect(page.getByTestId("usage-source")).toContainText(
    "Some of the gateway's records are still being counted.",
  );
  await expect(page.getByTestId("usage-total")).toHaveText("1,640,000 tokens so far");
  await expect(page.getByTestId("usage-tasks")).toContainText("Still being counted");
  // The cost and the budget's count carry the same state, never a settled estimate.
  await expect(page.getByTestId("usage-cost")).toHaveText("About $3.29 so far");
  await expect(page.getByTestId("budget-meter")).toContainText("tokens this week so far");
  const settings = await settingsUsage(page);
  await expect(settings.getByTestId("usage-all-total")).toContainText(
    "tokens so far · about $11.05 so far, still being counted",
  );
});

test("F-233: the context of the open task is the gateway's figure, and what fills it reads as unavailable", async ({
  page,
}) => {
  await openFixture(page, PAGE, "light");
  await expect(page.getByTestId("usage-context")).toContainText(
    "'Disk almost full on the media box'",
  );
  await expect(page.getByTestId("usage-context")).toContainText("of 128,000 tokens");
  await expect(usage(page)).toContainText(
    "Breakdown unavailable: what fills it isn't reported. The gateway counts input, output and cache, not history, memory or tools apart.",
  );
});

test("S16 the budget comes first, and it and the figures each name their own period and time zone", async ({
  page,
}) => {
  await openFixture(page, PAGE, "light");
  const groups = await usage(page).locator(".b-group").allTextContents();
  expect(groups.indexOf("Budget")).toBeLessThan(groups.indexOf("Usage"));
  await expect(page.getByTestId("budget-window")).toContainText(
    /^Counts the total the gateway reports this week \([A-Z][a-z]{2} \d{1,2}( to [A-Z][a-z]{2} \d{1,2})?, your time\)/,
  );
  await expect(usage(page)).not.toContainText("same figure");
  // Today's figures beside a weekly budget: each says which days it is.
  await usage(page).getByRole("radio", { name: "Today" }).click();
  await expect(page.getByTestId("usage-source")).toContainText(
    /^From the gateway's usage records for Otto today \([A-Z][a-z]{2} \d{1,2}, your time\), as of /,
  );
  await expect(page.getByTestId("budget-window")).toContainText("this week");
  await usage(page).getByRole("radio", { name: "This week" }).click();
  await expect(page.getByTestId("budget-meter")).toContainText("1.64M of 2.5M tokens this week");
  await expect(page.getByTestId("usage-total")).toHaveText("1,640,000 tokens");
  await expect(page.getByTestId("budget-meter").getByRole("meter")).toHaveAccessibleName(
    "Otto's weekly budget: 1,640,000 of 2,500,000 tokens this week",
  );
});

test("S17 a budget is a warning everywhere, and says so", async ({ page }) => {
  await openFixture(page, `${PAGE}&budget=reached`, "light");
  await expect(page.getByTestId("shown-only").first()).toHaveText("Shown only");
  await expect(usage(page)).toContainText("nothing on the gateway stops Otto at the limit");
  await expect(page.getByTestId("budget-reached")).toHaveText(
    "Otto has reached its weekly warning budget. This is shown only: other apps, channels and Otto's routines aren't stopped.",
  );
  await expect(page.getByTestId("budget-reached-note")).toContainText(
    "Otto has reached its weekly warning budget. This is shown only",
  );
  const all = await page.locator("body").innerText();
  expect(all).not.toMatch(/won't send|didn't start|was stopped|held until|refused/i);
});

test("F-396: at 80 percent the meter warns with its numbers, and the task gets one line that agrees (fixture)", async ({
  page,
}) => {
  await openFixture(page, `${PAGE}&budget=warn`, "light");
  await expect(page.locator('.c-meter[data-tone="warn"] [role="meter"]')).toHaveCount(1);
  await expect(page.getByTestId("budget-meter")).toContainText("1.64M of 2M tokens this week");
  await expect(page.getByTestId("budget-warned")).toHaveText(
    "Otto has used 82% of its weekly budget.",
  );
  await expect(page.getByTestId("budget-line")).toHaveText(
    "Otto has used 82% of its weekly budget: 1.64M of 2M tokens.",
  );
  await expect(page.getByTestId("budget-reached-note")).toHaveCount(0);
});

test("S17 a Daily budget is labelled and counted daily", async ({ page }) => {
  await openFixture(page, `${PAGE}&budget=daily`, "light");
  await expect(page.getByTestId("budget-meter")).toContainText("295k of 400k tokens today");
  await expect(page.getByTestId("budget")).toContainText("Resets at 00:00, your time.");
  await page.getByTestId("budget-edit").click();
  await expect(
    page.getByTestId("budget-form").getByRole("radio", { name: "Daily" }),
  ).toHaveAttribute("aria-checked", "true");
});

test("S17 the budget form says what it takes, refuses what it can't keep, and saves only when right", async ({
  page,
}) => {
  await openFixture(page, `${PAGE}&budget=none`, "light");
  await expect(page.getByTestId("budget-none")).toContainText("No budget.");
  await page.getByTestId("budget-new").click();
  const field = page.getByTestId("budget-tokens");
  await expect(field).toBeFocused();
  await expect(page.getByTestId("budget-form")).toContainText("A whole number of 1,000 or more.");
  await expect(page.getByTestId("budget-save")).toBeDisabled();
  await field.fill("900");
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Enter a whole number of 1,000 or more.")).toBeVisible();
  await expect(page.getByTestId("budget-save")).toBeDisabled();
  await expect(field).toBeFocused();
  await field.fill("2,000,000");
  await expect(field).not.toHaveAttribute("aria-invalid", "true");
  await page.getByTestId("budget-save").click();
  await expect(page.getByTestId("work-announcer")).toHaveText("Budget saved");
  await expect(page.getByTestId("budget-meter")).toContainText("1.64M of 2M tokens this week");
  await expect(page.getByTestId("budget-line")).toBeVisible();
});

test("S17 Escape cancels the budget form, and the period choice is one radio group with one tab stop", async ({
  page,
}) => {
  await openFixture(page, PAGE, "light");
  await page.getByTestId("budget-edit").click();
  const form = page.getByTestId("budget-form");
  await expect(form.locator('[role="radio"][tabindex="0"]')).toHaveCount(1);
  await form.getByRole("radio", { name: "Weekly" }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(form.getByRole("radio", { name: "Daily" })).toHaveAttribute("aria-checked", "true");
  await expect(form.getByRole("radio", { name: "Daily" })).toBeFocused();
  await page.keyboard.press("End");
  await expect(form.getByRole("radio", { name: "Weekly" })).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("budget-tokens").focus();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("budget-form")).toHaveCount(0);
  await expect(page.getByTestId("budget-meter")).toBeVisible();
  // The period: Home and End go to the ends, and the figures follow.
  const period = usage(page).getByRole("radiogroup", { name: "Period" });
  await period.getByRole("radio", { name: "This week" }).focus();
  await page.keyboard.press("Home");
  await expect(period.getByRole("radio", { name: "Today" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByTestId("usage-total")).toHaveText("295,200 tokens");
});

test("S17 Raise budget above the composer opens the bot's budget form; Back returns to the Usage row", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}&access=write&budget=reached`, "light");
  await page.getByTestId("raise-from-composer").click();
  await expect(page.getByTestId("budget-form")).toBeVisible();
  await expect(page.getByTestId("budget-tokens")).toBeFocused();
  await page.getByTestId("budget-tokens").fill("3000000");
  await page.getByTestId("budget-save").click();
  await expect(page.getByTestId("budget-meter")).toContainText("1.64M of 3M tokens this week");
  await expect(page.getByTestId("budget-reached-note")).toHaveCount(0);
  await usage(page).getByRole("button", { name: "Back to settings" }).click();
  await expect(page.getByTestId("usage-row")).toBeFocused();
});

test("a read-only connection sees every figure and budget, and is offered no budget change", async ({
  page,
}) => {
  await openFixture(
    page,
    `scene=access-pinned&${OTTO_DISK}&panel=open&tab=settings&uview=usage&budget=reached`,
    "light",
  );
  await expect(page.getByTestId("budget-meter")).toBeVisible();
  await expect(page.getByTestId("usage-total")).toHaveText("1,640,000 tokens");
  await expect(page.getByTestId("budget-edit")).toHaveCount(0);
  await expect(page.getByTestId("budget-reached-note")).toContainText(
    "Otto has reached its weekly warning budget.",
  );
  await expect(page.getByTestId("raise-from-composer")).toHaveCount(0);
  const settings = await settingsUsage(page);
  await expect(settings.getByTestId("budgets")).toContainText(
    "Otto · weekly · 1.64M of 1.6M tokens this week",
  );
  await expect(settings.getByTestId("budget-add")).toHaveCount(0);
});

test("F-235: provider limits carry their window, reset, the gateway's time and no account (fixture)", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}&access=write`, "light");
  const settings = await settingsUsage(page);
  await expect(settings.getByTestId("limits")).toContainText(
    "OpenAI · Weekly · 62% used · resets Nov 17 · as of 5:38 PM",
  );
  await expect(settings.getByTestId("limits")).toContainText("xAI: no limits reported.");
  await expect(settings.getByTestId("limits")).toContainText(
    "The gateway doesn't say which of your accounts a limit is about",
  );
  await expect(
    settings.getByRole("meter", { name: "OpenAI's Weekly limit: 62% used, as of 5:38 PM" }),
  ).toHaveCount(1);
});

test("F-235: a gateway whose providers report no limits says so, with its time (fixture)", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}&access=write&usage=nolimits`, "light");
  const settings = await settingsUsage(page);
  await expect(settings.getByTestId("limits-none")).toHaveText(
    "No limits reported, as of 5:38 PM.",
  );
});

test("F-236: near a provider's limit the note names no account, closes, and at the limit says when it resets (fixture)", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}&access=write&plimit=near`, "light");
  const note = page.getByTestId("limit-note");
  await expect(note).toHaveText(
    "OpenAI reports 92% of a weekly limit used, as of 5:38 PM. It doesn't say which of your OpenAI accounts.",
  );
  await note.getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("limit-note")).toHaveCount(0);
  await openFixture(page, `scene=main&${OTTO_DISK}&access=write&plimit=reached`, "light");
  await expect(page.getByTestId("limit-note")).toHaveText(
    "OpenAI reports a weekly limit reached, as of 5:38 PM. It resets Nov 17.",
  );
  // A bot on another provider gets no note.
  await openFixture(page, `scene=main&bot=quartermaster&access=write&plimit=near`, "light");
  await expect(page.getByTestId("limit-note")).toHaveCount(0);
});

test("F-131 F-237: usage by source keeps Messages from other bots apart and charges nothing to one message (fixture)", async ({
  page,
}) => {
  await openFixture(page, PAGE, "light");
  const sources = page.getByTestId("usage-sources");
  await expect(
    sources.getByRole("listitem", { name: "Messages from other bots: 41,200 tokens" }),
  ).toHaveCount(1);
  await expect(
    sources.getByRole("listitem", { name: "Not attributed: 46,800 tokens" }),
  ).toHaveCount(1);
  await expect(usage(page)).toContainText("Messages from other bots: runs a send's result names.");
  await expect(usage(page)).toContainText("never charged to one message");
  const settings = await settingsUsage(page);
  await expect(
    settings.getByTestId("usage-bots").getByRole("listitem", { name: "Otto: 1,640,000 tokens" }),
  ).toHaveCount(1);
  await expect(settings.getByTestId("usage-sources")).toBeVisible();
});

test("F-237: a bot whose own figure couldn't be read is Unavailable on its bar and to a screen reader, never a zero (fixture)", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}&access=write&usage=botfail`, "light");
  const settings = await settingsUsage(page);
  const bots = settings.getByTestId("usage-bots");
  await expect(bots.getByRole("listitem", { name: "Otto: Unavailable" })).toHaveCount(1);
  await expect(bots.getByRole("listitem", { name: /^Otto: \d/ })).toHaveCount(0);
  await expect(bots.getByRole("listitem", { name: "Marlow: 562,000 tokens" })).toHaveCount(1);
});

test("F-234: while the host is busy reading other usage the page says it waits, never that it couldn't load (fixture)", async ({
  page,
}) => {
  await openFixture(page, `${PAGE}&usage=busy`, "light");
  await expect(page.getByTestId("usage-waiting")).toHaveText(
    "Waiting: Clawtrate is reading other usage from the gateway first, and asks again in a moment.",
  );
  await expect(page.getByTestId("usage-loading")).toBeVisible();
  await expect(page.getByTestId("usage-error")).toHaveCount(0);
  await expect(usage(page)).not.toContainText("Couldn't load");
  const settings = await settingsUsageWaiting(page);
  await expect(settings.getByTestId("usage-waiting")).toBeVisible();
  await expect(settings).not.toContainText("Couldn't load");
});

test("F-237: a period whose figures couldn't be read says so, and never shows another period's (fixture)", async ({
  page,
}) => {
  await openFixture(page, `${PAGE}&usage=periodfail`, "light");
  await expect(page.getByTestId("usage-total")).toHaveText("1,640,000 tokens");
  await usage(page).getByRole("radio", { name: "Today" }).click();
  await expect(page.getByTestId("usage-error")).toContainText("Couldn't load Otto's usage");
  await expect(page.getByTestId("usage-total")).toHaveCount(0);
  await expect(usage(page)).not.toContainText("1,640,000");
  // Back to This week: its own figures again.
  await usage(page).getByRole("radio", { name: "This week" }).click();
  await expect(page.getByTestId("usage-total")).toHaveText("1,640,000 tokens");
  // Settings: the same.
  const settings = await settingsUsage(page);
  await settings.getByRole("radio", { name: "Today" }).click();
  await expect(settings.getByTestId("usage-error")).toContainText("Couldn't load usage");
  await expect(settings.getByTestId("usage-all")).toHaveCount(0);
});

test("the Usage row's value wraps rather than shortening at phone width", async ({ browser }) => {
  const context = await browser.newContext(
    contextFor({ name: "phone", width: 390, height: 844, phone: true }, "light"),
  );
  const page = await context.newPage();
  await openFixture(page, `${PANE}&budget=warn`, "light");
  await settle(page);
  const value = page.getByTestId("usage-row").locator(".c-stack-value");
  await expect(value).toHaveText(
    "Budget 1.64M of 2M tokens this week · This week: 1,640,000 tokens · about $3.29, as of 5:39 PM",
  );
  const cut = await value.evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(cut).toBe(false);
  await context.close();
});
