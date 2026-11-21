// How New bot's Approvals step, the first-bot prompt and a new bot's
// command-setting note behave (docs/design/bots.md section 3,
// docs/design/controls.md section 10), in the fixture: nothing chosen at first
// and Create waiting for a choice, the radio group's names and keys, the
// choices gone below admin, the outcomes of Create, the prompt only where the
// fixture says the reads confirmed an unused implicit main, and the composer
// closed until the setting reads back as chosen. Dark first; light is checked
// as its own case.
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, SIZES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.phone)!;
const ADMIN = `scene=main&${OTTO_DISK}&access=admin`;

test.use(contextFor(WIDE, "dark"));

const newBot = (page: Page) => page.getByTestId("new-bot");
const sent = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { clawtrateFixture: { sent: Array<Record<string, unknown>> } }
    ).clawtrateFixture.sent.map((each) => ({ ...each })),
  );
const change = (page: Page, run: string) =>
  page.evaluate((body) => {
    const fixture = (
      window as unknown as {
        clawtrateFixture: { setState: (change: (state: unknown) => unknown) => void };
      }
    ).clawtrateFixture;
    fixture.setState(new Function("state", body) as (state: unknown) => unknown);
  }, run);

/** New bot as far as its Approvals step, with an account chosen. */
async function approvalsStep(page: Page, name = "Viral") {
  await page.keyboard.press("ControlOrMeta+n");
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("radio", { name: /^OpenAI · Home/ }).click();
  await page.getByTestId("account-next").click();
  await expect(page.getByRole("heading", { name: "Approvals", level: 2 })).toBeVisible();
}

test("F-051 F-034: the Approvals step comes after Account; nothing is chosen at first and Create waits for a choice", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "dark");
  await approvalsStep(page);
  await expect(page.getByText("When Viral wants to run a command:")).toBeVisible();
  const group = page.getByRole("radiogroup", { name: "Approvals" });
  const ask = group.getByRole("radio", { name: "Ask before acting" });
  const full = group.getByRole("radio", { name: "Run without routine approvals" });
  // Each row's name is its title; its line is its description. Neither is marked recommended.
  await expect(ask).toHaveAccessibleDescription(
    "Sets Viral's command policy to ask for approval when a command misses the machine's allowlist.",
  );
  await expect(full).toHaveAccessibleDescription(
    "Sets Viral's command policy to run without routine approval. The machine, the task or a rule can still require approval or block a command.",
  );
  await expect(group.getByRole("radio", { checked: true })).toHaveCount(0);
  await expect(group).not.toContainText(/recommended/i);
  await expect(
    page.getByText(
      "Commands use the machine and permissions set by the gateway. Viral's command setting replaces the gateway-wide command mode for this bot. You can change this later in Viral's settings.",
    ),
  ).toBeVisible();
  await expect(page.getByTestId("approvals-file")).toHaveText(
    "The gateway's approvals file can require approval or block commands.",
  );
  await expect(page.getByTestId("create")).toBeDisabled();
  await expect(page.getByTestId("choose-line")).toHaveText("Choose how Viral runs commands.");
  await expect(page.getByTestId("inherits")).toHaveCount(0);
  // Clicking Create sends nothing while nothing is chosen.
  await page.getByTestId("create").click({ force: true });
  expect((await sent(page)).some((each) => each.type === "createBot")).toBe(false);
  await ask.click();
  await expect(page.getByTestId("create")).toBeEnabled();
  await expect(page.getByTestId("inherits")).toHaveText(
    "Before Clawtrate sets Viral's policy, the new bot inherits the gateway's settings.",
  );
});

test("F-051: one tab stop, its first row while nothing is chosen; arrows move and choose; Space chooses and focus stays", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "dark");
  await approvalsStep(page);
  const group = page.getByRole("radiogroup", { name: "Approvals" });
  const rows = group.getByRole("radio");
  await expect(group.locator('[role="radio"][tabindex="0"]')).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("tabindex", "0");
  await rows.first().focus();
  await page.keyboard.press("Space");
  await expect(rows.first()).toHaveAttribute("aria-checked", "true");
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(1)).toBeFocused();
  await expect(rows.nth(1)).toHaveAttribute("aria-checked", "true");
  await expect(rows.first()).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Home");
  await expect(rows.first()).toHaveAttribute("aria-checked", "true");
  await expect(group.locator('[role="radio"][tabindex="0"]')).toHaveCount(1);
});

test("F-051: the choice is kept through Back and closing the dialog, until Create", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "dark");
  await approvalsStep(page);
  await page.getByRole("radio", { name: "Run without routine approvals" }).click();
  await page.getByRole("button", { name: "Back to the account" }).click();
  await expect(page.getByRole("heading", { name: "Account", level: 2 })).toBeVisible();
  await page.getByTestId("account-next").click();
  await expect(page.getByRole("radio", { name: "Run without routine approvals" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(newBot(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page.getByRole("radio", { name: "Run without routine approvals" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.getByTestId("create").click();
  await expect(newBot(page)).toHaveCount(0);
  expect((await sent(page)).find((each) => each.type === "createBot")).toMatchObject({
    name: "Viral",
    account: "openai:home",
    approvals: "full",
  });
  // Create cleared the draft.
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue("");
});

test("F-051: below admin the choices are never shown; access dropping while the step is open removes them and Create", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "dark");
  await approvalsStep(page);
  await expect(page.getByRole("radiogroup", { name: "Approvals" })).toBeVisible();
  await change(
    page,
    `return { ...state, connection: { ...state.connection, canAdmin: false, scopes: state.connection.scopes.filter((s) => s !== "operator.admin") } };`,
  );
  await expect(page.getByRole("radiogroup", { name: "Approvals" })).toHaveCount(0);
  await expect(page.getByTestId("create")).toHaveCount(0);
  await expect(page.getByTestId("admin-bar")).toBeVisible();
});

test("F-051: when the gateway's approvals file blocks commands, the line says so in the warning tone", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&approvalsfile=blocks`, "dark");
  await approvalsStep(page);
  const line = page.getByTestId("approvals-file");
  await expect(line).toHaveText("The gateway's approvals file blocks commands.");
  await expect(line).toHaveAttribute("data-tone", "warn");
  expect((await sent(page)).find((each) => each.type === "readApprovalsFile")).toMatchObject({
    name: "Viral",
  });
});

test("F-034 F-051: a Create whose reply settles nothing says so, offers Review bots, and not Create again", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&create=unconfirmed`, "dark");
  await approvalsStep(page);
  await page.getByRole("radio", { name: "Ask before acting" }).click();
  await page.getByTestId("create").click();
  const note = page.getByTestId("create-unconfirmed");
  await expect(note).toHaveText(
    "Clawtrate couldn't confirm whether Viral was created. Review the gateway's bot list.Review bots",
  );
  await expect(page.getByTestId("create")).toHaveCount(0);
  await note.getByRole("button", { name: "Review bots" }).click();
  await expect(newBot(page)).toHaveCount(0);
  const types = (await sent(page)).map((each) => each.type);
  expect(types.filter((type) => type === "createBot")).toHaveLength(1);
  expect(types).toContain("dismissBotCreation");
  expect(types).not.toContain("retryBotPolicy");
});

test("F-034: a refused Create says so and keeps every choice", async ({ page }) => {
  await openFixture(page, `${ADMIN}&create=failed`, "dark");
  await approvalsStep(page);
  await page.getByRole("radio", { name: "Ask before acting" }).click();
  await page.getByTestId("create").click();
  await expect(page.getByTestId("create-failed")).toHaveText(
    "Could not create the bot. Please try again.",
  );
  await expect(page.getByTestId("create")).toBeEnabled();
  await expect(page.getByRole("radio", { name: "Ask before acting" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("F-051 F-034: once created, the bot's first task names its saved setting and the reported label, then the composer opens", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "dark");
  await approvalsStep(page);
  await page.getByRole("radio", { name: "Ask before acting" }).click();
  await page.getByTestId("create").click();
  await expect(newBot(page)).toHaveCount(0);
  await expect(
    page.getByTestId("bot-list").getByRole("button", { name: /^Viral\b/ }),
  ).toHaveAttribute("aria-current", "true");
  const note = page.getByTestId("policy-note");
  await expect(note).toHaveText(
    "Viral's saved command setting is Ask before acting.The gateway reports that the default command policy asks on an allowlist miss.",
  );
  const field = page.getByTestId("composer-input");
  await expect(field).toBeEnabled();
  await expect(field).toHaveAttribute("placeholder", "Message Viral");
  await field.fill("hello");
  await field.press("Enter");
  await expect(note).toHaveCount(0);
});

test("F-051: a setting that didn't read back as chosen keeps the composer closed; Write it again, offered while the bot is identified, opens it", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&policy=unconfirmed`, "dark");
  await approvalsStep(page);
  await page.getByRole("radio", { name: "Run without routine approvals" }).click();
  await page.getByTestId("create").click();
  const note = page.getByTestId("policy-note");
  await expect(note).toContainText(
    "Clawtrate couldn't confirm Viral's command setting.Review the gateway's settings before sending a task.Its saved command setting is Never.",
  );
  await expect(page.getByTestId("composer-input")).toBeDisabled();
  await note.getByRole("button", { name: "Write it again" }).click();
  await expect(note).toHaveText(
    "Viral's saved command setting is Run without routine approvals.The gateway reports no routine approval in the default command policy.",
  );
  await expect(page.getByTestId("composer-input")).toBeEnabled();
  const types = (await sent(page)).map((each) => each.type);
  expect(types.filter((type) => type === "createBot")).toHaveLength(1);
  expect(types).toContain("retryBotPolicy");
});

test("F-051: with no fresh read identifying the bot, only Review settings is offered", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&policy=gone`, "dark");
  await approvalsStep(page);
  await page.getByRole("radio", { name: "Ask before acting" }).click();
  await page.getByTestId("create").click();
  const note = page.getByTestId("policy-note");
  await expect(note.getByRole("button", { name: "Review settings" })).toBeVisible();
  await expect(note.getByRole("button", { name: /Write/ })).toHaveCount(0);
  await note.getByRole("button", { name: "Review settings" }).click();
  await expect(page.getByRole("tab", { name: "Settings" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("F-051: a report with no label says the gateway reported none for the bot", async ({
  page,
}) => {
  await openFixture(page, `${ADMIN}&policy=nolabel`, "dark");
  await approvalsStep(page);
  await page.getByRole("radio", { name: "Ask before acting" }).click();
  await page.getByTestId("create").click();
  await expect(page.getByTestId("policy-note")).toHaveText(
    "Viral's saved command setting is Ask before acting.The gateway didn't report a default command policy for Viral.",
  );
});

test("F-005: on a confirmed unused implicit main the rail lists no bot and the app opens on Make your first bot; New bot checks again, then opens the dialog", async ({
  page,
}) => {
  await openFixture(page, "scene=main&access=admin&firstbot=read-only", "dark");
  await expect(page.getByTestId("bot")).toHaveCount(0);
  const prompt = page.getByTestId("first-bot");
  await expect(prompt.getByRole("heading", { name: "Make your first bot" })).toBeVisible();
  await expect(prompt).toContainText(
    "Give it a name and a picture, choose the account it runs on and how it runs commands.",
  );
  await expect(prompt.getByTestId("main-policy")).toHaveCount(0);
  await prompt.getByRole("button", { name: "New bot" }).click();
  await expect(newBot(page)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Name" })).toBeFocused();
  const types = (await sent(page)).map((each) => each.type);
  expect(types).toContain("recheckFirstBot");
  // Nothing is created until Create; then the roster is what the gateway lists.
  expect(types).not.toContain("createBot");
  await page.getByRole("textbox", { name: "Name" }).fill("Viral");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("radio", { name: /^OpenAI · Home/ }).click();
  await page.getByTestId("account-next").click();
  await page.getByRole("radio", { name: "Ask before acting" }).click();
  await page.getByTestId("create").click();
  await expect(prompt).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toHaveAttribute("placeholder", "Message Viral");
});

for (const [label, sentence] of [
  ["read-only", "The gateway reports that Main's default command policy disables commands."],
  ["guarded", "The gateway reports that Main's default command policy asks on an allowlist miss."],
  ["full", "The gateway reports no routine approval in Main's default command policy."],
  ["none", null],
] as const) {
  test(`F-005: below admin the prompt says what the gateway reports for Main (${label}) and asks for admin access`, async ({
    page,
  }) => {
    await openFixture(page, `scene=main&access=write&firstbot=${label}`, "dark");
    const prompt = page.getByTestId("first-bot");
    await expect(prompt).toContainText(
      "Creating a bot changes the gateway's settings, which needs admin access.",
    );
    if (sentence) await expect(prompt.getByTestId("main-policy")).toHaveText(sentence);
    else await expect(prompt.getByTestId("main-policy")).toHaveCount(0);
    await expect(prompt.getByRole("button", { name: "New bot" })).toHaveCount(0);
    await expect(prompt.getByRole("button", { name: "Request admin access" })).toBeVisible();
  });
}

test("F-005: on the read tier the prompt is how a person meets bots: no + button, and the access bar", async ({
  page,
}) => {
  await openFixture(page, "scene=main&access=read&firstbot=guarded", "dark");
  await expect(page.getByTestId("plus")).toHaveCount(0);
  await expect(page.getByTestId("first-bot")).toContainText("Make your first bot");
  await expect(page.getByTestId("main-policy")).toHaveText(
    "The gateway reports that Main's default command policy asks on an allowlist miss.",
  );
});

test("F-005: without a confirmed reading the normal roster shows, with no prompt", async ({
  page,
}) => {
  await openFixture(page, ADMIN, "dark");
  await expect(page.getByTestId("first-bot")).toHaveCount(0);
  await expect(page.getByTestId("bot").first()).toBeVisible();
});

test.describe("phone", () => {
  test.use(contextFor(PHONE, "dark"));
  test("F-034 F-051: the same Approvals step and Create on a phone", async ({ page }) => {
    await openFixture(page, ADMIN, "dark");
    await approvalsStep(page);
    await page.getByRole("radio", { name: "Ask before acting" }).click();
    await page.getByTestId("create").click();
    await expect(newBot(page)).toHaveCount(0);
    await expect(page.getByTestId("policy-note")).toContainText(
      "Viral's saved command setting is Ask before acting.",
    );
  });
});

test.describe("light", () => {
  test.use(contextFor(WIDE, "light"));
  test("F-051: the Approvals step reads the same in light", async ({ page }) => {
    await openFixture(page, ADMIN, "light");
    await approvalsStep(page);
    await expect(
      page.getByRole("radiogroup", { name: "Approvals" }).getByRole("radio"),
    ).toHaveCount(2);
    await expect(page.getByTestId("create")).toBeDisabled();
  });
});
