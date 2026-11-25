// The conversation with "Show commands" and "Show thinking" off, the default
// (docs/design/conversation.md, 7.11): what the bot says, one status line while it
// works, and one run line after it that opens to its actions in plain words. The
// switches in Settings → Advanced bring back the cards and the commands, here and
// in the Computer tab, and the bot's thinking.
import { test, type Page } from "@playwright/test";
import type { ClawtrateState } from "../packages/core/src/index.ts";
import { computerPanel, OTTO_COMPUTER } from "./computer-helpers.ts";
import { contextFor, expect, openFixture, OTTO_DISK, paintedFinal, SIZES } from "./fixture.ts";

const open = (page: Page, scene: string, extra = "") =>
  openFixture(page, `scene=${scene}&${OTTO_DISK}&panel=closed${extra}`);

const transcript = (page: Page) => page.getByTestId("transcript");
/** Action cards drawn at level 0: not inside a run line. */
const looseCards = (page: Page) =>
  transcript(page).locator("details.card.action:not(.run-line details)");
const runLine = (page: Page) => transcript(page).getByTestId("run-line").last();

/** Change the live run of Otto's task, as the host's next snapshot would. */
async function changeRun(page: Page, change: string, runId = "run-live") {
  await page.evaluate(
    ([source, id]) => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
        }
      ).clawtrateFixture;
      const apply = new Function("run", source) as (run: unknown) => unknown;
      fixture.setState((state) => {
        const key = "agent:otto:disk-space";
        const t = state.transcripts[key]!;
        const runs = t.runs.map((run) => (run.id === id ? (apply(run) as typeof run) : run));
        return { ...state, transcripts: { ...state.transcripts, [key]: { ...t, runs } } };
      });
    },
    [change, runId] as const,
  );
}

test.describe("the default conversation (7.11)", () => {
  test.use(contextFor(SIZES[0]!));

  test("F-528 F-551: a run's actions leave the conversation for its run line, failures included, except what waits for the person, which stays in view", async ({
    page,
  }) => {
    await open(page, "actions-mixed");
    await expect(runLine(page)).toContainText("8 actions");
    // The commands with a wait stay, as one fold, its failed command with them.
    const kept = looseCards(page);
    await expect(kept).toHaveCount(1);
    await expect(kept).toBeVisible();
    await expect(kept).toContainText("1 failed: couldn't run a command");
    await expect(kept).toContainText("Waiting for approval");
    // The rest are only in the closed run line, the unavailable memory search included.
    const listed = runLine(page).locator(".run-actions details.card.action");
    await expect(listed).toHaveCount(2);
    await expect(listed.nth(0)).toContainText('couldn\'t search memory for "loft insulation"');
    await expect(listed.nth(1)).toContainText("Image generation");
    for (const card of await listed.all()) await expect(card).toBeHidden();
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

  test("F-528: with Show thinking on, reasoning that led to actions keeps its place as a folded Thought line", async ({
    page,
  }) => {
    await open(page, "actions-repeat", "&thinking=show");
    const thought = transcript(page).locator("details.thought").first();
    await expect(thought).toBeVisible();
    await expect(thought).not.toHaveAttribute("open");
    await thought.locator(":scope > summary").click();
    await expect(thought).toContainText("confirm it on the thread");
    // No Raw while commands are not shown.
    await expect(thought.getByRole("button", { name: "Raw" })).toHaveCount(0);
  });

  test("F-529: the status line names the kind of work, and with Show thinking on, what the bot is thinking shows under it as it thinks", async ({
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
    await open(page, "run-reasoning", "&thinking=show");
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

  test("F-530 F-551: Show in chat from the Computer tab to a failed step opens the run line that holds it", async ({
    page,
  }) => {
    await openFixture(page, `${OTTO_COMPUTER}&computer=watching`);
    await changeRun(
      page,
      `return { ...run, steps: run.steps.map((s) => s.toolCallId === "x2"
         ? { ...s, status: "failed", error: "mv: cannot move: Permission denied" } : s) };`,
      "fixture-computer-2",
    );
    const commands = computerPanel(page).getByTestId("computer-commands");
    const row = commands.locator(".command-row", { hasText: "Failed" });
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: /^Show .+ in the chat$/ }).click();
    const focused = page.locator('.transcript [data-call="x2"]:focus-within');
    await expect(focused).toHaveCount(1);
    await expect(
      focused.locator("xpath=ancestor::details[contains(@class,'run-line')]"),
    ).toHaveAttribute("open", "");
  });

  test("F-551: a focused action waiting for the person that is then refused leaves focus on the transcript while the run works", async ({
    page,
  }) => {
    await open(page, "actions-running");
    await changeRun(
      page,
      `return { ...run, steps: run.steps.map((s) => s.toolCallId === "call_l3"
         ? { ...s, status: "waiting" } : s) };`,
    );
    const card = transcript(page).locator('details.card.action[data-call="call_l3"]');
    await expect(card).toBeVisible();
    await card.locator(":scope > summary").focus();
    await changeRun(
      page,
      `return { ...run, steps: run.steps.map((s) => s.toolCallId === "call_l3"
         ? { ...s, status: "failed", endedAt: Date.now(), error: "Exec denied (user-denied): du" } : s) };`,
    );
    await expect(card).toHaveCount(0);
    await expect(transcript(page)).toBeFocused();
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

  test("F-531: Settings → Advanced's Show commands switch, off by default, brings the cards and commands back at once and is kept", async ({
    page,
  }) => {
    await open(page, "actions-short");
    await expect(looseCards(page)).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+,");
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings
      .getByRole("button", { name: /Advanced/ })
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
      .getByRole("button", { name: /Advanced/ })
      .first()
      .click();
    await settings.getByRole("switch", { name: "Show commands" }).click();
    await page.keyboard.press("Escape");
    await expect(looseCards(page)).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("clawtrate.commands"))).toBeNull();
  });

  test("F-551: by default no reasoning is drawn: no Thought line, and the status line names the work with no thinking under it", async ({
    page,
  }) => {
    await open(page, "actions-repeat");
    await expect(transcript(page).getByText("Booked: the survey is on Tuesday")).toBeVisible();
    await expect(transcript(page).locator("[data-thought]")).toHaveCount(0);
    await open(page, "run-reasoning");
    await expect(page.getByTestId("status-phrase")).toHaveText("Thinking");
    await expect(page.getByTestId("status-thought")).toHaveCount(0);
    await expect(page.getByText("I'll check its size before suggesting anything.")).toHaveCount(0);
  });

  test("F-551: a failed action is never in the conversation with commands hidden: the run line counts it and opens to it", async ({
    page,
  }) => {
    await open(page, "actions-failed");
    await expect(transcript(page).getByText("Last week's log is missing.")).toBeVisible();
    await expect(looseCards(page)).toHaveCount(0);
    await expect(runLine(page).locator(":scope > summary")).toContainText("2 failed");
    await runLine(page).locator(":scope > summary").click();
    await expect(
      runLine(page).locator('.run-actions details.card.action[data-status="failed"]'),
    ).toHaveCount(2);
  });

  test("F-551: while the run works and after it ends, a failed action stays out of the conversation; with commands shown it is in place", async ({
    page,
  }) => {
    for (const shown of [false, true]) {
      await open(page, "actions-running", shown ? "&commands=show" : "");
      await changeRun(
        page,
        `return { ...run, steps: run.steps.map((s) => s.toolCallId === "call_l3"
           ? { ...s, status: "failed", endedAt: Date.now(), error: "Permission denied" }
           : s) };`,
      );
      const card = transcript(page).locator('details.card.action[data-call="call_l3"]');
      const loose = transcript(page).locator(
        'details.card.action[data-call="call_l3"]:not(.run-line details)',
      );
      await expect(loose).toHaveCount(shown ? 1 : 0);
      if (shown) await expect(card).toHaveAttribute("data-status", "failed");
      await changeRun(page, `return { ...run, text: "One step failed. I'll try another way." };`);
      await expect(transcript(page).getByText("One step failed.")).toBeVisible();
      await expect(loose).toHaveCount(shown ? 1 : 0);
      await changeRun(
        page,
        `return { ...run, state: "completed", endedAt: Date.now(), textComplete: true };`,
      );
      await expect(runLine(page).locator(":scope > summary")).toContainText("1 failed");
      await expect(loose).toHaveCount(shown ? 1 : 0);
      if (!shown) {
        await runLine(page).locator(":scope > summary").click();
        await expect(
          runLine(page).locator('details.card.action[data-call="call_l3"]'),
        ).toBeVisible();
      }
    }
  });

  test("F-551 F-531 F-519 F-563: Settings → Advanced holds Show commands, Show thinking, Show external channel chats and Show sessions from other tools, all off; Show thinking brings the thinking back at once, is kept, and leaves the commands hidden", async ({
    page,
  }) => {
    // The fixture keeps the gateway's own bot shown; here every switch is at its default.
    await open(page, "actions-repeat", "&gatewaybot=off");
    await expect(transcript(page).locator("details.thought")).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+,");
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("button", { name: "Advanced", exact: true }).click();
    const commands = settings.getByRole("switch", { name: "Show commands" });
    const thinking = settings.getByRole("switch", { name: "Show thinking" });
    await expect(commands).toHaveAttribute("aria-checked", "false");
    await expect(thinking).toHaveAttribute("aria-checked", "false");
    await expect(thinking).toHaveAccessibleDescription(/Thought lines/);
    // The switches, in this order: the two that hide other apps' sessions as a pair, then the
    // gateway's own bot's (F-562).
    expect(
      await settings
        .getByRole("switch")
        .evaluateAll((all) => all.map((s) => s.getAttribute("aria-labelledby"))),
    ).toEqual([
      "show-commands-label",
      "show-thinking-label",
      "channel-chats-label",
      "other-tools-label",
      "gateway-bot-label",
    ]);
    await expect(
      settings.getByRole("switch", { name: "Show external channel chats" }),
    ).toHaveAttribute("aria-checked", "false");
    const others = settings.getByRole("switch", { name: "Show sessions from other tools" });
    await expect(others).toHaveAttribute("aria-checked", "false");
    await expect(others).toHaveAccessibleDescription(/API client, a scheduled routine/);
    await thinking.click();
    await expect(thinking).toHaveAttribute("aria-checked", "true");
    expect(await page.evaluate(() => localStorage.getItem("clawtrate.thinking"))).toBe("show");
    expect(await page.evaluate(() => localStorage.getItem("clawtrate.commands"))).toBeNull();
    await page.keyboard.press("Escape");
    await expect(transcript(page).locator("details.thought").first()).toBeVisible();
    await expect(looseCards(page)).toHaveCount(0);
    // Kept: the live thinking shows under the status line after a reload.
    await open(page, "run-reasoning");
    await expect(page.getByTestId("status-thought")).toContainText(
      "I'll check its size before suggesting anything.",
    );
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
    await open(page, "run-reasoning", "&thinking=show");
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
      await open(page, "run-reasoning", "&thinking=show");
      await expect(page.getByTestId("status-thought")).toBeVisible();
      await paintedFinal(page);
      await expect(page).toHaveScreenshot(`quiet-thinking-${size.name}.png`);
    });

    test(`F-551: the default view, the bot's words and its run line with no thinking, at ${size.name}`, async ({
      page,
    }) => {
      await open(page, "actions-failed");
      await expect(runLine(page)).toBeVisible();
      await paintedFinal(page);
      await expect(page).toHaveScreenshot(`quiet-default-${size.name}.png`);
    });

    test(`F-551 F-519 F-563: Settings → Advanced, at ${size.name}`, async ({ page }) => {
      await open(page, "actions-failed", "&gatewaybot=off");
      await page.keyboard.press("ControlOrMeta+,");
      const settings = page.getByRole("dialog", { name: "Settings" });
      await settings.getByRole("button", { name: "Advanced", exact: true }).click();
      await expect(settings.getByRole("switch", { name: "Show thinking" })).toBeVisible();
      await expect(
        settings.getByRole("switch", { name: "Show external channel chats" }),
      ).toBeVisible();
      await paintedFinal(page);
      await expect(page).toHaveScreenshot(`quiet-advanced-${size.name}.png`);
    });
  });
}
