// A bot that takes a name in the chat (F-552): its card matches its baseline
// at 1440 and phone width in both themes, and on a connection without admin;
// it is reached and answered by keyboard, sends only on Rename or Not now, and
// shows a name the bot wrote only as text. The scene is written in the
// gateway's own shapes (apps/desktop/src/fixture/bot-name.ts); the live check
// is in e2e/accounts.spec.ts.
import { test, type Page } from "@playwright/test";
import type { ClawtrateState } from "../packages/core/src/types.ts";
import { contextFor, expect, openFixture, settle, SIZES, THEMES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.phone)!;
const TASK = "bot=new-bot&task=agent:new-bot:main&panel=closed";

const open = (page: Page, scene: string, theme: "light" | "dark") =>
  openFixture(page, `scene=${scene}&${TASK}`, theme);
const card = (page: Page) => page.getByRole("region", { name: "A new name for New bot" });
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
        size === WIDE && theme === "dark" ? ["bot-name", "bot-name-read-only"] : ["bot-name"];
      for (const scene of scenes) {
        test(`F-552: ${scene} matches its baseline`, async ({ page }) => {
          await open(page, scene, theme);
          await expect(card(page)).toBeVisible();
          await settle(page);
          await expect(page).toHaveScreenshot(`bot-name-${scene}-${theme}-${size.name}.png`);
        });
      }
    });
  }
}

test.describe("bot name behaviour", () => {
  test.use(contextFor(WIDE, "dark"));

  test("F-552: Rename is reached by keyboard, sends the name shown once, and the header and the sidebar follow", async ({
    page,
  }) => {
    await open(page, "bot-name", "dark");
    await expect(card(page)).toContainText("New bot would like to be called “Johnny”");
    expect(await sent(page)).toEqual([]);
    const rename = card(page).getByRole("button", { name: "Rename" });
    await page.getByTestId("composer-input").focus();
    // The card sits before the composer: Shift+Tab leaves the composer for Not now, then Rename.
    for (let i = 0; i < 6 && !(await rename.evaluate((el) => el === document.activeElement)); i++)
      await page.keyboard.press("Shift+Tab");
    await expect(rename).toBeFocused();
    await page.keyboard.press("Enter");
    // Stamped where the card was read: the fixture's gateway and the host's target.
    const { gatewayId, target } = await page.evaluate(
      () => (window as unknown as Fixture).clawtrateFixture.getState().connection,
    );
    expect(gatewayId).toMatch(/^[0-9a-f]+$/);
    expect(await sent(page)).toEqual([
      {
        type: "acceptBotName",
        botId: "new-bot",
        name: "Johnny",
        stamp: { gatewayId, target },
      },
    ]);
    await expect(card(page)).toHaveCount(0);
    await expect(page.locator(".title-pill-name")).toHaveText("Johnny");
    await expect(
      page.getByTestId("bot-list").getByRole("button", { name: /^Johnny\b/ }),
    ).toBeVisible();
    await expect(page.getByTestId("announcer")).toHaveText("Renamed to Johnny");
  });

  test("F-552: Not now sends only the decline and keeps the name", async ({ page }) => {
    await open(page, "bot-name", "dark");
    const notNow = card(page).getByRole("button", { name: "Not now" });
    await notNow.focus();
    await page.keyboard.press("Space");
    // It carries the stamp of the card's read too, so it answers only that card.
    const { gatewayId, target } = await page.evaluate(
      () => (window as unknown as Fixture).clawtrateFixture.getState().connection,
    );
    expect(await sent(page)).toEqual([
      { type: "declineBotName", botId: "new-bot", name: "Johnny", stamp: { gatewayId, target } },
    ]);
    await expect(card(page)).toHaveCount(0);
    await expect(page.locator(".title-pill-name")).toHaveText("New bot");
  });

  test("F-552: a Not now for a card read on an earlier connection announces nothing", async ({
    page,
  }) => {
    await open(page, "bot-name", "dark");
    await expect(card(page)).toBeVisible();
    // The connection moves on while the card is still on screen: the engine ignores its answer.
    await page.evaluate(() => {
      const { clawtrateFixture } = window as unknown as {
        clawtrateFixture: {
          setState(f: (s: { connection: { target: number } }) => unknown): void;
        };
      };
      clawtrateFixture.setState((state) => ({
        ...state,
        connection: { ...state.connection, target: state.connection.target + 1 },
      }));
    });
    await card(page).getByRole("button", { name: "Not now" }).click();
    await expect.poll(async () => (await sent(page)).length).toBe(1);
    await expect(card(page).getByRole("button", { name: "Not now" })).toBeEnabled();
    await expect(page.getByTestId("announcer")).not.toHaveText(/keeps its name/);
  });

  test("F-552: the fixture's Not now refuses a card being renamed and stamps that name no gateway, as the engine does (#512)", async ({
    page,
  }) => {
    await open(page, "bot-name", "dark");
    await expect(card(page)).toBeVisible();
    const notNow = (change: { status?: string; gatewayId?: null }) =>
      page.evaluate((change) => {
        const fixture = (
          window as unknown as {
            clawtrateFixture: {
              getState(): ClawtrateState;
              setState(f: (s: ClawtrateState) => ClawtrateState): void;
              invoke(command: unknown): Promise<{ declined: boolean }>;
            };
          }
        ).clawtrateFixture;
        fixture.setState((state) => {
          const gatewayId = "gatewayId" in change ? null : state.connection.gatewayId;
          const stamp = { gatewayId, target: state.connection.target };
          return {
            ...state,
            connection: { ...state.connection, gatewayId },
            botNames: state.botNames!.map((each) => ({
              ...each,
              stamp,
              status: (change.status ?? "open") as "open",
            })),
          };
        });
        const state = fixture.getState();
        return fixture.invoke({
          type: "declineBotName",
          botId: "new-bot",
          name: "Johnny",
          stamp: { gatewayId: state.connection.gatewayId, target: state.connection.target },
        });
      }, change);
    expect(await notNow({ status: "renaming" })).toEqual({ declined: false });
    expect(await notNow({ gatewayId: null })).toEqual({ declined: false });
    await expect(card(page)).toBeVisible();
  });

  test("F-552: a refused Rename announces what happened in the engine's words, and the fixture refuses a card from another connection (#471)", async ({
    page,
  }) => {
    await open(page, "bot-name", "dark");
    await expect(card(page)).toBeVisible();
    // The connection moves on while the card is still on screen: its Rename is refused.
    await page.evaluate(() =>
      (window as unknown as Fixture).clawtrateFixture.setState((state) => ({
        ...state,
        connection: { ...state.connection, target: state.connection.target + 1 },
      })),
    );
    await card(page).getByRole("button", { name: "Rename" }).click();
    await expect(page.getByTestId("announcer")).toHaveText(
      "This name was found on another gateway, so nothing was sent.",
    );
    await expect(page.locator(".title-pill-name")).toHaveText("New bot");
  });

  test("F-552: the fixture's Rename refuses a card being renamed and stamps that name no gateway, as the engine does (#471)", async ({
    page,
  }) => {
    await open(page, "bot-name", "dark");
    await expect(card(page)).toBeVisible();
    const rename = (change: { status?: string; gatewayId?: null }) =>
      page.evaluate((change) => {
        const fixture = (
          window as unknown as {
            clawtrateFixture: {
              getState(): ClawtrateState;
              setState(f: (s: ClawtrateState) => ClawtrateState): void;
              invoke(command: unknown): Promise<unknown>;
            };
          }
        ).clawtrateFixture;
        fixture.setState((state) => {
          const gatewayId = "gatewayId" in change ? null : state.connection.gatewayId;
          return {
            ...state,
            connection: { ...state.connection, gatewayId },
            botNames: state.botNames!.map((each) => ({
              ...each,
              stamp: { gatewayId, target: state.connection.target },
              status: (change.status ?? "open") as "open",
            })),
          };
        });
        const state = fixture.getState();
        return fixture
          .invoke({
            type: "acceptBotName",
            botId: "new-bot",
            name: "Johnny",
            stamp: { gatewayId: state.connection.gatewayId, target: state.connection.target },
          })
          .then(
            () => "renamed",
            (error: Error) => error.message,
          );
      }, change);
    expect(await rename({ status: "renaming" })).toBe("That name is no longer waiting for you.");
    expect(await rename({ gatewayId: null })).toBe(
      "This name was found on another gateway, so nothing was sent.",
    );
    await expect(page.locator(".title-pill-name")).toHaveText("New bot");
  });

  test("F-552: without admin the card says so and offers no Rename and no access request", async ({
    page,
  }) => {
    await open(page, "bot-name-read-only", "dark");
    await expect(card(page)).toContainText(
      "Renaming New bot needs admin access, which this connection doesn't have.",
    );
    await expect(card(page).getByRole("button")).toHaveText(["Not now"]);
  });

  test("F-552: a name the bot wrote is shown only as text", async ({ page }) => {
    await open(page, "bot-name", "dark");
    const name = '<img src=x onerror="document.title=1"><b>Jo</b>';
    await page.evaluate(
      (name) =>
        (window as unknown as Fixture).clawtrateFixture.setState((state) => ({
          ...state,
          botNames: state.botNames!.map((each) => ({ ...each, name })),
        })),
      name,
    );
    await expect(card(page).locator(".name-card-name")).toHaveText(name);
    await expect(card(page).locator("img, b")).toHaveCount(0);
    // A name is isolated wherever it shows, so a right-to-left one can't reorder the words around it.
    await expect(card(page).locator("bdi.name-card-name")).toHaveCount(1);
    await expect(page.locator("bdi.title-pill-name")).toHaveText("New bot");
    await expect(
      page.getByTestId("bot-list").locator("bdi.bot-name").filter({ hasText: "New bot" }),
    ).toHaveCount(1);
  });
});
