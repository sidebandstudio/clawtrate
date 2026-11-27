// "Bots know how Clawtrate works" in the fixture mode (F-566, #544, #628, #795): always on, with
// no switch, no link and nothing asked. Settings, Conversation says nothing about it while
// Clawtrate keeps every bot's section, and one quiet line for the bots whose file it can't keep;
// the sidebar has nothing to press. The gateway's half is the guide checks of `pnpm scenarios`.
import { test, type Page } from "@playwright/test";
import { contextFor, expect, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.name === "phone")!;

/** Settings, Conversation, once the bots' instructions have been read. */
async function openPane(page: Page, query: string, theme: "light" | "dark" = "light") {
  await openFixture(page, `scene=composer&${OTTO_DISK}&panel=closed${query}`, theme);
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(settings.getByTestId("turn-limit")).toBeVisible();
  await expect.poll(() => reads(page)).toBeGreaterThan(0);
  return settings;
}

const reads = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as { clawtrateFixture: { sent: { type: string }[] } }
      ).clawtrateFixture.sent.filter((command) => command.type === "readBotGuides").length,
  );
const lines = (settings: ReturnType<Page["getByRole"]>) =>
  settings.getByTestId("bot-guides").getByTestId("bot-guides-line");

test.describe("bots know how Clawtrate works", () => {
  test.use(contextFor(WIDE, "light"));

  test("F-566: always on: no switch, no link, no Read it, and nothing said while every bot has it", async ({
    page,
  }) => {
    for (const query of ["&access=admin", "&access=admin&guides=new"]) {
      const settings = await openPane(page, query);
      await expect(settings.getByText("Bots know how Clawtrate works")).toHaveCount(0);
      await expect(settings.getByRole("switch")).toHaveCount(1);
      await expect(settings.getByRole("switch", { name: "Bot voice" })).toBeVisible();
      await expect(settings.getByText("Read it")).toHaveCount(0);
      // A file the gateway hasn't made yet gets the section after the bot's next run: nothing to say.
      await expect(settings.getByTestId("bot-guides")).toHaveCount(0);
      await expect(
        settings.getByRole("button", { name: /^(Add|Update|Replace|Remove)$/ }),
      ).toHaveCount(0);
    }
  });

  test("F-566: one quiet line for each reason Clawtrate leaves a bot's file, naming the bots", async ({
    page,
  }) => {
    const settings = await openPane(page, "&access=admin&guides=odd");
    await expect(lines(settings)).toHaveText([
      "Clawtrate can't tell where its section is in Marlow's instructions, so it leaves them as they are.",
      "Pip's instructions aren't plain UTF-8 text, so Clawtrate leaves them as they are.",
      "Quartermaster of the Family Calendar and Errands's instructions are too long for Clawtrate's section: the gateway would leave part of them out.",
      "Clawtrate couldn't update Otto's instructions yet. It tries again the next time it connects.",
    ]);
    // Words only: nothing to press, no card and no link.
    await expect(settings.getByTestId("bot-guides").getByRole("button")).toHaveCount(0);
    await expect(settings.getByTestId("bot-guides").getByRole("link")).toHaveCount(0);
    await expect(settings.getByTestId("bot-guides").getByRole("alert")).toHaveCount(0);
  });

  test("F-566: without admin access, one line says Clawtrate can't keep it", async ({ page }) => {
    const settings = await openPane(page, "&guides=odd");
    await expect(lines(settings)).toHaveText([
      "Clawtrate can't keep its section in Marlow, Otto, Pip and Quartermaster of the Family Calendar and Errands's instructions current: this device doesn't have admin access to the gateway.",
    ]);
    // While every bot has it, there is nothing to say, admin or not.
    const kept = await openPane(page, "");
    await expect(kept.getByTestId("bot-guides")).toHaveCount(0);
  });

  test("F-566: says when a bot's file, or the bots' files, can't be read", async ({ page }) => {
    const one = await openPane(page, "&access=admin&guides=unread");
    await expect(lines(one)).toHaveText([
      "Couldn't read Otto's instructions. The gateway did not answer.",
    ]);
    const all = await openPane(page, "&access=admin&guides=fail");
    await expect(lines(all)).toHaveText([
      "Couldn't read the bots' instructions. The gateway did not answer.",
    ]);
  });

  test("F-566: the sidebar asks nothing: no card and nothing to press, with admin access", async ({
    page,
  }) => {
    await openFixture(page, `scene=composer&${OTTO_DISK}&access=admin`, "light");
    await expect(page.getByText("Teach your bots how Clawtrate works")).toHaveCount(0);
    await expect(page.getByTestId("bot-guides-offer-card")).toHaveCount(0);
  });
});

for (const size of [WIDE, PHONE]) {
  for (const theme of THEMES) {
    test.describe(`${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));
      for (const [name, query] of [
        ["odd", "&access=admin&guides=odd"],
        ["noadmin", "&guides=odd"],
      ] as const) {
        test(`F-566: the guides, ${name}`, async ({ page }) => {
          const settings = await openPane(page, query, theme);
          await settings.getByTestId("bot-guides").scrollIntoViewIfNeeded();
          await settle(page);
          await expect(page).toHaveScreenshot(`bot-guides-${name}-${theme}-${size.name}.png`);
        });
      }
      test("F-566: the sidebar, with nothing to press", async ({ page }) => {
        await openFixture(page, `scene=composer&${OTTO_DISK}&access=admin`, theme);
        // At phone width the rail is the list a task opens from.
        if (size.phone) await page.getByRole("button", { name: "Back to bots" }).click();
        await settle(page);
        await expect(page).toHaveScreenshot(`bot-guides-rail-${theme}-${size.name}.png`);
      });
    });
  }
}
