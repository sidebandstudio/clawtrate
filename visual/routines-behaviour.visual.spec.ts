// The Routines view's behaviour in the fixture (docs/design/automation.md
// sections 3 to 8, 15), at the widths and themes it is drawn at. The
// fixture's routines are made up (apps/desktop/src/fixture/routines.ts); the
// same rows are checked against a real gateway in e2e/routines.spec.ts.
import { expect, test, type Page } from "@playwright/test";
import type { ClawtrateState } from "../packages/core/src/index.ts";
import { contextFor, openFixture, SIZES } from "./fixture.ts";

const ROUTINES = "scene=main&routines=on";
const size = (name: string) => SIZES.find((each) => each.name === name)!;
const view = (page: Page) => page.getByTestId("routines-view");
const rail = (page: Page, bot: string) =>
  page
    .locator(".bot-group")
    .filter({ has: page.getByTestId("bot").getByText(bot, { exact: true }) })
    .getByTestId("routine-task");

async function open(page: Page, query = ROUTINES) {
  await openFixture(page, query, "light");
  // In one pane the rail is its own screen: back to it from the open conversation.
  const back = page.getByRole("button", { name: "Back to bots" });
  if (await back.isVisible().catch(() => false)) await back.click();
  await page.getByRole("button", { name: "Routines", exact: true }).click();
  await expect(view(page)).toBeVisible();
}

/** Change the fixture's routines as a `cron` event would: `source` is a function of them. */
async function change(page: Page, source: string) {
  await page.evaluate((source) => {
    const fixture = (
      window as unknown as {
        clawtrateFixture: { setState(change: (state: ClawtrateState) => ClawtrateState): void };
      }
    ).clawtrateFixture;
    const next = new Function(`return ${source}`)() as (
      routines: ClawtrateState["routines"],
    ) => ClawtrateState["routines"];
    fixture.setState((state) => ({ ...state, routines: next(state.routines) }));
  }, source);
}

const sent = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { clawtrateFixture: { sent: Array<{ type: string }> } }
    ).clawtrateFixture.sent.map((each) => each.type),
  );

const dayHeads = (page: Page) =>
  page.locator(".r-cal-dayhead").evaluateAll((heads) => heads.map((head) => head.textContent));

test.describe("1440", () => {
  test.use(contextFor(size("1440"), "light"));

  test("F-191: lists every bot's routines with schedule, zone, next and last run, and Paused", async ({
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

  test("F-191: the Routines button is there with no routines and after a failed read, with Try again", async ({
    page,
  }) => {
    await open(page, "scene=main&routines=empty");
    await expect(view(page).getByTestId("routines-empty")).toContainText("No routines yet");
    await openFixture(page, "scene=main&routines=error", "light");
    await page.getByRole("button", { name: "Routines", exact: true }).click();
    const error = view(page).getByTestId("routines-error");
    await expect(error).toContainText("Couldn't load routines.");
    await expect(error).toContainText("The gateway didn't answer in time.");
    await error.getByRole("button", { name: "Try again" }).click();
    expect(await sent(page)).toContain("refreshRoutines");
  });

  test("F-191: more routines than kept are said, a bot the client does not hold still owns its routine, and one bot's are read in full", async ({
    page,
  }) => {
    await open(page, "scene=main&routines=truncated");
    await expect(view(page).getByTestId("routines-omitted")).toContainText(
      "The gateway has 12 more routines than Clawtrate keeps.",
    );
    await expect(view(page).getByRole("heading", { name: "ledger" })).toBeVisible();
    await view(page).getByTestId("routine-row").filter({ hasText: "Ledger export" }).click();
    await expect(view(page).getByRole("heading", { name: "Ledger export" })).toBeVisible();
    await view(page).getByRole("button", { name: "Back to routines" }).click();
    await view(page).getByRole("combobox", { name: "Bots" }).selectOption({ label: "Otto" });
    await expect(view(page).getByTestId("routine-row")).toHaveCount(3);
    expect(await sent(page)).toContain("readBotRoutines");
  });

  test("F-558: a filtered bot deleted elsewhere keeps the filter while its own read can still list its routines", async ({
    page,
  }) => {
    // Quartermaster's one routine is beyond the capped list: only its own read lists it.
    await open(page, "scene=main&routines=truncated&routinehold=quartermaster");
    await view(page)
      .getByRole("combobox", { name: "Bots" })
      .selectOption({ label: "Quartermaster of the Family Calendar and Errands" });
    await expect(view(page).getByLabel("Loading routines")).toBeVisible();
    await page.evaluate(() =>
      (
        window as unknown as {
          clawtrateFixture: {
            setState(f: (s: { bots: Array<{ id: string }> }) => unknown): void;
          };
        }
      ).clawtrateFixture.setState((state) => ({
        ...state,
        bots: state.bots.filter((bot) => bot.id !== "quartermaster"),
      })),
    );
    await expect(view(page).getByLabel("Loading routines")).toBeVisible();
    await page.evaluate(() =>
      (window as unknown as { releaseRoutineReads(): void }).releaseRoutineReads(),
    );
    await expect(view(page).getByTestId("routine-row")).toHaveCount(1);
    await expect(view(page).getByTestId("routine-row")).toContainText("Stores count");
  });

  test("F-191: the bot filter confirms completeness only after a successful complete read", async ({
    page,
  }) => {
    const omitted = view(page).getByTestId("routines-omitted");
    const chooseOtto = () =>
      view(page).getByRole("combobox", { name: "Bots" }).selectOption({ label: "Otto" });
    await open(page, "scene=main&routines=truncated&routinehold=otto");
    await chooseOtto();
    await expect(view(page).getByLabel("Loading routines")).toBeVisible();
    await expect(omitted).not.toContainText("All of this bot's are shown.");
    await page.evaluate(() =>
      (window as unknown as { releaseRoutineReads(): void }).releaseRoutineReads(),
    );
    await expect(omitted).toContainText("All of this bot's are shown.");

    await open(page, "scene=main&routines=truncated&routinefail=otto");
    await chooseOtto();
    await expect(view(page)).toContainText("Couldn't load this bot's routines.");
    await expect(omitted).not.toContainText("All of this bot's are shown.");
  });

  test("F-188 F-353: a routine's page says its instruction, schedule, zone, next run, where it runs and its triggers", async ({
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
    // A cron schedule with no zone runs in the gateway's; its next run is said in the viewer's.
    await view(page).getByRole("button", { name: "Back to routines" }).click();
    await view(page).getByTestId("routine-row").filter({ hasText: "Certificate renewal" }).click();
    await expect(view(page).getByTestId("routine-facts")).toContainText(
      "Time zoneThe gateway's own time zone",
    );
    await expect(view(page).getByTestId("routine-next")).toHaveText(
      "Tue Dec 1, 3:00 AMYour time. The schedule itself runs in the gateway's time zone.",
    );
  });

  test("F-190: runs say how each ended, with usage, and open their conversation or say why there is none", async ({
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
    // The recorded message whole: the gateway's own lines are not cut away.
    const message = view(page).getByTestId("scheduled-message");
    await expect(message).toContainText("Scheduled message, as the gateway recorded it");
    await expect(message).toContainText("Summarise the notes I added yesterday");
    await expect(message).toContainText("This is an unattended scheduled run.");
    await expect(view(page).getByTestId("run-view")).toContainText("Three notes from yesterday.");
    await expect(view(page).getByTestId("run-view")).toContainText("120 in, 80 out tokens");
    await expect(view(page).getByRole("button", { name: "All runs", exact: true })).toHaveCount(0);
    await view(page).getByRole("button", { name: "Back to Morning digest, all runs" }).click();
    await runs.nth(4).click();
    await expect(view(page).getByTestId("run-not-kept")).toContainText(
      "Clawtrate can't show this run's conversation. The gateway returned none for it. By default it keeps",
    );
    await expect(view(page).getByTestId("run-summary")).toContainText(
      "What the run returned: Three notes from yesterday.",
    );
  });

  test("F-190: a reminder in the main conversation is shown as such, not as a run of its own", async ({
    page,
  }) => {
    await open(page);
    await view(page).getByTestId("routine-row").filter({ hasText: "Stretch break" }).click();
    await expect(view(page)).toContainText("Posts a reminder in Juniper's main conversation:");
    await expect(view(page).getByTestId("routine-facts")).toContainText(
      "Runs inJuniper's main conversation",
    );
    await view(page).getByTestId("run-row").first().click();
    // The gateway records no session for a main-target run, so the run itself
    // cannot say which conversation it used.
    await expect(view(page).getByTestId("run-not-kept")).toContainText(
      "Clawtrate can't confirm which conversation this run used. The gateway recorded no session for it",
    );
  });

  test("F-190: a routine's runs that fail to load say so, with Try again", async ({ page }) => {
    await open(page, `${ROUTINES}&routinefail=routine-digest`);
    await view(page).getByTestId("routine-row").filter({ hasText: "Morning digest" }).click();
    const error = view(page).getByTestId("read-error");
    await expect(error).toContainText("Couldn't load runs. The gateway didn't answer in time.");
    await expect(error.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(view(page).getByTestId("no-runs")).toHaveCount(0);
  });

  test("F-355: a routine's page shows its 20 most recently finished runs, in the gateway's order", async ({
    page,
  }) => {
    await open(page, "scene=main&routines=many");
    await view(page).getByTestId("routine-row").filter({ hasText: "Morning digest" }).click();
    const rows = view(page).locator("[data-run-at]");
    await expect(rows).toHaveCount(20);
    const times = (await rows.evaluateAll((each) =>
      each.map((row) => Number(row.getAttribute("data-run-at"))),
    )) as number[];
    expect(times).toEqual([...times].sort((a, b) => b - a));
    await expect(view(page)).toContainText(
      "Clawtrate shows the 20 runs that finished most recently.",
    );
    await expect(view(page)).toContainText("By default the gateway keeps 7 days of runs");
  });

  test("F-024: a bot whose routine is running shows the working mark and the routine's name", async ({
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

  test("F-193: a routine's latest run in the last day is a row under its bot that opens that run, and stays on it", async ({
    page,
  }) => {
    await openFixture(page, ROUTINES, "light");
    // Isolated agent routines whose latest run finished in the last 24 hours.
    await expect(rail(page, "Otto")).toHaveCount(2);
    await expect(rail(page, "Otto").filter({ hasText: "Nightly backup check" })).toHaveAttribute(
      "data-state",
      "failed",
    );
    await expect(rail(page, "Juniper")).toHaveCount(0);
    await rail(page, "Marlow").click();
    await expect(view(page).getByRole("heading", { name: "Morning digest" })).toBeVisible();
    await expect(view(page).getByTestId("scheduled-message")).toBeVisible();
    const when = view(page).locator(".r-titles p");
    await expect(when).toHaveText("Marlow · Today 8:00 AM");
    // A later run finishes: the run on screen stays the one that was opened.
    await change(
      page,
      `(store) => ({ ...store, routines: store.routines.map((each) =>
        each.id === "routine-digest" ? { ...each, lastRunAt: Date.now() - 60000 } : each) })`,
    );
    await expect(rail(page, "Marlow")).toContainText("5:39 PM");
    await expect(when).toHaveText("Marlow · Today 8:00 AM");
  });

  test("F-193: a routine's row stays for a day from when its latest run finished, not from when it started", async ({
    page,
  }) => {
    await openFixture(page, ROUTINES, "light");
    const hour = 3_600_000;
    const ran = (startedAgo: number, endedAgo: number) =>
      change(
        page,
        `(store) => ({ ...store, routines: store.routines.map((each) =>
          each.id === "routine-digest"
            ? { ...each, lastRunAt: Date.now() - ${startedAgo}, lastEndedAt: Date.now() - ${endedAgo} }
            : each) })`,
      );
    await ran(25 * hour, 23 * hour);
    await expect(rail(page, "Marlow")).toHaveCount(1);
    await ran(26 * hour, 25 * hour);
    await expect(rail(page, "Marlow")).toHaveCount(0);
  });

  test("F-193: a running row follows the same run into its conversation", async ({ page }) => {
    await openFixture(page, "scene=main&routines=running", "light");
    await rail(page, "Marlow").click();
    await expect(view(page).getByTestId("run-starting")).toHaveText("Running…");
    await change(
      page,
      `(store) => ({ ...store, routines: store.routines.map((each) =>
        each.id === "routine-digest"
          ? { ...each, runningAt: null, lastRunAt: each.runningAt }
          : each) })`,
    );
    await expect(view(page).getByTestId("run-view")).toBeVisible();
  });

  test("F-193: a running row whose routine is removed stops loading and says the run is gone", async ({
    page,
  }) => {
    await openFixture(page, "scene=main&routines=running", "light");
    await rail(page, "Marlow").click();
    await expect(view(page).getByTestId("run-starting")).toHaveText("Running…");
    await change(
      page,
      `(store) => ({ ...store,
        routines: store.routines.filter((each) => each.id !== "routine-digest"),
        removed: { id: "routine-digest", ranOnce: false, runAt: null } })`,
    );
    await expect(view(page).getByTestId("run-gone")).toBeVisible();
    await expect(view(page)).not.toContainText("Loading this run…");
  });

  test("F-190: an isolated run keeps its recorded conversation after its routine becomes a reminder or a command", async ({
    page,
  }) => {
    await open(page);
    await view(page).getByTestId("routine-row").filter({ hasText: "Morning digest" }).click();
    await view(page).getByTestId("run-row").first().click();
    const message = view(page).getByTestId("scheduled-message");
    await expect(message).toContainText("Summarise the notes I added yesterday");
    for (const payload of ["systemEvent", "other"]) {
      await change(
        page,
        `(store) => ({ ...store, routines: store.routines.map((each) =>
          each.id === "routine-digest"
            ? { ...each, payload: "${payload}", target: "main", updatedAt: Date.now() }
            : each) })`,
      );
      await expect(message).toContainText("Summarise the notes I added yesterday");
      await expect(view(page).getByTestId("run-not-kept")).toHaveCount(0);
    }
  });

  test("F-190: an isolated run whose routine was edited to a main-target reminder while it ran still reads its recorded conversation", async ({
    page,
  }) => {
    await open(page);
    await view(page).getByTestId("routine-row").filter({ hasText: "Morning digest" }).click();
    // The gateway writes a job's updatedAtMs as its last run's end (issue #212), so
    // an edit while the run was going is indistinguishable from the run's own end
    // timestamp: the run's recorded session is the only word on what it used.
    const runAt = Number(
      await view(page).getByTestId("run-row").first().getAttribute("data-run-at"),
    );
    await view(page).getByTestId("run-row").first().click();
    const message = view(page).getByTestId("scheduled-message");
    await expect(message).toContainText("Summarise the notes I added yesterday");
    await change(
      page,
      `(store) => ({ ...store, routines: store.routines.map((each) =>
        each.id === "routine-digest"
          ? { ...each, payload: "systemEvent", target: "main", updatedAt: ${runAt + 2600} }
          : each) })`,
    );
    await expect(message).toContainText("Summarise the notes I added yesterday");
    await expect(view(page).getByTestId("run-not-kept")).toHaveCount(0);
  });

  test("F-190: a run with no recorded session says its conversation could not be confirmed", async ({
    page,
  }) => {
    await open(page);
    await view(page).getByTestId("routine-row").filter({ hasText: "Stretch break" }).click();
    await view(page).getByTestId("run-row").first().click();
    await expect(view(page).getByTestId("run-not-kept")).toContainText(
      "Clawtrate can't confirm which conversation this run used. The gateway recorded no session for it",
    );
  });

  test("F-022: a task under Routines shows its unread dot, and coming back to it reads it again", async ({
    page,
  }) => {
    const key = "agent:otto:disk-space";
    await openFixture(page, `scene=rail-write&bot=otto&task=${key}&routines=on`, "light");
    const reads = () =>
      page.evaluate(
        (key) =>
          (
            window as unknown as {
              clawtrateFixture: { sent: Array<{ type: string; key?: string }> };
            }
          ).clawtrateFixture.sent.filter((each) => each.type === "markTask" && each.key === key)
            .length,
        key,
      );
    await expect.poll(reads).toBe(1);
    await page.getByRole("button", { name: "Routines", exact: true }).click();
    // Another device marks it unread while Routines covers it.
    await page.evaluate((key) => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: { setState(change: (state: ClawtrateState) => ClawtrateState): void };
        }
      ).clawtrateFixture;
      fixture.setState((state) => ({
        ...state,
        tasksByBot: {
          ...state.tasksByBot,
          otto: state.tasksByBot.otto!.map((task) =>
            task.key === key
              ? { ...task, unread: true, unreadMarker: Date.now(), updatedAt: Date.now() }
              : task,
          ),
        },
      }));
    }, key);
    const row = page.getByTestId("task").filter({ hasText: "Disk almost full" }).first();
    await expect(row.locator(".unread-dot")).toHaveCount(1);
    await view(page).getByRole("button", { name: "Back to conversation" }).click();
    await expect.poll(reads).toBe(2);
  });

  test("F-193: another routine's run never shows under this one's heading while it loads, or when it fails", async ({
    page,
  }) => {
    await openFixture(page, `${ROUTINES}&routinehold=routine-backup`, "light");
    await rail(page, "Marlow").click();
    await expect(view(page).getByTestId("scheduled-message")).toContainText("Summarise the notes");
    await rail(page, "Otto").filter({ hasText: "Nightly backup check" }).click();
    await expect(view(page).getByRole("heading", { name: "Nightly backup check" })).toBeVisible();
    await expect(view(page)).toContainText("Loading this run…");
    await expect(view(page).getByTestId("scheduled-message")).toHaveCount(0);
    await expect(view(page)).not.toContainText("Three notes from yesterday.");
    // Its runs, then its conversation, are answered.
    await expect(async () => {
      await page.evaluate(() =>
        (window as unknown as { releaseRoutineReads(): void }).releaseRoutineReads(),
      );
      await expect(view(page).getByTestId("scheduled-message")).toContainText(
        "Check last night's backup finished",
        { timeout: 500 },
      );
    }).toPass();

    await openFixture(page, `${ROUTINES}&routinefail=routine-backup`, "light");
    await rail(page, "Marlow").click();
    await expect(view(page).getByTestId("scheduled-message")).toBeVisible();
    await rail(page, "Otto").filter({ hasText: "Nightly backup check" }).click();
    const error = view(page).getByTestId("read-error");
    await expect(error).toContainText("Couldn't load this run.");
    await expect(view(page)).not.toContainText("No runs yet");
    await expect(view(page).getByTestId("scheduled-message")).toHaveCount(0);
  });

  test("F-190: a one-shot is said to have removed itself only on the gateway's word", async ({
    page,
  }) => {
    await open(page);
    await view(page)
      .getByTestId("routine-row")
      .filter({ hasText: "Send the draft to Sam" })
      .click();
    const remove = (ranOnce: boolean) =>
      change(
        page,
        `(store) => ({ ...store,
          routines: store.routines.filter((each) => each.id !== "routine-draft"),
          removed: { id: "routine-draft", ranOnce: ${ranOnce}, runAt: ${ranOnce} ? Date.now() - 60000 : null } })`,
      );
    await remove(false);
    await expect(view(page).getByTestId("routine-deleted")).toContainText(
      "This routine was deleted.",
    );
    await expect(view(page).getByTestId("routine-deleted")).not.toContainText("ran once");
    await open(page);
    await view(page)
      .getByTestId("routine-row")
      .filter({ hasText: "Send the draft to Sam" })
      .click();
    await remove(true);
    await expect(view(page).getByTestId("routine-deleted")).toContainText(
      "This routine ran once, and the gateway removed it. Its run succeeded today 5:39 PM.",
    );
  });

  test("F-197: the calendar's dates move with Previous, Next and Today, and focus stays on the button pressed", async ({
    page,
  }) => {
    await open(page);
    await view(page).getByRole("radio", { name: "Week" }).click();
    const range = page.getByTestId("calendar-range");
    expect(await dayHeads(page)).toHaveLength(7);
    expect((await dayHeads(page))[0]).toBe("Today Nov 16");
    await expect(range).toHaveText("Today Nov 16 to Sun Nov 22");
    await expect(range).toHaveRole("status");
    const next = page.getByRole("button", { name: "Next 7 days" });
    await next.click();
    expect((await dayHeads(page))[0]).toBe("Mon Nov 23");
    await expect(next).toBeFocused();
    const previous = page.getByRole("button", { name: "Previous 7 days" });
    await previous.click();
    await previous.click();
    expect((await dayHeads(page))[0]).toBe("Mon Nov 9");
    await expect(previous).toBeFocused();
    const today = page.getByRole("button", { name: "Today" });
    await today.click();
    expect((await dayHeads(page))[0]).toBe("Today Nov 16");
    await expect(today).toBeFocused();
    await view(page).getByRole("radio", { name: "3 days" }).click();
    expect(await dayHeads(page)).toHaveLength(3);
  });

  test("F-197: Left and Right move between chips on the nearest days that have one, and leave the dates alone", async ({
    page,
  }) => {
    await open(page);
    await view(page).getByRole("radio", { name: "Week" }).click();
    const digest = (day: string) =>
      page.getByRole("button", { name: `Morning digest, Marlow, ${day} 8:00 AM` });
    await digest("Tue Nov 17").focus();
    await page.keyboard.press("ArrowRight");
    await expect(digest("Wed Nov 18")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(digest("Tue Nov 17")).toBeFocused();
    await expect(page.getByTestId("calendar-range")).toHaveText("Today Nov 16 to Sun Nov 22");
  });

  test("F-197: the calendar is a group of lists named by their dates, with past runs of paused and frequent routines kept", async ({
    page,
  }) => {
    await open(page);
    await view(page).getByRole("radio", { name: "Week" }).click();
    const group = page.getByRole("group", { name: "Routines by day" });
    const days = group.getByRole("list");
    await expect(days).toHaveCount(7);
    await expect(days.first()).toHaveAccessibleName("Today Nov 16");
    // A frequent routine is a band each day, named with its date, and its recorded runs stay chips.
    await expect(page.locator(".r-cal-band", { hasText: "Disk space watch" })).toHaveCount(7);
    await expect(
      page.getByRole("button", { name: "Every 30 minutes · Disk space watch, Tue Nov 17" }),
    ).toBeVisible();
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
      page.getByRole("button", { name: "Nightly backup check, Otto, Mon Nov 16 3:30 AM, failed" }),
    ).toBeVisible();
    await expect(
      page.locator(".r-occ:not([data-past])", { hasText: "Morning digest" }),
    ).toHaveCount(4);
  });

  test("F-197: a frequent routine's band is only on the coming days it runs, and chips under an hour apart sit side by side", async ({
    page,
  }) => {
    await open(page);
    await view(page).getByRole("radio", { name: "Week" }).click();
    await change(
      page,
      `(routines) => {
          const base = routines.routines.find((each) => each.id === "routine-digest");
          const tue = (hour, minute) => Date.UTC(2026, 10, 17, hour + 5, minute);
          const make = (id, name, expr, next) => ({ ...base, id, name, nextRunAt: next,
            schedule: { ...base.schedule, kind: "cron", expr, tz: "America/New_York" } });
          return { ...routines, routines: [...routines.routines,
            make("sweep", "Inbox sweep", "0 8-12 * * 1-5", tue(8, 0)),
            make("standup", "Standup notes", "0,30 9 * * *", tue(9, 0)),
            make("ten", "Ten o'clock check", "0 10 * * *", tue(10, 0))] };
        }`,
    );
    // Hourly from 8 AM to noon on weekdays: nothing is left of it today at 5:40 PM, and none at the weekend.
    const sweep = page.locator(".r-cal-band", { hasText: "Inbox sweep" });
    await expect(sweep).toHaveCount(4);
    await expect(page.getByRole("button", { name: /Inbox sweep, Sat Nov 21$/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Previous 7 days" }).click();
    await expect(sweep).toHaveCount(0);
    await page.getByRole("button", { name: "Today" }).click();
    const chips = [
      "Standup notes, Marlow, Tue Nov 17 9:00 AM",
      "Standup notes, Marlow, Tue Nov 17 9:30 AM",
      "Ten o'clock check, Marlow, Tue Nov 17 10:00 AM",
    ].map((name) => page.getByRole("button", { name, exact: true }));
    const boxes = await Promise.all(chips.map((chip) => chip.boundingBox()));
    for (const [i, a] of boxes.entries())
      for (const b of boxes.slice(i + 1))
        expect(
          a!.x < b!.x + b!.width &&
            b!.x < a!.x + a!.width &&
            a!.y < b!.y + b!.height &&
            b!.y < a!.y + a!.height,
        ).toBe(false);
    // A day with only a band is not announced as empty; one with nothing is.
    await change(
      page,
      `(routines) => ({ ...routines, routines: routines.routines.filter((each) => each.id === "sweep") })`,
    );
    const days = page.getByRole("group", { name: "Routines by day" }).getByRole("list");
    await expect(days.nth(3)).toHaveAccessibleName("Thu Nov 19");
    await expect(days.nth(3)).toHaveAccessibleDescription("");
    await expect(days.nth(5)).toHaveAccessibleDescription("Nothing scheduled");
  });

  test("F-197: a failed read of the days' runs says so with Try again, and a partial one says so", async ({
    page,
  }) => {
    await open(page, `${ROUTINES}&calendar=fail`);
    await view(page).getByRole("radio", { name: "Week" }).click();
    const error = page.getByTestId("calendar-error");
    await expect(error).toContainText("Couldn't load the runs on these days.");
    await expect(error.getByRole("button", { name: "Try again" })).toBeVisible();
    await open(page, `${ROUTINES}&calendar=partial`);
    await view(page).getByRole("radio", { name: "Week" }).click();
    await expect(page.getByTestId("calendar-partial")).toContainText(
      "Some runs on these days aren't shown.",
    );
  });

  test("F-193: the bot shortcut opens the selected bot's conversation from Routines", async ({
    page,
  }) => {
    await openFixture(page, "scene=main&bot=otto&task=agent:otto:disk-space&routines=on", "light");
    await page.getByRole("button", { name: "Routines", exact: true }).click();
    await expect(view(page)).toBeVisible();
    // The rail's order is recent activity, so ⌘1 targets the selected bot itself.
    await page.keyboard.press("ControlOrMeta+1");
    await expect(view(page)).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Disk almost full on the media box",
    );
  });

  test("the view has Back to the conversation, closes Work, and returns focus to the Routines button", async ({
    page,
  }) => {
    await openFixture(page, "scene=main&panel=open", "light");
    await expect(page.locator(".shell")).toHaveAttribute("data-panel", "open");
    const button = page.getByRole("button", { name: "Routines", exact: true });
    await button.click();
    await expect(page.locator(".shell")).toHaveAttribute("data-panel", "closed");
    await view(page).getByRole("button", { name: "Back to conversation" }).click();
    await expect(view(page)).toHaveCount(0);
    await expect(button).toBeFocused();
  });
});

test.describe("1100", () => {
  test.use(contextFor(size("1100"), "light"));
  test("F-197: the week keeps all seven days in view", async ({ page }) => {
    await open(page);
    await view(page).getByRole("radio", { name: "Week" }).click();
    const columns = page.getByTestId("calendar-day");
    await expect(columns).toHaveCount(7);
    const scroll = page.locator(".r-cal-scroll");
    expect(await scroll.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    const box = (await scroll.boundingBox())!;
    for (const column of await columns.all()) {
      const each = (await column.boundingBox())!;
      expect(each.x).toBeGreaterThanOrEqual(box.x - 0.5);
      expect(each.x + each.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
    }
  });
});

test.describe("resizing", () => {
  test.use(contextFor(size("1440"), "light"));
  test("Work docked at 1440 leaves no scrim and no inert rail behind Routines at 800", async ({
    page,
  }) => {
    await openFixture(page, "scene=main&panel=open", "light");
    await page.getByRole("button", { name: "Routines", exact: true }).click();
    await page.setViewportSize({ width: 800, height: 700 });
    await expect(view(page)).toBeVisible();
    await expect(page.locator(".shell")).toHaveAttribute("data-panel", "closed");
    await expect(page.locator(".rail")).not.toHaveAttribute("inert");
    await expect(page.locator(".drawer-scrim")).toBeHidden();
    await view(page).getByRole("radio", { name: "Week" }).click();
    await expect(view(page).getByRole("radio", { name: "Week" })).toBeChecked();
  });
});

test.describe("phone", () => {
  test.use(contextFor(size("phone"), "light"));
  test("F-193: a run's title and time are both readable at phone width", async ({ page }) => {
    await open(page);
    // The phone offers List and Day, and Back goes to the bots.
    await expect(view(page).getByRole("radio")).toHaveCount(2);
    await expect(view(page).getByRole("button", { name: "Back to bots" })).toBeVisible();
    await view(page).getByTestId("routine-row").filter({ hasText: "Nightly backup check" }).click();
    await view(page).getByTestId("run-row").first().click();
    const title = view(page).locator(".r-titles h1");
    const time = view(page).locator(".r-titles p");
    await expect(title).toHaveText("Nightly backup check");
    await expect(time).toHaveText("Otto · Today 3:30 AM");
    for (const element of [title, time]) {
      expect(await element.evaluate((each) => each.scrollWidth <= each.clientWidth)).toBe(true);
    }
  });

  test("F-190: reopening the selected task's conversation from Routines moves focus to it", async ({
    page,
  }) => {
    await openFixture(page, ROUTINES, "light");
    await page.getByRole("button", { name: "Back to bots" }).click();
    await page.getByRole("button", { name: "Routines", exact: true }).click();
    await expect(view(page)).toBeVisible();
    const open = view(page).getByRole("button", { name: "Open conversation", exact: true });
    await view(page).getByTestId("routine-row").filter({ hasText: "Plan the week" }).click();
    await view(page).getByTestId("run-row").first().click();
    await open.click();
    await expect(view(page)).toHaveCount(0);
    // The run's recorded conversation is the one the shell now holds open. Routines
    // covers it, and opening it again changes neither view nor task key.
    await page.getByRole("button", { name: "Back to bots" }).click();
    await page.getByRole("button", { name: "Routines", exact: true }).click();
    await view(page).getByTestId("routine-row").filter({ hasText: "Plan the week" }).click();
    await view(page).getByTestId("run-row").first().click();
    await open.click();
    await expect(view(page)).toHaveCount(0);
    await expect(page.locator(".conversation h1")).toBeFocused();
  });

  test("F-190: a run that recorded a shared conversation keeps it after its routine is changed to a command", async ({
    page,
  }) => {
    await open(page);
    await view(page).getByTestId("routine-row").filter({ hasText: "Plan the week" }).click();
    await view(page).getByTestId("run-row").first().click();
    const link = view(page).getByRole("button", { name: "Open conversation", exact: true });
    await expect(link).toBeVisible();
    await change(
      page,
      `(routines) => ({ ...routines, routines: routines.routines.map((each) =>
        each.id === "routine-week" ? { ...each, payload: "other" } : each) })`,
    );
    await expect(link).toBeVisible();
  });

  test("Back to bots leaves the view for the rail, with focus on the Routines button", async ({
    page,
  }) => {
    await open(page);
    await view(page).getByRole("button", { name: "Back to bots" }).click();
    await expect(view(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Routines", exact: true })).toBeFocused();
  });
});
