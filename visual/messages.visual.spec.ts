// What a person can do with a message, in the fixture mode: react, reply and
// more beside it, reactions as badges under it, and a thread assembled around
// a message and its replies (parity F-066, F-067, F-283). The gateway's half
// is proven in e2e/preview.spec.ts.
import { test, type Locator, type Page } from "@playwright/test";
import type { ClawtrateState, MessageReaction } from "../packages/core/src/index.ts";
import {
  contextFor,
  expect,
  NOW,
  openFixture,
  OTTO_DISK,
  settle,
  SIZES,
  THEMES,
} from "./fixture.ts";

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
 * The points of a control's 44 px touch area, across it from its centre out to its edges, where a
 * touch does not reach the control, each with what it reaches instead: a neighbour whose own area
 * lies over part of it fails.
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

const ownedLinkPoints = (link: Locator) =>
  link.evaluate((el) =>
    [...el.getClientRects()].flatMap((box) =>
      [box.top + 1, (box.top + box.bottom) / 2, box.bottom - 1].flatMap((y) =>
        [box.left + 1, (box.left + box.right) / 2, box.right - 1]
          .filter((x) => el.contains(document.elementFromPoint(x, y)))
          .map((x) => ({ x, y })),
      ),
    ),
  );

const lostLinkPoints = (link: Locator, points: Array<{ x: number; y: number }>) =>
  link.evaluate(
    (el, points) => points.filter(({ x, y }) => !el.contains(document.elementFromPoint(x, y))),
    points,
  );

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

/** A message's reaction pills, in view, each reaching every point of its 44 px touch area. */
async function pillsReach(page: Page, row: string, count: number): Promise<void> {
  const message = page.locator(`[data-message="${row}"]`);
  const pills = message.getByTestId("reaction");
  await expect(pills).toHaveCount(count);
  await message.getByTestId("reactions").evaluate((el) => el.scrollIntoView({ block: "center" }));
  await settle(page);
  for (const pill of await pills.all()) expect(await unreached(pill)).toEqual([]);
}

/** Otto's progress bubble, a row of its own: on a phone its bar has no room beside it. */
const progress = (page: Page) =>
  page.getByTestId("message").filter({ hasText: "I'll write that down so I don't forget." });

/** Touch and hold a message's last bubble until its actions open, then lift. */
async function holdOn(
  message: Locator,
  target = message.locator(".msg > .bubble").last(),
  offset = { x: 30, y: 20 },
): Promise<void> {
  const box = (await target.boundingBox())!;
  const at = {
    pointerType: "touch",
    isPrimary: true,
    clientX: box.x + offset.x,
    clientY: box.y + offset.y,
  };
  await target.dispatchEvent("pointerdown", at);
  await expect(message.getByTestId("message-actions")).toHaveAttribute("data-open", "true", {
    timeout: 3000,
  });
  await target.dispatchEvent("pointerup", at);
}

/** Messages at the end of the open task, each with the gateway's id of its row. */
async function addMessages(
  page: Page,
  add: Array<{ id: string; role: "user" | "assistant"; text: string }>,
): Promise<void> {
  await page.evaluate((add) => {
    const fixture = (
      window as unknown as {
        clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
      }
    ).clawtrateFixture;
    fixture.setState((state) => {
      const task = "agent:otto:disk-space";
      const transcript = state.transcripts[task]!;
      const at = transcript.items.at(-1)!.timestamp ?? 0;
      const items = add.map(({ id, role, text }, index) => ({
        id: `${id}:1`,
        role,
        timestamp: at + 60_000 * (index + 1),
        blocks: [
          { kind: "text" as const, text, ...(role === "assistant" ? { messageId: id } : {}) },
        ],
        model: null,
        messageId: id,
      }));
      return {
        ...state,
        transcripts: {
          ...state.transcripts,
          [task]: { ...transcript, items: [...transcript.items, ...items] },
        },
      };
    });
  }, add);
}

/** Scroll the transcript until a bubble's top is at a height on the screen. */
const topAt = (bubble: Locator, y: number) =>
  bubble.evaluate((el, y) => {
    el.closest(".transcript")!.scrollTop += el.getBoundingClientRect().top - y;
  }, y);

/** Four reactions, each a pill of its own. */
const FOUR: MessageReaction[] = ["👍", "❤️", "🎉", "👀"].map((emoji) => ({
  emoji,
  count: 1,
  mine: false,
}));

/**
 * Fingers on the screen, through the browser's own touch input, so that they drift, scroll and
 * lift the way real ones do. A pointer event made by hand does none of that. Each one goes down on
 * a message's bubble and moves by an offset from there.
 */
async function touchScreen(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const down = new Map<number, { x: number; y: number }>();
  const send = (type: "touchStart" | "touchMove" | "touchEnd", ids = [...down.keys()]) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: ids.map((id) => ({ id, ...down.get(id)!, radiusX: 10, radiusY: 10, force: 1 })),
    });
  return async (turn: Locator) => {
    const box = (await turn.locator(".msg > .bubble").last().boundingBox())!;
    const id = down.size + 1;
    const at = (dx: number, dy: number) => down.set(id, { x: box.x + 30 + dx, y: box.y + 20 + dy });
    at(0, 0);
    await send("touchStart");
    return {
      move: (dx: number, dy: number) => (at(dx, dy), send("touchMove")),
      // A touchEnd lifts the points it carries, or all of them when it carries none: one finger
      // of several lifts alone, with a pointerup of its own.
      lift: async () => {
        await send("touchEnd", down.size > 1 ? [id] : []);
        down.delete(id);
      },
    };
  };
}

/** One finger down on a message's bubble. */
const fingerOn = async (turn: Locator) => (await touchScreen(turn.page()))(turn);

/**
 * Otto's answer, ready to hold. The page's timers stop, so the long press cannot end before the
 * finger has drifted, however slow the page: the check runs them.
 */
async function holdReady(page: Page) {
  await page.clock.install({ time: NOW });
  await open(page);
  const turn = answer(page);
  await turn.scrollIntoViewIfNeeded();
  await page.clock.pauseAt(new Date(NOW.getTime() + 60_000));
  return turn;
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

  test("F-066: in a message's menu, focus stays on the item the person moved to, through the toolbar's and the conversation's re-renders", async ({
    page,
  }) => {
    await open(page);
    const actions = answer(page).getByTestId("message-actions");
    await actions.getByRole("button", { name: "More" }).focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: "More" });
    await expect(menu.getByRole("menuitem", { name: "Copy text" })).toBeFocused();
    // Focus moving inside the menu re-measures the toolbar, which re-renders the menu's parent.
    await page.keyboard.press("ArrowDown");
    const later = menu.getByRole("menuitem", { name: "Copy message ID" });
    await expect(later).toBeFocused();
    // A new state from the host re-renders the conversation, and the menu's parent hands it a new
    // `onClose`.
    await page.evaluate(async () => {
      const fixture = (
        window as unknown as {
          clawtrateFixture: {
            setState: (f: (s: Record<string, unknown>) => Record<string, unknown>) => void;
          };
        }
      ).clawtrateFixture;
      fixture.setState((state) => ({
        ...state,
        connection: { ...(state.connection as object) },
      }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    expect(await page.evaluate(() => document.activeElement?.textContent)).toContain(
      "Copy message ID",
    );
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
    await bubble.dispatchEvent("pointerdown", {
      pointerType: "touch",
      pointerId: 1,
      isPrimary: true,
      ...at,
    });
    await bubble.dispatchEvent("pointerdown", { pointerType: "touch", pointerId: 2, ...at });
    await bubble.dispatchEvent("pointerup", { pointerType: "touch", pointerId: 2, ...at });
    await bubble.dispatchEvent("pointerup", { pointerType: "touch", pointerId: 1, ...at });
    await page.waitForTimeout(900);
    await expect(actions).not.toHaveAttribute("data-open", "true");
  });

  test("F-066: touch and hold shows a message's actions though the finger drifts a few px", async ({
    page,
  }) => {
    const turn = await holdReady(page);
    const finger = await fingerOn(turn);
    for (const dx of [3, 0, 3, 1]) await finger.move(dx, 2);
    await page.clock.runFor(600);
    await expect(turn.getByTestId("message-actions")).toHaveAttribute("data-open", "true");
    await finger.lift();
  });

  test("F-066: a finger that moves 30 px is a scroll, not a touch and hold: nothing opens", async ({
    page,
  }) => {
    const turn = await holdReady(page);
    const finger = await fingerOn(turn);
    for (const dy of [10, 20, 30]) await finger.move(0, -dy);
    await page.clock.runFor(600);
    await finger.lift();
    await expect(turn.getByTestId("message-actions")).not.toHaveAttribute("data-open", "true");
  });

  test("F-066: a finger held on a message keeps its text from being selected until it lifts", async ({
    page,
  }) => {
    const turn = await holdReady(page);
    const text = turn.locator(".msg > .bubble").last();
    const finger = await fingerOn(turn);
    await expect(text).toHaveCSS("user-select", "none");
    await page.clock.runFor(600);
    await expect(turn.getByTestId("message-actions")).toHaveAttribute("data-open", "true");
    // Still, once the actions show, though the finger drifts past the slop: the system's own long
    // press can come a little later.
    await finger.move(11, 0);
    await expect(text).toHaveCSS("user-select", "none");
    await expect(turn.getByTestId("message-actions")).toHaveAttribute("data-open", "true");
    await finger.lift();
    await expect(text).toHaveCSS("user-select", "auto");
  });

  test("F-066: a finger that moves 11 px before the long press ends its wait: nothing opens", async ({
    page,
  }) => {
    const turn = await holdReady(page);
    const text = turn.locator(".msg > .bubble").last();
    const finger = await fingerOn(turn);
    await finger.move(0, 11);
    await page.clock.runFor(600);
    // The browser has not taken the finger, so this slop is what ended the wait.
    await expect(text).toHaveCSS("user-select", "none");
    await expect(turn.getByTestId("message-actions")).not.toHaveAttribute("data-open", "true");
    await finger.lift();
    await expect(text).toHaveCSS("user-select", "auto");
  });

  test("F-066: a second finger down anywhere is no touch and hold, nor the start of one, while both stay down", async ({
    page,
  }) => {
    const turn = await holdReady(page);
    const finger = await touchScreen(page);
    const first = await finger(turn);
    // On another message: outside the first one, and a hold of its own if a second finger could start one.
    const second = await finger(
      page.getByTestId("transcript-turn").filter({ hasText: "Keep an eye on it" }),
    );
    await page.clock.runFor(600);
    await expect(turn.locator(".msg > .bubble").last()).toHaveCSS("user-select", "none");
    await expect(page.locator('[data-testid="message-actions"][data-open="true"]')).toHaveCount(0);
    await second.lift();
    // The first finger is still down, and still keeps its message's text unselectable.
    await expect(turn.locator(".msg > .bubble").last()).toHaveCSS("user-select", "none");
    await first.lift();
    await expect(turn.locator(".msg > .bubble").last()).toHaveCSS("user-select", "auto");
  });

  test("F-066: a mouse moving over a held message leaves the touch and hold to the finger", async ({
    page,
  }) => {
    const turn = await holdReady(page);
    const box = (await turn.locator(".msg > .bubble").last().boundingBox())!;
    const finger = await fingerOn(turn);
    await page.mouse.move(box.x + 120, box.y + 40);
    await page.mouse.move(box.x + 160, box.y + 60);
    await page.clock.runFor(600);
    await expect(turn.getByTestId("message-actions")).toHaveAttribute("data-open", "true");
    await finger.lift();
  });

  test("F-066: when the text under a held finger goes, the hold ends with it: nothing opens, and the text is selectable", async ({
    page,
  }) => {
    const turn = await holdReady(page);
    // By its id, since the text that finds it goes.
    const id = await turn.getByTestId("message").last().getAttribute("data-message");
    const message = page.locator(`[data-testid="message"][data-message="${id}"]`);
    const text = message.locator(".msg > .bubble");
    const finger = await fingerOn(turn);
    // A move: from there the browser holds the finger to the text it went down on.
    await finger.move(1, 1);
    await text
      .locator("p")
      .first()
      .evaluate((el) => el.remove());
    // The browser lets go of the finger before its next event.
    await finger.move(2, 1);
    await page.clock.runFor(600);
    await expect(text).toHaveCSS("user-select", "auto");
    await expect(message.getByTestId("message-actions")).not.toHaveAttribute("data-open", "true");
    await finger.lift();
  });

  test("F-066: the transcript scrolling under a held finger ends its wait: nothing opens", async ({
    page,
  }) => {
    const turn = await holdReady(page);
    const text = turn.locator(".msg > .bubble").last();
    const finger = await fingerOn(turn);
    // Away and back: the message is where it started by the time the long press would open.
    for (const dy of [-40, 40])
      await page.getByTestId("transcript").evaluate(
        (el, by) =>
          new Promise((scrolled) => {
            el.addEventListener("scroll", scrolled, { once: true });
            el.scrollTop += by;
          }),
        dy,
      );
    await page.clock.runFor(600);
    await expect(text).toHaveCSS("user-select", "none");
    await expect(turn.getByTestId("message-actions")).not.toHaveAttribute("data-open", "true");
    await finger.lift();
  });

  test("F-066: the browser's own long press on a held message opens its actions, and not the browser's menu", async ({
    page,
  }) => {
    const turn = await holdReady(page);
    const finger = await fingerOn(turn);
    // As Chromium sends it, before this long press is due: the page's timers stay stopped.
    const shut = await turn
      .locator(".msg > .bubble")
      .last()
      .evaluate(
        (el) =>
          !el.dispatchEvent(
            new PointerEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              pointerType: "touch",
            }),
          ),
      );
    expect(shut).toBe(true);
    await expect(turn.getByTestId("message-actions")).toHaveAttribute("data-open", "true");
    await finger.lift();
  });

  test("F-066: a right-click on a held message is the mouse's own: it opens nothing and keeps the browser's menu", async ({
    page,
  }) => {
    const turn = await holdReady(page);
    const box = (await turn.locator(".msg > .bubble").last().boundingBox())!;
    // Seen after the page's own handlers: a prevented menu is one the browser does not show.
    await page.evaluate(() =>
      window.addEventListener("contextmenu", (event) => {
        (window as unknown as { menuShut: boolean }).menuShut = event.defaultPrevented;
      }),
    );
    const finger = await fingerOn(turn);
    await page.mouse.click(box.x + 120, box.y + 20, { button: "right" });
    expect(await page.evaluate(() => (window as unknown as { menuShut: boolean }).menuShut)).toBe(
      false,
    );
    await expect(turn.getByTestId("message-actions")).not.toHaveAttribute("data-open", "true");
    await finger.lift();
  });

  test("F-066: on a touch screen, a mouse over a message shows its actions, and a touch hides them", async ({
    page,
  }) => {
    await open(page);
    const turn = answer(page);
    await turn.scrollIntoViewIfNeeded();
    const actions = turn.getByTestId("message-actions");
    const box = (await turn.locator(".msg > .bubble").last().boundingBox())!;
    // This screen reports no hover, as Chromium can for a touch screen in tablet mode with a mouse.
    expect(await page.evaluate(() => matchMedia("(any-hover: hover)").matches)).toBe(false);
    await page.mouse.move(box.x + 30, box.y + 20);
    await expect.poll(() => shown(actions)).toBe(true);
    await page.touchscreen.tap(box.x + 30, box.y + 20);
    // pointer-events changes at once, where the opacity fades.
    await expect(actions).toHaveCSS("pointer-events", "none");
    // The mouse moving on over the same message shows them again, without leaving it first.
    await page.mouse.move(box.x + 40, box.y + 24);
    await expect.poll(() => shown(actions)).toBe(true);
  });

  test("F-066: a finger lifting from a message leaves its actions to a mouse still over it", async ({
    page,
  }) => {
    const turn = await holdReady(page);
    const box = (await turn.locator(".msg > .bubble").last().boundingBox())!;
    const finger = await fingerOn(turn);
    // The mouse comes onto the message while the finger is down; the finger lifts before the hold.
    await page.mouse.move(box.x + 120, box.y + 40);
    await page.mouse.move(box.x + 160, box.y + 60);
    await finger.lift();
    // pointer-events changes at once, where the opacity fades.
    await expect(turn.getByTestId("message-actions")).toHaveCSS("pointer-events", "auto");
  });

  test("F-066: a tap on a message leaves its actions hidden", async ({ page }) => {
    await open(page);
    const turn = answer(page);
    await turn.scrollIntoViewIfNeeded();
    const box = (await turn.locator(".msg > .bubble").last().boundingBox())!;
    await page.touchscreen.tap(box.x + 30, box.y + 20);
    // The tap leaves :hover on the message, as iOS does, until the next tap elsewhere.
    await expect.poll(() => turn.evaluate((el) => el.matches(":hover"))).toBe(true);
    // pointer-events changes at once, where the opacity fades.
    await expect(turn.getByTestId("message-actions")).toHaveCSS("pointer-events", "none");
  });
});

for (const width of [320, 390]) {
  test.describe(`touch areas on a ${width}px phone`, () => {
    test.use(contextFor({ ...PHONE, width }, "light"));
    const longText = Array.from({ length: 24 }, (_, i) => `Line ${i + 1}.`).join("\n\n");

    test("F-066: touch and hold on a message shows its actions, each with a 44 px hit area of its own", async ({
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
      await bubble.dispatchEvent("pointerdown", {
        pointerType: "touch",
        isPrimary: true,
        clientX: x,
        clientY: y,
      });
      await expect(actions).toHaveAttribute("data-open", "true", { timeout: 3000 });
      await bubble.dispatchEvent("pointerup", { pointerType: "touch", clientX: x, clientY: y });
      await expect.poll(() => shown(actions)).toBe(true);
      const buttons = actions.getByRole("button");
      await expect(buttons).toHaveCount(3);
      for (const button of await buttons.all()) expect(await unreached(button)).toEqual([]);
      // Within the screen.
      const bar = (await actions.boundingBox())!;
      expect(bar.x).toBeGreaterThanOrEqual(0);
      expect(bar.x + bar.width).toBeLessThanOrEqual(width);
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

    test("F-066: a held message just under the header, with no room beside it or above it, shows its actions where each button keeps its 44 px hit area", async ({
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
      await expect.poll(() => shown(actions)).toBe(true);
      const buttons = actions.getByRole("button");
      await expect(buttons).toHaveCount(3);
      for (const button of await buttons.all()) expect(await unreached(button)).toEqual([]);
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

    for (const role of ["user", "assistant"] as const) {
      const whose = role === "user" ? "of yours" : "of Otto's";
      /** A short message, with room beside it, and a long one after it to scroll by. */
      const shortThenLong = (page: Page) =>
        addMessages(page, [
          { id: "row-short", role, text: "Done." },
          {
            id: "row-long",
            role: role === "user" ? "assistant" : "user",
            text: longText,
          },
        ]);

      test(`F-066: a short held message ${whose} at the transcript's foot keeps its actions beside it and on screen, each button with its 44 px hit area`, async ({
        page,
      }) => {
        await open(page);
        await shortThenLong(page);
        const message = page.locator('[data-message="row-short"]');
        const bubble = message.locator(".msg > .bubble");
        // Its top 30 px above the transcript's foot: beside its top, the bar would reach past it.
        const view = (await page.getByTestId("transcript").boundingBox())!;
        await topAt(bubble, view.y + view.height - 30);
        await settle(page);
        await expect(page.getByTestId("jump-latest")).toHaveCount(0);
        await holdOn(message);
        const actions = message.getByTestId("message-actions");
        const buttons = actions.getByRole("button");
        await expect(buttons).toHaveCount(3);
        for (const button of await buttons.all()) expect(await unreached(button)).toEqual([]);
        // Beside the bubble, where there is room for it: moved up, not across.
        const bar = (await actions.boundingBox())!;
        const box = (await bubble.boundingBox())!;
        if (role === "user") expect(bar.x + bar.width).toBeLessThanOrEqual(box.x);
        else expect(bar.x).toBeGreaterThanOrEqual(box.x + box.width);
      });

      test(`F-066 F-283: a held message ${whose} just under the header keeps its actions off its four reaction pills, each button and pill with its 44 px hit area`, async ({
        page,
      }) => {
        await open(page);
        // Your message before Otto's progress bubble, or that bubble: on a phone, neither has room
        // beside it.
        const row = role === "user" ? "row-3" : "row-4-1";
        await react(page, { [row]: FOUR });
        const message = page.locator(`[data-message="${row}"]`);
        const pills = message.getByTestId("reaction");
        await expect(pills).toHaveCount(4);
        const header = (await page.locator(".conversation-header").boundingBox())!;
        await topAt(message.locator(".msg > .bubble"), header.y + header.height + 10);
        await settle(page);
        for (const pill of await pills.all()) expect(await unreached(pill)).toEqual([]);
        await holdOn(message);
        const buttons = message.getByTestId("message-actions").getByRole("button");
        await expect(buttons).toHaveCount(3);
        for (const button of await buttons.all()) expect(await unreached(button)).toEqual([]);
        for (const pill of await pills.all()) expect(await unreached(pill)).toEqual([]);
      });

      test(`F-066 F-283: a held message ${whose} between links keeps both links, four reactions and its actions tappable`, async ({
        page,
      }) => {
        await open(page);
        await addMessages(page, [
          {
            id: "row-held",
            role,
            text: "[The whole first line is this link](https://example.com/one)\n\nPlain words held below it.",
          },
          {
            id: "row-next",
            role,
            text: "[A link right after the pills](https://example.com/two) and more.",
          },
          {
            id: "row-long",
            role: role === "user" ? "assistant" : "user",
            text: longText,
          },
        ]);
        await react(page, { "row-held": FOUR });
        const message = page.locator('[data-message="row-held"]');
        const header = (await page.locator(".conversation-header").boundingBox())!;
        await topAt(message.locator(".msg > .bubble"), header.y + header.height + 10);
        await settle(page);

        const links = [
          message.getByRole("link"),
          page.locator('[data-message="row-next"]').getByRole("link"),
        ];
        const points = await Promise.all(links.map(ownedLinkPoints));
        for (const owned of points) expect(owned.length).toBeGreaterThan(0);
        const pills = message.getByTestId("reaction");
        await expect(pills).toHaveCount(4);
        for (const pill of await pills.all()) expect(await unreached(pill)).toEqual([]);

        await holdOn(message, message.getByText("Plain words held below it."), { x: 30, y: 4 });
        for (const [index, link] of links.entries())
          expect(await lostLinkPoints(link, points[index]!)).toEqual([]);
        for (const pill of await pills.all()) expect(await unreached(pill)).toEqual([]);
        const buttons = message.getByTestId("message-actions").getByRole("button");
        await expect(buttons).toHaveCount(3);
        for (const button of await buttons.all()) expect(await unreached(button)).toEqual([]);
      });

      test(`F-066: a short held message ${whose} just under the status strip keeps its actions where the transcript shows, off Retry, each button and Retry with its 44 px hit area`, async ({
        page,
      }) => {
        await open(page);
        await shortThenLong(page);
        // The gateway can't be reached: the strip shows, with Retry, and write access stays.
        await page.evaluate(() => {
          const fixture = (
            window as unknown as {
              clawtrateFixture: { setState: (f: (s: ClawtrateState) => ClawtrateState) => void };
            }
          ).clawtrateFixture;
          fixture.setState((state) => ({
            ...state,
            connection: { ...state.connection, status: "error" },
          }));
        });
        const strip = page.getByTestId("status-strip");
        const retry = strip.getByRole("button", { name: "Retry now" });
        await expect(retry).toBeVisible();
        const message = page.locator('[data-message="row-short"]');
        // Its top 6 px under the strip: clear of what the strip draws, not of what Retry takes.
        const drawn = (await strip.boundingBox())!;
        await topAt(message.locator(".msg > .bubble"), drawn.y + drawn.height + 6);
        await settle(page);
        await expect(page.getByTestId("jump-latest")).toHaveCount(0);
        expect(await unreached(retry)).toEqual([]);
        await holdOn(message);
        const buttons = message.getByTestId("message-actions").getByRole("button");
        await expect(buttons).toHaveCount(3);
        for (const button of await buttons.all()) expect(await unreached(button)).toEqual([]);
        expect(await unreached(retry)).toEqual([]);
        // And where they show: past the fade the transcript's mask draws under the strip.
        const shown = await page.getByTestId("transcript").evaluate((el) => {
          const stops = [...getComputedStyle(el).maskImage.matchAll(/([\d.]+)px/g)];
          return el.getBoundingClientRect().top + Number(stops.at(-1)![1]);
        });
        for (const button of await buttons.all()) {
          const box = (await button.boundingBox())!;
          expect(box.y + box.height / 2 - 22).toBeGreaterThanOrEqual(shown);
        }
      });
    }

    if (width === 320) {
      test("F-066: a held one-letter message at the foot keeps its actions on screen and off a 4 px link", async ({
        page,
      }) => {
        await open(page);
        await addMessages(page, [
          {
            id: "row-before",
            role: "assistant",
            text: "A short note with [i](https://example.com/i) and a few words.",
          },
          { id: "row-held", role: "user", text: "k" },
          {
            id: "row-long",
            role: "assistant",
            text: longText,
          },
        ]);
        const message = page.locator('[data-message="row-held"]');
        const bubble = message.locator(".msg > .bubble");
        const view = (await page.getByTestId("transcript").boundingBox())!;
        await topAt(bubble, view.y + view.height - 8);
        await settle(page);

        const link = page
          .locator('[data-message="row-before"]')
          .getByRole("link", { name: "i", exact: true });
        await link.evaluate(
          (el: HTMLElement, y) => {
            Object.assign(el.style, {
              display: "inline-block",
              width: "4px",
              position: "relative",
            });
            const box = el.getBoundingClientRect();
            el.style.left = `${139.4 - box.left}px`;
            el.style.top = `${y - box.top}px`;
          },
          view.y + view.height - 47,
        );
        const points = await ownedLinkPoints(link);
        expect(points).toHaveLength(9);

        expect(
          await bubble.evaluate((el) => {
            const box = el.getBoundingClientRect();
            return el.contains(document.elementFromPoint(box.left + 18, box.top + 4));
          }),
        ).toBe(true);
        await holdOn(message, bubble, { x: 18, y: 4 });
        expect(await lostLinkPoints(link, points)).toEqual([]);
        const buttons = message.getByTestId("message-actions").getByRole("button");
        await expect(buttons).toHaveCount(3);
        for (const button of await buttons.all()) expect(await unreached(button)).toEqual([]);
      });
    }
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
        // A phone has no hover: there the actions show after a touch and hold.
        if (size.phone) {
          const finger = await fingerOn(turn);
          await expect(turn.getByTestId("message-actions")).toHaveAttribute("data-open", "true");
          await finger.lift();
        } else await turn.locator(".msg > .bubble").last().hover();
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
