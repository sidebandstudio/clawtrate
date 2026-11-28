// The composer's "/" and "@" menus in the fixture mode (parity F-071, F-070):
// what typing a trigger lists, how a row is chosen by keyboard and pointer,
// and that its chip goes with the message. The gateway's lists are proven in
// e2e/preview.spec.ts.
import { test, type Page } from "@playwright/test";
import { contextFor, expect, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

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

  test("F-071: typing / lists the task's library skills, the bot's skills and the gateway's commands, each tagged with whose it is", async ({
    page,
  }) => {
    await open(page);
    await field(page).click();
    await page.keyboard.type("/");
    const list = page.getByRole("listbox", { name: "Skills and commands" });
    const rows = list.getByRole("option");
    await expect(rows).toHaveCount(7);
    // A library skill shows its name, not the generated command it inserts.
    await expect(rows.nth(0).locator(".composer-menu-name")).toHaveText("tide-table");
    await expect(rows.nth(0).locator(".composer-menu-tag")).toHaveText("Your skill");
    await expect(rows.nth(1).locator(".composer-menu-name")).toHaveText("ferry-times");
    await expect(rows.nth(1).locator(".composer-menu-tag")).toHaveText("Team skill");
    // Saved after the task started: offered to add (#889).
    await expect(rows.nth(2).locator(".composer-menu-name")).toHaveText("moon-phase");
    await expect(rows.nth(2).locator(".composer-menu-tag")).toHaveText("Add your skill");
    await expect(rows.nth(3)).toContainText("/healthcheck");
    await expect(rows.nth(3).locator(".composer-menu-tag")).toHaveText("Bot skill");
    await expect(rows.nth(5)).toContainText("/status");
    await expect(rows.nth(5).locator(".composer-menu-tag")).toHaveText("Command");
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
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(field(page)).toHaveAttribute("aria-activedescendant", "composer-menu-4");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    const chip = page.getByTestId("token-chip");
    await expect(chip).toHaveText(/Bot skill\s*\/weather/);
    await expect(field(page)).toHaveValue("");
    // Nothing was sent by choosing.
    expect(await sends(page)).toEqual([]);
    await page.keyboard.type("for tomorrow in Lisbon");
    await page.keyboard.press("Enter");
    expect(await sends(page)).toMatchObject([{ text: "/weather for tomorrow in Lisbon" }]);
    await expect(chip).toHaveCount(0);
    await expect(page.getByTestId("outgoing")).toContainText("/weather for tomorrow in Lisbon");
  });

  test("F-071: with a skill or command chosen, / offers no second one: the gateway runs one per message", async ({
    page,
  }) => {
    await open(page);
    await record(page);
    await field(page).click();
    await page.keyboard.type("/");
    await page.getByRole("option", { name: /\/weather/ }).click();
    await expect(page.getByTestId("token-chip")).toHaveCount(1);
    await page.keyboard.type("/");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(field(page)).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Backspace");
    await page.keyboard.type(" in Lisbon");
    await page.keyboard.press("Enter");
    expect(await sends(page)).toMatchObject([{ text: "/weather in Lisbon" }]);
  });

  test("F-071: a list that could not be read is read again when the menu opens again, and a slower earlier read does not replace a later one", async ({
    page,
  }) => {
    await open(page);
    await page.evaluate(() => {
      const w = window as unknown as {
        clawtrateFixture: { invoke: (c: unknown) => Promise<unknown> };
        reads: number;
        releaseSlash?: () => void;
      };
      const fixture = w.clawtrateFixture;
      const invoke = fixture.invoke.bind(fixture);
      w.reads = 0;
      fixture.invoke = (command: unknown) => {
        const each = command as { type: string; trigger?: string };
        if (each.type !== "readComposerMenu") return invoke(command);
        if (each.trigger !== "/") return invoke(command);
        w.reads += 1;
        // The first "/" read fails; the third answers only when the check says so.
        if (w.reads === 1) return Promise.reject(new Error("Not connected to the gateway."));
        if (w.reads === 3)
          return new Promise<void>((resolve) => (w.releaseSlash = resolve)).then(() =>
            invoke(command),
          );
        return invoke(command);
      };
    });
    await field(page).click();
    await page.keyboard.type("/");
    await expect(page.getByRole("alert")).toContainText("Couldn't load the list");
    await page.keyboard.press("Escape");
    await field(page).fill("");
    await page.keyboard.type("/");
    await expect(page.getByRole("option", { name: /\/status/ })).toBeVisible();
    // A read of "/" still out when "@" is opened does not replace the "@" list.
    await page.keyboard.press("Escape");
    await field(page).fill("");
    await page.keyboard.type("@");
    await expect(page.getByRole("option").first()).toBeVisible();
    await field(page).fill("");
    await page.keyboard.type("/");
    await field(page).fill("");
    await page.keyboard.type("@");
    await page.evaluate(() => (window as unknown as { releaseSlash: () => void }).releaseSlash());
    await page.waitForTimeout(200);
    await expect(page.getByRole("option", { name: /\/status/ })).toHaveCount(0);
    await expect(page.getByRole("option").first()).toBeVisible();
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
    await page.getByRole("button", { name: "Remove tide-table" }).click();
    await expect(page.getByTestId("token-chip")).toHaveCount(0);
    // A slash later in a sentence is only a slash.
    await field(page).fill("");
    await page.keyboard.type("either this /");
    await expect(page.getByRole("listbox")).toHaveCount(0);
  });

  test("F-071: a library skill's chip shows its name and whose it is, and the message runs it by its command", async ({
    page,
  }) => {
    await open(page);
    await record(page);
    await field(page).click();
    await page.keyboard.type("/tide");
    await expect(page.getByRole("option", { name: /tide-table/ })).toBeVisible();
    await page.keyboard.press("Enter");
    const chip = page.getByTestId("token-chip");
    await expect(chip).toHaveText(/Your skill\s*tide-table/);
    await page.keyboard.type("for Saturday");
    await page.keyboard.press("Enter");
    expect(await sends(page)).toMatchObject([
      { text: "/skill s_tide_tabl_5ace502a23c5418a9319 for Saturday" },
    ]);
  });

  test("F-071: choosing a library skill the task doesn't have adds it to the task, then puts its chip in; the line says so, and Undo takes it out (#889)", async ({
    page,
  }) => {
    await open(page);
    await record(page);
    await field(page).click();
    await page.keyboard.type("/moon");
    const row = page.getByRole("option", { name: /moon-phase/ });
    await expect(row.locator(".composer-menu-tag")).toHaveText("Add your skill");
    await page.keyboard.press("Enter");
    // Added at once, without a question, and then used: the chip runs it by its command.
    const line = page.getByTestId("library-skill-line");
    await expect(line).toContainText("Added moon-phase to this task.");
    const chip = page.getByTestId("token-chip");
    await expect(chip).toHaveText(/Your skill\s*moon-phase/);
    await expect(field(page)).toHaveValue("");
    const commands = () =>
      page.evaluate(() =>
        (window as unknown as { sent: Array<{ type: string }> }).sent
          .map((each) => each.type)
          .filter((type) => type !== "readComposerMenu"),
      );
    expect(await commands()).toEqual(["attachLibrarySkill"]);
    await page.keyboard.type("tonight");
    await page.keyboard.press("Enter");
    expect(await sends(page)).toMatchObject([
      { text: "/skill s_moon_phas_e65dd9b102714cd6a01b tonight" },
    ]);
    // The next "/" reads the task again: it has the skill now.
    await page.keyboard.type("/moon");
    await expect(row.locator(".composer-menu-tag")).toHaveText("Your skill");
    await page.keyboard.press("Escape");
    await field(page).fill("");
    // Undo takes it out, says so, and the next "/" offers it to add again.
    await line.getByRole("button", { name: "Undo: Added moon-phase to this task" }).click();
    await expect(line.getByRole("status")).toHaveText("Undone. moon-phase is out of this task.");
    await expect(line.getByRole("button", { name: /^Undo/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect((await commands()).slice(-1)).toEqual(["detachLibrarySkill"]);
    await field(page).click();
    await page.keyboard.type("/moon");
    await expect(row.locator(".composer-menu-tag")).toHaveText("Add your skill");
    // Undo again does nothing more.
    await page.keyboard.press("Escape");
    await line.getByRole("button", { name: /^Undo/ }).click();
    expect((await commands()).filter((type) => type === "detachLibrarySkill")).toHaveLength(1);
  });

  test("F-071: a refused add is said in plain words, and no chip goes in and nothing is offered to undo (#889)", async ({
    page,
  }) => {
    await open(page);
    await page.evaluate(() => {
      const fixture = (
        window as unknown as { clawtrateFixture: { invoke: (c: unknown) => Promise<unknown> } }
      ).clawtrateFixture;
      const invoke = fixture.invoke.bind(fixture);
      fixture.invoke = (command: unknown) =>
        (command as { type: string }).type === "attachLibrarySkill"
          ? Promise.reject(
              new Error(
                "Couldn't add moon-phase to this task: a task can have at most 64 library skills.",
              ),
            )
          : invoke(command);
    });
    await field(page).click();
    await page.keyboard.type("/moon");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alert")).toContainText(
      "Couldn't add moon-phase to this task: a task can have at most 64 library skills.",
    );
    await expect(page.getByTestId("token-chip")).toHaveCount(0);
    await expect(page.getByTestId("library-skill-line")).toHaveCount(0);
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
      test("F-071: the / menu open over the composer", async ({ page }) => {
        await open(page, theme);
        await field(page).click();
        await page.keyboard.type("/");
        await expect(page.getByRole("option")).toHaveCount(7);
        await settle(page);
        await expect(page).toHaveScreenshot(`composer-menu-${theme}-${size.name}.png`);
      });
      test("F-071: the line that says a library skill was added to the task, with Undo", async ({
        page,
      }) => {
        await open(page, theme);
        await field(page).click();
        await page.keyboard.type("/moon");
        await page.keyboard.press("Enter");
        await expect(page.getByTestId("library-skill-line")).toContainText(
          "Added moon-phase to this task.",
        );
        await expect(page.getByTestId("token-chip")).toHaveText(/Your skill\s*moon-phase/);
        await page.keyboard.type("for tonight");
        await settle(page);
        await expect(page).toHaveScreenshot(`composer-skill-added-${theme}-${size.name}.png`);
      });
    });
  }
}
