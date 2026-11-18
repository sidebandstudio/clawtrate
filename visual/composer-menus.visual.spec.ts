// The composer's "/" and "@" menus in the fixture mode (parity F-071, F-070):
// what typing a trigger lists, how a row is chosen by keyboard and pointer,
// and that its chip goes with the message. The gateway's lists are proven in
// e2e/preview.spec.ts.
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;

const open = (page: Page, theme: "light" | "dark" = "light") =>
  openFixture(page, `scene=composer&${OTTO_DISK}&panel=closed`, theme);
const field = (page: Page) => page.getByTestId("composer-input");

async function record(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      clawtrateFixture: Record<string, (command: unknown) => Promise<unknown>>;
      sent: unknown[];
    };
    w.sent = [];
    const fixture = w.clawtrateFixture;
    const invoke = fixture.invoke!.bind(fixture);
    fixture.invoke = (command) => (w.sent.push(command), invoke(command));
  });
}
const sends = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { sent: Array<{ type: string; text?: string }> }).sent.filter(
      (each) => each.type === "sendMessage",
    ),
  );

test.describe("the composer's menus", () => {
  test.use(contextFor(WIDE, "light"));

  test("F-071: typing / lists the bot's skills and the gateway's actions, each tagged Skill or Action", async ({
    page,
  }) => {
    await open(page);
    await field(page).click();
    await page.keyboard.type("/");
    const list = page.getByRole("listbox", { name: "Skills and actions" });
    const rows = list.getByRole("option");
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText("/healthcheck");
    await expect(rows.nth(0).locator(".composer-menu-tag")).toHaveText("Skill");
    await expect(rows.nth(2)).toContainText("/status");
    await expect(rows.nth(2).locator(".composer-menu-tag")).toHaveText("Action");
    await expect(field(page)).toHaveAttribute("aria-expanded", "true");
    await expect(field(page)).toHaveAttribute("aria-activedescendant", "composer-menu-0");
    // What follows the trigger narrows the list.
    await page.keyboard.type("wea");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("/weather");
  });

  test("F-071: choosing a row puts its chip in the message, and the chip is sent with the words", async ({
    page,
  }) => {
    await open(page);
    await record(page);
    await field(page).click();
    await page.keyboard.type("/");
    await page.keyboard.press("ArrowDown");
    await expect(field(page)).toHaveAttribute("aria-activedescendant", "composer-menu-1");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    const chip = page.getByTestId("token-chip");
    await expect(chip).toHaveText(/Skill\s*\/weather/);
    await expect(field(page)).toHaveValue("");
    // Nothing was sent by choosing.
    expect(await sends(page)).toEqual([]);
    await page.keyboard.type("for tomorrow in Lisbon");
    await page.keyboard.press("Enter");
    expect(await sends(page)).toMatchObject([{ text: "/weather for tomorrow in Lisbon" }]);
    await expect(chip).toHaveCount(0);
    await expect(page.getByTestId("outgoing")).toContainText("/weather for tomorrow in Lisbon");
  });

  test("F-071: Escape closes the menu and keeps the words; a chip is removed with its button or Backspace", async ({
    page,
  }) => {
    await open(page);
    await field(page).click();
    await page.keyboard.type("/sta");
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(field(page)).toHaveValue("/sta");
    await field(page).fill("");
    await page.keyboard.type("/");
    await page.getByRole("option", { name: /\/status/ }).click();
    await expect(page.getByTestId("token-chip")).toHaveCount(1);
    await expect(field(page)).toBeFocused();
    await page.keyboard.press("Backspace");
    await expect(page.getByTestId("token-chip")).toHaveCount(0);
    await page.keyboard.type("/");
    await page.keyboard.press("Tab");
    await page.getByRole("button", { name: "Remove /healthcheck" }).click();
    await expect(page.getByTestId("token-chip")).toHaveCount(0);
    // A slash later in a sentence is only a slash.
    await field(page).fill("");
    await page.keyboard.type("either this /");
    await expect(page.getByRole("listbox")).toHaveCount(0);
  });

  test("F-070: typing @ lists the bots and the gateway's routines, tagged, and puts the chosen name where it was typed", async ({
    page,
  }) => {
    await open(page);
    await record(page);
    await field(page).click();
    await page.keyboard.type("Ask @");
    const list = page.getByRole("listbox", { name: "Mention a bot or routine" });
    await expect(list.getByRole("option").filter({ hasText: "@Marlow" })).toContainText("Bot");
    await expect(list.getByRole("option").filter({ hasText: "@Morning disk check" })).toContainText(
      "Routine",
    );
    await page.keyboard.type("mar");
    await expect(list.getByRole("option")).toHaveCount(1);
    await page.keyboard.press("Enter");
    await expect(field(page)).toHaveValue("Ask @Marlow ");
    await page.keyboard.type("about the plan");
    await page.keyboard.press("Enter");
    expect(await sends(page)).toMatchObject([{ text: "Ask @Marlow about the plan" }]);
  });
});

for (const size of SIZES) {
  for (const theme of THEMES) {
    test.describe(`composer menu ${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      test("F-071: the / menu open over the composer, and a chip in it", async ({ page }) => {
        await open(page, theme);
        await field(page).click();
        await page.keyboard.type("/");
        await page.keyboard.press("Enter");
        await page.keyboard.type("/");
        await expect(page.getByRole("option")).toHaveCount(4);
        await settle(page);
        await expect(page).toHaveScreenshot(`composer-menu-${theme}-${size.name}.png`);
      });
    });
  }
}
