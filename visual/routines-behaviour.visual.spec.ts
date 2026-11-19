// The Routines view's behaviour in the fixture (docs/design/automation.md
// sections 3 to 7, 15), at the widths and themes it is drawn at. The
// fixture's routines are made up (apps/desktop/src/fixture/routines.ts); the
// same rows are checked against a real gateway in e2e/routines.spec.ts.
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, SIZES } from "./fixture.ts";

const ROUTINES = "scene=main&routines=on";
const size = (name: string) => SIZES.find((each) => each.name === name)!;
const view = (page: Page) => page.getByTestId("routines-view");

async function open(page: Page, query = ROUTINES) {
  await openFixture(page, query, "light");
  // In one pane the rail is its own screen: back to it from the open conversation.
  const back = page.getByRole("button", { name: "Back to bots" });
  if (await back.isVisible().catch(() => false)) await back.click();
  await page.getByRole("button", { name: "Routines", exact: true }).click();
  await expect(view(page)).toBeVisible();
}

const dayHeads = (page: Page) =>
  page.locator(".r-cal-dayhead").evaluateAll((heads) => heads.map((head) => head.textContent));

test.describe("1440", () => {
  test.use(contextFor(size("1440"), "light"));

  test("F-191 lists every bot's routines with schedule, zone, next and last run, and Paused", async ({
    page,
  }) => {
    await open(page);
    const row = (name: string) => view(page).getByTestId("routine-row").filter({ hasText: name });
    await expect(view(page).getByTestId("routine-row")).toHaveCount(8);
    await expect(row("Morning digest")).toContainText(
      "Weekdays at 8:00 AM, New York · Next tomorrow 8:00 AM · Last today, succeeded",
    );
    await expect(row("Nightly backup check")).toContainText("Last today, failed");
    await expect(row("Inbox tidy-up")).toContainText("Paused · Fridays at 4:00 PM, New York");
    await expect(row("Send the draft to Sam")).toContainText("No runs yet");
    await view(page).getByRole("combobox", { name: "Bots" }).selectOption({ label: "Otto" });
    await expect(view(page).getByTestId("routine-row")).toHaveCount(3);
    await expect(view(page).getByTestId("routine-count")).toHaveText("3 routines");
  });

  test("F-188 F-353 a routine's page says its instruction, schedule, zone, next run, where it runs and its triggers", async ({
    page,
  }) => {
    await open(page);
    await view(page).getByTestId("routine-row").filter({ hasText: "Morning digest" }).click();
    await expect(view(page).getByRole("heading", { name: "Morning digest" })).toBeVisible();
    await expect(view(page)).toContainText(
      "Summarise the notes I added yesterday, and list anything I need to answer today.",
    );
    const facts = view(page).getByTestId("routine-facts");
    await expect(facts).toContainText("ScheduleWeekdays at 8:00 AM");
    await expect(facts).toContainText("Time zoneNew YorkAmerica/New_York");
    await expect(view(page).getByTestId("routine-next")).toHaveText(
      "Tomorrow, Tue Nov 17, 8:00 AMNew York time",
    );
    await expect(facts).toContainText("Runs inA new conversation each time");
    await expect(facts).toContainText("ResultsKept with the run");
    await expect(facts).toContainText(
      "TriggersIts schedule only.This gateway's webhooks start a bot directly, not a routine.",
    );
    // A routine in another zone gives the viewer's time too.
    await view(page).getByRole("button", { name: "Back to routines" }).click();
    await view(page).getByTestId("routine-row").filter({ hasText: "Plan the week" }).click();
    await expect(view(page).getByTestId("routine-next")).toContainText("your time");
  });

  test("F-190 runs say how each ended, with usage, and open their conversation or say why there is none", async ({
    page,
  }) => {
    await open(page);
    await view(page).getByTestId("routine-row").filter({ hasText: "Morning digest" }).click();
    const runs = view(page).getByTestId("run-row");
    await expect(runs).toHaveCount(6);
    await expect(runs.nth(0)).toContainText("Succeeded · 2.6 s · 200 tokens");
    await expect(runs.nth(1)).toContainText("started by hand");
    await expect(runs.nth(2)).toContainText(
      "Failed: Channel is required (no configured channels detected).",
    );
    await expect(runs.nth(3)).toContainText("Skipped");
    await runs.nth(0).click();
    await expect(view(page).getByTestId("scheduled-message")).toContainText(
      "Summarise the notes I added yesterday",
    );
    await expect(view(page).getByTestId("run-view")).toContainText("Three notes from yesterday.");
    await expect(view(page).getByTestId("run-view")).toContainText("120 in, 80 out tokens");
    await view(page).getByRole("button", { name: "Back to the routine" }).click();
    await runs.nth(4).click();
    await expect(view(page).getByTestId("run-not-kept")).toContainText(
      "The gateway doesn't have this run's conversation.",
    );
    await expect(view(page).getByTestId("run-summary")).toContainText(
      "Three notes from yesterday.",
    );
  });

  test("F-190 a reminder in the main conversation is shown as such, not as a run of its own", async ({
    page,
  }) => {
    await open(page);
    await view(page).getByTestId("routine-row").filter({ hasText: "Stretch break" }).click();
    await expect(view(page)).toContainText("Posts a reminder in Juniper's main conversation:");
    await expect(view(page).getByTestId("routine-facts")).toContainText(
      "Runs inJuniper's main conversation",
    );
    await view(page).getByTestId("run-row").first().click();
    await expect(view(page).getByTestId("run-not-kept")).toContainText(
      "This run has no conversation of its own.",
    );
  });

  test("F-355 a routine's page shows its 20 most recent runs, newest first", async ({ page }) => {
    await open(page, "scene=main&routines=many");
    await view(page).getByTestId("routine-row").filter({ hasText: "Morning digest" }).click();
    const rows = view(page).locator("[data-run-at]");
    await expect(rows).toHaveCount(20);
    const times = (await rows.evaluateAll((each) =>
      each.map((row) => Number(row.getAttribute("data-run-at"))),
    )) as number[];
    expect(times).toEqual([...times].sort((a, b) => b - a));
    await expect(view(page)).toContainText("Clawtrate shows the 20 most recent runs.");
  });

  test("F-024 a bot whose routine is running shows the working mark and the routine's name", async ({
    page,
  }) => {
    await openFixture(page, "scene=main&routines=running", "light");
    const marlow = page.getByTestId("bot-list").getByRole("button", { name: /^Marlow\b/ });
    await expect(marlow).toHaveAttribute("data-state", "working");
    await expect(marlow).toContainText("Running Morning digest");
    await expect(marlow).toHaveAccessibleName(/^Marlow, working/);
    // Without a run in progress the same bot is idle.
    await openFixture(page, ROUTINES, "light");
    await expect(
      page.getByTestId("bot-list").getByRole("button", { name: /^Marlow\b/ }),
    ).not.toHaveAttribute("data-state", "working");
  });

  test("F-193 a routine's latest run is a row under its bot that opens the run", async ({
    page,
  }) => {
    await openFixture(page, ROUTINES, "light");
    const rows = page
      .getByRole("list", { name: "Otto's routine runs" })
      .getByTestId("routine-task");
    await expect(rows).toHaveCount(3);
    const backup = rows.filter({ hasText: "Nightly backup check" });
    await expect(backup).toHaveAttribute("data-state", "failed");
    await page
      .getByRole("list", { name: "Marlow's routine runs" })
      .getByTestId("routine-task")
      .click();
    await expect(view(page).getByRole("heading", { name: "Morning digest" })).toBeVisible();
    await expect(view(page).getByTestId("scheduled-message")).toBeVisible();
    await expect(view(page).getByRole("button", { name: "All runs" })).toBeVisible();
  });

  test("F-197 the calendar moves by its arrows, Today and the Left and Right keys", async ({
    page,
  }) => {
    await open(page);
    await view(page).getByRole("radio", { name: "Week" }).click();
    const first = await dayHeads(page);
    expect(first[0]).toBe("TodayNov 16");
    expect(first).toHaveLength(7);
    await page.getByRole("button", { name: "Next 7 days" }).click();
    expect((await dayHeads(page))[0]).toBe("MonNov 23");
    await page.getByRole("button", { name: "Previous 7 days" }).click();
    await page.getByRole("button", { name: "Previous 7 days" }).click();
    expect((await dayHeads(page))[0]).toBe("MonNov 9");
    await page.getByRole("button", { name: "Today" }).click();
    expect((await dayHeads(page))[0]).toBe("TodayNov 16");
    await page.getByRole("region", { name: /^Routines, / }).focus();
    await page.keyboard.press("ArrowRight");
    expect((await dayHeads(page))[0]).toBe("TueNov 17");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    expect((await dayHeads(page))[0]).toBe("SunNov 15");
    // Day and 3 days have as many columns.
    await view(page).getByRole("radio", { name: "3 days" }).click();
    expect(await dayHeads(page)).toHaveLength(3);
  });

  test("F-197 the calendar is lists of chips by day, with past runs of paused and frequent routines kept", async ({
    page,
  }) => {
    await open(page);
    await view(page).getByRole("radio", { name: "Week" }).click();
    const days = page.getByTestId("calendar").getByRole("list");
    await expect(days).toHaveCount(7);
    await expect(days.first()).toHaveAccessibleName("Monday, Nov 16");
    // A frequent routine is a band each day, and its recorded runs stay chips.
    await expect(page.locator(".r-cal-band", { hasText: "Disk space watch" })).toHaveCount(7);
    await expect(
      page.locator('.r-occ[data-past="true"]', { hasText: "Disk space watch" }),
    ).not.toHaveCount(0);
    // Inbox tidy-up is paused: nothing ahead, its last run (Tue Nov 10) still drawn.
    await expect(page.locator(".r-occ", { hasText: "Inbox tidy-up" })).toHaveCount(0);
    await page.getByRole("button", { name: "Previous 7 days" }).click();
    await expect(
      page.locator('.r-occ[data-past="true"]', { hasText: "Inbox tidy-up" }),
    ).toHaveCount(1);
    // A failed run has its mark; future times follow the schedule.
    await page.getByRole("button", { name: "Today" }).click();
    await expect(
      page.getByRole("button", {
        name: "Nightly backup check, Otto, Monday, Nov 16 3:30 AM, failed",
      }),
    ).toBeVisible();
    await expect(
      page.locator(".r-occ:not([data-past])", { hasText: "Morning digest" }),
    ).toHaveCount(4);
  });
});

test.describe("1100", () => {
  test.use(contextFor(size("1100"), "light"));
  test("F-197 the week keeps all seven days in view", async ({ page }) => {
    await open(page);
    await view(page).getByRole("radio", { name: "Week" }).click();
    const scroll = page.locator(".r-cal-scroll");
    const fits = await scroll.evaluate((element) => element.scrollWidth <= element.clientWidth);
    expect(fits).toBe(true);
    const box = (await scroll.boundingBox())!;
    const last = (await page.locator(".r-cal-dayhead").last().boundingBox())!;
    expect(last.x + last.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
  });
});

test.describe("phone", () => {
  test.use(contextFor(size("phone"), "light"));
  test("F-193 a run's title and time are both readable at phone width", async ({ page }) => {
    await open(page);
    // The phone offers List and Day.
    await expect(view(page).getByRole("radio")).toHaveCount(2);
    await view(page).getByTestId("routine-row").filter({ hasText: "Nightly backup check" }).click();
    await view(page).getByTestId("run-row").first().click();
    const title = view(page).locator(".r-titles h1");
    const time = view(page).locator(".r-titles p");
    await expect(time).toContainText("Otto · Today 3:30 AM");
    for (const element of [title, time]) {
      expect(await element.evaluate((each) => each.scrollWidth <= each.clientWidth)).toBe(true);
    }
  });
});
