// A setting's explanation behind an "i" (#798, InfoTip.tsx): it opens on hover, on keyboard focus
// and on tap; Escape (wherever focus is), a second tap, a tap elsewhere and focus leaving put it
// away; one is open at a time; it opens in the flow below its row, so it covers no control and no
// line that stays in view, and fits a phone's screen; and the control keeps its explanation as its
// description, in its exact words, whether or not the "i" is open. Pictures: each section it is
// in, desktop and phone, with one "i" open.
import { test, type Locator, type Page } from "@playwright/test";
import { checkIns } from "./check-ins-helpers.ts";
import { contextFor, expect, openFixture, OTTO_DISK, settle, SIZES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.name === "phone")!;

/** Every explanation moved behind an "i", in its exact words. */
const WORDS = {
  commands:
    "Shows each action as its own card with its command or call, in the conversation and the Computer tab.",
  thinking:
    "Shows a bot's reasoning: Thought lines in the conversation, and its thinking while it works.",
  channels:
    "Chats that reach a bot through Discord, Telegram, Slack, iMessage, WhatsApp, Signal or another channel. While it's off they stay out of the task list, its previews and its unread marks. A bot's main conversation always shows, with any channel messages the gateway puts in it.",
  otherTools:
    "Sessions an API client, a scheduled routine or another tool started with a bot. While it's off they stay out of the task list, its previews and its unread marks. A routine's runs open from Routines, and one waiting for your approval or answer always shows.",
  gatewayBot:
    "Every gateway has a default bot: channel messages, other tools' calls and scheduled runs that name no bot land on it. While it's off and you have another bot, it stays out of the sidebar unless it is waiting on you.",
  turnLimit:
    "At the limit Clawtrate asks the gateway to stop the turn, so it doesn't hang. Once the gateway confirms, the turn ends with a note naming the limit. Send a message to pick up where it left off. It applies to turns this device starts.",
  voice:
    "While it's on, a voice guide is added to a bot's system prompt each time the gateway runs the plugin's hook, if its config permits the hook. The guide asks the bots to talk plainly and kindly, with no em dashes.",
};

async function section(page: Page, name: string, query = "", theme: "dark" | "light" = "dark") {
  await openFixture(page, `scene=composer&${OTTO_DISK}&panel=closed&access=admin${query}`, theme);
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name, exact: true }).click();
  await expect(settings.getByRole("heading", { name, level: 3 })).toBeVisible();
  return settings;
}

const info = (scope: Locator | Page, about: string) =>
  scope.getByRole("button", { name: `About ${about}` });
const card = (scope: Locator | Page, id: string) => scope.locator(`#${id}`);

/** Whether two boxes overlap. */
async function overlap(a: Locator, b: Locator) {
  const [x, y] = [await a.boundingBox(), await b.boundingBox()];
  if (!x || !y) throw new Error("not laid out");
  return x.x < y.x + y.width && y.x < x.x + x.width && x.y < y.y + y.height && y.y < x.y + x.height;
}

/**
 * What an open card covers in `scope`: every visible control, and every line that stays in view
 * (a hint, a warning, an error), that its box overlaps. Empty when it covers nothing.
 */
async function covered(scope: Locator | Page, open: Locator) {
  const box = await open.boundingBox();
  if (!box) throw new Error("the card isn't laid out");
  const under: string[] = [];
  const things = scope.locator(
    'button, input, textarea, select, [role="switch"], [role="radio"], .b-hint, .ci-hint, .form-error, .b-field-error',
  );
  for (const thing of await things.all()) {
    if (!(await thing.isVisible())) continue;
    const at = await thing.boundingBox();
    if (!at) continue;
    if (
      box.x < at.x + at.width &&
      at.x < box.x + box.width &&
      box.y < at.y + at.height &&
      at.y < box.y + box.height
    )
      under.push(
        (await thing.getAttribute("aria-label")) ?? (await thing.innerText()).slice(0, 40),
      );
  }
  return under;
}

test.describe("F-613: the explanation behind an i", () => {
  test.use(contextFor(WIDE, "dark"));

  test("each moved explanation is its control's description, in its exact words, while closed", async ({
    page,
  }) => {
    let settings = await section(page, "Advanced");
    for (const [id, words] of [
      ["show-commands", WORDS.commands],
      ["show-thinking", WORDS.thinking],
      ["channel-chats", WORDS.channels],
      ["other-tool-sessions", WORDS.otherTools],
      ["gateway-bot", WORDS.gatewayBot],
    ] as const) {
      await expect(settings.getByTestId(id)).toHaveAccessibleDescription(words);
    }
    // Nothing of it shows until the "i" is opened.
    await expect(settings.getByText(WORDS.channels)).toBeHidden();
    settings = await section(page, "Conversation");
    await expect(
      settings.getByRole("spinbutton", { name: "Turn time limit" }),
    ).toHaveAccessibleDescription(WORDS.turnLimit);
    await expect(settings.getByRole("switch", { name: "Bot voice" })).toHaveAccessibleDescription(
      WORDS.voice,
    );
    await expect(settings.getByText(WORDS.turnLimit)).toBeHidden();
    // The "i" says what it explains, and the card's words are the same.
    await expect(info(settings, "Turn time limit")).toHaveAccessibleDescription(WORDS.turnLimit);
  });

  test("hover opens it, and leaving puts it away", async ({ page }) => {
    const settings = await section(page, "Conversation");
    const i = info(settings, "Turn time limit");
    await i.hover();
    await expect(card(settings, "turn-limit-note")).toBeVisible();
    await expect(i).toHaveAttribute("aria-expanded", "true");
    await page.mouse.move(5, 5);
    await expect(card(settings, "turn-limit-note")).toBeHidden();
  });

  test("keyboard focus opens it; Escape puts it away and Settings stays; focus leaving puts it away", async ({
    page,
  }) => {
    const settings = await section(page, "Conversation");
    const i = info(settings, "Turn time limit");
    await i.focus();
    await expect(card(settings, "turn-limit-note")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(card(settings, "turn-limit-note")).toBeHidden();
    await expect(settings).toBeVisible();
    await expect(i).toBeFocused();
    // Enter opens it again from the keyboard.
    await page.keyboard.press("Enter");
    await expect(card(settings, "turn-limit-note")).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(settings.getByRole("spinbutton", { name: "Turn time limit" })).toBeFocused();
    await expect(card(settings, "turn-limit-note")).toBeHidden();
  });

  test("its field's unit is part of the field's name", async ({ page }) => {
    const settings = await section(page, "Conversation");
    await expect(settings.getByTestId("turn-limit")).toHaveAccessibleName(
      "Turn time limit minutes",
    );
  });

  test("Escape puts away a card opened by hover, wherever focus is, and nothing else", async ({
    page,
  }) => {
    await openFixture(
      page,
      `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=write&uview=usage&budget=none`,
      "dark",
    );
    await page.getByTestId("budget-new").click();
    const field = page.getByTestId("budget-tokens");
    await field.fill("250000");
    await expect(field).toBeFocused();
    // The pointer over the "i", focus still in the field: Escape closes the card only.
    await info(page, "Tokens").hover();
    const shown = page.locator(".info-tip-card:not([hidden])");
    await expect(shown).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(shown).toHaveCount(0);
    await expect(page.getByTestId("budget-form")).toBeVisible();
    await expect(field).toHaveValue("250000");
    // And in Settings: the dialog stays.
    const settings = await section(page, "Conversation");
    await settings.getByRole("spinbutton", { name: "Turn time limit" }).focus();
    await info(settings, "Turn time limit").hover();
    await expect(card(settings, "turn-limit-note")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(card(settings, "turn-limit-note")).toBeHidden();
    await expect(settings).toBeVisible();
  });

  test("a card put away with Escape after a press stays away when the pointer leaves", async ({
    page,
  }) => {
    const settings = await section(page, "Conversation");
    const i = info(settings, "Turn time limit");
    await i.click();
    await expect(card(settings, "turn-limit-note")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(card(settings, "turn-limit-note")).toBeHidden();
    await page.mouse.move(5, 5);
    await page.waitForTimeout(400);
    await expect(card(settings, "turn-limit-note")).toBeHidden();
  });

  test("one card is open at a time", async ({ page }) => {
    const settings = await section(page, "Conversation");
    await info(settings, "Turn time limit").focus();
    await expect(card(settings, "turn-limit-note")).toBeVisible();
    await info(settings, "Bot voice").hover();
    await expect(card(settings, "bot-voice-note")).toBeVisible();
    await expect(card(settings, "turn-limit-note")).toBeHidden();
    await expect(settings.locator(".info-tip-card:not([hidden])")).toHaveCount(1);
  });

  test("an open card covers no control and no line that stays in view", async ({ page }) => {
    let settings = await section(page, "Conversation");
    for (const [about, id] of [
      ["Turn time limit", "turn-limit-note"],
      ["Bot voice", "bot-voice-note"],
    ] as const) {
      await info(settings, about).click();
      await expect(card(settings, id)).toBeVisible();
      expect(await covered(settings, card(settings, id)), about).toEqual([]);
      await page.keyboard.press("Escape");
    }
    settings = await section(page, "Advanced");
    for (const about of [
      "Show commands",
      "Show external channel chats",
      "Show the gateway's own bot",
    ]) {
      await info(settings, about).click();
      const open = settings.locator(".info-tip-card:not([hidden])");
      expect(await covered(settings, open), about).toEqual([]);
      await page.keyboard.press("Escape");
    }
    await openFixture(
      page,
      `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=write&uview=usage&budget=none`,
      "dark",
    );
    await page.getByTestId("budget-new").click();
    await info(page, "Tokens").click();
    const form = page.getByTestId("budget-form");
    expect(await covered(form, form.locator(".info-tip-card:not([hidden])"))).toEqual([]);
    await openFixture(page, `scene=main&${OTTO_DISK}&access=admin&checkins=every`, "dark");
    await checkIns(page);
    await page.getByRole("button", { name: "Change Otto's check-ins" }).click();
    const dialog = page.getByRole("dialog", { name: "Otto's check-ins" });
    await info(dialog, "Prompt").click();
    expect(await covered(dialog, dialog.locator(".info-tip-card:not([hidden])"))).toEqual([]);
  });

  test("it never covers the control it explains", async ({ page }) => {
    let settings = await section(page, "Conversation");
    for (const [about, id, control] of [
      [
        "Turn time limit",
        "turn-limit-note",
        settings.getByRole("spinbutton", { name: "Turn time limit" }),
      ],
      ["Bot voice", "bot-voice-note", settings.getByRole("switch", { name: "Bot voice" })],
    ] as const) {
      await info(settings, about).click();
      await expect(card(settings, id)).toBeVisible();
      expect(await overlap(card(settings, id), control), about).toBe(false);
      expect(await overlap(card(settings, id), info(settings, about)), about).toBe(false);
      await page.keyboard.press("Escape");
    }
    settings = await section(page, "Advanced");
    await info(settings, "Show external channel chats").click();
    expect(
      await overlap(card(settings, "channel-chats-note"), settings.getByTestId("channel-chats")),
    ).toBe(false);
  });

  test("the budget's tokens and a check-in's prompt keep their explanations, and their warnings stay in view", async ({
    page,
  }) => {
    await openFixture(
      page,
      `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=write&uview=usage&budget=none`,
      "dark",
    );
    await page.getByTestId("budget-new").click();
    const field = page.getByTestId("budget-tokens");
    await expect(field).toHaveAccessibleDescription(
      /^A whole number of 1,000 or more: the total the gateway reports for \S.* each week, .*, input, output and cache together\. A warning only: nothing on the gateway stops a bot at its budget\.$/,
    );
    await expect(
      page.getByText("A warning only: nothing on the gateway stops a bot at its budget."),
    ).toBeVisible();
    // Escape on the "i" puts the card away, not the form.
    await info(page, "Tokens").click();
    await expect(
      card(page, `${(await field.getAttribute("id"))!.replace(/-tokens$/, "")}-help`),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("budget-form")).toBeVisible();

    await openFixture(page, `scene=main&${OTTO_DISK}&access=admin&checkins=every`, "dark");
    await checkIns(page);
    await page.getByRole("button", { name: "Change Otto's check-ins" }).click();
    const dialog = page.getByRole("dialog", { name: "Otto's check-ins" });
    const prompt = dialog.getByRole("textbox", { name: "Prompt" });
    await expect(prompt).toHaveAccessibleDescription(
      /Empty uses the (prompt the gateway sets for every bot|gateway's built-in prompt, which asks the bot to reply NO_REPLY when nothing needs attention)\. Up to 4,000 characters\.$/,
    );
    // Its typed prompt's note is a warning about what it replaces: in view.
    await expect(dialog.getByTestId("prompt-note")).toBeVisible();
  });
});

test.describe("F-613: at phone width", () => {
  test.use(contextFor(PHONE, "dark"));

  test("a tap opens it, fitting the screen; a second tap or a tap elsewhere puts it away", async ({
    page,
  }) => {
    const settings = await section(page, "Conversation");
    const i = info(settings, "Turn time limit");
    await i.tap();
    const shown = card(settings, "turn-limit-note");
    await expect(shown).toBeVisible();
    const box = (await shown.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      PHONE.width,
    );
    expect(
      await overlap(shown, settings.getByRole("spinbutton", { name: "Turn time limit" })),
    ).toBe(false);
    await i.tap();
    await expect(shown).toBeHidden();
    await i.tap();
    await expect(shown).toBeVisible();
    await settings.getByRole("heading", { name: "Conversation", level: 3 }).tap();
    await expect(shown).toBeHidden();
  });
});

for (const size of [WIDE, PHONE]) {
  test.describe(`settings info ${size.name}`, () => {
    test.use(contextFor(size, "dark"));
    for (const [name, sectionName, about] of [
      ["conversation", "Conversation", "Turn time limit"],
      ["advanced", "Advanced", "Show external channel chats"],
    ] as const) {
      test(`F-613: ${sectionName} with one "i" open`, async ({ page }) => {
        const settings = await section(page, sectionName);
        await info(settings, about).click();
        await settle(page);
        await expect(page).toHaveScreenshot(`settings-info-${name}-dark-${size.name}.png`);
      });
    }
    test(`F-613: a budget's tokens with its "i" open`, async ({ page }) => {
      await openFixture(
        page,
        `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=write&uview=usage&budget=none`,
        "dark",
      );
      await page.getByTestId("budget-new").click();
      await info(page, "Tokens").click();
      await settle(page);
      await expect(page).toHaveScreenshot(`settings-info-budget-dark-${size.name}.png`);
    });
    test(`F-613: a check-in's prompt with its "i" open`, async ({ page }) => {
      await openFixture(page, `scene=main&${OTTO_DISK}&access=admin&checkins=every`, "dark");
      await checkIns(page);
      await page.getByRole("button", { name: "Change Otto's check-ins" }).click();
      const dialog = page.getByRole("dialog", { name: "Otto's check-ins" });
      await info(dialog, "Prompt").click();
      await settle(page);
      await expect(page).toHaveScreenshot(`settings-info-checkin-dark-${size.name}.png`);
    });
  });
}
