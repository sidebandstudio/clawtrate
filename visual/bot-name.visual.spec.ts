// A bot that takes a name in the chat (F-552): it is renamed at once, and one line in its
// conversation says what happened, with Undo naming the name it puts back. The lines match their
// baselines at 1440 and phone width in both themes; Undo and Close are reached by keyboard and
// named for what they do; a name the bot wrote is shown only as text; the bot's settings list its
// recent name changes; a connection that can't change bots shows no Undo. The scenes
// are written in the gateway's own shapes (apps/desktop/src/fixture/bot-name.ts); the live check
// is in e2e/accounts.spec.ts.
import { test, type Page } from "@playwright/test";
import type { ClawtrateState } from "../packages/core/src/types.ts";
import { contextFor, expect, openFixture, settle, SIZES, THEMES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.phone)!;
const TASK = "bot=new-bot&task=agent:new-bot:main&panel=closed";
const SETTINGS = "bot=new-bot&task=agent:new-bot:main&panel=open&tab=settings";

const open = (page: Page, scene: string, theme: "light" | "dark", where = TASK) =>
  openFixture(page, `scene=${scene}&${where}`, theme);
const line = (page: Page) => page.getByRole("region", { name: /'s name$/ });
type Fixture = {
  clawtrateFixture: {
    sent: Array<{ type: string }>;
    setState(change: (state: ClawtrateState) => ClawtrateState): void;
    getState(): ClawtrateState;
  };
};
const sent = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as Fixture).clawtrateFixture.sent.filter((command) =>
      command.type.endsWith("BotName"),
    ),
  );

for (const size of [WIDE, PHONE]) {
  for (const theme of THEMES) {
    test.describe(`bot name ${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      const scenes =
        size === WIDE && theme === "dark"
          ? ["bot-name", "bot-name-own", "bot-name-file", "bot-name-undone", "bot-name-read-only"]
          : ["bot-name"];
      for (const scene of scenes) {
        test(`F-552: ${scene} matches its baseline`, async ({ page }) => {
          await open(page, scene, theme);
          await expect(line(page)).toBeVisible();
          await settle(page);
          await expect(page).toHaveScreenshot(`bot-name-${scene}-${theme}-${size.name}.png`);
        });
      }
      if (size === WIDE && theme === "dark")
        test("F-552: the bot's recent name changes match their baseline", async ({ page }) => {
          await open(page, "bot-name", theme, SETTINGS);
          await expect(page.getByTestId("name-changes")).toBeVisible();
          await settle(page);
          await expect(page).toHaveScreenshot(`bot-name-settings-${theme}-${size.name}.png`);
        });
    });
  }
}

test.describe("bot name behaviour", () => {
  test.use(contextFor(WIDE, "dark"));

  test("F-552: the line says what happened in one of three forms; a screen reader hears it", async ({
    page,
  }) => {
    await open(page, "bot-name", "dark");
    await expect(line(page).getByRole("status")).toHaveText("Renamed to Johnny");
    await expect(page.locator(".title-pill-name")).toHaveText("Johnny");
    await open(page, "bot-name-own", "dark");
    await expect(line(page).getByRole("status")).toHaveText(
      "New bot renamed itself to Johnny after reading a file",
    );
    await open(page, "bot-name-file", "dark");
    await expect(line(page).getByRole("status")).toHaveText(
      "New bot is now Johnny, the name in its identity file",
    );
    await expect(line(page).getByRole("button", { name: "Undo: back to New bot" })).toBeVisible();
    expect(await sent(page)).toEqual([]);
  });

  test("F-552: Undo is reached by keyboard, is named for what it does, and sends only the change shown", async ({
    page,
  }) => {
    await open(page, "bot-name", "dark");
    const undo = line(page).getByRole("button", { name: "Undo: back to New bot" });
    await page.getByTestId("composer-input").focus();
    // The line sits before the composer: Shift+Tab leaves the composer for Close, then Undo.
    for (let i = 0; i < 6 && !(await undo.evaluate((el) => el === document.activeElement)); i++)
      await page.keyboard.press("Shift+Tab");
    await expect(undo).toBeFocused();
    await page.keyboard.press("Enter");
    const state = await page.evaluate(() =>
      (window as unknown as Fixture).clawtrateFixture.getState(),
    );
    const { gatewayId, target } = state.connection;
    expect(await sent(page)).toEqual([
      {
        type: "undoBotName",
        botId: "new-bot",
        run: state.botNameRecord!.changes[0]!.run,
        from: "New bot",
        stamp: { gatewayId, target },
      },
    ]);
    await expect(line(page).getByRole("status")).toHaveText("Back to New bot.");
    await expect(line(page).getByRole("button", { name: /^Undo/ })).toHaveCount(0);
    await expect(page.locator(".title-pill-name")).toHaveText("New bot");
    await expect(page.getByTestId("announcer")).toHaveText("Back to New bot.");
  });

  test("F-552: an Undo refused announces the engine's words, and the name stays", async ({
    page,
  }) => {
    await open(page, "bot-name", "dark");
    await page.evaluate(() =>
      (window as unknown as Fixture).clawtrateFixture.setState((state) => ({
        ...state,
        connection: { ...state.connection, target: state.connection.target + 1 },
      })),
    );
    await line(page).getByRole("button", { name: /^Undo/ }).click();
    await expect(page.getByTestId("announcer")).toHaveText(
      "This change was read on another gateway, so nothing was sent.",
    );
    // Shown in the line too, not only announced.
    await expect(line(page).getByRole("status")).toHaveText(
      "Renamed to Johnny Undo didn't go through: This change was read on another gateway, so nothing was sent.",
    );
    await expect(page.locator(".title-pill-name")).toHaveText("Johnny");
  });

  test("F-552: a connection that can't change bots shows the line without Undo", async ({
    page,
  }) => {
    await open(page, "bot-name", "dark");
    await page.evaluate(() =>
      (window as unknown as Fixture).clawtrateFixture.setState((state) => ({
        ...state,
        connection: { ...state.connection, canAdmin: false },
      })),
    );
    await expect(line(page).getByRole("status")).toHaveText("Renamed to Johnny");
    await expect(line(page).getByRole("button", { name: /^Undo/ })).toHaveCount(0);
  });

  test("F-552: Close puts the line away and sends nothing to the gateway", async ({ page }) => {
    await open(page, "bot-name", "dark");
    const run = await page.evaluate(
      () => (window as unknown as Fixture).clawtrateFixture.getState().botNames![0]!.run,
    );
    await line(page).getByRole("button", { name: "Close" }).click();
    expect(await sent(page)).toEqual([{ type: "dismissBotName", botId: "new-bot", run }]);
    await expect(line(page)).toHaveCount(0);
    await expect(page.locator(".title-pill-name")).toHaveText("Johnny");
  });

  test("F-552: without admin nothing was renamed, the line says why, and nothing asks for access", async ({
    page,
  }) => {
    await open(page, "bot-name-read-only", "dark");
    await expect(line(page)).toContainText(
      "New bot wrote a new name for itself, Johnny. Renaming needs admin access, which this connection doesn't have.",
    );
    await expect(line(page).getByRole("button")).toHaveText([""]);
    await expect(line(page).getByRole("button", { name: "Close" })).toBeVisible();
  });

  test("F-552: a name the bot wrote is shown only as text", async ({ page }) => {
    await open(page, "bot-name", "dark");
    const name = '<img src=x onerror="document.title=1"><b>Jo</b>';
    await page.evaluate(
      (name) =>
        (window as unknown as Fixture).clawtrateFixture.setState((state) => ({
          ...state,
          botNames: state.botNames!.map((each) => ({ ...each, to: name })),
        })),
      name,
    );
    await expect(line(page).locator(".name-line-name")).toHaveText(name);
    await expect(line(page).locator("img, b")).toHaveCount(0);
    // A name is isolated wherever it shows, so a right-to-left one can't reorder the words around it.
    await expect(line(page).locator("bdi.name-line-name")).toHaveCount(1);
  });

  test("F-552: the bot's settings list its recent name changes, with Undo until it is undone", async ({
    page,
  }) => {
    await open(page, "bot-name", "dark", SETTINGS);
    const changes = page.getByTestId("name-changes");
    await expect(page.getByRole("heading", { name: "Recent changes", level: 4 })).toBeVisible();
    await expect(changes).toContainText("Renamed from New bot to Johnny");
    await changes.getByRole("button", { name: "Undo: back to New bot" }).click();
    await expect(changes).toContainText("Put back to New bot");
    await expect(changes.getByRole("button")).toHaveCount(0);
  });
});
