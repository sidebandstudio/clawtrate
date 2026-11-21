// The Computer tab's behaviour on fixed state (work-pane.md, Part 3): the
// keyboard and focus of the full view, input that reaches the page only while
// held, the hand-back before an answer, a read-only connection, and leaving.
// The fixture answers with the engine itself and a scripted computer plugin.
// Test names carry the parity rows they prove.
import { expect, test, type Page } from "@playwright/test";
import { contextFor, NOW, openFixture, SIZES } from "./fixture.ts";
import {
  COMPUTER,
  computerPanel,
  control,
  controlBar,
  fullView,
  openFull,
  OTTO_COMPUTER,
  painted,
  take,
  tileReady,
  watch,
} from "./computer-helpers.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.phone)!;

type Sent = { type: string; [key: string]: unknown };
const sent = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { clawtrateFixture: { sent: Sent[] } }).clawtrateFixture.sent,
  );
const sentOf = async (page: Page, type: string) =>
  (await sent(page)).filter((each) => each.type === type);
const pane = (page: Page) =>
  page.evaluate(() => {
    const state = (
      window as unknown as {
        clawtrateFixture: { getState(): { computer?: { panes: Record<string, unknown> } } };
      }
    ).clawtrateFixture.getState();
    return state.computer?.panes["fixture-viewer"] as
      | { view: { status: string } | null; control: { status: string; released: boolean } }
      | undefined;
  });

test.describe("the full view on the desktop", () => {
  test.use(contextFor(WIDE, "light"));

  test("F-142: nothing is drawn until Watch; Escape in Watching closes the full view, focus returns to Open, and watching continues", async ({
    page,
  }) => {
    await openFixture(page, `${COMPUTER}&computer=watching`, "light");
    await tileReady(page);
    expect(await sentOf(page, "computerWatch")).toEqual([]);
    await expect(computerPanel(page).locator("canvas")).toHaveCount(0);
    await openFull(page);
    await expect(fullView(page)).toHaveAttribute("role", "dialog");
    await expect(fullView(page).getByText("Watching", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(fullView(page)).toHaveCount(0);
    await expect(
      computerPanel(page).getByRole("button", { name: "Open Juniper's browser full window" }),
    ).toBeFocused();
    expect((await pane(page))?.view?.status).toBe("live");
  });

  test("F-142: in control, Escape moves focus to Give back control and never ends control; the collapse control keeps control, shown in the tile with Give back control", async ({
    page,
  }) => {
    await openFixture(page, `${COMPUTER}&computer=control`, "light");
    await control(page);
    // You have control is never alone: its second line stands under it.
    await expect(controlBar(page)).toContainText(
      "You have control" +
        "Juniper's new browser actions are paused. Something it already started can still change this page." +
        "I'm done" +
        "Skip" +
        "Give back control",
    );
    await fullView(page).getByTestId("screen-frame").focus();
    await page.keyboard.press("Escape");
    await expect(controlBar(page).getByRole("button", { name: "Give back control" })).toBeFocused();
    await expect(fullView(page)).toBeVisible();
    expect((await pane(page))?.control.status).toBe("granted");
    expect(await sentOf(page, "computerRelease")).toEqual([]);
    await fullView(page).getByRole("button", { name: "Close the full view (Esc)" }).click();
    await expect(fullView(page)).toHaveCount(0);
    const tile = computerPanel(page).getByTestId("computer-tile-control");
    await expect(tile).toContainText("You have control.");
    await expect(tile).toContainText("Juniper's new browser actions are paused.");
    await tile.getByRole("button", { name: "Give back control" }).click();
    await expect.poll(async () => (await pane(page))?.control.status).toBe("none");
  });

  test("F-142: typed text, clicks and scrolling reach the page only while this viewer holds control and the picture has focus; Enter is not sent; a paste goes only on a paste", async ({
    page,
  }) => {
    await openFixture(page, `${COMPUTER}&computer=control`, "light");
    await openFull(page);
    const frame = fullView(page).getByTestId("screen-frame");
    await frame.focus();
    await page.keyboard.type("no");
    await frame.click();
    expect(await sentOf(page, "computerInput")).toEqual([]);
    await take(page);
    await expect(controlBar(page)).toContainText("You have control");
    await frame.click({ position: { x: 100, y: 50 } });
    await page.keyboard.type("4821");
    await page.keyboard.press("Enter");
    await expect(
      fullView(page).getByRole("status").filter({ hasText: "Enter isn't sent to the page." }),
    ).toBeVisible();
    await page.mouse.wheel(0, 200);
    await frame.evaluate((element) => {
      const data = new DataTransfer();
      data.setData("text/plain", "pasted");
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
    });
    await expect
      .poll(async () => (await sentOf(page, "computerInput")).length)
      .toBeGreaterThanOrEqual(7);
    const inputs = (await sentOf(page, "computerInput")).map(
      (each) => each.input as { kind: string; text?: string; x?: number },
    );
    expect(inputs[0]).toMatchObject({ kind: "click" });
    // Mapped from the picture to the page's own pixels (1280 wide).
    expect(inputs[0]!.x).toBeGreaterThan(50);
    expect(
      inputs
        .filter((each) => each.kind === "text")
        .map((each) => each.text)
        .join(""),
    ).toBe("4821pasted");
    expect(inputs.some((each) => each.kind === "scroll")).toBe(true);
    // Focus leaves the picture: typing no longer reaches the page.
    await fullView(page).getByRole("button", { name: "Give back control" }).focus();
    const before = (await sentOf(page, "computerInput")).length;
    await page.keyboard.type("x");
    expect((await sentOf(page, "computerInput")).length).toBe(before);
  });

  test("F-142: a click is mapped with the picture on screen: a newer frame of a resized page that was never drawn changes nothing", async ({
    page,
  }) => {
    await openFixture(page, `${COMPUTER}&computer=resized`, "light");
    await control(page);
    const frame = fullView(page).getByTestId("screen-frame");
    await frame.focus();
    // The page is now half as wide, in a frame that can't be decoded: the 1280-wide picture stays.
    await page.keyboard.type("x");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                clawtrateFixture: {
                  getState(): { computer?: { panes: Record<string, { view: { width: number } }> } };
                };
              }
            ).clawtrateFixture.getState().computer?.panes["fixture-viewer"]?.view.width,
        ),
      )
      .toBe(640);
    const canvas = fullView(page).locator("canvas");
    const box = (await canvas.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(async () => (await sentOf(page, "computerInput")).length).toBe(2);
    const click = (await sentOf(page, "computerInput"))[1]!.input as { kind: string; x: number };
    expect(click.kind).toBe("click");
    // The middle of the 1280-wide picture on screen, not of the 640-wide page not yet drawn.
    expect(Math.abs(click.x - 640)).toBeLessThanOrEqual(8);
  });

  test("F-145: choosing an answer gives control back first; the answer goes once the release is confirmed, and the bot can carry on", async ({
    page,
  }) => {
    await openFixture(page, `${COMPUTER}&computer=control`, "light");
    await control(page);
    await controlBar(page).getByRole("button", { name: "I'm done" }).click();
    await expect(controlBar(page)).toContainText(
      /Giving control back…|Sending your answer…|Answer sent/,
    );
    await expect(controlBar(page)).toContainText("Answer sent. Juniper can carry on.");
    const release = (await sentOf(page, "computerRelease"))[0]!;
    expect(release.answer).toEqual({ questionId: "ask_library_sign_in", itemId: "q1", option: 0 });
    await expect(fullView(page).getByText("Watching", { exact: true })).toBeVisible();
  });

  test("F-145: a release that is refused leaves ownership unknown with Try again and Check; Check finds control still held", async ({
    page,
  }) => {
    await openFixture(page, `${COMPUTER}&computer=releasefail`, "light");
    await control(page);
    await controlBar(page).getByRole("button", { name: "I'm done" }).click();
    await expect(controlBar(page)).toContainText(
      "Giving control back wasn't confirmed. This device may still have control of Juniper's browser.",
    );
    await expect(controlBar(page)).toContainText(
      "Your answer wasn't sent. Answer in the chat once control is given back.",
    );
    await expect(fullView(page).getByText("Watching", { exact: true })).toHaveCount(0);
    await expect(fullView(page).getByRole("button", { name: "Take control" })).toHaveCount(0);
    await controlBar(page).getByRole("button", { name: "Check" }).click();
    await expect(fullView(page).getByText("You still have control.")).toBeVisible();
  });

  test("F-145: a question the bar cannot answer is answered in the chat after control is given back", async ({
    page,
  }) => {
    await openFixture(page, `${COMPUTER}&computer=complexquestion`, "light");
    await control(page);
    await controlBar(page).getByRole("button", { name: "Give back control and answer" }).click();
    await expect(fullView(page)).toHaveCount(0);
    await expect.poll(async () => (await pane(page))?.control.status).toBe("none");
    await expect(page.locator(".transcript [data-testid=question-card]").last()).toBeInViewport();
  });

  test("F-145: answering in the chat goes to the question it was offered for, not a later card below it", async ({
    page,
  }) => {
    await openFixture(page, `${COMPUTER}&computer=complexlater`, "light");
    await control(page);
    await controlBar(page).getByRole("button", { name: "Give back control and answer" }).click();
    await expect(fullView(page)).toHaveCount(0);
    const card = page.locator("#card-question-ask_library_sign_in");
    await expect(card).toBeInViewport();
    await expect
      .poll(() => card.evaluate((element) => element.contains(document.activeElement)))
      .toBe(true);
  });

  test("F-144: the waiting banner's Take control opens the full view and asks for control; Show the question goes to the card", async ({
    page,
  }) => {
    await openFixture(page, `${COMPUTER}&computer=control`, "light");
    const banner = computerPanel(page).getByTestId("computer-banner");
    await expect(banner).toContainText("Juniper is waiting for you");
    await expect(banner).toContainText(
      "Sign in to your library account, then hand the browser back.",
    );
    await banner.getByRole("button", { name: "Show the question" }).click();
    await expect(page.locator("#card-question-ask_library_sign_in")).toBeInViewport();
    await banner.getByRole("button", { name: "Take control" }).click();
    await expect(fullView(page)).toBeVisible();
    await expect(controlBar(page)).toContainText("You have control");
  });

  test("F-142: Cancel while waiting withdraws the take; nothing says You have control", async ({
    page,
  }) => {
    await openFixture(page, `${COMPUTER}&computer=draining`, "light");
    await openFull(page);
    await take(page);
    await expect(controlBar(page)).toContainText("Waiting for the gateway to confirm control…");
    await expect(controlBar(page).getByRole("button", { name: "Cancel" })).toBeFocused();
    await controlBar(page).getByRole("button", { name: "Cancel" }).click();
    await expect(fullView(page).getByText("Watching", { exact: true })).toBeVisible();
    expect(await sentOf(page, "computerCancelTake")).toHaveLength(1);
  });

  test("F-142: Live only while a usable picture arrived within 10 s; on a quiet page the tile and the full view say the last picture's age by themselves", async ({
    page,
  }) => {
    // The fixture's stream sends one frame and, with nothing typed, no other, while its
    // renewals go on answering. The fixture's clock is fixed: the check moves it on.
    await openFixture(page, `${COMPUTER}&computer=watching`, "light");
    await watch(page);
    const badge = computerPanel(page).locator(".screen-live");
    await expect(badge).toHaveText("Live");
    await page.clock.setFixedTime(new Date(NOW.getTime() + 9_000));
    await page.waitForTimeout(1_500);
    await expect(badge).toHaveText("Live");
    await page.clock.setFixedTime(new Date(NOW.getTime() + 12_000));
    await expect(badge).toHaveText("Last picture, 12 s ago");
    const tile = computerPanel(page).getByTestId("computer-tile");
    // Only the picture is the image: the tile's buttons are not inside it.
    await expect(tile.locator("[role=img] button")).toHaveCount(0);
    await expect(tile.getByRole("button", { name: "Stop watching" })).toBeVisible();
    await expect(tile.getByRole("img")).toHaveAccessibleName(
      /^Juniper's browser, last picture, 12 s ago: /,
    );
    expect((await pane(page))?.view?.status).toBe("live");
    await computerPanel(page)
      .getByRole("button", { name: "Open Juniper's browser full window" })
      .click();
    await expect(fullView(page).locator(".screen-age")).toHaveText("Last picture, 12 s ago");
    await expect(fullView(page).getByTestId("screen-frame")).toHaveAccessibleName(
      "Juniper's browser, last picture, 12 s ago",
    );
    await page.clock.setFixedTime(new Date(NOW.getTime() + 75_000));
    await expect(fullView(page).locator(".screen-age")).toHaveText("Last picture, 1 min ago");
  });

  test("F-142: another device's take that is still waiting for the bot is asking for control, never has control", async ({
    page,
  }) => {
    await openFixture(page, `${COMPUTER}&computer=elsewhere-taking`, "light");
    await tileReady(page);
    await expect(computerPanel(page).getByTestId("computer-elsewhere")).toHaveText(
      "Someone on another device is asking for control of Juniper's browser.",
    );
    await expect(page.getByText(/has control of Juniper's browser/)).toHaveCount(0);
  });

  test("leaving the Computer tab while in control gives control back first, then ends the view", async ({
    page,
  }) => {
    await openFixture(page, `${COMPUTER}&computer=control`, "light");
    await control(page);
    await fullView(page).getByRole("button", { name: "Close the full view (Esc)" }).click();
    await page.getByRole("tab", { name: "Files" }).click();
    await expect.poll(async () => (await pane(page))?.control.status).toBe("none");
    expect((await pane(page))?.view).toBeNull();
    expect(await sentOf(page, "computerLeave")).not.toHaveLength(0);
  });

  test("Show live when I open Computer is kept for the bot, and starts watching when the tab opens", async ({
    page,
  }) => {
    await openFixture(page, `${COMPUTER}&computer=watching`, "light");
    await tileReady(page);
    await computerPanel(page).getByLabel("Show live when I open Computer").check();
    await page.getByRole("tab", { name: "Files" }).click();
    await page.getByRole("tab", { name: "Computer" }).click();
    await expect(computerPanel(page).locator(".screen[data-state=live]")).toBeVisible();
  });

  test("with Show live on, leaving the Computer tab leaves the view closed: nothing asks to watch until it is shown again", async ({
    page,
  }) => {
    await openFixture(page, `${COMPUTER}&computer=watching`, "light");
    await tileReady(page);
    await computerPanel(page).getByLabel("Show live when I open Computer").check();
    await expect(computerPanel(page).locator(".screen[data-state=live]")).toBeVisible();
    const watches = (await sentOf(page, "computerWatch")).length;
    await page.getByRole("tab", { name: "Files" }).click();
    await expect.poll(async () => (await pane(page))?.view ?? null).toBeNull();
    await page.waitForTimeout(800);
    expect(await sentOf(page, "computerWatch")).toHaveLength(watches);
    expect((await pane(page))?.view ?? null).toBeNull();
    await page.getByRole("tab", { name: "Computer" }).click();
    await expect(computerPanel(page).locator(".screen[data-state=live]")).toBeVisible();
    expect(await sentOf(page, "computerWatch")).toHaveLength(watches + 1);
  });

  test("the one-time note before the first watch goes for good", async ({ page }) => {
    await openFixture(page, `${COMPUTER}&computer=watching&firstwatch=1`, "light");
    await expect(computerPanel(page).getByTestId("computer-first-watch")).toContainText(
      "This is Juniper's browser, used by all of Juniper's tasks. It may be signed in to sites, and what you see here is live: anyone who can see your screen sees it too.",
    );
    await watch(page);
    await computerPanel(page).getByRole("button", { name: "Stop watching" }).click();
    await expect(computerPanel(page).getByTestId("computer-first-watch")).toHaveCount(0);
  });
});

test.describe("a read-only connection (section 19)", () => {
  test.use(contextFor(WIDE, "light"));

  test("F-141: never asks for a view, never opens the full view and offers Request access", async ({
    page,
  }) => {
    await openFixture(page, `${COMPUTER}&computer=control&access=read`, "light");
    await expect(
      computerPanel(page).getByText(
        "Watching needs a connection that can send. This device is read-only.",
      ),
    ).toBeVisible();
    await expect(computerPanel(page).getByRole("button", { name: "Request access" })).toBeVisible();
    await expect(computerPanel(page).getByRole("button", { name: /^Watch/ })).toHaveCount(0);
    await expect(computerPanel(page).getByTestId("computer-banner")).toHaveCount(0);
    await expect(fullView(page)).toHaveCount(0);
    for (const type of ["computerWatch", "computerTake", "computerInput"])
      expect(await sentOf(page, type)).toEqual([]);
  });
});

test.describe("the computer button, recovery and the machine", () => {
  test.use(contextFor(WIDE, "light"));

  test("F-139: the header's computer button opens the pane on Computer with focus on its tab, and says when the browser is in use", async ({
    page,
  }) => {
    await openFixture(
      page,
      `scene=main&bot=main&task=agent:main:ebook-apps&panel=closed&tab=files&computer=active`,
      "light",
    );
    const button = page.getByTestId("computer-button");
    await expect(button).toHaveAccessibleName("Juniper's computer, in use. Show the computer");
    await expect(button).toHaveAttribute("data-active", "true");
    await button.click();
    await expect(page.getByRole("tab", { name: "Computer, in use" })).toBeFocused();
    await expect(page.getByRole("tab", { name: "Computer, in use" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  test("the Computer tab asks the gateway nothing while another tab of the pane is shown", async ({
    page,
  }) => {
    await openFixture(
      page,
      `${COMPUTER.replace("tab=computer", "tab=files")}&computer=watching`,
      "light",
    );
    await expect(page.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
    await page.waitForTimeout(500);
    for (const type of ["readMachine", "computerShow", "computerTabs", "computerWatch"])
      expect(await sentOf(page, type), type).toEqual([]);
    await page.getByRole("tab", { name: "Computer" }).click();
    await tileReady(page);
    expect(await sentOf(page, "computerShow")).toHaveLength(1);
    expect((await sentOf(page, "readMachine")).length).toBeGreaterThan(0);
  });

  test("F-139: a task that never used the browser has no computer button", async ({ page }) => {
    await openFixture(page, `${COMPUTER}&computer=unused`, "light");
    await expect(page.getByTestId("computer-button")).toHaveCount(0);
  });

  test("F-149: after three refusals for the same reason the tab offers to stop the bot in this task, after a confirmation that says what keeps going", async ({
    page,
  }) => {
    await openFixture(page, `${COMPUTER}&computer=stuck`, "light");
    await openFull(page);
    await take(page);
    for (let i = 0; i < 2; i++) {
      await expect(controlBar(page)).toContainText("Juniper is still acting");
      await controlBar(page).getByRole("button", { name: "Try again" }).click();
    }
    await expect(controlBar(page)).toContainText("Juniper is still acting");
    await page.keyboard.press("Escape");
    await expect(fullView(page)).toHaveCount(0);
    const stuck = computerPanel(page).getByTestId("computer-stuck");
    await expect(stuck).toContainText("The last three requests didn't give you control.");
    await stuck.getByRole("button", { name: "Stop Juniper in this task" }).click();
    const confirm = computerPanel(page).getByRole("alertdialog", {
      name: "Stop Juniper in this task?",
    });
    await expect(confirm).toContainText(
      "Steps already done stay done. The request affects only this task.",
    );
    await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
    await confirm.getByRole("button", { name: "Stop", exact: true }).click();
    // Accepted, the run still stopping: Stopping, never Stopped, until the run's own end.
    const line = computerPanel(page).getByTestId("computer-stopped");
    await expect(line).toHaveText("Stopping Juniper's runs in this task…");
    await expect(line).toHaveText("Stopped Juniper's runs in this task.");
    expect(await sentOf(page, "computerStopTask")).toHaveLength(1);
  });

  test("F-149: a stop the gateway refuses says so, keeps the run as it was and offers Stop again; it never says Stopped", async ({
    page,
  }) => {
    await openFixture(page, `${COMPUTER}&computer=stuck-refused`, "light");
    await openFull(page);
    await take(page);
    for (let i = 0; i < 2; i++) {
      await expect(controlBar(page)).toContainText("Juniper is still acting");
      await controlBar(page).getByRole("button", { name: "Try again" }).click();
    }
    await expect(controlBar(page)).toContainText("Juniper is still acting");
    await page.keyboard.press("Escape");
    await computerPanel(page)
      .getByTestId("computer-stuck")
      .getByRole("button", { name: "Stop Juniper in this task" })
      .click();
    await computerPanel(page)
      .getByRole("alertdialog", { name: "Stop Juniper in this task?" })
      .getByRole("button", { name: "Stop", exact: true })
      .click();
    const stuck = computerPanel(page).getByTestId("computer-stuck");
    await expect(stuck).toContainText(
      "Couldn't stop Juniper's runs in this task. The gateway refused to stop this run.",
    );
    await expect(stuck.getByRole("button", { name: "Stop Juniper in this task" })).toBeVisible();
    await expect(page.getByText(/Stopped Juniper's runs/)).toHaveCount(0);
  });

  test("F-147 F-148 F-150: the machine keeps the approval target, where commands ran and the setting apart; a node that is not connected says so with Check again", async ({
    page,
  }) => {
    await openFixture(page, `${OTTO_COMPUTER}&computer=offline`, "light");
    const machine = computerPanel(page).getByTestId("computer-machine");
    await expect(machine).toContainText("Command approval target");
    await expect(machine).toContainText("Commands ran on" + "media-box");
    await expect(machine).toContainText(
      "Set for Otto" + "Commands: media-box" + "A setting for Otto. A task can run somewhere else.",
    );
    await expect(machine.getByTestId("computer-node")).toContainText("Not connected");
    await expect(machine.getByTestId("computer-node")).toContainText("while going to sleep");
    await expect(machine.getByTestId("computer-node")).not.toContainText("Reconnecting");
    await machine.getByRole("button", { name: "Check again" }).click();
    await expect(machine).toContainText(/Checked \d+:\d\d (AM|PM)/);
    // No recover, reset or update of a machine is offered.
    await expect(
      computerPanel(page).getByRole("button", { name: /Recover|Reset|Update/ }),
    ).toHaveCount(0);
  });

  test("F-150: when the gateway's own desktop isn't available, Prepare it again asks the gateway to prepare it, and nothing else does", async ({
    page,
  }) => {
    await openFixture(page, `${OTTO_COMPUTER}&computer=desktop`, "light");
    const machine = computerPanel(page).getByTestId("computer-machine");
    await expect(machine).toContainText(
      "The gateway's desktop isn't available. No display is attached.",
    );
    const reads = await sentOf(page, "readMachine");
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((each) => each.probe === false)).toBe(true);
    await machine.getByRole("button", { name: "Prepare it again" }).click();
    await expect(machine).not.toContainText("The gateway's desktop isn't available.");
    expect((await sentOf(page, "readMachine")).filter((each) => each.probe === true)).toHaveLength(
      1,
    );
  });

  test("F-147: a setting the gateway hasn't resolved says so as it is stored, never the gateway's machine", async ({
    page,
  }) => {
    await openFixture(page, `${COMPUTER}&computer=watching`, "light");
    const machine = computerPanel(page).getByTestId("computer-machine");
    await expect(machine).toContainText(
      "Set for Juniper" +
        "Commands: not set" +
        "Not resolved: the gateway chooses where each of Juniper's commands runs. Where one ran is only in its own result.",
    );
    await expect(machine.locator(".machine-setting")).not.toContainText("the gateway's machine");
  });

  test("F-147: Node settings opens Settings on Machines, where the node's settings are", async ({
    page,
  }) => {
    await openFixture(page, `${OTTO_COMPUTER}&computer=offline`, "light");
    const machine = computerPanel(page).getByTestId("computer-machine");
    await machine.getByRole("button", { name: "Node settings for media-box" }).click();
    await expect(page.locator("#b-section-title")).toHaveText("Machines");
  });

  test("F-148: a first read that fails says so and can be read again", async ({ page }) => {
    await openFixture(page, `${OTTO_COMPUTER}&computer=machinefirstfail`, "light");
    const machine = computerPanel(page).getByTestId("computer-machine");
    const failed = machine.getByTestId("computer-machine-failed");
    await expect(failed).toContainText("Couldn't read this.");
    await failed.getByRole("button", { name: "Check again" }).click();
    await expect(failed).toHaveCount(0);
    await expect(machine.getByTestId("computer-node")).toContainText("Connected");
  });

  test("F-148: after a read that fails, or with the connection dropped, the facts are the last read at their time, never current", async ({
    page,
  }) => {
    await openFixture(page, `${OTTO_COMPUTER}&computer=machinefail`, "light");
    const machine = computerPanel(page).getByTestId("computer-machine");
    const node = machine.getByTestId("computer-node");
    await expect(node).toContainText("Connected");
    await expect(machine.getByTestId("computer-machine-stale")).toHaveCount(0);
    // Shown again, the tab reads again, and that read fails.
    await page.getByRole("tab", { name: "Files" }).click();
    await page.getByRole("tab", { name: "Computer" }).click();
    await expect(machine.getByTestId("computer-machine-stale")).toHaveText(
      /^Couldn't read this again\. As read at \d+:\d\d (AM|PM)\.$/,
    );
    await expect(node).toContainText(/Connected when last read, \d+:\d\d (AM|PM)/);
    await page.evaluate(() =>
      (
        window as unknown as {
          clawtrateFixture: {
            setState(change: (s: { connection: object }) => object): void;
          };
        }
      ).clawtrateFixture.setState((s) => ({
        ...s,
        connection: { ...s.connection, status: "reconnecting" },
      })),
    );
    await expect(machine.getByTestId("computer-machine-stale")).toHaveText(
      /^Not connected to the gateway\. As read at \d+:\d\d (AM|PM)\.$/,
    );
  });

  test("F-148: a node record that couldn't be read is Unknown, never Not connected", async ({
    page,
  }) => {
    await openFixture(page, `${OTTO_COMPUTER}&computer=nodeunknown`, "light");
    const node = computerPanel(page).getByTestId("computer-node");
    await expect(node).toContainText("Unknown");
    await expect(node).not.toContainText("Not connected");
  });

  test("F-153 F-154: commands with how each ended and its duration, and recent actions newest first, each one step from the chat", async ({
    page,
  }) => {
    await openFixture(page, `${OTTO_COMPUTER}&computer=watching`, "light");
    const commands = computerPanel(page).getByTestId("computer-commands");
    await expect(commands.locator(".command-row").first()).toContainText(
      "mv /var/lib/transcode-cache /var/lib/transcode-cache.old",
    );
    await expect(commands.locator(".command-row").first()).toContainText("exit 0 · 0.4s");
    await expect(commands.locator(".command-row").nth(1)).toContainText("exit 0 · 6.2s");
    const actions = computerPanel(page).getByTestId("computer-actions");
    await expect(actions.getByRole("button").first()).toHaveAccessibleName(
      /, \d+:\d\d (AM|PM)\. Show in chat$/,
    );
    // The link reaches the step itself in the chat: the command's own call, open and focused.
    await commands
      .getByRole("button", {
        name: "Show mv /var/lib/transcode-cache /var/lib/transcode-cache.old in the chat",
      })
      .click();
    const focused = page.locator(".transcript [data-call]:focus-within");
    await expect(focused).toHaveCount(1);
    await expect(focused).toContainText("transcode-cache");
    await actions.getByRole("button").first().click();
    await expect(page.locator(".transcript [data-call]:focus-within")).toHaveCount(1);
  });
});

test.describe("the full view on the phone (section 18, On the phone)", () => {
  test.use(contextFor(PHONE, "light"));

  test("F-142: in control the page opens at its own size; zoom is the device's own; the dock keeps You have control with its second line", async ({
    page,
  }) => {
    await openFixture(page, `${COMPUTER}&computer=control`, "light");
    await openFull(page);
    const fitted = await fullView(page)
      .locator(".screen-zoom-inner")
      .evaluate((el) => el.clientWidth);
    await fullView(page)
      .locator(".control-dock")
      .getByRole("button", { name: "Take control" })
      .click();
    await expect(fullView(page).locator(".control-dock")).toContainText(
      "You have control" +
        "Juniper's new browser actions are paused. Something it already started can still change this page.",
    );
    await expect
      .poll(() =>
        fullView(page)
          .locator(".screen-zoom-inner")
          .evaluate((el) => el.clientWidth),
      )
      .toBe(1280);
    expect(fitted).toBeLessThan(400);
    await fullView(page).getByRole("button", { name: "Zoom out" }).click();
    expect(await sentOf(page, "computerInput")).toEqual([]);
    await fullView(page).getByRole("button", { name: "Type into the page" }).click();
    await fullView(page)
      .getByRole("textbox", { name: "Type into the page" })
      .pressSequentially("ab");
    await expect.poll(async () => (await sentOf(page, "computerInput")).length).toBeGreaterThan(0);
    await fullView(page).getByRole("textbox", { name: "Type into the page" }).press("Enter");
    await expect(
      fullView(page).getByText("Enter isn't sent to the page. Tap the page's button instead."),
    ).toBeVisible();
    await fullView(page).getByRole("button", { name: "Done", exact: true }).click();
    await expect(fullView(page).getByRole("textbox", { name: "Type into the page" })).toHaveCount(
      0,
    );
  });
});

test.describe("closing edits", () => {
  test.use(contextFor(WIDE, "light"));

  test("F-142: choosing another tab while Computer stays open opens a view of it, and a take there is granted; a full view with no view open says so and offers Watch", async ({
    page,
  }) => {
    await openFixture(page, `${COMPUTER}&computer=control`, "light");
    await openFull(page);
    const pills = fullView(page).getByRole("group", { name: "Tabs" });
    await pills.getByRole("button", { name: "Lending apps" }).click();
    // The view of the new tab: its title, and its picture.
    await expect(fullView(page).locator(".viewer-title")).toContainText("Lending apps");
    await expect(fullView(page).getByText("Watching", { exact: true })).toBeVisible();
    await painted(fullView(page).locator("canvas"));
    await take(page);
    await expect(controlBar(page)).toContainText("You have control");
    expect(await sentOf(page, "computerTake")).toHaveLength(1);

    // The view ends, then another tab is chosen: nothing is being watched, and the view says so.
    await page.goto("about:blank");
    await openFixture(page, `${COMPUTER}&computer=ended`, "light");
    await openFull(page);
    await expect(fullView(page)).toContainText("The view ended.");
    await fullView(page)
      .getByRole("group", { name: "Tabs" })
      .getByRole("button", { name: "Lending apps" })
      .click();
    await expect(fullView(page)).toContainText("No view open");
    await expect(fullView(page).getByText("Watching", { exact: true })).toHaveCount(0);
    await expect(fullView(page)).not.toContainText("Connecting to Juniper's browser");
    await fullView(page).getByRole("button", { name: "Watch", exact: true }).click();
    await expect(fullView(page).getByText("Watching", { exact: true })).toBeVisible();
  });

  test("F-142: a refused take while another request waits says who is asking, never that anyone has control, and the line goes once that request ends", async ({
    page,
  }) => {
    await openFixture(page, `${COMPUTER}&computer=conflict-window`, "light");
    await openFull(page);
    await take(page);
    await expect(controlBar(page)).toContainText(
      "Another window of this app is asking for control of Juniper's browser.",
    );
    await expect(page.getByText(/has control of Juniper's browser/)).toHaveCount(0);

    await page.goto("about:blank");
    await openFixture(page, `${COMPUTER}&computer=conflict-ends`, "light");
    await openFull(page);
    await take(page);
    await expect(controlBar(page)).toContainText(
      "Someone on another device is asking for control of Juniper's browser.",
    );
    await expect(controlBar(page)).toHaveCount(0, { timeout: 10_000 });
    await expect(fullView(page).getByRole("button", { name: "Take control" })).toBeVisible();
  });

  test("F-142: scrolling reaches the page only while the picture has focus", async ({ page }) => {
    await openFixture(page, `${COMPUTER}&computer=control`, "light");
    await control(page);
    const frame = fullView(page).getByTestId("screen-frame");
    const box = (await frame.boundingBox())!;
    await fullView(page).getByRole("button", { name: "Give back control" }).focus();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(300);
    expect(await sentOf(page, "computerInput")).toEqual([]);
    await frame.focus();
    await page.mouse.wheel(0, 300);
    await expect
      .poll(async () =>
        (await sentOf(page, "computerInput")).some(
          (each) => (each.input as { kind: string }).kind === "scroll",
        ),
      )
      .toBe(true);
  });

  test("F-142: control kept on a bot's browser after switching to another bot's task names that bot's browser, and says the gateway lets it expire", async ({
    page,
  }) => {
    await openFixture(page, `${COMPUTER}&computer=releaseunknown`, "light");
    await control(page);
    await controlBar(page).getByRole("button", { name: "Give back control" }).click();
    await expect(controlBar(page)).toContainText("Giving control back…");
    await page.keyboard.press("Escape");
    await fullView(page)
      .getByRole("button", { name: /^Close the full view/ })
      .click()
      .catch(() => {});
    await page
      .getByTestId("bot-list")
      .getByRole("button", { name: /^Otto\b/ })
      .click();
    await page
      .getByRole("list", { name: "Otto's tasks" })
      .getByTestId("task")
      .filter({ hasText: "Disk almost full" })
      .click();
    await expect(computerPanel(page).getByTestId("computer-held")).toHaveText(
      "This device may still have control of Juniper's browser. Giving it back wasn't confirmed. The gateway will let it expire if it isn't renewed.Give it back",
    );
  });

  test("F-141: a tab list the plugin couldn't read says so with Retry; without the plugin, nothing offers to install it", async ({
    page,
  }) => {
    await openFixture(page, `${COMPUTER}&computer=tabsunknown`, "light");
    const unknown = computerPanel(page).getByTestId("computer-tabs-unknown");
    await expect(unknown).toContainText("Couldn't check for tabs in Juniper's browser.");
    await expect(computerPanel(page).getByTestId("computer-no-tabs")).toHaveCount(0);
    await unknown.getByRole("button", { name: "Retry" }).click();
    await expect.poll(async () => (await sentOf(page, "computerTabs")).length).toBeGreaterThan(0);

    await page.goto("about:blank");
    await openFixture(page, `${COMPUTER}&computer=noplugin`, "light");
    const absent = computerPanel(page).getByTestId("computer-noplugin");
    await expect(absent).toContainText(
      "Watching is available on a Clawtrate development gateway configured for this bot.",
    );
    await expect(absent).not.toContainText("installs");
    await expect(absent.getByRole("button", { name: "What the plugin adds" })).toHaveCount(0);
  });

  test("F-144: Show the question brings that question's own card into view and focuses it, even with a later answered card below it", async ({
    page,
  }) => {
    await openFixture(page, `${COMPUTER}&computer=laterquestion`, "light");
    const banner = computerPanel(page).getByTestId("computer-banner");
    await expect(banner).toContainText("Juniper is waiting for you");
    await page.locator(".transcript").evaluate((element) => {
      const scroller =
        element.closest<HTMLElement>("[data-testid=conversation-scroll], .conversation-scroll") ??
        element.parentElement!;
      scroller.scrollTop = 0;
    });
    await banner.getByRole("button", { name: "Show the question" }).click();
    const card = page.locator("#card-question-ask_library_sign_in");
    await expect(card).toBeInViewport();
    await expect
      .poll(() => card.evaluate((element) => element.contains(document.activeElement)))
      .toBe(true);
    // Not the later, answered card.
    expect(
      await page
        .locator("#card-question-ask_holds_checked")
        .evaluate((element) => element.contains(document.activeElement)),
    ).toBe(false);
  });

  test("F-144: the banner offers Take control only while the shown tab can be asked for", async ({
    page,
  }) => {
    await openFixture(page, `${COMPUTER}&computer=elsewhere`, "light");
    const banner = computerPanel(page).getByTestId("computer-banner");
    await expect(banner).toContainText("Juniper is waiting for you");
    await expect(banner.getByRole("button", { name: "Show the question" })).toBeVisible();
    await expect(banner.getByRole("button", { name: "Take control" })).toHaveCount(0);
  });
});
