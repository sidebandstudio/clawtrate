// The conversation with "Show commands" off, the default (docs/design/conversation.md,
// 7.11): what the bot says and thinks, one status line while it works, and one run
// line after it that opens to its actions in plain words. The switch in Settings
// brings the cards and the commands back, here and in the Computer tab.
import { test, type Page } from "@playwright/test";
import { computerPanel, OTTO_COMPUTER } from "./computer-helpers.ts";
import { contextFor, expect, openFixture, OTTO_DISK, paintedFinal, SIZES } from "./fixture.ts";

const open = (page: Page, scene: string, extra = "") =>
  openFixture(page, `scene=${scene}&${OTTO_DISK}&panel=closed${extra}`);

const transcript = (page: Page) => page.getByTestId("transcript");
/** Action cards drawn at level 0: not inside a run line. */
const looseCards = (page: Page) =>
  transcript(page).locator("details.card.action:not(.run-line details)");
const runLine = (page: Page) => transcript(page).getByTestId("run-line").last();

test.describe("the default conversation (7.11)", () => {
  test.use(contextFor(SIZES[0]!));

  test("F-528: a run's actions leave the conversation for its run line, except what went wrong or waits for the person, which stays in view", async ({
    page,
  }) => {
    await open(page, "actions-mixed");
    await expect(runLine(page)).toContainText("8 actions");
    // The memory search that was unavailable, and the commands with a failure and a wait, stay.
    const kept = looseCards(page);
    await expect(kept).toHaveCount(2);
    for (const card of await kept.all()) await expect(card).toBeVisible();
    await expect(kept.nth(0)).toContainText('couldn\'t search memory for "loft insulation"');
    await expect(kept.nth(1)).toContainText("1 failed: couldn't run a command");
    await expect(kept.nth(1)).toContainText("Waiting for approval");
    // The rest are only in the closed run line.
    const listed = runLine(page).locator(".run-actions details.card.action");
    await expect(listed).toHaveCount(1);
    await expect(listed).toContainText("Image generation");
    await expect(listed).toBeHidden();
    await expect(transcript(page).getByText("Starting the sketches.")).toBeVisible();
    await expect(transcript(page).getByText("Now the backup folder.")).toBeVisible();
    await expect(transcript(page).getByTestId("actions-not-kept")).toHaveCount(0);
  });

  test("F-528: approval cards, question cards and the Messaged cards stay in view", async ({
    page,
  }) => {
    await openFixture(page, "scene=approval-pending");
    await expect(page.getByTestId("approval-card").first()).toBeVisible();
    // The call the approval is for waits for the person, so its card stays in view too.
    await expect(looseCards(page)).toHaveCount(1);
    await expect(looseCards(page)).toContainText("Wants to run a command");
    await openFixture(page, "scene=question-single");
    await expect(page.getByTestId("question-card").first()).toBeVisible();
    await openFixture(page, "scene=messaged-started");
    await expect(page.locator(".transcript .card.messaged").first()).toBeVisible();
  });

  test("F-531: without commands shown, request and Messaged cards offer no Raw; an approval still shows the exact command", async ({
    page,
  }) => {
    for (const shown of [false, true]) {
      const extra = shown ? "&commands=show" : "";
      await openFixture(page, `scene=approval-pending${extra}`);
      const approval = page.getByTestId("approval-card").first();
      await expect(approval).toContainText("mv /srv/media/transcode-cache");
      await expect(approval.getByRole("button", { name: "Raw" })).toHaveCount(shown ? 1 : 0);
      await openFixture(page, `scene=messaged-started${extra}`);
      const messaged = page.locator(".transcript .card.messaged").first();
      await messaged.locator(":scope > summary").click();
      await expect(messaged.getByRole("button", { name: "Raw" })).toHaveCount(shown ? 1 : 0);
    }
  });

  test("F-528: reasoning that led to actions keeps its place as a folded Thought line", async ({
    page,
  }) => {
    await open(page, "actions-repeat");
    const thought = transcript(page).locator("details.thought").first();
    await expect(thought).toBeVisible();
    await expect(thought).not.toHaveAttribute("open");
    await thought.locator(":scope > summary").click();
    await expect(thought).toContainText("confirm it on the thread");
    // No Raw while commands are not shown.
    await expect(thought.getByRole("button", { name: "Raw" })).toHaveCount(0);
  });

  test("F-529: the status line names the kind of work, and what the bot is thinking shows under it as it thinks", async ({
    page,
  }) => {
    await open(page, "run-working");
    await expect(page.getByTestId("status-phrase")).toHaveText("Reading files");
    await expect(page.getByTestId("status-line")).toHaveAccessibleName(
      "Otto, working: Reading files.",
    );
    // No card to bring into view: a plain line, not a button or a tab stop.
    await expect(transcript(page).getByRole("button", { name: /^Otto, working/ })).toHaveCount(0);
    expect(await page.getByTestId("status-line").evaluate((el) => el.tagName)).toBe("DIV");
    await expect(page.getByTestId("status-thought")).toHaveCount(0);
    await open(page, "run-reasoning");
    await expect(page.getByTestId("status-phrase")).toHaveText("Thinking");
    await expect(page.getByTestId("status-thought")).toContainText(
      "I'll check its size before suggesting anything.",
    );
    // No card for the running work; only history's failures stay in view.
    await expect(
      transcript(page).locator('details.card.action[data-status="running"]:not(.run-line details)'),
    ).toHaveCount(0);
  });

  test("F-530: the run line opens to its actions in plain words: no command line, no program, no Raw", async ({
    page,
  }) => {
    await open(page, "actions-kinds");
    const line = runLine(page);
    await line.locator(":scope > summary").click();
    const list = line.locator(".run-actions");
    await expect(list.locator("details.card.action")).toHaveCount(23);
    await expect(list).toContainText("Ran a command");
    await expect(list).toContainText('Searched the web for "cold climate heat pump"');
    await expect(list.locator(".mono")).toHaveCount(0);
    await expect(list.locator(".action-exit")).toHaveCount(0);
    const command = list.locator("details.card.action", { hasText: "Ran a command" }).first();
    await command.locator(":scope > summary").click();
    await expect(command.getByRole("tab", { name: "Raw" })).toHaveCount(0);
    await expect(command.locator(".step-body")).not.toContainText("Command");
    // The record stays under the list.
    await expect(line.locator(".run-record")).toContainText("run-1");
  });

  test("F-530: Show in chat from the Computer tab opens the run line that holds the step and focuses it", async ({
    page,
  }) => {
    await openFixture(page, `${OTTO_COMPUTER}&computer=watching`);
    const commands = computerPanel(page).getByTestId("computer-commands");
    await expect(commands.locator(".command-row").first()).toContainText("Ran a command");
    await expect(commands.locator("code")).toHaveCount(0);
    await expect(commands.locator(".command-row").first()).toContainText("Done · 0.4s");
    await expect(computerPanel(page).getByTestId("computer-actions")).toContainText(
      "Ran a command",
    );
    // Each row's button says which command it shows, in plain words.
    const buttons = commands.getByRole("button", {
      name: /^Show Ran a command, Done · \d\.\ds, .+, in the chat$/,
    });
    await expect(buttons).toHaveCount(2);
    const names = await buttons.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("aria-label")),
    );
    expect(new Set(names).size).toBe(2);
    await buttons.first().click();
    const focused = page.locator(".transcript [data-call]:focus-within");
    await expect(focused).toHaveCount(1);
    await expect(focused).toContainText("Ran a command");
    await expect(
      focused.locator("xpath=ancestor::details[contains(@class,'run-line')]"),
    ).toHaveAttribute("open", "");
  });

  test("F-532: a message that repeats the reply beside it leaves its text out, with commands shown or not", async ({
    page,
  }) => {
    const reply = "Booked: the survey is on Tuesday, December 2, between 9 and 11 AM.";
    for (const extra of ["", "&commands=show"]) {
      await open(page, "actions-repeat", extra);
      await expect(transcript(page).getByText(reply)).toHaveCount(1);
      const card = transcript(page).locator("details.card.action", {
        hasText: "Message on a conversation",
      });
      if (!extra) await runLine(page).locator(":scope > summary").click();
      await expect(card.locator(":scope > summary")).toHaveAccessibleName(
        "Message on a conversation, sent",
      );
      await expect(card.locator(":scope > summary")).not.toContainText("Booked");
    }
  });

  test("F-531: Settings → Conversation's Show commands switch, off by default, brings the cards and commands back at once and is kept", async ({
    page,
  }) => {
    await open(page, "actions-short");
    await expect(looseCards(page)).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+,");
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings
      .getByRole("button", { name: /Conversation/ })
      .first()
      .click();
    const toggle = settings.getByRole("switch", { name: "Show commands" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(await page.evaluate(() => localStorage.getItem("clawtrate.commands"))).toBe("show");
    await page.keyboard.press("Escape");
    await expect(looseCards(page)).toHaveCount(2);
    await expect(looseCards(page).nth(1)).toContainText("tail -n 2 logs/backup-2026-11-15.log");
    // Kept: a reload opens with the cards.
    await page.reload();
    await expect(looseCards(page)).toHaveCount(2);
    await page.keyboard.press("ControlOrMeta+,");
    await settings
      .getByRole("button", { name: /Conversation/ })
      .first()
      .click();
    await settings.getByRole("switch", { name: "Show commands" }).click();
    await page.keyboard.press("Escape");
    await expect(looseCards(page)).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("clawtrate.commands"))).toBeNull();
  });

  test("F-531: with commands shown, the Computer tab lists command lines again", async ({
    page,
  }) => {
    await openFixture(page, `${OTTO_COMPUTER}&computer=watching&commands=show`);
    const commands = computerPanel(page).getByTestId("computer-commands");
    await expect(commands.locator("code").first()).toContainText("mv /var/lib/transcode-cache");
    await expect(commands.locator(".command-row").first()).toContainText("exit 0 · 0.4s");
  });
});

test.describe("the thinking on a phone (7.11)", () => {
  test.use(contextFor(SIZES.find((size) => size.phone)!));

  test("F-529: the thinking under the status line keeps its newest words: its last three lines show", async ({
    page,
  }) => {
    await open(page, "run-reasoning");
    const thought = page.getByTestId("status-thought");
    await expect(thought).toBeVisible();
    // The text is longer than three lines here: its end is inside the box, its start is cut.
    const { end, start, box } = await thought.evaluate((element) => {
      const text = element.querySelector("span")!.firstChild as Text;
      const at = (from: number, to: number) => {
        const range = document.createRange();
        range.setStart(text, from);
        range.setEnd(text, to);
        return range.getBoundingClientRect();
      };
      const r = element.getBoundingClientRect();
      const length = text.data.length;
      return {
        end: at(length - 1, length).bottom,
        start: at(0, 1).top,
        box: { top: r.top, bottom: r.bottom },
      };
    });
    expect(end).toBeLessThanOrEqual(box.bottom + 1);
    expect(end).toBeGreaterThan(box.top);
    expect(start).toBeLessThan(box.top);
  });
});

// Each matches its approved baseline at every size, in the default theme.
for (const size of SIZES) {
  test.describe(`the default conversation at ${size.name}`, () => {
    test.use(contextFor(size));

    test(`F-528 F-530: a run's line, opened, in plain words, at ${size.name}`, async ({ page }) => {
      await open(page, "actions-mixed");
      await runLine(page).locator(":scope > summary").click();
      await paintedFinal(page);
      await expect(page).toHaveScreenshot(`quiet-run-line-open-${size.name}.png`);
    });

    test(`F-529: what the bot is thinking, under the status line, at ${size.name}`, async ({
      page,
    }) => {
      await open(page, "run-reasoning");
      await expect(page.getByTestId("status-thought")).toBeVisible();
      await paintedFinal(page);
      await expect(page).toHaveScreenshot(`quiet-thinking-${size.name}.png`);
    });
  });
}
