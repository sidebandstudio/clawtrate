// What a person can do with a message, in the fixture mode: react, reply and
// more beside it, reactions as badges under it, and a thread assembled around
// a message and its replies (parity F-066, F-067, F-283). The gateway's half
// is proven in e2e/preview.spec.ts.
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ClawtrateState, MessageReaction } from "../packages/core/src/index.ts";
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

/**
 * The points of a control's 44 px touch area, across it from its centre, where a touch does not
 * reach the control, each with what it reaches instead: a neighbour lying over part of the area
 * fails, and so does the header drawn over it.
 */
const unreached = (control: Locator) =>
  control.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const across = [-21.5, -11, 0, 11, 21.5];
    return across.flatMap((dy) =>
      across.flatMap((dx) => {
        const hit = document.elementFromPoint(
          box.left + box.width / 2 + dx,
          box.top + box.height / 2 + dy,
        );
        if (el.contains(hit)) return [];
        const other = hit?.closest("button, [aria-label]");
        const name = other?.getAttribute("aria-label") ?? other?.textContent ?? hit?.tagName;
        return [`${dx},${dy}: ${name ?? "nothing"}`];
      }),
    );
  });

/** Set the reactions on messages of the open task, by row, as the gateway's next event would. */
async function react(page: Page, reactions: Record<string, MessageReaction[]>): Promise<void> {
  await page.evaluate((reactions) => {
    const fixture = (
      window as unknown as {
        clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
      }
    ).clawtrateFixture;
    fixture.setState((state) => {
      const task = "agent:otto:disk-space";
      const transcript = state.transcripts[task]!;
      const all = { ...transcript.reactions, ...reactions };
      return {
        ...state,
        transcripts: { ...state.transcripts, [task]: { ...transcript, reactions: all } },
      };
    });
  }, reactions);
}

/** Touch and hold a message's last bubble until its actions open, then lift. */
async function holdOn(message: Locator): Promise<void> {
  const bubble = message.locator(".msg > .bubble").last();
  const box = (await bubble.boundingBox())!;
  // The first finger down, as the browser marks it: a touch and hold is that finger's.
  const at = {
    pointerType: "touch",
    pointerId: 1,
    isPrimary: true,
    clientX: box.x + 30,
    clientY: box.y + 20,
  };
  await bubble.dispatchEvent("pointerdown", at);
  await expect(message.getByTestId("message-actions")).toHaveAttribute("data-open", "true", {
    timeout: 3000,
  });
  await bubble.dispatchEvent("pointerup", at);
}

/** A message's reaction pills, in view, each reaching every point of its 44 px touch area. */
async function pillsReach(page: Page, row: string, count: number): Promise<void> {
  const message = page.locator(`[data-message="${row}"]`);
  const pills = message.getByTestId("reaction");
  await expect(pills).toHaveCount(count);
  await message.getByTestId("reactions").evaluate((el) => el.scrollIntoView({ block: "center" }));
  await settle(page);
  for (const pill of await pills.all()) expect(await unreached(pill)).toEqual([]);
}

/**
 * Hover Otto's list of what fills the disk, a bubble with room beside it for the bar, with its top
 * 10 px under the header and then 20 px above the transcript's foot, and move slowly to React each
 * time: the bar shows beside it and stays to take the pointer.
 */
async function hoverToReact(page: Page): Promise<void> {
  const message = page.locator('[data-message="row-7"]');
  const bubble = message.locator(".msg > .bubble");
  const actions = message.getByTestId("message-actions");
  const header = (await page.locator(".conversation-header").boundingBox())!;
  const view = (await page.locator(".transcript").boundingBox())!;
  for (const top of [header.y + header.height - 10, view.y + view.height - 20]) {
    await page.mouse.move(0, 0);
    await bubble.evaluate((el, top) => {
      el.closest(".transcript")!.scrollTop += el.getBoundingClientRect().top - top;
    }, top);
    await settle(page);
    const box = (await bubble.boundingBox())!;
    await page.mouse.move(box.x + 20, Math.max(box.y, header.y + header.height) + 6);
    await expect.poll(() => shown(actions)).toBe(true);
    const bar = (await actions.boundingBox())!;
    expect(bar.x).toBeGreaterThanOrEqual(box.x + box.width);
    // On its way across, the pointer stays on the message, so the bar stays to take it.
    const react = actions.getByRole("button", { name: "Add a reaction" });
    const at = (await react.boundingBox())!;
    await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2, { steps: 20 });
    expect(await shown(actions)).toBe(true);
    expect(await react.evaluate((el) => el.matches(":hover"))).toBe(true);
  }
}

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

  test("F-066: a hovered message whose top lies under the header or at the foot keeps its actions beside it, where the pointer reaches them", async ({
    page,
  }) => {
    await open(page);
    await hoverToReact(page);
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

  test("F-066: when write access goes while Reply holds the tab stop, More takes it", async ({
    page,
  }) => {
    await open(page);
    const actions = answer(page).getByTestId("message-actions");
    await actions.getByRole("button", { name: "Add a reaction" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(actions.getByRole("button", { name: "Reply in a thread" })).toBeFocused();
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: {
            setState: (f: (s: Record<string, unknown>) => Record<string, unknown>) => void;
          };
        }
      ).clawtrateFixture;
      fixture.setState((state) => ({
        ...state,
        connection: { ...(state.connection as object), canWrite: false },
      }));
    });
    await expect(actions.getByRole("button")).toHaveCount(1);
    await expect(actions.getByRole("button", { name: "More" })).toHaveAttribute("tabindex", "0");
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
    await expect(page.getByTestId("announcer")).not.toHaveText("Reply sent");
  });

  test("F-067: a reply the gateway refused shows in its thread as failed, with Resend and Delete, and is not counted", async ({
    page,
  }) => {
    await open(page, "message-thread-failed");
    await record(page);
    // Yours and the bot's answer delivered as a reply; the refused one is not among them.
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

  test("F-067: a thread holds the message and each row the gateway marks as a reply to it: yours, and a bot's bubble by its own row, never the rest of its turn", async ({
    page,
  }) => {
    await open(page, "message-thread-failed");
    await page.getByTestId("reply-quote").first().click();
    const thread = page.getByRole("dialog", { name: "Thread" });
    const messages = thread.getByTestId("thread-message");
    await expect(messages).toHaveText([
      /Nothing alarming that I can see from here\./,
      /Could you read the system log another way\?/,
      /Otto\s*I can read it through the journal instead\./,
    ]);
    await expect(messages.last()).toHaveAttribute("data-role", "assistant");
    await expect(thread.getByTestId("thread-count")).toHaveText("2 replies");
    // The progress bubble of the same turn, and an answer with no reference of its own, stay out.
    await expect(thread).not.toContainText("Let me see which logs I can reach.");
    await expect(thread).not.toContainText("Starting the nightly rotation now.");
  });

  test("F-067: a reply refused after newer words were typed in the thread keeps both", async ({
    page,
  }) => {
    await open(page);
    await page.evaluate(() => {
      const w = window as unknown as {
        clawtrateFixture: { invoke: (c: unknown) => Promise<unknown> };
        refuse?: () => void;
      };
      const original = w.clawtrateFixture.invoke.bind(w.clawtrateFixture);
      w.clawtrateFixture.invoke = (command: unknown) =>
        (command as { type: string }).type === "sendMessage"
          ? new Promise((_, reject) => {
              w.refuse = () => reject(new Error("The gateway refused it."));
            })
          : original(command);
    });
    await page.getByTestId("reply-quote").click();
    const thread = page.getByRole("dialog", { name: "Thread" });
    const input = thread.getByTestId("thread-input");
    await input.fill("The first reply");
    await page.keyboard.press("Enter");
    await expect(input).toHaveValue("");
    await input.fill("typed meanwhile");
    await page.evaluate(() => (window as unknown as { refuse: () => void }).refuse());
    await expect(thread.locator(".thread-error")).toContainText("The gateway refused it.");
    await expect(input).toHaveValue("The first reply\ntyped meanwhile");
  });

  test("F-067: a reply refused after another thread was opened comes back to its own thread, not the one shown", async ({
    page,
  }) => {
    await open(page);
    await page.evaluate(() => {
      const w = window as unknown as {
        clawtrateFixture: { invoke: (c: unknown) => Promise<unknown> };
        refuse?: () => void;
      };
      const original = w.clawtrateFixture.invoke.bind(w.clawtrateFixture);
      w.clawtrateFixture.invoke = (command: unknown) =>
        (command as { type: string }).type === "sendMessage"
          ? new Promise((_, reject) => {
              w.refuse = () => reject(new Error("The gateway refused it."));
            })
          : original(command);
    });
    await page.getByTestId("reply-quote").click();
    const thread = page.getByRole("dialog", { name: "Thread" });
    const input = thread.getByTestId("thread-input");
    await input.fill("The first reply");
    await page.keyboard.press("Enter");
    await expect(input).toHaveValue("");
    // Another message's thread is opened from the keyboard (the panel covers its toolbar) while
    // the first reply is still being taken.
    await report(page).getByRole("button", { name: "Reply in a thread" }).last().focus();
    await page.keyboard.press("Enter");
    await expect(thread.getByTestId("thread-message").first()).not.toContainText(
      "Nothing alarming that I can see from here.",
    );
    await page.evaluate(() => (window as unknown as { refuse: () => void }).refuse());
    await page.waitForTimeout(200);
    await expect(input).toHaveValue("");
    await expect(thread.locator(".thread-error")).toHaveCount(0);
    // Back in the first thread, the refused words and the reason are there.
    await answer(page).getByRole("button", { name: "Reply in a thread" }).last().focus();
    await page.keyboard.press("Enter");
    await expect(thread.getByTestId("thread-message").first()).toContainText(
      "Nothing alarming that I can see from here.",
    );
    await expect(input).toHaveValue("The first reply");
    await expect(thread.locator(".thread-error")).toContainText("The gateway refused it.");
  });

  test("F-067: on a read-only connection the thread takes focus, so Escape closes it", async ({
    page,
  }) => {
    await open(page);
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: {
            setState: (f: (s: Record<string, unknown>) => Record<string, unknown>) => void;
          };
        }
      ).clawtrateFixture;
      fixture.setState((state) => ({
        ...state,
        connection: { ...(state.connection as object), canWrite: false },
      }));
    });
    const quote = page.getByTestId("reply-quote");
    await quote.click();
    const thread = page.getByRole("dialog", { name: "Thread" });
    await expect(thread).toBeVisible();
    await expect(thread.getByTestId("thread-input")).toHaveCount(0);
    await expect(thread).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(thread).toHaveCount(0);
    await expect(quote).toBeFocused();
  });

  test("F-067: when write access ends while the reply field has focus, the thread takes it, so Escape closes it", async ({
    page,
  }) => {
    await open(page);
    const quote = page.getByTestId("reply-quote");
    await quote.click();
    const thread = page.getByRole("dialog", { name: "Thread" });
    await expect(thread.getByTestId("thread-input")).toBeFocused();
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: {
            setState: (f: (s: Record<string, unknown>) => Record<string, unknown>) => void;
          };
        }
      ).clawtrateFixture;
      fixture.setState((state) => ({
        ...state,
        connection: { ...(state.connection as object), canWrite: false },
      }));
    });
    await expect(thread.getByTestId("thread-input")).toHaveCount(0);
    await expect(thread).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(thread).toHaveCount(0);
    await expect(quote).toBeFocused();
  });

  test("F-067: a reply that leaves the outbox without history holding it is never announced as sent", async ({
    page,
  }) => {
    await open(page);
    await page.getByTestId("reply-quote").click();
    const thread = page.getByRole("dialog", { name: "Thread" });
    await thread.getByTestId("thread-input").fill("Deleted before it lands");
    await page.keyboard.press("Enter");
    // The reply is removed, as Delete removes it: no history row ever holds it.
    await page.evaluate(() => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: {
            setState: (f: (s: Record<string, unknown>) => Record<string, unknown>) => void;
          };
        }
      ).clawtrateFixture;
      fixture.setState((state) => {
        const transcripts = state.transcripts as Record<string, { outbox: unknown[] }>;
        const key = "agent:otto:disk-space";
        return {
          ...state,
          transcripts: { ...transcripts, [key]: { ...transcripts[key]!, outbox: [] } },
        };
      });
    });
    await page.waitForTimeout(300);
    await expect(page.getByTestId("announcer")).not.toHaveText("Reply sent");
  });

  test("F-067: a reply is announced as sent once history holds the row the gateway stored under its key, and not for a look-alike", async ({
    page,
  }) => {
    await open(page);
    await page.getByTestId("reply-quote").click();
    const thread = page.getByRole("dialog", { name: "Thread" });
    await thread.getByTestId("thread-input").fill("Or ask me for a copy of it.");
    await page.keyboard.press("Enter");
    await expect(thread.getByTestId("outgoing")).toHaveAttribute("data-status", "sent");
    const announcer = page.getByTestId("announcer");
    await expect(announcer).not.toHaveText("Reply sent");
    // History holds a row of the same words, replying to the same message, under another key.
    const land = (own: boolean) =>
      page.evaluate((own) => {
        const fixture = (
          window as unknown as {
            clawtrateFixture: {
              setState: (f: (s: Record<string, unknown>) => Record<string, unknown>) => void;
            };
          }
        ).clawtrateFixture;
        fixture.setState((state) => {
          type Sent = { id: string; text: string; replyToId?: string };
          const transcripts = state.transcripts as Record<
            string,
            { outbox: Sent[]; items: unknown[] }
          >;
          const key = "agent:otto:disk-space";
          const transcript = transcripts[key]!;
          const mine = transcript.outbox.find((each) => each.replyToId)!;
          const row = {
            id: `row-landed:${transcript.items.length}`,
            role: "user",
            timestamp: Date.now(),
            blocks: [{ kind: "text", text: mine.text }],
            model: null,
            messageId: `row-landed-${transcript.items.length}`,
            replyTo: { id: mine.replyToId, text: null, sender: null },
            idempotencyKey: own ? `${mine.id}:user` : "another-client:user",
          };
          const outbox = own
            ? transcript.outbox.filter((each) => each !== mine)
            : transcript.outbox;
          return {
            ...state,
            transcripts: {
              ...transcripts,
              [key]: { ...transcript, items: [...transcript.items, row], outbox },
            },
          };
        });
      }, own);
    await land(false);
    await page.waitForTimeout(300);
    await expect(announcer).not.toHaveText("Reply sent");
    await land(true);
    await expect(announcer).toHaveText("Reply sent");
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

test.describe("message actions with a mouse on a touch screen", () => {
  // The primary pointer is coarse, so the page takes its touch sizes, and a mouse is there too.
  test.use({ ...contextFor(WIDE, "light"), hasTouch: true });

  test("F-066: on a touch screen, a hovered message keeps a mouse's actions beside it, spaced as on any desktop, where the pointer reaches them", async ({
    page,
  }) => {
    await open(page);
    expect(await page.evaluate(() => document.documentElement.dataset.input)).toBe("touch");
    await hoverToReact(page);
    const actions = page.locator('[data-message="row-7"]').getByTestId("message-actions");
    expect(await actions.evaluate((el) => getComputedStyle(el).columnGap)).toBe("2px");
  });
});

test.describe("message actions on a phone", () => {
  test.use(contextFor(PHONE, "light"));

  test("F-066: a second finger on a message is no touch and hold: nothing opens once the fingers lift", async ({
    page,
  }) => {
    await open(page);
    const turn = answer(page);
    await turn.scrollIntoViewIfNeeded();
    const bubble = turn.locator(".msg > .bubble").last();
    const box = (await bubble.boundingBox())!;
    const actions = turn.getByTestId("message-actions");
    const at = { clientX: box.x + 30, clientY: box.y + 20 };
    await bubble.dispatchEvent("pointerdown", { pointerType: "touch", pointerId: 1, ...at });
    await bubble.dispatchEvent("pointerdown", { pointerType: "touch", pointerId: 2, ...at });
    await bubble.dispatchEvent("pointerup", { pointerType: "touch", pointerId: 2, ...at });
    await bubble.dispatchEvent("pointerup", { pointerType: "touch", pointerId: 1, ...at });
    await page.waitForTimeout(900);
    await expect(actions).not.toHaveAttribute("data-open", "true");
  });

  test("F-066: when the screen narrows while a held message's actions show, the bar moves so each button keeps its 44 px hit area", async ({
    page,
  }) => {
    await open(page);
    const turn = answer(page);
    await turn.scrollIntoViewIfNeeded();
    await holdOn(turn);
    await page.setViewportSize({ width: 320, height: PHONE.height });
    const buttons = turn.getByTestId("message-actions").getByRole("button");
    await expect(buttons).toHaveCount(3);
    for (const button of await buttons.all())
      await expect.poll(() => unreached(button)).toEqual([]);
  });
});

/** Otto's progress bubble, a row of its own with no room beside it for the bar on a phone. */
const progress = (page: Page) =>
  page.getByTestId("message").filter({ hasText: "I'll write that down so I don't forget." });

for (const width of [320, 390]) {
  test.describe(`touch areas on a ${width}px phone`, () => {
    test.use(contextFor({ ...PHONE, width }, "light"));

    test("F-066: touch and hold on a message shows its actions, each with a 44 px hit area of its own", async ({
      page,
    }) => {
      await open(page);
      const turn = answer(page);
      await turn.scrollIntoViewIfNeeded();
      const box = (await turn.locator(".msg > .bubble").last().boundingBox())!;
      const actions = turn.getByTestId("message-actions");
      await page.touchscreen.tap(box.x + 30, box.y + 20);
      expect(await shown(actions)).toBe(false);
      await holdOn(turn);
      await expect.poll(() => shown(actions)).toBe(true);
      const buttons = actions.getByRole("button");
      await expect(buttons).toHaveCount(3);
      for (const button of await buttons.all()) expect(await unreached(button)).toEqual([]);
      // Within the screen.
      const bar = (await actions.boundingBox())!;
      expect(bar.x).toBeGreaterThanOrEqual(0);
      expect(bar.x + bar.width).toBeLessThanOrEqual(width);
    });

    test("F-066: a held message just under the header, with no room beside it or above it, shows its actions under it, each with its 44 px hit area", async ({
      page,
    }) => {
      await open(page);
      const message = progress(page);
      const bubble = message.locator(".msg > .bubble");
      // Its top 10 px under the header: above it, the bar would lie under the header.
      const header = (await page.locator(".conversation-header").boundingBox())!;
      await bubble.evaluate(
        (el, top) => {
          el.closest(".transcript")!.scrollTop += el.getBoundingClientRect().top - top;
        },
        header.y + header.height + 10,
      );
      await settle(page);
      await holdOn(message);
      const actions = message.getByTestId("message-actions");
      const buttons = actions.getByRole("button");
      await expect(buttons).toHaveCount(3);
      for (const button of await buttons.all()) expect(await unreached(button)).toEqual([]);
      const bar = (await actions.boundingBox())!;
      const box = (await bubble.boundingBox())!;
      expect(bar.y).toBeGreaterThanOrEqual(box.y + box.height);
    });

    test("F-066: when write access comes back while a held message's actions show, the wider bar moves so each button keeps its 44 px hit area", async ({
      page,
    }) => {
      await open(page, "message-actions-read");
      const message = progress(page);
      await message.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await settle(page);
      await holdOn(message);
      const actions = message.getByTestId("message-actions");
      await expect(actions.getByRole("button")).toHaveCount(1);
      await page.evaluate(() => {
        const fixture = (
          window as unknown as {
            clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
          }
        ).clawtrateFixture;
        fixture.setState((state) => ({
          ...state,
          connection: { ...state.connection, canWrite: true },
        }));
      });
      const buttons = actions.getByRole("button");
      await expect(buttons).toHaveCount(3);
      for (const button of await buttons.all())
        await expect.poll(() => unreached(button)).toEqual([]);
    });

    test("F-283: reaction pills that wrap onto a second row each keep a 44 px hit area of their own", async ({
      page,
    }) => {
      await open(page);
      // Otto's report takes six reactions with three-digit counts: more than one row holds.
      await react(page, {
        "row-9": ["👍", "❤️", "😂", "🎉", "👀", "🙏"].map((emoji, i) => ({
          emoji,
          count: 120 + i,
          mine: i === 0,
        })),
      });
      await pillsReach(page, "row-9", 6);
      const rows = await page
        .locator('[data-message="row-9"]')
        .getByTestId("reaction")
        .evaluateAll((all) => new Set(all.map((each) => each.getBoundingClientRect().top)).size);
      expect(rows).toBe(2);
    });

    test("F-283: a reaction pill keeps its 44 px hit area over the replies link under it", async ({
      page,
    }) => {
      await open(page);
      // Otto's first answer has a reply, so its replies link is under the reaction it takes here.
      await react(page, { "row-2": [{ emoji: "👀", count: 1, mine: false }] });
      await pillsReach(page, "row-2", 1);
    });

    test("F-283: a reaction pill keeps its 44 px hit area over the quote of the reply under it", async ({
      page,
    }) => {
      await open(page);
      // Your reply after Otto's report quotes an earlier answer, just under the report's pills.
      await pillsReach(page, "row-9", 2);
    });

    test("F-283: narrow reaction pills side by side each keep a 44 px hit area of their own", async ({
      page,
    }) => {
      await open(page);
      // Glyphs narrower than an emoji, with one reaction each: drawn, their pills are under 44 px.
      await react(page, {
        "row-9": ["☹", "☺"].map((emoji) => ({ emoji, count: 1, mine: false })),
      });
      await pillsReach(page, "row-9", 2);
    });
  });
}

/** One reaction each of the six the react button offers. */
const SIX: MessageReaction[] = ["👍", "❤️", "😂", "🎉", "👀", "🙏"].map((emoji) => ({
  emoji,
  count: 1,
  mine: false,
}));

for (const width of [320, 390, 430]) {
  test.describe(`held actions on a ${width}px phone`, () => {
    test.use(contextFor({ ...PHONE, width }, "light"));

    // Yours, and Otto's first answer, with a replies link under its reactions.
    for (const [whose, row] of [
      ["your", "row-6"],
      ["Otto's", "row-2"],
    ] as const)
      test(`F-066 F-283: ${whose} message held just under the header shows its actions clear of its reactions and replies link, each control with its 44 px hit area`, async ({
        page,
      }) => {
        await open(page);
        await react(page, { [row]: SIX });
        const message = page.locator(`[data-message="${row}"]`);
        // Its top 10 px under the header: the bar has no room above it.
        const header = (await page.locator(".conversation-header").boundingBox())!;
        await message
          .locator(".msg > .bubble")
          .last()
          .evaluate(
            (el, top) => {
              el.closest(".transcript")!.scrollTop += el.getBoundingClientRect().top - top;
            },
            header.y + header.height + 10,
          );
        await settle(page);
        await holdOn(message);
        const buttons = message.getByTestId("message-actions").getByRole("button");
        await expect(buttons).toHaveCount(3);
        await expect(message.getByTestId("reaction")).toHaveCount(6);
        const controls = message.locator('[data-testid="reaction"], [data-testid="replies-link"]');
        for (const control of [...(await buttons.all()), ...(await controls.all())])
          expect(await unreached(control)).toEqual([]);
      });

    test("F-066 F-067: a held reply shows its actions clear of the quote over it, each button with its 44 px hit area", async ({
      page,
    }) => {
      await open(page);
      const message = page.locator('[data-message="row-reply"]');
      await message.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await settle(page);
      await holdOn(message);
      const buttons = message.getByTestId("message-actions").getByRole("button");
      await expect(buttons).toHaveCount(3);
      for (const button of await buttons.all()) expect(await unreached(button)).toEqual([]);
      // The quote heads the reply's turn, just over its bubble, which lies over the foot of the
      // quote's 44 px area with the bar shut too: there, only the bar is looked for.
      const quote = page
        .getByTestId("transcript-turn")
        .filter({ has: message })
        .getByTestId("reply-quote");
      const onBar = (await unreached(quote)).filter((point) =>
        / (Add a reaction|Reply in a thread|More)$/.test(point),
      );
      expect(onBar).toEqual([]);
    });
  });
}

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
        // A phone has no mouse: there a touch and hold shows the actions.
        if (size.phone) await holdOn(turn);
        else await turn.locator(".msg > .bubble").last().hover();
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
