// How the account screens behave (docs/design/bots.md, sections 2 to 11 and
// 19): the "+" menu and ⌘N, focus in and out of the dialogs, the radio groups'
// one tab stop and arrows, the selects, Escape that belongs to the innermost
// thing, the access bar for admin, and what a read-only connection shows.
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, settle, SIZES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.phone)!;
const ADMIN = `scene=main&${OTTO_DISK}&access=admin`;

test.use(contextFor(WIDE, "light"));

const newBot = (page: Page) => page.getByTestId("new-bot");
const sent = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { clawtrateFixture: { sent: Array<Record<string, unknown>> } }
    ).clawtrateFixture.sent.map((each) => ({ ...each })),
  );

test("F-034: the + menu offers New bot with ⌘N; New bot opens on its name, and Escape gives focus back to +", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  const plus = page.getByTestId("plus");
  await plus.click();
  const menu = page.getByRole("menu", { name: "New" });
  await expect(menu.getByRole("menuitem", { name: "New bot" })).toBeFocused();
  await expect(menu).toContainText("⌘N");
  await page.keyboard.press("Enter");
  await expect(newBot(page)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Name" })).toBeFocused();
  // The live picture follows the shape and colour chosen.
  await page.getByRole("radio", { name: "gem" }).click();
  await page.getByRole("radio", { name: "Blue" }).click();
  await expect(page.locator(".b-preview svg g").first()).toHaveAttribute("fill", "#5b8dff");
  await page.keyboard.press("Escape");
  await expect(newBot(page)).toHaveCount(0);
  await expect(plus).toBeFocused();
  // What was entered is kept: the dialog opens again with it, from ⌘N.
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page.getByRole("radio", { name: "gem" })).toHaveAttribute("aria-checked", "true");
});

test("F-034: shapes and colours are radio groups of one tab stop; arrows move and choose; Enter in the name is Next", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("textbox", { name: "Name" }).fill("Viral");
  await page.keyboard.press("Tab");
  const drop = page.getByRole("radio", { name: "drop" });
  await expect(drop).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "gem" })).toBeFocused();
  await expect(page.getByRole("radio", { name: "gem" })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Home");
  await expect(page.getByRole("radio", { name: "pebble" })).toHaveAttribute("aria-checked", "true");
  // One tab stop: Tab leaves the group for the colours.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("radio", { name: "Pink" })).toBeFocused();
  await page.getByRole("textbox", { name: "Name" }).press("Enter");
  await expect(page.getByRole("heading", { name: "Account", level: 2 })).toBeVisible();
  await expect(page.getByText("Choose the account Viral runs on.")).toBeVisible();
  // Back keeps everything.
  await page.getByRole("button", { name: "Back to the picture" }).click();
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue("Viral");
  await expect(page.getByRole("radio", { name: "pebble" })).toHaveAttribute("aria-checked", "true");
});

test("F-472: the Account step: subscriptions first, the gateway's choice last; Create waits for a choice; arrows choose", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("button", { name: "Next" }).click();
  const group = page.getByRole("radiogroup", { name: "Accounts" });
  await expect(group.locator(".b-group")).toHaveText(["Subscriptions", "API keys"]);
  const radios = group.getByRole("radio");
  await expect(radios.first()).toHaveAccessibleName(/^OpenAI · Work, Subscription, Marlow, Otto$/);
  await expect(radios.last()).toHaveAccessibleName(
    /^Let the gateway choose\. No fixed account\. The gateway picks one of OpenAI's accounts for each run, as its account order allows, with its default model, gpt-5\.5\.$/,
  );
  // An account kept by one bot is not offered to a bot that does not exist yet.
  await expect(group.getByRole("radio", { name: /Pip's key/ })).toHaveCount(0);
  // Nothing chosen: Create waits, and says why.
  await expect(page.getByTestId("create")).toBeDisabled();
  await expect(page.getByText("Choose an account, or let the gateway choose.")).toBeVisible();
  // One tab stop, the first row when none is chosen; arrows move and choose.
  await radios.first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(radios.nth(1)).toBeFocused();
  await expect(radios.nth(1)).toHaveAttribute("aria-checked", "true");
  await expect(group.locator('[role="radio"][tabindex="0"]')).toHaveCount(1);
  await page.keyboard.press("End");
  await expect(radios.last()).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("create")).toBeEnabled();
  // The model and effort follow, for the default model's provider.
  await expect(page.getByTestId("model-select")).toHaveAccessibleName("Model: gpt-5.5");
  await expect(page.getByTestId("effort-select")).toHaveAccessibleName("Effort: Medium");
});

test("F-472: when the gateway's default model names an account, that account is chosen at first, and the step says why", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&defacct=1`, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("radio", { name: /^OpenAI · Work/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(
    page.getByText("Chosen because the gateway's default model names it."),
  ).toBeVisible();
});

test("F-472: Create writes the bot on the account chosen, with its model and effort, then opens it", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("textbox", { name: "Name" }).fill("Viral");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("radio", { name: /^xAI · Personal/ }).click();
  await expect(page.getByTestId("model-select")).toHaveAccessibleName("Model: grok-4.7");
  // A model with no levels offers no effort.
  await page.getByTestId("model-select").click();
  await page.getByRole("menuitemradio", { name: "grok-build-0.1" }).click();
  await expect(page.getByTestId("effort-select")).toHaveAccessibleName("Effort: Not offered");
  await expect(page.getByTestId("effort-select")).toBeDisabled();
  await page.getByTestId("create").click();
  await expect(newBot(page)).toHaveCount(0);
  const create = (await sent(page)).find((each) => each.type === "createBot");
  expect(create).toMatchObject({
    name: "Viral",
    account: "xai:personal",
    provider: "xai",
    model: "grok-build-0.1",
    effort: null,
  });
  expect(String(create!.avatar)).toMatch(/^data:image\/png;base64,/);
  await expect(
    page.getByTestId("bot-list").getByRole("button", { name: /^Viral\b/ }),
  ).toBeVisible();
});

test("F-472: below admin the rows show but cannot be chosen, and the access bar takes Create's place; what was chosen survives the request", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}&access=write&admin=grant`, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("textbox", { name: "Name" }).fill("Viral");
  await page.getByRole("button", { name: "Next" }).click();
  const work = page.getByRole("radio", { name: /^OpenAI openai:work/ });
  await expect(work).toHaveAttribute("aria-disabled", "true");
  await work.click({ force: true });
  await expect(work).toHaveAttribute("aria-checked", "false");
  const bar = page.getByTestId("admin-bar");
  await expect(bar).toContainText(
    "Admin access needed. Creating a bot changes the gateway's settings, which needs admin access. What you chose stays here while you ask.",
  );
  await bar.getByRole("button", { name: "Request admin access" }).click();
  await expect(bar).toContainText("Waiting for the gateway's owner.");
  await expect(bar.getByTestId("command")).toContainText("openclaw devices approve");
  expect(
    (await sent(page)).some((each) => each.type === "requestAccess" && each.tier === "admin"),
  ).toBe(true);
  await expect(page.getByTestId("admin-bar")).toContainText("Admin access granted.");
  // Granted: labels arrive, the name is kept, and the rows can be chosen.
  await expect(page.getByText("Choose the account Viral runs on.")).toBeVisible();
  await page.getByRole("radio", { name: /^OpenAI · Work/ }).click();
  await expect(page.getByRole("radio", { name: /^OpenAI · Work/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("F-474: a sign-in's stages: the code with its link; Back cancels; the API key path is folded and never chosen", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Connect another account" }).click();
  // Subscriptions first; OpenRouter, billed per token, after.
  await expect(newBot(page).locator(".b-group")).toHaveText(["Subscriptions", "Billed per token"]);
  const disclosure = newBot(page).locator("details.b-disclosure");
  await expect(disclosure).not.toHaveAttribute("open", "");
  await expect(page.getByTestId("api-key")).toBeHidden();
  await newBot(page)
    .getByRole("button", { name: /^xAI · / })
    .click();
  await expect(page.getByRole("heading", { name: "Sign in to xAI", level: 2 })).toBeVisible();
  await expect(page.getByRole("group", { name: "Code QK4F 7PZD" })).toBeVisible();
  await expect(page.getByTestId("open-page")).toHaveAttribute("target", "_blank");
  await expect(page.getByText("Waiting for xAI. The code works for 15 minutes.")).toBeVisible();
  // Back returns to the methods and cancels the sign-in in progress.
  await page.getByRole("button", { name: "Back to sign-in methods" }).click();
  await expect(page.getByRole("heading", { name: "Connect an account", level: 2 })).toBeVisible();
  expect((await sent(page)).map((each) => each.type)).toEqual(
    expect.arrayContaining(["startSignIn", "cancelSignIn"]),
  );
});

test("F-474: a pasted code is a password field, cleared as it is sent", async ({ page }) => {
  await openFixture(page, ADMIN, "light");
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Connect another account" }).click();
  await newBot(page)
    .getByRole("button", { name: /^ChatGPT in the browser/ })
    .click();
  const paste = page.getByTestId("paste");
  await expect(paste).toHaveAttribute("type", "password");
  await expect(paste).toHaveAttribute("autocomplete", "off");
  await paste.fill("made-up-code-0001");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Connected to OpenAI" })).toBeVisible();
  expect(await page.content()).not.toContain("made-up-code-0001");
  // The label step: another OpenAI account exists, so a label is required.
  await expect(page.getByRole("textbox", { name: "Label" })).toBeFocused();
  await expect(page.getByRole("button", { name: "Done" })).toBeDisabled();
  await page.getByRole("textbox", { name: "Label" }).fill("Studio");
  await page.getByRole("button", { name: "Done" }).click();
  // Back on the Account step, the new account chosen.
  await expect(page.getByRole("radio", { name: /^OpenAI · Studio/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("F-490: the Account page: the lock command, Check now, and Back to the row that opened it", async ({
  page,
}) => {
  await openFixture(
    page,
    `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=admin&lock=bound`,
    "light",
  );
  const row = page.getByRole("button", { name: /^Account: OpenAI · Work, Bound\. Open\.$/ });
  await row.click();
  await expect(page.getByRole("heading", { name: "Account", level: 3 })).toBeFocused();
  await expect(page.getByTestId("bound-note")).toContainText(
    "Bound. Otto runs on OpenAI · Work. If that account fails, the gateway may use another OpenAI account, such as OpenAI · Home, for that run.",
  );
  await expect(page.getByTestId("command")).toHaveText(
    "openclaw models auth order set --provider openai --agent otto openai:work",
  );
  // Copying the command: the page watches for the lock, every 4 seconds.
  await page.getByRole("button", { name: "Copy lock command" }).click();
  await expect(page.getByText("Checking the gateway for the lock, again in 4s")).toBeVisible();
  await page.getByRole("button", { name: "Check now" }).click();
  expect((await sent(page)).filter((each) => each.type === "checkLock").length).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Back to settings" }).click();
  await expect(row).toBeFocused();
});

test("F-490: what a lock doesn't cover is folded; the read that failed keeps the last confirmation, with its time", async ({
  page,
}) => {
  await openFixture(
    page,
    `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=admin&lock=failed`,
    "light",
  );
  await page
    .getByRole("button", { name: /^Account: OpenAI · Work, Locked, as of 5:28 PM\. Open\.$/ })
    .click();
  await expect(page.getByTestId("locked-note")).toContainText("Locked, as of 5:28 PM.");
  await expect(page.getByTestId("evidence-failed")).toContainText(
    "Couldn't read the gateway's order for Otto. Last confirmed locked at 5:28 PM.",
  );
  const ways = page.locator("details.b-disclosure", { hasText: "What a lock doesn't cover" });
  await expect(ways).not.toHaveAttribute("open", "");
  await ways.locator("summary").click();
  await expect(ways.locator("li")).toHaveCount(8);
});

test("F-473: changing a locked bot's account: the note before saving, then the lock out of date with both commands", async ({
  page,
}) => {
  await openFixture(
    page,
    `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=admin&lock=locked`,
    "light",
  );
  await page.getByRole("button", { name: /^Account: / }).click();
  await page.getByRole("button", { name: "Change account" }).click();
  await expect(page.getByRole("heading", { name: "Change account", level: 3 })).toBeFocused();
  const save = page.getByRole("button", { name: "Save" });
  await expect(save).toBeDisabled();
  await page.getByRole("radio", { name: /^OpenAI · Home/ }).click();
  await expect(
    page.getByText(
      /Otto is locked to OpenAI · Work\. After saving, Otto runs on OpenAI · Home first/,
    ),
  ).toBeVisible();
  await save.click();
  await expect(page.getByTestId("stale-note")).toContainText(
    "The lock is out of date. Otto runs on OpenAI · Home first, but the gateway's order for Otto still lists only OpenAI · Work",
  );
  await expect(page.getByTestId("command").first()).toHaveText(
    "openclaw models auth order set --provider openai --agent otto openai:home",
  );
  await expect(page.getByRole("heading", { name: "Account", level: 3 })).toBeFocused();
});

test("F-478: changing to a provider that lacks the bot's model asks for a model before saving, and the effort follows it", async ({
  page,
}) => {
  await openFixture(
    page,
    `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=admin&lock=bound`,
    "light",
  );
  await page.getByRole("button", { name: /^Account: / }).click();
  await page.getByRole("button", { name: "Change account" }).click();
  await page.getByRole("radio", { name: /^xAI · Personal/ }).click();
  await expect(
    page.getByText("xAI doesn't offer gpt-5.5. Choose one of its models."),
  ).toBeVisible();
  const save = page.getByRole("button", { name: "Save" });
  await expect(save).toBeDisabled();
  // Down opens the select's menu; Escape closes the menu alone.
  await page.getByTestId("model-select").focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menu", { name: "Model" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "Model" })).toHaveCount(0);
  await expect(page.getByTestId("model-select")).toBeFocused();
  await expect(page.getByTestId("work-panel")).toBeVisible();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitemradio", { name: "grok-4.7" }).click();
  await expect(page.getByTestId("effort-select")).toHaveAccessibleName("Effort: Low");
  await expect(save).toBeEnabled();
  await save.click();
  const change = (await sent(page)).find((each) => each.type === "changeBotAccount");
  expect(change).toMatchObject({
    botId: "otto",
    account: "xai:personal",
    provider: "xai",
    model: "grok-4.7",
    effort: "low",
  });
});

test("F-472: Let the gateway choose for an existing bot, and the one-account order still stored, with its clear command", async ({
  page,
}) => {
  await openFixture(
    page,
    `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=admin&lock=retained`,
    "light",
  );
  await page.getByRole("button", { name: /^Account: OpenAI, Gateway chooses\. Open\.$/ }).click();
  await expect(page.getByTestId("gateway-note")).toContainText("The gateway chooses.");
  await expect(page.getByTestId("retained-order")).toContainText(
    "The gateway still has an order for Otto that names only OpenAI · Work",
  );
  await expect(page.getByTestId("retained-order").getByTestId("command")).toHaveText(
    "openclaw models auth order clear --provider openai --agent otto",
  );
  await page.getByRole("button", { name: "Bind to an account" }).click();
  await expect(page.getByRole("radio", { name: /^Let the gateway choose/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("F-476: below admin there are no labels: accounts are told apart by their ids; nothing that would do nothing is offered", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}&access=read`, "light");
  // On the read tier there is no "+".
  await expect(page.getByTestId("plus")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+n");
  await expect(newBot(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Accounts", exact: true }).click();
  await expect(settings.getByRole("button", { name: /^OpenAI openai:work, / })).toBeVisible();
  await expect(settings.getByRole("button", { name: /^OpenAI openai:home, / })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Connect an account" })).toHaveCount(0);
  await expect(settings.getByTestId("admin-bar")).toContainText("Read-only.");
  await settings.getByRole("button", { name: /^OpenAI openai:work, / }).click();
  await expect(settings.getByRole("button", { name: "Disconnect…" })).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "Edit label" })).toHaveCount(0);
  // Escape closes Settings, and ⌘, opens it again on the section last shown.
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+,");
  await expect(settings.getByRole("heading", { name: "Accounts", level: 3 })).toBeVisible();
});

test("F-490: a read-only connection shows a bot's settings with every value, and changes nothing", async ({
  page,
}) => {
  await openFixture(
    page,
    `scene=main&${OTTO_DISK}&panel=open&tab=settings&access=read&lock=locked`,
    "light",
  );
  await expect(page.getByTestId("model-select")).toBeDisabled();
  await page
    .getByRole("button", { name: /^Account: OpenAI openai:work, Locked\. Open\.$/ })
    .click();
  await expect(page.getByTestId("locked-note")).toBeVisible();
  await expect(page.getByRole("button", { name: "Change account" })).toHaveCount(0);
  await expect(page.getByTestId("admin-bar")).toContainText(
    "Changing Otto's settings needs admin access.",
  );
});

test("F-476: Disconnect asks first, with focus on Cancel; Escape closes the confirmation alone", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "light");
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Accounts", exact: true }).click();
  await settings.getByRole("button", { name: /^OpenAI · Work, / }).click();
  await expect(settings.getByTestId("account-facts")).toContainText("Used byMarlow, Otto (locked)");
  await settings.getByRole("button", { name: "Disconnect…" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Disconnect OpenAI · Work?" });
  await expect(confirm).toHaveAccessibleDescription(
    "Marlow and Otto use it. They show No account until you choose another, and Clawtrate doesn't start them until then. Your gateway removes the sign-in.",
  );
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(settings).toBeVisible();
  // A label already used by the provider is refused, and the field says why.
  await settings.getByRole("button", { name: "Edit label" }).click();
  await settings.getByRole("textbox", { name: "Label" }).fill("home");
  await settings.getByRole("button", { name: "Save" }).click();
  await expect(settings.getByRole("textbox", { name: "Label" })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(settings.locator("#b-relabel-error")).toHaveText(
    "Another OpenAI account is called Home. Choose a different label.",
  );
});

test.describe("phone", () => {
  test.use(contextFor(PHONE, "light"));
  test("F-034: on a phone New bot is a sheet over the screen, and Settings opens on its list", async ({
    page,
  }) => {
    await openFixture(page, ADMIN, "light");
    await page.keyboard.press("ControlOrMeta+n");
    const sheet = newBot(page);
    await expect(sheet).toBeVisible();
    const box = (await sheet.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(388);
    expect(box.height).toBeGreaterThan(780);
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+,");
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings.getByRole("navigation", { name: "Settings" })).toBeVisible();
    await settings.getByRole("button", { name: "Accounts", exact: true }).click();
    await expect(settings.getByRole("navigation", { name: "Settings" })).toBeHidden();
    await settings.getByRole("button", { name: "Back to settings" }).click();
    await expect(settings.getByRole("navigation", { name: "Settings" })).toBeVisible();
    await settle(page);
  });
});
