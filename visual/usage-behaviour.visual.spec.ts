// Usage and warning budgets in the fixture (docs/design/controls.md, sections
// 16 to 19): the states a development gateway cannot reach, proved here on
// made-up figures, and how the pages behave for the keyboard, a screen reader
// and a read-only connection. The fixture answers the bridge's usage commands
// as the engine does (apps/desktop/src/fixture/usage.ts).
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, settle } from "./fixture.ts";
import { holdFrames, tabThenRelease } from "./frames.ts";

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

/** From now on, the fixture's host answers every usage report busy, or fails it. */
const answerReadsWith = (page: Page, answer: "busy" | "fail") =>
  page.evaluate((answer) => {
    const bridge = (
      window as unknown as {
        clawtrateFixture: { invoke(command: { type: string }): Promise<unknown> };
      }
    ).clawtrateFixture;
    const original = bridge.invoke.bind(bridge);
    bridge.invoke = (command) =>
      command.type !== "readUsage"
        ? original(command)
        : answer === "busy"
          ? Promise.resolve({ busy: true })
          : Promise.reject(new Error("usage.cost timed out after 60 seconds."));
  }, answer);

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
  // A figure read again for the same period, and the read failed: the row keeps its figure
  // and says the refresh failed.
  await openFixture(page, `${PANE}&usage=computing`, "light");
  await expect(page.getByTestId("usage-row")).toContainText("This week: 1,640,000 tokens so far");
  await answerReadsWith(page, "fail");
  await expect(page.getByTestId("usage-row")).toContainText(
    "This week: 1,640,000 tokens so far · about $3.29 so far, still being counted · Couldn't read it again",
    { timeout: 15_000 },
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
  await expect(page.getByTestId("usage-context")).toContainText(
    /tokens in the latest prompt, of the model's 128,000$/,
  );
  await expect(usage(page)).toContainText(
    "The latest prompt the gateway reported for this task, against the model's context window; a reply's output isn't part of it. Breakdown unavailable: what fills it, history, memory or tools, isn't reported.",
  );
});

test("S16 the budget comes first, and it and the figures each name their own period and time zone", async ({
  page,
}) => {
  await openFixture(page, PAGE, "light");
  const groups = await usage(page).locator(".b-group").allTextContents();
  expect(groups).toContain("Budget");
  expect(groups).toContain("Usage");
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
  await expect(page.getByTestId("budget-meter")).toContainText(
    "1,640,000 of 2,500,000 tokens this week",
  );
  await expect(page.getByTestId("usage-total")).toHaveText("1,640,000 tokens");
  await expect(page.getByTestId("budget-meter").getByRole("meter")).toHaveAccessibleName(
    "Otto's weekly budget: 1,640,000 of 2,500,000 tokens this week",
  );
});

test("S17 a budget is a warning everywhere, and says so", async ({ page }) => {
  await openFixture(page, `${PAGE}&budget=reached`, "light");
  await expect(page.getByTestId("shown-only").first()).toHaveText("Shown only");
  await expect(usage(page)).toContainText("nothing stops Otto at the limit");
  const reached =
    "Otto has reached its weekly warning budget. Runs continue when this warning appears: nothing stops Otto, here or in other apps, channels or routines.";
  await expect(page.getByTestId("budget-reached")).toHaveText(reached);
  await expect(page.getByTestId("budget-reached-note")).toContainText(reached);
  // Past 100 percent the meter is a warning's colour, not a stop's.
  await expect(page.getByTestId("budget-meter")).toHaveAttribute("data-tone", "warn");
  const all = await page.locator("body").innerText();
  expect(all).not.toMatch(/won't send|didn't start|was stopped|held until|refused/i);
});

test("F-396: at 80 percent the meter warns with its numbers, and the task gets one line that agrees (fixture)", async ({
  page,
}) => {
  await openFixture(page, `${PAGE}&budget=warn`, "light");
  await expect(page.locator('.c-meter[data-tone="warn"] [role="meter"]')).toHaveCount(1);
  await expect(page.getByTestId("budget-meter")).toContainText(
    "1,640,000 of 2,000,000 tokens this week",
  );
  await expect(page.getByTestId("budget-warned")).toHaveText(
    "Otto has used 82% of its weekly budget.",
  );
  await expect(page.getByTestId("budget-line")).toHaveText(
    "Otto has used 82% of its weekly budget: 1,640,000 of 2,000,000 tokens.",
  );
  await expect(page.getByTestId("budget-reached-note")).toHaveCount(0);
});

test("S17 a Daily budget is labelled and counted daily", async ({ page }) => {
  await openFixture(page, `${PAGE}&budget=daily`, "light");
  await expect(page.getByTestId("budget-meter")).toContainText("295,200 of 400,000 tokens today");
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
  await expect(page.getByTestId("budget-meter")).toContainText(
    "1,640,000 of 2,000,000 tokens this week",
  );
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
  await expect(page.getByTestId("budget-meter")).toContainText(
    "1,640,000 of 3,000,000 tokens this week",
  );
  await expect(page.getByTestId("budget-reached-note")).toHaveCount(0);
  await usage(page).getByRole("button", { name: "Back to settings" }).click();
  await expect(page.getByTestId("usage-row")).toBeFocused();
});

test("S17 each Raise budget above the composer opens the form, also after the form was cancelled", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}&access=write&budget=reached`, "light");
  await page.getByTestId("raise-from-composer").click();
  await expect(page.getByTestId("budget-form")).toBeVisible();
  await page.getByTestId("budget-form").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("budget-form")).toHaveCount(0);
  await page.getByTestId("raise-from-composer").click();
  await expect(page.getByTestId("budget-form")).toBeVisible();
  await expect(page.getByTestId("budget-tokens")).toBeFocused();
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
    "Otto · weekly · 1,640,000 of 1,600,000 tokens this week",
  );
  await expect(settings.getByTestId("budget-add")).toHaveCount(0);
});

test("S17 a saved budget's row in Settings opens its own form; Escape returns to the row", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}&access=write`, "light");
  const settings = await settingsUsage(page);
  const row = settings.locator('[data-budget="bot:otto"] button');
  await expect(row).toHaveAccessibleName(
    /^Otto · weekly · .* tokens this week · your time\. Shown only\. Change\.$/,
  );
  await row.click();
  const form = settings.getByTestId("budget-edit-form");
  await expect(form.getByTestId("budget-tokens")).toBeFocused();
  await expect(form.getByTestId("budget-tokens")).toHaveValue("2,500,000");
  await expect(form.getByRole("radio", { name: "Weekly" })).toHaveAttribute("aria-checked", "true");
  await expect(settings.getByTestId("budget-target")).toHaveCount(0);
  await expect(settings).not.toContainText("Add a budget");
  await page.keyboard.press("Escape");
  await expect(form).toHaveCount(0);
  await expect(row).toBeFocused();
  // The routine's row opens the routine's form.
  await settings.locator('[data-budget="routine:weekly-cleanup"] button').click();
  await expect(settings.getByTestId("budget-edit-form")).toContainText("routine Weekly cleanup");
  // Escape in Add a budget's target choice closes that form, not Settings, and returns to Add a budget.
  await page.keyboard.press("Escape");
  await settings.getByTestId("budget-add").click();
  await settings.getByTestId("budget-target").focus();
  await page.keyboard.press("Escape");
  await expect(settings).toBeVisible();
  await expect(settings.getByTestId("budget-add-form")).toHaveCount(0);
  await expect(settings.getByTestId("budget-add")).toBeFocused();
});

test("F-234: a saved routine budget whose routine now shares a task says its count is unavailable, can't be saved again, and can be removed (fixture)", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}&access=write&usage=retargeted`, "light");
  const settings = await settingsUsage(page);
  const row = settings.locator('[data-budget="routine:weekly-cleanup"]');
  await expect(row).toContainText(
    "Routine Weekly cleanup (Otto) · daily · 200,000 tokens today, count unavailable",
  );
  await row.getByRole("button").click();
  const form = settings.getByTestId("budget-edit-form");
  await form.getByTestId("budget-tokens").fill("300,000");
  await expect(form.getByTestId("budget-save")).toBeDisabled();
  await form.getByTestId("budget-remove").click();
  await expect(row).toHaveCount(0);
});

test("F-237: each settled bar names its own time, and each saved budget its own time zone (fixture)", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}&access=write&usage=ages`, "light");
  const settings = await settingsUsage(page);
  const bots = settings.getByTestId("usage-bots");
  await expect(
    bots.getByRole("listitem", { name: "Pip: 379,000 tokens, as of 4:39 PM" }),
  ).toHaveCount(1);
  await expect(
    bots.getByRole("listitem", { name: "Otto: 1,640,000 tokens, as of 5:39 PM" }),
  ).toHaveCount(1);
  await expect(settings.locator('[data-budget="routine:weekly-cleanup"]')).toContainText(
    "200,000 tokens today · Asia/Tokyo",
  );
  await expect(settings.locator('[data-budget="bot:otto"]')).toContainText(
    "2,500,000 tokens this week · your time",
  );
});

test("F-234: a failed read of the routines is said and can be tried again, never shown as no routines (fixture)", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}&access=write&usage=routinesfail`, "light");
  const settings = await settingsUsage(page);
  await settings.getByTestId("budget-add").click();
  const error = settings.getByTestId("routines-error");
  await expect(error).toContainText(
    "Couldn't read the routines: cron.list timed out after 60 seconds.",
  );
  await error.getByRole("button", { name: "Try again" }).click();
  await expect(
    settings.getByTestId("budget-target").locator("option", { hasText: "Weekly cleanup" }),
  ).toHaveCount(1);
  await expect(settings.getByTestId("routines-error")).toHaveCount(0);
});

test("S17 a save that ends after another budget's form was opened leaves that form open (fixture)", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}&access=write`, "light");
  const settings = await settingsUsage(page);
  // The host answers budget changes only when the test says.
  await page.evaluate(() => {
    const bridge = (
      window as unknown as {
        clawtrateFixture: { invoke(command: { type: string }): Promise<unknown> };
        releaseSave?: () => void;
      }
    ).clawtrateFixture;
    const original = bridge.invoke.bind(bridge);
    bridge.invoke = (command) =>
      command.type !== "changeBudget"
        ? original(command)
        : new Promise((resolve) => {
            (window as unknown as { releaseSave: () => void }).releaseSave = () =>
              resolve(original(command));
          });
  });
  await settings.locator('[data-budget="bot:otto"] button').click();
  await settings.getByTestId("budget-edit-form").getByTestId("budget-tokens").fill("3,000,000");
  await settings.getByTestId("budget-edit-form").getByTestId("budget-save").click();
  // Meanwhile, the routine's budget is opened.
  await settings.locator('[data-budget="routine:weekly-cleanup"] button').click();
  await expect(settings.getByTestId("budget-edit-form")).toContainText("routine Weekly cleanup");
  await page.evaluate(() => (window as unknown as { releaseSave: () => void }).releaseSave());
  await expect(settings.locator('[data-budget="bot:otto"]')).toContainText("3,000,000 tokens");
  await expect(settings.getByTestId("budget-edit-form")).toContainText("routine Weekly cleanup");
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
  // Closed at 100%, then the provider reports the next window, still at 100%: a new note.
  await page.getByTestId("limit-note").getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("limit-note")).toHaveCount(0);
  await page.evaluate(() =>
    (
      window as unknown as {
        clawtrateFixture: {
          setState(
            change: (state: {
              usage: {
                limits: { providers: Array<{ windows: Array<{ resetAt: number | null }> }> };
              };
            }) => unknown,
          ): void;
        };
      }
    ).clawtrateFixture.setState((state) => ({
      ...state,
      usage: {
        ...state.usage,
        limits: {
          ...state.usage.limits,
          providers: state.usage.limits.providers.map((provider) => ({
            ...provider,
            windows: provider.windows.map((window) => ({
              ...window,
              resetAt: window.resetAt === null ? null : window.resetAt + 7 * 86_400_000,
            })),
          })),
        },
      },
    })),
  );
  await expect(page.getByTestId("limit-note")).toHaveText(
    "OpenAI reports a weekly limit reached, as of 5:38 PM. It resets Nov 24.",
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
    settings
      .getByTestId("usage-bots")
      .getByRole("listitem", { name: "Otto: 1,640,000 tokens, as of 5:39 PM" }),
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
  await expect(
    bots.getByRole("listitem", { name: "Marlow: 562,000 tokens, as of 5:39 PM" }),
  ).toHaveCount(1);
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
  // A figure shown already, read again for the same period while the host is busy: the
  // figure stays, and the page says it waits.
  await openFixture(page, `${PAGE}&usage=computing`, "light");
  await expect(page.getByTestId("usage-total")).toHaveText("1,640,000 tokens so far");
  await answerReadsWith(page, "busy");
  await expect(page.getByTestId("usage-waiting")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("usage-total")).toHaveText("1,640,000 tokens so far");
});

/** The `readUsage` commands the page has sent the fixture's host so far. */
const usageReads = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as { clawtrateFixture: { sent: Array<{ type: string }> } }
      ).clawtrateFixture.sent.filter((each) => each.type === "readUsage").length,
  );

/** Say the window is hidden, or shown again, as the browser does. */
const setHidden = (page: Page, hidden: boolean) =>
  page.evaluate((hidden) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (hidden ? "hidden" : "visible"),
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);

test("F-234: a hidden window asks for no report at the date's rollover, and reads the new day once shown (fixture)", async ({
  browser,
}) => {
  const context = await browser.newContext({
    ...contextFor({ name: "1440", width: 1440, height: 900 }, "light"),
    timezoneId: "America/New_York",
  });
  const page = await context.newPage();
  // Two minutes before midnight, so the page's first report is for Nov 16 however long it loads;
  // then the clock is held just before midnight until the page is hidden.
  await page.clock.install({ time: new Date("2026-11-16T23:58:00-05:00") });
  await page.goto(`/?${PAGE}&theme=light`);
  await expect(page.getByTestId("usage-source")).toContainText("this week (Nov 16, your time)");
  await page.clock.pauseAt(new Date("2026-11-16T23:59:50-05:00"));
  await setHidden(page, true);
  const before = await usageReads(page);
  // Past midnight and the page's 30-second tick, while hidden.
  await page.clock.fastForward("01:00");
  expect(await usageReads(page)).toBe(before);
  await setHidden(page, false);
  await page.clock.resume();
  await expect.poll(() => usageReads(page)).toBeGreaterThan(before);
  await expect(page.getByTestId("usage-source")).toContainText(
    "this week (Nov 16 to Nov 17, your time)",
  );
  await context.close();
});

test("F-234: a Usage page kept out of view asks for no recount, and asks once shown again (fixture)", async ({
  page,
}) => {
  await openFixture(page, PAGE, "light");
  await expect(page.getByTestId("usage-total")).toBeVisible();
  const recounts = () =>
    page.evaluate(
      () =>
        (
          window as unknown as { clawtrateFixture: { sent: Array<{ type: string }> } }
        ).clawtrateFixture.sent.filter((each) => each.type === "refreshUsage").length,
    );
  // Details shown, then another bot and back: Otto's Settings tab, out of view, keeps its page.
  await page.getByRole("tab", { name: "Details" }).click();
  const before = await recounts();
  await page
    .getByTestId("bot-list")
    .getByRole("button", { name: /^Pip\b/ })
    .first()
    .click();
  await page
    .getByTestId("bot-list")
    .getByRole("button", { name: /^Otto\b/ })
    .first()
    .click();
  await page.getByRole("tab", { name: "Details" }).waitFor();
  expect(await recounts()).toBe(before);
  await page.getByRole("tab", { name: "Settings" }).click();
  await expect.poll(recounts).toBeGreaterThan(before);
});

test("F-237: through a switch of host, Settings drops the old gateway's figures and reads again once connected (fixture)", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}&access=write`, "light");
  const settings = await settingsUsage(page);
  await expect(settings.getByTestId("usage-all-total")).toContainText("Every bot:");
  const before = await usageReads(page);
  const setConnection = (change: Record<string, unknown>) =>
    page.evaluate(
      (change) =>
        (
          window as unknown as {
            clawtrateFixture: {
              setState(change: (state: { connection: object }) => unknown): void;
            };
          }
        ).clawtrateFixture.setState((state) => ({
          ...state,
          connection: { ...state.connection, ...change },
        })),
      change,
    );
  await setConnection({
    status: "connecting",
    gatewayUrl: "ws://127.0.0.1:19999",
    gatewayId: "another-gateway",
    connectedAt: null,
  });
  await expect(settings.getByTestId("usage-all")).toHaveCount(0);
  expect(await usageReads(page)).toBe(before);
  // The new host's report is held, then answered with its own total.
  await page.evaluate(() => {
    const bridge = (
      window as unknown as {
        clawtrateFixture: { invoke(command: { type: string }): Promise<unknown> };
      }
    ).clawtrateFixture;
    const original = bridge.invoke.bind(bridge);
    bridge.invoke = (command) => {
      if (command.type !== "readUsage") return original(command);
      // Asked of the host now, and answered only when the test says.
      const asked = original(command);
      return new Promise((resolve) => {
        (window as unknown as { releaseReport: () => void }).releaseReport = () =>
          void asked.then((report) => {
            const answer = report as { figure: { tokens: { total: number } } };
            answer.figure.tokens.total = 9_999;
            resolve(answer);
          });
      });
    };
  });
  await setConnection({ status: "connected", connectedAt: Date.now() + 1 });
  await expect.poll(() => usageReads(page)).toBeGreaterThan(before);
  // While the new host's report is read, the old gateway's total stays hidden.
  await expect(settings.getByTestId("usage-all")).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { releaseReport: () => void }).releaseReport());
  await expect(settings.getByTestId("usage-all-total")).toContainText("Every bot: 9,999 tokens");
});

test("F-237: a period whose figures couldn't be read says so, and never shows another period's (fixture)", async ({
  page,
}) => {
  await openFixture(page, `${PAGE}&usage=periodfail`, "light");
  await expect(page.getByTestId("usage-total")).toHaveText("1,640,000 tokens");
  await usage(page).getByRole("radio", { name: "Today" }).click();
  await expect(page.getByTestId("usage-error")).toContainText("Couldn't load Otto's usage");
  // None of the week's figures stand in for today's (the weekly budget's meter keeps its own).
  await expect(page.getByTestId("usage-total")).toHaveCount(0);
  await expect(page.getByTestId("usage-tokens")).toHaveCount(0);
  await expect(page.getByTestId("usage-source")).toHaveCount(0);
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
    "Budget 1,640,000 of 2,000,000 tokens this week · This week: 1,640,000 tokens · about $3.29, as of 5:39 PM",
  );
  const cut = await value.evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(cut).toBe(false);
  // It wraps onto lines of its own, every one of them shown: no clamp hides the end.
  const shape = await value.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
    return { lines, hidden: element.scrollHeight - element.clientHeight };
  });
  expect(shape.lines).toBeGreaterThan(1);
  expect(shape.hidden).toBeLessThanOrEqual(0);
  await context.close();
});

// With the page's frames held until after the next key (Tab), as on a slow machine, a key that
// chooses, opens or closes moves focus as it is handled, and Tab moves on from there.

test("F-232: an arrow in the Period choice moves focus with the choice: a Tab straight after leaves the group", async ({
  page,
}) => {
  await openFixture(page, PAGE, "light");
  const period = usage(page).getByRole("radiogroup", { name: "Period" });
  await period.getByRole("radio", { name: "This week" }).focus();
  await holdFrames(page);
  await page.keyboard.press("Home");
  await expect(period.getByRole("radio", { name: "Today" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(period.getByRole("radio", { name: "Today" })).toBeFocused();
  // Shift+Tab: Tab from the last control of the pane leaves the page.
  await tabThenRelease(page, usage(page).getByTestId("budget-edit"), "Shift+Tab");
});

test("F-234: an arrow in the budget's Period choice moves focus with the choice: a Tab straight after leaves the group", async ({
  page,
}) => {
  await openFixture(page, PAGE, "light");
  await page.getByTestId("budget-edit").click();
  const form = page.getByTestId("budget-form");
  await form.getByRole("radio", { name: "Weekly" }).focus();
  await holdFrames(page);
  await page.keyboard.press("ArrowLeft");
  await expect(form.getByRole("radio", { name: "Daily" })).toHaveAttribute("aria-checked", "true");
  await expect(form.getByRole("radio", { name: "Daily" })).toBeFocused();
  await tabThenRelease(page, form.getByTestId("budget-tokens"));
});

test("F-232: the Usage page takes focus as it opens, and its row as it closes: a Tab straight after is not undone", async ({
  page,
}) => {
  await openFixture(page, PANE, "light");
  const row = page.getByTestId("usage-row");
  await row.focus();
  await holdFrames(page);
  await page.keyboard.press("Enter");
  await expect(usage(page)).toBeVisible();
  await expect(usage(page).locator("[data-bs-focus]")).toBeFocused();
  await tabThenRelease(page, usage(page).getByTestId("budget-edit"));
  await usage(page).getByRole("button", { name: "Back to settings" }).focus();
  await holdFrames(page);
  await page.keyboard.press("Enter");
  await expect(usage(page)).toHaveCount(0);
  await expect(row).toBeFocused();
  await tabThenRelease(page, page.getByRole("button", { name: /^Where Otto runs: / }));
});

test("F-234: Escape from a budget's form in Settings gives focus back to its row, and from Add a budget to Add a budget: a Tab straight after is not undone", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}&access=write`, "light");
  const settings = await settingsUsage(page);
  const row = settings.locator('[data-budget="bot:otto"] button');
  await row.click();
  await expect(settings.getByTestId("budget-tokens")).toBeFocused();
  await holdFrames(page);
  await page.keyboard.press("Escape");
  await expect(settings.getByTestId("budget-edit-form")).toHaveCount(0);
  await expect(row).toBeFocused();
  await tabThenRelease(page, settings.locator('[data-budget="routine:weekly-cleanup"] button'));
  await settings.getByTestId("budget-add").click();
  await settings.getByTestId("budget-target").focus();
  await holdFrames(page);
  await page.keyboard.press("Escape");
  await expect(settings.getByTestId("budget-add-form")).toHaveCount(0);
  await expect(settings.getByTestId("budget-add")).toBeFocused();
  await tabThenRelease(page, settings.getByRole("radio", { name: "This week" }).first());
});
