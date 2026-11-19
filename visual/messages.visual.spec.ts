// What a person can do with a message, in the fixture mode: react, reply and
// more beside it, reactions as badges under it, and a thread assembled around
// a message and its replies (parity F-066, F-067, F-283). The gateway's half
// is proven in e2e/preview.spec.ts.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.phone)!;

const open = (page: Page, scene = "message-actions", theme: "light" | "dark" = "light") =>
  openFixture(page, `scene=${scene}&${OTTO_DISK}&panel=closed`, theme);

/** Otto's first answer: a bubble of its own, with a reply to it later in the task. */
const answer = (page: Page) =>
  page
    .getByTestId("transcript-turn")
    .and(page.locator('[data-role="assistant"]'))
    .filter({ hasText: "Nothing alarming that I can see" });

/** Otto's report, the one message the scene gives reactions. */
const report = (page: Page) =>
  page
    .getByTestId("transcript-turn")
    .filter({ has: page.getByTestId("reactions") })
    .first();

/** Record every command the interface sends through the bridge. */
async function record(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      clawtrateFixture: Record<string, (command: unknown) => Promise<unknown>>;
      sent: unknown[];
    };
    w.sent = [];
    const fixture = w.clawtrateFixture;
    const invoke = fixture.invoke!.bind(fixture);
    const send = fixture.send!.bind(fixture);
    fixture.invoke = (command) => (w.sent.push(command), invoke(command));
    fixture.send = (command) => (w.sent.push(command), send(command));
  });
}
const sent = (page: Page) =>
  page.evaluate(() => (window as unknown as { sent: Array<Record<string, unknown>> }).sent);

/** The names of a toolbar's buttons, in order. */
const names = (locator: Locator) =>
  locator
    .getByRole("button")
    .evaluateAll((all) => all.map((each) => each.getAttribute("aria-label")));

const shown = (locator: Locator) =>
  locator.evaluate((el) => Number(getComputedStyle(el).opacity) === 1);

test.describe("message actions", () => {
  test.use(contextFor(WIDE, "light"));

  test("F-066: hovering a bot message shows react, reply and more to its right, and only while it is hovered", async ({
    page,
  }) => {
    await open(page);
    const turn = answer(page);
    await turn.scrollIntoViewIfNeeded();
    const actions = turn.getByTestId("message-actions");
    expect(await shown(actions)).toBe(false);
    const bubble = turn.locator(".msg > .bubble").last();
    await bubble.hover();
    await expect.poll(() => shown(actions)).toBe(true);
    expect(await names(actions)).toEqual(["Add a reaction", "Reply in a thread", "More"]);
    const bar = (await actions.boundingBox())!;
    const box = (await bubble.boundingBox())!;
    // To its right, level with its first line.
    expect(bar.x).toBeGreaterThanOrEqual(box.x + box.width);
    expect(Math.abs(bar.y - box.y)).toBeLessThan(4);
    await page.getByRole("heading", { name: "Disk almost full on the media box" }).hover();
    await expect.poll(() => shown(actions)).toBe(false);
  });

  test("F-066: the actions are one tab stop; Left and Right move between them and they show while focused", async ({
    page,
  }) => {
    await open(page);
    const actions = answer(page).getByTestId("message-actions");
    const react = actions.getByRole("button", { name: "Add a reaction" });
    await expect(react).toHaveAttribute("tabindex", "0");
    await expect(actions.getByRole("button", { name: "More" })).toHaveAttribute("tabindex", "-1");
    await react.focus();
    await expect.poll(() => shown(actions)).toBe(true);
    await page.keyboard.press("ArrowRight");
    await expect(actions.getByRole("button", { name: "Reply in a thread" })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(actions.getByRole("button", { name: "More" })).toBeFocused();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: "More" });
    await expect(menu.getByRole("menuitem")).toHaveText(["Copy text", "Copy message ID"]);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(actions.getByRole("button", { name: "More" })).toBeFocused();
  });

  test("F-066: in a turn of a progress bubble and a final one, each bubble's actions act on its own message", async ({
    page,
  }) => {
    await open(page);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await record(page);
    const turn = page
      .getByTestId("transcript-turn")
      .filter({ hasText: "I'll write that down so I don't forget." });
    const progress = turn.getByTestId("message").filter({ hasText: "I'll write that down" });
    const final = turn.getByTestId("message").filter({ hasText: "Will do." });
    await expect(progress).toHaveAttribute("data-message", "row-4-1");
    await expect(final).toHaveAttribute("data-message", "row-4");
    await progress.scrollIntoViewIfNeeded();
    // The progress bubble's own actions, beside it, and only its own.
    const bubble = progress.locator(".msg > .bubble");
    await bubble.hover();
    const actions = progress.getByTestId("message-actions");
    await expect.poll(() => shown(actions)).toBe(true);
    expect(await shown(final.getByTestId("message-actions"))).toBe(false);
    const bar = (await actions.boundingBox())!;
    const box = (await bubble.boundingBox())!;
    expect(bar.x).toBeGreaterThanOrEqual(box.x + box.width);
    expect(Math.abs(bar.y - box.y)).toBeLessThan(4);
    await actions.getByRole("button", { name: "Add a reaction" }).click();
    await page
      .getByRole("menu", { name: "Add a reaction" })
      .getByRole("menuitem", { name: /Party/ })
      .click();
    expect((await sent(page)).at(-1)).toMatchObject({ type: "setReaction", messageId: "row-4-1" });
    await expect(progress.getByTestId("reaction")).toHaveText("🎉1");
    await expect(final.getByTestId("reactions")).toHaveCount(0);
    await actions.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Copy message ID" }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("row-4-1");
    // The final bubble's actions name the final row.
    await final.locator(".msg > .bubble").hover();
    const finalActions = final.getByTestId("message-actions");
    await expect.poll(() => shown(finalActions)).toBe(true);
    await finalActions.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Copy text" }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("Will do. I added a note so I check the disk each morning and tell you above 90%.");
    await finalActions.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Copy message ID" }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("row-4");
    // Reply on the progress bubble opens its thread and names its row.
    await bubble.hover();
    await actions.getByRole("button", { name: "Reply in a thread" }).click();
    const thread = page.getByRole("dialog", { name: "Thread" });
    await expect(thread.getByTestId("thread-message").first()).toContainText(
      "I'll write that down so I don't forget.",
    );
    await thread.getByTestId("thread-input").fill("Thanks.");
    await page.keyboard.press("Enter");
    expect((await sent(page)).at(-1)).toMatchObject({
      type: "sendMessage",
      text: "Thanks.",
      replyToId: "row-4-1",
    });
  });

  test("F-283: a reaction chosen from the react button shows as a badge under the message, and choosing the badge takes it away", async ({
    page,
  }) => {
    await open(page);
    await record(page);
    const turn = answer(page);
    await expect(turn.getByTestId("reactions")).toHaveCount(0);
    await turn.locator(".msg > .bubble").last().hover();
    await turn.getByRole("button", { name: "Add a reaction" }).click();
    await page
      .getByRole("menu", { name: "Add a reaction" })
      .getByRole("menuitem", { name: /Looking/ })
      .click();
    const badge = turn.getByTestId("reaction");
    await expect(badge).toHaveText("👀1");
    await expect(badge).toHaveAccessibleName("👀 1 reaction, yours among them. Remove yours");
    await expect(badge).toHaveAttribute("aria-pressed", "true");
    // Under the message: below its last bubble, at its left edge.
    const box = (await turn.locator(".msg > .bubble").last().boundingBox())!;
    const at = (await badge.boundingBox())!;
    expect(at.y).toBeGreaterThanOrEqual(box.y + box.height);
    expect(Math.abs(at.x - box.x)).toBeLessThan(2);
    expect((await sent(page)).at(-1)).toMatchObject({
      type: "setReaction",
      messageId: "row-2",
      emoji: "👀",
      remove: false,
    });
    await badge.click();
    await expect(turn.getByTestId("reactions")).toHaveCount(0);
    expect((await sent(page)).at(-1)).toMatchObject({
      type: "setReaction",
      messageId: "row-2",
      emoji: "👀",
      remove: true,
    });
    await expect(page.getByTestId("announcer")).toHaveText("Removed 👀");
  });

  test("F-283: another person's reaction counts beside yours; adding yours to it raises the count", async ({
    page,
  }) => {
    await open(page);
    const badges = report(page).getByTestId("reaction");
    await expect(badges).toHaveText(["👍2", "🎉1"]);
    await expect(badges.nth(1)).toHaveAttribute("aria-pressed", "false");
    await badges.nth(1).click();
    await expect(badges).toHaveText(["👍2", "🎉2"]);
    await expect(badges.nth(1)).toHaveAttribute("aria-pressed", "true");
  });

  test("F-067: Reply opens the thread on that message; a reply sent there names it, and Escape returns to Reply", async ({
    page,
  }) => {
    await open(page);
    await record(page);
    const turn = answer(page);
    await turn.locator(".msg > .bubble").last().hover();
    const reply = turn.getByRole("button", { name: "Reply in a thread" });
    await reply.click();
    const thread = page.getByRole("dialog", { name: "Thread" });
    const messages = thread.getByTestId("thread-message");
    await expect(messages.first()).toContainText("Nothing alarming that I can see from here.");
    await expect(messages.nth(1)).toContainText("Could you read the system log another way?");
    await expect(thread.getByTestId("thread-input")).toBeFocused();
    await thread.getByTestId("thread-input").fill("Or ask me for a copy of it.");
    await page.keyboard.press("Enter");
    // On its way, shown as the transcript shows it; sent once the gateway answered.
    const mine = thread.getByTestId("outgoing");
    await expect(mine).toContainText("Or ask me for a copy of it.");
    await expect(mine).toHaveAttribute("data-status", "sent");
    await expect(page.getByTestId("announcer")).toHaveText("Reply sent");
    await expect(thread).toContainText("2 replies");
    expect((await sent(page)).at(-1)).toMatchObject({
      type: "sendMessage",
      text: "Or ask me for a copy of it.",
      replyToId: "row-2",
    });
    await page.keyboard.press("Escape");
    await expect(thread).toHaveCount(0);
    await expect(reply).toBeFocused();
  });

  test("F-067 F-468: a reply typed in a thread while a question is pending is held and shown as held, and is neither counted nor announced as sent", async ({
    page,
  }) => {
    await open(page, "message-thread-question");
    await record(page);
    await page.getByTestId("reply-quote").click();
    const thread = page.getByRole("dialog", { name: "Thread" });
    await expect(thread.getByTestId("thread-count")).toHaveText("1 reply");
    await thread.getByTestId("thread-input").fill("And the backups?");
    await page.keyboard.press("Enter");
    expect((await sent(page)).at(-1)).toMatchObject({
      type: "sendMessage",
      text: "And the backups?",
      replyToId: "row-2",
    });
    const row = thread.getByTestId("shelf-row");
    await expect(row).toContainText("Held until you answer");
    await expect(row).toContainText("And the backups?");
    await expect(row.getByRole("button", { name: "Send now" })).toHaveCount(0);
    await expect(thread.getByTestId("thread-count")).toHaveText("1 reply");
    await expect(page.getByTestId("replies-link")).toHaveText("1 reply");
    await expect(page.getByTestId("announcer")).toHaveText("Held until you answer");
    await expect(page.getByTestId("announcer")).not.toHaveText("Reply sent");
  });

  test("F-067: a reply the gateway refused shows in its thread as failed, with Resend and Delete, and is not counted", async ({
    page,
  }) => {
    await open(page, "message-thread-failed");
    await record(page);
    await expect(page.getByTestId("replies-link")).toHaveText("2 replies");
    await page.getByTestId("reply-quote").first().click();
    const thread = page.getByRole("dialog", { name: "Thread" });
    await expect(thread.getByTestId("thread-count")).toHaveText("2 replies");
    const failed = thread.getByTestId("outgoing");
    await expect(failed).toHaveAttribute("data-status", "failed");
    await expect(failed).toContainText("Failed to send");
    await failed.getByRole("button", { name: "Resend" }).click();
    expect((await sent(page)).at(-1)).toMatchObject({
      type: "retryMessage",
      messageId: "msg-reply",
    });
  });

  test("F-067: a thread holds the message and the rows the gateway marks as replies to it, never the answer that merely follows", async ({
    page,
  }) => {
    await open(page, "message-thread-failed");
    await page.getByTestId("reply-quote").first().click();
    const thread = page.getByRole("dialog", { name: "Thread" });
    const messages = thread.getByTestId("thread-message");
    await expect(messages).toHaveText([
      /Nothing alarming that I can see from here\./,
      /Could you read the system log another way\?/,
      /I can read it through the journal instead\./,
    ]);
    await expect(thread).not.toContainText("Starting the nightly rotation now.");
  });

  test("F-067: a reply's line says what it answers, and opens the thread on that message", async ({
    page,
  }) => {
    await open(page);
    const quote = page.getByTestId("reply-quote");
    await expect(quote).toContainText("Otto: Nothing alarming that I can see from here.");
    await expect(page.getByTestId("replies-link")).toHaveText("1 reply");
    await quote.click();
    const thread = page.getByRole("dialog", { name: "Thread" });
    await expect(thread.getByTestId("thread-message").first()).toContainText(
      "Nothing alarming that I can see from here.",
    );
    await thread.getByRole("button", { name: "Close the thread" }).click();
    await expect(thread).toHaveCount(0);
    await expect(quote).toBeFocused();
  });

  test("F-066 F-283: on a read-only connection the badges are only shown, and More is the one action", async ({
    page,
  }) => {
    await open(page, "message-actions-read");
    const turn = report(page);
    await expect(turn.getByRole("button", { name: /reaction/ })).toHaveCount(0);
    await expect(turn.getByRole("img", { name: "👍 2 reactions" })).toBeVisible();
    expect(await names(turn.getByTestId("message-actions"))).toEqual(["More"]);
  });
});

test.describe("message actions on a phone", () => {
  test.use(contextFor(PHONE, "light"));

  test("F-066: touch and hold on a message shows its actions, each with a 44 px hit area", async ({
    page,
  }) => {
    await open(page);
    const turn = answer(page);
    await turn.scrollIntoViewIfNeeded();
    const bubble = turn.locator(".msg > .bubble").last();
    const box = (await bubble.boundingBox())!;
    const actions = turn.getByTestId("message-actions");
    const x = box.x + 30;
    const y = box.y + 20;
    await page.touchscreen.tap(x, y);
    expect(await shown(actions)).toBe(false);
    // Held: a pointer down that lasts past the long press.
    await bubble.dispatchEvent("pointerdown", { pointerType: "touch", clientX: x, clientY: y });
    await expect(actions).toHaveAttribute("data-open", "true", { timeout: 3000 });
    await bubble.dispatchEvent("pointerup", { pointerType: "touch", clientX: x, clientY: y });
    await expect.poll(() => shown(actions)).toBe(true);
    for (const button of await actions.getByRole("button").all()) {
      const size = await button.evaluate((el) => {
        const after = getComputedStyle(el, "::after");
        return [parseFloat(after.width), parseFloat(after.height)];
      });
      expect(size[0]).toBeGreaterThanOrEqual(44);
      expect(size[1]).toBeGreaterThanOrEqual(44);
    }
    // Within the screen.
    const bar = (await actions.boundingBox())!;
    expect(bar.x).toBeGreaterThanOrEqual(0);
    expect(bar.x + bar.width).toBeLessThanOrEqual(PHONE.width);
  });
});

for (const size of SIZES) {
  for (const theme of THEMES) {
    test.describe(`messages ${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));

      test("F-066 F-283: a message's actions beside it and its reactions under it", async ({
        page,
      }) => {
        await open(page, "message-actions", theme);
        const turn = report(page);
        await turn.scrollIntoViewIfNeeded();
        await turn.locator(".msg > .bubble").last().hover();
        await expect.poll(() => shown(turn.getByTestId("message-actions"))).toBe(true);
        await settle(page);
        await expect(page).toHaveScreenshot(`messages-actions-${theme}-${size.name}.png`);
      });

      test("F-067: the thread open on a message", async ({ page }) => {
        await open(page, "message-actions", theme);
        await page.getByTestId("reply-quote").click();
        await expect(page.getByRole("dialog", { name: "Thread" })).toBeVisible();
        await page.mouse.move(0, 0);
        await settle(page);
        await expect(page).toHaveScreenshot(`messages-thread-${theme}-${size.name}.png`);
      });
    });
  }
}
