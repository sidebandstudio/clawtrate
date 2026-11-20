// Changing routines in the fixture (docs/design/automation.md sections 9 to
// 13): the editor and every way a save ends, the switch, Run now, delete, the
// row's menu, a bot's routines' time zone, the gateway's hook address, and
// what a connection without admin access sees. The same writes are checked
// against a real gateway in e2e/routines-edit.spec.ts. The fixture's routines
// are made up (apps/desktop/src/fixture/routines.ts).
import type { ClawtrateState, ConnectionState } from "../packages/core/src/index.ts";
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, SIZES } from "./fixture.ts";

const ADMIN = "scene=main&routines=on&access=admin";
const READ = "scene=main&routines=on";
const size = (name: string) => SIZES.find((each) => each.name === name)!;
const view = (page: Page) => page.getByTestId("routines-view");
const editor = (page: Page) => page.getByTestId("routine-editor");
const row = (page: Page, name: string) =>
  view(page).getByTestId("routine-row").filter({ hasText: name });

async function open(page: Page, query = ADMIN) {
  await openFixture(page, query, "light");
  const back = page.getByRole("button", { name: "Back to bots" });
  if (await back.isVisible().catch(() => false)) await back.click();
  await page.getByRole("button", { name: "Routines", exact: true }).click();
  await expect(view(page)).toBeVisible();
}

async function openPage(page: Page, name: string, query = ADMIN) {
  await open(page, query);
  await row(page, name).locator(".r-row-main").click();
  await expect(view(page).getByRole("heading", { name })).toBeVisible();
}

const save = (page: Page) => editor(page).getByRole("button", { name: "Save", exact: true });

async function fillNew(page: Page, name = "Weekly reading list") {
  await view(page).getByTestId("new-routine").click();
  await expect(editor(page).getByRole("heading", { name: "New routine" })).toBeVisible();
  await editor(page).getByLabel("Bot").selectOption({ label: "Pip" });
  await editor(page).getByLabel("Name").fill(name);
  await editor(page).getByLabel("Instruction").fill("List the three articles worth reading first.");
}

/** A value from the fixture's connection state, read by a no-op set. */
async function connectionValue(page: Page, field: "gatewayId") {
  return page.evaluate((field) => {
    const fixture = (
      window as unknown as {
        clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
      }
    ).clawtrateFixture;
    let value: string | null = null;
    fixture.setState((state) => {
      value = state.connection[field];
      return state;
    });
    return value;
  }, field);
}

/** Change the fixture's connection, as the host's next snapshot would. */
async function setConnection(page: Page, change: Partial<ConnectionState>) {
  await page.evaluate((change) => {
    const fixture = (
      window as unknown as {
        clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
      }
    ).clawtrateFixture;
    fixture.setState((state) => ({
      ...state,
      connection: { ...state.connection, ...change },
    }));
  }, change);
}

async function setAdmin(page: Page, admin: boolean) {
  await setConnection(page, { canAdmin: admin });
}

test.describe("1440", () => {
  test.use(contextFor(size("1440"), "light"));

  test("F-191: with admin each routine has its switch, and New routine is in the header, the empty state and under one bot", async ({
    page,
  }) => {
    await open(page);
    await expect(view(page).getByRole("switch")).toHaveCount(8);
    await expect(row(page, "Inbox tidy-up").getByRole("switch")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await expect(view(page).getByTestId("new-routine")).toHaveText("New routine");
    await view(page).getByRole("combobox", { name: "Bots" }).selectOption({ label: "Pip" });
    await expect(view(page).getByRole("button", { name: "New routine for Pip" })).toBeVisible();
    await open(page, "scene=main&routines=empty&access=admin");
    await expect(view(page).getByTestId("routines-empty").getByRole("button")).toHaveText(
      "New routine",
    );
  });

  test("F-189 F-354: a new routine is made in the form, and its page says it waits for its first time", async ({
    page,
  }) => {
    await open(page);
    await fillNew(page);
    await editor(page).getByRole("radio", { name: "Some days of the week" }).click();
    await editor(page).getByRole("button", { name: "Fri" }).click();
    await expect(editor(page).getByTestId("preview")).toContainText(
      // Pip's routines run on London time, so a new one starts there.
      "Runs on Mondays and Fridays at 8:00 AM, London time. Next: Fri Nov 20, 8:00 AM (3:00 AM your time)",
    );
    await save(page).click();
    await expect(editor(page)).toHaveCount(0);
    await expect(view(page).getByRole("heading", { name: "Weekly reading list" })).toBeVisible();
    await expect(view(page).getByTestId("no-runs")).toContainText("No runs yet. The first is due");
    await expect(page.getByTestId("b-announcer")).toHaveText("Routine created");
  });

  test("F-195: schedules are at least five minutes apart, from the choices and in a cron expression", async ({
    page,
  }) => {
    await open(page);
    await fillNew(page);
    await editor(page).getByRole("radio", { name: "Every few hours or minutes" }).click();
    await editor(page).getByLabel("Every").fill("4");
    await save(page).click();
    await expect(editor(page)).toContainText("Routines run at least 5 minutes apart.");
    // Save makes no request while the form says no.
    await expect(editor(page)).toBeVisible();
    await editor(page).getByLabel("Every").fill("5");
    await expect(editor(page)).not.toContainText("Routines run at least 5 minutes apart.");
    await editor(page).getByText("More").click();
    await editor(page).getByLabel("Cron expression").fill("*/7 * * * *");
    await expect(editor(page).getByTestId("routine-editor").or(editor(page))).toContainText(
      "Routines run at least 5 minutes apart.",
    );
    await editor(page).getByLabel("Cron expression").fill("*/5 * * * *");
    await expect(editor(page)).not.toContainText("at least 5 minutes apart");
    await editor(page).getByLabel("Cron expression").fill("99 * * * *");
    await expect(editor(page)).toContainText("The gateway can't read this");
  });

  test("F-195: a cron expression that never runs in the next eight years is refused at Save, and nothing is sent", async ({
    page,
  }) => {
    await open(page);
    await fillNew(page);
    await editor(page).getByText("More", { exact: true }).click();
    await editor(page).getByLabel("Cron expression").fill("0 0 8 1 1 * 2036");
    await save(page).click();
    await expect(editor(page).getByLabel("Cron expression")).toBeFocused();
    await expect(editor(page)).toContainText("This never runs in the next eight years.");
    const sent = await page.evaluate(() =>
      (
        window as unknown as { clawtrateFixture: { sent: Array<{ type: string }> } }
      ).clawtrateFixture.sent.map((each) => each.type),
    );
    expect(sent).not.toContain("createRoutine");
    await editor(page).getByLabel("Cron expression").fill("0 0 8 1 1 * 2030");
    await expect(editor(page)).not.toContainText("This never runs");
  });

  test("F-189: a refused save says why and keeps what was typed", async ({ page }) => {
    await open(page, `${ADMIN}&save=refused`);
    await fillNew(page, "Kept name");
    await save(page).click();
    await expect(editor(page).getByTestId("editor-refused")).toContainText(
      "The gateway didn't save this. invalid cron.add params: CronPattern",
    );
    await expect(editor(page).getByLabel("Name")).toHaveValue("Kept name");
    await expect(save(page)).toBeEnabled();
    await save(page).click();
    await expect(view(page).getByRole("heading", { name: "Kept name" })).toBeVisible();
  });

  test("F-189: a save with no answer is not called saved: Save goes, Check now only reads, and finds it", async ({
    page,
  }) => {
    await open(page, `${ADMIN}&save=noanswer`);
    await fillNew(page, "In doubt");
    await save(page).click();
    const note = editor(page).getByTestId("editor-unknown");
    await expect(note).toContainText("The gateway didn't answer. This may or may not have saved");
    await expect(save(page)).toHaveCount(0);
    await expect(editor(page).getByLabel("Name")).toBeDisabled();
    await note.getByRole("button", { name: "Check now" }).click();
    await expect(view(page).getByRole("heading", { name: "In doubt" })).toBeVisible();
  });

  test("F-189: a new routine that landed and was changed elsewhere is edited from what this save sent", async ({
    page,
  }) => {
    await open(page, `${ADMIN}&save=changed`);
    await fillNew(page, "Landed, then changed");
    await save(page).click();
    const unknown = editor(page).getByTestId("editor-unknown");
    await unknown.getByRole("button", { name: "Check now" }).click();
    const conflict = editor(page).getByTestId("editor-changed");
    await conflict.getByRole("button", { name: "Save mine anyway" }).click();
    await expect(editor(page)).toHaveCount(0);
    const update = await page.evaluate(() =>
      (
        window as unknown as { clawtrateFixture: { sent: Array<Record<string, unknown>> } }
      ).clawtrateFixture.sent.find((each) => each.type === "updateRoutine"),
    );
    // Edited from what was sent, so the change made elsewhere is not an edit of this draft's.
    expect((update?.original as { text: string }).text).toBe(
      "List the three articles worth reading first.",
    );
    expect((update?.edit as { text: string }).text).toBe(
      "List the three articles worth reading first.",
    );
  });

  test("F-189: while a save is out, Use my version can't swap the draft it sent", async ({
    page,
  }) => {
    await openPage(page, "Morning digest", `${ADMIN}&save=conflict`);
    await view(page).getByRole("button", { name: "Edit", exact: true }).click();
    await editor(page).getByLabel("Name").fill("Morning digest, short");
    await save(page).click();
    await editor(page)
      .getByTestId("editor-changed")
      .getByRole("button", { name: "Show the new version" })
      .click();
    const mine = editor(page).getByTestId("your-version");
    await mine.getByText("Your version").click();
    const use = mine.getByRole("button", { name: "Use my version" });
    await expect(use).toBeEnabled();
    // The next save is held: it is out, and its answer hasn't come.
    await page.evaluate(() => {
      const w = window as unknown as {
        clawtrateFixture: { invoke: (command: { type: string }) => Promise<unknown> };
      };
      const invoke = w.clawtrateFixture.invoke.bind(w.clawtrateFixture);
      w.clawtrateFixture.invoke = (command) =>
        command.type === "updateRoutine" ? new Promise(() => {}) : invoke(command);
    });
    await save(page).click();
    await expect(use).toBeDisabled();
  });

  test("F-189: a change made elsewhere while the editor is open is shown, and the person's version kept", async ({
    page,
  }) => {
    await openPage(page, "Morning digest", `${ADMIN}&save=conflict`);
    await view(page).getByRole("button", { name: "Edit", exact: true }).click();
    await editor(page).getByLabel("Name").fill("Morning digest, short");
    await save(page).click();
    const note = editor(page).getByTestId("editor-changed");
    await expect(note).toContainText("This routine was changed elsewhere while you were editing.");
    await note.getByRole("button", { name: "Show the new version" }).click();
    await expect(editor(page).getByLabel("Instruction")).toHaveValue(/Keep it to three lines\.$/u);
    await expect(editor(page).getByLabel("Name")).toHaveValue("Morning digest");
    const mine = editor(page).getByTestId("your-version");
    await mine.getByText("Your version").click();
    await expect(mine).toContainText("Morning digest, short");
    await mine.getByRole("button", { name: "Use my version" }).click();
    await expect(editor(page).getByLabel("Name")).toHaveValue("Morning digest, short");
    // Only the rename comes back: the instruction the other client wrote stays.
    await expect(editor(page).getByLabel("Instruction")).toHaveValue(/Keep it to three lines\.$/u);
    // Through the ordinary save, now compared with the new version.
    await save(page).click();
    await expect(editor(page)).toHaveCount(0);
    await expect(view(page).getByRole("heading", { name: "Morning digest, short" })).toBeVisible();
  });

  test("F-189: a schedule the form doesn't write is shown as written, and a reminder's text is shown, not edited", async ({
    page,
  }) => {
    await openPage(page, "Certificate renewal");
    await view(page).getByRole("button", { name: "Edit", exact: true }).click();
    await expect(editor(page).getByTestId("locked")).toContainText(
      "This schedule was set on the gateway.",
    );
    await editor(page).getByRole("button", { name: "Cancel" }).click();
    await view(page).getByRole("button", { name: "Back to routines" }).click();
    await row(page, "Stretch break").locator(".r-row-main").click();
    await view(page).getByRole("button", { name: "Edit", exact: true }).click();
    // A reminder's text is shown, not edited: a save never sends its payload.
    await expect(editor(page).getByRole("textbox", { name: "Reminder" })).toHaveCount(0);
    await expect(editor(page)).toContainText("Time to stand up and stretch.");
    await expect(editor(page)).toContainText("This reminder's text was set on the gateway.");
  });

  test("F-189: losing admin while editing keeps what was typed, and the next save after it is granted works", async ({
    page,
  }) => {
    await open(page);
    await fillNew(page, "Survives");
    await setAdmin(page, false);
    await expect(editor(page).getByTestId("admin-bar")).toContainText("Admin access needed.");
    await expect(save(page)).toHaveCount(0);
    await expect(editor(page).getByLabel("Name")).toHaveValue("Survives");
    await setAdmin(page, true);
    await save(page).click();
    await expect(view(page).getByRole("heading", { name: "Survives" })).toBeVisible();
  });

  test("F-189: a save before the gateway confirms its identity is refused, and the same draft saves once it is", async ({
    page,
  }) => {
    await open(page);
    const gatewayId = await connectionValue(page, "gatewayId");
    await setConnection(page, { gatewayId: null });
    await fillNew(page);
    await save(page).click();
    await expect(editor(page)).toContainText("The gateway hasn't confirmed its identity yet");
    // The gateway this draft belongs to confirms: the editor binds to it and saves.
    await setConnection(page, { gatewayId });
    await save(page).click();
    await expect(editor(page)).toHaveCount(0);
    await expect(view(page).getByRole("heading", { name: "Weekly reading list" })).toBeVisible();
  });

  test("F-189: an editor that opened while the identity was loading closes when another gateway confirms", async ({
    page,
  }) => {
    await open(page);
    const gatewayId = await connectionValue(page, "gatewayId");
    await setConnection(page, { gatewayId: null });
    await fillNew(page);
    // The gateway the draft was made on confirms while the editor is open.
    await setConnection(page, { gatewayId });
    // A replacement gateway connects: its hello, then its identity read.
    await setConnection(page, { connectedAt: Date.now() + 5_000 });
    await setConnection(page, { gatewayId: null });
    // Bound to the first gateway, the draft waits while the newcomer's identity is unknown
    // (an unbound one would have closed at the new hello, before this click is handled),
    // and its save is refused rather than sent.
    await save(page).click();
    await expect(editor(page)).toContainText("The gateway hasn't confirmed its identity yet");
    await setConnection(page, { gatewayId: "another gateway" });
    await expect(editor(page)).toHaveCount(0);
  });

  test("F-350: the switch and the page pause and resume, shown as Paused in the list", async ({
    page,
  }) => {
    await open(page);
    await row(page, "Morning digest").getByRole("switch").click();
    await expect(row(page, "Morning digest")).toContainText("Paused · Weekdays at 8:00 AM");
    await expect(page.getByTestId("b-announcer")).toHaveText("Paused Morning digest");
    await row(page, "Morning digest").locator(".r-row-main").click();
    await expect(view(page).getByTestId("routine-state")).toHaveText(
      "Paused. It won't run until resumed.",
    );
    await view(page).getByRole("button", { name: "Resume" }).click();
    await expect(view(page).getByTestId("routine-state")).toHaveText(
      "Runs weekdays at 8:00 AM, New York.",
    );
    await open(page, `${ADMIN}&pause=fail`);
    await row(page, "Morning digest").getByRole("switch").click();
    await expect(row(page, "Morning digest").locator("..").getByTestId("row-note")).toHaveText(
      "Couldn't pause: missing scope: operator.admin",
    );
    await expect(row(page, "Morning digest").getByRole("switch")).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  test("F-351: Run now runs it and reads Running until done; one in progress or refused says so", async ({
    page,
  }) => {
    await openPage(page, "Morning digest");
    await view(page).getByRole("button", { name: "Run now" }).click();
    await expect(view(page).getByTestId("routine-state")).toContainText("Running since");
    await expect(view(page).getByTestId("run-row").first()).toContainText("Running…");
    await expect(view(page).getByTestId("routine-state")).toHaveText(
      "Runs weekdays at 8:00 AM, New York.",
      { timeout: 10_000 },
    );
    await openPage(page, "Morning digest", `${ADMIN}&run=already`);
    await view(page).getByRole("button", { name: "Run now" }).click();
    await expect(view(page).getByTestId("run-note")).toHaveText("It's already running.");
    await openPage(page, "Morning digest", `${ADMIN}&run=fail`);
    await view(page).getByRole("button", { name: "Run now" }).click();
    await expect(view(page).getByTestId("run-note")).toContainText(
      "Couldn't start a run: Automation not found",
    );
    await openPage(page, "Inbox tidy-up");
    await expect(view(page).getByRole("button", { name: "Run once now" })).toBeVisible();
    // A reply that only takes the request is said queued; running is said when the run is seen.
    await openPage(page, "Morning digest", `${ADMIN}&run=held`);
    await view(page).getByRole("button", { name: "Run now" }).click();
    await expect(page.getByTestId("b-announcer")).toHaveText("Queued Morning digest");
    await expect(page.getByTestId("b-announcer")).toHaveText("Running Morning digest", {
      timeout: 10_000,
    });
  });

  test("F-352: delete asks first, says what it loses, and the routine leaves the list; a failure keeps the dialog", async ({
    page,
  }) => {
    await openPage(page, "Plan the week", `${ADMIN}&delete=fail`);
    await view(page).getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Delete…" }).click();
    const dialog = page.getByTestId("routine-delete");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(dialog.getByTestId("delete-error")).toContainText("missing scope: operator.admin");
    await openPage(page, "Plan the week");
    await view(page).getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Delete…" }).click();
    await expect(page.getByTestId("routine-delete")).toContainText(
      "Delete Plan the week?It won't run again, and Clawtrate can't show its runs afterwards. Its last run was Nov 13 at 10:40 PM.",
    );
    await page
      .getByTestId("routine-delete")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect(page.getByTestId("routine-delete")).toHaveCount(0);
    await expect(row(page, "Plan the week")).toHaveCount(0);
    await expect(page.getByTestId("b-announcer")).toHaveText("Deleted Plan the week");
  });

  test("F-192 F-352: a row's menu and a delete confirmation close when another connection's list arrives", async ({
    page,
  }) => {
    await open(page);
    const listed = (on: number) =>
      page.evaluate((on) => {
        const fixture = (
          window as unknown as {
            clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
          }
        ).clawtrateFixture;
        fixture.setState((state) => ({ ...state, routines: { ...state.routines, listedOn: on } }));
      }, on);
    // Another hello at the address: the rows shown are still the last connection's, and a
    // menu opened from them now still says so in what it sends.
    await setConnection(page, { connectedAt: Date.now() + 5_000 });
    await row(page, "Morning digest").locator(".r-row-main").click({ button: "right" });
    await expect(page.getByRole("menu")).toBeVisible();
    // This connection's list arrives: the menu from the old rows goes with them.
    await listed(1);
    await expect(page.getByRole("menu")).toHaveCount(0);
    await row(page, "Morning digest").locator(".r-row-main").click({ button: "right" });
    await page.getByRole("menu").getByRole("menuitem", { name: "Delete…" }).click();
    await expect(page.getByTestId("routine-delete")).toBeVisible();
    await listed(2);
    await expect(page.getByTestId("routine-delete")).toHaveCount(0);
  });

  test("F-350: a row's action sends the list it was shown from", async ({ page }) => {
    await open(page);
    await row(page, "Morning digest").getByRole("switch").click();
    const sent = await page.evaluate(() =>
      (
        window as unknown as { clawtrateFixture: { sent: Array<Record<string, unknown>> } }
      ).clawtrateFixture.sent.find((each) => each.type === "setRoutineEnabled"),
    );
    expect(sent).toMatchObject({ type: "setRoutineEnabled", listedOn: 0 });
  });

  test("F-192: right-click, Shift+F10 or the Menu key on a routine offers Open, Pause or Resume, Run now, Edit and Delete", async ({
    page,
  }) => {
    await open(page);
    await row(page, "Morning digest").locator(".r-row-main").click({ button: "right" });
    await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText([
      "Open",
      "Pause",
      "Run now",
      "Edit…",
      "Delete…",
    ]);
    await page.keyboard.press("Escape");
    await row(page, "Inbox tidy-up").locator(".r-row-main").focus();
    await page.keyboard.press("Shift+F10");
    await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText([
      "Open",
      "Resume",
      "Run once now",
      "Edit…",
      "Delete…",
    ]);
    await page.getByRole("menuitem", { name: "Edit…" }).click();
    await expect(editor(page).getByLabel("Name")).toHaveValue("Inbox tidy-up");
  });

  test("F-196: a bot's routines' time zone is said over them, and Change rewrites each routine's zone the form can write", async ({
    page,
  }) => {
    await open(page);
    await view(page).getByRole("combobox", { name: "Bots" }).selectOption({ label: "Otto" });
    const line = view(page).getByTestId("routines-zone");
    await expect(line).toContainText("Routines' time zone: New York");
    await line.getByRole("button", { name: "Change…" }).click();
    const dialog = page.getByTestId("routines-zone-dialog");
    await expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
    await expect(dialog).toContainText("Leaves Disk space watch, Certificate renewal as they are");
    await dialog.getByLabel("Time zone").selectOption("Europe/Berlin");
    await expect(dialog).toContainText("Changes Nightly backup check.");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(line).toContainText("Routines' time zone: Berlin");
    await expect(row(page, "Nightly backup check")).toContainText("Every day at 3:30 AM, Berlin");
  });

  test("F-349 F-358: with admin and the gateway's hooks on, the page shows their address to copy; a routine has none of its own", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openPage(page, "Morning digest", `${ADMIN}&hooks=on`);
    const facts = view(page).getByTestId("routine-facts");
    await expect(facts).toContainText(
      "This gateway's webhooks start a bot directly, not a routine.",
    );
    const hooks = view(page).getByTestId("gateway-hooks");
    await hooks.getByText("Gateway webhooks").click();
    await expect(hooks).toContainText("POST to http://127.0.0.1:18789/hooks/agent");
    await expect(hooks).toContainText("Key: kept on the gateway.");
    await hooks.getByRole("button", { name: "Copy the webhook address" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "http://127.0.0.1:18789/hooks/agent",
    );
    await openPage(page, "Morning digest");
    await expect(view(page).getByTestId("gateway-hooks")).toHaveCount(0);
    await openPage(page, "Morning digest", `${READ}&hooks=on`);
    await expect(view(page).getByTestId("gateway-hooks")).toHaveCount(0);
  });

  test("without admin nothing that writes is offered anywhere, and the foot says how to ask for admin", async ({
    page,
  }) => {
    await open(page, READ);
    await expect(view(page).getByRole("switch")).toHaveCount(0);
    await expect(view(page).getByTestId("new-routine")).toHaveCount(0);
    await expect(view(page).getByTestId("admin-bar")).toContainText(
      "Read-only. Creating and changing routines needs admin access.",
    );
    await expect(
      view(page).getByTestId("admin-bar").getByRole("button", { name: "Request admin access" }),
    ).toBeVisible();
    await row(page, "Morning digest").locator(".r-row-main").click({ button: "right" });
    await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText(["Open"]);
    await page.keyboard.press("Escape");
    await row(page, "Morning digest").locator(".r-row-main").click();
    await expect(view(page).getByTestId("routine-actions")).toHaveCount(0);
    await expect(page.getByTestId("routine-editor")).toHaveCount(0);
    await view(page).getByRole("button", { name: "Back to routines" }).click();
    await view(page).getByRole("combobox", { name: "Bots" }).selectOption({ label: "Otto" });
    await expect(view(page).getByTestId("routines-zone")).not.toContainText("Change");
  });

  test("admin is asked for only by its button, and once granted the controls appear", async ({
    page,
  }) => {
    await open(page, `${READ}&admin=grant`);
    await expect(view(page).getByTestId("admin-bar")).toContainText("Read-only.");
    await view(page)
      .getByTestId("admin-bar")
      .getByRole("button", { name: "Request admin access" })
      .click();
    await expect(view(page).getByTestId("admin-bar")).toContainText("Admin access granted.");
    await expect(view(page).getByRole("switch")).toHaveCount(8);
    await expect(view(page).getByTestId("new-routine")).toBeVisible();
  });

  test("deleting a routine elsewhere while its page is open leaves no controls that change it", async ({
    page,
  }) => {
    await openPage(page, "Plan the week");
    await expect(view(page).getByTestId("routine-actions")).toBeVisible();
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
        }
      ).clawtrateFixture;
      fixture.setState((state) => ({
        ...state,
        routines: {
          ...state.routines,
          routines: state.routines.routines.filter((each) => each.name !== "Plan the week"),
        },
      }));
    });
    await expect(view(page).getByTestId("routine-deleted")).toBeVisible();
    await expect(view(page).getByTestId("routine-actions")).toHaveCount(0);
  });
});

test.describe("phone", () => {
  test.use(contextFor(size("phone"), "light"));

  test("F-191: on the phone New routine is a round button named for what it makes", async ({
    page,
  }) => {
    await open(page);
    await expect(view(page).getByRole("button", { name: "New routine" })).toBeVisible();
    await view(page).getByRole("combobox", { name: "Bots" }).selectOption({ label: "Otto" });
    await expect(
      view(page).getByRole("button", { name: "New routine for Otto" }).first(),
    ).toBeVisible();
  });
});
